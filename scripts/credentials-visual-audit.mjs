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
const isLoopback = host => ['127.0.0.1', 'localhost'].includes(host);
assert.ok(isLoopback(new URL(base).hostname), 'Visual fixtures must run on loopback.');
const output = process.env.T3_CREDENTIALS_VISUAL_OUTPUT || '/tmp/t3-credentials-visual'; await fs.mkdir(output, { recursive: true });
// Only the preview answers these without a key, and only with the fixture's names.
const identity = await (await fetch(new URL('/.well-known/t3/environment', base))).json();
assert.equal(identity.environmentId, 'fixture-preview', 'Run console-preview.mjs. This never runs against a real Setup.');
const fixture = await (await fetch(new URL('credentials', base))).json();
assert.deepEqual(fixture.credentials.map(row => row.id).sort(), ['app-db', 'build-server', 'cloudflare-token', 'github', 'kube-staging', 'old-box', 'project-api'], 'Use the seven-row console fixture.');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const themes = (process.env.T3_CREDENTIALS_VISUAL_THEMES || 'light,dark').split(',');
const cases = ['list', 'empty', 'inspect-ssh', 'inspect-api', 'inspect-rejected', 'add-start', 'add-detected', 'add-ssh', 'add-ssh-password', 'add-api', 'add-custom', 'conflict', 'host-key', 'delete'];
const MODES = { phone: { width: 390, height: 844, layout: 'compact', scale: 2 }, narrow: { width: 640, height: 800, layout: 'wide' }, tab: { width: 1040, height: 820, layout: 'wide' }, desktop: { width: 1280, height: 900, standalone: true } };
const requestedModes = (process.env.T3_CREDENTIALS_VISUAL_MODES || Object.keys(MODES).join(',')).split(',');
const fakeToken = 'ghp_' + 'syntheticfixture'.repeat(3);
const DETAILS = { 'inspect-ssh': 'build-server', 'inspect-api': 'project-api', 'inspect-rejected': 'github', 'host-key': 'old-box', delete: 'project-api', conflict: 'build-server' };
// Each add case hides the row it would otherwise collide with.
const HIDDEN = { 'add-ssh': 'build-server', 'add-ssh-password': 'old-box', 'add-api': 'project-api', 'add-detected': 'github' };
let captures = 0;
try {
  for (const theme of themes) for (const mode of requestedModes) for (const state of cases) {
    if (process.env.T3_CREDENTIALS_VISUAL_STATES && !process.env.T3_CREDENTIALS_VISUAL_STATES.split(',').includes(state)) continue;
    const { width, height, layout, scale = 1, standalone } = MODES[mode];
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce', colorScheme: theme });
    const errors = [], outside = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('t3-console-theme', value), theme);
    await page.addInitScript(value => { const NativeDate = Date; window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [value])); } static now() { return value; } }; }, Date.parse(fixture.credentials.find(row => row.id === 'build-server').test.at) + 120000);
    await page.route('**/*', route => { const { hostname, href } = new URL(route.request().url()); if (isLoopback(hostname)) return route.fallback(); outside.push(href); return route.abort(); });
    await page.route('**/credentials', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const credentials = state === 'empty' ? [] : fixture.credentials.filter(row => row.id !== HIDDEN[state]);
      return route.fulfill({ json: { ...fixture, credentials } });
    });
    const url = new URL(base); url.hash = 'vault';
    if (!standalone) url.search = 'embed=t3&host=tab&layout=' + layout + '&theme=' + theme;
    const target = standalone ? (await page.goto(url.href), page) : await framed(page, url.href);
    await target.locator('#page-vault:not([hidden]) .tc-page-title').waitFor();
    assert.equal((await target.locator('#page-vault .tc-page-title').textContent()).trim(), 'Vault');
    if (state === 'empty') await target.getByRole('button', { name: 'Add credential…', exact: true }).waitFor();
    else await target.locator('[data-cred-action="inspect"]').first().waitFor();
    await target.locator('#page-vault .tc-page-title').click();
    if (DETAILS[state]) { await target.locator('[data-cred-action="inspect"][data-id="' + DETAILS[state] + '"]').click(); await target.locator('.tc-cred-inspector').waitFor(); }
    if (state === 'host-key') { await target.locator('.tc-cred-inspector [data-cred-inspect="review"]').click(); await target.locator('.tc-cred-dialog [data-cred-key="trust"]:enabled').waitFor(); }
    if (state === 'delete') { await target.locator('.tc-cred-inspector [data-cred-inspect="menu"]').click(); await target.getByRole('menuitem', { name: 'Delete…', exact: true }).click(); await target.getByRole('alertdialog').waitFor(); }
    if (state.startsWith('add')) {
      await target.getByRole('button', { name: 'Add credential', exact: true }).click(); const editor = target.locator('.tc-cred-editor');
      await editor.locator('#cred-paste').waitFor();
      const pick = async type => { await editor.locator('[data-cred-editor="pick-type"][data-value="' + type + '"]').click(); await editor.locator('#cred-id').waitFor(); };
      const signIn = choice => editor.locator('label.tc-cred-option', { has: target.locator('input[data-cred-editor="signin"][value="' + choice + '"]') }).click();
      if (state === 'add-detected') {
        await editor.locator('#cred-paste').evaluate((el, value) => { el.value = value; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })); }, fakeToken);
        await editor.locator('.tc-cred-detect').waitFor();
        assert.equal(await editor.locator('#cred-id').inputValue(), 'github');
      }
      if (state === 'add-ssh') {
        await pick('ssh'); await editor.locator('#cred-id').fill('build-server');
        await editor.locator('#cred-fields-host').fill('127.0.0.10'); await editor.locator('#cred-fields-username').fill('deploy');
        await editor.locator('.tc-cred-install code').waitFor();
        await editor.locator('[data-cred-editor="test"]').click(); await editor.getByText('Pinned on first use. A different key later blocks it.', { exact: true }).waitFor();
      }
      if (state === 'add-ssh-password') {
        await pick('ssh'); await editor.locator('#cred-id').fill('old-box'); await signIn('password');
        await editor.locator('#cred-fields-host').fill('127.0.0.20'); await editor.locator('#cred-fields-username').fill('root'); await editor.locator('#cred-secrets-password').fill('synthetic-visual-fixture');
        await editor.locator('[data-cred-editor="test"]').click();
        await editor.getByLabel('Trust this host key', { exact: true }).check(); await editor.getByText('Signed in as root', { exact: true }).waitFor();
      }
      if (state === 'add-api') {
        await pick('token'); await editor.locator('#cred-id').fill('project-api'); await editor.locator('#cred-secrets-token').fill('synthetic-visual-fixture');
        await editor.locator('#cred-fields-baseUrl').fill('http://127.0.0.1:8787/v1/');
        await editor.getByRole('button', { name: 'Header', exact: true }).click(); await editor.locator('#cred-fields-authName').fill('X-API-Key'); await editor.locator('#cred-fields-testPath').fill('account');
        await editor.locator('[data-cred-editor="test"]').click(); await editor.getByText('Connected · HTTP 200', { exact: true }).waitFor();
      }
      if (state === 'add-custom') {
        await pick('custom'); await editor.locator('#cred-id').fill('deploy-env');
        await editor.locator('[data-cred-field="vars.0.name"]').fill('DEPLOY_TOKEN'); await editor.locator('[data-cred-field="vars.0.value"]').fill('synthetic-visual-fixture');
        await editor.getByRole('button', { name: 'Add variable', exact: true }).click();
        await editor.locator('[data-cred-field="vars.1.name"]').fill('DEPLOY_REGION'); await editor.locator('[data-cred-editor="var-secret"][data-index="1"]').click(); await editor.locator('[data-cred-field="vars.1.value"]').fill('eu-west-1');
      }
    }
    if (state === 'conflict') {
      const details = target.locator('.tc-cred-inspector'), editor = target.locator('.tc-cred-editor');
      if (await details.locator('[data-cred-inspect="edit"]').isVisible()) await details.locator('[data-cred-inspect="edit"]').click();
      else { await details.locator('[data-cred-inspect="menu"]').click(); await target.getByRole('menuitem', { name: 'Edit…', exact: true }).click(); }
      await editor.getByRole('button', { name: 'Replace…', exact: true }).click(); await editor.locator('#cred-secrets-privateKey').fill('synthetic-replacement');
      const original = fixture.credentials.find(row => row.id === 'build-server');
      await page.route('**/credentials/save', route => route.fulfill({ status: 409, json: { ok: false, code: 'changed', error: 'Changed elsewhere.', current: { ...original, fields: { ...original.fields, host: '127.0.0.11' }, updatedAt: new Date().toISOString(), secretChangedAt: new Date().toISOString(), revision: '0123456789abcdef' } } }));
      await editor.locator('[data-cred-editor="save"]').click(); await editor.locator('#cred-conflict').waitFor();
    }
    await target.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const geometry = await target.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1, text: document.documentElement.innerText, panels: [...document.querySelectorAll('.tc-cred-editor,.tc-cred-dialog,.tc-cred-inspector')].map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }) }));
    assert.equal(geometry.overflow, false, 'horizontal overflow: ' + state + ' at ' + mode); for (const r of geometry.panels) assert.ok(r.x >= -1 && r.y >= -1 && r.right <= width + 1 && r.bottom <= height + 1, JSON.stringify(r));
    assert.doesNotMatch(geometry.text, /\bt3-(?:ssh|api)\b/, 'old helper names: ' + state + ' at ' + mode);
    assert.ok(!geometry.text.includes(fakeToken) && !geometry.text.includes('synthetic-visual-fixture') && !geometry.text.includes('synthetic-replacement'), 'a typed secret is on the page: ' + state + ' at ' + mode);
    const file = path.join(output, `${theme}-${mode}-${state}.png`);
    if (standalone) await page.screenshot({ path: file }); else await page.locator('iframe').screenshot({ path: file });
    captures++;
    assert.deepEqual(errors, []); assert.deepEqual(outside, [], 'the preview must not reach outside loopback'); await page.close(); console.log('PASS visual ' + theme + ' ' + mode + ' ' + state);
  }
  console.log('PASS ' + captures + ' aligned Vault visual captures');
} finally { await browser.close(); }
