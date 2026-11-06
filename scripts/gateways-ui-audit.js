#!/usr/bin/env node
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
const SECRET = 'sk-audit-secret-value';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark']) for (const variant of (TAB ? [480, 639, 640, 704, 1040].map(width => 'tab-' + width) : ['desktop', 'phone', 'embedded', 'embedded-phone'])) {
      if (only.length && !only.includes(variant)) continue;
      const embedded = TAB || variant.startsWith('embedded'), phone = TAB ? Number(variant.slice(4)) < 640 : variant === 'phone' || variant === 'embedded-phone';
      const viewport = TAB ? { width: Number(variant.slice(4)), height: 820 } : phone ? { width: 390, height: 844 } : { width: 1280, height: 900 };
      const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce', hasTouch: phone });
      const page = await context.newPage(), errors = [], calls = [];
      let fixture = createGatewaysFixtures({ scenario: 'empty' }), gate = null, gateRoute = null, conflict = false, installed = ['claude', 'codex', 'opencode'];
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
          const clipped = [...document.querySelectorAll('.tc-gw-card, .tc-gw-editor, .tc-gw-inspector')].filter(node => node.getBoundingClientRect().right > width + 1);
          return { wide, clipped: clipped.length };
        });
        assert.deepEqual(over, { wide: false, clipped: 0 }, `${name}: nothing runs off the side`);
      };
      const postCalls = name => calls.filter(call => call.route === name).length;
      const reload = async scenario => { fixture = createGatewaysFixtures({ scenario }); await target.evaluate(() => { location.hash = 'overview'; }); await target.locator('#page-overview:not([hidden])').waitFor(); await visit(target, page, 'gateways'); };
      const confirm = async answer => { await target.locator(`.tc-dialog [data-answer="${answer}"], [role="alertdialog"] [data-answer="${answer}"]`).first().click(); };
      const field = id => target.locator(`#gw-${id}`);
      const next = () => target.locator('[data-key="gw-next"]');
      const outcome = () => target.locator('[data-key="gw-outcome"]');
      const switchOf = (id, agent) => target.locator(`[data-gw-toggle="${agent}"][data-id="${id}"]`);

      try {
      // ---- empty, and the page in the navigation ---------------------------------
      step('empty, and the page in the navigation');
      await visit(target, page, 'gateways');
      await target.getByText('Route agents through your own gateway').waitFor();
      await noOverflow('empty'); await shot('empty');

      // ---- presets keep what someone typed ---------------------------------------
      step('presets keep what someone typed');
      await target.locator('[data-key="gw-add-empty"]').click();
      await field('url').waitFor();
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

      // ---- failures say what to do ------------------------------------------------
      step('failures say what to do');
      await field('url').fill('http://127.0.0.1:8317/v1');
      await next().click();
      await outcome().getByText('inside this container').waitFor();
      assert.equal(await field('url').inputValue(), 'http://127.0.0.1:8317', 'The address is shown as it will be used');
      await target.getByText('Removed /v1').waitFor();
      await target.locator('[data-key="gw-anyway"]').waitFor();
      await target.waitForFunction(() => { const main = document.querySelector('.tc-gw-editor .tc-wizard-main').getBoundingClientRect(), box = document.querySelector('[data-key="gw-outcome"]').getBoundingClientRect(); return box.top >= main.top - 1 && box.bottom <= main.bottom + 1; });
      const foot = await target.evaluate(() => { const rows = new Set([...document.querySelectorAll('.tc-gw-editor .tc-wizard-foot .tc-btn')].filter(node => node.offsetParent).map(node => Math.round(node.getBoundingClientRect().top))); return rows.size; });
      assert.equal(foot, 1, 'The footer’s buttons share a line');
      await noOverflow('refused'); await shot('refused');
      await field('url').fill('http://host.docker.internal:8317');
      await field('key').fill('wrong-key');
      await next().click();
      await outcome().getByText('turned this key down').waitFor();
      assert.equal(await target.locator('[data-key="gw-anyway"]').count(), 0, 'A rejected key isn’t something to go past');
      await shot('rejected');

      // ---- an agent a gateway can't serve can't be picked -------------------------
      step('an agent a gateway cant serve cant be picked');
      await field('url').fill('https://tiny.example.test');
      await field('key').fill(SECRET);
      await next().click();
      await target.locator('[data-key="gw-pick"]').waitFor();
      assert.equal(await target.locator('#gw-pick-switch-codex').isDisabled(), true, 'Without the Responses API, Codex can’t be chosen');
      await target.getByText('which Codex needs').waitFor();
      await target.locator('[data-key="gw-back"]').click();

      // ---- a fix in one press, then the agents step -------------------------------
      step('a fix in one press, then the agents step');
      await field('url').fill('http://127.0.0.1:8317');
      await next().click();
      await target.locator('[data-key="gw-fix"]').click();
      await target.locator('[data-key="gw-pick"]').or(outcome().getByText('Connected')).first().waitFor();
      assert.equal(await field('url').inputValue(), 'http://host.docker.internal:8317', 'The fix fills in the address');
      await next().click();
      await target.locator('[data-key="gw-pick"]').waitFor();
      assert.equal(await target.locator('#gw-pick-switch-claude').getAttribute('aria-checked'), 'true');
      await noOverflow('agents'); await shot('agents');

      // ---- connecting happens once, and the key doesn't stay ----------------------
      step('connecting happens once, and the key doesnt stay');
      gate = deferred(); gateRoute = '/create';
      const connect = target.locator('[data-key="gw-connect"]');
      await connect.click();
      await target.getByText('Connecting…').waitFor();
      await connect.click({ force: true }).catch(() => {});
      gate.resolve(); gate = null;
      await target.locator('[data-key="gw-finish"]').waitFor();
      assert.equal(postCalls('create'), 1, 'A second press doesn’t connect twice');
      await target.getByText('is connected').waitFor();
      await target.locator('[data-key="gw-done"]').getByText('Ready').first().waitFor();
      await noOverflow('done'); await shot('done');
      const html = await target.evaluate(() => document.documentElement.outerHTML);
      assert.ok(!html.includes(SECRET), 'The key isn’t left anywhere in the page');
      await target.locator('[data-key="gw-finish"]').click();
      await target.locator('.tc-gw-card').waitFor();
      assert.equal(await target.locator('.tc-gw-editor').count(), 0);
      await noOverflow('card'); await shot('card');

      // ---- turning an agent off asks, because it can't be undone mid-turn ---------
      step('turning an agent off asks, because it cant be undone mid-turn');
      const id = 'cliproxyapi', claude = switchOf(id, 'claude');
      await claude.click();
      await target.getByText('any turn running on it stops').waitFor();
      await confirm('no');
      assert.equal(await claude.getAttribute('aria-checked'), 'true', 'Cancelling leaves it on');
      assert.equal(postCalls('agent'), 0);
      await claude.click();
      await confirm('yes');
      await target.waitForFunction(() => document.querySelector('[data-gw-toggle="claude"]').getAttribute('aria-checked') === 'false');
      await claude.click();
      await target.waitForFunction(() => document.querySelector('[data-gw-toggle="claude"]').getAttribute('aria-checked') === 'true');

      // ---- editing says when it will restart anything -----------------------------
      step('editing says when it will restart anything');
      await target.locator(`[data-key="gw-menu-${id}"]`).click();
      await target.locator('.tc-menu-item', { hasText: 'Edit' }).click();
      await field('url').waitFor();
      assert.equal(await next().isDisabled(), true, 'Nothing to save yet');
      await field('name').fill('Renamed');
      assert.equal(await next().innerText(), 'Save', 'A new name needs no test');
      assert.equal(await target.locator('.tc-gw-foot-note').count(), 0);
      await field('url').fill('https://llm.example.net');
      assert.equal(await next().innerText(), 'Test and save');
      await target.locator('.tc-gw-foot-note').waitFor();
      await noOverflow('edit'); await shot('edit');
      await field('url').fill('http://host.docker.internal:8317');
      const tests = postCalls('test');
      await next().click();
      await target.locator('.tc-gw-editor').waitFor({ state: 'detached' });
      assert.equal(postCalls('test'), tests, 'Saving a new name doesn’t test the connection');
      await target.locator('.tc-gw-name', { hasText: 'Renamed' }).waitFor();

      // ---- the inspector -----------------------------------------------------------
      step('the inspector');
      await target.locator(`[data-key="gw-name-${id}"]`).click();
      const inspector = target.locator('.tc-gw-inspector');
      await inspector.waitFor();
      const rows = inspector.locator('.tc-gw-models > li');
      assert.ok(await rows.count() > 8, 'Models are listed');
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
      const all = inspector.locator('[data-key="gw-scope-claude"] [data-scope="all"]');
      await all.click();
      await target.waitForFunction(() => document.querySelector('[data-key="gw-scope-claude"] [data-scope="all"]').getAttribute('aria-pressed') === 'true');
      await inspector.locator('[data-gw-inspect="close"]').click();
      await inspector.waitFor({ state: 'detached' });

      // ---- every way in: the shortcut, a link to one gateway, a link to the sheet ---
      step('every way in');
      await target.evaluate(() => { location.hash = 'overview'; });
      await target.locator('#page-overview:not([hidden])').waitFor();
      await target.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('g'); await page.keyboard.press('w');
      await target.locator('#page-gateways:not([hidden])').waitFor();
      await target.evaluate(gateway => { location.hash = 'gateways/' + gateway; }, id);
      await inspector.waitFor();
      await inspector.locator('[data-gw-inspect="close"]').click();
      await inspector.waitFor({ state: 'detached' });
      assert.equal(await target.evaluate(() => location.hash), '#gateways', 'Closing leaves the address clean');
      await target.evaluate(gateway => { location.hash = 'gateways/' + gateway; }, id);
      await inspector.waitFor();
      await inspector.locator('[data-gw-inspect="close"]').click();
      await inspector.waitFor({ state: 'detached' });
      await target.evaluate(() => { location.hash = 'gateways/new'; });
      await field('url').waitFor();
      assert.equal(await target.evaluate(() => location.hash), '#gateways', 'The link works again later');
      await target.locator('[data-gw-editor="close"]').first().click();
      await target.locator('.tc-gw-editor').waitFor({ state: 'detached' });

      // ---- a stale window is told, and catches up ---------------------------------
      step('a stale window is told, and catches up');
      conflict = true;
      await switchOf(id, 'opencode').click();
      await confirm('yes').catch(() => {});
      await target.getByText('Gateways changed in another window').waitFor();
      await target.locator('.tc-toast button').first().click().catch(() => {});

      // ---- whatever needs a person says so, with the one thing to do --------------
      step('whatever needs a person says so, with the one thing to do');
      await reload('attention');
      await target.getByText('settings file overrides gateways').waitFor();
      await target.locator('[data-gw-action="apply"]').first().waitFor();
      await noOverflow('attention'); await shot('attention');
      await target.locator('[data-gw-action="apply"]').first().click();
      await target.getByText('any turn running on it stops').waitFor();
      await confirm('no');
      assert.equal(postCalls('apply'), 0, 'Cancelling restarts nothing');
      await target.locator('[data-gw-action="apply"]').first().click();
      await confirm('yes');
      await target.waitForFunction(() => !document.querySelector('[data-gw-action="apply"][data-id="cliproxy"]'));
      await target.locator('[data-key="gw-conflict-fix"]').click();
      await target.getByText('Every other setting stays').waitFor();
      await confirm('yes');
      await target.locator('[data-key="gw-conflict-claude-settings"]').waitFor({ state: 'detached' });

      // ---- T3 away: readable, and nothing pretends to work ------------------------
      step('T3 away: readable, and nothing pretends to work');
      await reload('set-up');
      await fixture.respond('POST', new URL('http://x/gateways/__t3'), { down: true });
      await target.evaluate(() => { location.hash = 'overview'; });
      await target.locator('#page-overview:not([hidden])').waitFor();
      await new Promise(resolve => setTimeout(resolve, 1100));
      await visit(target, page, 'gateways');
      await target.locator('[data-key="gw-t3"]').waitFor();
      assert.equal(await switchOf('cliproxy', 'claude').isDisabled(), true);
      await noOverflow('t3-down'); await shot('t3-down');
      await fixture.respond('POST', new URL('http://x/gateways/__t3'), { down: false });
      await new Promise(resolve => setTimeout(resolve, 1100));
      await target.evaluate(() => { location.hash = 'overview'; });
      await target.locator('#page-overview:not([hidden])').waitFor();
      await visit(target, page, 'gateways');

      // ---- removing says what stays -----------------------------------------------
      step('removing says what stays');
      await target.locator('[data-key="gw-menu-cliproxy"]').click();
      await target.locator('.tc-menu-item', { hasText: 'Remove' }).click();
      await target.getByText('Its key stays in the Vault').waitFor();
      await shot('remove');
      await confirm('yes');
      await target.locator('[data-key="gw-card-cliproxy"]').waitFor({ state: 'detached' });

      // ---- an agent that isn't installed can't be picked --------------------------
      step('an agent that isnt installed cant be picked');
      installed = ['claude'];
      await target.evaluate(() => location.reload());
      await target.waitForLoadState?.('domcontentloaded');
      await target.locator('#page-gateways:not([hidden]) [data-key="gw-add"]').waitFor();
      await visit(target, page, 'gateways');
      await target.locator('[data-key="gw-add"]').click();
      await field('url').fill('https://any.example.test');
      await next().click();
      await target.locator('[data-key="gw-pick"]').waitFor();
      assert.equal(await target.locator('#gw-pick-switch-codex').isDisabled(), true);
      await target.getByText('Not installed').first().waitFor();

      assert.deepEqual(errors, [], 'No browser exceptions');
      } catch (error) {
        await shot('failure').catch(() => {});
        console.error(`${variant} ${theme}: failed after "${last}", with ${JSON.stringify(calls.map(call => call.route))}`);
        throw error;
      }
      console.log(`${variant} ${theme}: presets, drafts, failures, one connect, no key left behind, confirmations, edit, inspector, conflicts, T3 away, removal passed`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
