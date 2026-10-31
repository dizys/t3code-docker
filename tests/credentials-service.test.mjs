import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCredentialStore } from '../docker/setup/credentials.mjs';
import { createCredentialIO } from '../docker/setup/credentials/io.mjs';
import { createHostKeys, parseKey, reachHost } from '../docker/setup/credentials/hostkeys.mjs';
import { createCredentialsService } from '../docker/setup/credentials/service.mjs';
import { apiRequest, sshRequest } from '../docker/setup/credentials/run.mjs';
import { credentialKey } from './fixtures/credential-keys.mjs';
const ssh = { id: 'build-server', type: 'ssh', host: '192.0.2.10', port: 22, username: 'deploy', secret: 'synthetic-pass' };
const api = { id: 'project-api', type: 'api', baseUrl: 'https://api.example.test/v1/', secret: 'synthetic-token' };
const usage = { invalidate() {}, async annotate(credentials) { return { credentials: credentials.map(row => ({ ...row, usedIn: [] })), usageAt: new Date().toISOString(), usageWarnings: [] }; } };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-service-')), io = createCredentialIO({ directory });
  const key = credentialKey(); let offered = key, reachable = { ok: true }, signins = 0, scans = 0;
  const keys = createHostKeys({ io, reach: async () => reachable, run: async (program, args) => {
    if (program.endsWith('keyscan')) { scans++; if (!offered) return { code: 1, stdout: '' }; return { code: 0, stdout: `host ${offered.type} ${offered.key}\n` }; }
    return { code: 0, stdout: offered ? '256 ' + offered.fingerprint + ' (ED25519)' : '' };
  } });
  const store = createCredentialStore({ directory, io, hostKeys: keys });
  const service = createCredentialsService({ store, usage, test: async (profile, options) => { signins++; return options.test ? options.test(profile) : { ok: true, code: 'ok', detail: { user: profile.username } }; }, ...options });
  t.after(() => { service.close(); return fs.rm(directory, { recursive: true, force: true }); });
  return { directory, io, key, keys, store, service, create: credential => store.save({ create: true, credential }), offered(value) { offered = value; }, reachable(value) { reachable = value; }, get signins() { return signins; }, get scans() { return scans; } };
}

test('scan only reads host details and never signs in, persists state or reads a secret', async t => {
  const f = await fixture(t); await f.create(ssh);
  const before = await fs.readFile(path.join(f.directory, 'state.json'), 'utf8');
  const result = await f.service.handle('/credentials/scan', { id: ssh.id });
  assert.equal(result.hostKey.state, 'new'); assert.equal(result.hostKey.presented.fingerprint, f.key.fingerprint); assert.equal(f.signins, 0);
  assert.equal(await fs.readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
  assert.equal(JSON.stringify(result).includes(ssh.secret), false);
});

test('saved tests block before authentication until explicit fresh fingerprint trust', async t => {
  const f = await fixture(t), saved = (await f.create(ssh)).credential;
  let result = await f.service.handle('/credentials/test', { id: ssh.id });
  assert.equal(result.ok, true); assert.equal(result.result.code, 'host-key-untrusted'); assert.equal(f.signins, 0);
  await f.service.handle('/credentials/trust', { id: ssh.id, fingerprint: f.key.fingerprint });
  result = await f.service.handle('/credentials/test', { id: ssh.id });
  assert.equal(result.result.code, 'ok'); assert.equal(f.signins, 1);
  const next = credentialKey(); f.offered(next);
  result = await f.service.handle('/credentials/test', { id: ssh.id });
  assert.equal(result.result.code, 'host-key-changed'); assert.equal(f.signins, 1);
  assert.equal(result.result.detail.trusted.fingerprint, f.key.fingerprint);
  assert.equal(result.result.detail.presented.fingerprint, next.fingerprint);
  assert.equal((await f.store.public(ssh.id)).revision, saved.revision);
  await assert.rejects(f.service.handle('/credentials/trust', { id: ssh.id, fingerprint: f.key.fingerprint }), { status: 409, code: 'key-changed' });
  assert.equal((await f.store.public(ssh.id)).hostKey.fingerprint, f.key.fingerprint);
});

test('draft tests pin only the fingerprint explicitly approved and leave no saved traces', async t => {
  let calls = 0, temporary;
  const f = await fixture(t, { test: async profile => {
    calls++; temporary = path.dirname(profile.knownHostsFile);
    assert.equal((await fs.stat(profile.knownHostsFile)).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(profile.knownHostsFile, 'utf8'), `${ssh.id} ${f.key.type} ${f.key.key}\n`);
    return { ok: true, code: 'ok', detail: { user: profile.username } };
  } });
  const before = await fs.readdir(f.directory);
  let result = await f.service.handle('/credentials/test', { draft: ssh }); assert.equal(result.result.code, 'host-key-untrusted');
  result = await f.service.handle('/credentials/test', { draft: ssh, trust: { fingerprint: f.key.fingerprint } });
  assert.equal(result.result.code, 'ok'); assert.equal(calls, 1);
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.directory), before);
  f.offered(credentialKey());
  result = await f.service.handle('/credentials/test', { draft: ssh, trust: { fingerprint: f.key.fingerprint } });
  assert.equal(result.result.code, 'host-key-changed'); assert.equal(calls, 1);
});

test('a changed draft target must get fresh trust even when the host offers the same key', async t => {
  const f = await fixture(t); const saved = (await f.create(ssh)).credential;
  await f.store.trust({ id: ssh.id, revision: saved.revision, key: f.key });
  let answer = await f.service.handle('/credentials/test', { id: ssh.id, draft: { ...ssh, secret: '' } });
  assert.equal(answer.result.code, 'ok');
  answer = await f.service.handle('/credentials/test', { id: ssh.id, draft: { ...ssh, host: 'other-host', secret: '' } });
  assert.equal(answer.result.code, 'host-key-untrusted');
  for (const draft of [{ ...ssh, id: 'other', secret: '' }, { ...api, id: ssh.id, secret: '' }]) await assert.rejects(f.service.handle('/credentials/test', { id: ssh.id, draft }), { status: 400 });
});

test('saving comes before optional trust and exposes partial trust failure honestly', async t => {
  const f = await fixture(t), oldKey = f.key; f.offered(credentialKey());
  const answer = await f.service.handle('/credentials/create', { credential: ssh, trust: { fingerprint: oldKey.fingerprint } });
  assert.equal(answer.ok, true); assert.equal(answer.credential.id, ssh.id); assert.equal(answer.trust.code, 'key-changed');
  assert.equal(answer.credential.hostKey, null); assert.equal((await f.store.list()).credentials.length, 1);
  const saved = await f.service.handle('/credentials/save', { credential: { ...ssh, secret: '' }, revision: answer.credential.revision, trust: { fingerprint: answer.trust.presented.fingerprint } });
  assert.equal(saved.trust.ok, true); assert.equal(saved.credential.hostKey.fingerprint, answer.trust.presented.fingerprint);
});

test('a credential edited during trust scanning cannot acquire trust for an obsolete target', async t => {
  const f = await fixture(t); const saved = (await f.create(ssh)).credential;
  const oldInspect = f.keys.inspect;
  f.keys.inspect = async (...args) => { const answer = await oldInspect(...args); await f.store.save({ credential: { ...ssh, host: 'other-host' }, revision: saved.revision }); return answer; };
  await assert.rejects(f.service.handle('/credentials/trust', { id: ssh.id, fingerprint: f.key.fingerprint }), { code: 'changed' });
  assert.equal((await f.store.public(ssh.id)).hostKey, null);
});

test('unreachable, timeout and scans without keys never attempt authentication', async t => {
  const f = await fixture(t); await f.create(ssh);
  for (const code of ['unreachable', 'timeout']) { f.reachable({ ok: false, code, detail: {} }); assert.equal((await f.service.handle('/credentials/test', { id: ssh.id })).result.code, code); }
  f.reachable({ ok: true }); f.offered(null);
  assert.equal((await f.service.handle('/credentials/test', { id: ssh.id })).result.code, 'scan-failed'); assert.equal(f.signins, 0);
});

test('three in-flight tests are allowed; excess checks are refused and shutdown aborts all', async t => {
  const waiting = [], f = await fixture(t, { test: async (_profile, { signal }) => new Promise(resolve => { waiting.push(() => resolve({ ok: true, code: 'ok' })); signal.addEventListener('abort', () => resolve({ ok: false, code: 'timeout' }), { once: true }); }) });
  await f.create(api);
  const jobs = [1, 2, 3].map(() => f.service.handle('/credentials/test', { id: api.id }));
  // All three reserve their lease synchronously before any store read.
  await assert.rejects(f.service.handle('/credentials/test', { id: api.id }), { status: 409, code: 'busy' });
  while (waiting.length < 3) await new Promise(resolve => setImmediate(resolve));
  f.service.close(); const results = await Promise.all(jobs); assert.ok(results.every(answer => answer.result.code === 'timeout'));
  await assert.rejects(f.service.handle('/credentials/test', { id: api.id }), { status: 503 });
});

for (const [status, code] of [[200, 'ok'], [204, 'ok'], [401, 'rejected'], [403, 'rejected'], [404, 'not-found'], [500, 'http-error'], [302, 'redirect']]) test('API test classifies HTTP ' + status + ' without a response body or header', async () => {
  let cancelled = 0;
  const result = await apiRequest(api, 'GET', '', { probe: true, fetchRequest: async (_url, options) => {
    assert.equal(options.redirect, 'manual'); return { status, ok: status < 300, body: { cancel() { cancelled++; } }, headers: { secret: api.secret } };
  } });
  assert.equal(result.code, code); assert.deepEqual(result.detail, { status }); assert.equal(cancelled, 1); assert.equal(JSON.stringify(result).includes(api.secret), false);
});
for (const [error, code] of [[{ cause: { code: 'CERT_HAS_EXPIRED' } }, 'certificate'], [{ cause: { code: 'ECONNREFUSED' } }, 'unreachable'], [{ name: 'AbortError' }, 'timeout']]) test('API test classifies ' + code + ' without returning diagnostics', async () => {
  const result = await apiRequest(api, 'GET', '', { probe: true, fetchRequest: async () => { throw { ...error, message: api.secret }; } }); assert.equal(result.code, code); assert.deepEqual(result.detail, {});
});

test('SSH helper refuses an untrusted credential before starting a process', async () => {
  let spawned = false;
  await assert.rejects(sshRequest(ssh, ['true'], { spawnProcess() { spawned = true; } }), { code: 'host-key-untrusted' });
  assert.equal(spawned, false);
});

test('host key parser ignores markers and fingerprints a real public key', () => {
  const key = credentialKey(); assert.equal(parseKey('host ' + key.type + ' ' + key.key).fingerprint, key.fingerprint);
  for (const line of ['# comment', '@revoked host ' + key.type + ' ' + key.key, 'host bad key', 'host ssh-ed25519 bad']) assert.equal(parseKey(line), null);
});

for (const [clientLine, remoteLine, status, code] of [
  ['', 'Permission denied\n', 0, 'ok'], ['', 'Permission denied\n', 1, 'failed'],
  ['Permission denied (password).', '', 255, 'auth-rejected'], ['Host key verification failed.', '', 255, 'host-key-changed'],
  ['ssh: connect to host: Connection refused', '', 255, 'unreachable'], ['Connection timed out', '', 255, 'timeout'],
  ['unexpected synthetic-pass message', '', 255, 'failed'],
]) test('SSH client diagnostics classify ' + code + ' independently of remote stderr', async () => {
  const { spawn } = await import('node:child_process');
  const result = await sshRequest({ ...ssh, knownHostsFile: '/synthetic/pinned-key', hostKeyType: 'ssh-ed25519' }, ['true'], { probe: true, stdin: 'ignore', spawnProcess(_program, args, options) {
    const log = args[args.indexOf('-E') + 1];
    return spawn(process.execPath, ['-e', "require('node:fs').writeFileSync(process.env.CLIENT_LOG,process.env.CLIENT_LINE);process.stderr.write(process.env.REMOTE_LINE);process.exitCode=Number(process.env.RESULT_CODE)"], { ...options, env: { ...options.env, CLIENT_LOG: log, CLIENT_LINE: clientLine, REMOTE_LINE: remoteLine, RESULT_CODE: String(status) } });
  } });
  assert.equal(result.code, code); assert.equal(JSON.stringify(result).includes(ssh.secret), false);
});
