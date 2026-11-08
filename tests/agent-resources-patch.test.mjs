import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { files, creates, patchAgentResources } from '../docker/runtime/patches/agent-resources.mjs';
import { patches } from '../docker/runtime/patches/index.mjs';

// Run the production bridge modules with only type syntax erased.
async function moduleFor(t, name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 't3-resource-bridge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const text = await fs.readFile(new URL('../docker/runtime/patches/' + name + '.ts', import.meta.url), 'utf8');
  const file = path.join(directory, name + '.mjs');
  await fs.writeFile(file, stripTypeScriptTypes(text, { mode: 'transform' }));
  return { ...(await import(pathToFileURL(file).href)), directory };
}
const put = async (file, content) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };

test('Antigravity profiles load instruction files, modular rules and MCP without sharing auth or hooks', async t => {
  const { linkAntigravityUserResources, directory } = await moduleFor(t, 'antigravity-user-resources');
  const home = path.join(directory, 'home'), profile = path.join(directory, 'private-profile'), root = path.join(home, '.gemini');
  await put(path.join(root, 'config/AGENTS.md'), '# Shared instructions');
  await put(path.join(root, 'GEMINI.md'), '# Additional native guidance');
  await put(path.join(root, 'config/rules/team.md'), '---\ntrigger: always_on\n---\n# Team');
  await put(path.join(root, 'config/mcp_config.json'), JSON.stringify({mcpServers:{fixture:{command:'server'},remote:{serverUrl:'https://example.test/mcp',headers:{Authorization:'private'}},off:{command:'must-not-run',disabled:true}}}));
  await put(path.join(root, 'antigravity-acp/acp_token.json'), 'must-not-be-linked');
  await put(path.join(root, 'antigravity-acp/settings.json'), 'must-not-be-linked');
  await put(path.join(root, 'config/hooks.json'), 'must-not-be-linked');
  await put(path.join(profile, 'antigravity-acp/settings.json'), 'private-auth-selection');
  await linkAntigravityUserResources(profile, home);
  assert.equal(await fs.readFile(path.join(profile, 'config/AGENTS.md'), 'utf8'), '# Shared instructions');
  assert.equal(await fs.readFile(path.join(profile, 'config/rules/team.md'), 'utf8'), '---\ntrigger: always_on\n---\n# Team');
  const mcp = JSON.parse(await fs.readFile(path.join(profile, 'config/mcp_config.json'), 'utf8'));
  assert.equal(mcp.mcpServers.fixture.command, 'server');
  assert.equal(mcp.mcpServers.remote.url, 'https://example.test/mcp');
  assert.equal(mcp.mcpServers.remote.headers.Authorization, 'private');
  assert.equal(mcp.mcpServers.off, undefined);
  assert.equal((await fs.stat(path.join(profile, 'config/mcp_config.json'))).mode & 0o777, 0o600);
  await put(path.join(root, 'config/mcp_config.json'), JSON.stringify({mcpServers:{changed:{command:'new-server'}}}));
  await linkAntigravityUserResources(profile, home);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(profile, 'config/mcp_config.json'), 'utf8')).mcpServers), ['changed']);
  assert.equal(await fs.readFile(path.join(profile, 'antigravity-acp/settings.json'), 'utf8'), 'private-auth-selection');
  for (const file of ['config/hooks.json', 'antigravity-acp/acp_token.json']) await assert.rejects(fs.lstat(path.join(profile, file)), { code: 'ENOENT' });
  // Atomic source saves remain visible through the profile link.
  await put(path.join(root, 'config/next.md'), '# New instructions');
  await fs.rename(path.join(root, 'config/next.md'), path.join(root, 'config/AGENTS.md'));
  assert.equal(await fs.readFile(path.join(profile, 'config/AGENTS.md'), 'utf8'), '# New instructions');
  await fs.unlink(path.join(root, 'config/AGENTS.md'));
  await linkAntigravityUserResources(profile, home);
  await assert.rejects(fs.lstat(path.join(profile, 'config/AGENTS.md')), { code: 'ENOENT' });
});

test('Antigravity bridge reports private conflicts, preserves their files and replaces only empty placeholders', async t => {
  const { linkAntigravityUserResources, directory } = await moduleFor(t, 'antigravity-user-resources');
  const home = path.join(directory, 'home'), profile = path.join(directory, 'private-profile');
  await put(path.join(home, '.gemini/config/AGENTS.md'), '# Global');
  await put(path.join(home, '.gemini/config/mcp_config.json'), '{}');
  await put(path.join(home, '.gemini/config/rules/team.md'), '# Native');
  await put(path.join(profile, 'config/AGENTS.md'), '# Profile-owned');
  const foreign = path.join(directory, 'foreign.json'); await put(foreign, '{"foreign":true}');
  await fs.symlink(foreign, path.join(profile, 'config/mcp_config.json'));
  await fs.mkdir(path.join(profile, 'config/rules'));
  await assert.rejects(linkAntigravityUserResources(profile, home), /private settings.*AGENTS.md/);
  assert.equal(await fs.readFile(path.join(profile, 'config/AGENTS.md'), 'utf8'), '# Profile-owned');
  await fs.unlink(path.join(profile, 'config/AGENTS.md'));
  await assert.rejects(linkAntigravityUserResources(profile, home), /private settings.*mcp_config.json/);
  assert.equal(await fs.readlink(path.join(profile, 'config/mcp_config.json')), foreign);
  await fs.unlink(path.join(profile, 'config/mcp_config.json'));
  await linkAntigravityUserResources(profile, home);
  assert.equal((await fs.lstat(path.join(profile, 'config/rules'))).isSymbolicLink(), true);
});

test('Antigravity snapshots serialize concurrent starts, track removals and preserve manual edits', async t => {
  const { linkAntigravityUserResources, directory } = await moduleFor(t, 'antigravity-user-resources');
  const home = path.join(directory, 'home'), profile = path.join(directory, 'profile');
  const source = path.join(home, '.gemini/config/mcp_config.json'), target = path.join(profile, 'config/mcp_config.json');
  await put(source, '{"mcpServers":{"probe":{"command":"fixture"}}}');
  await Promise.all(Array.from({ length: 8 }, () => linkAntigravityUserResources(profile, home)));
  assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
  assert.equal((await fs.readdir(path.dirname(target))).filter(name => name.startsWith('.t3-user-mcp-')).length, 1);
  await fs.unlink(source); await linkAntigravityUserResources(profile, home);
  await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.dirname(target)), []);
  await put(source, '{"mcpServers":{}}'); await linkAntigravityUserResources(profile, home);
  await fs.writeFile(target, '{"mcpServers":{"private":{"command":"keep"}}}');
  await assert.rejects(linkAntigravityUserResources(profile, home), /private settings/);
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).mcpServers.private.command, 'keep');
});

test('Cursor keeps its primary project, source layers and tool protocol while adding one global instruction workspace', async t => {
  const { withCursorGlobalInstructions, directory } = await moduleFor(t, 'cursor-global-instructions');
  const options = { apiKey: 'private', local: { cwd: '/project', dirs: ['/other-project'], settingSources: ['user', 'project'], sandboxOptions: { enabled: true } } };
  assert.equal(withCursorGlobalInstructions(options, { HOME: directory }), options);
  const root = path.join(directory, '.cursor/t3-instructions');
  await put(path.join(root, 'AGENTS.md'), '# Global');
  const result = withCursorGlobalInstructions(options, { HOME: directory });
  assert.deepEqual(result.local.dirs, ['/other-project', root]);
  assert.equal(result.local.cwd, '/project'); assert.equal(result.systemPrompt, undefined);
  assert.deepEqual(withCursorGlobalInstructions(result, { HOME: directory }), result);
  assert.deepEqual(options.local.dirs, ['/other-project']);
});

test('the resource bridges are registered and reject source drift and repeated application', () => {
  const source = {
    [files[0]]: 'import * as NodeFSP from "node:fs/promises";\n  yield* linkAntigravityUserSkills({ profileDirectory: geminiHome, userHome, platform });',
    [files[1]]: 'import * as CursorAgentSdk from "./CursorAgentSdk.ts";\n.open({ ...input, options: { ...input.options, apiKey } })',
  };
  const next = patchAgentResources(source);
  assert.match(next[files[0]], /linkAntigravityUserResources\(geminiHome, userHome\)/);
  assert.match(next[files[1]], /withCursorGlobalInstructions/);
  assert.ok(creates.every(file => typeof next[file] === 'string'));
  assert.ok(patches.some(patch => patch.name === 'agent-resources'));
  assert.throws(() => patchAgentResources(next), /already exists/);
  assert.throws(() => patchAgentResources({ ...source, [files[1]]: '' }), /no longer matches/);
});
