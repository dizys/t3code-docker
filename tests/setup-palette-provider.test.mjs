import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { clientSource } from '../docker/runtime/patches/setup-palette.mjs';

// Execute the provider itself. React DOM and native matching/virtualization
// are exercised by setup-bridge-audit.js against the compiled native client.
const javascript = stripTypeScriptTypes(clientSource)
  .replace(/^import .+;\n/gm, '')
  .replace('export function useSetupPaletteActions', 'function useSetupPaletteActions')
  + '\nglobalThis.provider={useSetupPaletteActions,getSnapshot,subscribe};';
function load() {
  const window = new EventTarget();
  const context = vm.createContext({ window, Event, CustomEvent, SettingsIcon: 'settings-icon',
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  });
  vm.runInContext(javascript, context);
  return { window, ...context.provider };
}
const plain = value => JSON.parse(JSON.stringify(value));
const item = (id, changes = {}) => ({ id, title: id === 'setup' ? 'Open setup' : 'Files', meta: 'Setup · projects and disk use', terms: ['workspace'], icon: 'folder', ...changes });
const snapshot = (items = [item('setup'), item('files')]) => ({ protocol: 1, items, icons: { folder: [['path', { d: 'M2 4h20v16H2z' }]] } });

test('an absent bridge contributes no commands and the native capability is discoverable', () => {
  const p = load();
  assert.equal(p.window.__T3_SETUP_PALETTE_NATIVE__, 1);
  assert.equal(p.useSetupPaletteActions('files', async () => {}).length, 0);
  assert.equal(p.getSnapshot(), p.getSnapshot(), 'Unchanged snapshots must keep identity');
});

test('native actions have stable IDs, ordinary searchable metadata and one root-browse entry', () => {
  const p = load(); p.window.__T3_SETUP_PALETTE_SNAPSHOT__ = snapshot();
  const commands = p.useSetupPaletteActions('files', async () => {});
  assert.deepEqual(commands.map(action => action.value).join(','), 't3-setup:setup,t3-setup:files');
  assert.equal(commands[1].title, 'Files');
  assert.equal(commands[1].description, 'Setup · projects and disk use');
  assert.deepEqual(plain(commands[1].searchTerms), ['Files', 'Setup Files', 'workspace', 'Setup · projects and disk use']);
  assert.equal(commands[1].icon.children[0].tag, 'svg');
  assert.equal(p.useSetupPaletteActions('  ', async () => {}).length, 1);
  assert.equal(p.useSetupPaletteActions('>', async () => {}).length, 2);
  const before = p.getSnapshot();
  assert.equal(p.getSnapshot(), before);
  p.window.__T3_SETUP_PALETTE_SNAPSHOT__ = snapshot([item('setup')]);
  assert.notEqual(p.getSnapshot(), before);
  assert.equal(p.useSetupPaletteActions('files', async () => {}).length, 1, 'Removed commands leave the native model');
});

test('malformed or duplicate metadata is rejected and SVGs cannot carry executable content', () => {
  const p = load();
  for (const value of [null, { ...snapshot(), protocol: 2 }, { ...snapshot(), icons: [] },
    snapshot([item('files'), item('files')]), snapshot([item('https://evil.test')]),
    snapshot([item('files', { title: '' })]), snapshot([item('files', { title: 'x\n' })]),
    snapshot([item('files', { terms: ['x'.repeat(201)] })]), snapshot([item('files', { terms: Array(26).fill('x') })]),
    snapshot(Array.from({length:102}, (_,i) => item('item-'+i))),
  ]) {
    p.window.__T3_SETUP_PALETTE_SNAPSHOT__ = value;
    assert.equal(p.getSnapshot().length, 0);
  }
  for (const nodes of [[['script', {}]], [['path', { onclick: 'alert' }]], [['path', { fill: 'url(https://evil.test)' }]]]) {
    p.window.__T3_SETUP_PALETTE_SNAPSHOT__ = { ...snapshot([item('files')]), icons: { folder: nodes } };
    assert.equal(p.useSetupPaletteActions('files', async () => {})[0].icon.children[0].tag, 'settings-icon');
  }
});

test('native navigation requires bridge acknowledgement and precedes the Setup open handoff', async () => {
  const p = load(), order = [];
  p.window.__T3_SETUP_PALETTE_SNAPSHOT__ = snapshot();
  const command = p.useSetupPaletteActions('files', async () => { order.push('native-settings'); }).find(action => action.value === 't3-setup:files');
  p.window.addEventListener('t3-setup-palette:open', event => { order.push('open:'+event.detail.id); });
  await command.run();
  assert.deepEqual(order, [], 'A stale or unpaired command cannot navigate');
  p.window.addEventListener('t3-setup-palette:request', event => { if (event.detail.protocol === 1 && event.detail.id === 'files') event.preventDefault(); });
  await command.run();
  assert.deepEqual(order, ['native-settings', 'open:files']);
});

test('metadata subscriptions are removed when the native palette unmounts', () => {
  const p = load(); let changed = 0;
  const unsubscribe = p.subscribe(() => { changed++; });
  p.window.dispatchEvent(new Event('t3-setup-palette:changed'));assert.equal(changed, 1);
  unsubscribe();p.window.dispatchEvent(new Event('t3-setup-palette:changed'));assert.equal(changed, 1);
});
