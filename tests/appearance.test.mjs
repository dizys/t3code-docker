import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadAssets, contentSecurityPolicy, renderConsole } from '../docker/setup/page.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const context = vm.createContext({ CSS: { supports: (_property, value) => value !== 'unsupported' } });
vm.runInContext(read('../docker/setup/client/appearance.js'), context);
const A = vm.runInContext('T3Appearance', context);
const bridge = vm.createContext({});
vm.runInContext(read('../docker/t3-client/setup-bridge.js'), bridge);
const B = bridge.T3SetupBridge;
const fixture = JSON.parse(read('./fixtures/native-appearance.json'));
const supports = () => true;
const plain = value => JSON.parse(JSON.stringify(value));
const palette = overrides => ({ version: 1, colors: { background: '#000', primary: '#346bf1', accent: '#141414', ...overrides } });

test('the bridge and console agree on every transported color role', () => {
  assert.deepEqual([...new Set(Object.values(A.COLORS))].sort(), [...B.APPEARANCE_COLORS].sort());
  assert.notEqual(A.COLORS['--accent'], A.COLORS['--hover'], 'native accent is a surface, primary is an action');
});

test('native primary, neutral selection and semantic feedback retain separate meanings', () => {
  const result = A.normalize(palette({ warning: '#fe9a00', 'warning-foreground': '#bb4d00', destructive: '#fb414a' }), supports);
  assert.equal(result.properties['--accent'], '#346bf1');
  assert.equal(result.properties['--hover'], '#141414');
  assert.equal(result.properties['--warn'], '#fe9a00');
  assert.equal(result.properties['--warn-text'], '#bb4d00');
  assert.equal(result.properties['--danger'], '#fb414a');
});

test('native appearance reads adjusted contrast and falls back to older host variables', () => {
  const values = { '--foreground': '#aaa', '--contrast-foreground': '#fff', '--background': '#000', '--font-sans': 'Inter, sans-serif', '-webkit-font-smoothing': 'auto' };
  const result = B.appearanceFromStyles({ fontSize: '18px', getPropertyValue: key => values[key] || '' });
  assert.equal(result.colors.foreground, '#fff');
  assert.equal(result.colors.background, '#000');
  assert.equal(result.fonts.sans, 'Inter, sans-serif');
  assert.equal(result.fonts.smoothing, 'auto');
  assert.equal(result.fontSize, '18px');
  assert(!Object.hasOwn(result.colors, 'primary'), 'missing roles use the console default');
  const primary = B.appearanceFromStyles({ fontSize: '16px', getPropertyValue: key => ({ '--primary': '#123456', '--contrast-primary': '#ffffff' })[key] || '' });
  assert.equal(primary.colors.primary, '#123456', 'native primary does not use the text contrast adjustment');
});

test('malformed protocols and arrays never become appearance declarations', () => {
  for (const value of [null, [], '', 1, { version: 2, colors: {} }, { version: 1, colors: [] }, { version: 1 }]) assert.equal(A.normalize(value, supports), null);
});

test('CSS injection, unresolved references, URLs, oversized values and unknown properties are rejected', () => {
  for (const value of ['red; background:url(https://example.com)', 'url(https://example.com)', 'var(--foreign)', 'env(foreign)', '<style>', 'x'.repeat(513)]) {
    assert(!Object.hasOwn(A.normalize(palette({ primary: value }), supports).properties, '--accent'));
  }
  const result = A.normalize({ version: 1, colors: { ...palette().colors, position: 'fixed', '--evil': 'red' } }, supports);
  assert(!Object.hasOwn(result.properties, 'position'));
  assert(!Object.hasOwn(result.properties, '--evil'));
  const inherited = Object.create({ primary: 'red' });
  assert(!Object.hasOwn(A.normalize({ version: 1, colors: inherited }, supports).properties, '--accent'));
  assert(!Object.hasOwn(A.normalize(palette({ primary: 'unsupported' }), () => false).properties, '--accent'));
});

test('font families, smoothing and geometry have bounded independent validation', () => {
  const result = A.normalize({ ...palette(), fonts: { sans: 'Inter, system-ui', mono: 'Menlo, monospace', smoothing: 'auto' }, fontSize: '18px', radius: '0.5rem' }, supports);
  assert.equal(result.properties['--font-sans'], 'Inter, system-ui');
  assert.equal(result.properties['--font-mono'], 'Menlo, monospace');
  assert.equal(result.properties['--font-smoothing'], 'auto');
  assert.equal(result.properties['--control-radius'], '0.5rem');
  assert.equal(result.fontSize, '18px');
  assert.equal(A.normalize({ ...palette(), radius: '.75rem' }, supports).properties['--control-radius'], '.75rem');
  for (const size of ['0px', '21px', '100%', '18px; color:red', 18, null]) assert.equal(A.normalize({ ...palette(), fontSize: size }, supports).fontSize, null);
  for (const radius of ['999px', '3rem', '-2px', '50%', 'var(--other)']) assert(!Object.hasOwn(A.normalize({ ...palette(), radius }, supports).properties, '--control-radius'));
});

test('switching palettes and legacy fallback clear owned styles without disturbing unrelated properties', () => {
  const values = new Map([['--unrelated', 'preserved']]);
  const style = { setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key),
    set fontSize(value) { values.set('font-size', value); } };
  const root = { style };
  assert(A.apply(root, { ...palette({ sidebar: '#111' }), fontSize: '18px' }));
  assert.equal(values.get('--sidebar'), '#111');
  assert.equal(values.get('font-size'), '18px');
  assert(A.apply(root, palette()));
  assert(!values.has('--sidebar'));
  assert(!values.has('font-size'));
  assert.equal(A.apply(root, { version: 9 }), false);
  assert.equal(values.get('--bg'), '#000');
  A.clear(root);
  assert.deepEqual([...values], [['--unrelated', 'preserved']]);
});

test('both measured native themes can be transported with their complete color roles', () => {
  for (const theme of ['light', 'dark']) {
    const colors = fixture[theme];
    const payload = B.appearanceFromStyles({ fontSize: '16px', getPropertyValue: name => colors[name.replace(/^--/, '')] || '' });
    const result = plain(A.normalize(payload, supports));
    assert.equal(result.properties['--bg'], colors.background);
    assert.equal(result.properties['--fg-muted'], colors['muted-foreground']);
    assert.equal(result.properties['--sidebar'], colors.sidebar);
    assert.equal(result.fontSize, '16px');
  }
});

test('Inter is inline, licensed and available to both console and unlock pages without network access', () => {
  const assets = loadAssets();
  assert.match(assets.css, /@font-face\{font-family:"Inter Variable"/);
  assert.match(assets.css, /src:url\(data:font\/woff2;base64,/);
  assert.match(read('../docker/setup/design/fonts/OFL.txt'), /SIL OPEN FONT LICENSE/);
  assert.match(contentSecurityPolicy('test'), /font-src data:/);
  assert.doesNotMatch(contentSecurityPolicy('test'), /font-src[^;]*(?:https?:|\*)/);
  for (const list of [assets.console, assets.unlock]) assert(list.some(script => script.path === 'client/appearance.js'));
  const page = renderConsole({ assets, nonce: 'test', mount: '/__setup', embed: true });
  assert.match(page, /aria-label="Breadcrumb"/);
  assert.match(page, /id="current-page" aria-current="page"/);
});
