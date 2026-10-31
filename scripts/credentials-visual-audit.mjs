#!/usr/bin/env node
// Captures the real console with explicitly synthetic in-memory fixture data.
// Run console-preview.mjs first. Never point this at a production Setup URL.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const { framed } = require('./lib/console-fixtures.cjs');
const base = process.argv[2] || 'http://127.0.0.1:23966/__setup/';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Visual fixtures must run on loopback.');
const output = process.env.T3_CREDENTIALS_VISUAL_OUTPUT || '/tmp/t3-credentials-visual'; await fs.mkdir(output, { recursive: true });
const fixture = await (await fetch(new URL('credentials', base))).json();
assert.equal(fixture.credentials.length, 5, 'Use the five-row console fixture.');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const themes = (process.env.T3_CREDENTIALS_VISUAL_THEMES || 'light,dark').split(',');
const cases = ['list', 'empty', 'inspect-ssh', 'inspect-api', 'add-ssh', 'add-api', 'conflict', 'host-key', 'delete'];
let captures = 0;
try {
  for (const theme of themes) for (const mode of ['tab', 'phone']) for (const state of mode === 'phone' ? ['list', 'inspect-api', 'add-ssh'] : cases) {
    if (process.env.T3_CREDENTIALS_VISUAL_STATES && !process.env.T3_CREDENTIALS_VISUAL_STATES.split(',').includes(state)) continue;
    const width = mode === 'tab' ? 1040 : 390, height = mode === 'tab' ? 820 : 844;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: mode === 'phone' ? 2 : 1, reducedMotion: 'reduce', colorScheme: theme });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('t3-console-theme', value), theme);
    await page.addInitScript(value => { const NativeDate = Date; window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [value])); } static now() { return value; } }; }, Date.parse(fixture.credentials.find(row => row.id === 'build-server').test.at) + 120000);
    await page.route('**/credentials', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const credentials = state === 'empty' ? [] : fixture.credentials.filter(row => !(state === 'add-ssh' && row.id === 'build-server') && !(state === 'add-api' && row.id === 'project-api'));
      return route.fulfill({ json: { ...fixture, credentials } });
    });
    const url = new URL(base); url.search = 'embed=t3&host=tab&layout=' + (mode === 'phone' ? 'compact' : 'wide') + '&theme=' + theme; url.hash = 'credentials';
    const target = await framed(page, url.href);
    await target.locator('#page-credentials:not([hidden]) .tc-page-title').waitFor();
    await target.getByText(state === 'empty' ? 'Keep secrets out of chats and skills' : 'Search credentials', { exact: true }).count();
    if (state === 'empty') await target.getByRole('button', { name: 'Add credential…', exact: true }).waitFor();
    else await target.locator('[data-cred-action="inspect"]').first().waitFor();
    await target.locator('#page-credentials .tc-page-title').click();
    if (state.startsWith('inspect') || state === 'host-key' || state === 'delete' || state === 'conflict') {
      const id = state === 'inspect-ssh' || state === 'conflict' ? 'build-server' : state === 'host-key' ? 'staging-server' : mode === 'phone' ? 'home-assistant' : 'project-api';
      await target.locator('[data-cred-action="inspect"][data-id="' + id + '"]').click(); await target.locator('.tc-cred-inspector').waitFor();
    }
    if (state === 'host-key') { await target.locator('.tc-cred-inspector [data-cred-inspect="review"]').click(); await target.locator('.tc-cred-dialog [data-cred-key="trust"]:enabled').waitFor(); }
    if (state === 'delete') { await target.locator('.tc-cred-inspector [data-cred-inspect="menu"]').click(); await target.getByRole('menuitem', { name: 'Delete…', exact: true }).click(); await target.getByRole('alertdialog').waitFor(); }
    if (state.startsWith('add')) {
      await target.getByRole('button', { name: 'Add credential', exact: true }).click(); const editor = target.locator('.tc-cred-editor');
      await editor.getByLabel('Name', { exact: true }).fill(state === 'add-ssh' ? 'build-server' : 'project-api');
      if (state === 'add-api') {
        await editor.getByRole('button', { name: 'HTTP API', exact: true }).click(); await editor.getByLabel('Base URL', { exact: true }).fill('https://api.example.com/v1/');
        await editor.getByRole('button', { name: 'Header', exact: true }).click(); await editor.getByLabel('Header name', { exact: true }).fill('X-API-Key'); await editor.getByLabel('GET test path (optional)', { exact: true }).fill('account');
      } else { await editor.getByLabel('Host', { exact: true }).fill('192.0.2.10'); await editor.getByLabel('Username', { exact: true }).fill('deploy'); }
      await editor.locator('#cred-secret').fill('synthetic-visual-fixture');
      await editor.locator('[data-cred-editor="test"]').click();
      if (state === 'add-ssh') { await editor.getByLabel('Trust this host key', { exact: true }).check(); await editor.getByText('Signed in as deploy', { exact: true }).waitFor(); }
      else await editor.getByText('Connected · HTTP 200', { exact: true }).waitFor();
    }
    if (state === 'conflict') {
      await target.locator('.tc-cred-inspector [data-cred-inspect="edit"]').click(); const editor = target.locator('.tc-cred-editor');
      await editor.getByRole('button', { name: 'Replace…', exact: true }).click(); await editor.locator('#cred-secret').fill('synthetic-replacement');
      const original = fixture.credentials.find(row => row.id === 'build-server');
      await page.route('**/credentials/save', route => route.fulfill({ status: 409, json: { ok: false, code: 'changed', error: 'Changed elsewhere.', current: { ...original, host: '192.0.2.11', updatedAt: new Date().toISOString(), secretChangedAt: new Date().toISOString(), revision: '0123456789abcdef' } } }));
      await editor.locator('[data-cred-editor="save"]').click(); await editor.locator('#cred-conflict').waitFor();
    }
    await target.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const geometry = await target.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, panels: [...document.querySelectorAll('.tc-cred-editor,.tc-cred-dialog,.tc-cred-inspector')].map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }) }));
    assert.equal(geometry.overflow, false); for (const r of geometry.panels) assert.ok(r.x >= -1 && r.y >= -1 && r.right <= width + 1 && r.bottom <= height + 1, JSON.stringify(r));
    await page.locator('iframe').screenshot({ path: path.join(output, `${theme}-${mode}-${state}.png`) }); captures++;
    assert.deepEqual(errors, []); await page.close(); console.log('PASS visual ' + theme + ' ' + mode + ' ' + state);
  }
  console.log('PASS ' + captures + ' aligned Credentials visual captures');
} finally { await browser.close(); }
