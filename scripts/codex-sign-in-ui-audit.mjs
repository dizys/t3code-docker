#!/usr/bin/env node
// Real setup UI + disposable home: the Codex row when T3 Code uses its own
// ChatGPT connection. No real account, key or T3 Code settings file is touched.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { authFixture } from '../tests/fixtures/opencode-auth.mjs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const output = process.env.T3_CODEX_SIGNIN_UI_OUTPUT || '/tmp/t3-codex-sign-in-ui';
await fs.mkdir(output, { recursive: true });
const f = await authFixture();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const settingsFile = path.join(f.home, '.t3/userdata/settings.json');
const settings = () => fs.readFile(settingsFile, 'utf8').then(JSON.parse);
const managed = async () => fs.writeFile(settingsFile, JSON.stringify({ providerInstances: { codex: { driver: 'codex', config: { setupMode: 'managed' } } } }));
// The fixture's latest release is 2.0.32, so this Codex has nothing to update.
const codex = (authenticated = true) => ({ codex: { id: 'codex', name: 'Codex', installed: true, configured: true, runnable: true, installedVersion: '2.0.32', executable: f.executable, authenticated } });
const STATUS = 'Signed in · Not used by T3 Code';
// A sign-in that changes anywhere refreshes the rows at once; a removal with
// nothing to remove is the cheapest one, and leaves the row's own facts to show.
const prepare = async (authenticated) => {
  await managed();
  await f.facts(codex(authenticated));
  await f.request('/auth/apikey/remove', { agent: 'pi', provider: 'openrouter' });
};
let runs = 0;
try {
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  for (const theme of ['light', 'dark']) for (const [width, height, embedded] of [[360, 720], [390, 844], [820, 900], [1280, 900], [1198, 878, true]]) {
    await prepare(true);
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((value) => localStorage.setItem('t3-console-theme', value), theme);
    const capture = (step) => page.screenshot({ path: path.join(output, `${theme}-${width}${embedded ? '-embedded' : ''}-${step}.png`) });
    await page.goto(f.base + '/' + (embedded ? '?embed=t3&theme=' + theme : '') + '#agents');
    await page.getByRole('textbox', { name: 'Setup key', exact: true }).fill('auth-fixture');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    const row = page.locator('[data-key="row-harness:codex"]').filter({ visible: true });
    const button = row.getByRole('button', { name: 'Use in T3 Code', exact: true });
    await button.waitFor();
    assert.match(await row.innerText(), new RegExp(STATUS));
    await capture('row');
    const fits = await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1);
    assert.ok(fits, 'the row and page fit without scrolling sideways');

    // Cancelling changes nothing and hands focus back.
    await button.click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText(/instead of its own ChatGPT connection/).waitFor();
    assert.match(await dialog.innerText(), /saved connection isn.t deleted/);
    await capture('confirm');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await settings()).providerInstances.codex.config.setupMode, 'managed');
    assert.equal(await button.evaluate((node) => document.activeElement === node), true);

    // The sign-in went away behind the page: the failure is said and nothing moves.
    await f.facts(codex(false));
    await button.click();
    await dialog.getByRole('button', { name: 'Use this sign-in', exact: true }).click();
    await page.getByText(/Sign in to Codex first/).first().waitFor();
    await capture('refused');
    assert.equal((await settings()).providerInstances.codex.config.setupMode, 'managed');
    await row.getByRole('button', { name: 'Sign in', exact: true }).waitFor();

    // Signed in again, the row offers the switch once more, and it takes.
    await prepare(true);
    await button.waitFor({ timeout: 30000 });
    await button.click();
    await dialog.getByRole('button', { name: 'Use this sign-in', exact: true }).click();
    await page.getByText('T3 Code now uses this Codex sign-in').first().waitFor();
    assert.equal((await settings()).providerInstances.codex.config.setupMode, 'existing');
    await row.getByText('Signed in', { exact: true }).waitFor();
    assert.equal(await button.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-key')), 'menu-harness:codex', 'focus lands on the row, not the page');
    await capture('switched');
    assert.deepEqual(errors, []);
    await page.close();
    runs++;
    console.log(`${theme} ${width}${embedded ? ' embedded' : ''}: row, confirmation, refusal and switch passed`);
  }
  console.log(`Codex sign-in audit passed (${runs} layouts). Screens: ${output}`);
} finally {
  await browser.close();
  await f.close();
}
