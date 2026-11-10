import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createArtifacts, manifest, protectedPath } from '../docker/services/artifacts.mjs';
import { createMisePackages, miseEnvironment, packageSpec } from '../docker/services/mise-packages.mjs';
const exec = promisify(execFile), miseAvailable = existsSync('/usr/local/bin/mise');
const payload = (name, data, format = 'binary', version = '1.0.0') => ({ name, version, format, url: 'https://fixture.invalid/' + name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-service-packages-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Only this inert fixture uses user-owned temporary storage. Production
  // always uses the default root-owned ancestor and manifest checks.
  const check = async (file, { directory = true } = {}) => {
    assert.ok(file.startsWith(root + '/') || file === root);
    const stat = await fs.lstat(file); assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o022, 0);
    assert.equal(directory ? stat.isDirectory() : stat.isFile(), true);
  };
  const storage = {
    path: check,
    directory: async file => { await fs.mkdir(file, { recursive: true, mode: 0o700 }); await check(file); },
    write: async (file, text, mode = 0o600) => { await fs.writeFile(file, text, { mode }); },
    manifest: (directory, options) => manifest(directory, { ...options, owner: process.getuid() }),
  };
  let downloads = 0;
  const inputs = new Map();
  const catalogue = { schema: 1, arch: process.arch === 'x64' ? 'amd64' : 'arm64', services: {} };
  const add = (id, item, data, executable = item.name) => { inputs.set(item.url, data); catalogue.services[id] = { id, version: item.version, payloads: [item], executable }; };
  const run = async (file, args, options) => { try { return await exec(file, args, options); } catch (error) { t.diagnostic(error.stderr || error.message); throw error; } };
  const manager = createArtifacts({ root, catalogue, storage, run, fetchImpl: async url => { downloads++; assert.ok(inputs.has(url)); return new Response(inputs.get(url)); } });
  return { root, storage, catalogue, add, manager, downloads: () => downloads, inputs };
}

test('privileged Mise ignores the caller home, environment and project configuration', () => {
  const env = miseEnvironment('/protected/mise', '/protected/mise/recipes/package/mise.toml');
  assert.equal(env.HOME, '/protected/mise/home'); assert.equal(env.MISE_NO_HOOKS, 'true'); assert.equal(env.MISE_NO_ENV, 'true');
  assert.equal(env.MISE_ENV_SHELL_EXPAND, 'false'); assert.equal(env.MISE_SYSTEM_CONFIG_FILE, '/protected/mise/empty.toml');
  assert.equal(env.MISE_GLOBAL_CONFIG_FILE, '/protected/mise/recipes/package/mise.toml'); assert.equal(env.MISE_CEILING_PATHS, '/protected/mise');
  assert.ok(!Object.keys(env).some(name => /TOKEN|PASSWORD|SETUP|BASH_ENV/.test(name)));
});
test('package identities pin exact versions, architecture and content and reject unsafe definitions', () => {
  const item = payload('libwrap0', Buffer.from('test'), 'deb', '1:7.6.q-36');
  assert.equal(packageSpec(item, 'ignored', 'arm64').version, item.version);
  for (const patch of [{ name: '../bad' }, { version: '../../bad' }, { sha256: 'bad' }, { bytes: -1 }, { format: 'script' }, { url: 'file:///etc/passwd' }]) assert.throws(() => packageSpec({ ...item, ...patch }, 'fallback', 'arm64'));
});
test('protected service storage rejects writable or user-controlled ancestors', async () => {
  await assert.rejects(protectedPath(os.tmpdir()), error => error.code === 'storage-unsafe');
});

test('real Mise owns the package, reuses verified installs and removes actual files plus legacy caches while keeping identity', { skip: !miseAvailable }, async t => {
  const f = await fixture(t), data = Buffer.from('#!/bin/sh\nexit 0\n'), item = payload('cloudflared', data);
  const userConfig = '[hooks]\nenter = "touch ' + f.root + '/user-hook-ran"\n';
  await fs.writeFile(f.root + '/.t3-services-unused.toml', userConfig);
  f.add('cloudflared', item, data);
  const selected = f.manager.selection('cloudflared'), installed = await f.manager.install('cloudflared', selected);
  assert.equal(installed.manager, 'mise'); assert.equal(installed.components.length, 1);
  assert.equal(existsSync(f.root + '/user-hook-ran'), false); assert.equal(await fs.readFile(f.root + '/.t3-services-unused.toml', 'utf8'), userConfig);
  assert.deepEqual(await fs.readFile(installed.path + '/cloudflared'), data);
  const component = installed.components[0], recipe = f.root + '/mise/recipes/' + component.key + '/mise.toml';
  const { stdout } = await exec('/usr/local/bin/mise', ['-C', f.root + '/mise', 'ls', '--installed', '--json'], { env: miseEnvironment(f.root + '/mise', recipe) });
  assert.equal(JSON.parse(stdout)[component.tool][0].version, item.version);
  assert.equal((await f.manager.install('cloudflared', selected)).path, installed.path); assert.equal(f.downloads(), 1);
  await fs.appendFile(installed.path + '/cloudflared', 'tampered');
  await assert.rejects(f.manager.install('cloudflared', selected), error => error.code === 'artifact-unsafe');
  const identity = f.root + '/instances/cloudflared'; await f.storage.directory(identity); await fs.writeFile(identity + '/identity', 'retain identity');
  const legacy = f.root + '/artifacts/cloudflared/' + 'a'.repeat(64); await f.storage.directory(legacy);
  await fs.writeFile(legacy + '/receipt.json', JSON.stringify({ id: 'cloudflared', payloads: [item] })); await fs.writeFile(legacy + '/old-software', 'cached');
  const removal = await f.manager.remove('cloudflared'); assert.equal(removal.softwareRemoved, true);
  assert.equal(existsSync(installed.path), false); assert.equal(existsSync(legacy), false); assert.equal(existsSync(installed.recordPath), false);
  assert.equal(await fs.readFile(identity + '/identity', 'utf8'), 'retain identity');
  await f.manager.remove('cloudflared');
});
test('shared and pending-operation packages survive until their last consumer releases them', { skip: !miseAvailable }, async t => {
  const f = await fixture(t), data = Buffer.from('#!/bin/sh\nexit 0\n'), item = payload('shared-runtime', data);
  f.add('cloudflared', item, data); f.add('tailscale', item, data);
  const first = await f.manager.install('cloudflared', f.manager.selection('cloudflared'));
  const second = await f.manager.install('tailscale', f.manager.selection('tailscale'));
  assert.equal(first.path, second.path); assert.equal(f.downloads(), 1);
  assert.equal((await f.manager.remove('cloudflared')).retainedPackages.length, 1); assert.equal(existsSync(second.path), true);
  const pending = { payloads: [item] };
  assert.equal((await f.manager.remove('tailscale', { references: () => [pending] })).retainedPackages.length, 1);
  await f.manager.remove('tailscale'); assert.equal(existsSync(first.path), false);
  await f.manager.remove('cloudflared'); assert.equal(existsSync(first.recordPath), false);
});
test('real Mise Debian adaptation unpacks only package data and uninstall deletes the dependencies', { skip: !miseAvailable || !existsSync('/usr/bin/dpkg-deb') }, async t => {
  const f = await fixture(t), source = f.root + '/deb-source';
  await fs.mkdir(source + '/DEBIAN', { recursive: true }); await fs.mkdir(source + '/usr/sbin', { recursive: true });
  const version = '1:1.0.0-1+test';
  await fs.writeFile(source + '/DEBIAN/control', 'Package: openssh-server\nVersion: ' + version + '\nArchitecture: all\nMaintainer: Fixture <fixture@example.invalid>\nDescription: inert service fixture\n');
  await fs.writeFile(source + '/DEBIAN/postinst', '#!/bin/sh\ntouch ' + f.root + '/maintainer-script-ran\n', { mode: 0o755 });
  await fs.writeFile(source + '/usr/sbin/sshd', '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await exec('/usr/bin/dpkg-deb', ['--build', '--root-owner-group', source, f.root + '/fixture.deb']);
  const data = await fs.readFile(f.root + '/fixture.deb'), item = payload('openssh-server', data, 'deb', version);
  f.add('openssh', item, data, 'usr/sbin/sshd');
  const installed = await f.manager.install('openssh', f.manager.selection('openssh'));
  assert.equal(existsSync(installed.path + '/usr/sbin/sshd'), true); assert.equal(existsSync(f.root + '/maintainer-script-ran'), false);
  assert.equal(installed.components[0].version, version);
  await f.manager.remove('openssh'); assert.equal(existsSync(installed.path), false);
});
test('bad hashes and interrupted staging never activate a service and remain explicitly removable', { skip: !miseAvailable }, async t => {
  const f = await fixture(t), data = Buffer.from('#!/bin/sh\nexit 0\n'), item = payload('cloudflared', data);
  f.add('cloudflared', item, Buffer.from('wrong'));
  await assert.rejects(f.manager.install('cloudflared', f.manager.selection('cloudflared')), error => error.code === 'digest');
  const record = f.root + '/artifacts/cloudflared/mise-' + f.manager.selection('cloudflared').digest;
  assert.equal(JSON.parse(await fs.readFile(record + '/receipt.json')).complete, false);
  await f.manager.remove('cloudflared'); assert.equal(existsSync(record), false);
  f.inputs.set(item.url, data);
  const installed = await f.manager.install('cloudflared', f.manager.selection('cloudflared'));
  await fs.rm(installed.path + '/receipt.json');
  await fs.rm(installed.recordPath, { recursive: true });
  const recovered = await f.manager.install('cloudflared', f.manager.selection('cloudflared'));
  assert.equal(recovered.complete, true); assert.equal(existsSync(recovered.path + '/receipt.json'), true);
});
test('Mise Tailscale packages extract the approved CLI and daemon without running or installing extra archive members', { skip: !miseAvailable }, async t => {
  const f = await fixture(t), source = f.root + '/tail-source';
  await fs.mkdir(source + '/tailscale_fixture', { recursive: true });
  for (const name of ['tailscale', 'tailscaled', 'extra-installer']) await fs.writeFile(source + '/tailscale_fixture/' + name, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await exec('/usr/bin/tar', ['-czf', f.root + '/fixture.tgz', '-C', source, 'tailscale_fixture']);
  const data = await fs.readFile(f.root + '/fixture.tgz'), item = { ...payload('tailscale', data, 'tgz'), prefix: 'tailscale_fixture' };
  f.add('tailscale', item, data, 'tailscaled');
  const installed = await f.manager.install('tailscale', f.manager.selection('tailscale'));
  assert.equal(existsSync(installed.path + '/tailscale'), true); assert.equal(existsSync(installed.path + '/tailscaled'), true); assert.equal(existsSync(installed.path + '/extra-installer'), false);
  await f.manager.remove('tailscale'); assert.equal(existsSync(installed.path), false);
});
test('an interrupted multi-package uninstall resumes deletion, preserving identity until all software is gone', { skip: !miseAvailable }, async t => {
  const f = await fixture(t), data = Buffer.from('#!/bin/sh\nexit 0\n'), first = payload('openssh-server', data), second = payload('libwrap0', data);
  f.add('openssh', first, data); f.inputs.set(second.url, data); f.catalogue.services.openssh.payloads.push(second);
  const installed = await f.manager.install('openssh', f.manager.selection('openssh'));
  const packages = createMisePackages({ root: f.root, storage: f.storage });
  let attempts = 0;
  const manager = createArtifacts({ root: f.root, catalogue: f.catalogue, storage: f.storage, packages: { ...packages, remove: async component => { if (++attempts === 2) throw new Error('interrupted fixture'); return packages.remove(component); } } });
  await assert.rejects(manager.remove('openssh'), /interrupted fixture/);
  assert.equal(existsSync(installed.components[0].path), false); assert.equal(existsSync(installed.components[1].path), true); assert.equal(existsSync(installed.recordPath), true);
  assert.equal((await manager.remove('openssh')).softwareRemoved, true);
  for (const component of installed.components) assert.equal(existsSync(component.path), false);
  assert.equal(existsSync(installed.recordPath), false);
});
test('a shared installed package with a missing receipt is preserved rather than silently replaced', { skip: !miseAvailable }, async t => {
  const f = await fixture(t), data = Buffer.from('#!/bin/sh\nexit 0\n'), item = payload('shared-runtime', data);
  f.add('cloudflared', item, data); f.add('tailscale', item, data);
  const installed = await f.manager.install('cloudflared', f.manager.selection('cloudflared'));
  await fs.rm(installed.path + '/receipt.json');
  await assert.rejects(f.manager.install('tailscale', f.manager.selection('tailscale')), error => error.code === 'artifact-unsafe');
  assert.deepEqual(await fs.readFile(installed.path + '/shared-runtime'), data); assert.equal(f.downloads(), 1);
});
