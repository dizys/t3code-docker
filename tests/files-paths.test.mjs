import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizePath, validateName, displayPath, inside, isSecret, canonicalEntry, createPathPolicy } from '../docker/setup/files/paths.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-files-paths-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  for (const dir of [home, workspace, path.join(home, '.t3/userdata'), path.join(home, '.t3/agents/.codex'), path.join(home, '.ssh'), path.join(home, '.local/share/mise')]) await fs.mkdir(dir, { recursive: true });
  await fs.symlink(path.join(home, '.t3/agents/.codex'), path.join(home, '.codex'));
  return { root, home, workspace, policy: createPathPolicy({ home, workspace, env: {} }) };
}

test('absolute paths retain terminal-equivalent access without a workspace boundary', () => {
  for (const [input, expected] of [['/etc/../var/log', '/var/log'], ['/', '/'], ['/space name/日本語', '/space name/日本語'], ['/workspace/a/../../etc', '/etc']]) assert.equal(normalizePath(input), expected);
  for (const invalid of ['', '.', '../etc', '~/a', null, [], '/file\0name', '/' + 'a'.repeat(4096)]) assert.throws(() => normalizePath(invalid), { code: 'invalid' });
  assert.equal(inside('/a', '/ab'), false); assert.equal(inside('/', '/etc'), true);
  assert.equal(displayPath('/home/t3/a', '/home/t3'), '~/a'); assert.equal(displayPath('/home/t3-other', '/home/t3'), '/home/t3-other');
});

test('names reject separators and byte overflow while preserving Linux names as data', () => {
  for (const name of ['a file.txt', '--help', 'a\\b', '$(touch nope)', '日本語.txt', 'a'.repeat(255)]) assert.equal(validateName(name), name);
  for (const name of ['', '.', '..', '../a', 'a/b', '\0', 'a'.repeat(256), '語'.repeat(86)]) assert.throws(() => validateName(name), { code: 'invalid' });
});

test('secret names follow the handoff patterns and its explicit exceptions', () => {
  for (const name of ['.env', '.env.local', 'server.pem', 'ssh.key', 'backup.p12', 'vault.kdbx', 'id_ed25519', 'id_rsa.old', 'credentials.json', 'auth.json', '.npmrc']) assert.equal(isSecret(name), true, name);
  for (const name of ['.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'public.key.pub', 'src.env', 'README.md']) assert.equal(isSecret(name), false, name);
});

test('canonical entry preserves the final link while guards classify its real target', async (t) => {
  const f = await fixture(t), link = path.join(f.workspace, 'linked-state');
  await fs.symlink(path.join(f.home, '.t3'), link);
  assert.equal(await canonicalEntry(link), link, 'a future rename/trash acts on the link itself');
  const linked = await f.policy.classify(link);
  assert.equal(linked.path, link); assert.equal(linked.linked, true); assert.equal(linked.managed.root, path.join(f.home, '.t3'));
  const child = await f.policy.classify(path.join(link, 'userdata/new-folder/new-file'));
  assert.equal(child.path, path.join(f.home, '.t3/userdata/new-folder/new-file'));
  assert.equal(child.what, 'Threads and agent data');
  assert.equal((await f.policy.classify('/etc')).managed, null, 'system read-only state is an OS permission, not a hard-coded policy');
});

test('configured managed, provider and key roots remain guarded through links and overrides', async (t) => {
  const f = await fixture(t), actual = path.join(f.root, 'state-real');
  await fs.mkdir(actual); await fs.symlink(actual, path.join(f.workspace, 'state-alias'));
  const customCodex = path.join(f.root, 'custom-codex'); await fs.mkdir(customCodex);
  const customGh = path.join(f.root, 'custom-gh'); await fs.mkdir(customGh);
  const policy = createPathPolicy({ home: f.home, workspace: f.workspace, env: { T3CODE_HOME: path.join(f.workspace, 'state-alias'), CODEX_HOME: customCodex, GH_CONFIG_DIR: customGh } });
  assert.equal((await policy.classify(actual)).managed.root, actual);
  assert.deepEqual((await policy.classify(path.join(customCodex, 'auth.json'))).signIns, ['Codex']);
  assert.deepEqual((await policy.classify(customGh)).signIns, ['GitHub CLI']);
  assert.equal((await policy.classify(path.join(f.home, '.ssh/id_ed25519'))).keys, true);
  assert.equal((await policy.classify(path.join(f.home, '.ssh/id_ed25519.pub'))).secret, false);
  const codex = await f.policy.classify(path.join(f.home, '.codex'));
  assert(codex.tags.includes('managed')); assert(codex.tags.includes('sign-in'));
});

test('managed ancestors are explained without locking unrelated sibling content', async (t) => {
  const f = await fixture(t);
  const parent = await f.policy.classify(path.join(f.home, '.local'));
  assert.equal(parent.managed, null); assert.equal(parent.ancestor.tag, 'Agents and toolchains');
  const sibling = await f.policy.classify(path.join(f.home, '.local/personal-file'));
  assert.equal(sibling.managed, null); assert.equal(sibling.ancestor, null);
  const caches = createPathPolicy({ home: f.home, workspace: f.workspace, env: {}, storage: { snapshot: () => ({ categories: [{ kind: 'cache', path: path.join(f.root, 'custom-cache') }] }) } });
  assert.equal((await caches.classify(path.join(f.root, 'custom-cache/entry'))).managed.tag, 'Caches');
});

test('saved server credentials carry key and secret warnings in Files, including a custom state volume', async t => {
  const f = await fixture(t);
  const policy = createPathPolicy({ home: f.home, workspace: f.workspace, env: { T3CODE_HOME: path.join(f.root, 'custom-t3') } });
  const folder = path.join(f.root, 'custom-t3/server-credentials');
  await fs.mkdir(folder, { recursive: true });
  assert.equal((await policy.classify(folder)).keys, true);
  const file = await policy.classify(path.join(folder, 'credentials.json'));
  assert.equal(file.keys, true); assert.equal(file.secret, true);
});
