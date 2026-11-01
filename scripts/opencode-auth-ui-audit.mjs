#!/usr/bin/env node
// Real setup UI + disposable credential CLI. No real account or key is touched.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { authFixture } from '../tests/fixtures/opencode-auth.mjs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const output = process.env.T3_AUTH_UI_OUTPUT || '/tmp/t3-opencode-auth-ui';
await fs.mkdir(output, { recursive: true });
const f = await authFixture();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const initial = [{ id: 'anthropic', connections: [{ type: 'credential', id: 'cred_work', label: 'Work', method: 'oauth' }, { type: 'credential', id: 'cred_key', label: 'API key', method: 'key' }] },
  { id: 'openai', connections: [{ type: 'credential', id: 'cred_other', label: 'Personal', method: 'oauth' }] }];
try {
  for (const theme of ['light', 'dark']) for (const [width, height, embedded] of [[360, 720], [390, 844], [820, 900], [1280, 900], [1198, 878, true]]) {
    await fs.writeFile(f.stateFile, JSON.stringify(initial)); await f.mode({ gateList: true, failImport: true });
    await f.request('/providers?refresh=1');
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((value) => localStorage.setItem('t3-console-theme', value), theme);
    const capture = (step) => page.screenshot({ path: path.join(output, `${theme}-${width}${embedded ? '-embedded' : ''}-${step}.png`) });
    const sheet = page.locator('form[role="dialog"]');
    const saved = (provider) => page.locator(`[data-key="saved-${provider}"]`);
    await page.goto(f.base + '/' + (embedded ? '?embed=t3&theme=' + theme : '') + '#agents');
    await page.getByRole('textbox', { name: 'Setup key', exact: true }).fill('auth-fixture');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    // The first open races the saved-account read: the label follows it.
    await page.locator('[data-cmd="harness.apikey"][data-id="opencode"]').click();
    await sheet.waitFor();
    await page.getByText('Checking saved sign-ins…', { exact: true }).waitFor();
    assert.equal(await page.getByText('No saved sign-ins yet.', { exact: true }).count(), 0);
    await page.locator('#prov').fill('Anthropic'); await page.locator('.tc-option[data-provider="anthropic"]').click();
    const key = 'fixture-browser-key';
    await page.locator('#apikey').fill(key);
    await page.locator('#apikey').evaluate((input) => input.setSelectionRange(4, 4));
    await f.mode({ failImport: true });
    await saved('anthropic').getByText('2 saved accounts', { exact: true }).waitFor();
    assert.equal(await page.locator('#apikey').inputValue(), key);
    assert.equal(await page.locator('#apikey').evaluate((input) => input.selectionStart), 4);
    await capture('saved');
    await saved('anthropic').getByRole('button', { name: 'Remove saved sign-ins for Anthropic', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.getByText(/including API keys and browser sign-ins/).waitFor();
    assert.match(await confirmation.innerText(), /Other providers and environment credentials stay in place/);
    await capture('confirm');
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Save key', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('#apikey').inputValue(), key);
    assert.ok(!(await page.getByRole('alert').innerText()).includes(key));
    assert.equal(await page.locator('#key-error').evaluate((node) => document.activeElement === node), true);
    await capture('save-error');
    await f.mode({ gateImport: true });
    await page.getByRole('button', { name: 'Save key', exact: true }).click();
    await sheet.locator('[aria-busy="true"]').waitFor();
    assert.equal(await page.locator('#apikey').isDisabled(), true);
    assert.equal(await sheet.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape'); assert.equal(await sheet.count(), 1);
    assert.equal(await sheet.evaluate((panel) => panel.contains(document.activeElement)), true);
    // Browser navigation can close a sheet while its write still completes.
    // A later result must not dismiss a newly opened sheet or replace its draft.
    await page.evaluate(() => { location.hash = '#overview'; }); await sheet.waitFor({ state: 'hidden' });
    await page.evaluate(() => { location.hash = '#agents'; });
    await page.getByRole('button', { name: 'Manage keys', exact: true }).click();
    await page.locator('#apikey').fill('draft-for-the-new-sheet');
    const completedSave = page.waitForResponse((response) => response.url().endsWith('/auth/apikey'));
    await f.mode({}); await completedSave;
    await saved('anthropic').getByText('3 saved accounts', { exact: true }).waitFor();
    assert.equal(await page.locator('#apikey').inputValue(), 'draft-for-the-new-sheet');
    assert.equal(await page.locator('#apikey').isEnabled(), true);
    await f.mode({ gateLogout: true });
    await saved('anthropic').getByRole('button', { name: 'Remove saved sign-ins for Anthropic', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove sign-ins', exact: true }).click();
    await sheet.locator('[aria-busy="true"]').waitFor();
    await page.keyboard.press('Escape'); assert.equal(await sheet.count(), 1);
    await f.mode({});
    await saved('anthropic').waitFor({ state: 'hidden' }); await saved('openai').waitFor();
    assert.equal(await page.locator('#apikey').inputValue(), 'draft-for-the-new-sheet');
    await f.mode({ failList: true }); await f.request('/providers?refresh=1');
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Manage keys', exact: true }).click();
    await page.getByText('Could not check saved sign-ins.', { exact: false }).waitFor();
    await page.locator('#apikey').fill('draft-through-retry');
    await f.mode({}); await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await saved('openai').waitFor();
    assert.equal(await page.locator('#apikey').inputValue(), 'draft-through-retry');
    assert.equal(await saved('openai').getByRole('button').isEnabled(), true);
    const box = await sheet.boundingBox();
    assert.ok(box.x >= -1 && box.x + box.width <= width + 1 && box.y >= -1 && box.y + box.height <= height + 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await capture('after-remove');
    console.log(`PASS OpenCode credentials: ${theme} ${width}x${height} ${embedded ? 'embedded-query fallback' : 'standalone'}`);
    await page.close();
  }
} finally { await browser.close(); await f.close(); }
