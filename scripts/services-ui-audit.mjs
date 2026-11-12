#!/usr/bin/env node
// Real console and real controller journals with inert fixture adapters.
// All requests stay on the disposable loopback fixture, with no live sign-ins.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const output = process.env.T3_SERVICES_UI_OUTPUT || '/tmp/t3-pr119-evidence/ui';
await fs.mkdir(output, { recursive: true });
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const server = spawn(process.execPath, ['scripts/console-preview.mjs', '--port', String(port)], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = ''; server.stderr.on('data', chunk => { serverOutput += chunk; });
const base = `http://127.0.0.1:${port}/__setup/`;
const wait = async fn => { for (let i = 0; i < 100; i++) { if (await fn()) return; if (server.exitCode !== null) throw new Error(serverOutput); await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Fixture server did not start: ' + serverOutput); };
let browser;
const checks = [];
const geometry = () => {
  const issues = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('page overflow');
  for (const element of document.querySelectorAll('.tc-layer [role=dialog], .tc-layer [role=alertdialog], .tc-layer [role=menu], #page-services .tc-row, #page-toolchains [data-key^="service-runtime-"], #page-access .tc-service-route')) {
    const rect = element.getBoundingClientRect();
    if (rect.width && (rect.left < -1 || rect.right > innerWidth + 1)) issues.push('horizontal bounds: ' + element.className);
    if (element.closest('.tc-layer') && rect.height && (rect.top < -1 || rect.bottom > innerHeight + 1)) issues.push('vertical dialog bounds');
  }
  for (const header of document.querySelectorAll('.tc-service-editor > .tc-sheet-head')) {
    const close = header.querySelector('[data-service-edit=close]'), title = header.querySelector('.tc-sheet-head-text');
    const edge = header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight);
    const rect = close.getBoundingClientRect();
    if (Math.abs(rect.right - edge) > 1) issues.push('service editor close button is not at the right edge');
    if (rect.left < title.getBoundingClientRect().right - 1) issues.push('service editor title overlaps the close button');
  }
  return issues;
};
try {
  await wait(async () => { try { return (await fetch(base)).ok; } catch { return false; } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  for (const [width, height, theme, embedded, fontSize] of [[1440,1000,'light',false,16],[390,844,'dark',false,16],[1198,878,'dark',true,16],[360,800,'light',false,20]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [], tag = `${width}-${theme}-${embedded ? 'embedded' : 'standalone'}-${fontSize}`;
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ theme, fontSize }) => { localStorage.setItem('t3-console-theme', theme); document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = fontSize + 'px'; }); }, { theme, fontSize });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' || route.request().url().startsWith('data:') ? route.continue() : route.abort());
    let dropSubmission = true;
    const submissionKeys = [];
    await page.route('**/services/apply', async route => {
      submissionKeys.push(route.request().postDataJSON().idempotencyKey);
      if (dropSubmission) { dropSubmission = false; const response = await route.fetch(); assert.equal(response.ok(), true); await route.abort('failed'); }
      else await route.continue();
    });
    let userUnavailable = false, tailnetOverride = null, authenticationOverride = null, requirementsOverride = null;
    await page.route('**/services/requirements', async route => {
      if (requirementsOverride === 'unavailable') await route.fulfill({ status: 503, json: { ok: false, error: 'Fixture requirements disconnected' } });
      else if (requirementsOverride) await route.fulfill({ json: { tailscale: requirementsOverride } });
      else await route.continue();
    });
    await page.route('**/__setup/services', async route => {
      const response = await route.fetch(), body = await response.json();
      if (userUnavailable) {
        body.domains = body.domains.map(domain => domain.domain === 'user' ? { ...domain, code: 'controller-unavailable', error: 'Fixture controller disconnected', services: [], operations: [], connections: [], routes: [] } : domain);
        body.services = body.services.filter(item => item.domain !== 'user'); body.operations = body.operations.filter(item => item.domain !== 'user'); body.connections = []; body.routes = [];
      }
      if (tailnetOverride) for (const service of body.services) if (service.domain === 'system' && service.id === 'tailscale') {
        service.observation.connection = { ...tailnetOverride };
        if (service.config.networkMode === 'kernel') service.observation.networking = { mode: 'kernel', state: ({ Running: 'ready', NeedsLogin: 'needs-login', NeedsMachineAuth: 'needs-approval', Unavailable: 'error' })[tailnetOverride.state] || 'connecting', dns: tailnetOverride.state === 'Running' ? 'ready' : 'deployment', message: 'Disposable networking status fixture.' };
      }
      await route.fulfill({ json: body });
    });
    await page.route('**/services/authentication', async route => {
      if (authenticationOverride || tailnetOverride) await route.fulfill({ json: { state: tailnetOverride?.state || 'NeedsLogin', url: null, starting: false, ...authenticationOverride } });
      else await route.continue();
    });
    const shot = async name => { assert.deepEqual(await page.evaluate(geometry), [], tag + ': ' + name); await page.screenshot({ path: path.join(output, tag + '-' + name + '.png') }); };
    const button = name => page.getByRole('button', { name, exact: true });
    const tab = name => page.getByRole('tab', { name, exact: true });
    const openPage = async hash => { await page.evaluate(value => { location.hash = value; }, hash); await page.locator('#page-' + hash.split('/')[0] + ':not([hidden])').waitFor(); };
    await page.goto(base + (embedded ? '?embed=t3&host=tab&layout=wide' : '') + '#services/new');
    const initialEditor = page.getByRole('dialog', { name: 'Add a custom service', exact: true });
    await initialEditor.waitFor();
    await shot('new-editor');
    assert.equal(await page.locator('#app').evaluate(element => element.inert), true, 'the editor deep link keeps the underlying console inert');
    await initialEditor.getByRole('button', { name: 'Close', exact: true }).click();
    await initialEditor.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#app').evaluate(element => element.inert), false, 'closing the editor restores console interaction');
    await page.getByRole('tab', { name: 'Configured', exact: true }).waitFor();
    await shot('configured');
    await button('Add service').first().click(); await page.getByRole('menuitem', { name: 'Custom service…', exact: true }).click();
    await page.locator('#svc-name').fill('Preview ' + tag); await page.locator('#svc-executable').fill('/usr/bin/python3');
    await page.locator('#svc-cwd').fill('/workspace/a folder');
    for (const argument of ['', 'a b', '$(literal)', '雪']) { await button('Add argument').click(); await page.locator('[data-service-arg]').last().fill(argument); }
    await shot('command');
    await button('Continue').click(); await page.locator('#svc-health').selectOption('http'); await page.locator('#svc-port').fill('8080');
    await page.getByText('Environment and advanced settings', { exact: true }).click();
    await button('Add variable').click(); await page.locator('[data-service-variable=name]').first().fill('DISCARD_ME');
    await button('Add variable').click(); await page.locator('[data-service-variable=name]').last().fill('LITERAL_VALUE'); await page.locator('[data-service-variable=value]').last().fill('a b $(literal)');
    await button('Remove variable 1').click(); assert.equal(await page.locator('[data-service-variable=name]').first().inputValue(), 'LITERAL_VALUE');
    await button('Add variable').click(); await page.locator('[data-service-variable=name]').last().fill('API_TOKEN'); await page.locator('[data-service-variable=source]').last().selectOption('vault');
    await page.locator('[data-service-variable=value]').last().selectOption('project-api');
    await shot('advanced');
    await button('Review changes').click();
    const review = page.getByRole('dialog', { name: 'Review Preview ' + tag, exact: true });
    await review.waitFor(); assert.match(await review.innerText(), /\$\(literal\)/); assert.match(await review.innerText(), /a folder/);
    assert.match(await review.innerText(), /API_TOKEN.*project-api/);
    await shot('review'); await review.getByRole('button', { name: 'Add and enable', exact: true }).click();
    await review.getByRole('button', { name: 'Check submission', exact: true }).click();
    assert.equal(submissionKeys[0], submissionKeys[1], 'a lost response reuses the durable submission key');
    const row = page.locator('.tc-service-row').filter({ has: page.locator('.tc-service-name').filter({ hasText: 'Preview ' + tag }) });
    await row.getByText('Locally ready', { exact: true }).waitFor();
    userUnavailable = true; await row.getByText('Status unavailable', { exact: true }).waitFor();
    await shot('stale'); userUnavailable = false; await button('Retry').first().click(); await row.getByText('Locally ready', { exact: true }).waitFor();
    await button('Preview ' + tag).click();
    await page.locator('.tc-service-logs').getByText('Serving the selected folder on loopback.', { exact: true }).waitFor();
    await shot('inspector');
    await page.locator('[data-service-inspect=stop]').click(); await page.getByRole('dialog', { name: 'Review Preview ' + tag }).getByRole('button', { name: 'Stop for now', exact: true }).click();
    await row.getByText('Stopped for now', { exact: true }).waitFor().catch(async error => { console.error(await page.locator('body').innerText()); console.error(JSON.stringify((await (await fetch(base + 'services')).json()).services?.map(item => ({ id: item.id, revision: item.revision, state: item.observation?.state, reason: item.observation?.reason })))); throw error; });
    await page.locator('[data-service-inspect=close]').click();
    await row.getByRole('button', { name: 'Manage Preview ' + tag, exact: true }).click(); await page.getByRole('menuitem', { name: 'Disable at startup', exact: true }).click();
    await button('Disable service').click(); await row.getByText('Disabled', { exact: true }).waitFor();
    await row.getByRole('button', { name: 'Manage Preview ' + tag, exact: true }).click(); await page.getByRole('menuitem', { name: 'Remove registration…', exact: true }).click();
    await button('Remove registration').click(); await row.waitFor({ state: 'detached' });
    // Suspending to Toolchains keeps literal argv, selected tool and draft.
    await button('Add service').first().click(); await page.getByRole('menuitem', { name: 'Custom service…', exact: true }).click();
    await page.locator('#svc-name').fill('Keep this draft'); await page.locator('#svc-mode').selectOption('mise');
    await page.locator('[data-service-tool]').first().selectOption('python@3.14.0'); await button('Open Toolchains').click();
    await openPage('services'); await button('Resume draft').click(); assert.equal(await page.locator('#svc-name').inputValue(), 'Keep this draft');
    assert.equal(await page.locator('[data-service-tool]').first().inputValue(), 'python@3.14.0');
    await page.locator('[data-service-edit=close]').click(); await button('Discard').click();
    await openPage('access/ssh'); await tab('SSH').waitFor(); assert.equal(await tab('SSH').getAttribute('aria-selected'), 'true');
    if (await button('Set up SSH').isVisible()) {
      await button('Set up SSH').click(); await shot('ssh-setup'); await page.locator('#svc-keys').fill('-----BEGIN PRIVATE KEY----- fixture-private-canary');
      await button('Review changes').click(); await page.getByText('This is a private key. Paste only its public key.', { exact: true }).waitFor();
      assert.equal(await page.locator('#svc-keys').inputValue(), ''); assert.ok(!(await page.locator('body').innerText()).includes('fixture-private-canary'));
      const type = Buffer.from('ssh-ed25519'), blob = Buffer.concat([Buffer.from([0,0,0,type.length]),type,Buffer.from([0,0,0,32]),Buffer.alloc(32,11)]);
      await page.locator('#svc-keys').fill('ssh-ed25519 ' + blob.toString('base64') + ' test client');
      await page.locator('#svc-listen').selectOption('0.0.0.0'); await button('Review changes').click(); await button('Install and enable').click();
      await page.locator('#page-access .tc-service-row').getByText('Locally ready', { exact: true }).waitFor();
    }
    await button('Manage SSH').click(); await page.getByRole('menuitem', { name: 'Edit configuration', exact: true }).click();
    await page.getByRole('dialog', { name: 'Edit SSH', exact: true }).waitFor(); await shot('ssh-editor');
    await page.locator('[data-service-edit=close]').click();
    await shot('ssh');
    await openPage('toolchains');
    const runtimes = page.getByRole('region', { name: 'Service packages', exact: true });
    await runtimes.getByRole('link', { name: 'Manage openssh-server for SSH', exact: true }).waitFor();
    assert.match(await runtimes.innerText(), /Mise · Used by SSH/);
    assert.match(await runtimes.innerText(), /protected Mise storage/);
    await shot('service-runtimes');
    await runtimes.getByRole('link', { name: 'Manage openssh-server for SSH', exact: true }).click();
    const sshInspector = page.getByRole('dialog', { name: 'SSH', exact: true });
    await sshInspector.waitFor(); assert.match(await sshInspector.innerText(), /openssh-server@fixture-version, libwrap0@fixture-version, libwtmpdb0@fixture-version, libtalloc2@fixture-version/);
    assert.match(await sshInspector.innerText(), /SSH username\s+t3/);
    await shot('ssh-components'); await sshInspector.getByRole('button', { name: 'Close', exact: true }).click();
    if (width === 1440) { await page.waitForTimeout(5500); assert.equal(await sshInspector.count(), 0, 'polling must not reopen a closed service deep link'); }
    await openPage('services');
    let tailnet = page.locator('.tc-service-row').filter({ has: page.getByRole('button', { name: 'Tailscale', exact: true }) });
    if (!await tailnet.count()) {
      await tab('Available').click();
      await page.locator('.tc-card').filter({ has: page.getByRole('heading', { name: 'Tailscale', exact: true }) }).getByRole('button', { name: 'Configure…', exact: true }).click();
      await button('Review changes').click(); await button('Install and enable').click(); await tab('Configured').click();
    }
    await tailnet.getByText(/^(Running|Network ready|Sign-in needed)$/).first().waitFor();
    await tailnet.getByRole('button', { name: 'Manage Tailscale', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit configuration', exact: true }).click();
    const tailnetEditor = page.getByRole('dialog', { name: 'Edit Tailscale', exact: true });
    await tailnetEditor.getByLabel('Networking', { exact: true }).selectOption('kernel');
    const networkSettings = 'services:\n  t3code:\n    environment:\n      T3_TAILSCALE_NETWORKING: "1"\n    cap_add:\n      - NET_ADMIN\n    devices:\n      - /dev/net/tun:/dev/net/tun\n';
    requirementsOverride = { ready: false, message: 'Apply the optional override and recreate this container.', compose: networkSettings, checks: [{ id: 'tun', label: 'TUN device', ok: false }] };
    await tailnetEditor.getByRole('button', { name: 'Check again', exact: true }).click();
    await tailnetEditor.getByText('Deployment change needed', { exact: true }).waitFor();
    assert.equal(await tailnetEditor.getByRole('button', { name: 'Review changes', exact: true }).isDisabled(), true);
    await tailnetEditor.getByText('Deployment settings', { exact: true }).click();
    assert.match(await tailnetEditor.innerText(), /NET_ADMIN/); assert.match(await tailnetEditor.innerText(), /\/dev\/net\/tun/);
    await shot('tailscale-networking-requirements');
    requirementsOverride = 'unavailable';
    await tailnetEditor.getByRole('button', { name: 'Check again', exact: true }).click();
    await tailnetEditor.getByText('Requirements unavailable', { exact: true }).waitFor();
    assert.equal(await tailnetEditor.getByLabel('Networking', { exact: true }).inputValue(), 'kernel');
    assert.equal(await tailnetEditor.getByRole('button', { name: 'Review changes', exact: true }).isDisabled(), true);
    requirementsOverride = null;
    await tailnetEditor.getByRole('button', { name: 'Check again', exact: true }).click();
    await tailnetEditor.getByText('Deployment ready', { exact: true }).waitFor();
    await shot('tailscale-networking-ready');
    await tailnetEditor.getByRole('button', { name: 'Review changes', exact: true }).click();
    const networkingReview = page.getByRole('dialog', { name: 'Review Tailscale', exact: true });
    assert.match(await networkingReview.innerText(), /Full container networking/); assert.match(await networkingReview.innerText(), /every program/);
    await networkingReview.getByRole('checkbox', { name: 'I have another way to reach Setup or this container.', exact: true }).check();
    await shot('tailscale-networking-review');
    await networkingReview.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await tailnetEditor.waitFor({ state: 'detached' });
    const authMenu = async () => { await tailnet.getByRole('button', { name: 'Manage Tailscale', exact: true }).click(); return page.getByRole('menuitem').filter({ hasText: /sign.in|sign out|approval/i }); };
    const authLabels = async () => (await (await authMenu()).allTextContents()).map(label => label.trim());
    assert.deepEqual(await authLabels(), ['Sign in…']); await shot('tailscale-first-sign-in');
    await page.getByRole('menuitem', { name: 'Sign in…', exact: true }).click(); await button('Start sign-in').click();
    const authDialog = page.getByRole('dialog', { name: 'Sign in to Tailscale', exact: true });
    await authDialog.getByRole('link', { name: 'Open Tailscale sign-in', exact: true }).waitFor();
    await authDialog.getByRole('button', { name: 'Close', exact: true }).click();
    const submissionsBeforeResume = submissionKeys.length;
    assert.deepEqual(await authLabels(), ['Continue sign-in']);
    await page.getByRole('menuitem', { name: 'Continue sign-in', exact: true }).click();
    await authDialog.getByRole('link', { name: 'Open Tailscale sign-in', exact: true }).waitFor(); await shot('tailscale-pending-sign-in');
    assert.equal(submissionKeys.length, submissionsBeforeResume, 'resuming browser authorization must not submit another service operation');
    await authDialog.getByRole('button', { name: 'Close', exact: true }).click();
    authenticationOverride = { state: 'NeedsLogin', url: null, starting: false };
    await authMenu(); await page.getByRole('menuitem', { name: 'Continue sign-in', exact: true }).click();
    await authDialog.getByRole('button', { name: 'Start sign-in…', exact: true }).waitFor();
    assert.equal(await authDialog.locator('.tc-spinner').count(), 0, 'an expired link needs an explicit restart instead of an endless spinner');
    await shot('tailscale-expired-sign-in'); await authDialog.getByRole('button', { name: 'Close', exact: true }).click(); authenticationOverride = null;
    const refreshConnector = async () => {
      await openPage('toolchains');
      const response = page.waitForResponse(value => new URL(value.url()).pathname === '/__setup/services');
      await openPage('services'); await (await response).finished(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    };
    tailnetOverride = { state: 'NeedsMachineAuth', signInPending: false }; await refreshConnector();
    assert.deepEqual(await authLabels(), ['Check device approval', 'Sign out…']);
    await page.getByRole('menuitem', { name: 'Check device approval', exact: true }).click();
    await authDialog.getByRole('link', { name: 'Open Tailscale admin console', exact: true }).waitFor();
    assert.equal(await authDialog.getByRole('link', { name: 'Open Tailscale sign-in', exact: true }).count(), 0);
    await shot('tailscale-device-approval'); await authDialog.getByRole('button', { name: 'Close', exact: true }).click();
    tailnetOverride = { state: 'Unavailable' }; await refreshConnector();
    assert.deepEqual(await authLabels(), []); await page.keyboard.press('Escape');
    tailnetOverride = { state: 'Running', signInPending: false }; await refreshConnector();
    assert.deepEqual(await authLabels(), ['Sign out…']); await shot('tailscale-signed-in');
    await page.getByRole('menuitem', { name: 'Sign out…', exact: true }).click(); tailnetOverride = null;
    await page.getByRole('checkbox', { name: 'I have another way to reach Setup or this container.', exact: true }).check(); await button('Sign out connector').click();
    await openPage('access/ssh');
    await tab('Connections').click(); await button('Add connection').click();
    await page.locator('[data-service-network=name]').fill('Existing LAN ' + tag); await button('Review changes').click(); await button('Save connection').click();
    await page.getByText('Existing LAN ' + tag, { exact: true }).waitFor(); await shot('connections');
    await tab('SSH').click(); await button('Add route').click();
    await page.locator('[data-service-network=name]').fill('Client route ' + tag); await page.locator('[data-service-network=connection]').selectOption({ label: 'Existing LAN ' + tag });
    await page.locator('[data-service-network=host]').fill('client.example.invalid'); await button('Review changes').click(); await button('Save route').click();
    const route = page.locator('.tc-service-route').filter({ has: page.getByText('Client route ' + tag, { exact: true }) });
    await route.getByText('Client test needed', { exact: true }).waitFor(); await shot('route');
    assert.match(await route.innerText(), /t3@client\.example\.invalid/);
    await route.getByRole('button', { name: 'Report client test', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Report a successful client test?', exact: true }).getByRole('button', { name: 'Report success', exact: true }).click();
    await button('Record client test').click();
    await route.getByText('Client test reported', { exact: true }).waitFor();
    await route.getByRole('button', { name: 'Remove route…', exact: true }).click(); await button('Remove route').click(); await route.waitFor({ state: 'detached' });
    if (width === 1440) {
      const sshRow = page.locator('#page-access .tc-service-row').filter({ has: page.locator('.tc-service-name').filter({ hasText: /^SSH$/ }) });
      assert.match(await sshRow.innerText(), /SSH username: t3/);
      await button('Manage SSH').click(); await page.getByRole('menuitem', { name: 'Stop for now', exact: true }).click();
      await page.getByRole('checkbox', { name: 'I have another way to reach Setup or this container.', exact: true }).check(); await button('Stop for now').click();
      await sshRow.getByText('Stopped for now', { exact: true }).waitFor();
      await button('Manage SSH').click();
      assert.equal(await page.getByRole('menuitem', { name: 'Restart', exact: true }).count(), 0);
      assert.equal(await page.getByRole('menuitem', { name: 'Stop for now', exact: true }).count(), 0);
      await page.getByRole('menuitem', { name: 'Start', exact: true }).click(); await button('Start service').click();
      await sshRow.getByText('Locally ready', { exact: true }).waitFor();
      await button('Manage SSH').click(); await page.getByRole('menuitem', { name: 'Disable at startup', exact: true }).click();
      assert.equal(await button('Disable service').isDisabled(), true);
      await page.getByRole('checkbox', { name: 'I have another way to reach Setup or this container.', exact: true }).check(); await button('Disable service').click();
      await sshRow.getByText('Disabled', { exact: true }).waitFor();
      await button('Manage SSH').click(); await page.getByRole('menuitem', { name: 'Uninstall service…', exact: true }).click(); await button('Uninstall service').click();
      await sshRow.getByText('Uninstalled', { exact: true }).waitFor();
      assert.match(await sshRow.innerText(), /Software removed · Settings and identity saved/);
      await button('Manage SSH').click(); await page.getByRole('menuitem', { name: 'Install again…', exact: true }).click();
      assert.ok((await page.locator('#svc-keys').inputValue()).startsWith('ssh-ed25519 '));
      await button('Review changes').click(); await button('Install and enable').click(); await sshRow.getByText('Locally ready', { exact: true }).waitFor();
    }
    await tab('Devices').click(); await page.getByText('Paired devices', { exact: true }).waitFor();
    await tab('Devices').focus(); await page.keyboard.press('ArrowRight'); await tab('Connections').waitFor();
    assert.equal(await tab('Connections').getAttribute('aria-selected'), 'true');
    assert.deepEqual(errors, [], tag + ': browser errors');
    checks.push({ width, theme, embedded, fontSize, checks: ['editor close button alignment', 'create literal argv', 'environment and Vault reference forms', 'review', 'lost submission recovery', 'stale status retains last-known rows', 'observed status', 'logs', 'stop for now', 'disable', 'remove', 'draft preservation', 'SSH key privacy', 'optional SSH install', 'Mise components and versions link to service management', 'SSH bundled components', 'closed service deep links stay closed', 'first and pending Tailscale sign-in actions', 'resuming sign-in creates no operation', 'expired sign-in recovery', 'Tailscale device approval and signed-in actions', 'unavailable Tailscale state', 'connection review', 'client route and instructions', 'reported client test', 'route removal', 'Access tabs', 'keyboard tabs', 'geometry', 'no browser exceptions'] });
    await context.close(); console.log(JSON.stringify({ ok: true, ...checks.at(-1) }));
  }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(checks, null, 2) + '\n');
} finally {
  await browser?.close(); server.kill('SIGTERM'); if (server.exitCode === null) await once(server, 'exit');
}
