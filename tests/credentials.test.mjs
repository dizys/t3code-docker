import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createCredentialStore, credentialFailure } from '../docker/setup/credentials.mjs';
import { normalize } from '../docker/setup/credentials/model.mjs';
import { outputFilter, apiRequest, apiTarget, sshRequest, testCredential } from '../docker/setup/credentials/run.mjs';

const secret = 'fixture-private-credential-123';
const ssh = { id: 'build-server', label: 'Build server', type: 'ssh', fields: { host: '192.0.2.1', port: 22, username: 'deploy', auth: 'password' }, secrets: { password: secret } };
const token = (baseUrl, fields = {}, value = secret) => ({ id: 'service', label: 'Service API', type: 'token', fields: { baseUrl, ...fields }, secrets: { token: value } });
const withFields = (credential, fields) => ({ ...credential, fields: { ...credential.fields, ...fields } });
const sink = () => { const chunks = []; return { write: chunk => { chunks.push(Buffer.from(chunk)); }, get text() { return Buffer.concat(chunks).toString(); } }; };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-credentials-'));
  const directory = path.join(root, 'credentials');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Always pass home: saving an SSH credential adds a line to <home>/.ssh/config.
  const open = () => createCredentialStore({ directory, home: root });
  return { root, directory, open, store: open() };
}
const create = async (store, profile) => store.save({ credential: profile, create: true });

test('credentials persist privately and public reads never include saved values', async t => {
  const { directory, open, store } = await fixture(t);
  await create(store, ssh);
  await create(store, { ...token('http://192.0.2.2/api', {}, secret + '-token'), id: 'project-api' });
  const snapshot = await open().list();
  assert.equal(snapshot.credentials.length, 2);
  assert.equal(snapshot.credentials[1].fields.baseUrl, 'http://192.0.2.2/api/');
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  for (const row of snapshot.credentials) assert.equal(Object.hasOwn(row, 'secrets'), false);
  assert.deepEqual(snapshot.credentials.map(row => row.secretNames), [['password'], ['token']]);
  assert.deepEqual(snapshot.credentials.map(row => row.hasSecret), [true, true]);
  assert.deepEqual(snapshot.credentials.map(row => row.delivers), [[], ['PROJECT_API_TOKEN']]);
  assert.deepEqual(snapshot.credentials.map(row => row.usage), [null, null]);
  assert.equal((await store.forUse('build-server')).secrets.password, secret);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, 'credentials.json'))).mode & 0o777, 0o600);
  const before = snapshot.credentials.find(row => row.id === 'build-server');
  const saved = await store.save({ credential: { ...ssh, secrets: { password: '' } }, revision: before.revision });
  assert.equal((await store.forUse('build-server')).secrets.password, secret);
  assert.equal(JSON.stringify(saved).includes(secret), false);
  const next = await store.save({ credential: { ...ssh, secrets: { password: 'replacement-password' } }, revision: saved.credential.revision });
  assert.equal((await store.forUse('build-server')).secrets.password, 'replacement-password');
  await store.remove({ id: 'build-server', revision: next.credential.revision });
  await assert.rejects(store.forUse('build-server'), { status: 404, code: 'not-found' });
  assert.equal((await store.list()).credentials.length, 1);
});

test('conflicting, duplicate and overlapping writes cannot overwrite another editor', async t => {
  const { store, open } = await fixture(t);
  const initial = (await create(store, ssh)).credential;
  await assert.rejects(create(store, ssh), { status: 409, code: 'taken' });
  const other = open();
  const outcomes = await Promise.allSettled(['first-host', 'second-host'].map((host, index) => (index ? other : store).save({ credential: withFields(ssh, { host }), revision: initial.revision })));
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'rejected']);
  assert.equal(outcomes[1].reason.status, 409);
  assert.equal(outcomes[1].reason.code, 'changed');
  assert.equal(JSON.stringify(credentialFailure(outcomes[1].reason)).includes(secret), false);
  await assert.rejects(store.remove({ id: 'build-server', revision: initial.revision }), { status: 409, code: 'changed' });
  assert.equal((await store.forUse('build-server')).fields.host, 'first-host');
});

test('invalid input and damaged stores fail without echoing or replacing credentials', async t => {
  const { directory, root, store } = await fixture(t);
  for (const change of [{ id: '../escape' }, { id: 'new' }, { fields: { ...ssh.fields, host: '-oProxyCommand=bad' } }, { fields: { ...ssh.fields, username: 'user;bad' } }, { fields: { ...ssh.fields, port: 0 } }, { fields: { ...ssh.fields, auth: 'telepathy' } }, { secrets: { password: 'line\nbreak' } }, { secrets: { password: '\ud800' } }, { secrets: undefined }, { type: 'unknown' }, { description: 'two\nlines' }]) {
    await assert.rejects(create(store, { ...ssh, ...change }), error => !error.message.includes(secret));
  }
  for (const baseUrl of ['file:///etc/passwd', 'https://user:password@example.com', 'http://example.com?secret=hello', 'http://example.com/#secret']) {
    await assert.rejects(create(store, { ...token(baseUrl), id: 'api' }));
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

test('variable names a command relies on cannot be overwritten by a saved value', () => {
  const named = env => normalize({ id: 'service', type: 'token', fields: {}, secrets: { token: secret }, env: { token: env } });
  assert.equal(named('CLOUDFLARE_API_TOKEN').env.token, 'CLOUDFLARE_API_TOKEN');
  for (const env of ['PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BASH_ENV', 'has space', '1LEADING', 'A=B']) assert.throws(() => named(env), { status: 400, extra: { field: 'env' } }, env);
  for (const input of [{ fields: { PATH: '/tmp' } }, { secrets: { LD_PRELOAD: secret } }, { fields: { 'not a name': 'x' } }, { fields: { SAME: 'x' }, secrets: { SAME: secret } }, { fields: {}, secrets: {} }]) {
    assert.throws(() => normalize({ id: 'mixed', type: 'custom', ...input }), { status: 400, extra: { field: 'vars' } });
  }
});

test('normalizing keeps only what a type holds and treats a pasted value the way a person meant it', () => {
  const bare = normalize({ id: 'service', type: 'token', fields: { authType: 'header', authName: 'X-Key', testPath: 'account' }, secrets: { token: secret + '\n' } });
  assert.deepEqual(bare.fields, {}, 'API settings mean nothing without an address');
  assert.equal(bare.secrets.token, secret, 'a trailing line break is not part of a single-line secret');
  const mode = auth => normalize({ id: 'box', type: 'ssh', fields: { host: 'example.net', username: 'deploy', auth }, secrets: { password: secret, privateKey: 'fixture-key-text' } });
  assert.deepEqual(mode('password').secrets, { password: secret });
  assert.deepEqual(mode('key').secrets, { privateKey: 'fixture-key-text' });
  assert.equal(mode('key').fields.port, 22, 'the default port is saved');
  const file = normalize({ id: 'cert', type: 'file', secrets: { content: 'line one\nline two\n' } });
  assert.equal(file.secrets.content, 'line one\nline two\n', 'a file keeps its line breaks');
  assert.equal(file.fields.filename, 'credential');
  assert.throws(() => normalize({ id: 'long', type: 'token', secrets: { token: 'x'.repeat(8193) } }), { status: 400 });
  assert.throws(() => normalize({ id: 'long', type: 'file', secrets: { content: 'x'.repeat(48 * 1024 + 1) } }), { status: 400 });
  assert.throws(() => normalize({ id: 'blank', type: 'file', secrets: { content: ' \n' } }), { status: 400 });
  // A custom row that is left out is removed; a listed one keeps its saved value.
  const previous = normalize({ id: 'mixed', type: 'custom', fields: { REGION: 'eu' }, secrets: { KEEP: secret, DROP: secret + '-other' } });
  const edited = normalize({ id: 'mixed', type: 'custom', fields: { REGION: 'us' }, secretNames: ['KEEP'], secrets: {} }, previous);
  assert.deepEqual([edited.fields, edited.secrets], [{ REGION: 'us' }, { KEEP: secret }]);
});

test('an omitted or blank optional secret is kept, an explicit null removes it', () => {
  const aws = secrets => ({ id: 'cloud', type: 'aws', fields: { accessKeyId: 'AKIAFIXTURE' }, secrets });
  const previous = normalize(aws({ secretAccessKey: 'fixture-secret', sessionToken: 'fixture-session' }));
  assert.equal(normalize(aws({ secretAccessKey: '' }), previous).secrets.sessionToken, 'fixture-session', 'omitted keeps');
  assert.equal(normalize(aws({ secretAccessKey: '', sessionToken: '' }), previous).secrets.sessionToken, 'fixture-session', 'blank keeps');
  const cleared = normalize(aws({ secretAccessKey: '', sessionToken: null }), previous);
  assert.equal(Object.hasOwn(cleared.secrets, 'sessionToken'), false, 'null removes an optional secret');
  assert.equal(cleared.secrets.secretAccessKey, 'fixture-secret');
  assert.equal(normalize(aws({ secretAccessKey: null }), previous).secrets.secretAccessKey, 'fixture-secret', 'a required secret still keeps on null');
});

test('output filtering masks literal and encoded values across every chunk boundary', () => {
  for (const value of [secret, 'password-with-"quotes"&slashes\\and-more', 'key +/~']) {
    const variants = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), new URLSearchParams([['', value]]).toString().slice(1), Buffer.from(value).toString('base64')];
    const source = 'before ' + variants.join(' middle ') + ' after';
    for (let size = 1; size <= source.length; size++) {
      let output = ''; const filter = outputFilter(value, text => { output += text; });
      for (let i = 0; i < source.length; i += size) filter.write(source.slice(i, i + size));
      filter.end();
      assert.equal(output, 'before ' + variants.map(() => '[redacted]').join(' middle ') + ' after', 'chunk size ' + size);
    }
  }
});

test('legacy bearer connections remain readable and changing auth settings retains the saved key', async t => {
  const { directory, store } = await fixture(t);
  await store.list();
  const file = path.join(directory, 'credentials.json');
  const legacy = JSON.stringify({ version: 1, profiles: [{ id: 'service', label: 'Service API', type: 'api', baseUrl: 'https://api.example.com/v1/', secret }] });
  await fs.writeFile(file, legacy, { mode: 0o600 });
  assert.equal((await store.forUse('service')).fields.authType, 'bearer');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 3);
  const before = await store.list();
  const saved = await store.save({ credential: { ...before.credentials[0], fields: { ...before.credentials[0].fields, authType: 'header', authName: 'X-API-Key', authPrefix: '', testPath: 'account' }, secrets: { token: '' } }, revision: before.credentials[0].revision });
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal((await store.forUse('service')).secrets.token, secret);
  assert.equal((await store.list()).credentials[0].fields.authName, 'X-API-Key');
});

test('API authentication and test-path validation rejects unsafe configuration', async t => {
  const { store } = await fixture(t);
  for (const change of [{ authType: 'unknown' }, { authType: 'header', authName: 'bad:name' }, { authType: 'header', authName: 'Host' },
    { authType: 'header', authName: 'Content-Length' }, { authType: 'header', authName: 'X-Key', authPrefix: 'Token\r\ninjected' },
    { authType: 'query', authName: 'key\ninjected' }, { testPath: '/outside' }, { testPath: '../outside' }, { testPath: 'https://other.test/' }]) {
    await assert.rejects(create(store, token('https://api.example.com/v1/', change)), error => error.status === 400 && !error.message.includes(secret));
  }
});

for (const [authType, authName, authPrefix] of [['bearer', undefined, undefined], ['header', 'X-API-Key', ''], ['header', 'Authorization', 'Token'], ['query', 'api_key', undefined], ['query', 'api[key]', undefined]]) {
  test(`API ${authType} ${authName || ''} ${authPrefix || ''} authentication uses the saved key and configured test path`, async t => {
    const { store } = await fixture(t); let received;
    const key = authType === 'query' ? secret + '/+ ~' : secret;
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost'); received = { headers: req.headers, url };
      res.end(JSON.stringify({ echo: authType === 'query' ? url.search : req.headers[(authName || 'authorization').toLowerCase()] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    await create(store, token('http://127.0.0.1:' + server.address().port + '/v1/', { authType, authName, authPrefix, testPath: 'account' }, key));
    const profile = await store.forUse('service');
    assert.equal((await testCredential(profile)).code, 'ok');
    assert.equal(received.url.pathname, '/v1/account');
    if (authType === 'query') { assert.equal(received.url.searchParams.get(authName), key); assert.equal(received.headers.authorization, undefined); }
    else assert.equal(received.headers[(authName || 'authorization').toLowerCase()], (authType === 'bearer' ? 'Bearer ' : authPrefix ? authPrefix + ' ' : '') + key);
    const output = sink();
    assert.equal(await apiRequest(profile, 'GET', 'projects?limit=2', { stdout: output }), 0);
    assert.equal(received.url.searchParams.get('limit'), '2');
    assert.equal(output.text.includes(secret), false); assert.match(output.text, /\[redacted\]/);
  });
}

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
  const profile = { id: 'project-api', type: 'token', fields: { baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/', authType: 'bearer' }, secrets: { token: secret } };
  const output = sink();
  assert.equal(await apiRequest(profile, 'POST', 'projects', { body: '{"name":"demo-project"}', stdout: output }), 0);
  assert.equal(output.text, 'hello [redacted] goodbye');
  assert.deepEqual(received, { url: '/api/projects', method: 'POST', body: '{"name":"demo-project"}' });
  await assert.rejects(apiRequest(profile, 'GET', 'redirect'), /redirect/);
  assert.equal(calls, 2, 'redirect destination was never requested');
  assert.deepEqual(await apiRequest(profile, 'GET', 'unauthorized', { probe: true }), { ok: false, code: 'rejected', detail: { status: 401 } });
  assert.equal((await testCredential(profile)).code, 'ok');
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await testCredential(profile, { signal: cancelled.signal })).code, 'timeout');
  for (const target of ['https://other.test/api', '//other.test', '/api/states', '../outside', '%2e%2e/outside', 'foo\\outside', '#fragment']) assert.throws(() => apiTarget(profile, target));
  assert.throws(() => apiTarget({ id: 'no-address', fields: {} }, 'x'), /t3-vault run/);
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
  const out = sink(), err = sink();
  const code = await sshRequest({ ...ssh, knownHostsFile: '/synthetic/known_hosts/build-server', hostKeyType: 'ssh-ed25519' }, ['uptime'], { stdin: 'ignore', stdout: out, stderr: err,
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, '/usr/bin/ssh'); assert.ok(args.includes('StrictHostKeyChecking=yes'));
      assert.equal(JSON.stringify(args).includes(secret), false);
      assert.deepEqual(args.slice(-2), ['192.0.2.1', 'uptime']);
      return spawn(process.execPath, [fixtureFile], options);
    },
  });
  assert.equal(code, 0); assert.equal(out.text, 'output [redacted] done'); assert.equal(err.text, 'error [redacted] done');
  const controller = new AbortController(); let interrupted;
  t.after(() => interrupted?.kill());
  await assert.rejects(sshRequest({ ...ssh, knownHostsFile: '/synthetic/known_hosts/build-server', hostKeyType: 'ssh-ed25519' }, ['true'], { stdin: 'ignore', signal: controller.signal,
    spawnProcess: (_executable, _args, options) => {
      interrupted = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
      interrupted.once('spawn', () => controller.abort());
      return interrupted;
    },
  }), /SSH could not start or was interrupted/);
  if (interrupted.signalCode === null && interrupted.exitCode === null) await once(interrupted, 'close');
  assert.equal(interrupted.signalCode, 'SIGKILL');
});

test('SSH keeps a known_hosts path literal, even with a % in it', async () => {
  let args;
  await sshRequest({ ...ssh, knownHostsFile: '/synthetic/100%done/build-server', hostKeyType: 'ssh-ed25519' }, ['uptime'], { stdin: 'ignore', stdout: sink(), stderr: sink(), spawnProcess: (_executable, given, options) => { args = given; return spawn(process.execPath, ['-e', ''], options); } });
  assert.ok(args.includes('UserKnownHostsFile=/synthetic/100%%done/build-server'));
  assert.equal(execFileSync('/usr/bin/ssh', ['-G', '-F', '/dev/null', '-o', args[args.findIndex(arg => arg.startsWith('UserKnownHostsFile=')) ], 'x'], { encoding: 'utf8' }).match(/^userknownhostsfile (.*)$/m)[1], '/synthetic/100%done/build-server');
});

test('SSH with a key hands it over in a private file that is gone afterwards, never in arguments or the environment', async t => {
  const { root } = await fixture(t);
  const line = 'Zml4dHVyZS1wcml2YXRlLWtleS1ib2R5LWxpbmU', key = `fixture key header\n${line}\nfixture key footer\n`;
  const printer = path.join(root, 'print.cjs'); await fs.writeFile(printer, 'process.stdout.write(process.argv[2]);');
  const out = sink(); let seen;
  const code = await sshRequest({ id: 'box', type: 'ssh', fields: { host: '192.0.2.5', port: 2200, username: 'deploy', auth: 'key', publicKey: 'ssh-ed25519 AAAA' }, secrets: { privateKey: key }, knownHostsFile: '/synthetic/known_hosts/box', hostKeyType: 'ssh-ed25519' }, ['uptime'], { stdin: 'ignore', stdout: out, stderr: sink(),
    spawnProcess: (_executable, args, options) => {
      const file = args[args.indexOf('-i') + 1];
      seen = { args, env: options.env, file };
      assert.equal(args.includes('IdentitiesOnly=yes'), true); assert.equal(args.includes('BatchMode=yes'), true);
      assert.equal(args[args.indexOf('-p') + 1], '2200'); assert.equal(args[args.indexOf('-l') + 1], 'deploy');
      return spawn(process.execPath, [printer, 'printed ' + line], options);
    },
  });
  assert.equal(code, 0);
  assert.equal(out.text, 'printed [redacted]', 'a line of the key is hidden too');
  assert.equal(JSON.stringify(seen.args).includes(line), false);
  assert.equal(Object.values(seen.env).some(value => value.includes(line)), false);
  assert.equal(seen.env.T3_CREDENTIAL_PASSWORD, process.env.T3_CREDENTIAL_PASSWORD);
  await assert.rejects(fs.stat(seen.file), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.dirname(seen.file)), { code: 'ENOENT' });
});

test('SSH hosts accept IPv6 addresses including leading ::', async t => {
  const { store } = await fixture(t);
  for (const host of ['::1', '::', '2001:db8::1']) {
    await create(store, { ...withFields(ssh, { host }), id: 'v6-' + host.length });
  }
  await assert.rejects(create(store, { ...withFields(ssh, { host: '-oProxyCommand=bad' }), id: 'bad-host' }));
});

test('API helper reports HTTP status on stderr for non-probe failures without the secret', async t => {
  const server = createServer((req, res) => { res.writeHead(401); res.end(secret); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const profile = { id: 'project-api', type: 'token', fields: { baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/', authType: 'bearer' }, secrets: { token: secret } };
  const output = sink(), error = sink();
  assert.equal(await apiRequest(profile, 'GET', 'projects', { stdout: output, stderr: error }), 1);
  assert.equal(output.text, '[redacted]');
  assert.match(error.text, /HTTP 401/);
  assert.equal((output.text + error.text).includes(secret), false);
});
