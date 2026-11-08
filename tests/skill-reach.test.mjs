import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSkillsService } from '../docker/setup/skills.mjs';

test('reach describes all eight agents with overridden, missing and aliased roots', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-reach-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: 'custom-claude', CODEX_HOME: 'custom-codex', XDG_CONFIG_HOME: 'custom-config', GROK_HOME: 'custom-grok' };
  await fs.mkdir(path.join(home, 'physical'));
  await fs.mkdir(path.join(home, 'custom-claude')); await fs.mkdir(path.join(home, 'custom-codex'));
  await fs.symlink(path.join(home, 'physical'), path.join(home, 'custom-claude/skills'));
  await fs.symlink(path.join(home, 'physical'), path.join(home, 'custom-codex/skills'));
  const service = createSkillsService({ home, env });
  const result = await service.reach(), root = result.roots.find(root => root.resolvedPath === path.join(home, 'physical'));
  assert.deepEqual(root.owners, ['claude', 'codex']);
  assert.deepEqual(root.readers, ['claude', 'codex', 'opencode', 'cursor', 'grok', 'muse']);
  assert.equal(root.paths.length, 2); assert.equal(root.writable, true);
  assert(result.roots.some(root => root.path === path.join(home, 'custom-config/muse/skills')));
  assert(result.roots.some(root => root.path === path.join(home, 'custom-grok/skills')));
  const system = result.roots.find(root => root.scope === 'system');
  assert.deepEqual(system.readers, ['codex']); assert.equal(system.writable, false);
  assert.equal((await service.reach()), result, 'the metadata shares its pending/TTL cache');
  await fs.symlink(path.join(home, 'missing-target'), path.join(home, 'custom-config'));
  const changed = await service.reach({ refresh: true });
  assert(changed.roots.filter(root => root.path.startsWith(path.join(home, 'custom-config/'))).every(root => !root.writable && root.resolvedPath === null));
});

test('reach fails closed on an unreadable package lock without scanning skills', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-reach-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.agents'));
  await fs.writeFile(path.join(home, '.agents/.skill-lock.json'), '{ invalid');
  const result = await createSkillsService({ home, env: {} }).reach();
  assert(result.roots.every(root => !root.writable));
});
