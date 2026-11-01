import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../docker/setup/client/skills.js', import.meta.url), 'utf8');
const model = await readFile(new URL('../docker/setup/client/skill-model.js', import.meta.url), 'utf8');
const skills = [
  { id: 'user', name: 'My skill', scope: 'user' },
  { id: 'system', name: 'Bundled skill', scope: 'system' },
  { id: 'admin', name: 'Organization skill', scope: 'admin' },
  { id: 'plugin', name: 'Plugin skill', scope: 'user', source: 'Plugin' },
].map(row => ({ ...row, path: '/skills/' + row.id + '/SKILL.md', resolvedPath: '/skills/' + row.id + '/SKILL.md', description: '', canEdit: row.scope === 'user' }));
async function fixture(rows = skills, storage = new Map(), onRequest, installed = ['codex', 'cursor']) {
  const requests = [], installs = [], updates = [], menus = [];
  const context = vm.createContext({
    Kit: { html: (parts, ...values) => parts.reduce((text, part, i) => text + part + (Array.isArray(values[i]) ? values[i].join('') : values[i] ?? ''), ''), raw: value => value, icon: () => '', announce() {}, isPhone: () => false, menu: (_, config) => { menus.push(config); return config.items.find(item => item.label?.startsWith('Review'))?.run(); } },
    T3Model: { plural: (count, name) => `${count} ${name}${count === 1 ? '' : 's'}`, listOf: names => names.join(', '), absTime: String, relTime: String },
    T3C: { agentMark: () => '' },
    T3SkillImport: { create: () => ({ open: options => installs.push(options) }) },
    T3SkillInspector: { create: () => ({ repaint() {} }) },
    T3SkillHooks: { create: () => ({ open() {}, close: () => true }) },
    T3SkillUpdate: { create: () => ({ open: (provider, id) => updates.push({ provider, id }), close: () => true }) },
    document: { getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  });
  vm.runInContext(model + '\n' + source + '\nglobalThis.create = T3SkillsUI.create;', context);
  const ui = context.create({ render() {}, getStatus: () => ({ harnesses: installed.map(id => ({ installed: true, id })) }), api: async (url, options) => {
    requests.push({ url, options });
    const custom = await onRequest?.(url, options);
    if (custom) return custom;
    const provider = url.includes('cursor') ? 'cursor' : 'codex';
    return { ok: true, data: url.includes('/reach') ? { roots: [] } : { provider, scannedAt: Date.now(), skills: structuredClone(rows) } };
  } });
  await ui.refresh();
  await new Promise(resolve => setImmediate(resolve));
  return { ui, requests, storage, installs, updates, menus };
}

test('bundled filter hides physical system skills only and persists without provider writes', async () => {
  const { ui, requests, storage } = await fixture();
  assert.match(ui.content(), /Bundled skill/);
  const before = requests.length;
  ui.toggleBundled();
  const content = ui.content();
  assert.doesNotMatch(content, /data-key="(?:phone-)?skill-[^\"]*system/);
  for (const name of ['My skill', 'Organization skill', 'Plugin skill']) assert.ok(content.includes(name));
  assert.match(content, /1 bundled skill is hidden/);
  assert.equal(requests.length, before);
  const restored = await fixture(skills, storage);
  assert.doesNotMatch(restored.ui.content(), /data-key="(?:phone-)?skill-[^\"]*system/);
  restored.ui.toggleBundled();
  assert.match(restored.ui.content(), /Bundled skill/);
});

test('filtered empty state has a working clear action', async () => {
  const { ui } = await fixture([skills[1]]);
  ui.toggleBundled();
  assert.match(ui.content(), /1 bundled skill is hidden/);
  assert.match(ui.content(), /No skills match these filters/);
  ui.clear();
  assert.match(ui.content(), /Bundled skill/);
});

test('blocked browser storage still allows filtering for the session', async () => {
  const { ui } = await fixture(skills, { get() { throw Error('blocked'); }, set() { throw Error('blocked'); } });
  ui.toggleBundled();
  assert.doesNotMatch(ui.content(), /data-key="(?:phone-)?skill-[^\"]*system/);
});

const tracked = { ...skills[0], origin: { source: 'org/repo', name: 'my-skill', fingerprint: 'a'.repeat(64) } };
test('repository checks deduplicate physical copies and review selects only the owning installation', async () => {
  const sibling = { ...tracked, id: 'second', name: 'second-skill', path: '/skills/second/SKILL.md', resolvedPath: '/skills/second/SKILL.md' };
  const { ui, requests, installs, updates } = await fixture([tracked, sibling], new Map(), (url, options) => url.endsWith('/check-update') ? { ok: true, data: { results: options.body.skills.map(skill => ({ ok: true, ...skill, update: { ...tracked.origin, status: 'available' } })) } } : null);
  await ui.checkUpdates();
  const checks = requests.filter(request => request.url.endsWith('/check-update'));
  assert.equal(checks.length, 1, 'two agent inventories refer to one physical installation');
  assert.deepEqual(JSON.parse(JSON.stringify(checks[0].options.body.skills)), [{ provider: 'codex', id: tracked.id }, { provider: 'codex', id: sibling.id }]);
  assert.match(ui.content(), /Update available/);
  ui.menu(tracked.resolvedPath, {});
  assert.deepEqual(JSON.parse(JSON.stringify(updates[0])), { provider: 'codex', id: tracked.id });
  assert.equal(installs.length, 0, 'reviewing an update never opens the new-copy planner');
});

test('a late update response cannot overwrite a rescanned installation', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const begin = new Promise(resolve => { started = resolve; });
  const { ui } = await fixture([tracked], new Map(), async (url, options) => {
    if (!url.endsWith('/check-update')) return null;
    started(); await gate;
    return { ok: true, data: { results: options.body.skills.map(skill => ({ ok: true, ...skill, update: { ...tracked.origin, status: 'available' } })) } };
  });
  const checking = ui.checkUpdates();
  await begin;
  await ui.refresh();
  release(); await checking;
  assert.doesNotMatch(ui.content(), /Update available/);
});

test('batch failures remain attached to their own installation', async () => {
  const sibling = { ...tracked, id: 'second', name: 'second-skill', path: '/skills/second/SKILL.md', resolvedPath: '/skills/second/SKILL.md' };
  const { ui } = await fixture([tracked, sibling], new Map(), (url, options) => url.endsWith('/check-update') ? { ok: true, data: { results: options.body.skills.map(skill => skill.id === tracked.id
    ? { ok: true, ...skill, update: { ...tracked.origin, status: 'available' } }
    : { ok: false, ...skill, error: 'Installation changed' }) } } : null);
  await ui.checkUpdates();
  assert.match(ui.content(), /Update available/); assert.match(ui.content(), /Update check failed/); assert.match(ui.content(), /Installation changed/);
});

test('different repositories use separate requests', async () => {
  const sibling = { ...tracked, id: 'second', name: 'second-skill', path: '/skills/second/SKILL.md', resolvedPath: '/skills/second/SKILL.md', origin: { ...tracked.origin, source: 'org/other' } };
  const { ui, requests } = await fixture([tracked, sibling], new Map(), (url, options) => url.endsWith('/check-update') ? { ok: true, data: { results: options.body.skills.map(skill => ({ ok: true, ...skill, update: { status: 'current' } })) } } : null);
  await ui.checkUpdates();
  const checks = requests.filter(request => request.url.endsWith('/check-update'));
  assert.equal(checks.length, 2); assert.ok(checks.every(check => check.options.body.skills.length === 1));
});


test('layout, agent scope and bundled visibility are inline and persist without provider writes', async () => {
  const { ui, requests, storage } = await fixture();
  assert.equal(requests.filter(row => row.url === '/context/skills/hooks').length, 1);
  const count = requests.length;
  for (let index = 0; index < 3; index++) ui.activate(false);
  assert.equal(requests.length, count);
  // Cards by default, with an inline Cards/Table toggle and no View menu.
  assert.doesNotMatch(ui.content(), /skills\.view-menu|skills-view-menu/);
  assert.match(ui.content(), /data-key="skills-layout-cards"[^>]*aria-pressed="true"/);
  ui.layout('table');
  assert.equal(storage.get('t3-console-skill-view'), 'table');
  assert.match(ui.content(), /data-key="skills-layout-table"[^>]*aria-pressed="true"/);
  ui.layout('cards');
  assert.equal(storage.get('t3-console-skill-view'), 'cards');
  // Agent scope is an inline toggle that remembers its choice.
  ui.toggleAgents();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(storage.get('t3-console-skill-columns'), 'all');
  assert.match(ui.content(), /data-key="skills-agents-chip"[^>]*aria-pressed="true"/);
  ui.toggleAgents();
  assert.equal(storage.get('t3-console-skill-columns'), 'installed');
  // Bundled visibility is an inline chip that never writes provider settings.
  const before = requests.length;
  ui.toggleBundled();
  const content = ui.content();
  assert.doesNotMatch(content, /data-key="(?:phone-)?skill-[^\"]*system/);
  for (const name of ['My skill', 'Organization skill', 'Plugin skill']) assert.ok(content.includes(name));
  assert.match(content, /1 bundled skill is hidden/);
  assert.equal(requests.length, before);
  const restored = await fixture(skills, storage);
  assert.doesNotMatch(restored.ui.content(), /data-key="(?:phone-)?skill-[^\"]*system/);
  restored.ui.toggleBundled();
  assert.match(restored.ui.content(), /Bundled skill/);
  await ui.refresh();
  assert.equal(requests.filter(row => row.url === '/context/skills/hooks').length, 2);
});

test('Updates view keeps unchecked installations visible after a partial check and checks one installation on demand', async () => {
  const second = { ...tracked, id: 'other', name: 'Other skill', path: '/skills/other/SKILL.md', resolvedPath: '/skills/other/SKILL.md' };
  const { ui, requests } = await fixture([tracked, second], new Map(), (url, options) => url.endsWith('/check-update') ? { ok: true, data: { results: options.body.skills.map(row => ({ ...row, ok: true, update: { status: 'available', checkedAt: 1000 } })) } } : null);
  ui.show('updates'); assert.match(ui.content(), /Check 2 skills for updates/);
  await ui.checkOne(tracked.resolvedPath);
  const check = requests.find(row => row.url.endsWith('/check-update'));
  assert.equal(check.options.body.skills.length, 1);
  const content = ui.content();
  assert.match(content, /Not checked yet/); assert.match(content, /Review update/);
  assert.ok(content.indexOf('update-row-' + tracked.path) < content.indexOf('update-row-' + second.path));
  assert.doesNotMatch(content, /tc-sk-options|tc-mx-columns/);
});


test('hook discovery stays absent without Codex, and discovery failure leaves the library quiet', async () => {
  const absent = await fixture(skills, new Map(), null, ['cursor']);
  assert.equal(absent.requests.filter(row => row.url === '/context/skills/hooks').length, 0);
  assert.doesNotMatch(absent.ui.content(), /data-cmd="skills.hooks"/);
  const unavailable = await fixture(skills, new Map(), url => url === '/context/skills/hooks' ? { ok: false, error: 'unsupported native API' } : null);
  assert.doesNotMatch(unavailable.ui.content(), /waiting for review|unsupported native API/);
  assert.match(unavailable.ui.content(), /Codex plugin hooks…/);
});
