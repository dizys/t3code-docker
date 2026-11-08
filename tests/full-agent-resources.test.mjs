import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AGENT_NAMES, agentResourcePaths } from '../docker/setup/agent-resources.mjs';
import { agentsMdTargets, contextStatus, providerInstructionState, setProviderInstructionMode, readProviderAgentsMd, writeProviderAgentsMd, writeAgentsMd } from '../docker/setup/context.mjs';
import { createMcpService } from '../docker/setup/mcp.mjs';
import { readProviderMcp, writeProviderMcpEntry } from '../docker/setup/mcp/adapters.mjs';
import { parseMcpSnippet } from '../docker/setup/mcp/parse.mjs';
import { createSkillsService, skillRoots } from '../docker/setup/skills.mjs';
import { skillAdapter } from '../docker/setup/skills/adapters.mjs';
import { parse } from '../docker/setup/vendor/toml-patch.mjs';
const fixture = async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-all-agents-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, baseDir: path.join(home, '.t3'), env: { HOME: home }, io: fs };
};
const put = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
const skill = '# Fixture body\n';
const markdown = name => `---\nname: ${name}\ndescription: Verify local resource loading.\n---\n${skill}`;

test('native MCP imports accept wrapped, legacy and standalone agent entries without losing credentials', () => {
  const remote = { serverUrl: 'https://example.test/mcp', headers: { Authorization: 'Bearer fixture' }, disabled: true };
  for (const value of [
    { mcpServers: { probe: remote } },
    { probe: remote },
    remote,
    { schema_version: 1, mcpServers: { probe: { url: remote.serverUrl, headers: remote.headers, enabled: false } } },
    { schema_version: 1, mcp_servers: { probe: { url: remote.serverUrl, headers: remote.headers, enabled: false } } },
    { type: 'streamable-http', url: remote.serverUrl, headers: remote.headers, enabled: false },
  ]) {
    const result = parseMcpSnippet(JSON.stringify(value));
    assert.deepEqual(result.errors, [], JSON.stringify(value));
    assert.equal(result.servers.length, 1);
    assert.equal(result.servers[0].url, remote.serverUrl);
    assert.deepEqual(result.servers[0].headers, remote.headers);
    assert.equal(result.servers[0].enabled, undefined, 'importing does not change the independent per-agent setting');
    assert.deepEqual(result.notes, []);
  }
  const local = parseMcpSnippet(JSON.stringify({ schema_version: 1, mcp_servers: { probe: { command: 'fixture', args: ['', 'with space'], env: { TOKEN: 'fixture' } } } }));
  assert.deepEqual(local.errors, []);
  assert.deepEqual(local.servers[0].command, ['fixture', '', 'with space']);
  assert.deepEqual(local.servers[0].env, { TOKEN: 'fixture' });
  for (const value of [
    { mcp_servers: {}, mcpServers: {} },
    { mcp_servers: [] },
    { mcp_servers: { probe: { command: 'fixture', url: remote.serverUrl } } },
    { command: 'fixture', serverUrl: remote.serverUrl },
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['probe-' + i, remote])),
  ]) assert.ok(parseMcpSnippet(JSON.stringify(value)).errors.length, JSON.stringify(value));
});

test('all eight registries expose matching native paths and project placements', async t => {
  const f = await fixture(t), env = { ...f.env, GROK_HOME: 'grok-custom', PI_CODING_AGENT_DIR: 'pi-custom', XDG_CONFIG_HOME: '.cfg' }, roots = agentResourcePaths(f.home, env);
  assert.equal(Object.keys(AGENT_NAMES).length, 8);
  assert.deepEqual(agentsMdTargets(env, f.home).map(row => row.provider), Object.keys(AGENT_NAMES));
  for (const provider of Object.keys(AGENT_NAMES)) {
    assert.equal(skillRoots(provider, { ...f, env })[0].path, path.join(roots[provider], 'skills'));
    assert.ok(skillAdapter(provider, { ...f, env }).projectDir);
  }
  assert.equal(roots.pi, path.join(f.home, 'pi-custom'));
  assert.equal(roots.grok, path.join(f.home, 'grok-custom'));
});

test('Pi and Codex instructions honor existing native overrides and conflict checks', async t => {
  const f = await fixture(t), roots = agentResourcePaths(f.home, f.env);
  await writeAgentsMd(fs, f.baseDir, '# Shared');
  for (const provider of ['pi', 'codex']) {
    const override = path.join(roots[provider], 'AGENTS.override.md');
    await put(path.join(roots[provider], 'AGENTS.md'), '# Lower priority');
    await put(override, '# Native override');
    const state = await providerInstructionState(fs, f.baseDir, provider, f);
    assert.equal(state.path, override);
    const read = await readProviderAgentsMd(fs, provider, f);
    assert.equal((await writeProviderAgentsMd(fs, provider, '# Edited override', read.revision, f)).ok, true);
    assert.equal((await writeProviderAgentsMd(fs, provider, '# Stale', read.revision, f)).code, 'conflict');
    const current = await providerInstructionState(fs, f.baseDir, provider, f);
    assert.equal((await setProviderInstructionMode(fs, f.baseDir, provider, 'shared', current.sourceRevision, f)).ok, true);
    assert.equal(await fs.readFile(override, 'utf8'), '# Shared');
    assert.equal(await fs.readFile(path.join(roots[provider], 'AGENTS.md'), 'utf8'), '# Lower priority');
  }
  assert.equal((await contextStatus(fs, f)).providers.length, 8);
});

for (const provider of ['grok', 'muse', 'pi', 'antigravity']) test(`${provider} MCP preserves native options, secrets, revision and independent off state`, async t => {
  const f = await fixture(t), changes = [], svc = createMcpService({ ...f, onNativeChange: async id => { changes.push(id); } });
  const created = await svc.create({ name: 'resource-probe', type: 'remote', url: 'https://example.test/private?token=private', headers: { Authorization: 'Bearer private' } });
  const before = await readProviderMcp(fs, provider, f);
  await svc.setLink(provider, 'resource-probe', true, created.revision, before.revision, false);
  let state = await svc.list(provider);
  assert.deepEqual(state.linked, ['resource-probe']); assert.deepEqual(state.disabled, ['resource-probe']);
  assert.equal(JSON.stringify(await svc.status({ refresh: true })).includes('private'), false);
  await assert.rejects(svc.setLink(provider, 'resource-probe', true, created.revision, before.revision), { code: 'conflict' });
  await svc.setLink(provider, 'resource-probe', true, created.revision, state.revision, true);
  assert.deepEqual((await svc.list(provider)).disabled, []);
  const native = await readProviderMcp(fs, provider, f), entry = { ...native.servers[0].entry, timeout: 90 };
  await writeProviderMcpEntry(fs, provider, f, 'resource-probe', entry, { revision: native.revision });
  state = await svc.list(provider);
  assert.deepEqual(state.diverged, ['resource-probe']);
  assert.equal((await svc.diff(provider, 'resource-probe')).extraOptions.includes('timeout'), true);
  const source = await fs.readFile(state.path, 'utf8');
  if (provider === 'muse') assert.equal(JSON.parse(source).schema_version, 1);
  await svc.setLink(provider, 'resource-probe', false, created.revision, state.revision);
  assert.deepEqual((await svc.list(provider)).unlinked, ['resource-probe']);
  assert.ok(changes.length >= 3);
});

test('Grok disable-list state can be enabled without losing other entries or model routing', async t => {
  const f = await fixture(t), file = path.join(f.home, '.grok/config.toml');
  await put(file, '# Routing stays native\nmodel = "grok-code"\ndisabled_mcp_servers = ["resource-probe", "other"]\n[mcp_servers.resource-probe]\ncommand = "fixture"\n');
  const svc = createMcpService(f), created = await svc.create({ name: 'resource-probe', type: 'local', command: ['fixture'], env: {} });
  const before = await svc.list('grok'); assert.deepEqual(before.disabled, ['resource-probe']);
  await svc.setLink('grok', 'resource-probe', true, created.revision, before.revision, true);
  const config = parse(await fs.readFile(file, 'utf8'));
  assert.equal(config.model, 'grok-code'); assert.deepEqual(config.disabled_mcp_servers, ['other']);
});

test('Pi never shadows T3 orchestration and Muse refuses an unknown settings schema', async t => {
  const f = await fixture(t), svc = createMcpService(f);
  const created = await svc.create({ name: 't3-code', type: 'local', command: ['fixture'] });
  await assert.rejects(svc.setLink('pi', 't3-code', true, created.revision), { code: 'unsupported' });
  const file = path.join(f.home, '.config/muse/settings.json');
  await put(file, '{"schema_version":2,"future":true}');
  await assert.rejects(svc.setLink('muse', 't3-code', true, created.revision), { code: 'unsupported' });
  assert.equal(await fs.readFile(file, 'utf8'), '{"schema_version":2,"future":true}');
});

for (const provider of ['grok', 'muse', 'pi']) test(`${provider} skill user settings preserve unrelated MCP, native rules and reject stale saves`, async t => {
  const f = await fixture(t), root = agentResourcePaths(f.home, f.env)[provider], file = path.join(root, provider === 'grok' ? 'config.toml' : 'settings.json');
  await put(path.join(root, 'skills/resource-probe/SKILL.md'), markdown('resource-probe'));
  await put(file, provider === 'grok' ? '# Keep this comment\nmodel="native"\n[skills]\nignore=["/ignored"]\n[mcp_servers.existing]\ncommand="fixture"\n' : JSON.stringify({ ...(provider === 'muse' ? { schema_version: 1 } : {}), unrelated: true, mcpServers: { existing: { command: 'fixture' } } }));
  const changed = [], svc = createSkillsService({ ...f, onNativeChange: async id => changed.push(id) });
  let inventory = await svc.list(provider), row = inventory.skills[0];
  assert.equal(row.canSetState, true); assert.equal(inventory.coverage, 'settings');
  await svc.setState(provider, row.id, row.stateRevision, undefined, provider === 'muse' ? 'off' : 'disabled');
  await assert.rejects(svc.setState(provider, row.id, row.stateRevision, undefined, provider === 'muse' ? 'on' : 'enabled'), { code: 'conflict' });
  inventory = await svc.list(provider, { refresh: true }); row = inventory.skills[0];
  assert.equal(row.state, provider === 'muse' ? 'off' : 'disabled');
  const raw = await fs.readFile(file, 'utf8'), config = provider === 'grok' ? parse(raw) : JSON.parse(raw);
  assert.equal(provider === 'grok' ? config.mcp_servers.existing.command : config.mcpServers.existing.command, 'fixture');
  if (provider === 'grok') { assert.deepEqual(config.skills.ignore, ['/ignored']); assert.match(raw, /Keep this comment/); }
  if (provider === 'muse') {
    assert.equal(config.skills.activation.user['$CONFIG_DIR/skills/resource-probe/SKILL.md'], 'off');
    assert.equal(config.skills.activation.user[row.path], undefined);
  }
  await svc.setState(provider, row.id, row.stateRevision, undefined, provider === 'muse' ? 'on' : 'enabled');
  assert.equal((await svc.list(provider, { refresh: true })).skills[0].state, provider === 'muse' ? 'on' : 'enabled');
  assert.deepEqual(changed, [provider, provider]);
});

test('Pi MCP gates older installations, supports the native floor and preserves existing config on refusal', async t => {
  const f = await fixture(t); let version = '0.80.5';
  const svc = createMcpService({ ...f, getHarness: async () => ({ installed: true, version }) });
  const created = await svc.create({ name: 'resource-probe', type: 'local', command: ['fixture'] });
  await assert.rejects(svc.setLink('pi', 'resource-probe', true, created.revision), { code: 'upgrade-required' });
  assert.equal((await svc.status({ refresh: true })).providers.find(row => row.provider === 'pi').code, 'upgrade-required');
  assert.equal((await svc.list('pi')).shared[0].linkable, false);
  await assert.rejects(fs.stat(path.join(f.home, '.pi/agent/mcp.json')), { code: 'ENOENT' });
  version = '0.99.0';
  await svc.setLink('pi', 'resource-probe', true, created.revision);
  version = '0.80.5';
  const before = await fs.readFile(path.join(f.home, '.pi/agent/mcp.json'), 'utf8');
  await assert.rejects(svc.setLink('pi', 'resource-probe', true, created.revision), { code: 'upgrade-required' });
  assert.equal(await fs.readFile(path.join(f.home, '.pi/agent/mcp.json'), 'utf8'), before);
  // A downgrade must still allow cleanup of a configuration it cannot load.
  await svc.setLink('pi', 'resource-probe', false, created.revision);
});

for (const [provider, text] of [
  ['grok', 'skills = []\n'],
  ['muse', '{"skills":"unsupported"}'],
  ['muse', '{"skills":{"activation":"unsupported"}}'],
  ['muse', '{"skills":{"activation":{"user":[]}}}'],
]) test(`${provider} leaves malformed native skill settings read-only: ${text.trim()}`, async t => {
  const f = await fixture(t), root = agentResourcePaths(f.home, f.env)[provider];
  const file = path.join(root, provider === 'grok' ? 'config.toml' : 'settings.json');
  await put(path.join(root, 'skills/resource-probe/SKILL.md'), markdown('resource-probe'));
  await put(file, text);
  const svc = createSkillsService(f), inventory = await svc.list(provider), row = inventory.skills[0];
  assert.ok(inventory.nativeError); assert.equal(Boolean(row.canSetState), false);
  await assert.rejects(svc.setState(provider, row.id, row.stateRevision, undefined, provider === 'grok' ? 'disabled' : 'off'), { code: 'unsupported' });
  assert.equal(await fs.readFile(file, 'utf8'), text);
});

test('Muse uses symbolic display paths for shared and Codex skill settings', async t => {
  const f = await fixture(t); f.env.CODEX_HOME = path.join(f.home, 'custom-codex');
  for (const [directory, name] of [[path.join(f.home, '.agents/skills'), 'shared-probe'], [path.join(f.env.CODEX_HOME, 'skills'), 'codex-probe']]) await put(path.join(directory, name, 'SKILL.md'), markdown(name));
  const svc = createSkillsService(f), rows = (await svc.list('muse')).skills;
  for (const row of rows) await svc.setState('muse', row.id, (await svc.list('muse', { refresh: true })).skills.find(item => item.id === row.id).stateRevision, undefined, 'off');
  const config = JSON.parse(await fs.readFile(path.join(f.home, '.config/muse/settings.json'), 'utf8'));
  assert.deepEqual(config.skills.activation.user, { '$HOME/.agents/skills/shared-probe/SKILL.md': 'off', '$CODEX_HOME/skills/codex-probe/SKILL.md': 'off' });
});

test('Muse preserves a legacy MCP container and refuses ambiguous settings', async t => {
  const f = await fixture(t), file = path.join(f.home, '.config/muse/settings.json');
  await put(file, '{"schema_version":1,"mcp_servers":{"existing":{"command":"keep"}}}');
  const svc = createMcpService(f), created = await svc.create({ name: 'resource-probe', type: 'remote', url: 'https://example.test/mcp' });
  await svc.setLink('muse', 'resource-probe', true, created.revision);
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(config.mcpServers, undefined); assert.equal(config.mcp_servers.existing.command, 'keep');
  assert.equal(config.mcp_servers['resource-probe'].url, 'https://example.test/mcp');
  const ambiguous = JSON.stringify({ ...config, mcpServers: {} }); await fs.writeFile(file, ambiguous);
  await assert.rejects(svc.setLink('muse', 'resource-probe', true, created.revision), { code: 'unsupported' });
  assert.equal(await fs.readFile(file, 'utf8'), ambiguous);
});

test('Antigravity preserves its native direct-map MCP layout when adding and unlinking servers', async t => {
  const f = await fixture(t), file = path.join(f.home, '.gemini/config/mcp_config.json');
  await put(file, '{"existing":{"serverUrl":"https://example.test/mcp","disabled":true,"timeout":90}}');
  const svc = createMcpService(f), created = await svc.create({ name: 'resource-probe', type: 'local', command: ['fixture'] });
  assert.equal((await svc.list('antigravity')).own[0].name, 'existing');
  await svc.setLink('antigravity', 'resource-probe', true, created.revision);
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(config.mcpServers, undefined); assert.equal(config['resource-probe'].command, 'fixture');
  assert.equal(config.existing.disabled, true); assert.equal(config.existing.timeout, 90);
  await svc.setLink('antigravity', 'resource-probe', false, created.revision);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { existing: config.existing });
});

test('placement preserves relative directory links and refuses shared or duplicate installations', async t => {
  const f = await fixture(t), root = skillRoots('cursor', f)[0].path;
  await put(path.join(f.home, '.agents/skills/shared/SKILL.md'), markdown('shared'));
  await put(path.join(f.home, 'local-source/SKILL.md'), markdown('linked'));
  await fs.mkdir(root, { recursive: true });
  await fs.symlink(path.relative(root, path.join(f.home, 'local-source')), path.join(root, 'linked'));
  const svc = createSkillsService(f);
  let rows = (await svc.list('cursor')).skills;
  assert.equal(rows.find(row => row.name === 'shared').canToggle, false);
  let row = rows.find(row => row.name === 'linked');
  await svc.setState('cursor', row.id, row.stateRevision, false);
  row = (await svc.list('cursor', { refresh: true })).skills.find(row => row.name === 'linked');
  assert.equal(row.state, 'disabled'); assert.equal(row.error, null);
  await svc.setState('cursor', row.id, row.stateRevision, true);
  assert.equal(await fs.realpath(path.join(root, 'linked')), path.join(f.home, 'local-source'));
  assert.equal((await fs.lstat(path.join(root, 'linked'))).isSymbolicLink(), true);
  await put(path.join(f.home, '.agents/skills/linked/SKILL.md'), markdown('linked'));
  row = (await svc.list('cursor', { refresh: true })).skills.find(row => row.path === path.join(root, 'linked/SKILL.md'));
  assert.equal(row.canToggle, false); assert.match(row.stateReadOnlyReason, /duplicate/);
});

for (const provider of ['cursor', 'antigravity']) test(`${provider} parks and restores an entire local skill with its supporting files`, async t => {
  const f = await fixture(t), root = skillRoots(provider, f)[0].path, directory = path.join(root, 'resource-probe');
  await put(path.join(directory, 'SKILL.md'), markdown('resource-probe'));
  await put(path.join(directory, 'scripts/check.sh'), '#!/bin/sh\necho fixture\n');
  await fs.chmod(path.join(directory, 'scripts/check.sh'), 0o755);
  const svc = createSkillsService(f);
  let row = (await svc.list(provider)).skills[0]; assert.equal(row.canToggle, true);
  const original = row;
  await svc.setState(provider, row.id, row.stateRevision, false);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  row = (await svc.list(provider, { refresh: true })).skills[0]; assert.equal(row.state, 'disabled'); assert.equal(row.canToggle, true);
  assert.equal(row.placementKey, original.placementKey);
  assert.notEqual(row.id, original.id); assert.notEqual(row.resolvedPath, original.resolvedPath);
  assert.equal(row.canEdit, false); assert.equal(row.canRemove, false);
  await svc.setState(provider, row.id, row.stateRevision, true);
  assert.equal(await fs.readFile(path.join(directory, 'scripts/check.sh'), 'utf8'), '#!/bin/sh\necho fixture\n');
  assert.equal((await fs.stat(path.join(directory, 'scripts/check.sh'))).mode & 0o777, 0o755);
  row = (await svc.list(provider, { refresh: true })).skills[0];
  await put(path.join(root + '.t3-disabled', 'resource-probe/SKILL.md'), '# Existing content');
  await assert.rejects(svc.setState(provider, row.id, row.stateRevision, false), { code: 'conflict' });
  assert.equal(await fs.readFile(path.join(root + '.t3-disabled', 'resource-probe/SKILL.md'), 'utf8'), '# Existing content');
});
