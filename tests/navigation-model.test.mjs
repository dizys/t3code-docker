// Shared host metadata must follow the page registry, and never contain SVG
// markup or runtime secrets. These contracts also exercise a future page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = path => readFileSync(new URL('../docker/setup/' + path, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const load = (pages = []) => {
  const context = vm.createContext({ URL, window: {}, document: { readyState: 'loading', addEventListener() {} }, navigator: {} });
  const routes = source('client/routes.js').replace('const PAGES = [', 'const PAGES = [' + pages.map(p => JSON.stringify(p) + ',').join(''));
  for (const code of [routes, source('client/model.js'), source('design/ui.js')]) vm.runInContext(code, context);
  return { R: vm.runInContext('T3Routes', context), M: vm.runInContext('T3Model', context), icons: context.window.T3C.icons };
};
const { R, M, icons } = load();

test('navigation projects the registry without leaking page or runtime details', () => {
  const status = { server: { ok: true, secret: 'not navigation' }, image: { version: 'v1.2.3', variant: 'browser' },
    storage: { disk: { usedPercent: 95 } }, publicUrl: 'https://fixture.example', setupKey: 'never sent' };
  const model = plain(M.navModel(status, null, null, 'devices'));
  assert.equal(model.current, 'access');
  assert.deepEqual(model.groups.map(g => [g.id, g.label, g.pages.map(p => p.route)]), plain(R.grouped().map(g => [g.id, g.label, g.pages.map(p => p.route)])));
  for (const g of model.groups) for (const p of g.pages) assert.deepEqual(Object.keys(p).sort(), ['badge', 'icon', 'route', 'title']);
  assert.deepEqual(model.status, { ok: true, text: 'Running', version: M.imageLabel(status.image).text });
  assert.equal(model.attention, M.attentionCount(status, null, null));
  assert.doesNotMatch(JSON.stringify(model), /secret|setupKey|never sent|fixture\.example/);
  assert.equal(M.navModel(null, null, null, 'more').current, null);
  assert.equal(M.navModel(null, null, null, 'unknown').current, null);
  assert.equal(M.navModel(null, null, null, null).status.text, 'Not answering');
});

test('every badge has one shared meaning and accessible sentence', () => {
  const badge = value => plain(M.navBadgeOf(value));
  assert.deepEqual(badge({ tone: 'warn', kind: 'live', count: 1 }), { kind: 'warn', count: 1, label: '1 thing needs you' });
  assert.equal(badge({ tone: 'warn', count: 2 }).label, '2 things need you');
  assert.equal(badge({ kind: 'running', count: 1 }).label, '1 install running');
  assert.equal(badge({ kind: 'live', count: 2 }).label, '2 ports published');
  assert.deepEqual(badge({ kind: 'count', count: 120 }), { kind: 'count', count: 120, label: '120 updates available' });
  for (const value of [null, {}, { kind: 'unknown', count: 1 }, { tone: 'warn', count: 0 }, { tone: 'warn', count: -1 }, { tone: 'warn', count: 1.5 }, { tone: 'warn', count: '2' }, { tone: 'warn', count: Infinity }]) assert.equal(badge(value), null);
});

test('icon data permits geometry only, with bounded values and inert fills', () => {
  const nodes = plain(M.iconNodes('<script>alert(1)</script><image href="bad"/><path d="M12 8V4H8" onload="bad" style="stroke:red"/><rect width="16" height="12" x="4" y="8" rx="2" fill="currentColor"/>'));
  assert.deepEqual(nodes, [['path', { d: 'M12 8V4H8' }], ['rect', { width: '16', height: '12', x: '4', y: '8', rx: '2', fill: 'currentColor' }]]);
  for (const fill of ['red', 'url(bad)', 'javascript:bad', '']) assert.deepEqual(plain(M.iconNodes(`<circle r="2" fill="${fill}"/>`)), [['circle', { r: '2' }]]);
  assert.deepEqual(plain(M.iconNodes("<ellipse cx='12' cy='5' rx='9' ry='3' fill='none'/>")), [['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3', fill: 'none' }]]);
  assert.deepEqual(plain(M.iconNodes('<path d="url(bad)"/><path d="' + '1'.repeat(2001) + '"/>')), [['path', {}], ['path', {}]]);
  assert.deepEqual(plain(M.iconNodes(null)), []);
  assert.deepEqual(plain(M.iconNodes(' '.repeat(65537))), []);
});

test('registry routes, renderers, shortcuts, groups, aliases and icons agree', () => {
  const renderers = source('app.js').match(/const PAGES = \{([\s\S]*?)\n  \};/)[1];
  const keys = new Set(), routes = new Set();
  for (const p of R.PAGES) {
    assert.match(renderers, new RegExp('\\b' + p.route + ':'));
    assert(!routes.has(p.route)); routes.add(p.route);
    assert(p.key && !keys.has(p.key)); keys.add(p.key);
    assert(R.GROUPS.some(g => g.id === p.group));
    assert(Object.hasOwn(icons, p.icon), p.icon);
    assert(M.iconNodes(icons[p.icon]).length > 0, p.icon);
  }
  for (const target of Object.values(R.ALIASES)) assert(routes.has(target));
  assert.deepEqual(Object.keys(M.navIcons(icons)).sort(), [...new Set(R.PAGES.map(p => p.icon))].sort());
});

test('native palette metadata preserves existing commands and includes every page', () => {
  const legacy = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../docker/t3-client/setup-bridge.js', import.meta.url), 'utf8'), legacy);
  const entries = plain(R.paletteEntries());
  for (const old of legacy.T3SetupBridge.PALETTE_ITEMS) {
    const entry = entries.find(p => p.id === old.id);
    assert(entry, old.id);
    for (const key of ['route', 'title', 'meta']) assert.equal(entry[key], old[key], key + ' for ' + old.id);
    assert.deepEqual(entry.terms, plain(old.terms || []));
  }
  assert.equal(entries.length, R.PAGES.length + 1);
  assert.equal(new Set(entries.map(p => p.id)).size, entries.length);
  for (const p of R.PAGES) assert(entries.some(entry => entry.route === p.route));
  for (const entry of entries) {
    assert.equal(typeof entry.id, 'string'); assert.equal(typeof entry.title, 'string');
    assert.equal(typeof entry.meta, 'string'); assert(Array.isArray(entry.terms));
    assert(entry.terms.every(term => typeof term === 'string'));
  }
});

test('a future page follows the registry into metadata and empty groups disappear', () => {
  const { R, M, icons } = load([{ route: 'backups', title: 'Backups', icon: 'hard-drive', key: 'b', group: 'system', summary: 'Restore saved work.', doc: 'backups.md' },
    { route: 'internal', title: 'Internal', icon: 'folder', key: 'z', group: 'system', summary: 'Internal tools.', doc: 'internal.md', palette: false }]);
  R.GROUPS.push({ id: 'empty', label: 'Empty' });
  const model = plain(M.navModel(null, null, null, 'backups'));
  assert.equal(model.current, 'backups'); assert(!model.groups.some(g => g.id === 'empty'));
  assert.deepEqual(model.groups.find(g => g.id === 'system').pages[0], { route: 'backups', title: 'Backups', icon: 'hard-drive', badge: null });
  const entry = plain(R.paletteEntries()).find(p => p.route === 'backups');
  assert.deepEqual(entry, { id: 'backups', route: 'backups', title: 'Backups', meta: 'Setup · restore saved work', terms: [], icon: 'hard-drive' });
  assert(!R.paletteEntries().some(p => p.route === 'internal'));
  assert(M.navIcons(icons)['hard-drive'].length > 0);
});
