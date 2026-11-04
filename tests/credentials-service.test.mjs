import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCredentialStore } from '../docker/setup/credentials.mjs';
import { createCredentialIO } from '../docker/setup/credentials/io.mjs';
import { createHostKeys, parseKey, reachHost } from '../docker/setup/credentials/hostkeys.mjs';
import { createCredentialsService } from '../docker/setup/credentials/service.mjs';
import { publicTypes } from '../docker/setup/credentials/types.mjs';
import { apiRequest, sshRequest } from '../docker/setup/credentials/run.mjs';
import { credentialKey } from './fixtures/credential-keys.mjs';
const ssh = { id: 'build-server', type: 'ssh', fields: { host: '192.0.2.10', port: 22, username: 'deploy', auth: 'password' }, secrets: { password: 'synthetic-pass' } };
const api = { id: 'project-api', type: 'token', fields: { baseUrl: 'https://api.example.test/v1/', authType: 'bearer' }, secrets: { token: 'synthetic-token' } };
const keyed = { id: 'key-server', type: 'ssh', fields: { host: '192.0.2.11', port: 22, username: 'deploy', auth: 'key' }, secrets: { privateKey: 'fixture-pasted-key-text' } };
const made = { privateKey: 'fixture-generated-key-text\n', publicKey: 'ssh-ed25519 AAAAgenerated t3-vault:fixture' };
const opener = async (text, { comment }) => ({ privateKey: 'opened ' + text + '\n', publicKey: 'ssh-ed25519 AAAAopened ' + comment });
const withFields = (credential, fields) => ({ ...credential, fields: { ...credential.fields, ...fields } });
const usage = { invalidate() {}, async annotate(credentials) { return { credentials: credentials.map(row => ({ ...row, usedIn: [] })), usageAt: new Date().toISOString(), usageWarnings: [] }; } };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-service-')), io = createCredentialIO({ directory });
  // Always pass home: saving an SSH credential adds a line to <home>/.ssh/config.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-service-home-'));
  const key = credentialKey(); let offered = key, netFail = null, signins = 0, scans = 0, reachCalls = 0;
  const keys = createHostKeys({ io, home, reach: async () => { reachCalls++; throw new Error('preflight must not run'); }, run: async (program, args) => {
    if (program.endsWith('keyscan')) {
      scans++;
      if (netFail === 'unreachable') return { code: 1, stdout: '', stderr: 'ssh: connect to host: Connection refused' };
      if (netFail === 'timeout') return { code: 1, stdout: '', stderr: 'Connection timed out' };
      if (netFail === 'throttled') return { code: 1, stdout: '', stderr: 'Connection closed by remote host' };
      if (!offered) return { code: 1, stdout: '# host:22 SSH-2.0-fixture\n', stderr: '' };
      const wanted = String(args[args.indexOf('-t') + 1] || '').split(',');
      const match = wanted.some(kind => kind === 'ed25519' ? offered.type === 'ssh-ed25519' : kind === 'rsa' ? offered.type === 'ssh-rsa' : kind === 'ecdsa' ? offered.type.startsWith('ecdsa-') : false);
      if (!match) return { code: 1, stdout: '# host:22 SSH-2.0-fixture\n', stderr: '' };
      return { code: 0, stdout: `host ${offered.type} ${offered.key}\n`, stderr: '' };
    }
    return { code: 0, stdout: offered ? '256 ' + offered.fingerprint + ' (ED25519)' : '', stderr: '' };
  } });
  const store = createCredentialStore({ directory, io, hostKeys: keys, home });
  const strictTest = async profile => {
    signins++;
    if (netFail) return { ok: false, code: netFail, detail: {} };
    if (profile.knownHostsFile) {
      try {
        const pinned = String(await fs.readFile(profile.knownHostsFile, 'utf8')).trim().split(/\s+/).pop();
        if (!offered || offered.key !== pinned) return { ok: false, code: 'host-key-changed', detail: {} };
      } catch { return { ok: false, code: 'host-key-changed', detail: {} }; }
    }
    return { ok: true, code: 'ok', detail: { user: profile.fields.username } };
  };
  const service = createCredentialsService({ store, usage, keygen: async () => made, keyOpener: opener, test: async (profile, testOptions) => testOptions.test ? testOptions.test(profile) : strictTest(profile), ...options });
  t.after(() => { service.close(); return Promise.all([directory, home].map(folder => fs.rm(folder, { recursive: true, force: true }))); });
  return { directory, home, io, key, keys, store, service, create: credential => store.save({ create: true, credential }), offered(value) { offered = value; }, reachable(value) { netFail = value?.ok ? null : value.code; }, failNet(code) { netFail = code; }, get signins() { return signins; }, get scans() { return scans; }, get reachCalls() { return reachCalls; } };
}

test('scan only reads host details and never signs in, persists state or reads a secret', async t => {
  const f = await fixture(t); await f.create(ssh);
  const before = await fs.readFile(path.join(f.directory, 'state.json'), 'utf8');
  const result = await f.service.handle('/credentials/scan', { id: ssh.id });
  assert.equal(result.hostKey.state, 'new'); assert.equal(result.hostKey.presented.fingerprint, f.key.fingerprint); assert.equal(f.signins, 0);
  assert.equal(await fs.readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
  assert.equal(JSON.stringify(result).includes(ssh.secrets.password), false);
});

test('saved tests block before authentication until explicit fresh fingerprint trust', async t => {
  const f = await fixture(t), saved = (await f.create(ssh)).credential;
  let result = await f.service.handle('/credentials/test', { id: ssh.id });
  assert.equal(result.ok, true); assert.equal(result.result.code, 'host-key-untrusted'); assert.equal(f.signins, 0);
  await f.service.handle('/credentials/trust', { id: ssh.id, fingerprint: f.key.fingerprint });
  const scansBefore = f.scans;
  result = await f.service.handle('/credentials/test', { id: ssh.id });
  assert.equal(result.result.code, 'ok'); assert.equal(f.signins, 1); assert.equal(f.scans, scansBefore, 'a pinned test must not rescan');
  const next = credentialKey(); f.offered(next);
  result = await f.service.handle('/credentials/test', { id: ssh.id });
  assert.equal(result.result.code, 'host-key-changed'); assert.equal(f.signins, 2, 'strict verification still blocks a changed key');
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
    return { ok: true, code: 'ok', detail: { user: profile.fields.username } };
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
  let answer = await f.service.handle('/credentials/test', { id: ssh.id, draft: { ...ssh, secrets: {} } });
  assert.equal(answer.result.code, 'ok');
  answer = await f.service.handle('/credentials/test', { id: ssh.id, draft: { ...withFields(ssh, { host: 'other-host' }), secrets: {} } });
  assert.equal(answer.result.code, 'host-key-untrusted');
  for (const draft of [{ ...ssh, id: 'other', secrets: {} }, { ...api, id: ssh.id, secrets: {} }]) await assert.rejects(f.service.handle('/credentials/test', { id: ssh.id, draft }), { status: 400 });
});

test('saving comes before optional trust and exposes partial trust failure honestly', async t => {
  const f = await fixture(t), oldKey = f.key; f.offered(credentialKey());
  const answer = await f.service.handle('/credentials/create', { credential: ssh, trust: { fingerprint: oldKey.fingerprint } });
  assert.equal(answer.ok, true); assert.equal(answer.credential.id, ssh.id); assert.equal(answer.trust.code, 'key-changed');
  assert.equal(answer.credential.hostKey, null); assert.equal((await f.store.list()).credentials.length, 1);
  const saved = await f.service.handle('/credentials/save', { credential: { ...ssh, secrets: {} }, revision: answer.credential.revision, trust: { fingerprint: answer.trust.presented.fingerprint } });
  assert.equal(saved.trust.ok, true); assert.equal(saved.credential.hostKey.fingerprint, answer.trust.presented.fingerprint);
});

test('a credential edited during trust scanning cannot acquire trust for an obsolete target', async t => {
  const f = await fixture(t); const saved = (await f.create(ssh)).credential;
  const oldInspect = f.keys.inspect;
  f.keys.inspect = async (...args) => { const answer = await oldInspect(...args); await f.store.save({ credential: withFields(ssh, { host: 'other-host' }), revision: saved.revision }); return answer; };
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

test('a credential with no way to test it says so instead of inventing a result', async t => {
  const f = await fixture(t);
  await f.create({ id: 'plain-token', type: 'token', fields: {}, secrets: { token: 'synthetic-token' } });
  assert.deepEqual(await f.service.handle('/credentials/test', { id: 'plain-token' }), { ok: true, result: null });
  assert.equal(f.signins, 0);
});

for (const [status, code] of [[200, 'ok'], [204, 'ok'], [401, 'rejected'], [403, 'rejected'], [404, 'not-found'], [500, 'http-error'], [302, 'redirect']]) test('API test classifies HTTP ' + status + ' without a response body or header', async () => {
  let cancelled = 0;
  const result = await apiRequest(api, 'GET', '', { probe: true, fetchRequest: async (_url, options) => {
    assert.equal(options.redirect, 'manual'); return { status, ok: status < 300, body: { cancel() { cancelled++; } }, headers: { secret: api.secrets.token } };
  } });
  assert.equal(result.code, code); assert.deepEqual(result.detail, { status }); assert.equal(cancelled, 1); assert.equal(JSON.stringify(result).includes(api.secrets.token), false);
});
for (const [error, code] of [[{ cause: { code: 'CERT_HAS_EXPIRED' } }, 'certificate'], [{ cause: { code: 'ECONNREFUSED' } }, 'unreachable'], [{ name: 'AbortError' }, 'timeout']]) test('API test classifies ' + code + ' without returning diagnostics', async () => {
  const result = await apiRequest(api, 'GET', '', { probe: true, fetchRequest: async () => { throw { ...error, message: api.secrets.token }; } }); assert.equal(result.code, code); assert.deepEqual(result.detail, {});
});

test('SSH helper refuses an untrusted credential before starting a process', async () => {
  let spawned = false;
  await assert.rejects(sshRequest(ssh, ['true'], { spawnProcess() { spawned = true; } }), { code: 'host-key-untrusted' });
  assert.equal(spawned, false);
});

test('SSH helper refuses a credential of another type before starting a process', async () => {
  let spawned = false;
  await assert.rejects(sshRequest(api, ['true'], { spawnProcess() { spawned = true; } }), /t3-vault run/);
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
  assert.equal(result.code, code); assert.equal(JSON.stringify(result).includes(ssh.secrets.password), false);
});

test('a review opened before an address change cannot show or trust keys for a new target', async t => {
  const f = await fixture(t), original = (await f.create(ssh)).credential;
  await f.store.save({ credential: withFields(ssh, { host: 'other-host' }), revision: original.revision });
  for (const route of ['/credentials/scan', '/credentials/trust']) {
    await assert.rejects(f.service.handle(route, { id: original.id, revision: original.revision, fingerprint: f.key.fingerprint }), { status: 409, code: 'changed' });
  }
  assert.equal(f.scans, 0); assert.equal(f.signins, 0); assert.equal((await f.store.public(ssh.id)).hostKey, null);
});

test('the page gets every type and whether plain ssh works, and saving from it is always marked as Setup', async t => {
  const f = await fixture(t);
  const empty = await f.service.handle('/credentials');
  assert.deepEqual(empty.types, publicTypes()); assert.equal(empty.sshAliases, false); assert.deepEqual(empty.credentials, []);
  const saved = await f.service.handle('/credentials/create', { credential: ssh, origin: { by: 'agent', threadId: 'made-up' } });
  assert.deepEqual(saved.credential.origin, { by: 'setup' }, 'a request body cannot claim to be an agent');
  assert.equal((await f.service.handle('/credentials')).sshAliases, true);
  await assert.rejects(f.service.handle('/credentials/unknown'), { status: 404, code: 'not-found' });
});

test('detection reads only what it is given and refuses more than a key file could be', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.handle('/credentials/detect', { text: 'ghp_' + 'fixture0000000000000000' })).detected.type, 'git');
  assert.equal((await f.service.handle('/credentials/detect', { text: '' })).detected, null);
  for (const text of [undefined, 42, 'x'.repeat(48 * 1024 + 1)]) await assert.rejects(f.service.handle('/credentials/detect', { text }), { status: 400 });
});

test('a pasted key is opened before anything is saved, so a bad one leaves nothing behind', async t => {
  const f = await fixture(t);
  await assert.rejects(createCredentialsService({ store: f.store, usage, keyOpener: async () => { throw Object.assign(new Error('That doesn’t look like a private key.'), { status: 400 }); } }).save({ credential: keyed }, { create: true }), /private key/);
  assert.deepEqual((await f.store.list()).credentials, []);
  const answer = await f.service.handle('/credentials/create', { credential: keyed, passphrase: 'synthetic-passphrase' });
  assert.equal(answer.credential.fields.publicKey, 'ssh-ed25519 AAAAopened t3-vault:key-server');
  assert.deepEqual(Object.keys((await f.store.forUse(keyed.id)).secrets), ['privateKey']);
  assert.equal((await f.store.forUse(keyed.id)).secrets.privateKey, 'opened fixture-pasted-key-text\n');
  assert.equal(JSON.stringify(answer).includes('fixture-pasted-key-text'), false);
  assert.equal(JSON.stringify(await fs.readFile(path.join(f.directory, 'credentials.json'), 'utf8')).includes('synthetic-passphrase'), false, 'the passphrase is never kept');
});

test('a key sign-in pins a new host on first use, and from then on a different key blocks it', async t => {
  const f = await fixture(t);
  const answer = await f.service.handle('/credentials/create', { credential: keyed });
  assert.deepEqual([answer.trust.ok, answer.trust.firstUse], [true, true]);
  assert.equal(answer.credential.hostKey.fingerprint, f.key.fingerprint); assert.equal(answer.credential.hostKey.firstUse, true);
  const scansAfterPin = f.scans;
  assert.equal((await f.service.handle('/credentials/test', { id: keyed.id })).result.code, 'ok'); assert.equal(f.signins, 1); assert.equal(f.scans, scansAfterPin, 'a pinned test must not rescan');
  const next = credentialKey(); f.offered(next);
  const changed = await f.service.handle('/credentials/test', { id: keyed.id });
  assert.equal(changed.result.code, 'host-key-changed'); assert.equal(f.signins, 2, 'strict verification still blocks a changed key');
  assert.equal((await f.store.public(keyed.id)).hostKey.fingerprint, f.key.fingerprint);
});

test('an unreachable host still lets a key be saved, and the first working test pins it', async t => {
  const f = await fixture(t); f.reachable({ ok: false, code: 'unreachable', detail: {} });
  const answer = await f.service.handle('/credentials/create', { credential: keyed });
  assert.equal(answer.ok, true); assert.deepEqual(answer.trust, { ok: false, code: 'unreachable' }); assert.equal(answer.credential.hostKey, null);
  assert.equal((await f.service.handle('/credentials/test', { id: keyed.id })).result.code, 'unreachable'); assert.equal(f.signins, 0);
  f.reachable({ ok: true });
  const tested = await f.service.handle('/credentials/test', { id: keyed.id });
  assert.equal(tested.result.code, 'ok'); assert.equal(tested.result.hostKey.state, 'new'); assert.equal(f.signins, 1);
  assert.equal((await f.store.public(keyed.id)).hostKey.firstUse, true);
});

test('pinning on first use never applies to a password, which would hand it to whoever answered', async t => {
  const f = await fixture(t); await f.create(ssh);
  assert.deepEqual(await f.service.pinFirstUse(ssh.id), { ok: false, code: 'host-key-untrusted' });
  assert.equal((await f.store.public(ssh.id)).hostKey, null);
});

test('a generated key is offered once, can be saved, and expires', async t => {
  let at = Date.parse('2026-10-30T10:00:00Z');
  const f = await fixture(t, { clock: () => at });
  const offer = await f.service.handle('/credentials/generate-key', { id: keyed.id });
  assert.equal(offer.publicKey, made.publicKey); assert.match(offer.install, /authorized_keys/); assert.ok(offer.install.includes(made.publicKey));
  assert.equal(JSON.stringify(offer).includes(made.privateKey.trim()), false);
  const saved = await f.service.handle('/credentials/create', { credential: { ...keyed, secrets: {} }, generatedKeyId: offer.keyId });
  assert.equal((await f.store.forUse(keyed.id)).secrets.privateKey, made.privateKey); assert.equal(saved.credential.fields.publicKey, made.publicKey);
  await assert.rejects(f.service.handle('/credentials/create', { credential: { ...keyed, id: 'again', secrets: {} }, generatedKeyId: offer.keyId }), { code: 'key-expired' });
  const late = await f.service.handle('/credentials/generate-key', { id: 'late' });
  at += 31 * 60_000;
  await assert.rejects(f.service.handle('/credentials/create', { credential: { ...keyed, id: 'late', secrets: {} }, generatedKeyId: late.keyId }), { code: 'key-expired' });
  assert.deepEqual((await f.store.list()).credentials.map(row => row.id), [keyed.id]);
});

test('moving a saved password to a key proves the key works before the password goes', async t => {
  let sshCalls = [], verdict = { ok: true, code: 'ok', detail: {} };
  const f = await fixture(t, { ssh: async (credential, command) => { sshCalls.push({ credential, command }); return { ok: true, code: 'ok', detail: {} }; }, test: async () => verdict });
  const saved = (await f.create(ssh)).credential;
  await assert.rejects(f.service.handle('/credentials/install-key', { id: ssh.id }), { status: 409, code: 'host-key-untrusted' }, 'a password never goes to an unconfirmed server');
  assert.equal(sshCalls.length, 0);
  const trusted = await f.store.trust({ id: ssh.id, revision: saved.revision, key: f.key });
  await assert.rejects(f.service.handle('/credentials/install-key', { id: ssh.id, revision: 'stale' }), { code: 'changed' });
  verdict = { ok: false, code: 'auth-rejected', detail: {} };
  await assert.rejects(f.service.handle('/credentials/install-key', { id: ssh.id }), { code: 'install-failed' });
  assert.equal((await f.store.forUse(ssh.id)).secrets.password, ssh.secrets.password, 'the password stays until the key works');
  verdict = { ok: true, code: 'ok', detail: {} };
  const moved = await f.service.handle('/credentials/install-key', { id: ssh.id, revision: trusted.revision });
  assert.ok(sshCalls.at(-1).command[0].includes(made.publicKey));
  assert.equal(moved.credential.fields.auth, 'key'); assert.equal(moved.credential.fields.publicKey, made.publicKey);
  assert.equal(moved.credential.hostKey.fingerprint, f.key.fingerprint, 'the same server stays trusted');
  assert.deepEqual((await f.store.forUse(ssh.id)).secrets, { privateKey: made.privateKey });
  assert.equal((await fs.readFile(path.join(f.directory, 'credentials.json'), 'utf8')).includes(ssh.secrets.password), false);
  await assert.rejects(f.service.handle('/credentials/install-key', { id: api.id }), { code: 'not-found' });
});

test('installing with a one-time password needs a reviewed fingerprint and never saves the password', async t => {
  const password = 'synthetic-one-time-password', calls = [];
  const f = await fixture(t, { ssh: async (credential, command) => { calls.push({ credential, command }); return { ok: true, code: 'ok', detail: {} }; }, test: async () => ({ ok: true, code: 'ok', detail: {} }) });
  const input = { credential: { ...keyed, secrets: {} }, generate: true, install: { password } };
  await assert.rejects(f.service.save(input, { create: true }), { code: 'host-key-untrusted' });
  await assert.rejects(f.service.save({ ...input, install: {}, trust: { fingerprint: f.key.fingerprint } }, { create: true }), { status: 400, extra: { field: 'password' } });
  await assert.rejects(f.service.save({ ...input, trust: { fingerprint: credentialKey().fingerprint } }, { create: true }), { code: 'key-changed' });
  assert.equal(calls.length, 0); assert.deepEqual((await f.store.list()).credentials, []);
  const saved = await f.service.save({ ...input, trust: { fingerprint: f.key.fingerprint } }, { create: true, origin: { by: 'terminal' } });
  assert.equal(calls[0].credential.secrets.password, password); assert.equal(calls[0].credential.fields.auth, 'password');
  assert.equal(saved.credential.fields.auth, 'key'); assert.equal(saved.credential.hostKey.fingerprint, f.key.fingerprint);
  assert.deepEqual(saved.credential.origin, { by: 'terminal' });
  assert.deepEqual(Object.keys((await f.store.forUse(keyed.id)).secrets), ['privateKey']);
  assert.equal((await fs.readFile(path.join(f.directory, 'credentials.json'), 'utf8')).includes(password), false);
});

test('a key that fails after a one-time install leaves nothing saved and says the password wasn\'t kept', async t => {
  const f = await fixture(t, { ssh: async () => ({ ok: true, code: 'ok', detail: {} }), test: async () => ({ ok: false, code: 'auth-rejected', detail: {} }) });
  await assert.rejects(f.service.save({ credential: { ...keyed, secrets: {} }, generate: true, install: { password: 'synthetic-one-time-password' }, trust: { fingerprint: f.key.fingerprint } }, { create: true }), error => error.code === 'install-failed' && /wasn’t saved/.test(error.message));
  assert.deepEqual((await f.store.list()).credentials, []);
});

test('discovery prefers one Ed25519 query with no preflight connection', async t => {
  const f = await fixture(t); await f.create(ssh);
  const seen = [];
  const keys = createHostKeys({ io: f.io, home: f.home, reach: async () => { throw new Error('preflight must not run'); }, run: async (program, args) => {
    if (program.endsWith('keyscan')) { seen.push(args[args.indexOf('-t') + 1]); return { code: 0, stdout: `host ${f.key.type} ${f.key.key}\n`, stderr: '' }; }
    return { code: 0, stdout: '256 ' + f.key.fingerprint + ' (ED25519)', stderr: '' };
  } });
  const scanned = await keys.scan({ host: '192.0.2.10', port: 22 });
  assert.equal(scanned.ok, true); assert.deepEqual(seen, ['ed25519'], 'one query, Ed25519 first');
  assert.equal(f.reachCalls, 0);
});

test('discovery falls back to RSA before ECDSA, and never retries a throttled scan', async t => {
  const f = await fixture(t);
  const { randomBytes, createHash } = await import('node:crypto');
  const synthetic = type => {
    const name = Buffer.from(type), length = Buffer.alloc(4), keyLength = Buffer.alloc(4);
    length.writeUInt32BE(name.length); keyLength.writeUInt32BE(32);
    const wire = Buffer.concat([length, name, keyLength, randomBytes(32)]);
    return { type, key: wire.toString('base64'), fingerprint: 'SHA256:' + createHash('sha256').update(wire).digest('base64').replace(/=+$/, '') };
  };
  const rsaKey = synthetic('ssh-rsa');
  const seen = [];
  const keys = createHostKeys({ io: f.io, home: f.home, reach: async () => { throw new Error('preflight must not run'); }, run: async (program, args) => {
    if (program.endsWith('keyscan')) { const kind = args[args.indexOf('-t') + 1]; seen.push(kind);
      if (kind === 'ed25519') return { code: 1, stdout: '# host:22 SSH-2.0-fixture\n', stderr: '' };
      return { code: 0, stdout: `host ${rsaKey.type} ${rsaKey.key}\n`, stderr: '' }; }
    return { code: 0, stdout: `256 ${rsaKey.fingerprint} (RSA)`, stderr: '' };
  } });
  const scanned = await keys.scan({ host: '192.0.2.10', port: 22 });
  assert.equal(scanned.ok, true); assert.equal(scanned.key.type, 'ssh-rsa'); assert.deepEqual(seen, ['ed25519', 'rsa']);

  const throttledSeen = [];
  const throttled = createHostKeys({ io: f.io, home: f.home, reach: async () => { throw new Error('preflight must not run'); }, run: async program => {
    if (String(program).endsWith('keyscan')) { throttledSeen.push(1); return { code: 1, stdout: '', stderr: 'Connection closed by remote host' }; }
    return { code: 1, stdout: '', stderr: '' };
  } });
  const blocked = await throttled.scan({ host: '192.0.2.10', port: 22 });
  assert.equal(blocked.code, 'scan-failed'); assert.equal(throttledSeen.length, 1, 'a throttled scan must not try the next type');
  let attempts = 0;
  const silent = createHostKeys({ io: f.io, run: async () => { attempts++; return { code: 1, stdout: '', stderr: '' }; } });
  assert.equal((await silent.scan({ host: '127.0.0.1', port: 1 })).code, 'unreachable');
  assert.equal(attempts, 1, 'a silent failure must not try the next type');
});

test('discovery classifies network failures without a preflight', async t => {
  const f = await fixture(t); await f.create(ssh);
  f.failNet('unreachable');
  assert.equal((await f.service.handle('/credentials/test', { id: ssh.id })).result.code, 'unreachable');
  f.failNet('timeout');
  assert.equal((await f.service.handle('/credentials/test', { id: ssh.id })).result.code, 'timeout');
  f.failNet(null); f.offered(null);
  assert.equal((await f.service.handle('/credentials/test', { id: ssh.id })).result.code, 'scan-failed');
});

test('reachHost reports what happened without throwing', async () => {
  assert.equal((await reachHost({ host: '127.0.0.1', port: 1 }, { connect: () => { throw new Error('fixture'); } })).code, 'unreachable');
  const stopped = new AbortController(); stopped.abort();
  assert.equal((await reachHost({ host: '127.0.0.1', port: 1 }, { signal: stopped.signal })).code, 'timeout');
});
