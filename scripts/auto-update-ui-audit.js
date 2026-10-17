#!/usr/bin/env node
// Auto-update settings and the T3 Code risk confirmation against a running
// console. Policy saves are intercepted: this audit cannot change a real
// policy. Usage: node scripts/auto-update-ui-audit.js <console-url> <setup-key>
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }
const base = process.argv[2] || "http://127.0.0.1:23780/__setup/";
const key = process.argv[3] || "dev";
const output = process.env.T3_AUTO_UPDATE_UI_OUTPUT || "/tmp/t3-auto-update-ui-audit";

const freshPolicy = () => ({
  version: 2,
  providers: { enabled: false, checkMinutes: 180, idleMinutes: 30 },
  toolchains: { enabled: false, checkMinutes: 180, idleMinutes: 30 },
  t3: { enabled: false, checkMinutes: 180, idleMinutes: 30, stayOnChannel: true },
});

const geometry = () => {
  const issues = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push("horizontal page overflow");
  for (const panel of document.querySelectorAll('.tc-layer [role="dialog"], .tc-layer [role="alertdialog"]')) {
    const rect = panel.getBoundingClientRect();
    if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) {
      issues.push("dialog outside viewport");
    }
  }
  for (const el of document.querySelectorAll('.tc-layer [role="dialog"] *, .tc-layer [role="alertdialog"] *')) {
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || el.matches('input, .tc-switch')) continue;
    if (style.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1) issues.push(`${el.className || el.tagName} clipped`);
  }
  return issues;
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const statusUrl = new URL('status', base.endsWith('/') ? base : base + '/');
  const initial = await fetch(statusUrl, { headers: { 'x-t3-setup-key': key } });
  assert.equal(initial.ok, true, 'console must accept the supplied setup key');
  const fixtureStatus = await initial.json();
  // Registry failures include long URLs. Keep that state in the viewport
  // checks even when the live development home has no failed installations.
  fixtureStatus.harnesses = fixtureStatus.harnesses.map((row) => row.id === 'opencode'
    ? { ...row, installed: false, inProgress: false, failed: true, operation: 'install',
      failure: 'GitHub rate limit exceeded: https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting Reference: sha512-' + 'a'.repeat(96) }
    : row);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
  try {
    const runs = [[360, 800], [390, 844], [1100, 1000]];
    const widths = process.env.T3_AUTO_UPDATE_UI_WIDTHS?.split(',').map(Number);
    for (const [width, height] of runs.filter(([width]) => !widths || widths.includes(width))) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [], saved = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let policy = freshPolicy();
      let updates = { refreshing: false, errors: {} };
      const runtime = { ...fixtureStatus.t3?.runtime, channel: 'stable', version: '0.1.0',
        releases: { stable: { version: '0.1.0' }, nightly: { version: '0.1.1-nightly.20261017.1' } }, checkedAt: 1, checking: false,
        checkError: 'registry offline', operation: null, supported: true };

      let requestedChannel;
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url()), method = route.request().method();
        if (url.pathname.endsWith('/status')) {
          return route.fulfill({ json: { ...fixtureStatus, updates, t3: { ...fixtureStatus.t3, runtime }, autoUpdate: { policy, state: {}, lastActivityAt: Date.now(), busy: null } } });
        }
        if (url.pathname.endsWith('/updates/check')) {
          if (url.pathname.endsWith('/t3/updates/check')) {
            requestedChannel = route.request().postDataJSON().channel || runtime.channel;
            const error = requestedChannel === runtime.channel ? runtime.checkError : null;
            return route.fulfill({ status: error ? 502 : 200, json: {
              ok: !error, error, channels: runtime.releases,
              errors: runtime.checkError ? { stable: runtime.checkError } : {},
            } });
          }
          updates = { refreshing: true, errors: {} };
          return route.fulfill({ status: 202, json: { ok: true, code: 'checking' } });
        }
        if (/\/auto-update(?:\/policy)?$/.test(url.pathname)) {
          if (method === 'POST') {
            const body = route.request().postDataJSON();
            saved.push(body);
            policy = JSON.parse(JSON.stringify(body));
            return route.fulfill({ json: { ok: true, policy } });
          }
          return route.fulfill({ json: { ok: true, policy, state: {}, lastActivityAt: Date.now() } });
        }
        return route.continue();
      });
      const url = new URL(base); url.hash = 'agents';
      await page.goto(url.href);
      await page.getByLabel('Setup key', { exact: true }).fill(key);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await page.locator('[data-cmd="auto.settings"]:visible').first().waitFor();
      const tag = `${width}-${theme}`;
      const check = async (name) => { assert.deepEqual(await page.evaluate(geometry), [], `${tag} ${name}`); };

      await page.locator('[data-cmd="auto.settings"]:visible').first().click();
      const settings = page.getByRole('dialog', { name: 'Automatic updates' });
      await settings.waitFor(); await check('settings');
      await page.screenshot({ path: path.join(output, `${tag}-settings.png`) });
      const providers = page.locator('[data-auto-switch="providers.enabled"]');
      const toolchains = page.locator('[data-auto-switch="toolchains.enabled"]');
      const t3 = page.locator('[data-auto-switch="t3.enabled"]');
      for (const toggle of [providers, toolchains, t3]) assert.equal(await toggle.getAttribute('aria-checked'), 'false');

      await providers.click();
      assert.equal(await providers.getAttribute('aria-checked'), 'true');
      assert.equal(await toolchains.getAttribute('aria-checked'), 'false');
      assert.equal(await page.getByRole('alertdialog').count(), 0);

      // Turning T3 Code on must warn before the draft changes. Cancelling the
      // warning leaves the switch and its timing fields off.
      await t3.click();
      const warning = page.getByRole('alertdialog');
      await warning.waitFor(); await check('T3 Code warning');
      const warningText = await warning.innerText();
      assert.match(warningText, /alpha software/);
      assert.match(warningText, /setup console/);
      assert.match(warningText, /active agent turns and terminals stop/);
      assert.equal(await t3.getAttribute('aria-checked'), 'false');
      assert.equal(await page.locator('#auto-t3-check').isDisabled(), true);
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Cancel');
      await page.screenshot({ path: path.join(output, `${tag}-warning.png`) });
      await page.keyboard.press('Escape');
      await warning.waitFor({ state: 'hidden' });
      assert.equal(await t3.getAttribute('aria-checked'), 'false');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.autoSwitch), 't3.enabled');

      // Confirming enables T3 Code. Within this settings session, turning it
      // off and back on does not repeat a warning the user just accepted.
      await t3.click(); await warning.waitFor();
      await page.getByRole('button', { name: 'Turn on automatic updates', exact: true }).click();
      await warning.waitFor({ state: 'hidden' });
      assert.equal(await t3.getAttribute('aria-checked'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.autoSwitch), 't3.enabled');
      await t3.click(); assert.equal(await t3.getAttribute('aria-checked'), 'false');
      await t3.click(); await page.waitForTimeout(100);
      assert.equal(await t3.getAttribute('aria-checked'), 'true');
      assert.equal(await page.getByRole('alertdialog').count(), 0);

      await toolchains.click(); await page.waitForTimeout(100);
      assert.equal(await toolchains.getAttribute('aria-checked'), 'true');
      assert.equal(await page.getByRole('alertdialog').count(), 0);
      await page.locator('#auto-t3-check').fill('1.5');
      await page.locator('#auto-t3-idle').fill('15');
      await page.locator('[data-auto-save]').click();
      await settings.waitFor({ state: 'hidden' });
      assert.equal(saved.length, 1);
      assert.equal(saved[0].providers.enabled, true);
      assert.equal(saved[0].toolchains.enabled, true);
      assert.equal(saved[0].t3.enabled, true);
      assert.equal(saved[0].t3.checkMinutes, 90);
      assert.equal(saved[0].t3.idleMinutes, 15);

      // Manual checks show progress, then retained-result warnings on both
      // software pages. No real update or policy mutation leaves this audit.
      await page.locator('[data-cmd="updates.check"]:visible').first().click();
      await page.reload();
      await page.getByText('Checking for updates', { exact: true }).waitFor();
      await check('checking');
      updates = { refreshing: false, errors: { 'harness:claude': 'offline', 'toolchain:go': 'offline' } };
      await page.reload();
      await page.locator('#page-agents').getByText('Some updates could not be checked', { exact: true }).waitFor();
      await check('agent failure');
      url.hash = 'toolchains'; await page.goto(url.href);
      await page.locator('#page-toolchains').getByText('Some updates could not be checked', { exact: true }).waitFor();
      await check('toolchain failure');

      url.hash = 'environment'; await page.goto(url.href);
      const card = page.getByRole('region', { name: 'T3 Code updates', exact: true });
      await card.getByText('Could not verify updates', { exact: true }).waitFor();
      assert.equal(await card.getByText('You’re up to date', { exact: true }).count(), 0);
      await card.getByRole('button', { name: 'Check for updates', exact: true }).click();
      await card.getByText('Could not verify updates', { exact: true }).waitFor();
      await check('selected channel failure');
      await page.screenshot({ path: path.join(output, `${tag}-check-failed.png`) });
      await card.getByRole('button', { name: 'Nightly', exact: true }).click();
      const switchDialog = page.getByRole('alertdialog', { name: 'Switch to Nightly?' });
      await switchDialog.waitFor();
      assert.equal(requestedChannel, 'nightly', 'switch checks the target channel even when Stable failed');
      await switchDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await switchDialog.waitFor({ state: 'hidden' });
      runtime.checkError = null;
      runtime.checkedAt = Date.now();
      runtime.releases.stable.version = '0.1.1';
      await card.getByRole('button', { name: 'Check for updates', exact: true }).click();
      await card.getByText('Stable update available', { exact: true }).waitFor();
      assert.equal(await card.getByRole('button', { name: 'Update and restart', exact: true }).count(), 1);
      await check('recovered update');
      runtime.releases.stable.version = runtime.version;
      await card.getByRole('button', { name: 'Check for updates', exact: true }).click();
      await card.getByText('You’re up to date', { exact: true }).waitFor();

      assert.deepEqual(errors, []); await context.close();
      console.log(`PASS ${tag}: defaults, independent toggles, T3 Code warning, save payload, check progress, failures and recovery`);
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
