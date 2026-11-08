import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeAgentsMd, providerInstructionState, setProviderInstructionMode, readProviderAgentsMd, contextStatus } from '../docker/setup/context.mjs';
import { createSkillsService } from '../docker/setup/skills.mjs';
import { createMcpService } from '../docker/setup/mcp.mjs';
import { parse } from '../docker/setup/vendor/toml-patch.mjs';

const put = async (file, content) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
const markdown = name => `---\nname: ${name}\ndescription: Probe robustness.\n---\n# Skill\n`;
async function fixture(t, provider = 'codex') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-resources-robust-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, provider === 'pi' ? '.pi/agent' : '.' + provider);
  const options = { home, env: {}, io: fs, baseDir: path.join(home, '.t3') };
  await writeAgentsMd(fs, options.baseDir, '# Shared');
  return { ...options, root };
}
const change = async (f, provider, mode, io = fs) => setProviderInstructionMode(io, f.baseDir, provider, mode,
  (await providerInstructionState(io, f.baseDir, provider, f)).sourceRevision, f);

for (const provider of ['codex', 'pi']) test(`${provider} disconnects every native fallback and restores the original files and links`, async t => {
  const f = await fixture(t, provider);
  const names = provider === 'pi' ? ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'] : ['AGENTS.override.md', 'AGENTS.md'];
  for (const name of names) await put(path.join(f.root, name), '# ' + name);
  const linked = path.join(f.root, names.at(-1)), target = path.join(f.home, 'team.md');
  await fs.writeFile(target, '# Team'); await fs.unlink(linked);
  const relative = path.relative(f.root, target); await fs.symlink(relative, linked);
  await fs.chmod(path.join(f.root, names[0]), 0o640);
  assert.equal((await change(f, provider, 'none')).ok, true);
  const disconnected = await providerInstructionState(fs, f.baseDir, provider, f);
  assert.equal(disconnected.mode, null); assert.equal(path.basename(disconnected.path), names[0]);
  for (const name of names) {
    await assert.rejects(fs.lstat(path.join(f.root, name)), { code: 'ENOENT' });
    await fs.lstat(path.join(f.root, name + '.t3-context-backup'));
  }
  assert.equal((await change(f, provider, 'shared')).ok, true);
  assert.equal((await readProviderAgentsMd(fs, provider, f)).content, '# Shared');
  assert.equal((await change(f, provider, 'separate')).ok, true);
  for (const name of names.slice(0, -1)) assert.equal(await fs.readFile(path.join(f.root, name), 'utf8'), '# ' + name);
  assert.equal(await fs.readlink(linked), relative);
  assert.equal((await fs.stat(path.join(f.root, names[0]))).mode & 0o777, 0o640);
  assert.equal((await readProviderAgentsMd(fs, provider, f)).content, '# AGENTS.override.md');
});

test('instruction fallback edits and occupied backup slots are refused before moving any file', async t => {
  const f = await fixture(t), primary = path.join(f.root, 'AGENTS.override.md'), fallback = path.join(f.root, 'AGENTS.md');
  await put(primary, '# Primary'); await put(fallback, '# Fallback');
  const before = await providerInstructionState(fs, f.baseDir, 'codex', f);
  await fs.writeFile(fallback, '# Changed fallback');
  assert.equal((await setProviderInstructionMode(fs, f.baseDir, 'codex', 'none', before.sourceRevision, f)).code, 'conflict');
  await fs.writeFile(fallback + '.t3-context-backup', '# Prior backup');
  assert.equal((await change(f, 'codex', 'none')).code, 'conflict');
  assert.equal(await fs.readFile(primary, 'utf8'), '# Primary');
  assert.equal(await fs.readFile(fallback, 'utf8'), '# Changed fallback');
  assert.equal(await fs.readFile(fallback + '.t3-context-backup', 'utf8'), '# Prior backup');
  await assert.rejects(fs.lstat(primary + '.t3-context-backup'), { code: 'ENOENT' });
});

test('one unreadable instruction provider does not hide the other agents', async t => {
  const f = await fixture(t);
  await put(path.join(f.home, '.claude/CLAUDE.md'), '# Readable');
  const io = { ...fs, lstat: async file => {
    if (String(file).startsWith(f.root + path.sep)) throw Object.assign(new Error('Fixture provider is unreadable'), { code: 'EACCES' });
    return fs.lstat(file);
  } };
  const status = await contextStatus(io, f);
  assert.equal(status.providers.length, 8);
  assert.match(status.providers.find(row => row.provider === 'codex').error, /unreadable/);
  assert.equal(status.providers.find(row => row.provider === 'claude').mode, 'separate');
  assert.equal((await readProviderAgentsMd(io, 'codex', f)).code, 'unavailable');
  assert.equal((await change(f, 'codex', 'shared', io)).ok, false);
});

test('a native instruction symlink cannot collide with the source-switch queue', { timeout: 5000 }, async t => {
  const f = await fixture(t), file = path.join(f.root, '.t3-instruction-source');
  await put(file, '# Private guidance');
  await fs.symlink(path.basename(file), path.join(f.root, 'AGENTS.override.md'));
  assert.equal((await change(f, 'codex', 'shared')).ok, true);
  assert.equal((await change(f, 'codex', 'separate')).ok, true);
  assert.equal((await readProviderAgentsMd(fs, 'codex', f)).content, '# Private guidance');
});

for (const mode of ['none', 'separate']) test(`failed ${mode} instruction changes roll back the complete file set`, async t => {
  const f = await fixture(t), primary = path.join(f.root, 'AGENTS.override.md'), fallback = path.join(f.root, 'AGENTS.md');
  await put(primary, '# Primary'); await put(fallback, '# Fallback');
  if (mode === 'separate') assert.equal((await change(f, 'codex', 'none')).ok, true);
  let injected = false;
  const io = { ...fs, link: async (from, to) => {
    if (!injected && from === (mode === 'none' ? fallback : fallback + '.t3-context-backup')) {
      injected = true; throw Object.assign(new Error('Injected filesystem failure'), { code: 'EACCES' });
    }
    return fs.link(from, to);
  } };
  await assert.rejects(change(f, 'codex', mode, io), { code: 'EACCES' });
  assert.equal(injected, true);
  const suffix = mode === 'none' ? '' : '.t3-context-backup';
  assert.equal(await fs.readFile(primary + suffix, 'utf8'), '# Primary');
  assert.equal(await fs.readFile(fallback + suffix, 'utf8'), '# Fallback');
  for (const file of [primary, fallback]) await assert.rejects(fs.lstat(file + (suffix ? '' : '.t3-context-backup')), { code: 'ENOENT' });
  assert.equal((await change(f, 'codex', mode)).ok, true, 'retry after a filesystem failure succeeds with a fresh revision');
});

test('a backup created during an instruction switch is never overwritten', async t => {
  const f = await fixture(t), file = path.join(f.root, 'AGENTS.override.md');
  await put(file, '# Primary');
  let injected = false;
  const io = { ...fs, link: async (from, to) => {
    if (!injected && to === file + '.t3-context-backup') { injected = true; await fs.writeFile(to, '# Concurrent backup'); }
    return fs.link(from, to);
  } };
  await assert.rejects(change(f, 'codex', 'shared', io), { code: 'conflict' });
  assert.equal(await fs.readFile(file, 'utf8'), '# Primary');
  assert.equal(await fs.readFile(file + '.t3-context-backup', 'utf8'), '# Concurrent backup');
  assert.equal((await fs.readdir(f.root)).some(name => name.includes('.tmp.')), false);
});

test('a failed restoration from Shared retains the shared link and every original backup', async t => {
  const f = await fixture(t), primary = path.join(f.root, 'AGENTS.override.md'), fallback = path.join(f.root, 'AGENTS.md');
  await put(primary, '# Primary'); await put(fallback, '# Fallback');
  await change(f, 'codex', 'none'); await change(f, 'codex', 'shared');
  let injected = false;
  const io = { ...fs, link: async (from, to) => {
    if (!injected && from === fallback + '.t3-context-backup') { injected = true; throw Object.assign(new Error('Injected restore failure'), { code: 'EACCES' }); }
    return fs.link(from, to);
  } };
  await assert.rejects(change(f, 'codex', 'separate', io), { code: 'EACCES' });
  assert.equal((await providerInstructionState(fs, f.baseDir, 'codex', f)).mode, 'shared');
  assert.equal(await fs.readFile(primary, 'utf8'), '# Shared');
  assert.equal(await fs.readFile(primary + '.t3-context-backup', 'utf8'), '# Primary');
  assert.equal(await fs.readFile(fallback + '.t3-context-backup', 'utf8'), '# Fallback');
  assert.equal((await fs.readdir(f.root)).some(name => name.includes('.tmp.')), false);
  assert.equal((await change(f, 'codex', 'separate')).ok, true);
});

test('an instruction destination created during restoration is preserved with the original backups', async t => {
  const f = await fixture(t), primary = path.join(f.root, 'AGENTS.override.md'), fallback = path.join(f.root, 'AGENTS.md');
  await put(primary, '# Primary'); await put(fallback, '# Fallback'); await change(f, 'codex', 'none');
  let injected = false;
  const io = { ...fs, link: async (from, to) => {
    if (!injected && to === fallback) { injected = true; await fs.writeFile(to, '# Concurrent file'); }
    return fs.link(from, to);
  } };
  await assert.rejects(change(f, 'codex', 'separate', io), { code: 'conflict' });
  assert.equal(await fs.readFile(fallback, 'utf8'), '# Concurrent file');
  assert.equal(await fs.readFile(primary + '.t3-context-backup', 'utf8'), '# Primary');
  assert.equal(await fs.readFile(fallback + '.t3-context-backup', 'utf8'), '# Fallback');
  await assert.rejects(fs.lstat(primary), { code: 'ENOENT' });
});

test('a blocked rollback preserves both the concurrent file and the original with a recovery path', async t => {
  const f = await fixture(t), primary = path.join(f.root, 'AGENTS.override.md'), fallback = path.join(f.root, 'AGENTS.md');
  await put(primary, '# Primary'); await put(fallback, '# Fallback');
  const io = { ...fs, link: async (from, to) => {
    if (from === fallback) { await fs.writeFile(primary, '# Concurrent file'); throw new Error('Injected move failure'); }
    return fs.link(from, to);
  } };
  await assert.rejects(change(f, 'codex', 'none', io), error => {
    assert.match(error.message, /could not be rolled back/);
    assert.ok(error.message.includes(primary + '.t3-context-backup')); return true;
  });
  assert.equal(await fs.readFile(primary, 'utf8'), '# Concurrent file');
  assert.equal(await fs.readFile(primary + '.t3-context-backup', 'utf8'), '# Primary');
  assert.equal(await fs.readFile(fallback, 'utf8'), '# Fallback');
});

test('Muse null activation agrees with the native Off state and can be enabled explicitly', async t => {
  const f = await fixture(t), root = path.join(f.home, '.config/muse');
  await put(path.join(root, 'skills/probe/SKILL.md'), markdown('probe'));
  await put(path.join(root, 'settings.json'), JSON.stringify({ schema_version: 1, skills: { activation: { user: { '$CONFIG_DIR/skills/probe/SKILL.md': null } } } }));
  const svc = createSkillsService(f), row = (await svc.list('muse')).skills[0];
  assert.equal(row.state, 'off'); assert.equal(row.canSetState, true);
  await svc.setState('muse', row.id, row.stateRevision, undefined, 'on');
  assert.equal((await svc.list('muse', { refresh: true })).skills[0].state, 'on');
});

test('an unsupported Muse settings schema disables MCP controls as well as writes', async t => {
  const f = await fixture(t), file = path.join(f.home, '.config/muse/settings.json');
  const original = '{"schema_version":2,"mcpServers":{"probe":{"command":"keep"}}}'; await put(file, original);
  const svc = createMcpService(f), status = await svc.status({ refresh: true });
  assert.equal(status.providers.find(row => row.provider === 'muse').code, 'unsupported');
  await assert.rejects(svc.list('muse'), { code: 'unsupported' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

for (const provider of ['grok', 'muse', 'pi']) test(`${provider} serializes concurrent skill and MCP writes through a shared native file`, async t => {
  const f = await fixture(t, provider), root = provider === 'muse' ? path.join(f.home, '.config/muse') : f.root;
  await put(path.join(root, 'skills/probe/SKILL.md'), markdown('probe'));
  const skills = createSkillsService(f), mcp = createMcpService(f);
  const shared = await mcp.create({ name: 'probe', type: 'local', command: ['fixture'] });
  const row = (await skills.list(provider)).skills[0], native = await mcp.list(provider);
  const results = await Promise.allSettled([
    skills.setState(provider, row.id, row.stateRevision, undefined, provider === 'muse' ? 'off' : 'disabled'),
    mcp.setLink(provider, 'probe', true, shared.revision, native.revision),
  ]);
  // Pi stores MCP separately. Grok and Muse must reject the stale competing
  // write, rather than losing the first write's unrelated settings.
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  assert.equal(fulfilled.length, provider === 'pi' ? 2 : 1);
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'conflict', result.reason.stack);
  if (results[1].status === 'rejected') await mcp.setLink(provider, 'probe', true, shared.revision, (await mcp.list(provider)).revision);
  if (results[0].status === 'rejected') {
    const current = (await skills.list(provider, { refresh: true })).skills[0];
    await skills.setState(provider, current.id, current.stateRevision, undefined, provider === 'muse' ? 'off' : 'disabled');
  }
  assert.deepEqual((await mcp.list(provider)).linked, ['probe']);
  assert.equal((await skills.list(provider, { refresh: true })).skills[0].state, provider === 'muse' ? 'off' : 'disabled');
  if (provider === 'grok') assert.equal(parse(await fs.readFile(path.join(root, 'config.toml'), 'utf8')).mcp_servers.probe.command, 'fixture');
});
