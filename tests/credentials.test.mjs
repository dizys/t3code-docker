import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createCredentialStore, credentialFailure } from '../docker/setup/credentials.mjs';
import { outputFilter, apiRequest, apiTarget, sshRequest, testCredential } from '../docker/setup/credentials/run.mjs';

const secret = 'fixture-private-credential-123';
const ssh = { id: 'homeserver', label: 'Home server', type: 'ssh', host: '192.0.2.1', username: 'oliver', port: 22, secret };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-credentials-'));
  const directory = path.join(root, 'credentials');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, directory, store: createCredentialStore({ directory }) };
}
const create = async (store, profile) => store.save({ profile, revision: (await store.list()).revision, create: true });

test('credentials persist privately and public reads never include saved values', async t => {
  const { directory, store } = await fixture(t);
  await create(store, ssh);
  await create(store, { id: 'ha', label: 'Home Assistant API', type: 'api', baseUrl: 'http://192.0.2.2/api', secret: secret + '-token' });
  const snapshot = await createCredentialStore({ directory }).list();
  assert.equal(snapshot.profiles.length, 2);
  assert.equal(snapshot.profiles[1].baseUrl, 'http://192.0.2.2/api/');
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal((await store.forUse('homeserver')).secret, secret);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, 'credentials.json'))).mode & 0o777, 0o600);
  const saved = await store.save({ profile: { ...ssh, secret: '', label: 'Renamed' }, revision: snapshot.revision });
  assert.equal((await store.forUse('homeserver')).secret, secret);
  assert.equal(JSON.stringify(saved).includes(secret), false);
  await store.save({ profile: { ...ssh, secret: 'replacement-password' }, revision: saved.revision });
  assert.equal((await store.forUse('homeserver')).secret, 'replacement-password');
  await store.remove({ id: 'homeserver', revision: (await store.list()).revision });
  await assert.rejects(store.forUse('homeserver'), /not found/);
  assert.equal((await store.list()).profiles.length, 1);
});

test('conflicting, duplicate and overlapping writes cannot overwrite another editor', async t => {
  const { store } = await fixture(t);
  const before = await store.list();
  await create(store, ssh);
  await assert.rejects(store.save({ profile: { ...ssh, secret: 'lost' }, revision: before.revision }), { status: 409 });
  let revision = (await store.list()).revision;
  await assert.rejects(store.save({ profile: ssh, revision, create: true }), { status: 409 });
  const outcomes = await Promise.allSettled(['First', 'Second'].map(label => store.save({ profile: { ...ssh, label }, revision })));
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'rejected']);
  assert.equal(outcomes[1].reason.status, 409);
  revision = (await store.list()).revision;
  await assert.rejects(store.remove({ id: 'homeserver', revision: before.revision }), { status: 409 });
  assert.equal((await store.forUse('homeserver')).label, 'First');
});

test('invalid input and damaged stores fail without echoing or replacing credentials', async t => {
  const { directory, root, store } = await fixture(t);
  for (const change of [{ id: '../escape' }, { host: '-oProxyCommand=bad' }, { username: 'user;bad' }, { port: 0 }, { secret: 'line\nbreak' }, { secret: '\ud800' }, { secret: undefined }, { label: '\u0000' }, { type: 'unknown' }]) {
    await assert.rejects(create(store, { ...ssh, ...change }));
  }
  for (const baseUrl of ['file:///etc/passwd', 'https://user:password@example.com', 'http://example.com?secret=hello', 'http://example.com/#secret']) {
    await assert.rejects(create(store, { id: 'api', label: 'API', type: 'api', baseUrl, secret }));
  }
  await create(store, ssh);
  const file = path.join(directory, 'credentials.json');
  await fs.writeFile(file, '{"secret":"' + secret + '"');
  let failure;
  try { await store.list(); } catch (error) { failure = credentialFailure(error); }
  assert.equal(failure.status, 500); assert.equal(JSON.stringify(failure).includes(secret), false);
  await assert.rejects(create(store, ssh));
  assert.equal(await fs.readFile(file, 'utf8'), '{"secret":"' + secret + '"');
  await fs.rm(file);
  const external = path.join(root, 'external'); await fs.writeFile(external, 'do not touch');
  await fs.symlink(external, file); await assert.rejects(store.list());
  assert.equal(await fs.readFile(external, 'utf8'), 'do not touch');
  await fs.rm(directory, { recursive: true }); await fs.symlink(root, directory);
  await assert.rejects(store.list());
});

test('output filtering masks literal and encoded values across every chunk boundary', () => {
  for (const value of [secret, 'password-with-"quotes"&slashes\\and-more']) {
    const variants = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString('base64')];
    const source = 'before ' + variants.join(' middle ') + ' after';
    for (let size = 1; size <= source.length; size++) {
      let output = ''; const filter = outputFilter(value, text => { output += text; });
      for (let i = 0; i < source.length; i += size) filter.write(source.slice(i, i + size));
      filter.end();
      assert.equal(output, 'before ' + variants.map(() => '[redacted]').join(' middle ') + ' after', 'chunk size ' + size);
    }
  }
});

test('API helper authenticates internally, filters output and never follows redirects', async t => {
  let calls = 0, received;
  const server = createServer(async (req, res) => {
    calls++; assert.equal(req.headers.authorization, 'Bearer ' + secret);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { url: req.url, method: req.method, body: Buffer.concat(chunks).toString() };
    if (req.url === '/api/redirect') { res.writeHead(302, { location: '/elsewhere' }); res.end(); return; }
    if (req.url === '/api/unauthorized') { res.writeHead(401); res.end(secret); return; }
    res.write('hello ' + secret.slice(0, 8)); setTimeout(() => res.end(secret.slice(8) + ' goodbye'), 5);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const profile = { id: 'ha', type: 'api', baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/', secret };
  let output = '';
  assert.equal(await apiRequest(profile, 'POST', 'services/light/turn_on', { body: '{"entity_id":"light.kitchen"}', stdout: { write: text => { output += text; } } }), 0);
  assert.equal(output, 'hello [redacted] goodbye');
  assert.deepEqual(received, { url: '/api/services/light/turn_on', method: 'POST', body: '{"entity_id":"light.kitchen"}' });
  await assert.rejects(apiRequest(profile, 'GET', 'redirect'), /redirects are not followed/);
  assert.equal(calls, 2, 'redirect destination was never requested');
  await assert.rejects(apiRequest(profile, 'GET', 'unauthorized', { probe: true }), error => !error.message.includes(secret) && /HTTP 401/.test(error.message));
  assert.equal(await testCredential(profile), 0);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(testCredential(profile, { signal: cancelled.signal }), /API request failed/);
  for (const target of ['https://other.test/api', '//other.test', '/api/states', '../outside', '%2e%2e/outside', 'foo\\outside', '#fragment']) assert.throws(() => apiTarget(profile, target));
});

test('SSH helper supplies askpass privately and filters both output streams', async t => {
  const { root } = await fixture(t);
  const fixtureFile = path.join(root, 'ssh.cjs');
  await fs.writeFile(fixtureFile, `const {execFileSync}=require('node:child_process');
const secret=execFileSync(process.env.SSH_ASKPASS,[],{encoding:'utf8'}).trimEnd();
if(secret!==process.env.T3_CREDENTIAL_PASSWORD)process.exit(2);
process.stdout.write('output '+secret.slice(0,5));
process.stderr.write('error '+secret.slice(0,5));
setTimeout(()=>{process.stdout.write(secret.slice(5)+' done');process.stderr.write(secret.slice(5)+' done');},10);`);
  let out = '', err = '';
  const code = await sshRequest(ssh, ['uptime'], { stdin: 'ignore', stdout: { write: value => { out += value; } }, stderr: { write: value => { err += value; } },
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, '/usr/bin/ssh'); assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
      assert.equal(JSON.stringify(args).includes(secret), false);
      assert.deepEqual(args.slice(-2), ['192.0.2.1', 'uptime']);
      return spawn(process.execPath, [fixtureFile], options);
    },
  });
  assert.equal(code, 0); assert.equal(out, 'output [redacted] done'); assert.equal(err, 'error [redacted] done');
  const controller = new AbortController(); let interrupted;
  t.after(() => interrupted?.kill());
  await assert.rejects(sshRequest(ssh, ['true'], { stdin: 'ignore', signal: controller.signal,
    spawnProcess: (_executable, _args, options) => {
      interrupted = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
      interrupted.once('spawn', () => controller.abort());
      return interrupted;
    },
  }), /SSH could not start or was interrupted/);
  if (interrupted.signalCode === null && interrupted.exitCode === null) await once(interrupted, 'close');
  assert.equal(interrupted.signalCode, 'SIGTERM');
});
