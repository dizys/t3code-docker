// Stores written by earlier versions, read by this one. Each row here is shaped
// as those versions wrote it, so these fail if the upgrade ever stops matching
// what's already on people's servers.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCredentialStore } from '../docker/setup/credentials.mjs';
import { upgradeProfile } from '../docker/setup/credentials/model.mjs';
import { credentialKey } from './fixtures/credential-keys.mjs';

const password = 'fixture-migrated-password', token = 'fixture-migrated-token';
const v2Ssh = { id: 'build-server', type: 'ssh', host: '192.0.2.10', port: 2222, username: 'deploy', secret: password, createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T04:05:06.000Z', secretChangedAt: '2026-01-15T00:00:00.000Z', revision: '0123456789abcdef' };
const v2Api = { id: 'project-api', type: 'api', baseUrl: 'https://api.example.test/v1/', authType: 'header', authName: 'X-Key', authPrefix: 'Token', testPath: 'account', secret: token, createdAt: '2026-03-04T05:06:07.000Z', updatedAt: '2026-03-04T05:06:07.000Z', secretChangedAt: null, revision: 'fedcba9876543210' };
const v2Bearer = { id: 'plain-api', type: 'api', baseUrl: 'https://plain.example.test/', authType: 'bearer', testPath: '', secret: token + '-plain', createdAt: '2026-03-04T05:06:07.000Z', updatedAt: '2026-03-04T05:06:07.000Z', secretChangedAt: '2026-03-04T05:06:07.000Z', revision: 'aaaaaaaaaaaaaaaa' };

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-migration-')), directory = path.join(root, 'credentials'), home = path.join(root, 'home');
  await fs.mkdir(directory, { mode: 0o700 }); await fs.mkdir(home);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(directory, 'credentials.json');
  const open = (extra = {}) => createCredentialStore({ directory, home, ...options, ...extra });
  const write = async value => { const text = typeof value === 'string' ? value : JSON.stringify(value); await fs.writeFile(file, text, { mode: 0o600 }); return text; };
  return { root, directory, home, file, write, open, read: async () => JSON.parse(await fs.readFile(file, 'utf8')) };
}
async function trustOnDisk(f, id, key, metadata = {}) {
  await fs.mkdir(path.join(f.directory, 'known_hosts'), { mode: 0o700 });
  await fs.writeFile(path.join(f.directory, 'known_hosts', id), `${id} ${key.type} ${key.key}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(f.directory, 'state.json'), JSON.stringify({ version: 1, tests: {}, hostKeys: { [id]: { type: key.type, fingerprint: key.fingerprint, trustedAt: '2026-02-01T00:00:00.000Z', carried: false, firstUse: false } }, ...metadata }), { mode: 0o600 });
}

test('a v2 store becomes v3, keeping revisions, dates, secrets and host keys', async t => {
  const f = await fixture(t), key = credentialKey();
  await trustOnDisk(f, v2Ssh.id, key, { tests: { [v2Api.id]: { ok: false, code: 'rejected', ms: 12, at: '2026-03-05T00:00:00.000Z', revision: v2Api.revision, detail: { status: 401 } } } });
  await f.write({ version: 2, profiles: [v2Ssh, v2Api, v2Bearer] });
  const { credentials, sshAliases } = await f.open().list();

  const raw = await f.read();
  assert.equal(raw.version, 3); assert.equal(Object.hasOwn(raw, 'profiles'), false); assert.equal(raw.credentials.length, 3);
  assert.deepEqual(raw.credentials[0], {
    id: 'build-server', type: 'ssh', description: '',
    fields: { host: '192.0.2.10', port: 2222, username: 'deploy', auth: 'password' },
    secrets: { password }, env: {},
    createdAt: v2Ssh.createdAt, updatedAt: v2Ssh.updatedAt, secretChangedAt: v2Ssh.secretChangedAt, revision: v2Ssh.revision,
  });
  assert.deepEqual(raw.credentials[1], {
    id: 'project-api', type: 'token', description: '',
    fields: { baseUrl: 'https://api.example.test/v1/', authType: 'header', authName: 'X-Key', authPrefix: 'Token', testPath: 'account' },
    secrets: { token }, env: {},
    createdAt: v2Api.createdAt, updatedAt: v2Api.updatedAt, secretChangedAt: null, revision: v2Api.revision,
  });
  assert.deepEqual(raw.credentials[2].fields, { baseUrl: 'https://plain.example.test/', authType: 'bearer', testPath: '' });
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);

  // What people see and use is the same as before the upgrade.
  const [box, api] = credentials;
  assert.deepEqual([box.revision, box.createdAt, box.updatedAt, box.secretChangedAt], [v2Ssh.revision, v2Ssh.createdAt, v2Ssh.updatedAt, v2Ssh.secretChangedAt]);
  assert.equal(box.hostKey.fingerprint, key.fingerprint, 'a server that was trusted stays trusted');
  assert.equal(box.hostKey.trustedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(api.test.code, 'rejected', 'a result for the same revision still counts');
  assert.equal(JSON.stringify(credentials).includes(password) || JSON.stringify(credentials).includes(token), false);
  const store = f.open();
  assert.equal((await store.forUse(v2Ssh.id)).secrets.password, password);
  assert.equal((await store.forUse(v2Ssh.id)).knownHostsFile, path.join(f.directory, 'known_hosts', v2Ssh.id));
  assert.equal((await store.forUse(v2Api.id)).secrets.token, token);
  assert.deepEqual((await store.forUse(v2Api.id)).fields.authPrefix, 'Token');

  // Old passwords sign in the old way, and plain ssh now reaches them.
  assert.equal(sshAliases, true, 'the upgrade writes the ssh files');
  assert.match(await fs.readFile(path.join(f.directory, 'ssh_config'), 'utf8'), /^Host build-server$/m);

  // An edit from a page opened before the upgrade still lines up.
  const saved = (await store.save({ credential: { id: v2Api.id, type: 'token', fields: { testPath: 'me' }, secrets: {} }, revision: v2Api.revision })).credential;
  assert.equal(saved.createdAt, v2Api.createdAt); assert.equal(saved.fields.testPath, 'me'); assert.equal((await store.forUse(v2Api.id)).secrets.token, token);
});

test('a v2 upgrade happens once, then the file is left alone', async t => {
  const f = await fixture(t);
  await f.write({ version: 2, profiles: [v2Ssh, v2Api] });
  await f.open().initialize();
  const once = await fs.readFile(f.file, 'utf8'), when = (await fs.stat(f.file)).mtimeMs;
  await f.open().initialize(); await f.open().list();
  assert.equal(await fs.readFile(f.file, 'utf8'), once);
  assert.equal((await fs.stat(f.file)).mtimeMs, when);
});

test('a v1 store also works: dates come from the file, revisions are new, and known_hosts is carried over', async t => {
  const carried = credentialKey(), runs = [];
  const f = await fixture(t);
  const { createCredentialIO } = await import('../docker/setup/credentials/io.mjs'), { createHostKeys } = await import('../docker/setup/credentials/hostkeys.mjs');
  const io = createCredentialIO({ directory: f.directory });
  const hostKeys = createHostKeys({ io, home: f.home, run: async (program, args) => { runs.push(args); return { code: 0, stdout: 'known ' + carried.type + ' ' + carried.key + '\n' }; } });
  await f.write({ version: 1, profiles: [{ id: 'build-server', label: 'Old label', type: 'ssh', host: '192.0.2.10', port: 22, username: 'deploy', secret: password }, { id: 'project-api', label: 'Old label', type: 'api', baseUrl: 'https://api.example.test/v1', secret: token }] });
  const stamped = new Date('2026-01-01T00:00:00.000Z'); await fs.utimes(f.file, stamped, stamped);
  const store = f.open({ io, hostKeys }), [box, api] = (await store.list()).credentials;
  assert.equal((await f.read()).version, 3);
  assert.deepEqual([box.createdAt, box.updatedAt, box.secretChangedAt], [stamped.toISOString(), stamped.toISOString(), null]);
  assert.match(box.revision, /^[a-f0-9]{16}$/); assert.notEqual(box.revision, api.revision);
  assert.equal(box.hostKey.fingerprint, carried.fingerprint); assert.equal(box.hostKey.carried, true);
  assert.equal(api.hostKey, null);
  assert.equal(api.fields.baseUrl, 'https://api.example.test/v1/'); assert.equal(api.fields.authType, 'bearer');
  assert.equal(Object.hasOwn(box, 'label'), false);
  assert.equal((await store.forUse(box.id)).secrets.password, password); assert.equal((await store.forUse(api.id)).secrets.token, token);
  assert.deepEqual(runs.map(args => args.slice(0, 2)), [['-F', '192.0.2.10']], 'only the SSH row looks in known_hosts');
});

test('v2 never reads known_hosts: only v1 trusted it, and only once', async t => {
  let ran = 0;
  const f = await fixture(t);
  const { createCredentialIO } = await import('../docker/setup/credentials/io.mjs'), { createHostKeys } = await import('../docker/setup/credentials/hostkeys.mjs');
  const io = createCredentialIO({ directory: f.directory }), hostKeys = createHostKeys({ io, home: f.home, run: async () => { ran++; return { code: 0, stdout: '' }; } });
  await f.write({ version: 2, profiles: [v2Ssh] });
  const [box] = (await f.open({ io, hostKeys }).list()).credentials;
  assert.equal(ran, 0); assert.equal(box.hostKey, null, 'nothing is trusted that wasn\'t already');
});

test('a read-only store refuses to migrate, and leaves the old file exactly as it was', async t => {
  for (const version of [1, 2]) {
    const f = await fixture(t), profiles = version === 1 ? [{ id: 'old-api', type: 'api', baseUrl: 'https://api.example.test/', secret: token }] : [v2Ssh, v2Api];
    const before = await f.write({ version, profiles }), readOnly = f.open({ readOnly: true });
    for (const read of [() => readOnly.list(), () => readOnly.forUse(profiles[0].id), () => readOnly.public(profiles[0].id)]) {
      await assert.rejects(read(), error => { assert.equal(error.code, 'migration', 'version ' + version); assert.equal(error.status, 409); assert.match(error.message, /Open Setup once/); assert.equal(error.message.includes(token), false); return true; });
    }
    assert.equal(await fs.readFile(f.file, 'utf8'), before);
    assert.deepEqual(await fs.readdir(f.directory), ['credentials.json'], 'not even a lock file');
    await assert.rejects(fs.stat(path.join(f.home, '.ssh')), { code: 'ENOENT' });
    assert.equal((await f.open().list()).credentials.length, profiles.length, 'the writer can still do it afterwards');
    assert.equal((await f.read()).version, 3);
    assert.equal((await readOnly.list()).credentials.length, profiles.length, 'and helpers work from then on');
  }
});

test('an unreadable old store is an error and is left for repair, never overwritten', async t => {
  for (const damaged of [
    { version: 2, profiles: [{ id: 'x', type: 'ssh' }] }, { version: 2, profiles: [{ ...v2Ssh, host: '-oProxyCommand=bad' }] }, { version: 2, profiles: [v2Ssh, v2Ssh] }, { version: 2, profiles: 'nope' },
    { version: 2, credentials: [] }, { version: 1, profiles: [null] }, { version: 4, credentials: [] }, { version: 0, profiles: [] }, { profiles: [] }, [], 'not json',
  ]) {
    const f = await fixture(t), before = await f.write(damaged);
    await assert.rejects(f.open().list(), { code: 'store', status: 500 }, JSON.stringify(damaged));
    assert.equal(await fs.readFile(f.file, 'utf8'), before);
  }
});

test('a failed upgrade restores the old file, and works when tried again', async t => {
  let failing = true;
  const f = await fixture(t);
  const { createCredentialIO } = await import('../docker/setup/credentials/io.mjs');
  const io = createCredentialIO({ directory: f.directory, effects: { ...fs, rename: async (from, to) => { if (failing && to.endsWith('/credentials.json')) { failing = false; throw new Error('injected failure'); } return fs.rename(from, to); } } });
  const before = await f.write({ version: 2, profiles: [v2Ssh] });
  await assert.rejects(f.open({ io }).initialize(), { code: 'store' });
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.equal((await f.open().list()).credentials[0].revision, v2Ssh.revision);
});

test('version 3 files round trip, for every type', async t => {
  const f = await fixture(t), store = f.open();
  const rows = [
    { id: 'box-key', type: 'ssh', description: 'Key sign-in', fields: { host: 'example.test', port: 22, username: 'deploy', auth: 'key', publicKey: 'ssh-ed25519 AAAAfixture' }, secrets: { privateKey: 'fixture key text\n' } },
    { id: 'box-pass', type: 'ssh', fields: { host: 'example.test', port: 2222, username: 'deploy', auth: 'password' }, secrets: { password: 'fixture-password' } },
    { id: 'tok', type: 'token', fields: { baseUrl: 'https://example.test/', authType: 'query', authName: 'key', testPath: 'me' }, secrets: { token: 'fixture-token' }, env: { token: 'TOK_KEY' } },
    { id: 'log', type: 'login', fields: { username: 'me', url: 'https://example.test' }, secrets: { password: 'fixture-password' } },
    { id: 'db', type: 'database', fields: { engine: 'mysql', host: 'db.example.test', port: 3307, database: 'app', username: 'me', options: 'ssl=true' }, secrets: { password: 'fixture-password' } },
    { id: 'cloud', type: 'aws', fields: { accessKeyId: 'AKIAFIXTURE', region: 'eu-west-1' }, secrets: { secretAccessKey: 'fixture-secret', sessionToken: 'fixture-session' } },
    { id: 'gce', type: 'gcp', fields: { project: 'p', clientEmail: 'a@example.test' }, secrets: { serviceAccount: '{"type":"service_account"}\n' } },
    { id: 'kube', type: 'kubernetes', fields: {}, secrets: { kubeconfig: 'apiVersion: v1\nkind: Config\nclusters: []\n' } },
    { id: 'gh', type: 'git', fields: { host: 'github.com', username: 'x-access-token', baseUrl: 'https://api.github.com/', authType: 'bearer', testPath: 'user' }, secrets: { token: 'fixture-token' }, env: { token: 'GH_TOKEN' } },
    { id: 'npm', type: 'registry', fields: { username: 'me' }, secrets: { token: 'fixture-token' } },
    { id: 'cert', type: 'file', fields: { filename: 'cert.pem' }, secrets: { content: 'line one\nline two\n' }, env: { content: 'CERT_PATH' } },
    { id: 'mixed', type: 'custom', fields: { REGION: 'eu' }, secrets: { API_KEY: 'fixture-secret\nsecond line' } },
  ];
  for (const credential of rows) await store.save({ credential, create: true, origin: { by: 'agent', threadId: 'thread-1' } });
  const raw = await fs.readFile(f.file, 'utf8'), when = (await fs.stat(f.file)).mtimeMs, parsed = JSON.parse(raw);
  assert.equal(parsed.version, 3); assert.equal(parsed.credentials.length, rows.length);
  for (const row of rows) {
    const stored = parsed.credentials.find(entry => entry.id === row.id);
    assert.deepEqual(stored.secrets, row.secrets, row.id);
    for (const [key, value] of Object.entries(row.fields)) assert.equal(stored.fields[key], value, row.id + ' ' + key);
    assert.deepEqual(stored.env, row.env ?? {}, row.id);
    assert.deepEqual(stored.origin, { by: 'agent', threadId: 'thread-1' }, row.id);
  }
  // A fresh reader gets the same thing, and reading changes nothing on disk.
  const fresh = f.open();
  for (const row of rows) {
    const used = await fresh.forUse(row.id), stored = parsed.credentials.find(entry => entry.id === row.id);
    assert.deepEqual(used.secrets, row.secrets, row.id); assert.equal(used.revision, stored.revision); assert.equal(used.createdAt, stored.createdAt);
    assert.deepEqual(used.origin, stored.origin);
  }
  await fresh.list(); await fresh.initialize();
  assert.equal(await fs.readFile(f.file, 'utf8'), raw); assert.equal((await fs.stat(f.file)).mtimeMs, when);
  // Changing one credential leaves every other exactly as it was.
  const before = parsed.credentials.find(entry => entry.id === 'tok');
  await fresh.save({ credential: { id: 'tok', type: 'token', fields: {}, secrets: {}, description: 'Now described' }, revision: before.revision });
  const after = await f.read();
  for (const row of rows) if (row.id !== 'tok') assert.deepEqual(after.credentials.find(entry => entry.id === row.id), parsed.credentials.find(entry => entry.id === row.id), row.id);
  assert.equal(after.credentials.find(entry => entry.id === 'tok').description, 'Now described');
  // A read-only helper reads them too, without an upgrade of any kind.
  assert.equal((await f.open({ readOnly: true }).list()).credentials.length, rows.length);
});

test('a version 3 row with something wrong in it stops the store rather than being quietly dropped', async t => {
  const good = { id: 'tok', type: 'token', description: '', fields: {}, secrets: { token: 'fixture-token' }, env: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', secretChangedAt: null, revision: '0123456789abcdef' };
  const f = await fixture(t); await f.write({ version: 3, credentials: [good] });
  assert.equal((await f.open().forUse('tok')).secrets.token, 'fixture-token', 'the fixture is valid to start with');
  for (const change of [{ revision: 'short' }, { revision: undefined }, { createdAt: 'not a date' }, { updatedAt: undefined }, { secretChangedAt: 'not a date' }, { secretChangedAt: undefined }, { type: 'api' }, { id: 'Bad' }, { secrets: {} }, { fields: { baseUrl: 'file:///etc/passwd' } }]) {
    const g = await fixture(t), before = await g.write({ version: 3, credentials: [{ ...good, ...change }] });
    await assert.rejects(g.open().list(), { code: 'store' }, JSON.stringify(change));
    assert.equal(await fs.readFile(g.file, 'utf8'), before);
  }
  const twice = await fixture(t); await twice.write({ version: 3, credentials: [good, good] });
  await assert.rejects(twice.open().list(), { code: 'store' });
  const many = await fixture(t); await many.write({ version: 3, credentials: Array.from({ length: 65 }, (_, index) => ({ ...good, id: 'tok-' + index })) });
  await assert.rejects(many.open().list(), { code: 'store' });
  const shaped = await fixture(t); await shaped.write({ version: 3, profiles: [good] });
  await assert.rejects(shaped.open().list(), { code: 'store' }, 'version 3 reads credentials, not profiles');
});

test('an origin the store can\'t believe is dropped on read, while the credential survives', async t => {
  const good = { id: 'tok', type: 'token', description: '', fields: {}, secrets: { token: 'fixture-token' }, env: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', secretChangedAt: null, revision: '0123456789abcdef', origin: { by: 'someone' }, changedBy: { by: 'agent', threadId: 'bad id!' } };
  const f = await fixture(t); await f.write({ version: 3, credentials: [good] });
  const row = await f.open().public('tok');
  assert.equal(row.origin, undefined); assert.deepEqual(row.changedBy, { by: 'agent' });
});

test('upgradeProfile maps each old shape onto the new one', () => {
  assert.deepEqual(upgradeProfile({ id: 'a', type: 'ssh', host: 'h', port: 22, username: 'u', secret: 's' }), { id: 'a', type: 'ssh', description: '', fields: { host: 'h', port: 22, username: 'u', auth: 'password' }, secrets: { password: 's' }, env: {} });
  assert.deepEqual(upgradeProfile({ id: 'a', type: 'api', baseUrl: 'https://x.test/', secret: 's' }), { id: 'a', type: 'token', description: '', fields: { baseUrl: 'https://x.test/', authType: 'bearer', testPath: '' }, secrets: { token: 's' }, env: {} });
  const stamped = upgradeProfile({ id: 'a', type: 'ssh', host: 'h', port: 22, username: 'u', secret: 's', createdAt: 'c', updatedAt: 'u', secretChangedAt: null, revision: 'r' });
  assert.deepEqual([stamped.createdAt, stamped.updatedAt, stamped.secretChangedAt, stamped.revision], ['c', 'u', null, 'r'], 'a null date stays null rather than becoming now');
});
