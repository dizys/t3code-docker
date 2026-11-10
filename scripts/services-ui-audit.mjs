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
  for (const element of document.querySelectorAll('.tc-layer [role=dialog], .tc-layer [role=alertdialog], #page-services .tc-row, #page-access .tc-service-route')) {
    const rect = element.getBoundingClientRect();
    if (rect.width && (rect.left < -1 || rect.right > innerWidth + 1)) issues.push('horizontal bounds: ' + element.className);
    if (element.closest('.tc-layer') && rect.height && (rect.top < -1 || rect.bottom > innerHeight + 1)) issues.push('vertical dialog bounds');
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
    let userUnavailable = false;
    await page.route('**/__setup/services', async route => {
      const response = await route.fetch(), body = await response.json();
      if (userUnavailable) {
        body.domains = body.domains.map(domain => domain.domain === 'user' ? { ...domain, code: 'controller-unavailable', error: 'Fixture controller disconnected', services: [], operations: [], connections: [], routes: [] } : domain);
        body.services = body.services.filter(item => item.domain !== 'user'); body.operations = body.operations.filter(item => item.domain !== 'user'); body.connections = []; body.routes = [];
      }
      await route.fulfill({ json: body });
    });
    const shot = async name => { assert.deepEqual(await page.evaluate(geometry), [], tag + ': ' + name); await page.screenshot({ path: path.join(output, tag + '-' + name + '.png') }); };
    const button = name => page.getByRole('button', { name, exact: true });
    const tab = name => page.getByRole('tab', { name, exact: true });
    const openPage = async hash => { await page.evaluate(value => { location.hash = value; }, hash); await page.locator('#page-' + hash.split('/')[0] + ':not([hidden])').waitFor(); };
    await page.goto(base + (embedded ? '?embed=t3&host=tab&layout=wide' : '') + '#services/new');
    const initialEditor = page.getByRole('dialog', { name: 'Add a custom service', exact: true });
    await initialEditor.waitFor();
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
      await button('Set up SSH').click(); await page.locator('#svc-keys').fill('-----BEGIN PRIVATE KEY----- fixture-private-canary');
      await button('Review changes').click(); await page.getByText('This is a private key. Paste only its public key.', { exact: true }).waitFor();
      assert.equal(await page.locator('#svc-keys').inputValue(), ''); assert.ok(!(await page.locator('body').innerText()).includes('fixture-private-canary'));
      const type = Buffer.from('ssh-ed25519'), blob = Buffer.concat([Buffer.from([0,0,0,type.length]),type,Buffer.from([0,0,0,32]),Buffer.alloc(32,11)]);
      await page.locator('#svc-keys').fill('ssh-ed25519 ' + blob.toString('base64') + ' test client');
      await page.locator('#svc-listen').selectOption('0.0.0.0'); await button('Review changes').click(); await button('Install and enable').click();
      await page.locator('.tc-service-row').getByText('Locally ready', { exact: true }).waitFor();
    }
    await shot('ssh');
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
      const sshRow = page.locator('.tc-service-row').filter({ has: page.locator('.tc-service-name').filter({ hasText: /^SSH$/ }) });
      await button('Manage SSH').click(); await page.getByRole('menuitem', { name: 'Disable at startup', exact: true }).click();
      assert.equal(await button('Disable service').isDisabled(), true);
      await page.getByRole('checkbox', { name: 'I have another way to reach Setup or this container.', exact: true }).check(); await button('Disable service').click();
      await sshRow.getByText('Disabled', { exact: true }).waitFor();
      await button('Manage SSH').click(); await page.getByRole('menuitem', { name: 'Uninstall service…', exact: true }).click(); await button('Uninstall service').click();
      await sshRow.getByText('Payload removed', { exact: true }).waitFor();
      await button('Manage SSH').click(); await page.getByRole('menuitem', { name: 'Install again…', exact: true }).click();
      assert.ok((await page.locator('#svc-keys').inputValue()).startsWith('ssh-ed25519 '));
      await button('Review changes').click(); await button('Install and enable').click(); await sshRow.getByText('Locally ready', { exact: true }).waitFor();
    }
    await tab('Devices').click(); await page.getByText('Paired devices', { exact: true }).waitFor();
    await tab('Devices').focus(); await page.keyboard.press('ArrowRight'); await tab('Connections').waitFor();
    assert.equal(await tab('Connections').getAttribute('aria-selected'), 'true');
    assert.deepEqual(errors, [], tag + ': browser errors');
    checks.push({ width, theme, embedded, fontSize, checks: ['create literal argv', 'environment and Vault reference forms', 'review', 'lost submission recovery', 'stale status retains last-known rows', 'observed status', 'logs', 'stop for now', 'disable', 'remove', 'draft preservation', 'SSH key privacy', 'optional SSH install', 'connection review', 'client route and instructions', 'reported client test', 'route removal', 'Access tabs', 'keyboard tabs', 'geometry', 'no browser exceptions'] });
    await context.close(); console.log(JSON.stringify({ ok: true, ...checks.at(-1) }));
  }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(checks, null, 2) + '\n');
} finally {
  await browser?.close(); server.kill('SIGTERM'); if (server.exitCode === null) await once(server, 'exit');
}
