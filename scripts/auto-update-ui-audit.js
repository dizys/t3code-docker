#!/usr/bin/env node
// The Updates page against a running console: automatic-update switches and
// schedules, the T3 Code risk confirmation, update checks and their failures.
// Policy saves and checks are intercepted: this audit cannot change a real
// policy or start a real check. Usage: node scripts/auto-update-ui-audit.js <console-url> <setup-key>
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
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push(`horizontal page overflow (${document.documentElement.scrollWidth}px > ${innerWidth}px)`);
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
  // Model a failed first install independently of the live home's versions
  // and startup work. CI may already have OpenCode installed or queued; those
  // facts would otherwise turn this fixture into a different row state.
  const failure = 'GitHub rate limit exceeded: https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting Reference: sha512-' + 'a'.repeat(96)
    + '\n' + ('Registry diagnostic: sha512-' + 'b'.repeat(128) + '\n').repeat(20);
  fixtureStatus.harnesses = fixtureStatus.harnesses.map((row) => row.id === 'opencode'
    ? { ...row, installed: false, installedVersion: null, version: null, inProgress: false, failed: true, operation: 'install', failure }
    : row);
  if (fixtureStatus.operations) delete fixtureStatus.operations['harness:opencode'];
  // A finished first-start failure also has a page notice. Keep it in every
  // run: otherwise an empty scratch home misses long errors present in CI.
  fixtureStatus.setup = { ...fixtureStatus.setup, state: 'finished', items: [
    { kind: 'agent', id: 'opencode', name: 'OpenCode', state: 'failed', error: failure },
  ] };
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
  try {
    const runs = [[320, 740, false], [360, 800, false], [390, 844, false], [1100, 1000, false], [390, 844, true], [1198, 878, true]];
    const widths = process.env.T3_AUTO_UPDATE_UI_WIDTHS?.split(',').map(Number);
    for (const [width, height, embedded] of runs.filter(([width]) => !widths || widths.includes(width))) for (const theme of ['light', 'dark']) {
      const fixture = structuredClone(fixtureStatus);
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
      const host = await context.newPage(), errors = [], saved = [];
      let page = host;
      host.on('pageerror', (error) => errors.push(error.message));
      let policy = freshPolicy();
      let updates = { refreshing: false, manual: false, errors: {} }, checkRequests = 0, startFailure = false;
      let holdStatus = null;
      let rustReply = 'fail', rustRequests = 0, rustStarted, finishRust;
      let runtimeReply = 'fail', runtimeRequests = 0, runtimeStarted, finishRuntime;
      let opencodeInstalls = 0;
      const runtime = { ...fixture.t3?.runtime, channel: 'stable', version: '0.1.0',
        expectedPatchRevision: null, patchRevision: null,
        releases: { stable: { version: '0.1.0' }, nightly: { version: '0.1.1-nightly.20261017.1' } }, checkedAt: 1, checking: false,
        checkError: "GitHub's release API rate limit was reached. Try checking again later; the running version was kept.", operation: null, supported: true };

      let requestedChannel;
      await host.route('**/*', async (route) => {
        const url = new URL(route.request().url()), method = route.request().method();
        if (url.pathname.endsWith('/harnesses/versions') && url.searchParams.get('id') === 'opencode') {
          return route.fulfill({ json: { latest: '1.18.31', releases: [
            { version: '2.0.27', supported: true, minimumT3Version: '0.1.2' },
            { version: '2.0.18', supported: true, minimumT3Version: '0.1.2' },
            { version: '2.0.17', supported: false, minimumT3Version: '0.1.2' },
            { version: '1.18.31', supported: true },
          ] } });
        }
        if (method === 'POST' && url.pathname.endsWith('/harnesses/install')) {
          opencodeInstalls++;
          return route.fulfill({ status: 202, json: { ok: true } });
        }
        if (url.pathname.endsWith('/status')) {
          const snapshot = structuredClone({ ...fixture, updates, t3: { ...fixture.t3, runtime }, autoUpdate: { policy, state: {}, lastActivityAt: Date.now(), busy: null } });
          if (holdStatus) { const gate = holdStatus; holdStatus = null; gate.started(); await gate.wait; }
          return route.fulfill({ json: snapshot });
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
          if (startFailure) return route.fulfill({ status: 503, json: { ok: false, error: 'Setup service temporarily unavailable' } });
          checkRequests++;
          updates = { refreshing: true, manual: true, errors: {} };
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
        if (method === 'POST' && url.pathname.endsWith('/toolchains/update')) {
          assert.equal(route.request().postDataJSON().id, 'rust');
          rustRequests++;
          if (rustReply === 'fail') return route.fulfill({ status: 502, json: { ok: false, error: 'invalid version: stable' } });
          await new Promise((resolve) => { finishRust = resolve; rustStarted(); });
          const row = fixture.toolchains.find(t => t.id === 'rust');
          Object.assign(row, { failed: false, failure: null, latestVersion: '1.99.1', newestVersion: null, operationState: 'ok' });
          return route.fulfill({ json: { ok: true, changed: false, message: 'Rust 1.99.1 is already up to date.' } });
        }
        if (method === 'POST' && url.pathname.endsWith('/t3/update')) {
          runtimeRequests++;
          assert.deepEqual(route.request().postDataJSON(), { channel: runtime.channel, version: runtime.version }, 'an integration update keeps the exact native version and channel');
          if (runtimeReply === 'fail') return route.fulfill({ status: 503, json: { ok: false, error: 'The runtime registry is temporarily unavailable. The running version was kept.' } });
          await new Promise((resolve) => { finishRuntime = resolve; runtimeStarted(); });
          runtime.operation = { id: 'integration-fixture', phase: 'downloading', channel: runtime.channel, version: runtime.version, patchRevision: runtime.expectedPatchRevision };
          return route.fulfill({ status: 202, json: { ok: true, operation: runtime.operation } });
        }
        return route.continue();
      });
      const url = new URL(base); url.hash = 'agents';
      if (embedded) {
        url.searchParams.set('embed', 't3'); url.searchParams.set('theme', theme);
        const parentUrl = new URL('/__update-audit-frame', base).href;
        await host.route(parentUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe title="Setup"></iframe>' }));
        await host.goto(parentUrl);
        page = await (await host.locator('iframe').elementHandle()).contentFrame();
      }
      await page.goto(url.href);
      if (await page.getByLabel('Setup key', { exact: true }).count()) {
        await page.getByLabel('Setup key', { exact: true }).fill(key);
        await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      }
      await page.locator('#page-agents .tc-page-head').waitFor();
      if (embedded) assert.equal(await page.evaluate(() => window.parent !== window && document.documentElement.dataset.embed === 't3'), true, 'embedded cases run inside a real iframe');
      await page.evaluate(() => { window.T3C.copyText = async (text) => { window.auditCopiedText = text; return true; }; });
      const tag = `${width}-${theme}${embedded ? '-embedded' : ''}`;
      const check = async (name) => { assert.deepEqual(await page.evaluate(geometry), [], `${tag} ${name}`); };

      const startupWarning = page.locator('#page-agents > .tc-notice').filter({ hasText: 'First start couldn’t install OpenCode' });
      await startupWarning.waitFor();
      assert.equal((await startupWarning.textContent()).includes('sha512-'), false, 'the warning keeps raw diagnostics in Details');
      await check('finished startup failure');
      await host.screenshot({ path: path.join(output, `${tag}-startup-failed.png`) });
      await startupWarning.getByRole('button', { name: 'Setup failure details', exact: true }).click();
      const startupDialog = page.getByRole('dialog', { name: 'Setup failures', exact: true });
      await startupDialog.waitFor();
      assert.equal(await startupDialog.locator('pre').textContent(), 'OpenCode\n' + failure, 'startup details retain the complete diagnostic');
      assert.equal(await startupDialog.locator('.tc-dialog-body').evaluate((el) => el.scrollHeight > el.clientHeight), true, 'long diagnostics scroll within the dialog');
      assert.equal(await startupDialog.locator('.tc-dialog-foot').evaluate((el) => { const rect = el.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true, 'copy and close stay visible');
      await check('startup error details');
      await startupDialog.getByRole('button', { name: 'Copy details', exact: true }).click();
      assert.equal(await page.evaluate(() => window.auditCopiedText), 'OpenCode\n' + failure);
      await host.keyboard.press('Escape');
      await startupDialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.dataset.cmd), 'setup.errors', 'Escape returns focus to startup Details');

      // Long diagnostics stay available without consuming the agent list.
      const failedRow = page.locator('[data-key="row-harness:opencode"]');
      await failedRow.getByRole('button', { name: 'Error details for OpenCode' }).waitFor();
      const failedHeight = await failedRow.evaluate((el) => el.getBoundingClientRect().height);
      assert.ok(failedHeight <= 110, `${tag}: opaque failed-install row is ${failedHeight}px (maximum 110px)`);
      await failedRow.getByRole('button', { name: 'Error details for OpenCode' }).click();
      const errorDialog = page.getByRole('dialog', { name: 'OpenCode: install failed' });
      await errorDialog.waitFor();
      assert.ok((await errorDialog.locator('pre').textContent()).includes('sha512-' + 'a'.repeat(96)), 'the full diagnostic remains inspectable');
      await check('row error details');
      await host.screenshot({ path: path.join(output, `${tag}-row-error.png`) });
      await errorDialog.getByRole('button', { name: 'Copy details' }).click();
      assert.equal(await page.evaluate(() => window.auditCopiedText), await errorDialog.locator('pre').textContent());
      await host.keyboard.press('Escape');
      await errorDialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.dataset.cmd), 'row.error', 'Escape returns focus to Details');

      // OpenCode v2 works on Stable 0.1.2 too. Keep the version requirement
      // distinct from the shared-database migration consent.
      await failedRow.getByRole('button', { name: 'More for OpenCode', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Install a specific version…', exact: true }).click();
      const versions = page.getByRole('dialog', { name: 'Install a specific version of OpenCode', exact: true });
      await versions.getByRole('option').first().waitFor();
      await versions.getByLabel('Version', { exact: true }).fill('2');
      assert.equal(await versions.getByRole('option').count(), 3, 'the major prefix includes both supported and unsupported v2 releases');
      assert.equal(await versions.locator('[data-version="2.0.17"]').getAttribute('aria-disabled'), 'true', 'the v2 minimum remains enforced');
      assert.ok((await versions.locator('[data-version="2.0.27"]').textContent()).includes('T3 Code 0.1.2+'), 'the picker reports the runtime minimum');
      assert.ok(!(await versions.textContent()).includes('Nightly'), 'Stable users are not told to switch channels');
      await check('OpenCode v2 picker');
      await host.screenshot({ path: path.join(output, `${tag}-opencode-v2-picker.png`) });
      await versions.locator('[data-version="2.0.27"]').click();
      await versions.getByRole('button', { name: 'Install OpenCode 2.0.27', exact: true }).click();
      const migration = page.getByRole('alertdialog', { name: 'Install OpenCode 2?', exact: true });
      await migration.waitFor();
      const consent = await migration.textContent();
      assert.ok(consent.includes('T3 Code 0.1.2 or newer') && consent.includes('shared database'), 'the switch explains runtime support and data conversion');
      assert.ok(!consent.includes('Nightly'), 'the migration consent does not require Nightly');
      await check('OpenCode v2 migration');
      await host.screenshot({ path: path.join(output, `${tag}-opencode-v2-migration.png`) });
      await migration.getByRole('button', { name: 'Cancel', exact: true }).click();
      await migration.waitFor({ state: 'hidden' });
      assert.equal(opencodeInstalls, 0, 'cancelling migration never installs or changes the selected major');
      await versions.getByRole('button', { name: 'Cancel', exact: true }).click();
      await versions.waitFor({ state: 'hidden' });

      // Automatic updates: a switch per category on the Updates page, each
      // saved as it is pressed and independent of the others.
      url.hash = 'updates'; await page.goto(url.href);
      const providers = page.locator('[data-key="auto-toggle-providers"]');
      const toolchains = page.locator('[data-key="auto-toggle-toolchains"]');
      const t3 = page.locator('[data-key="auto-toggle-t3"]');
      await t3.waitFor();
      await check('updates page');
      await host.screenshot({ path: path.join(output, `${tag}-updates.png`) });
      for (const toggle of [providers, toolchains, t3]) assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      assert.equal(await page.locator('[data-cmd="auto.schedule"]').count(), 0, 'a category that is off has no schedule to change');

      await providers.click();
      await page.waitForFunction(() => document.querySelector('[data-key="auto-toggle-providers"]')?.getAttribute('aria-checked') === 'true');
      assert.equal(saved.length, 1);
      assert.equal(saved[0].providers.enabled, true);
      assert.equal(saved[0].toolchains.enabled, false);
      assert.equal(saved[0].t3.enabled, false);
      assert.equal(await toolchains.getAttribute('aria-checked'), 'false');
      assert.equal(await page.getByRole('alertdialog').count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'auto-toggle-providers', 'saving keeps focus on the switch');

      // Turning T3 Code on warns first; cancelling saves nothing.
      await t3.click();
      const warning = page.getByRole('alertdialog');
      await warning.waitFor(); await check('T3 Code warning');
      const warningText = await warning.innerText();
      assert.match(warningText, /alpha software/);
      assert.match(warningText, /setup console/);
      assert.match(warningText, /Active agent turns and terminals stop/);
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Cancel');
      await host.screenshot({ path: path.join(output, `${tag}-warning.png`) });
      await host.keyboard.press('Escape');
      await warning.waitFor({ state: 'hidden' });
      assert.equal(await t3.getAttribute('aria-checked'), 'false');
      assert.equal(saved.length, 1, 'a cancelled warning saves nothing');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'auto-toggle-t3');

      await t3.click(); await warning.waitFor();
      await page.getByRole('button', { name: 'Turn on automatic updates', exact: true }).click();
      await warning.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelector('[data-key="auto-toggle-t3"]')?.getAttribute('aria-checked') === 'true');
      assert.equal(saved.length, 2);
      assert.equal(saved[1].t3.enabled, true);
      assert.equal(saved[1].providers.enabled, true, 'each save keeps the other categories as they were');

      await toolchains.click();
      await page.waitForFunction(() => document.querySelector('[data-key="auto-toggle-toolchains"]')?.getAttribute('aria-checked') === 'true');
      assert.equal(saved.length, 3);
      assert.equal(await page.getByRole('alertdialog').count(), 0);

      // A schedule of its own, checked before it is saved.
      await page.locator('[data-key="auto-schedule-t3"]').click();
      const schedule = page.getByRole('dialog', { name: 'T3 Code: when to update' });
      await schedule.waitFor(); await check('schedule');
      await host.screenshot({ path: path.join(output, `${tag}-schedule.png`) });
      await page.locator('#auto-check').fill('0');
      await page.locator('[data-schedule-save]').click();
      assert.equal(await page.locator('#auto-check').getAttribute('aria-invalid'), 'true');
      assert.equal(saved.length, 3, 'an invalid schedule is not saved');
      await page.locator('#auto-check').fill('1.5');
      await page.locator('#auto-idle').fill('15');
      await page.locator('[data-schedule-save]').click();
      await schedule.waitFor({ state: 'hidden' });
      assert.equal(saved.length, 4);
      assert.equal(saved[3].t3.checkMinutes, 90);
      assert.equal(saved[3].t3.idleMinutes, 15);
      assert.equal(saved[3].providers.enabled, true);
      assert.equal(saved[3].toolchains.enabled, true);
      assert.match(await page.locator('#auto-t3-desc').textContent(), /every 1\.5 hours.*15 min/);

      // One check covers everything. It never moves the page or resizes itself.
      const control = () => page.locator('[data-cmd="updates.check"]').first();
      const firstTop = () => page.locator('#page-updates [data-key="runtime"]').evaluate((el) => el.getBoundingClientRect().top);
      const refreshStatus = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo(0, 0));
      const idleTop = await firstTop();
      const controlSize = () => control().evaluate((el) => { const { width, height } = el.getBoundingClientRect(); return { width, height }; });
      const idleSize = await controlSize();
      // A pre-existing status read must not briefly re-enable the control or
      // report completion while the accepted manual request is still waiting.
      let releaseStatus, statusStarted;
      const started = new Promise((resolve) => { statusStarted = resolve; });
      holdStatus = { started: statusStarted, wait: new Promise((resolve) => { releaseStatus = resolve; }) };
      await refreshStatus();
      await started;
      try {
        await control().click();
        await page.getByRole('button', { name: 'Checking for updates', exact: true }).waitFor();
        await check('checking');
        assert.equal(await control().getAttribute('aria-disabled'), 'true', 'manual checks coalesce while running');
        assert.equal(checkRequests, 1);
        assert.equal(await page.evaluate(() => document.activeElement.dataset.cmd), 'updates.check', 'starting a check preserves keyboard focus');
        await host.keyboard.press('Enter');
        await host.waitForTimeout(100);
        assert.equal(checkRequests, 1, 'aria-disabled blocks keyboard resubmission during an older status read');
      } finally { releaseStatus(); }
      assert.equal(await firstTop(), idleTop, 'checking does not move the page');
      assert.deepEqual(await controlSize(), idleSize, 'checking preserves the control’s size');
      await host.screenshot({ path: path.join(output, `${tag}-checking.png`) });

      // Sources that could not be checked: a count on the page, the rest one press away.
      updates = { refreshing: false, manual: false, errors: { 'harness:claude': 'offline <script>unsafe</script>', 'toolchain:go': 'offline' } };
      await refreshStatus();
      const failed = page.locator('#page-updates > .tc-notice').filter({ hasText: '2 sources couldn’t be checked' });
      await failed.waitFor();
      assert.deepEqual(await controlSize(), idleSize, 'a failure preserves the control’s size');
      await check('check failures');
      await host.screenshot({ path: path.join(output, `${tag}-check-failures.png`) });
      assert.equal(await page.getByText('Some update checks failed', { exact: true }).count(), 1, 'manual completion is announced once');
      await failed.getByRole('button', { name: 'Details', exact: true }).click();
      const checks = page.getByRole('dialog', { name: 'Update checks', exact: true });
      await checks.waitFor();
      assert.equal(await checks.getByText('Claude Code', { exact: true }).count(), 1);
      assert.equal(await checks.getByText('Go', { exact: true }).count(), 1, 'every source is listed on the one page that checks them');
      assert.equal(await checks.locator('pre').first().isVisible(), false, 'technical diagnostics start collapsed');
      await checks.locator('summary').first().click();
      assert.equal(await checks.locator('pre').first().textContent(), 'offline <script>unsafe</script>', 'diagnostics render as text');
      assert.equal(await checks.locator('script').count(), 0);
      await check('check details');
      await checks.getByRole('button', { name: 'Copy details' }).click();
      assert.equal(await page.evaluate(() => window.auditCopiedText), 'Claude Code\noffline <script>unsafe</script>\n\nGo\noffline');
      await host.keyboard.press('Escape');
      await checks.waitFor({ state: 'hidden' });
      await failed.getByRole('button', { name: 'Details', exact: true }).click();
      await checks.waitFor();
      await checks.getByRole('button', { name: 'Check again', exact: true }).click();
      await checks.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Checking for updates', exact: true }).waitFor();
      assert.equal(checkRequests, 2);
      updates = { refreshing: false, manual: false, errors: {} };
      await refreshStatus();
      await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor();
      await failed.waitFor({ state: 'hidden' });
      assert.equal(await firstTop(), idleTop, 'recovery preserves the page position');
      await check('recovered check');

      startFailure = true;
      await control().click();
      await page.getByText('Couldn’t start the update check', { exact: true }).waitFor();
      // T3 Code's own check, started by the same press, ends on its own time.
      await page.waitForFunction(() => document.querySelector('[data-cmd="updates.check"]')?.getAttribute('aria-disabled') === 'false', null, { timeout: 5000 })
        .catch(() => assert.fail('a failed request leaves the check available'));
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
      startFailure = false;

      updates = { refreshing: true, manual: false, errors: {} };
      await refreshStatus();
      await page.getByRole('button', { name: 'Checking for updates', exact: true }).waitFor();
      assert.equal(await control().getAttribute('aria-disabled'), 'false', 'a background pass still accepts a fresh manual check');
      await control().click();
      assert.equal(checkRequests, 3);
      updates = { refreshing: false, manual: false, errors: {} };
      await refreshStatus();

      // T3 Code's own release, on the same page.
      const card = page.getByRole('region', { name: 'T3 Code', exact: true });
      await card.getByText('Couldn’t check for T3 Code updates', { exact: true }).waitFor();
      assert.equal(await card.getByText('Up to date', { exact: true }).count(), 0);
      // Background checks have no toast. Their reason must remain visible
      // after ordinary polls, with remote text escaped and long names wrapped.
      for (const [name, error] of [
        ['rate-limit', runtime.checkError],
        ['checksum', 'The release must list exactly one SHA-256 checksum for t3-0.1.1-nightly.20261019.3373-linux-arm64.tar.gz.'],
        ['metadata', 'GitHub returned invalid metadata: <script>unsafe</script>'],
      ]) {
        runtime.checkError = error;
        await refreshStatus();
        await card.getByText(error + ' The last known releases are shown.', { exact: true }).waitFor();
        assert.equal(await card.locator('script').count(), 0, 'release errors are rendered as text');
        await refreshStatus();
        assert.equal(await card.getByText(error + ' The last known releases are shown.', { exact: true }).count(), 1, 'polling keeps the reason available');
        await check(`release ${name} failure`);
        await host.screenshot({ path: path.join(output, `${tag}-release-${name}.png`) });
      }
      await check('selected channel failure');
      await host.screenshot({ path: path.join(output, `${tag}-check-failed.png`) });
      await card.getByRole('button', { name: 'Nightly', exact: true }).click();
      const switchDialog = page.getByRole('alertdialog', { name: 'Switch to Nightly?' });
      await switchDialog.waitFor();
      assert.equal(requestedChannel, 'nightly', 'switching checks the target channel even when Stable failed');
      await switchDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await switchDialog.waitFor({ state: 'hidden' });
      runtime.checkError = null;
      runtime.checkedAt = Date.now();
      runtime.releases.stable.version = '0.1.1';
      // One press checks the agents and tools and T3 Code: each pass ends
      // before the next, as a real one would.
      const finishCheck = async () => {
        updates = { refreshing: false, manual: false, errors: {} };
        await refreshStatus();
        await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor();
      };
      await control().click();
      await card.getByText('Stable update available', { exact: true }).waitFor();
      assert.equal(await card.locator('.tc-runtime-notes').count(), 0, 'a successful check clears the persistent warning');
      assert.equal(await card.getByRole('button', { name: 'Update and restart', exact: true }).count(), 1);
      await check('recovered update');
      await finishCheck();
      runtime.releases.stable.version = runtime.version;
      await control().click();
      await card.getByText('Up to date', { exact: true }).waitFor();
      await finishCheck();

      const savedRuntime = structuredClone(runtime), savedServerVersion = fixture.server.version;
      Object.assign(runtime, { channel: 'nightly', version: '0.1.3-nightly.20261026.3710', expectedPatchRevision: 'a'.repeat(64),
        releases: { stable: { version: '0.1.2', patchRevision: 'a'.repeat(64) }, nightly: { version: '0.1.3-nightly.20261026.3710', patchRevision: 'a'.repeat(64) } } });
      fixture.server.version = runtime.version;
      await refreshStatus();
      await card.getByText('Container integration update available', { exact: true }).waitFor();
      assert.equal(await card.locator('.tc-version-arrow').count(), 0, 'same-version integration has no duplicate version arrow');
      await check('same-version integration ready');
      await host.screenshot({ path: path.join(output, `${tag}-integration-ready.png`) });
      await card.getByRole('button', { name: 'Update and restart', exact: true }).click();
      const integrationDialog = page.getByRole('alertdialog', { name: 'Install T3 integration update?' });
      await integrationDialog.waitFor();
      assert.match(await integrationDialog.innerText(), /Your version stays.*on Nightly/s);
      assert.equal(await page.locator('#toaster').evaluate(el => getComputedStyle(el).display), 'none', 'earlier notifications cannot paint over the confirmation');
      await check('same-version integration confirmation');
      await host.screenshot({ path: path.join(output, `${tag}-integration-update.png`) });
      await integrationDialog.screenshot({ path: path.join(output, `${tag}-integration-confirmation.png`) });
      await integrationDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await integrationDialog.waitFor({ state: 'hidden' });
      assert.equal(runtimeRequests, 0, 'cancelling never submits an update');
      await card.getByRole('button', { name: 'Update and restart', exact: true }).click();
      await integrationDialog.getByRole('button', { name: 'Update and restart', exact: true }).click();
      await page.getByText('Could not update T3 Code', { exact: true }).waitFor();
      assert.equal(runtimeRequests, 1);
      await page.waitForFunction(() => document.querySelector('[data-cmd="t3.update"]')?.disabled === false);
      runtimeReply = 'hold';
      const startedRuntime = new Promise(resolve => { runtimeStarted = resolve; });
      await card.getByRole('button', { name: 'Update and restart', exact: true }).click();
      await integrationDialog.getByRole('button', { name: 'Update and restart', exact: true }).click();
      await startedRuntime;
      try {
        await card.getByText('Starting update', { exact: true }).waitFor();
        assert.equal(await card.getByRole('button', { name: 'Update and restart', exact: true }).isDisabled(), true);
        assert.equal(await card.getByRole('button', { name: 'Stable', exact: true }).isDisabled(), true);
        await host.keyboard.press('Enter');
        await refreshStatus();
        assert.equal(runtimeRequests, 2, 'a pending submission cannot be repeated by keyboard or polls');
        await check('integration submission');
      } finally { finishRuntime(); }
      await card.getByText('Downloading', { exact: true }).waitFor();
      assert.equal(await card.locator('.tc-version-arrow').count(), 0);
      runtime.patchRevision = runtime.expectedPatchRevision;
      runtime.operation = { ...runtime.operation, phase: 'succeeded' };
      await refreshStatus();
      await card.getByText('Up to date', { exact: true }).waitFor();
      await page.getByText('T3 Code updated', { exact: true }).waitFor();
      Object.assign(runtime, savedRuntime);
      fixture.server.version = savedServerVersion;

      // An older cache and failed click can describe the same Rust failure.
      // Keep one error, never offer a channel as a version, and keep feedback
      // visible while a delayed retry verifies an unchanged installation.
      const rustFacts = fixture.toolchains.find(t => t.id === 'rust');
      assert.ok(rustFacts, 'fixture includes Rust');
      Object.assign(rustFacts, { installed: true, version: '1.99.1', inProgress: false,
        latestVersion: 'stable', newestVersion: 'stable', failed: true,
        failure: 'invalid version: stable', operation: 'update', operationState: 'failed' });
      if (fixture.operations) delete fixture.operations['toolchain:rust'];
      await refreshStatus();
      const rust = page.locator('#page-updates [data-key="row-toolchain:rust"]');
      await rust.getByRole('button', { name: 'Retry', exact: true }).waitFor();
      await rust.getByRole('button', { name: 'Retry', exact: true }).click();
      await rust.getByRole('button', { name: 'Retry', exact: true }).waitFor();
      assert.equal(rustRequests, 1);
      assert.equal(await rust.locator('.tc-status').count(), 1, 'the failed request and status share one error line');
      assert.equal(await rust.getByRole('alert').count(), 1, 'the remaining error is still announced to assistive technology');
      assert.equal(await rust.locator('.tc-version-to, .tc-version-arrow').count(), 0, 'a cached channel is never an update arrow');
      assert.match(await rust.textContent(), /1\.99\.1/);
      await check('Rust failed retry');
      await host.screenshot({ path: path.join(output, `${tag}-rust-failed.png`) });

      rustReply = 'hold';
      const startedRust = new Promise(resolve => { rustStarted = resolve; });
      await rust.getByRole('button', { name: 'Retry', exact: true }).click();
      await startedRust;
      try {
        await rust.getByText('Updating', { exact: true }).waitFor();
        assert.equal(await rust.getByRole('button', { name: 'Retry', exact: true }).count(), 0, 'a pending retry cannot be submitted again');
        await refreshStatus();
        await rust.getByText('Updating', { exact: true }).waitFor();
        assert.equal(rustRequests, 2, 'polls do not submit another operation');
        await check('Rust pending retry');
      } finally { finishRust(); }
      await page.getByText('Rust 1.99.1 is already up to date.', { exact: true }).waitFor();
      await rust.waitFor({ state: 'hidden' });

      // A native custom font can make the idle label wider than its minimum.
      // Exercise real checks with both wide mono and serif text, at every size.
      const originalFont = await page.evaluate(() => document.documentElement.style.getPropertyValue('--font-sans'));
      try {
        for (const family of ['"Liberation Mono", monospace', 'serif']) {
          await page.evaluate(async family => {
            document.documentElement.style.setProperty('--font-sans', family);
            await document.fonts.ready;
            window.scrollTo(0, 0);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }, family);
          await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor();
          const size = await controlSize(), top = await firstTop();
          await control().click();
          await page.getByRole('button', { name: 'Checking for updates', exact: true }).waitFor();
          assert.deepEqual(await controlSize(), size, family + ': progress keeps the idle control size');
          assert.equal(await firstTop(), top, family + ': progress keeps the page position');
          await finishCheck();
          assert.deepEqual(await controlSize(), size, family + ': completion keeps the idle control size');
        }
      } finally {
        await page.evaluate(value => {
          if (value) document.documentElement.style.setProperty('--font-sans', value);
          else document.documentElement.style.removeProperty('--font-sans');
        }, originalFont);
      }
      url.hash = 'toolchains'; await page.goto(url.href);
      const installedRust = page.locator('#page-toolchains [data-key="row-toolchain:rust"]');
      await installedRust.getByText(/With clippy and rustfmt.*up to date/).waitFor();
      assert.equal(await installedRust.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
      assert.equal(await installedRust.locator('.tc-status').count(), 1);
      await check('Rust recovered');
      await host.screenshot({ path: path.join(output, `${tag}-rust-recovered.png`) });

      assert.deepEqual(errors, []); await context.close();
      console.log(`PASS ${tag}: startup failures, switches, release checks, Rust failure deduplication and delayed retry recovery`);
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
