import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCredentialStore, credentialFailure } from '../docker/setup/credentials.mjs';
import { createCredentialIO } from '../docker/setup/credentials/io.mjs';
import { createHostKeys } from '../docker/setup/credentials/hostkeys.mjs';
import { credentialKey } from './fixtures/credential-keys.mjs';
const ssh = { id: 'build-server', label: 'No longer stored', type: 'ssh', host: '192.0.2.10', port: 22, username: 'deploy', secret: 'synthetic-private-password' };
const api = { id: 'project-api', type: 'api', baseUrl: 'https://api.example.test/v1/', secret: 'synthetic-private-token' };
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-store-')), directory = path.join(root, 'credentials');
  const io = createCredentialIO({ directory, effects: options.effects || fs }), key = credentialKey();
  const hostKeys = createHostKeys({ io, home: root, ...options.keys });
  const store = createCredentialStore({ directory, io, hostKeys, ...options.store });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, directory, io, hostKeys, key, store, create: credential => store.save({ credential, create: true }) };
}

test('v2 stores immutable names, independent random revisions and server-owned dates', async t => {
  let ms = Date.parse('2026-10-30T10:00:00Z');
  const { store, create, directory } = await fixture(t, { store: { clock: () => ms } });
  const a = (await create({ ...ssh, revision: 'bad', createdAt: 'bad' })).credential;
  const b = (await create(api)).credential;
  assert.match(a.revision, /^[a-f0-9]{16}$/); assert.notEqual(a.revision, b.revision);
  assert.equal(a.createdAt, '2026-10-30T10:00:00.000Z'); assert.equal(a.secretChangedAt, a.createdAt);
  ms += 1000;
  const edited = (await store.save({ credential: { ...ssh, secret: '', username: 'other' }, revision: a.revision })).credential;
  assert.equal(edited.createdAt, a.createdAt); assert.notEqual(edited.updatedAt, a.updatedAt); assert.equal(edited.secretChangedAt, a.secretChangedAt);
  await store.save({ credential: { ...api, secret: '' }, revision: b.revision });
  const raw = JSON.parse(await fs.readFile(path.join(directory, 'credentials.json'), 'utf8'));
  assert.equal(raw.version, 2); assert.equal(Object.hasOwn(raw.profiles[0], 'label'), false);
  assert.equal(JSON.stringify(await store.list()).includes(ssh.secret), false);
  await assert.rejects(store.save({ credential: { ...ssh, type: 'api', baseUrl: api.baseUrl }, revision: edited.revision }), /change its type/);
  await assert.rejects(store.draft({ id: ssh.id, draft: { ...ssh, id: 'different', secret: '' } }), /name cannot change/);
  await assert.rejects(store.draft({ id: ssh.id, draft: { ...api, id: ssh.id, secret: '' } }), /change its type/);
  await assert.rejects(store.remove({ id: '../escape', revision: '' }), { code: 'invalid' });
});

test('migration drops labels, sets mtime dates and carries a single existing key without changing user known_hosts', async t => {
  const carried = credentialKey(), { directory, root, io, store } = await fixture(t, { keys: { run: async (program, args) => {
    assert.equal(program, '/usr/bin/ssh-keygen'); assert.deepEqual(args.slice(0, 2), ['-F', '[192.0.2.10]:2222']);
    return { code: 0, stdout: '# comment\n|1|hash|hash ' + carried.type + ' ' + carried.key + '\n' };
  } } });
  await io.prepare(); await fs.mkdir(path.join(root, '.ssh')); const userFile = path.join(root, '.ssh/known_hosts'); await fs.writeFile(userFile, 'person-owned');
  const file = path.join(directory, 'credentials.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, profiles: [{ ...ssh, port: 2222 }, api] }), { mode: 0o600 });
  const before = await fs.stat(file), listed = (await store.list()).credentials;
  assert.equal(listed[0].createdAt, before.mtime.toISOString()); assert.equal(listed[0].secretChangedAt, null);
  assert.equal(listed[0].hostKey.fingerprint, carried.fingerprint); assert.equal(listed[0].hostKey.carried, true);
  assert.equal(await fs.readFile(userFile, 'utf8'), 'person-owned');
  assert.equal(await fs.readFile(path.join(directory, 'known_hosts', ssh.id), 'utf8'), `${ssh.id} ${carried.type} ${carried.key}\n`);
  assert.equal((await fs.stat(path.join(directory, 'known_hosts', ssh.id))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['credentials.json', 'known_hosts', 'state.json']);
});

test('migration failure leaves the exact v1 bytes and does not leave carried trust', async t => {
  const key = credentialKey(); let breakStore = false;
  const { store, io, directory } = await fixture(t, { effects: { ...fs, rename: async (a, b) => { if (breakStore && b.endsWith('/credentials.json')) { breakStore = false; throw new Error('injected failure'); } return fs.rename(a, b); } }, keys: { legacy: undefined, run: async () => ({ code: 0, stdout: 'old ' + key.type + ' ' + key.key }) } });
  await io.prepare(); const raw = JSON.stringify({ version: 1, profiles: [ssh] });
  await fs.writeFile(path.join(directory, 'credentials.json'), raw, { mode: 0o600 }); breakStore = true;
  await assert.rejects(store.initialize(), { code: 'store' });
  assert.equal(await fs.readFile(path.join(directory, 'credentials.json'), 'utf8'), raw);
  await assert.rejects(fs.stat(path.join(directory, 'known_hosts', ssh.id)), { code: 'ENOENT' });
  assert.equal((await store.list()).credentials[0].hostKey.carried, true, 'a repaired service can retry migration');
});

test('helpers only read: no chmod, creation, migration, lock or state access', async t => {
  const { directory, create, store, io } = await fixture(t);
  const saved = (await create(api)).credential;
  const before = await fs.readdir(directory);
  const readOnly = createCredentialStore({ directory, readOnly: true });
  const modeBefore = (await fs.stat(path.join(directory, 'credentials.json'))).mode;
  await fs.writeFile(path.join(directory, 'state.json'), '{invalid');
  assert.equal((await readOnly.forUse(api.id)).secret, api.secret);
  assert.equal((await fs.stat(path.join(directory, 'credentials.json'))).mode, modeBefore);
  assert.deepEqual((await fs.readdir(directory)).sort(), before.sort());
  await assert.rejects(readOnly.save({ credential: api, revision: saved.revision }), { code: 'read-only' });
  await fs.writeFile(path.join(directory, 'credentials.json'), JSON.stringify({ version: 1, profiles: [api] }));
  await assert.rejects(readOnly.forUse(api.id), /Open Setup once/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'credentials.json'))).version, 1);
  await store.initialize();
  await fs.chmod(path.join(directory, 'credentials.json'), 0o644);
  await assert.rejects(readOnly.forUse(api.id));
  await store.list(); assert.equal((await fs.stat(path.join(directory, 'credentials.json'))).mode & 0o777, 0o600);
  const missing = path.join(directory, 'absent');
  await assert.rejects(createCredentialStore({ directory: missing, readOnly: true }).forUse(api.id), { code: 'not-found' });
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
});

test('state damage is disposable and cannot confer or erase file-based host trust', async t => {
  const { store, create, key, directory } = await fixture(t);
  const a = (await create(ssh)).credential;
  await store.trust({ id: a.id, revision: a.revision, key });
  const file = path.join(directory, 'state.json');
  await fs.writeFile(file, '{broken');
  const row = await store.public(a.id);
  assert.equal(row.hostKey.fingerprint, key.fingerprint); assert.equal(row.hostKey.carried, false); assert.equal(row.test, null);
  await store.recordTest({ id: a.id, revision: a.revision, hostFingerprint: key.fingerprint, result: { ok: true, code: 'ok', ms: 3, detail: { user: 'deploy', secret: ssh.secret } } });
  assert.equal((await store.public(a.id)).test.code, 'ok'); assert.equal(JSON.stringify(JSON.parse(await fs.readFile(file))).includes(ssh.secret), false);
  await fs.rm(path.join(directory, 'known_hosts', a.id));
  assert.equal((await store.public(a.id)).hostKey, null); assert.equal((await store.forUse(a.id)).knownHostsFile, null);
  assert.deepEqual((await store.summary()).attention, [{ id: a.id, code: 'host-key-untrusted' }]);
});

test('tests never bump revisions; late tests and removed trust never overwrite newer state', async t => {
  const { store, create, key, directory } = await fixture(t);
  let a = (await create(ssh)).credential;
  await store.trust({ id: a.id, revision: a.revision, key });
  const before = await fs.readFile(path.join(directory, 'credentials.json'), 'utf8');
  const record = result => store.recordTest({ id: a.id, revision: a.revision, hostFingerprint: key.fingerprint, result: { ms: 3, detail: {}, ...result } });
  await record({ ok: false, code: 'timeout' }); assert.deepEqual((await store.summary()).attention, []);
  await record({ ok: false, code: 'timeout' }); assert.equal((await store.summary()).attention[0].code, 'timeout');
  await record({ ok: true, code: 'ok' }); assert.deepEqual((await store.summary()).attention, []);
  assert.equal(await fs.readFile(path.join(directory, 'credentials.json'), 'utf8'), before);
  const old = a; a = (await store.save({ credential: { ...ssh, username: 'other', secret: '' }, revision: a.revision })).credential;
  assert.equal(a.test, null); assert.equal(a.hostKey.fingerprint, key.fingerprint);
  assert.equal(await store.recordTest({ id: a.id, revision: old.revision, hostFingerprint: key.fingerprint, result: { ok: true, code: 'ok' } }), false);
  await store.forget(a.id); assert.equal(await record({ ok: true, code: 'ok' }), false);
});

test('host/port changes and deletion remove both metadata and the credential-specific key', async t => {
  const { store, create, key, directory } = await fixture(t);
  let a = (await create(ssh)).credential;
  await store.trust({ id: a.id, revision: a.revision, key });
  const changed = await store.save({ credential: { ...ssh, port: 2222, secret: '' }, revision: a.revision });
  assert.equal(changed.credential.hostKey, null);
  await assert.rejects(fs.stat(path.join(directory, 'known_hosts', a.id)), { code: 'ENOENT' });
  a = changed.credential; await store.trust({ id: a.id, revision: a.revision, key });
  const missingSecret = { ...a }; delete missingSecret.secret;
  assert.equal((await store.draft({ id: a.id, draft: missingSecret })).knownHostsFile.endsWith('/' + a.id), true);
  assert.equal((await store.draft({ id: a.id, draft: { ...missingSecret, host: 'other-host' } })).knownHostsFile, undefined);
  await store.remove({ id: a.id, revision: a.revision });
  assert.equal(await store.recordTest({ id: a.id, revision: a.revision, result: { ok: true, code: 'ok' } }), false);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'state.json')));
  assert.deepEqual(metadata.tests, {}); assert.deepEqual(metadata.hostKeys, {});
  await assert.rejects(store.save({ credential: ssh, revision: a.revision }), { code: 'gone' });
});

for (const damage of ['hardlink', 'symlink', 'oversize', 'fifo']) test('credential reads reject ' + damage + ' without touching its target', async t => {
  const { store, create, directory, root } = await fixture(t); await create(api);
  const file = path.join(directory, 'credentials.json'), external = path.join(root, 'external');
  await fs.rename(file, external);
  if (damage === 'hardlink') await fs.link(external, file);
  if (damage === 'symlink') await fs.symlink(external, file);
  if (damage === 'oversize') await fs.writeFile(file, ' '.repeat(512 * 1024 + 1), { mode: 0o600 });
  if (damage === 'fifo') { const { execute } = await import('../docker/setup/credentials/hostkeys.mjs'); await execute('/usr/bin/mkfifo', [file]); }
  const before = await fs.readFile(external, 'utf8');
  await assert.rejects(store.list());
  assert.equal(await fs.readFile(external, 'utf8'), before);
});

test('state recovery replaces its directory entry without following a symlink', async t => {
  const { store, create, directory, root } = await fixture(t); const a = (await create(api)).credential;
  const external = path.join(root, 'external'), file = path.join(directory, 'state.json');
  await fs.writeFile(external, 'keep this'); await fs.rm(file); await fs.symlink(external, file);
  await store.recordTest({ id: a.id, revision: a.revision, result: { ok: false, code: 'failed', detail: { line: api.secret + ' and ' + Buffer.from(api.secret).toString('base64') } } });
  assert.equal(await fs.readFile(external, 'utf8'), 'keep this');
  assert.equal((await fs.lstat(file)).isSymbolicLink(), false);
  assert.equal(JSON.stringify(await store.list()).includes(api.secret), false);
});
