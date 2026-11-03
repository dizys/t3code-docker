import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCredentialStore } from '../docker/setup/credentials.mjs';
import { createCredentialIO } from '../docker/setup/credentials/io.mjs';
import { createHostKeys } from '../docker/setup/credentials/hostkeys.mjs';
import { createUsageLog } from '../docker/setup/credentials/state.mjs';
import { credentialKey } from './fixtures/credential-keys.mjs';
const ssh = { id: 'build-server', label: 'No longer stored', type: 'ssh', fields: { host: '192.0.2.10', port: 22, username: 'deploy', auth: 'password' }, secrets: { password: 'synthetic-private-password' } };
const api = { id: 'project-api', type: 'token', fields: { baseUrl: 'https://api.example.test/v1/' }, secrets: { token: 'synthetic-private-token' } };
// The shapes version 1 and 2 files held, for the stores upgraded on read.
const legacySsh = { id: ssh.id, label: 'No longer stored', type: 'ssh', host: '192.0.2.10', port: 22, username: 'deploy', secret: ssh.secrets.password };
const legacyApi = { id: api.id, type: 'api', baseUrl: api.fields.baseUrl, secret: api.secrets.token };
const withFields = (credential, fields) => ({ ...credential, fields: { ...credential.fields, ...fields } });
const keyed = { id: 'key-server', type: 'ssh', fields: { host: '192.0.2.11', port: 22, username: 'deploy', auth: 'key', publicKey: 'ssh-ed25519 AAAAfixture t3-vault:key-server' }, secrets: { privateKey: 'fixture-private-key-text\n' } };
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-store-')), directory = path.join(root, 'credentials');
  const io = createCredentialIO({ directory, effects: options.effects || fs }), key = credentialKey();
  const hostKeys = createHostKeys({ io, home: root, ...options.keys });
  // Always pass home: saving an SSH credential adds a line to <home>/.ssh/config.
  const store = createCredentialStore({ directory, io, hostKeys, home: root, ...options.store });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, directory, io, hostKeys, key, store, create: credential => store.save({ credential, create: true }) };
}

test('v3 stores immutable names, independent random revisions and server-owned dates', async t => {
  let ms = Date.parse('2026-10-30T10:00:00Z');
  const { store, create, directory } = await fixture(t, { store: { clock: () => ms } });
  const a = (await create({ ...ssh, revision: 'bad', createdAt: 'bad' })).credential;
  const b = (await create(api)).credential;
  assert.match(a.revision, /^[a-f0-9]{16}$/); assert.notEqual(a.revision, b.revision);
  assert.equal(a.createdAt, '2026-10-30T10:00:00.000Z'); assert.equal(a.secretChangedAt, a.createdAt);
  ms += 1000;
  const edited = (await store.save({ credential: { ...withFields(ssh, { username: 'other' }), secrets: { password: '' } }, revision: a.revision })).credential;
  assert.equal(edited.createdAt, a.createdAt); assert.notEqual(edited.updatedAt, a.updatedAt); assert.equal(edited.secretChangedAt, a.secretChangedAt);
  await store.save({ credential: { ...api, secrets: { token: '' } }, revision: b.revision });
  const raw = JSON.parse(await fs.readFile(path.join(directory, 'credentials.json'), 'utf8'));
  assert.equal(raw.version, 3); assert.equal(Object.hasOwn(raw, 'profiles'), false); assert.equal(Object.hasOwn(raw.credentials[0], 'label'), false);
  assert.deepEqual(Object.keys(raw.credentials.find(row => row.id === ssh.id)).sort(), ['changedBy', 'createdAt', 'description', 'env', 'fields', 'id', 'origin', 'revision', 'secretChangedAt', 'secrets', 'type', 'updatedAt']);
  assert.equal(JSON.stringify(await store.list()).includes(ssh.secrets.password), false);
  await assert.rejects(store.save({ credential: { ...api, id: ssh.id }, revision: edited.revision }), /change its type/);
  await assert.rejects(store.draft({ id: ssh.id, draft: { ...ssh, id: 'different', secrets: {} } }), /name cannot change/);
  await assert.rejects(store.draft({ id: ssh.id, draft: { ...api, id: ssh.id, secrets: {} } }), /change its type/);
  await assert.rejects(store.remove({ id: '../escape', revision: '' }), { code: 'invalid' });
});

test('who added a credential is kept, who changed it is tracked, and unknown callers are not believed', async t => {
  const { store } = await fixture(t);
  const made = (await store.save({ credential: api, create: true, origin: { by: 'agent', threadId: 'thread:1' } })).credential;
  assert.deepEqual(made.origin, { by: 'agent', threadId: 'thread:1' }); assert.equal(made.changedBy, undefined);
  const changed = (await store.save({ credential: { ...api, description: 'Project API' }, revision: made.revision, origin: { by: 'terminal' } })).credential;
  assert.deepEqual(changed.origin, { by: 'agent', threadId: 'thread:1' }); assert.deepEqual(changed.changedBy, { by: 'terminal' });
  assert.equal(changed.description, 'Project API');
  assert.deepEqual((await store.public(api.id)).origin, { by: 'agent', threadId: 'thread:1' }, 'origin survives a read from disk');
  const other = { ...api, id: 'other-api' };
  assert.deepEqual((await store.save({ credential: other, create: true, origin: { by: 'someone' } })).credential.origin, { by: 'setup' });
  assert.deepEqual((await store.save({ credential: { ...other, id: 'third-api' }, create: true, origin: { by: 'agent', threadId: 'not valid!' } })).credential.origin, { by: 'agent' });
  assert.deepEqual((await store.save({ credential: { ...other, id: 'fourth-api' }, create: true })).credential.origin, { by: 'setup' });
});

test('migration drops labels, sets mtime dates and carries a single existing key without changing user known_hosts', async t => {
  const carried = credentialKey(), { directory, root, io, store } = await fixture(t, { keys: { run: async (program, args) => {
    assert.equal(program, '/usr/bin/ssh-keygen'); assert.deepEqual(args.slice(0, 2), ['-F', '[192.0.2.10]:2222']);
    return { code: 0, stdout: '# comment\n|1|hash|hash ' + carried.type + ' ' + carried.key + '\n' };
  } } });
  await io.prepare(); await fs.mkdir(path.join(root, '.ssh')); const userFile = path.join(root, '.ssh/known_hosts'); await fs.writeFile(userFile, 'person-owned');
  const file = path.join(directory, 'credentials.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, profiles: [{ ...legacySsh, port: 2222 }, legacyApi] }), { mode: 0o600 });
  const before = await fs.stat(file), listed = (await store.list()).credentials;
  assert.equal(listed[0].createdAt, before.mtime.toISOString()); assert.equal(listed[0].secretChangedAt, null);
  assert.equal(listed[0].hostKey.fingerprint, carried.fingerprint); assert.equal(listed[0].hostKey.carried, true);
  assert.equal(await fs.readFile(userFile, 'utf8'), 'person-owned');
  assert.equal(await fs.readFile(path.join(directory, 'known_hosts', ssh.id), 'utf8'), `${ssh.id} ${carried.type} ${carried.key}\n`);
  assert.equal((await fs.stat(path.join(directory, 'known_hosts', ssh.id))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8'))).includes('No longer stored'), false);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['credentials.json', 'keys', 'known_hosts', 'ssh_config', 'state.json', 'usage']);
});

test('migration failure leaves the exact v1 bytes and does not leave carried trust', async t => {
  const key = credentialKey(); let breakStore = false;
  const { store, io, directory } = await fixture(t, { effects: { ...fs, rename: async (a, b) => { if (breakStore && b.endsWith('/credentials.json')) { breakStore = false; throw new Error('injected failure'); } return fs.rename(a, b); } }, keys: { legacy: undefined, run: async () => ({ code: 0, stdout: 'old ' + key.type + ' ' + key.key }) } });
  await io.prepare(); const raw = JSON.stringify({ version: 1, profiles: [legacySsh] });
  await fs.writeFile(path.join(directory, 'credentials.json'), raw, { mode: 0o600 }); breakStore = true;
  await assert.rejects(store.initialize(), { code: 'store' });
  assert.equal(await fs.readFile(path.join(directory, 'credentials.json'), 'utf8'), raw);
  await assert.rejects(fs.stat(path.join(directory, 'known_hosts', ssh.id)), { code: 'ENOENT' });
  assert.equal((await store.list()).credentials[0].hostKey.carried, true, 'a repaired service can retry migration');
});

test('helpers only read: no chmod, creation, migration, lock or state access', async t => {
  const { directory, create, store, root } = await fixture(t);
  const saved = (await create(api)).credential;
  const before = await fs.readdir(directory);
  const readOnly = createCredentialStore({ directory, home: root, readOnly: true });
  const modeBefore = (await fs.stat(path.join(directory, 'credentials.json'))).mode;
  await fs.writeFile(path.join(directory, 'state.json'), '{invalid');
  assert.equal((await readOnly.forUse(api.id)).secrets.token, api.secrets.token);
  assert.equal((await fs.stat(path.join(directory, 'credentials.json'))).mode, modeBefore);
  assert.deepEqual((await fs.readdir(directory)).sort(), before.sort());
  await assert.rejects(readOnly.save({ credential: api, revision: saved.revision }), { code: 'read-only' });
  await fs.writeFile(path.join(directory, 'credentials.json'), JSON.stringify({ version: 1, profiles: [legacyApi] }));
  await assert.rejects(readOnly.forUse(api.id), /Open Setup once/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'credentials.json'))).version, 1);
  await store.initialize();
  await fs.chmod(path.join(directory, 'credentials.json'), 0o644);
  await assert.rejects(readOnly.forUse(api.id));
  await store.list(); assert.equal((await fs.stat(path.join(directory, 'credentials.json'))).mode & 0o777, 0o600);
  const missing = path.join(directory, 'absent');
  await assert.rejects(createCredentialStore({ directory: missing, home: root, readOnly: true }).forUse(api.id), { code: 'not-found' });
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
  await store.recordTest({ id: a.id, revision: a.revision, hostFingerprint: key.fingerprint, result: { ok: true, code: 'ok', ms: 3, detail: { user: 'deploy', secret: ssh.secrets.password } } });
  assert.equal((await store.public(a.id)).test.code, 'ok'); assert.equal(JSON.stringify(JSON.parse(await fs.readFile(file))).includes(ssh.secrets.password), false);
  await fs.rm(path.join(directory, 'known_hosts', a.id));
  assert.equal((await store.public(a.id)).hostKey, null); assert.equal((await store.forUse(a.id)).knownHostsFile, null);
  assert.deepEqual((await store.summary()).attention, [{ id: a.id, code: 'host-key-untrusted' }]);
});

test('a key sign-in waits for its first connection without asking for attention, a password does not', async t => {
  const { store, create, key } = await fixture(t);
  const a = (await create(keyed)).credential;
  assert.equal(a.hostKey, null);
  assert.deepEqual((await store.summary()).attention, []);
  const pinned = await store.trust({ id: a.id, revision: a.revision, key, firstUse: true });
  assert.equal(pinned.hostKey.firstUse, true);
  await create(ssh);
  assert.deepEqual((await store.summary()).attention, [{ id: ssh.id, code: 'host-key-untrusted' }]);
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
  const old = a; a = (await store.save({ credential: { ...withFields(ssh, { username: 'other' }), secrets: {} }, revision: a.revision })).credential;
  assert.equal(a.test, null); assert.equal(a.hostKey.fingerprint, key.fingerprint);
  assert.equal(await store.recordTest({ id: a.id, revision: old.revision, hostFingerprint: key.fingerprint, result: { ok: true, code: 'ok' } }), false);
  await store.forget(a.id); assert.equal(await record({ ok: true, code: 'ok' }), false);
});

test('a test result survives a save that changes nothing, and is dropped by one that does', async t => {
  const { store, create } = await fixture(t);
  let a = (await create(api)).credential;
  await store.recordTest({ id: a.id, revision: a.revision, result: { ok: true, code: 'ok', ms: 1, detail: {} } });
  a = (await store.save({ credential: { ...api, secrets: {}, description: 'Only the description' }, revision: a.revision })).credential;
  assert.equal(a.test.code, 'ok');
  a = (await store.save({ credential: { ...api, secrets: { token: 'a-different-synthetic-token' } }, revision: a.revision })).credential;
  assert.equal(a.test, null);
});

test('host/port changes and deletion remove both metadata and the credential-specific key', async t => {
  const { store, create, key, directory } = await fixture(t);
  let a = (await create(ssh)).credential;
  await store.trust({ id: a.id, revision: a.revision, key });
  const changed = await store.save({ credential: { ...withFields(ssh, { port: 2222 }), secrets: {} }, revision: a.revision });
  assert.equal(changed.credential.hostKey, null);
  await assert.rejects(fs.stat(path.join(directory, 'known_hosts', a.id)), { code: 'ENOENT' });
  a = changed.credential; await store.trust({ id: a.id, revision: a.revision, key });
  const missingSecret = { ...a }; assert.equal(Object.hasOwn(missingSecret, 'secrets'), false);
  assert.equal((await store.draft({ id: a.id, draft: missingSecret })).knownHostsFile.endsWith('/' + a.id), true);
  assert.equal((await store.draft({ id: a.id, draft: withFields(missingSecret, { host: 'other-host' }) })).knownHostsFile, undefined);
  await store.remove({ id: a.id, revision: a.revision });
  assert.equal(await store.recordTest({ id: a.id, revision: a.revision, result: { ok: true, code: 'ok' } }), false);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'state.json')));
  assert.deepEqual(metadata.tests, {}); assert.deepEqual(metadata.hostKeys, {});
  await assert.rejects(store.save({ credential: ssh, revision: a.revision }), { code: 'gone' });
});

test('saved SSH credentials become plain ssh hosts, and removing one takes its key and block away', async t => {
  const { store, create, directory, root } = await fixture(t);
  assert.equal((await store.list()).sshAliases, false);
  await create(api);
  await assert.rejects(fs.stat(path.join(root, '.ssh/config')), { code: 'ENOENT' }, 'nothing to read until there is an SSH credential');
  const a = (await create(keyed)).credential;
  await create(ssh);
  const config = path.join(directory, 'ssh_config'), keyFile = path.join(directory, 'keys', keyed.id);
  assert.equal(await fs.readFile(keyFile, 'utf8'), keyed.secrets.privateKey);
  for (const [file, mode] of [[keyFile, 0o600], [config, 0o600], [path.join(directory, 'keys'), 0o700], [path.join(directory, 'usage'), 0o700]]) assert.equal((await fs.stat(file)).mode & 0o777, mode, file);
  const text = await fs.readFile(config, 'utf8');
  assert.match(text, /^Host build-server$/m); assert.match(text, /^Host key-server$/m); assert.doesNotMatch(text, /project-api/);
  assert.equal(text.includes(ssh.secrets.password) || text.includes(keyed.secrets.privateKey.trim()), false, 'the generated file holds no secrets');
  assert.equal((await fs.readFile(path.join(root, '.ssh/config'), 'utf8')).split('\n')[0], `Include "${config}"`);
  assert.equal((await store.list()).sshAliases, true);
  await store.remove({ id: a.id, revision: a.revision });
  await assert.rejects(fs.stat(keyFile), { code: 'ENOENT' });
  assert.doesNotMatch(await fs.readFile(config, 'utf8'), /key-server/);
  // Changing how it signs in removes the key from disk as well.
  const again = (await create(keyed)).credential;
  await fs.stat(keyFile);
  await store.save({ credential: { ...keyed, fields: { host: keyed.fields.host, port: 22, username: 'deploy', auth: 'password' }, secrets: { password: 'synthetic-new-password' } }, revision: again.revision });
  await assert.rejects(fs.stat(keyFile), { code: 'ENOENT' });
  assert.equal(Object.keys((await store.forUse(keyed.id)).secrets).join(), 'password');
});

test('a ~/.ssh/config the Vault can\'t write costs plain ssh, never the saved credential', async t => {
  const { store, create, root, directory } = await fixture(t);
  const external = path.join(root, 'someone-elses-config');
  await fs.writeFile(external, 'Host mine\n'); await fs.mkdir(path.join(root, '.ssh')); await fs.symlink(external, path.join(root, '.ssh/config'));
  assert.equal((await create(ssh)).credential.id, ssh.id);
  assert.equal(await fs.readFile(external, 'utf8'), 'Host mine\n');
  assert.equal((await fs.lstat(path.join(root, '.ssh/config'))).isSymbolicLink(), true);
  assert.equal((await store.list()).sshAliases, false);
  assert.match(await fs.readFile(path.join(directory, 'ssh_config'), 'utf8'), /^Host build-server$/m, 't3-vault ssh and a later repair still have the file');
});

for (const damage of ['hardlink', 'symlink', 'oversize', 'fifo']) test('credential reads reject ' + damage + ' without touching its target', async t => {
  const { store, create, directory, root } = await fixture(t); await create(api);
  const file = path.join(directory, 'credentials.json'), external = path.join(root, 'external');
  await fs.rename(file, external);
  if (damage === 'hardlink') await fs.link(external, file);
  if (damage === 'symlink') await fs.symlink(external, file);
  if (damage === 'oversize') await fs.writeFile(file, ' '.repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
  if (damage === 'fifo') { const { execute } = await import('../docker/setup/credentials/hostkeys.mjs'); await execute('/usr/bin/mkfifo', [file]); }
  const before = await fs.readFile(external, 'utf8');
  await assert.rejects(store.list(), { code: damage === 'symlink' ? 'ELOOP' : 'store' });
  assert.equal(await fs.readFile(external, 'utf8'), before);
});

test('state recovery replaces its directory entry without following a symlink', async t => {
  const { store, create, directory, root } = await fixture(t); const a = (await create(api)).credential;
  const external = path.join(root, 'external'), file = path.join(directory, 'state.json');
  await fs.writeFile(external, 'keep this'); await fs.rm(file); await fs.symlink(external, file);
  await store.recordTest({ id: a.id, revision: a.revision, result: { ok: false, code: 'failed', detail: { line: api.secrets.token + ' and ' + Buffer.from(api.secrets.token).toString('base64') } } });
  assert.equal(await fs.readFile(external, 'utf8'), 'keep this');
  assert.equal((await fs.lstat(file)).isSymbolicLink(), false);
  assert.equal(JSON.stringify(await store.list()).includes(api.secrets.token), false);
});

test('replacement timestamps advance even when two writes share a clock tick', async t => {
  const { store, create } = await fixture(t, { store: { clock: () => Date.parse('2026-10-30T10:00:00Z') } });
  const a = (await create(api)).credential;
  const b = (await store.save({ credential: { ...api, secrets: { token: 'a-different-synthetic-token' } }, revision: a.revision })).credential;
  assert.notEqual(a.secretChangedAt, b.secretChangedAt); assert.ok(Date.parse(b.updatedAt) > Date.parse(a.updatedAt));
});

test('the usage log counts uses, keeps only a command\'s name, and notices plain ssh', async t => {
  let ms = Date.parse('2026-10-30T10:00:00Z');
  const { store, create, directory } = await fixture(t, { store: { clock: () => ms } });
  const log = createUsageLog({ directory, clock: () => ms }); await create(api);
  assert.equal(await log.read(api.id), null);
  await log.record(api.id, { command: '/usr/bin/curl', env: { T3CODE_THREAD_ID: 'thread-1' } });
  ms += 1000; await log.record(api.id, { command: 'wrangler', env: {} });
  assert.deepEqual(await log.read(api.id), { at: '2026-10-30T10:00:01.000Z', count: 2, command: 'wrangler' });
  assert.deepEqual((await store.public(api.id)).usage, { at: '2026-10-30T10:00:01.000Z', count: 2, command: 'wrangler' });
  const file = path.join(directory, 'usage', api.id + '.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await log.record(api.id, { command: '/usr/bin/curl', env: { T3CODE_THREAD_ID: 'thread-1' } });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { at: '2026-10-30T10:00:01.000Z', count: 3, threadId: 'thread-1', command: 'curl' });
  assert.deepEqual((await fs.readdir(path.join(directory, 'usage'))).filter(name => name.endsWith('.tmp')), []);
  // ssh's LocalCommand touches a file, which is all a plain `ssh NAME` leaves behind.
  const touch = path.join(directory, 'usage', api.id + '.touch');
  await fs.writeFile(touch, ''); await fs.utimes(touch, new Date('2026-10-30T11:00:00Z'), new Date('2026-10-30T11:00:00Z'));
  assert.deepEqual(await log.read(api.id), { count: 3, at: '2026-10-30T11:00:00.000Z', viaSsh: true });
  await fs.writeFile(file, '{broken');
  assert.deepEqual(await log.read(api.id), { count: 1, at: '2026-10-30T11:00:00.000Z', viaSsh: true });
  // Bookkeeping never fails a command, and goes when the credential goes.
  await log.record('../escape', { command: 'x' }); assert.equal(await log.read('../escape'), null);
  const saved = await store.public(api.id);
  await store.remove({ id: api.id, revision: saved.revision });
  assert.deepEqual(await fs.readdir(path.join(directory, 'usage')), []);
});
