#!/usr/bin/env node
const { runCases } = require('./lib/browser-audit-cases.cjs');
// The Gateways page through its real service, over stand-ins for T3, the Vault
// and the network (scripts/lib/gateways-fixtures.cjs). Every request is
// intercepted here, so nothing reaches a real gateway, agent or credential.
//   node scripts/gateways-ui-audit.js http://127.0.0.1:23785/__setup/ dev
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const { statusFor, portsFor, routeConsole, framed, unlock, visit } = require('./lib/console-fixtures.cjs');
const { createGatewaysFixtures } = require('./lib/gateways-fixtures.cjs');

const base = process.argv[2] || 'http://127.0.0.1:23785/__setup/', key = process.argv[3] || 'dev';
const TAB = process.env.T3_UI_AUDIT_TAB === '1';
const only = (process.env.T3_GATEWAYS_UI_ONLY || '').split(',').filter(Boolean);
const out = process.env.T3_GATEWAYS_UI_OUTPUT || '/tmp/t3-gateways-ui-audit';
fs.mkdirSync(out, { recursive: true });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const SECRET = 'sk-audit-secret-value', MANAGEMENT = 'management-audit-value';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const variants = (TAB ? [480, 639, 640, 704, 1040].map(width => 'tab-' + width) : ['desktop', 'phone', 'embedded', 'embedded-phone']).filter(variant => !only.length || only.includes(variant));
    const cases = ['light', 'dark'].flatMap(theme => variants.map(variant => [theme, variant]));
    await runCases(cases, async ([theme, variant], scope) => {
      const embedded = TAB || variant.startsWith('embedded'), phone = TAB ? Number(variant.slice(4)) < 640 : variant === 'phone' || variant === 'embedded-phone';
      const viewport = TAB ? { width: Number(variant.slice(4)), height: 820 } : phone ? { width: 390, height: 844 } : { width: 1280, height: 900 };
      const context = await scope.context(browser, { viewport, colorScheme: theme, reducedMotion: 'reduce', hasTouch: phone });
      const page = await context.newPage(), errors = [], calls = [];
      let fixture = createGatewaysFixtures({ scenario: 'empty' }), gate = null, gateRoute = null, conflict = false, installed = ['claude', 'codex', 'opencode', 'pi', 'grok'];
      page.on('pageerror', error => errors.push(error.message));
      const status = () => { const s = statusFor('skills'); for (const agent of s.harnesses) agent.installed = installed.includes(agent.id); return s; };
      await routeConsole(page, { status, ports: () => portsFor('ready') });
      await page.route('**/gateways**', async route => {
        const request = route.request(), url = new URL(request.url()), input = request.method() === 'POST' ? request.postDataJSON() : {};
        if (!/\/gateways(?:\/|$)/.test(url.pathname) || url.hash) return route.fallback();
        if (request.method() === 'POST') calls.push({ route: url.pathname.split('/').at(-1), ...input });
        if (gate && url.pathname.endsWith(gateRoute)) await gate.promise;
        if (conflict && request.method() === 'POST' && !url.pathname.endsWith('/test')) { conflict = false; return route.fulfill({ status: 409, json: { ok: false, code: 'conflict', error: 'Gateways changed in another window. Refresh and try again.' } }); }
        const result = await fixture.respond(request.method(), url, input);
        return route.fulfill({ status: result.status || 200, json: result.body });
      });
      const url = new URL(base);
      if (embedded) { url.searchParams.set('embed', 't3'); url.searchParams.set('theme', theme); if (TAB) { url.searchParams.set('host', 'tab'); url.searchParams.set('layout', Number(variant.slice(4)) >= 768 ? 'wide' : 'compact'); } }
      const target = embedded ? await framed(page, url.href) : page;
      if (!embedded) await page.goto(url.href);
      await unlock(target, key);
      const shot = name => page.screenshot({ path: path.join(out, `${variant}-${theme}-${name}.png`) });
      let last = 'start';
      const step = name => { last = name; };
      const noOverflow = async name => {
        const over = await target.evaluate(() => {
          const width = document.documentElement.clientWidth, wide = document.documentElement.scrollWidth > width + 1;
          const clipped = [...document.querySelectorAll('.tc-gw-table, .tc-gw-empty, .tc-gw-editor, .tc-gw-inspector')].filter(node => node.getBoundingClientRect().right > width + 1);
          return { wide, clipped: clipped.length };
        });
        assert.deepEqual(over, { wide: false, clipped: 0 }, `${name}: nothing runs off the side`);
      };
      const postCalls = name => calls.filter(call => call.route === name).length;
      const reload = async scenario => { fixture = createGatewaysFixtures({ scenario }); await target.evaluate(() => { location.hash = 'overview'; }); await target.locator('#page-overview:not([hidden])').waitFor(); await visit(target, page, 'gateways'); };
      const confirm = async answer => { await target.locator(`.tc-dialog [data-answer="${answer}"], [role="alertdialog"] [data-answer="${answer}"]`).first().click(); };
      const field = id => target.locator(`#gw-${id}`);
      const submit = () => target.locator('[data-key="gw-submit"]');
      const check = () => target.locator('[data-key="gw-check"]');
      const sheetGone = () => target.locator('.tc-gw-editor').waitFor({ state: 'detached' });
      const add = () => (phone ? target.locator('.tc-sk-phone-actions button') : target.locator('[data-key="gw-add"]')).click();
      const inspector = target.locator('.tc-gw-inspector');
      const inspect = async id => { await target.locator(phone ? `[data-key="gw-phone-${id}"]` : `[data-key="gw-name-${id}"]`).click(); await inspector.waitFor(); };
      const closeInspector = async () => { await inspector.locator('[data-gw-inspect="close"]').click(); await inspector.waitFor({ state: 'detached' }); };
      /** Leave a field the way someone does, which is what starts a test. */
      const leave = async id => { await field(id).press('Tab'); };

      try {
      // ---- empty, and the page in the navigation ---------------------------------
      step('empty, and the page in the navigation');
      await visit(target, page, 'gateways');
      await target.getByText('Connect your first gateway').waitFor();
      assert.equal(await target.locator('.tc-gw-empty .tc-gw-preset').count(), 4, 'Each kind of gateway is one press away');
      await noOverflow('empty'); await shot('empty');

      // ---- presets keep what someone typed ---------------------------------------
      step('presets keep what someone typed');
      await target.locator('[data-key="gw-start-openrouter"]').click();
      await field('url').waitFor();
      assert.equal(await field('url').inputValue(), 'https://openrouter.ai/api', 'The card chosen on the page opens the sheet on that type');
      await target.locator('[data-key="gw-preset-cliproxyapi"]').click();
      assert.equal(await field('url').inputValue(), 'http://host.docker.internal:8317');
      await target.locator('[data-key="gw-preset-litellm"]').click();
      assert.equal(await field('url').inputValue(), 'http://host.docker.internal:4000', 'An untouched address follows the preset');
      await field('url').fill('http://my-gateway:9000');
      await target.locator('[data-key="gw-preset-openrouter"]').click();
      assert.equal(await field('url').inputValue(), 'http://my-gateway:9000', 'A typed address survives a preset change');
      await target.locator('[data-key="gw-preset-cliproxyapi"]').click();
      await noOverflow('connect'); await shot('connect');

      // ---- leaving a draft asks first --------------------------------------------
      step('leaving a draft asks first');
      await field('key').fill(SECRET);
      await page.keyboard.press('Escape');
      await target.getByText('Discard this gateway?').waitFor();
      await confirm('no');
      assert.equal(await field('key').inputValue(), SECRET, 'Keeping a draft keeps what was typed');

      // ---- failures say what to do, as soon as a field is finished -------------------
      step('failures say what to do');
      await field('url').fill('http://127.0.0.1:8317/v1');
      await leave('url');
      await check().getByText('inside this container').waitFor();
      assert.equal(await field('url').inputValue(), 'http://127.0.0.1:8317', 'The address is shown as it will be used');
      await target.getByText('Removed /v1').waitFor();
      await target.locator('[data-key="gw-anyway"]').waitFor();
      assert.equal(await submit().isDisabled(), true, 'A failed test can’t be mistaken for a pass');
      const foot = await target.evaluate(() => { const rows = new Set([...document.querySelectorAll('.tc-gw-editor .tc-wizard-foot .tc-btn')].filter(node => node.offsetParent).map(node => Math.round(node.getBoundingClientRect().top))); return rows.size; });
      assert.equal(foot, 1, 'The footer’s buttons share a line');
      await noOverflow('refused'); await shot('refused');
      await field('url').fill('http://host.docker.internal:8317');
      await field('key').fill('wrong-key');
      await leave('key');
      await check().getByText('turned this key down').waitFor();
      assert.equal(await target.locator('[data-key="gw-anyway"]').count(), 0, 'A rejected key isn’t something to go past');
      await shot('rejected');

      // ---- an agent a gateway can't serve can't be picked -------------------------
      step('an agent a gateway cant serve cant be picked');
      await field('url').fill('https://tiny.example.test');
      await field('key').fill(SECRET);
      await leave('key');
      await check().getByText('Connected').waitFor();
      if (phone) await target.locator('.tc-wizard-rail-toggle').click();
      for (const driver of ['codex', 'grok']) {
        assert.equal(await target.locator(`[data-gw-agent="${driver}"]`).isDisabled(), true, 'Without the Responses API, ' + driver + ' can’t be chosen');
        await target.locator(`[data-key="gw-pick-${driver}"]`).getByText('This gateway has no Responses API').waitFor();
      }
      if (phone) await target.locator('.tc-wizard-rail-toggle').click();

      // ---- a fix in one press, and a gateway that says what it is ---------------------
      step('a fix in one press');
      await field('url').fill('http://127.0.0.1:8317');
      await leave('url');
      await target.locator('[data-key="gw-fix"]').click();
      await check().getByText('Connected').waitFor();
      assert.equal(await field('url').inputValue(), 'http://host.docker.internal:8317', 'The fix fills in the address');
      await target.locator('[data-key="gw-preset-custom"]').click();
      await field('url').fill('http://cliproxy.example.test:8317');
      await field('key').fill(SECRET);
      await leave('key');
      await check().getByText('CLIProxyAPI').waitFor();
      assert.equal(await target.locator('[data-key="gw-preset-cliproxyapi"]').getAttribute('aria-checked'), 'true', 'What the gateway says it is beats “Other”');
      await field('url').fill('http://host.docker.internal:8317');
      await leave('url');
      await check().getByText('Connected').waitFor();
      await noOverflow('tested'); await shot('tested');

      // ---- a management key is only ever sent on request, and never twice if refused -
      step('a management key is only sent on request');
      await target.locator('.tc-gw-optional > summary').click();
      await field('management-key').fill('not-the-right-one');
      await field('management-key').press('Tab');
      await page.waitForTimeout?.(200);
      assert.ok(calls.every(call => !('managementKey' in call)), 'Leaving the field sends nothing');
      assert.equal(await target.locator('.tc-gw-editor').getByText('Connected').count(), 1, 'The connection test still stands');
      await submit().click();
      await target.getByText('turned this management key down').waitFor();
      assert.equal(await submit().isDisabled(), true, 'A refused key can’t be sent again as it is');
      const refused = calls.filter(call => 'managementKey' in call).length;
      await submit().click({ force: true }).catch(() => {});
      await target.keyboard?.press?.('Control+Enter').catch?.(() => {});
      assert.equal(calls.filter(call => 'managementKey' in call).length, refused, 'Five of these lock the server out, so none are spent by accident');
      assert.equal((await fixture.t3()).state.hubs && Object.keys((await fixture.t3()).state.hubs).length, 0, 'T3 never gets a key that failed: it would poll with it');
      assert.equal(await target.locator('.tc-gw-editor').count(), 1, 'Nothing was added');
      await noOverflow('limits-refused'); await shot('limits-refused');
      await field('management-key').fill(MANAGEMENT);
      assert.equal(await submit().isDisabled(), false, 'A different key can be tried');

      // ---- adding happens once, and no key stays ----------------------------------
      step('adding happens once, and no key stays');
      gate = deferred(); gateRoute = '/create';
      await submit().click();
      await target.locator('.tc-gw-editor').getByText('Adding…').waitFor();
      await submit().click({ force: true }).catch(() => {});
      gate.resolve(); gate = null;
      await sheetGone();
      assert.equal(calls.filter(call => call.route === 'create' && call.managementKey === MANAGEMENT).length, 1, 'A second press doesn’t add twice');
      await target.getByText('in T3 Code’s model picker').first().waitFor();
      const html = await target.evaluate(() => document.documentElement.outerHTML);
      assert.ok(!html.includes(SECRET) && !html.includes(MANAGEMENT), 'No key is left anywhere in the page');
      const hubs = Object.values((await fixture.t3()).state.hubs);
      assert.deepEqual(hubs.map(hub => [hub.kind, hub.url, hub.managementKey]), [['cliproxy', 'http://host.docker.internal:8317', MANAGEMENT]], 'T3 Code has the hub');
      const id = 'cliproxyapi';
      const instances = (await fixture.t3()).state.instances;
      for (const driver of ['claudeAgent', 'codex', 'opencode', 'pi', 'grok']) assert.ok(instances[driver + '_gw_' + id], driver + ' connects through the editor');
      await target.locator(phone ? `[data-key="gw-phone-${id}"]` : `[data-key="gw-${id}"]`).waitFor();
      if (!phone) await target.locator(`[data-key="gw-limits-${id}"]`).getByText('6 accounts').waitFor({ timeout: 8000 });
      await noOverflow('page'); await shot('page');

      // ---- the same page as MCP servers, measured ---------------------------------
      // Narrower than this, MCP's longer toolbar wraps, and matching it would mean adding controls.
      if (viewport.width >= 1024) {
        step('the same page as MCP servers, measured');
        const measure = route => target.evaluate(route => {
          const root = document.querySelector('#page-' + route), box = selector => { const rect = root.querySelector(selector)?.getBoundingClientRect(); return rect ? { left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) } : null; };
          // A table is as tall as its rows, so only where it sits is compared.
          return { page: box(':scope > .tc-page-head'), toolbar: box('.tc-sk-toolbar'), table: { ...box('.tc-mx-scroll'), height: undefined }, head: box('.tc-mx-head'), foot: box('.tc-sk-library-foot') };
        }, route);
        const ours = await measure('gateways');
        await visit(target, page, 'mcp');
        await target.locator('#page-mcp .tc-mx-head').waitFor();
        const theirs = await measure('mcp');
        await visit(target, page, 'gateways');
        await target.locator('#page-gateways .tc-mx-head').waitFor();
        assert.deepEqual(ours, theirs, 'Moving between the two pages, nothing jumps');
      }

      // ---- an agent's cell says the state and holds the choices ----------------------
      step('an agents cell');
      if (phone) {
        await inspect(id);
        const claude = inspector.locator('[data-key="gw-switch-claude"]');
        await claude.click();
        await target.getByText('any turn running on it stops').waitFor();
        await confirm('no');
        assert.equal(await claude.getAttribute('aria-checked'), 'true', 'Cancelling leaves it on');
        assert.equal(postCalls('agent'), 0);
        await closeInspector();
      } else {
        const cell = target.locator(`[data-key="gw-cell-${id}-claude"]`);
        await cell.click();
        await target.locator('.tc-menu-item', { hasText: 'All models' }).waitFor();
        await noOverflow('cell'); await shot('cell');
        await target.locator('.tc-menu-item', { hasText: /^Off/ }).click();
        await target.getByText('any turn running on it stops').waitFor();
        await confirm('no');
        assert.equal(postCalls('agent'), 0, 'Cancelling changes nothing');
        await cell.click();
        await target.locator('.tc-menu-item', { hasText: /^Off/ }).click();
        await confirm('yes');
        await target.locator(`[data-key="gw-${id}-claude"] .tc-cell--none`).waitFor();
        await target.locator(`[data-key="gw-${id}-claude"] .tc-cell--none`).click();
        await target.locator(`[data-key="gw-cell-${id}-claude"]`).waitFor();
      }

      // ---- editing says when it will restart anything -----------------------------
      step('editing says when it will restart anything');
      await inspect(id);
      await inspector.locator('[data-gw-inspect="edit"]').click();
      await field('url').waitFor();
      await field('name').fill('Renamed');
      assert.equal(await submit().innerText(), 'Save', 'A new name needs no test');
      await field('url').fill('https://llm.example.net');
      await target.waitForFunction(() => /Save and restart/.test(document.querySelector('[data-key="gw-submit"]').textContent));
      await noOverflow('edit'); await shot('edit');
      await field('url').fill('http://host.docker.internal:8317');
      const tests = postCalls('test');
      await submit().click();
      await sheetGone();
      assert.equal(postCalls('test'), tests, 'Saving a new name doesn’t test the connection');
      await target.getByText('Saved Renamed').waitFor();
      assert.equal((await fixture.t3()).state.hubs[Object.keys((await fixture.t3()).state.hubs)[0]].label, 'Renamed', 'The hub follows the gateway’s name, and keeps its key');
      assert.equal(Object.values((await fixture.t3()).state.hubs)[0].managementKey, MANAGEMENT);

      // ---- the inspector -----------------------------------------------------------
      step('the inspector');
      await inspect(id);
      await inspector.locator('[data-key="gw-agents"]').waitFor();
      await inspector.locator('[data-key="gw-limits"]').getByText('claude@example.com').waitFor();
      assert.equal(await inspector.locator('.tc-gw-account').count(), 6, 'Every account reaches gateway details');
      await inspector.locator('[data-key="gw-account-antigravity"]').getByText('0% left', { exact: true }).waitFor();
      await inspector.locator('[data-key="gw-account-muse"]').getByText('Muse Code · Everyday', { exact: true }).waitFor();
      await inspector.locator('[data-key="gw-account-go"]').getByText('OpenCode Go · Go', { exact: true }).waitFor();
      assert.equal(await inspector.locator('.tc-gw-windows li').count(), 12, 'Each quota window has its own row');
      assert.ok((await inspector.locator('.tc-gw-windows').first().textContent()).includes('Resets in'), 'Reset times are visible');
      assert.ok(await inspector.locator('.tc-gw-windows time[datetime][title]').count(), 'Reset timestamps remain available alongside countdowns');
      const report = (await fixture.t3()).state.reports[0], go = report.accounts.find(account => account.id === 'go'), priorGo = structuredClone(go.usageLimits);
      go.usageLimits = { windows: [], unavailable: { reason: 'probeFailed', message: 'The provider refused the hub request (HTTP 429). Try refreshing Limits later.' } };
      await inspector.locator('[data-key="gw-insp-quota"]').click();
      await inspector.locator('[data-key="gw-account-go"]').getByText(/HTTP 429/).waitFor({ timeout: 15000 });
      assert.equal(await inspector.locator('[data-key="gw-account-go"] .tc-gw-windows').count(), 0, 'Unavailable quota is never shown as zero');
      assert.equal(await inspector.locator('.tc-gw-windows li').count(), 10, 'Healthy accounts retain their quota');
      await noOverflow('quota-partial'); await shot('quota-partial');
      go.usageLimits = priorGo;
      await inspector.locator('[data-key="gw-insp-quota"]').click();
      await inspector.locator('[data-key="gw-account-go"]').getByText('40% left', { exact: true }).waitFor({ timeout: 15000 });
      const rows = inspector.locator('.tc-gw-models > li');
      assert.ok(await rows.count() > 8, 'Models are listed');
      assert.ok(await inspector.locator('.tc-gw-family').count() >= 2, 'Under the company that makes them');
      const search = await inspector.locator('#gw-model-search').boundingBox(), label = await inspector.locator('.tc-gw-model-search').boundingBox();
      assert.ok(label.height <= search.height + 2, 'The search box doesn’t stretch into empty space');
      assert.ok((await rows.first().boundingBox()).height >= 24, 'Model rows keep their height in the sheet');
      await noOverflow('inspector'); await shot('inspector');
      await inspector.locator('#gw-model-search').fill('gemini');
      await target.waitForFunction(() => document.querySelectorAll('.tc-gw-models > li').length === 2);
      await inspector.locator('#gw-model-search').fill('');
      await inspector.locator('#gw-manual').fill('my-own-model');
      await inspector.locator('[data-key="gw-insp-manual"]').click();
      await inspector.getByText('my-own-model').waitFor();
      await inspector.locator('[data-gw-inspect="unmanual"]').click();
      await inspector.getByText('my-own-model').waitFor({ state: 'detached' });
      const all = inspector.locator('[data-key="gw-scope-claude-all"]');
      await all.click();
      await target.waitForFunction(() => document.querySelector('[data-key="gw-scope-claude-all"]')?.getAttribute('aria-pressed') === 'true');
      await inspector.locator('[data-key="gw-insp-remove-limits"]').click();
      await target.getByText('T3 Code forgets the management key').waitFor();
      await confirm('yes');
      await inspector.locator('[data-key="gw-insp-setup-limits"]').waitFor();
      assert.deepEqual(Object.keys((await fixture.t3()).state.hubs), [], 'Stopping removes the hub from T3 Code');
      await closeInspector();

      // ---- every way in: the shortcut, a link to one gateway, a link to the sheet ---
      step('every way in');
      await target.evaluate(() => { location.hash = 'overview'; });
      await target.locator('#page-overview:not([hidden])').waitFor();
      await target.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('g'); await page.keyboard.press('w');
      await target.locator('#page-gateways:not([hidden])').waitFor();
      await target.evaluate(gateway => { location.hash = 'gateways/' + gateway; }, id);
      await inspector.waitFor();
      await closeInspector();
      assert.equal(await target.evaluate(() => location.hash), '#gateways', 'Closing leaves the address clean');
      await target.evaluate(gateway => { location.hash = 'gateways/' + gateway; }, id);
      await inspector.waitFor();
      await closeInspector();
      await target.evaluate(() => { location.hash = 'gateways/new'; });
      await field('url').waitFor();
      assert.equal(await target.evaluate(() => location.hash), '#gateways', 'The link works again later');
      await target.locator('[data-gw-editor="close"]').first().click();
      await sheetGone();

      // ---- a stale window is told, and catches up ---------------------------------
      step('a stale window is told, and catches up');
      conflict = true;
      await inspect(id);
      await inspector.locator('[data-key="gw-switch-claude"]').click();
      await confirm('yes');
      await inspector.locator('[data-key="gw-insp-error"]').getByText('Gateways changed in another window').waitFor();
      await closeInspector();

      // ---- whatever needs a person says so, with the one thing to do --------------
      step('whatever needs a person says so, with the one thing to do');
      await reload('attention');
      if (!phone) {
        await target.getByText('settings file overrides gateways').waitFor();
        await target.waitForFunction(() => document.querySelectorAll('.tc-gw-row[data-tone="warn"]').length === 2);
        const fix = target.locator('[data-key="gw-fix-cliproxy"]');
        await fix.waitFor();
        assert.equal(await fix.innerText(), 'Update…', 'The row’s button is what would fix it');
        assert.match(await target.locator('[data-key="gw-attention"]').innerText(), /Needs attention 3/, 'The count matches what’s on the page, conflict included');
        assert.equal(await target.locator('#page-gateways .tc-sk-notices .tc-notice--warn').count(), 1, 'A row’s trouble stays on its row');
        await noOverflow('attention'); await shot('attention');
        await fix.click();
        await target.getByText('any turn running on them stops').waitFor();
        await confirm('no');
        assert.equal(postCalls('apply'), 0, 'Cancelling restarts nothing');
        await fix.click();
        await confirm('yes');
        await fix.waitFor({ state: 'detached' });
        await target.locator('[data-key="gw-fix-conflict"]').click();
        await target.getByText('Every other setting stays').waitFor();
        await confirm('yes');
        await target.locator('[data-key="gw-conflict-claude-settings"]').waitFor({ state: 'detached' });
      } else {
        await target.locator('.tc-sk-phone-notice').waitFor();
        await noOverflow('attention'); await shot('attention');
      }

      // ---- T3 away: readable, and nothing pretends to work ------------------------
      step('T3 away: readable, and nothing pretends to work');
      await reload('set-up');
      await fixture.respond('POST', new URL('http://x/gateways/__t3'), { down: true });
      await target.evaluate(() => { location.hash = 'overview'; });
      await target.locator('#page-overview:not([hidden])').waitFor();
      await new Promise(resolve => setTimeout(resolve, 1100));
      await visit(target, page, 'gateways');
      await target.locator('[data-key="gw-t3"]').waitFor();
      if (!phone) assert.equal(await target.locator('[data-key="gw-add"]').isDisabled(), true);
      await noOverflow('t3-down'); await shot('t3-down');
      await fixture.respond('POST', new URL('http://x/gateways/__t3'), { down: false });
      await new Promise(resolve => setTimeout(resolve, 1100));
      await target.evaluate(() => { location.hash = 'overview'; });
      await target.locator('#page-overview:not([hidden])').waitFor();
      await visit(target, page, 'gateways');

      // ---- removing says what stays -----------------------------------------------
      step('removing says what stays');
      await inspect('cliproxy');
      await inspector.locator('[data-gw-inspect="menu"]').click();
      await target.locator('.tc-menu-item', { hasText: 'Remove' }).click();
      await target.getByText('Its key stays in the Vault').waitFor();
      await target.getByText('T3 Code forgets the management key').waitFor();
      await shot('remove');
      await confirm('yes');
      await target.locator(phone ? '[data-key="gw-phone-cliproxy"]' : '[data-key="gw-cliproxy"]').waitFor({ state: 'detached' });
      assert.deepEqual(Object.keys((await fixture.t3()).state.hubs), [], 'Its hub goes with it');

      // ---- an agent that isn't installed can't be picked --------------------------
      step('an agent that isnt installed cant be picked');
      installed = ['claude'];
      await Promise.all([
        target.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        target.evaluate(() => location.reload()),
      ]);
      await target.locator(`#page-gateways:not([hidden]) ${phone ? '.tc-sk-phone-list' : '.tc-gw-table'}`).waitFor();
      await visit(target, page, 'gateways');
      await add();
      await field('url').fill('https://any.example.test');
      await field('key').fill(SECRET);
      await leave('key');
      await check().getByText('Connected').waitFor();
      if (phone) await target.locator('.tc-wizard-rail-toggle').click();
      assert.equal(await target.locator('[data-gw-agent="codex"]').isDisabled(), true);
      await target.locator('[data-key="gw-pick-codex"]').getByText('Not installed').waitFor();

      assert.deepEqual(errors, [], 'No browser exceptions');
      } catch (error) {
        await shot('failure').catch(() => {});
        console.error(`${variant} ${theme}: failed after "${last}", with ${JSON.stringify(calls.map(call => call.route))}`);
        throw error;
      }
      console.log(`${variant} ${theme}: presets, drafts, failures, detection, management key, one add, no key left behind, MCP parity, cells, edit, inspector, conflicts, T3 away, removal passed`);

    }, { name: 'Gateways', output: out });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
