#!/usr/bin/env node
// Real credential API + disposable home; no real server or credential is used.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { credentialsFixture } from '../tests/fixtures/credentials.mjs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const { statusFor, portsFor, fixture, framed } = require('./lib/console-fixtures.cjs');
const output = process.env.T3_CREDENTIALS_UI_OUTPUT || '/tmp/t3-credentials-ui';
await fs.mkdir(output, { recursive: true });
const f = await credentialsFixture();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const secret = 'fixture-browser-password-123', token = 'fixture-browser-token-456';
try {
  for (const theme of ['light', 'dark']) for (const [width, height, embedded] of [[360, 720], [390, 844], [820, 900], [1280, 900], [1198, 878, true]].filter(size => !process.env.T3_CREDENTIALS_UI_WIDTH || size[0] === Number(process.env.T3_CREDENTIALS_UI_WIDTH))) {
    console.log(`Checking ${theme} ${width}x${height}${embedded ? ' embedded' : ''}`);
    for (const profile of (await (await f.request('/credentials')).json()).profiles) {
      const current = await (await f.request('/credentials')).json();
      assert.equal((await f.request('/credentials/remove', { id: profile.id, revision: current.revision })).status, 200);
    }
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
    const errors = [], responses = []; page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (/\/credentials(?:\/|$)/.test(new URL(response.url()).pathname)) responses.push(response.text().catch(() => '')); });
    await page.addInitScript(value => localStorage.setItem('t3-console-theme', value), theme);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/status')) return route.fulfill({ json: statusFor('ready') });
      if (url.pathname.endsWith('/providers')) return route.fulfill({ json: fixture('providers.json') });
      if (url.pathname.endsWith('/ports')) return route.fulfill({ json: portsFor('ready') });
      return route.continue();
    });
    const url = f.base + '/' + (embedded ? '?embed=t3&theme=' + theme : '') + '#credentials';
    const target = embedded ? await framed(page, url) : (await page.goto(url), page);
    await target.getByLabel('Setup key', { exact: true }).fill('credential-fixture-key');
    await target.getByRole('button', { name: 'Unlock', exact: true }).click();
    await target.getByText('Save a connection once', { exact: true }).waitFor();
    const capture = step => page.screenshot({ path: path.join(output, `${theme}-${width}${embedded ? '-embedded' : ''}-${step}.png`), fullPage: true });
    await capture('empty');
    const dialog = target.getByRole('dialog');
    const add = async (id, label, type = 'ssh') => {
      await target.getByRole('button', { name: 'Add connection', exact: true }).first().click();
      await dialog.waitFor(); await target.getByLabel('Name', { exact: true }).fill(label);
      await target.getByLabel('Connection ID', { exact: true }).fill(id);
      await target.getByLabel('Connection type').selectOption(type);
      if (type === 'ssh') { await target.getByLabel('Host', { exact: true }).fill('192.0.2.10'); await target.getByLabel('Username', { exact: true }).fill(id === 'homeserver' ? 'oliver' : 'root'); }
      else await target.getByLabel('API base URL').fill('http://192.0.2.20/api/');
      await target.locator('#credential-secret').fill(type === 'ssh' ? secret : token);
      await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' }); await target.locator(`[data-key="credential-${id}"]`).waitFor();
    };
    await add('homeserver', 'HomeServer'); await add('homeassistant-ssh', 'Home Assistant SSH'); await add('homeassistant', 'Home Assistant API', 'api');
    await capture('saved');
    assert.equal((await target.content()).includes(secret), false);
    assert.equal((await target.content()).includes(token), false);
    await target.getByRole('button', { name: 'Edit HomeServer', exact: true }).click();
    assert.equal(await target.locator('#credential-secret').inputValue(), '');
    assert.equal(await target.getByLabel('Connection ID', { exact: true }).isDisabled(), true);
    assert.equal(await target.getByLabel('Connection type').isDisabled(), true);
    const box = await dialog.boundingBox();
    assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1);
    const buttons = await dialog.getByRole('button', { name: 'Save connection', exact: true }).boundingBox();
    assert.ok(buttons.y + buttons.height <= height, 'Save stays visible while fields scroll');
    await capture('edit');
    // An overlapping editor must not silently replace another window's edit.
    const current = await (await f.request('/credentials')).json();
    const old = current.profiles.find(profile => profile.id === 'homeserver');
    await f.request('/credentials/save', { profile: { ...old, label: 'Updated elsewhere' }, revision: current.revision });
    await target.locator('#credential-secret').fill('replacement-fixture-password');
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await target.getByRole('alert').waitFor();
    assert.equal(await target.locator('#credential-secret').inputValue(), 'replacement-fixture-password');
    assert.equal((await target.getByRole('alert').innerText()).includes('replacement-fixture-password'), false);
    assert.equal(await target.locator('#credential-error').evaluate(el => document.activeElement === el), true);
    await capture('conflict');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await target.getByRole('button', { name: 'Reload', exact: true }).click();
    await target.getByRole('button', { name: 'Edit Updated elsewhere', exact: true }).waitFor();
    await target.getByRole('button', { name: 'Edit Updated elsewhere', exact: true }).click();
    await target.getByLabel('Name', { exact: true }).fill('HomeServer');
    // Saving twice while the request is pending still issues exactly one write.
    let release, started, saves = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { started = resolve; });
    const intercept = async route => { saves++; started(); await gate; await route.continue(); };
    await page.route('**/credentials/save', intercept);
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(new Error('Save request did not start: ' + theme + ' ' + width)), 5000).unref())]);
    await target.locator('#credential-secret').press('Enter'); await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 1); assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
    release(); await dialog.waitFor({ state: 'hidden' }); await page.unroute('**/credentials/save', intercept);
    assert.equal(saves, 1); await target.getByRole('button', { name: 'Edit HomeServer', exact: true }).waitFor();
    await page.route('**/credentials/test', route => route.fulfill({ json: { ok: true, message: 'Connection succeeded.' } }));
    await target.getByRole('button', { name: 'Test Home Assistant API', exact: true }).click();
    await target.getByText('Connection succeeded', { exact: true }).waitFor();
    const failRead = route => route.fulfill({ status: 500, json: { ok: false, error: 'Fixture read failed.' } });
    await page.route('**/credentials', failRead);
    await target.getByRole('button', { name: 'Reload', exact: true }).click(); await target.getByRole('alert').waitFor();
    assert.equal(await target.getByRole('button', { name: 'Edit HomeServer', exact: true }).isDisabled(), true);
    await capture('read-error'); await page.unroute('**/credentials', failRead);
    await target.getByRole('button', { name: 'Reload', exact: true }).click();
    await target.getByRole('button', { name: 'Delete Home Assistant SSH', exact: true }).click();
    await target.getByRole('alertdialog').getByRole('button', { name: 'Delete connection', exact: true }).click();
    await target.locator('[data-key="credential-homeassistant-ssh"]').waitFor({ state: 'hidden' });
    assert.equal(await target.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const response of await Promise.all(responses)) for (const value of [secret, token, 'replacement-fixture-password']) assert.equal(response.includes(value), false);
    assert.deepEqual(errors, []); await capture('after-delete');
    console.log(`PASS server credentials: ${theme} ${width}x${height}${embedded ? ' embedded' : ''}`);
    await page.close();
  }
  assert.equal(f.logs().includes(secret), false); assert.equal(f.logs().includes(token), false);
} finally { await browser.close(); await f.close(); }
