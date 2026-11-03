import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../docker/setup/client/skill-model.js', import.meta.url), 'utf8'), context);
const model = vm.runInContext('T3SkillModel', context);
const plain = value => JSON.parse(JSON.stringify(value));
const roots = [
  { owner: 'claude', owners: ['claude'], writable: true, path: '/custom/claude/skills', readers: ['claude', 'opencode', 'cursor', 'grok', 'muse'] },
  { owner: 'codex', owners: ['codex'], writable: true, path: '/custom/codex/skills', readers: ['codex', 'cursor', 'muse'] },
  { owner: 'opencode', owners: ['opencode'], writable: true, path: '/custom/opencode/skills', readers: ['opencode'] },
  { owner: 'cursor', owners: ['cursor'], writable: true, path: '/custom/cursor/skills', readers: ['cursor', 'grok'] },
  { owner: 'grok', owners: ['grok'], writable: true, path: '/custom/grok/skills', readers: ['grok'] },
  { owner: 'muse', owners: ['muse'], writable: true, path: '/custom/muse/skills', readers: ['muse'] },
  { owner: 'antigravity', owners: ['antigravity'], writable: true, path: '/custom/antigravity/skills', readers: ['antigravity'] },
];
const installed = roots.slice(0, 5).map(root => root.owner);

test('seven-provider browser fixtures share physical identities, reach and native controls', () => {
  const fixture = name => JSON.parse(fs.readFileSync(new URL('../scripts/fixtures/console/' + name + '.json', import.meta.url), 'utf8'));
  const inventories = Object.fromEntries(model.providers.map(provider => [provider.id, fixture('skills-' + provider.id)]));
  const reach = fixture('skills-reach');
  assert(model.providers.every(provider => inventories[provider.id].skills.length));
  const rows = model.join(Object.fromEntries(installed.map(id => [id, inventories[id]])), reach);
  assert.equal(rows.length, 22);
  const research = rows.find(row => row.name === 'deep-research');
  assert.equal(research.byProvider.claude.state, 'name-only');
  assert.equal(research.byProvider.opencode.canSetState, true);
  assert.equal(research.byProvider.codex, undefined);
  assert.equal(model.state(research.byProvider.cursor).kind, 'found');
  assert(rows.some(row => row.packageSource === 'vercel-labs/skills' && !row.canEdit));
  assert.equal(model.filter(rows, { needsAttention: true }).length, 1);
  assert.deepEqual(plain(model.placement(installed, installed, reach.roots).providers), ['claude', 'codex']);
});

test('per-agent placement counts aliases once and keeps every selected agent in its physical group', () => {
  const shared = { owner: 'claude', owners: ['claude', 'codex'], writableOwners: ['claude', 'codex'], writable: true,
    path: '/alias/skills', resolvedPath: '/physical/skills', readers: ['claude', 'codex', 'cursor'] };
  const result = model.placement(['claude', 'codex', 'cursor'], ['claude', 'codex'], [shared], 'each');
  assert.deepEqual(plain(result.providers), ['claude', 'codex', 'cursor']);
  assert.equal(result.destinations.length, 2, 'the unavailable Cursor folder remains separately reviewable/blocked by the API');
  assert.equal(result.counts.claude, 1); assert.equal(result.counts.codex, 1);
  assert.equal(result.assignments.codex, 'claude');
  assert.deepEqual(plain(result.destinations[0].also), ['codex']);
});

test('physical identity joins aliases and native rows without conflating same-name installations', () => {
  const row = { id: 'local', name: 'review', path: '/alias/review/SKILL.md', resolvedPath: '/custom/claude/skills/review/SKILL.md', canEdit: true };
  const inventories = { claude: { skills: [{ ...row, state: 'name-only', canSetState: true }] },
    codex: { skills: [{ ...row, state: 'unknown' }, { ...row, id: 'native', path: '/native/review/SKILL.md', native: true, state: 'disabled', canToggle: true }] },
    cursor: { skills: [{ ...row }, { ...row, path: '/custom/cursor/skills/review/SKILL.md', resolvedPath: '/custom/cursor/skills/review/SKILL.md' }] } };
  const rows = model.join(inventories, { roots });
  assert.equal(rows.length, 2);
  const shared = rows.find(skill => Object.keys(skill.byProvider).length === 3);
  assert.equal(shared.byProvider.codex.id, 'native');
  assert.equal(shared.byProvider.codex.state, 'disabled');
  assert.equal(shared.groupLabel, 'Claude Code folder');
  assert.equal(model.available(shared.byProvider.codex), false);
  assert.equal(model.state(shared.byProvider.claude).kind, 'policy');
});

test('search, available-to and attention combine and count disabled policies accurately', () => {
  const rows = [
    { name: 'review', description: 'Review a patch', attention: true, byProvider: { claude: { state: 'off' }, codex: { state: 'enabled' } } },
    { name: 'release', description: 'Review release notes', attention: false, byProvider: { claude: { state: 'on' }, codex: { state: 'disabled' } } },
  ];
  assert.equal(model.filter(rows, { query: 'REVIEW patch', agent: 'codex', needsAttention: true }).length, 1);
  assert.equal(model.filter(rows, { query: 'review', agent: 'claude', needsAttention: true }).length, 0);
  assert.equal(model.filter(rows, { agent: 'claude' })[0].name, 'release');
  assert.equal(model.available({ state: 'user-invocable-only' }), true);
  assert.equal(model.available({ state: 'ask' }), true);
  assert.equal(model.available({ state: 'deny' }), false);
  assert.equal(model.available({ state: 'on', error: 'Missing' }), false);
});

test('fewest copies covers five agents with two folders, reports duplicates and favors own folders', () => {
  const plan = model.placement(installed, installed, roots);
  assert.deepEqual(plain(plan.providers), ['claude', 'codex']);
  assert.deepEqual(plain(plan.duplicates), ['cursor']);
  assert.equal(plan.assignments.codex, 'codex');
  assert.equal(plan.assignments.cursor, 'claude');
  assert.deepEqual(plain(plan.also), ['muse']);
  assert.deepEqual(plain(model.placement(['cursor'], installed, roots).providers), ['cursor']);
  assert.deepEqual(plain(model.placement(installed, installed, roots, 'each').providers), installed);
});

test('planner does not route through uninstalled or protected destinations and exposes uncovered agents', () => {
  const protectedRoots = roots.map(root => ({ ...root, writable: root.owner !== 'claude' }));
  const plan = model.placement(installed, installed, protectedRoots);
  assert.deepEqual(plain(plan.providers), []);
  assert.deepEqual(plain(plan.uncovered), installed);
  assert.equal(model.placement(['antigravity'], installed, roots).uncovered[0], 'antigravity');
  assert.equal(model.placement(['antigravity'], ['antigravity'], roots).providers[0], 'antigravity');
});

test('planner merges aliased agent homes and respects per-owner write restrictions', () => {
  const aliased = [{ owner: 'claude', owners: ['claude', 'codex'], writableOwners: ['codex'], writable: true,
    path: '/one', resolvedPath: '/physical', readers: ['claude', 'codex'] }];
  const plan = model.placement(['claude', 'codex'], ['claude', 'codex'], aliased);
  assert.deepEqual(plain(plan.providers), ['codex']);
  assert.deepEqual(plain(plan.duplicates), []);
});

test('every subset is covered with the minimum feasible number of folders', () => {
  for (let mask = 1; mask < 128; mask++) {
    const selected = roots.filter((_, i) => mask & (1 << i)).map(root => root.owner);
    const plan = model.placement(selected, roots.map(root => root.owner), roots);
    assert.equal(plan.uncovered.length, 0);
    for (let size = 1; size < plan.providers.length; size++) {
      const feasible = Array.from({ length: 127 }, (_, i) => roots.filter((_, bit) => (i + 1) & (1 << bit)))
        .filter(subset => subset.length === size).some(subset => selected.every(agent => subset.some(root => root.readers.includes(agent))));
      assert.equal(feasible, false, `A smaller covering set existed for ${selected}`);
    }
  }
});

test('path boundaries, environment paths and collapsed system grouping are independent of names', () => {
  assert.equal(model.contains('/home/user', '/home/username/skill'), false);
  assert.equal(model.displayPath('/custom/home/.codex/skills', '/custom/home'), '~/.codex/skills');
  const rows = model.join({ codex: { skills: [{ id: 'sys', name: 'system', scope: 'system', path: '/custom/codex/skills/.system/system/SKILL.md' }] } },
    { roots: [...roots, { owner: null, scope: 'system', source: 'System', path: '/custom/codex/skills/.system', readers: ['codex'] }] });
  assert.equal(rows[0].groupLabel, 'Codex system skills');
});

test('unified view merges same-named folders into one row and keeps singletons physical', () => {
  const codexRow = (name, file, extra = {}) => ({ id: 'codex-' + name + '-' + file, name, description: name + ' workflow', path: '/custom/codex/skills/' + file + '/SKILL.md', resolvedPath: '/custom/codex/skills/' + file + '/SKILL.md', scope: 'user', source: 'Provider', canEdit: true, ...extra });
  const sharedRow = (name, extra = {}) => ({ id: 'shared-' + name, name, description: name, path: '/shared/skills/' + name + '/SKILL.md', resolvedPath: '/shared/skills/' + name + '/SKILL.md', scope: 'user', source: 'Shared .agents', canEdit: true, ...extra });
  const physical = [
    { key: '/custom/codex/skills/review/SKILL.md', path: '/custom/codex/skills/review/SKILL.md', name: 'review', description: 'Review', provider: 'codex', byProvider: { codex: codexRow('review', 'review') }, aliases: [], root: { path: '/custom/codex/skills', readers: ['codex'] }, groupKey: '/custom/codex/skills', groupLabel: 'Codex folder' },
    { key: '/shared/skills/review/SKILL.md', path: '/shared/skills/review/SKILL.md', name: 'review', description: 'Review shared', provider: 'codex', byProvider: { codex: codexRow('review', 'review', { path: '/shared/skills/review/SKILL.md' }) }, aliases: [], root: { path: '/shared/skills', readers: ['codex', 'opencode'] }, groupKey: '/shared/skills', groupLabel: 'Shared .agents folder' },
    { key: '/custom/codex/skills/unique/SKILL.md', path: '/custom/codex/skills/unique/SKILL.md', name: 'unique', description: 'Only here', provider: 'codex', byProvider: { codex: codexRow('unique', 'unique') }, aliases: [], root: { path: '/custom/codex/skills', readers: ['codex'] }, groupKey: '/custom/codex/skills', groupLabel: 'Codex folder' },
  ];
  const unified = model.unify(physical);
  assert.equal(unified.length, 2);
  const merged = unified.find(row => row.name === 'review');
  assert.ok(merged.unified);
  assert.equal(merged.key, 'unified:review');
  assert.equal(merged.installations.length, 2);
  assert.equal(merged.groupKey, 'unified');
  assert.deepEqual([...merged.folders].sort(), ['/custom/codex/skills/review', '/shared/skills/review']);
  assert.ok(merged.byProvider.codex);
  const singleton = unified.find(row => row.name === 'unique');
  assert.equal(singleton.key, '/custom/codex/skills/unique/SKILL.md');
  assert.equal(singleton.unified, undefined);
  const grouped = model.groups(unified).sort((a, b) => a.key.localeCompare(b.key));
  assert.ok(grouped.some(group => group.key === 'unified' && group.rows.length === 1 && group.rows[0].name === 'review'));
  assert.ok(grouped.some(group => group.key === '/custom/codex/skills/skills/review' || group.rows.some(row => row.name === 'unique')));
});
