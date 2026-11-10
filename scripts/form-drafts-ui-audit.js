#!/usr/bin/env node
// Drafts, focus and selection across real console refreshes. Status and pairing
// responses are intercepted; this audit never creates a real pairing link.
// Usage: node scripts/form-drafts-ui-audit.js <console-url> <setup-key>
const assert = require('node:assert/strict');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }

const base = new URL(process.argv[2] || 'http://127.0.0.1:23780/__setup/');
if (!base.pathname.endsWith('/')) base.pathname += '/';
const key = process.argv[3] || 'dev';
const draft = '  Desk <draft> & "iPhone"  ';
const selection = [5, 12, 'backward'];
// Refresh notices sit above sections or an Access tabpanel containing them.
const pageNotices = '.tc-page:not([hidden]) > .tc-notice:has(~ .tc-section, ~ [role="tabpanel"])';
const runs = [
  { width: 1440, embedded: false, fallback: false },
  { width: 1198, embedded: true, fallback: true },
  { width: 390, embedded: false, fallback: true },
  { width: 390, embedded: true, fallback: false },
];

(async () => {
  const initial = await fetch(new URL('status', base), { headers: { 'x-t3-setup-key': key } });
  assert.equal(initial.status, 200, 'console must accept the supplied setup key');
  const fixture = await initial.json();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const run of runs) {
      const page = await browser.newPage({ viewport: { width: run.width, height: 900 } });
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      // A device list that could not be read puts up a notice; a fresh one takes it down.
      let readFailed = true, unavailable = false, failPairing = true;
      const submitted = [];
      const status = {
        ...fixture, publicUrl: 'https://t3.example.test', publicUrlSource: 'saved', degraded: [],
        setup: { state: 'finished', items: [] }, operations: {}, sessions: [], pairings: [],
        packages: Array.from({ length: 7 }, (_, i) => ({ id: 'npm:tool-' + i, name: 'tool-' + i, bins: ['tool-' + i], installed: true, installedVersion: '1.0.0' })),
      };
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname === new URL('status', base).pathname) {
          return route.fulfill({ status: unavailable ? 503 : 200, json: unavailable ? { error: 'Temporary status failure' } : {
            ...status, authLists: Object.fromEntries(['pairing', 'session'].map(name => [name, { at: Date.now(), available: true, stale: readFailed, refreshing: false, error: readFailed ? 'T3 Code did not answer' : null }])),
          } });
        }
        if (url.pathname === new URL('pair', base).pathname && request.method() === 'POST') {
          submitted.push(request.postDataJSON());
          return route.fulfill({ status: failPairing ? 503 : 200, json: failPairing
            ? { ok: false, error: 'Temporary pairing failure' }
            : { id: 'draft-test', pairUrl: 'https://t3.example.test/pair#token=fixture', expiresAt: new Date(Date.now() + 3600000).toISOString() } });
        }
        // Only the unlock form may write to the service; all other mutations
        // in this audit must have an explicit intercepted response above.
        if (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== new URL('login', base).pathname) {
          errors.push('Unexpected mutation: ' + request.method() + ' ' + url.pathname);
          return route.abort();
        }
        return route.continue();
      });
      const url = new URL(base); url.hash = 'access';
      await page.goto(url.href);
      if (await page.getByLabel('Setup key', { exact: true }).isVisible()) {
        await page.getByLabel('Setup key', { exact: true }).fill(key);
        await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      }
      await page.locator('#pair-label').waitFor();
      let ui = page;
      if (run.embedded) {
        url.searchParams.set('embed', 't3');
        const host = new URL('__form-drafts-host', base).href;
        await page.route(host, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe src="' + url.href + '"></iframe>' }));
        await page.goto(host);
        ui = await (await page.waitForSelector('iframe')).contentFrame();
        await ui.locator('#pair-label').waitFor();
      }
      if (run.fallback) await ui.evaluate(() => { Element.prototype.moveBefore = undefined; });
      await ui.locator(pageNotices).waitFor();
      const refresh = async notices => {
        const response = page.waitForResponse(r => new URL(r.url()).pathname === new URL('status', base).pathname);
        await ui.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await response;
        try {
          await ui.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count, { selector: pageNotices, count: notices });
        } catch (error) {
          const shown = await ui.locator(pageNotices).allTextContents();
          throw new Error('Expected ' + notices + ' page notices; saw ' + JSON.stringify(shown), { cause: error });
        }
        await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      const checkDraft = async focused => {
        const actual = await ui.evaluate(() => {
          const input = document.querySelector('#pair-label');
          return { value: input.value, sameNode: input === window.draftInput, focused: document.activeElement === input,
            sameTabs: document.querySelector('#page-access [role="tablist"]') === window.draftTabs,
            samePanel: document.querySelector('#access-tabpanel') === window.draftPanel,
            selection: [input.selectionStart, input.selectionEnd, input.selectionDirection] };
        });
        assert.equal(actual.value, draft, 'refresh must retain the unsaved label');
        assert.equal(actual.sameNode, true, 'the form must survive changes to page notices');
        assert.equal(actual.sameTabs, true, 'refresh must retain the Access tab controls');
        assert.equal(actual.samePanel, true, 'refresh must retain the active Access panel');
        assert.equal(actual.focused, focused, 'refresh must preserve the current focus');
        if (focused) assert.deepEqual(actual.selection, selection, 'refresh must preserve the editing selection');
      };

      await ui.locator('#pair-label').fill(draft);
      await ui.evaluate(range => {
        window.draftInput = document.querySelector('#pair-label');
        window.draftTabs = document.querySelector('#page-access [role="tablist"]');
        window.draftPanel = document.querySelector('#access-tabpanel');
        window.draftInput.setSelectionRange(...range);
      }, selection);
      readFailed = false; await refresh(0); await checkDraft(true);
      readFailed = true; await refresh(1); await checkDraft(true);
      await ui.locator('[data-cmd="pair.ttl"][data-value="7d"]').click();
      readFailed = false; await refresh(0); await checkDraft(false);
      assert.equal(await ui.evaluate(() => document.activeElement.dataset.value), '7d', 'a refresh must retain focus on an unkeyed button too');
      unavailable = true; await refresh(1); await checkDraft(false);
      unavailable = false; await refresh(0); await checkDraft(false);

      // The same notice transition must preserve another page's form input.
      await ui.evaluate(() => { location.hash = 'toolchains'; });
      await ui.locator('#tool-filter').fill('tool-2');
      unavailable = true; await refresh(1);
      unavailable = false; await refresh(0);
      assert.equal(await ui.locator('#tool-filter').inputValue(), 'tool-2');
      await ui.evaluate(() => { location.hash = 'access'; });
      assert.equal(await ui.locator('#pair-label').inputValue(), draft, 'navigation must retain the pairing draft');

      await ui.locator('[data-cmd="pair.start"]').click();
      await ui.getByText('Temporary pairing failure', { exact: true }).waitFor();
      assert.equal(await ui.locator('#pair-label').inputValue(), draft, 'a failed submission must retain the draft');
      assert.deepEqual(submitted[0], { ttl: '7d', label: draft.trim() });
      failPairing = false;
      await ui.locator('[data-cmd="pair.start"]').click();
      await ui.locator('[data-cmd="pair.new"]').waitFor();
      assert.deepEqual(submitted[1], submitted[0], 'retry must submit the same label and lifetime');
      await ui.locator('[data-cmd="pair.new"]').click();
      assert.equal(await ui.locator('#pair-label').inputValue(), '', 'only a successful submission clears the draft');
      assert.equal(await ui.locator('[data-cmd="pair.ttl"][data-value="7d"]').getAttribute('aria-pressed'), 'true');

      // Every Access panel must keep its tabs and keyboard focus through the
      // same notice transitions, even when it has no pairing form.
      for (const name of ['Connections', 'SSH', 'Devices']) {
        const tab = ui.getByRole('tab', { name, exact: true });
        await tab.click();
        await ui.getByRole('tabpanel', { name, exact: true }).waitFor();
        await tab.focus();
        await ui.evaluate(() => {
          window.refreshTab = document.activeElement;
          window.refreshPanel = document.querySelector('#access-tabpanel');
        });
        for (const stale of [true, false]) {
          readFailed = stale; await refresh(stale ? 1 : 0);
          const actual = await ui.evaluate(() => ({
            sameTab: document.querySelector('#page-access [role="tab"][aria-selected="true"]') === window.refreshTab,
            focused: document.activeElement === window.refreshTab,
            samePanel: document.querySelector('#access-tabpanel') === window.refreshPanel,
          }));
          assert.deepEqual(actual, { sameTab: true, focused: true, samePanel: true }, name + ': notices must preserve the panel and tab focus');
        }
      }

      // Shared patching also protects DOM-owned passwords and textareas, and
      // restores selection when an older browser blurs a moved control.
      const controls = await ui.evaluate(() => {
        const root = document.createElement('div'); document.body.appendChild(root);
        const results = [];
        for (const tag of ['input', 'textarea']) {
          root.replaceChildren(); delete root.__t3;
          const field = tag === 'input' ? '<input id="draft-control" type="password">' : '<textarea id="draft-control"></textarea>';
          const markup = '<section data-key="editor">' + field + '</section>';
          Kit.patch(root, '<div>Refreshing</div>' + markup);
          const input = root.querySelector('#draft-control'); input.value = 'private unsaved draft'; input.focus(); input.setSelectionRange(2, 8, 'backward');
          Kit.patch(root, markup);
          results.push({ tag, sameNode: root.querySelector('#draft-control') === input, value: input.value, focused: document.activeElement === input,
            selection: [input.selectionStart, input.selectionEnd, input.selectionDirection] });
        }
        // A rerendered page must never steal focus from another layer.
        const outside = document.createElement('input'); document.body.appendChild(outside); outside.focus();
        Kit.patch(root, '<p>New page contents</p>');
        results.push({ outsideFocus: document.activeElement === outside }); outside.remove(); root.remove(); return results;
      });
      for (const result of controls.slice(0, 2)) {
        assert.equal(result.sameNode, true); assert.equal(result.value, 'private unsaved draft'); assert.equal(result.focused, true);
        assert.deepEqual(result.selection, [2, 8, 'backward']);
      }
      assert.equal(controls[2].outsideFocus, true);
      assert.deepEqual(errors, [], 'the console must not throw or make unexpected mutations');
      console.log(`PASS: ${run.width}px${run.embedded ? ' embedded' : ''}${run.fallback ? ' insertBefore fallback' : ''}: drafts, focus, selection, failed refresh, retry and all Access tabs`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
