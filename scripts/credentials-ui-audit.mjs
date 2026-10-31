#!/usr/bin/env node
// Real Setup API, private disposable home and loopback API. SSH handshakes in
// the trust-dialog cases are intercepted; no external service is contacted.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { credentialsFixture } from '../tests/fixtures/credentials.mjs';
import { createCredentialStore } from '../docker/setup/credentials.mjs';
import { credentialKey } from '../tests/fixtures/credential-keys.mjs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const { statusFor, portsFor, fixture, framed } = require('./lib/console-fixtures.cjs');
const output = process.env.T3_CREDENTIALS_UI_OUTPUT || '/tmp/t3-credentials-ui';
await fs.mkdir(output, { recursive: true });
const f = await credentialsFixture(), directory = path.join(f.env.T3CODE_HOME, 'server-credentials');
let clock = Date.now(); const store = createCredentialStore({ directory, clock: () => clock });
const secret = 'fixture-browser-password-123', token = 'fixture-browser-token-456', replacement = 'fixture-replacement-private-789';
const loopback = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
loopback.listen(0, '127.0.0.1'); await once(loopback, 'listening');
const localApi = 'http://127.0.0.1:' + loopback.address().port + '/v1/';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const variants = [[1280, 900, 'standalone'], [1024, 768, 'standalone'], [744, 900, 'standalone'], [390, 844, 'standalone'], [360, 720, 'standalone'], [1198, 878, 'embedded'], [480, 760, 'tab'], [639, 800, 'tab'], [640, 800, 'tab'], [704, 800, 'tab'], [1040, 820, 'tab']];
const themes = (process.env.T3_CREDENTIALS_UI_THEMES || 'light,dark').split(',');
const requestedWidths = (process.env.T3_CREDENTIALS_UI_WIDTHS || process.env.T3_CREDENTIALS_UI_WIDTH || '').split(',').filter(Boolean).map(Number);
const selected = variants.filter(([width]) => !requestedWidths.length || requestedWidths.includes(width));
async function seed() {
  for (const row of (await store.list()).credentials) await store.remove({ id: row.id, revision: row.revision });
  const key = credentialKey(), next = credentialKey();
  for (const profile of fixture('credentials.json').credentials) {
    clock = Date.parse('2026-10-26T18:04:11Z');
    const saved = (await store.save({ create: true, credential: { ...profile, secret: profile.type === 'ssh' ? secret : token } })).credential;
    if (profile.type === 'ssh') await store.trust({ id: profile.id, revision: saved.revision, key });
    if (profile.test) {
      clock = Date.now() - (profile.id === 'build-server' ? 120000 : profile.id === 'home-assistant' ? 86400000 : 3600000);
      const result = profile.test.code === 'host-key-changed' ? { ...profile.test, detail: { trusted: { type: key.type, fingerprint: key.fingerprint }, presented: { type: next.type, fingerprint: next.fingerprint } } } : profile.test;
      await store.recordTest({ id: profile.id, revision: saved.revision, hostFingerprint: profile.type === 'ssh' ? key.fingerprint : undefined, result });
    }
  }
  clock = Date.now(); return { key, next };
}
async function geometry(target, width, height, label) {
  const problems = await target.evaluate(({ width, height }) => {
    const errors = [], rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('document overflows');
    for (const panel of document.querySelectorAll('.tc-cred-editor,.tc-cred-inspector,.tc-cred-dialog')) {
      const r = rect(panel); if (r.x < -1 || r.y < -1 || r.right > width + 1 || r.bottom > height + 1) errors.push('panel outside viewport: ' + JSON.stringify(r));
      const foot = panel.querySelector('.tc-wizard-foot'); if (foot && rect(foot).bottom > height + 1) errors.push('save footer outside viewport');
      if (panel.scrollWidth > panel.clientWidth + 2) errors.push('panel content overflows');
    }
    for (const row of document.querySelectorAll('.tc-cred-row')) {
      const parts = [...row.children].map(rect).filter(r => r.width > 0 && r.height > 0);
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (Math.min(parts[i].right, parts[j].right) - Math.max(parts[i].x, parts[j].x) > 1 && Math.min(parts[i].bottom, parts[j].bottom) - Math.max(parts[i].y, parts[j].y) > 1) errors.push('row columns overlap');
    }
    return errors;
  }, { width, height });
  assert.deepEqual(problems, [], label); checks++;
}
try {
  for (const theme of themes) for (const [width, height, mode] of selected) {
    console.log('Checking ' + theme + ' ' + width + ' ' + mode);
    const keys = await seed();
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
    const pageErrors = [], responseBodies = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => { if (/\/credentials(?:\/|$)/.test(new URL(response.url()).pathname)) responseBodies.push(response.text().catch(() => '')); });
    await page.addInitScript(value => localStorage.setItem('t3-console-theme', value), theme);
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__credentialCopy = value; } } }));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/status')) return route.fulfill({ json: { ...statusFor('ready'), credentials: await store.summary() } });
      if (url.pathname.endsWith('/providers')) return route.fulfill({ json: fixture('providers.json') });
      if (url.pathname.endsWith('/ports')) return route.fulfill({ json: portsFor('ready') });
      return route.continue();
    });
    const embedded = mode !== 'standalone', url = f.base + '/' + (embedded ? '?embed=t3&theme=' + theme + (mode === 'tab' ? '&host=tab&layout=wide' : '') : '') + '#credentials';
    const target = embedded ? await framed(page, url) : (await page.goto(url), page);
    const capture = name => page.screenshot({ path: path.join(output, `${theme}-${width}-${mode}-${name}.png`), fullPage: true });
    await target.getByLabel('Setup key', { exact: true }).fill('credential-fixture-key'); await target.getByRole('button', { name: 'Unlock', exact: true }).click();
    await target.locator('[data-cred-action="inspect"][data-id="build-server"]').waitFor();
    await geometry(target, width, height, 'list'); await capture('list');
    const search = target.getByRole('searchbox', { name: 'Search credentials' });
    await search.fill('X-API-Key'); check(await target.locator('.tc-cred-row,.tc-cred-prow').count() === 1, 'search matches secret kind'); await search.fill('');
    await target.getByRole('button', { name: 'Needs attention 2', exact: true }).click(); check(await target.locator('.tc-cred-row,.tc-cred-prow').count() === 2, 'attention filter');
    await target.getByRole('button', { name: 'Needs attention 2', exact: true }).click();
    await target.locator('[data-cred-action="inspect"][data-id="project-api"]').click();
    const inspector = target.locator('.tc-cred-inspector'); await inspector.waitFor(); await geometry(target, width, height, 'inspector'); await capture('inspect-api');
    check((await inspector.locator('.tc-cred-request').textContent()).includes('••••••••'), 'request has mask');
    await inspector.getByRole('button', { name: 'Copy snippet', exact: true }).click();
    check((await target.evaluate(() => window.__credentialCopy)).includes('t3-api project-api'), 'snippet uses name');
    await inspector.getByRole('button', { name: 'Close credential details' }).click();
    const edit = async id => {
      await target.locator('[data-cred-action="inspect"][data-id="' + id + '"]').click();
      const details = target.locator('.tc-cred-inspector');
      if (await details.locator('[data-cred-inspect="edit"]').isVisible()) await details.locator('[data-cred-inspect="edit"]').click();
      else { await details.locator('[data-cred-inspect="menu"]').click(); await target.getByRole('menuitem', { name: 'Edit…', exact: true }).click(); }
      await target.locator('.tc-cred-editor').waitFor();
    };
    await edit('build-server');
    let editor = target.locator('.tc-cred-editor');
    check(await editor.locator('#cred-id').count() === 0, 'saved name is locked');
    await editor.getByRole('button', { name: 'Replace…', exact: true }).click();
    check(await editor.locator('#cred-secret').inputValue() === '', 'replacement starts empty');
    await editor.locator('#cred-secret').fill(replacement); await editor.getByRole('button', { name: 'Show newly typed password' }).click();
    check(await editor.locator('#cred-secret').getAttribute('type') === 'text', 'reveal only typed password');
    check(!(await target.content()).includes(replacement), 'typed secret absent from markup');
    await geometry(target, width, height, 'editor'); await capture('edit-ssh');
    const current = await store.public('build-server');
    await store.save({ credential: { ...current, username: 'deploy-next' }, revision: current.revision });
    await editor.locator('[data-cred-editor="save"]').click(); await editor.locator('#cred-conflict').waitFor();
    check((await editor.locator('#cred-conflict').innerText()).includes('deploy-next'), 'conflict explains field change');
    check(await editor.locator('#cred-secret').inputValue() === replacement, 'conflict keeps draft secret'); await capture('conflict');
    await editor.getByRole('button', { name: 'Use theirs', exact: true }).click();
    check(await editor.locator('#cred-secret').inputValue() === replacement, 'use theirs keeps typed secret when saved secret unchanged');
    const newer = await store.public('build-server');
    await store.save({ credential: { ...newer, secret: 'external-replacement-synthetic' }, revision: newer.revision });
    await editor.locator('[data-cred-editor="save"]').click(); await editor.locator('#cred-conflict').waitFor();
    await editor.getByRole('button', { name: 'Use theirs', exact: true }).click();
    check(await editor.locator('#cred-secret').count() === 0, 'use theirs clears typed secret if theirs replaced it');
    await editor.getByRole('button', { name: 'Close credential editor' }).click(); await editor.waitFor({ state: 'hidden' });
    await edit('build-server'); editor = target.locator('.tc-cred-editor');
    await editor.getByLabel('Username', { exact: true }).fill('draft-user');
    const latest = await store.public('build-server');
    await store.save({ credential: { ...latest, username: 'edited-elsewhere' }, revision: latest.revision });
    await editor.locator('[data-cred-editor="save"]').click(); await editor.locator('#cred-conflict').waitFor();
    await editor.getByRole('button', { name: 'Keep mine', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
    check((await store.forUse('build-server')).username === 'draft-user', 'Keep mine saves the draft against the reviewed revision');
    check((await store.forUse('build-server')).secret === 'external-replacement-synthetic', 'Keep mine without a replacement keeps the current saved secret');
    await target.getByRole('button', { name: 'Add credential', exact: true }).click(); editor = target.locator('.tc-cred-editor');
    await editor.getByLabel('Name', { exact: true }).fill('Fixture Login');
    check(await editor.getByLabel('Name', { exact: true }).inputValue() === 'fixture-login', 'name normalized as typed');
    await editor.getByLabel('Host', { exact: true }).fill('192.0.2.30'); await editor.getByLabel('Username', { exact: true }).fill('deploy'); await editor.locator('#cred-secret').fill(secret);
    await editor.getByRole('button', { name: 'HTTP API', exact: true }).click();
    check(await editor.getByLabel('Name', { exact: true }).inputValue() === 'fixture-login', 'type switch retains name'); check(await editor.locator('#cred-secret').inputValue() === '', 'type switch clears password');
    await editor.getByLabel('Base URL', { exact: true }).fill(localApi); await editor.getByRole('button', { name: 'Header', exact: true }).click();
    await editor.getByLabel('Header name', { exact: true }).fill('X-API-Key'); await editor.locator('#cred-secret').fill(token);
    await editor.getByRole('button', { name: 'Query parameter', exact: true }).click(); check(await editor.locator('#cred-secret').inputValue() === token, 'auth switch retains newly typed key');
    await editor.getByRole('button', { name: 'Header', exact: true }).click(); await editor.getByLabel('GET test path (optional)', { exact: true }).fill('account');
    const beforeTest = await store.list();
    await editor.locator('[data-cred-editor="test"]').click(); await editor.getByText('Connected · HTTP 200', { exact: true }).waitFor();
    check(JSON.stringify(await store.list()) === JSON.stringify(beforeTest), 'draft testing writes nothing');
    if (width < (mode === 'tab' ? 640 : 1024)) {
      const feedback = await editor.locator('.tc-cred-test-line').evaluate(el => { const r = el.getBoundingClientRect(), foot = document.querySelector('.tc-cred-editor .tc-wizard-foot').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, actions: foot.top }; });
      await capture('draft-tested');
      check(feedback.top >= -1 && feedback.bottom <= feedback.actions + 1, 'phone test feedback is visible above pinned actions: ' + JSON.stringify(feedback));
    }
    // Delay the actual write. Enter/Escape and a second submit cannot duplicate it.
    let release, arrived, saves = 0; const gate = new Promise(resolve => { release = resolve; }), arrival = new Promise(resolve => { arrived = resolve; });
    const hold = async route => { saves++; arrived(); await gate; await route.continue(); };
    await page.route('**/credentials/create', hold); await editor.locator('[data-cred-editor="save"]').click(); await arrival;
    await editor.dispatchEvent('submit'); await page.keyboard.press('Escape');
    check(await editor.locator('#cred-secret').isDisabled(), 'fields disabled while saving'); check(await editor.locator('[data-cred-editor="close"]').first().isDisabled(), 'cannot close an unsettled save');
    release(); await editor.waitFor({ state: 'hidden' }); await page.unroute('**/credentials/create', hold); check(saves === 1, 'save submitted exactly once');
    await target.locator('[data-cred-action="inspect"][data-id="fixture-login"]').waitFor();
    check((await store.forUse('fixture-login')).secret === token, 'real API saved the new key');
    await edit('fixture-login'); editor = target.locator('.tc-cred-editor');
    await editor.getByLabel('Base URL', { exact: true }).fill(localApi + 'changed/');
    await editor.getByRole('button', { name: 'Close credential editor' }).click();
    await target.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click(); check(await editor.isVisible(), 'cancel discard keeps draft');
    await editor.getByRole('button', { name: 'Close credential editor' }).click(); await target.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
    // Review a key that changes again while the person decides. No SSH auth.
    await target.locator('[data-cred-action="inspect"][data-id="staging-server"]').click();
    const presented = { type: keys.next.type, fingerprint: keys.next.fingerprint }, third = credentialKey();
    await page.route('**/credentials/scan', route => route.fulfill({ json: { ok: true, hostKey: { state: 'changed', trusted: { type: keys.key.type, fingerprint: keys.key.fingerprint }, presented } } }));
    let trustCalls = 0;
    await page.route('**/credentials/trust', async route => {
      trustCalls++;
      if (trustCalls === 1) return route.fulfill({ status: 409, json: { ok: false, code: 'key-changed', error: 'The key changed again.', presented: { type: third.type, fingerprint: third.fingerprint } } });
      check(route.request().postDataJSON().fingerprint === third.fingerprint, 'trust uses the new displayed fingerprint');
      const saved = await store.public('staging-server');
      if (trustCalls === 2) {
        const current = (await store.save({ credential: { ...saved, host: '192.0.2.31' }, revision: saved.revision })).credential;
        return route.fulfill({ status: 409, json: { ok: false, code: 'changed', error: 'The host was edited elsewhere.', current } });
      }
      check(route.request().postDataJSON().revision === saved.revision, 'trust binds the refreshed connection revision');
      await store.trust({ id: saved.id, revision: saved.revision, key: third });
      return route.fulfill({ json: { ok: true, hostKey: (await store.public(saved.id)).hostKey } });
    });
    await target.locator('.tc-cred-inspector').getByRole('button', { name: 'Review…', exact: true }).click();
    const trustDialog = target.locator('.tc-cred-dialog'); await trustDialog.getByText(presented.fingerprint, { exact: false }).waitFor();
    await trustDialog.getByRole('button', { name: 'Trust new key', exact: true }).waitFor({ state: 'visible' });
    check(await trustDialog.getByRole('button', { name: 'Keep blocking', exact: true }).evaluate(el => document.activeElement === el), 'host-key review focuses keep blocking');
    await geometry(target, width, height, 'host-key review'); await capture('host-key');
    await trustDialog.getByRole('button', { name: 'Trust new key', exact: true }).click(); await trustDialog.getByText('The key changed again.', { exact: false }).waitFor();
    check((await trustDialog.innerText()).includes(third.fingerprint), 'new fingerprint shown after a trust conflict');
    await trustDialog.getByRole('button', { name: 'Trust new key', exact: true }).click();
    await trustDialog.getByRole('button', { name: 'Review current host', exact: true }).waitFor();
    check(await trustDialog.locator('[data-cred-key="trust"]').count() === 0, 'stale host cannot be trusted');
    await page.route('**/credentials/scan', async route => {
      const current = await store.public('staging-server');
      check(route.request().postDataJSON().revision === current.revision, 'review scans the current revision');
      return route.fulfill({ json: { ok: true, hostKey: { state: 'new', presented: { type: third.type, fingerprint: third.fingerprint } } } });
    });
    await trustDialog.getByRole('button', { name: 'Review current host', exact: true }).click();
    await trustDialog.getByRole('button', { name: 'Trust key', exact: true }).click(); await trustDialog.waitFor({ state: 'hidden' });
    await target.locator('.tc-cred-inspector').getByRole('button', { name: 'Close credential details' }).click();
    await edit('fixture-login'); editor = target.locator('.tc-cred-editor');
    await editor.getByRole('button', { name: 'Replace…', exact: true }).click(); await editor.locator('#cred-secret').fill(replacement);
    const deleted = await store.public('fixture-login'); await store.remove({ id: deleted.id, revision: deleted.revision });
    await editor.locator('[data-cred-editor="save"]').click(); await editor.getByText('Deleted in another window', { exact: true }).waitFor();
    await editor.getByRole('button', { name: 'Save as new', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
    check((await store.forUse('fixture-login')).secret === replacement, 'gone conflict can save as new with the typed key');
    const failRead = route => route.fulfill({ status: 500, json: { ok: false, code: 'store', error: 'Fixture read failed.' } });
    await page.route('**/credentials', failRead); await target.evaluate(() => window.dispatchEvent(new Event('focus')));
    await target.getByRole('alert').filter({ hasText: 'Fixture read failed.' }).waitFor();
    check(await target.locator('.tc-cred-row,.tc-cred-prow').count() === 0, 'read failure does not expose stale actionable rows'); await capture('read-error');
    await page.unroute('**/credentials', failRead); await target.getByRole('button', { name: 'Try again', exact: true }).click();
    await target.locator('[data-cred-action="inspect"][data-id="fixture-login"]').waitFor();
    await target.locator('[data-cred-action="inspect"][data-id="fixture-login"]').click();
    await target.locator('.tc-cred-inspector').getByRole('button', { name: 'Credential actions', exact: true }).click();
    await target.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    const deletion = target.getByRole('alertdialog'); await deletion.getByText('Backups of this volume still hold it', { exact: true }).waitFor(); await capture('delete');
    await deletion.getByRole('button', { name: 'Delete credential', exact: true }).click();
    await target.locator('[data-cred-action="inspect"][data-id="fixture-login"]').waitFor({ state: 'hidden' });
    await geometry(target, width, height, 'after delete');
    await target.waitForFunction(() => document.activeElement?.matches('#credential-list [data-cred-action="inspect"], #credential-list [data-cred-action="add"]'));
    check(true, 'deletion restores focus to a remaining credential or Add');
    // Long metadata and a partial scan keep the list honest and usable.
    const longId = 'long-' + 'a'.repeat(59);
    const partialRead = async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(), data = await response.json();
      data.usageWarnings = ['Fixture partial scan'];
      data.credentials.push({ ...data.credentials.find(row => row.id === 'project-api'), id: longId, baseUrl: 'https://' + 'api.'.repeat(25) + 'example.com/' + 'long-path/'.repeat(18), test: null, usedIn: [{ name: 'a-very-long-skill-name-'.repeat(4), where: 'All agents', kind: 'skill' }, { name: 'AGENTS.md', kind: 'instructions' }] });
      return route.fulfill({ response, json: data });
    };
    await page.route('**/credentials', partialRead); await target.evaluate(() => window.dispatchEvent(new Event('focus')));
    await target.getByText('Some skills couldn’t be read. Usage may be incomplete.', { exact: true }).waitFor();
    await geometry(target, width, height, 'long metadata list');
    await target.evaluate(id => { location.hash = 'credentials/' + id; }, longId);
    await target.locator('.tc-cred-inspector').getByRole('heading', { name: longId, exact: true }).waitFor();
    check((await target.locator('.tc-cred-inspector').innerText()).includes('At least 2 sources'), 'partial usage does not claim completeness');
    await geometry(target, width, height, 'long metadata inspector'); await capture('long-partial');
    await target.locator('.tc-cred-inspector').getByRole('button', { name: 'Close credential details' }).click();
    await page.unroute('**/credentials', partialRead);

    check(!(await target.content()).includes(secret) && !(await target.content()).includes(token) && !(await target.content()).includes(replacement), 'no saved or typed secrets remain in markup');
    for (const body of await Promise.all(responseBodies)) for (const value of [secret, token, replacement]) check(!body.includes(value), 'no credential response echoes a secret');
    assert.deepEqual(pageErrors, []); checks++; await page.close();
    console.log(`PASS credentials ${theme} ${width} ${mode} (${checks} checks so far)`);
  }
  check(!f.logs().includes(secret) && !f.logs().includes(token), 'service logs do not expose fixture credentials');
  console.log('PASS ' + checks + ' Credentials browser checks');
} finally { await browser.close(); loopback.closeAllConnections(); await new Promise(resolve => loopback.close(resolve)); await f.close(); }
