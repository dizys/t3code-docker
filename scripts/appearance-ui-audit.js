#!/usr/bin/env node
// Compare real rendered Setup roles with the pinned native T3 reference.
// API data is intercepted; this audit cannot change real settings or files.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');

// Called by setup-bridge-audit while the actual native T3 modal is open.
async function nativeAppearance({ page, frame, expect, output }) {
  const roles = await frame.evaluate(() => T3Appearance.COLORS);
  const original = await page.evaluate(() => document.documentElement.getAttribute('style'));
  const check = async label => {
    const expected = await page.evaluate(roles => {
      const s = getComputedStyle(document.documentElement), colors = {};
      const adjusted = new Set(['foreground', 'muted-foreground', 'placeholder', 'border', 'input', 'sidebar-foreground', 'sidebar-muted-foreground', 'sidebar-border']);
      for (const [token, role] of Object.entries(roles)) {
        const value = (adjusted.has(role) && s.getPropertyValue('--contrast-' + role).trim()) || s.getPropertyValue('--' + role).trim();
        if (value && CSS.supports('color', value)) colors[token] = value;
      }
      return { colors, fontSize: s.fontSize, font: s.getPropertyValue('--font-sans').trim() };
    }, roles);
    await frame.waitForFunction(expected => {
      const s = getComputedStyle(document.documentElement);
      return s.fontSize === expected.fontSize && Object.entries(expected.colors).every(([key, value]) => s.getPropertyValue(key).trim() === value);
    }, expected, { timeout: 5000 });
    expect(true, label + ': every available native semantic role and interface size reaches Setup');
  };
  const send = async message => page.evaluate(message => {
    document.querySelector('.t3-setup-frame').contentWindow.postMessage(message, location.origin);
  }, { source: 't3-code', type: 'theme', theme: 'light', ...message });
  try {
    await check('Initial appearance');
    await frame.evaluate(() => { location.hash = 'access'; });
    await frame.locator('#pair-label').fill('Keep this unsaved draft');
    await frame.locator('#pair-label').evaluate(input => { window.__appearanceDraft = input; input.setSelectionRange(5, 9); });
    await page.evaluate(() => {
      window.__appearanceMessages = [];
      document.querySelector('.t3-setup-frame').contentWindow.addEventListener('message', e => {
        if (e.source === window && e.data?.type === 'theme') window.__appearanceMessages.push(e.data);
      });
      document.documentElement.style.setProperty('--appearance-init-check', '1');
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => window.__appearanceMessages.length) === 0, 'the first unrelated root mutation does not repeat the initial appearance');
    await page.evaluate(() => {
      const r = document.documentElement;
      // A same-mode custom palette changes colors without changing .dark.
      r.style.setProperty('--primary', 'oklch(60% .16 330)');
      r.style.setProperty('--contrast-muted-foreground', 'oklch(65% .02 330)');
      r.style.setProperty('--background', 'oklch(20% .02 330)');
      r.style.setProperty('--card', 'oklch(24% .02 330)');
      r.style.setProperty('--sidebar', 'oklch(18% .02 330)');
      r.style.setProperty('--sidebar-row-selected', 'oklch(30% .03 330)');
      r.style.setProperty('--font-sans', '"Liberation Sans", sans-serif');
      r.style.setProperty('--font-mono', '"Liberation Mono", monospace');
      r.style.setProperty('-webkit-font-smoothing', 'auto');
      r.style.setProperty('--control-radius', '.75rem');
      r.style.fontSize = '20px';
    });
    await check('Live palette, contrast and typography');
    const draft = await frame.evaluate(() => ({ same: document.getElementById('pair-label') === window.__appearanceDraft,
      focused: document.activeElement === window.__appearanceDraft, value: window.__appearanceDraft.value,
      selection: [window.__appearanceDraft.selectionStart, window.__appearanceDraft.selectionEnd],
      bodyFont: getComputedStyle(document.body).fontFamily, radius: getComputedStyle(document.querySelector('#page-access .tc-btn')).borderRadius,
      width: document.documentElement.scrollWidth <= innerWidth + 1 }));
    expect(draft.same && draft.focused && draft.value === 'Keep this unsaved draft' && draft.selection.join() === '5,9',
      'palette-only updates preserve the form node, draft, focus and text selection', JSON.stringify(draft));
    expect(draft.bodyFont.includes('Liberation Sans') && draft.radius === '15px' && draft.width, 'custom native fonts and 20px scaling do not overflow the embedded console', JSON.stringify(draft));
    expect(await page.evaluate(() => window.__appearanceMessages.length) === 1, 'one root mutation batch sends one appearance snapshot');
    await page.evaluate(() => document.documentElement.style.setProperty('--unrelated-audit', '1'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => window.__appearanceMessages.length) === 1, 'unrelated root style changes do not resend appearance');
    if (output) await page.screenshot({ path: path.join(output, 'appearance-custom.png'), animations: 'disabled' });

    const retained = await frame.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));
    await frame.evaluate(() => window.postMessage({ source: 't3-code', type: 'theme', theme: 'light', appearance: { version: 1, colors: { primary: 'red' } } }, location.origin));
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { source: parent, origin: 'https://untrusted.invalid', data: { source: 't3-code', type: 'theme', theme: 'light', appearance: { version: 1, colors: { primary: 'red' } } } })));
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    expect(await frame.evaluate(() => document.documentElement.style.getPropertyValue('--accent')) === retained,
      'messages from the frame itself or a foreign origin cannot change appearance');
    await send({ appearance: { version: 1, colors: { primary: 'url(https://untrusted.invalid/x)', background: '#fff', position: 'fixed' }, fontSize: '999px' } });
    await frame.waitForFunction(() => document.documentElement.style.getPropertyValue('--bg') === '#fff');
    expect(await frame.evaluate(() => !document.documentElement.style.getPropertyValue('--accent') && !document.documentElement.style.fontSize),
      'malformed CSS values use safe defaults rather than arbitrary styles');
    await send({ appearance: undefined });
    await frame.waitForFunction(() => !document.documentElement.style.getPropertyValue('--bg'));
    expect(await frame.evaluate(() => getComputedStyle(document.documentElement).fontSize === '16px'), 'older theme-only hosts clear stale palette and font overrides');
  } finally {
    await page.evaluate(original => { if (original === null) document.documentElement.removeAttribute('style'); else document.documentElement.setAttribute('style', original); }, original);
    await check('Restored native appearance');
    await frame.locator('#pair-label').fill('');
    await frame.evaluate(() => { location.hash = 'overview'; });
  }
}

async function standalone() {
  const { statusFor, portsFor, routeConsole, framed, unlock, visit } = require('./lib/console-fixtures.cjs');
  const fixture = require('../tests/fixtures/native-appearance.json');
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
  const base = process.argv[2] || 'http://127.0.0.1:23780/__setup/', key = process.argv[3] || 'dev';
  const output = process.env.T3_APPEARANCE_UI_OUTPUT || '/tmp/t3-appearance-ui-audit';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const width of (process.env.T3_APPEARANCE_UI_SCALED_ONLY ? [] : [360, 820, 1440])) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.resourceType() === 'font') requests.push(request.url()); });
      await page.addInitScript(theme => localStorage.setItem('t3-console-theme', theme), theme);
      await routeConsole(page, { status: () => statusFor('ready'), ports: () => portsFor('ready') });
      await page.goto(base); await unlock(page, key); await visit(page, page, 'agents');
      const roles = await page.evaluate(() => T3Appearance.COLORS);
      const comparison = await page.evaluate(({ roles, expected }) => {
        const root = getComputedStyle(document.documentElement), probe = document.createElement('span');
        document.body.appendChild(probe);
        const normalized = value => { probe.style.color = ''; probe.style.color = value; return getComputedStyle(probe).color; };
        const differences = Object.entries(roles).filter(([, role]) => expected[role]).flatMap(([token, role]) => {
          const actual = root.getPropertyValue(token).trim(), want = expected[role];
          return normalized(actual) === normalized(want) ? [] : [{ token, actual, expected: want }];
        });
        probe.remove();
        return { differences, inline: document.documentElement.style.length, font: document.fonts.check('14px "Inter Variable"'),
          fontLoaded: [...document.fonts].some(font => font.family === 'Inter Variable' && font.status === 'loaded'),
          sidebar: getComputedStyle(document.querySelector('.tc-sidebar')).backgroundImage,
          sidebarWidth: document.querySelector('.tc-sidebar').getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          breadcrumb: document.getElementById('current-page').textContent,
          guide: document.getElementById('page-guide').href };
      }, { roles, expected: fixture[theme] });
      assert.deepEqual(comparison.differences, [], `${width}/${theme}: native role parity`);
      assert(comparison.font && comparison.fontLoaded, 'the real inline Inter font loads');
      assert(!comparison.overflow && comparison.sidebar === 'none', JSON.stringify(comparison));
      assert.equal(comparison.breadcrumb, 'Agents'); assert(comparison.guide.includes('/v0.20.0/'), comparison.guide);
      if (width >= 1024) assert.equal(comparison.sidebarWidth, 240);
      assert(requests.every(url => url.startsWith('data:')), 'fonts never need an external request');
      await visit(page, page, 'access');
      const input = page.locator('#pair-label'); await input.fill('Appearance draft'); await input.focus();
      assert((await input.evaluate(el => getComputedStyle(el).boxShadow)).includes('inset'), 'input focus stays inside its frame');
      await page.emulateMedia({ forcedColors: 'active' });
      assert.equal(await input.evaluate(el => getComputedStyle(el).outlineStyle), 'solid', 'system focus survives forced colors');
      await page.emulateMedia({ forcedColors: 'none' });
      await page.screenshot({ path: path.join(output, `${width}-${theme}.png`), animations: 'disabled' });
      assert.deepEqual(errors, []); await context.close(); console.log(`ok ${width}/${theme}: native roles, fonts, shell, focus and forced colors`);
    }
    for (const width of (process.env.T3_APPEARANCE_UI_WIDTHS?.split(',').map(Number) || [360, 820, 1198])) for (const fontSize of (process.env.T3_APPEARANCE_UI_SIZES?.split(',') || ['12px', '20px'])) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 640, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await routeConsole(page, { status: () => statusFor('skills'), ports: () => portsFor('ready') });
      const target = await framed(page, base + '?embed=t3&theme=dark'); await unlock(target, key);
      await target.locator('#page-overview .tc-page-head').waitFor();
      await page.evaluate(fontSize => document.querySelector('iframe').contentWindow.postMessage({ source: 't3-code', type: 'theme', theme: 'dark',
        appearance: { version: 1, colors: {}, fonts: { sans: '"Liberation Mono", monospace' }, fontSize } }, location.origin), fontSize);
      await target.waitForFunction(size => getComputedStyle(document.documentElement).fontSize === size, fontSize);
      for (const route of ['agents', 'access', 'instructions/skills', 'mcp', 'files', 'storage']) {
        await visit(target, page, route);
        const findings = await target.evaluate(() => {
          const findings = [];
          if (document.documentElement.scrollWidth > innerWidth + 1) findings.push('page overflow');
          for (const el of document.querySelectorAll('.tc-mx-agent-name')) if (el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 1) findings.push('clipped agent heading: ' + el.textContent);
          for (const el of document.querySelectorAll('.tc-tab')) if (el.getBoundingClientRect().height && el.getBoundingClientRect().height < 44) findings.push('small primary touch target');
          return findings;
        });
        if (findings.length) {
          await page.screenshot({ path: path.join(output, `${width}-${fontSize}-failure.png`), fullPage: true });
          console.error(await target.evaluate(() => [...document.querySelectorAll('#main *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && el.getBoundingClientRect().width).slice(0, 18).map(el => ({ cls: el.className, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right, overflow: getComputedStyle(el).overflowX }))));
        }
        assert.deepEqual(findings, [], `${width}/${fontSize}/${route}`);
        if (width === 1198 && fontSize === '20px' && route === 'instructions/skills') await page.screenshot({ path: path.join(output, '1198-20px-skills.png'), animations: 'disabled' });
      }
      if (width === 360) {
        const hit = await target.locator('.tc-btn').first().evaluate(el => { const s = getComputedStyle(el, '::after'); return [s.minWidth, s.minHeight]; });
        assert.deepEqual(hit, ['44px', '44px'], 'coarse pointer targets retain physical minimum size');
      }
      await page.screenshot({ path: path.join(output, `${width}-${fontSize}-scaled.png`), animations: 'disabled' });
      assert.deepEqual(errors, []); await context.close(); console.log(`ok ${width}/${fontSize}: six management surfaces, wide custom font, matrix labels and touch targets`);
    }
  } finally { await browser.close(); }
}
module.exports = { nativeAppearance };
if (require.main === module) standalone().catch(error => { console.error(error); process.exitCode = 1; });
