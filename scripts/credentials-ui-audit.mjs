#!/usr/bin/env node
// Real Setup API, private disposable home and loopback API. SSH scans, SSH draft
// tests and host trust are intercepted, every address saved here is loopback, and
// a guard fails the run if the page reaches for anything else.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
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

// The real server looks up releases and provider lists in the background. Those
// lookups meet a closed loopback port here, not the internet.
const nowhere = 'http://127.0.0.1:9', direct = '127.0.0.1,localhost';
Object.assign(process.env, { HTTP_PROXY: nowhere, HTTPS_PROXY: nowhere, ALL_PROXY: nowhere, http_proxy: nowhere, https_proxy: nowhere, all_proxy: nowhere, NO_PROXY: direct, no_proxy: direct, NODE_USE_ENV_PROXY: '1' });

// Nothing here may touch the person's own home, whatever $HOME says.
const outsideFiles = ['.ssh/config', '.claude/skills/t3-vault/SKILL.md', '.agents/skills/t3-vault/SKILL.md', '.gemini/config/skills/t3-vault/SKILL.md'].map(file => path.join(os.userInfo().homedir, file));
const outside = () => Promise.all(outsideFiles.map(file => fs.readFile(file, 'utf8').catch(() => null)));
const outsideBefore = await outside();

const f = await credentialsFixture(), directory = path.join(f.env.T3CODE_HOME, 'server-credentials');
assert.ok(path.resolve(f.home).startsWith(path.resolve(os.tmpdir()) + path.sep), 'The audit home must be a temporary folder.');
// The store's Include line goes under `home`, so it is always given explicitly.
let clock = Date.now(); const store = createCredentialStore({ directory, home: f.home, clock: () => clock });
const secret = 'fixture-browser-password-123', token = 'fixture-browser-token-456', replacement = 'fixture-replacement-private-789', external = 'external-replacement-synthetic';
const pasted = 'ghp_' + 'fixturetoken'.repeat(4), customSecret = 'fixture-custom-secret-321', kubeconfig = 'fixture-kubeconfig-654', passphrase = 'fixture-passphrase-987', typedKey = 'fixture-existing-key-210', onceSecret = 'fixture-once-password-543', saveToken = 'fixture-saved-token-876';
const loopback = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
loopback.listen(0, '127.0.0.1'); await once(loopback, 'listening');
const localApi = 'http://127.0.0.1:' + loopback.address().port + '/v1/';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
let checks = 0, openPage = null;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const same = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const variants = [[1280, 900, 'standalone'], [1024, 768, 'standalone'], [744, 900, 'standalone'], [390, 844, 'standalone'], [360, 720, 'standalone'], [1198, 878, 'embedded'], [480, 760, 'tab'], [639, 800, 'tab'], [640, 800, 'tab'], [704, 800, 'tab'], [1040, 820, 'tab']];
const themes = (process.env.T3_CREDENTIALS_UI_THEMES || 'light,dark').split(',');
const requestedWidths = (process.env.T3_CREDENTIALS_UI_WIDTHS || process.env.T3_CREDENTIALS_UI_WIDTH || '').split(',').filter(Boolean).map(Number);
const selected = variants.filter(([width]) => !requestedWidths.length || requestedWidths.includes(width));
const sshPort = 1; // Nothing listens here, so a real first-use scan stops at "unreachable".
const isLoopback = value => /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/.test(value);
// A password SSH row for the draft and conflict checks, so the seven fixture rows keep their states.
const editRow = { id: 'deploy-box', type: 'ssh', description: '', fields: { host: '127.0.0.30', port: sshPort, username: 'deploy', auth: 'password' }, env: {}, secretNames: ['password'], hostKey: { firstUse: false }, test: { ok: true, code: 'ok', ms: 120, detail: { user: 'deploy' } }, usage: null, origin: { by: 'setup' } };

// The preview fixture's rows, with every address moved to loopback.
const localised = (profile, index) => {
  const fields = { ...profile.fields };
  if (fields.host) fields.host = '127.0.0.' + (10 + index);
  if (profile.type === 'ssh') fields.port = sshPort;
  if (fields.baseUrl) fields.baseUrl = localApi;
  return fields;
};
async function seed() {
  for (const row of (await store.list()).credentials) await store.remove({ id: row.id, revision: row.revision });
  const key = credentialKey(), next = credentialKey();
  for (const [index, profile] of [...fixture('credentials.json').credentials, editRow].entries()) {
    clock = Date.parse('2026-10-26T18:04:11Z');
    const secrets = Object.fromEntries(profile.secretNames.map(name => [name, ['password', 'privateKey'].includes(name) ? secret : token]));
    const saved = (await store.save({ create: true, origin: profile.origin, credential: { id: profile.id, type: profile.type, description: profile.description, fields: profile === editRow ? profile.fields : localised(profile, index), env: profile.env, secrets } })).credential;
    if (profile.hostKey) await store.trust({ id: profile.id, revision: saved.revision, key, firstUse: profile.hostKey.firstUse === true });
    if (profile.test) {
      clock = Date.now() - (profile.id === 'build-server' ? 120000 : profile.id === 'github' ? 86400000 : 3600000);
      const result = profile.test.code === 'host-key-changed' ? { ...profile.test, detail: { trusted: { type: key.type, fingerprint: key.fingerprint }, presented: { type: next.type, fingerprint: next.fingerprint } } } : profile.test;
      await store.recordTest({ id: profile.id, revision: saved.revision, hostFingerprint: profile.hostKey ? key.fingerprint : undefined, result });
    }
    if (profile.usage) { clock = Date.parse(profile.usage.at); await store.usage.record(profile.id, { command: profile.usage.command || 'ssh', env: {} }); }
  }
  clock = Date.now(); return { key, next };
}
async function geometry(page, target, width, height, label) {
  const problems = await target.evaluate(({ width, height }) => {
    const errors = [], rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('document overflows: ' + document.documentElement.scrollWidth + ' > ' + innerWidth);
    if (document.body.scrollWidth > innerWidth + 1) errors.push('body overflows: ' + document.body.scrollWidth + ' > ' + innerWidth);
    for (const panel of document.querySelectorAll('.tc-cred-editor,.tc-cred-inspector,.tc-cred-dialog')) {
      const r = rect(panel); if (r.x < -1 || r.y < -1 || r.right > width + 1 || r.bottom > height + 1) errors.push('panel outside viewport: ' + JSON.stringify(r));
      const foot = panel.querySelector('.tc-wizard-foot'); if (foot && rect(foot).bottom > height + 1) errors.push('save footer outside viewport');
      if (panel.scrollWidth > panel.clientWidth + 2) errors.push('panel content overflows: ' + panel.scrollWidth + ' > ' + panel.clientWidth);
    }
    for (const row of document.querySelectorAll('.tc-cred-row')) {
      const parts = [...row.children].map(rect).filter(r => r.width > 0 && r.height > 0);
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (Math.min(parts[i].right, parts[j].right) - Math.max(parts[i].x, parts[j].x) > 1 && Math.min(parts[i].bottom, parts[j].bottom) - Math.max(parts[i].y, parts[j].y) > 1) errors.push('row columns overlap');
    }
    return errors;
  }, { width, height });
  same(problems, [], label);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'outer page does not overflow: ' + label);
}
// The old helpers and the old page name are gone from everything a person can read or hear.
async function naming(target, label) {
  const found = await target.evaluate(() => {
    const clone = document.documentElement.cloneNode(true);
    for (const skip of clone.querySelectorAll('script,style')) skip.remove();
    const attributes = [...document.querySelectorAll('[aria-label],[title],[placeholder],[alt],[href]')].flatMap(el => ['aria-label', 'title', 'placeholder', 'alt', 'href'].map(name => el.getAttribute(name)).filter(Boolean));
    const words = [clone.textContent, document.documentElement.innerText || '', ...attributes].join('\n');
    const titles = [document.title, ...[...document.querySelectorAll('h1,h2,h3,.tc-page-title,.tc-sheet-title,.tc-dialog-title,nav a,nav button,[aria-current=page],[role=menuitemradio],[role=option]')].map(el => (el.textContent || '').trim())];
    return { commands: words.match(/\bt3-(?:ssh|api)\b/g) || [], titles: titles.filter(text => /^credentials(?:$|\s*[·|—-])/i.test(text)), links: attributes.filter(value => /^#\/?credentials/.test(value)) };
  });
  same(found, { commands: [], titles: [], links: [] }, 'old names gone: ' + label);
}

try {
  same((await (await f.request('/credentials')).json()).types, fixture('credentials.json').types, 'preview fixture describes the same types as the real API');
  const types = fixture('credentials.json').types;
  for (const theme of themes) for (const [width, height, mode] of selected) {
    console.log('Checking ' + theme + ' ' + width + ' ' + mode);
    const keys = await seed(), phone = width < (mode === 'tab' ? 640 : 1024);
    const page = openPage = await browser.newPage({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
    const pageErrors = [], responseBodies = [], unexpected = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => { const route = new URL(response.url()).pathname; if (/\/credentials(?:\/|$)/.test(route)) responseBodies.push(response.text().catch(() => '').then(body => ({ route, body }))); });
    await page.addInitScript(value => localStorage.setItem('t3-console-theme', value), theme);
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__credentialCopy = value; } } }));
    // Lets a case hold one status poll, so it can land exactly when a link changes the address.
    await page.addInitScript(() => {
      const real = window.fetch;
      window.fetch = (input, init) => {
        const answer = real(input, init);
        if (!window.__holdStatus || !/\/status(\?|$)/.test(String(input?.url || input))) return answer;
        window.__holdStatus = false;
        return new Promise((resolve, reject) => answer.then(r => r.json().then(data => { window.__releaseStatus = () => resolve({ ok: r.ok, status: r.status, headers: r.headers, json: async () => data, text: async () => JSON.stringify(data) }); }), reject));
      };
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!isLoopback(url.hostname)) { unexpected.push('browser request to ' + url.href); return route.abort(); }
      if (url.pathname.endsWith('/status')) return route.fulfill({ json: { ...statusFor('ready'), credentials: await store.summary() } });
      if (url.pathname.endsWith('/providers')) return route.fulfill({ json: fixture('providers.json') });
      if (url.pathname.endsWith('/ports')) return route.fulfill({ json: portsFor('ready') });
      // Each case below intercepts what it needs. Anything left would reach a real host.
      const refuse = what => { unexpected.push(what); return route.fulfill({ status: 500, json: { ok: false, error: 'The audit refused this: ' + what } }); };
      if (/\/credentials\/(?:scan|trust|install-key|forget-host-key)$/.test(url.pathname)) return refuse('unintercepted ' + url.pathname);
      if (/\/credentials\/(?:test|create|save)$/.test(url.pathname)) {
        const body = request.postDataJSON(), draft = body.draft || body.credential;
        if (body.install) return refuse('a password install that was not intercepted');
        if (url.pathname.endsWith('/test')) {
          const saved = !draft && await store.public(body.id).catch(() => null), type = draft?.type || saved?.type, fields = draft?.fields || saved?.fields || {};
          if (type === 'ssh') return refuse('an SSH test that was not intercepted');
          if (fields.baseUrl && !isLoopback(new URL(fields.baseUrl).hostname)) return refuse('a test of ' + fields.baseUrl);
        } else if (draft?.type === 'ssh' && draft.fields?.auth === 'key' && !isLoopback(draft.fields.host)) return refuse('a first-use scan of ' + draft.fields.host);
      }
      return route.continue();
    });
    const embedded = mode !== 'standalone', url = f.base + '/' + (embedded ? '?embed=t3&theme=' + theme + (mode === 'tab' ? '&host=tab&layout=wide' : '') : '') + '#vault';
    const target = embedded ? await framed(page, url) : (await page.goto(url), page);
    const capture = name => page.screenshot({ path: path.join(output, `${theme}-${width}-${mode}-${name}.png`), fullPage: true });
    const fits = label => geometry(page, target, width, height, label);
    const rowCount = () => target.locator('.tc-cred-row,.tc-cred-prow').count();
    const row = id => target.locator('[data-cred-action="inspect"][data-id="' + id + '"]');
    const refresh = () => target.evaluate(() => window.dispatchEvent(new Event('focus')));
    const copied = () => target.evaluate(() => window.__credentialCopy);
    const markup = () => target.content();
    const pageText = () => target.evaluate(() => document.documentElement.innerText);
    const go = hash => target.evaluate(value => { location.hash = value; }, hash);
    const closeDetails = async () => { await target.locator('.tc-cred-inspector').getByRole('button', { name: 'Close credential details' }).click(); await target.locator('.tc-cred-inspector').waitFor({ state: 'hidden' }); };
    const addDialog = async () => {
      await target.getByRole('button', { name: 'Add credential', exact: true }).click();
      const editor = target.locator('.tc-cred-editor'); await editor.locator('#cred-paste').waitFor(); return editor;
    };
    const pick = async (editor, type) => { await editor.locator('[data-cred-editor="pick-type"][data-value="' + type + '"]').click(); await editor.locator('#cred-id').waitFor(); };
    const paste = (editor, text) => editor.locator('#cred-paste').evaluate((el, value) => { el.value = value; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })); }, text);
    // Leaving the empty Name field shows its error, which moves these options: the click must still land.
    const signIn = async (editor, choice) => {
      await editor.locator('label.tc-cred-option', { has: target.locator('input[data-cred-editor="signin"][value="' + choice + '"]') }).click();
      check(await editor.locator('input[data-cred-editor="signin"][value="' + choice + '"]').isChecked(), 'a click on ' + choice + ' lands');
    };
    const discard = async editor => {
      await editor.getByRole('button', { name: 'Close credential editor' }).click();
      const prompt = target.getByRole('alertdialog');
      await Promise.race([editor.waitFor({ state: 'hidden' }), prompt.waitFor()]);
      if (await prompt.count()) await prompt.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
    };
    // A test's answer can't be below the dialog's fold, on any width.
    const answerShows = async (editor, label) => {
      const place = await editor.locator('.tc-cred-test-line').evaluate(el => { const r = el.getBoundingClientRect(), panel = document.querySelector('.tc-cred-editor'); return { top: r.top, bottom: r.bottom, above: panel.querySelector('.tc-wizard-head').getBoundingClientRect().bottom, actions: panel.querySelector('.tc-wizard-foot').getBoundingClientRect().top }; });
      check(place.top >= place.above - 1 && place.bottom <= place.actions + 1, label + ' is visible above the pinned actions: ' + JSON.stringify(place));
    };
    const edit = async id => {
      await row(id).click();
      const details = target.locator('.tc-cred-inspector');
      if (await details.locator('[data-cred-inspect="edit"]').isVisible()) await details.locator('[data-cred-inspect="edit"]').click();
      else { await details.locator('[data-cred-inspect="menu"]').click(); await target.getByRole('menuitem', { name: 'Edit…', exact: true }).click(); }
      await target.locator('.tc-cred-editor').waitFor();
    };

    await target.getByLabel('Setup key', { exact: true }).fill('credential-fixture-key'); await target.getByRole('button', { name: 'Unlock', exact: true }).click();
    await row('build-server').waitFor();
    await fits('list'); await capture('list');

    // ---- The page is called Vault, and nothing mentions the old helpers. --------
    check((await target.locator('#page-vault .tc-page-title').textContent()).trim() === 'Vault', 'page title is Vault');
    check(await target.evaluate(() => document.body.dataset.consoleRoute === 'vault'), 'route is vault');
    // ---- A toast's mark matches what it says. ------------------------------------
    const toasts = await target.evaluate(() => {
      const shown = ['ok', 'warn', 'info', 'danger'].map(tone => {
        const handle = Kit.toast('Fixture ' + tone, tone === 'ok' ? {} : { tone });
        const node = [...document.querySelectorAll('.tc-toast')].at(-1), mark = node.querySelector('.tc-icon');
        const result = { tone, tag: node.dataset.tone, shape: mark.innerHTML, color: getComputedStyle(mark).color };
        handle?.close?.(); node.remove();
        return result;
      });
      // A fresh probe for each colour with no transition, or it reads a colour mid-change.
      const color = name => { const probe = document.createElement('span'); probe.style.cssText = 'transition:none;color:var(--' + name + ')'; document.querySelector('.tc-toaster, #toaster').append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; };
      const expected = { ok: color('ok'), warn: color('warn'), info: color('info'), danger: color('danger') };
      return { shown, expected };
    });
    for (const row of toasts.shown) check(row.color === toasts.expected[row.tone], 'a ' + row.tone + ' toast uses its own colour');
    check(new Set(toasts.shown.map(row => row.shape)).size === 4, 'each toast tone has its own icon');
    await naming(target, 'list');
    if (phone && !embedded) { await go('more'); await target.waitForFunction(() => document.body.dataset.consoleRoute === 'more'); await naming(target, 'phone More page'); }
    await go('overview'); await target.waitForFunction(() => document.body.dataset.consoleRoute === 'overview');
    if (!embedded) { await page.keyboard.press('Control+k'); await target.locator('.tc-layer .tc-palette').waitFor(); await naming(target, 'command palette'); await page.keyboard.press('Escape'); await target.locator('.tc-layer .tc-palette').waitFor({ state: 'hidden' }); }
    await go('vault'); await target.locator('#page-vault:not([hidden]) .tc-page-title').waitFor(); await row('build-server').waitFor();

    // ---- Search, filters and details. -------------------------------------------
    const search = target.getByRole('searchbox', { name: 'Search credentials' });
    await search.fill('X-API-Key'); check(await rowCount() === 1, 'search matches secret kind'); await search.fill('');
    await target.getByRole('button', { name: 'Needs attention 2', exact: true }).click(); check(await rowCount() === 2, 'attention filter');
    await target.getByRole('button', { name: 'Needs attention 2', exact: true }).click();
    await row('project-api').click();
    const inspector = target.locator('.tc-cred-inspector'); await inspector.waitFor(); await fits('inspector'); await capture('inspect-api');
    check((await inspector.locator('.tc-cred-request').textContent()).includes('••••••••'), 'request has mask');
    const sections = async () => (await inspector.locator('.tc-insp-label').allInnerTexts()).map(text => text.split('\n')[0].trim());
    for (const name of ['Details', 'Use it in a skill', 'Used in', 'Activity']) check((await sections()).includes(name), 'inspector has ' + name);
    await inspector.getByRole('button', { name: 'Copy snippet', exact: true }).click();
    check((await copied()).includes('t3-vault http project-api'), 'snippet uses name');
    await naming(target, 'API details');
    await closeDetails();
    await row('build-server').click(); await inspector.waitFor(); await capture('inspect-ssh'); await fits('SSH details');
    check((await sections()).includes('Add this key to a server'), 'a key sign-in offers its install line');
    await inspector.locator('[data-cred-inspect="copy-install"]').click();
    check((await copied()).includes('authorized_keys') && (await copied()).includes('t3-vault:build-server'), 'install line copies the public key');
    check(!(await inspector.innerText()).includes('Not trusted yet'), 'a pinned host is not offered for trust');
    await naming(target, 'SSH details');
    await closeDetails();

    // ---- Secret replacement and concurrent edits. -------------------------------
    await edit('deploy-box');
    let editor = target.locator('.tc-cred-editor');
    check(await editor.locator('#cred-id').count() === 0, 'saved name is locked');
    await editor.getByRole('button', { name: 'Replace…', exact: true }).click();
    const typed = editor.locator('#cred-secrets-password');
    check(await typed.inputValue() === '', 'replacement starts empty');
    await typed.fill(replacement); await editor.getByRole('button', { name: 'Show newly typed password' }).click();
    check(await typed.getAttribute('type') === 'text', 'reveal only typed password');
    check(!(await markup()).includes(replacement), 'typed secret absent from markup');
    await fits('editor'); await capture('edit-ssh');
    const current = await store.public('deploy-box');
    await store.save({ credential: { ...current, fields: { ...current.fields, username: 'deploy-next' } }, revision: current.revision });
    await editor.locator('[data-cred-editor="save"]').click(); await editor.locator('#cred-conflict').waitFor();
    check((await editor.locator('#cred-conflict').innerText()).includes('deploy-next'), 'conflict explains field change');
    check(await typed.inputValue() === replacement, 'conflict keeps draft secret'); await capture('conflict');
    await editor.getByRole('button', { name: 'Use theirs', exact: true }).click();
    check(await typed.inputValue() === replacement, 'use theirs keeps typed secret when saved secret unchanged');
    const newer = await store.public('deploy-box');
    await store.save({ credential: { ...newer, secrets: { password: external } }, revision: newer.revision });
    await editor.locator('[data-cred-editor="save"]').click(); await editor.locator('#cred-conflict').waitFor();
    await editor.getByRole('button', { name: 'Use theirs', exact: true }).click();
    check(await typed.count() === 0, 'use theirs clears typed secret if theirs replaced it');
    await editor.getByRole('button', { name: 'Close credential editor' }).click(); await editor.waitFor({ state: 'hidden' });
    await edit('deploy-box'); editor = target.locator('.tc-cred-editor');
    await editor.locator('#cred-fields-username').fill('draft-user');
    const latest = await store.public('deploy-box');
    await store.save({ credential: { ...latest, fields: { ...latest.fields, username: 'edited-elsewhere' } }, revision: latest.revision });
    await editor.locator('[data-cred-editor="save"]').click(); await editor.locator('#cred-conflict').waitFor();
    await editor.getByRole('button', { name: 'Keep mine', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
    check((await store.forUse('deploy-box')).fields.username === 'draft-user', 'Keep mine saves the draft against the reviewed revision');
    check((await store.forUse('deploy-box')).secrets.password === external, 'Keep mine without a replacement keeps the current saved secret');

    // ---- The add dialog, a draft test and a repeated save. ----------------------
    editor = await addDialog(); await fits('add dialog first step'); await capture('add-start'); await naming(target, 'add dialog first step');
    check(await editor.locator('[data-cred-editor="pick-type"]').count() === types.length, 'every type has a button');
    check((await editor.locator('#cred-paste').evaluate(el => getComputedStyle(el).webkitTextSecurity)) === 'disc', 'paste box stays masked');
    await pick(editor, 'ssh');
    await editor.locator('#cred-id').fill('Fixture Login');
    check(await editor.locator('#cred-id').inputValue() === 'fixture-login', 'name normalized as typed');
    await editor.locator('#cred-fields-host').fill('127.0.0.31'); await editor.locator('#cred-fields-username').fill('deploy');
    await signIn(editor, 'password'); await editor.locator('#cred-secrets-password').fill(secret);
    await editor.getByRole('button', { name: 'Choose another type', exact: true }).click(); await pick(editor, 'token');
    check(await editor.locator('#cred-id').inputValue() === 'fixture-login', 'type switch retains name'); check(await editor.locator('#cred-secrets-token').inputValue() === '', 'type switch clears password');
    await editor.locator('#cred-fields-baseUrl').fill(localApi); await editor.getByRole('button', { name: 'Header', exact: true }).click();
    await editor.locator('#cred-fields-authName').fill('X-API-Key'); await editor.locator('#cred-secrets-token').fill(token);
    await editor.getByRole('button', { name: 'Query parameter', exact: true }).click(); check(await editor.locator('#cred-secrets-token').inputValue() === token, 'auth switch retains newly typed key');
    await editor.getByRole('button', { name: 'Header', exact: true }).click(); await editor.locator('#cred-fields-testPath').fill('account');
    const beforeTest = await store.list();
    await editor.locator('[data-cred-editor="test"]').click(); await editor.getByText('Connected · HTTP 200', { exact: true }).waitFor();
    same(await store.list(), beforeTest, 'draft testing writes nothing');
    await capture('draft-tested'); await answerShows(editor, 'API test feedback');
    // Delay the actual write. Enter/Escape and a second submit cannot duplicate it.
    let release, arrived, saves = 0; const gate = new Promise(resolve => { release = resolve; }), arrival = new Promise(resolve => { arrived = resolve; });
    const hold = async route => { saves++; arrived(); await gate; await route.continue(); };
    await page.route('**/credentials/create', hold); await editor.locator('[data-cred-editor="save"]').click(); await arrival;
    await editor.dispatchEvent('submit'); await page.keyboard.press('Escape');
    check(await editor.locator('#cred-secrets-token').isDisabled(), 'fields disabled while saving'); check(await editor.locator('[data-cred-editor="close"]').first().isDisabled(), 'cannot close an unsettled save');
    release(); await editor.waitFor({ state: 'hidden' }); await page.unroute('**/credentials/create', hold); check(saves === 1, 'save submitted exactly once');
    await row('fixture-login').waitFor();
    check((await store.forUse('fixture-login')).secrets.token === token, 'real API saved the new key');
    await edit('fixture-login'); editor = target.locator('.tc-cred-editor');
    await editor.locator('#cred-fields-baseUrl').fill(localApi + 'changed/');
    await editor.getByRole('button', { name: 'Close credential editor' }).click();
    await target.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click(); check(await editor.isVisible(), 'cancel discard keeps draft');
    await editor.getByRole('button', { name: 'Close credential editor' }).click(); await target.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click(); await editor.waitFor({ state: 'hidden' });

    // ---- Review a key that changes again while the person decides. No SSH auth. --
    await row('old-box').click();
    const presented = { type: keys.next.type, fingerprint: keys.next.fingerprint }, third = credentialKey();
    await page.route('**/credentials/scan', route => route.fulfill({ json: { ok: true, hostKey: { state: 'changed', trusted: { type: keys.key.type, fingerprint: keys.key.fingerprint }, presented } } }));
    let trustCalls = 0;
    await page.route('**/credentials/trust', async route => {
      trustCalls++;
      if (trustCalls === 1) return route.fulfill({ status: 409, json: { ok: false, code: 'key-changed', error: 'The key changed again.', presented: { type: third.type, fingerprint: third.fingerprint } } });
      check(route.request().postDataJSON().fingerprint === third.fingerprint, 'trust uses the new displayed fingerprint');
      const saved = await store.public('old-box');
      if (trustCalls === 2) {
        const current = (await store.save({ credential: { ...saved, fields: { ...saved.fields, host: '127.0.0.32' } }, revision: saved.revision })).credential;
        return route.fulfill({ status: 409, json: { ok: false, code: 'changed', error: 'The host was edited elsewhere.', current } });
      }
      check(route.request().postDataJSON().revision === saved.revision, 'trust binds the refreshed connection revision');
      await store.trust({ id: saved.id, revision: saved.revision, key: third });
      return route.fulfill({ json: { ok: true, hostKey: (await store.public(saved.id)).hostKey } });
    });
    await inspector.getByRole('button', { name: 'Review…', exact: true }).click();
    const trustDialog = target.locator('.tc-cred-dialog'); await trustDialog.getByText(presented.fingerprint, { exact: false }).waitFor();
    await trustDialog.getByRole('button', { name: 'Trust new key', exact: true }).waitFor({ state: 'visible' });
    check(await trustDialog.getByRole('button', { name: 'Keep blocking', exact: true }).evaluate(el => document.activeElement === el), 'host-key review focuses keep blocking');
    await fits('host-key review'); await capture('host-key');
    await trustDialog.getByRole('button', { name: 'Trust new key', exact: true }).click(); await trustDialog.getByText('The key changed again.', { exact: false }).waitFor();
    check((await trustDialog.innerText()).includes(third.fingerprint), 'new fingerprint shown after a trust conflict');
    await trustDialog.getByRole('button', { name: 'Trust new key', exact: true }).click();
    await trustDialog.getByRole('button', { name: 'Review current host', exact: true }).waitFor();
    check(await trustDialog.locator('[data-cred-key="trust"]').count() === 0, 'stale host cannot be trusted');
    await page.route('**/credentials/scan', async route => {
      const current = await store.public('old-box');
      check(route.request().postDataJSON().revision === current.revision, 'review scans the current revision');
      return route.fulfill({ json: { ok: true, hostKey: { state: 'new', presented: { type: third.type, fingerprint: third.fingerprint } } } });
    });
    await trustDialog.getByRole('button', { name: 'Review current host', exact: true }).click();
    await trustDialog.getByRole('button', { name: 'Trust key', exact: true }).click(); await trustDialog.waitFor({ state: 'hidden' });
    await closeDetails();
    await page.unroute('**/credentials/scan'); await page.unroute('**/credentials/trust');

    // ---- A credential deleted elsewhere can be saved again. ---------------------
    await edit('fixture-login'); editor = target.locator('.tc-cred-editor');
    await editor.getByRole('button', { name: 'Replace…', exact: true }).click(); await editor.locator('#cred-secrets-token').fill(replacement);
    const deleted = await store.public('fixture-login'); await store.remove({ id: deleted.id, revision: deleted.revision });
    await editor.locator('[data-cred-editor="save"]').click(); await editor.getByText('Deleted in another window', { exact: true }).waitFor();
    await editor.getByRole('button', { name: 'Save as new', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
    check((await store.forUse('fixture-login')).secrets.token === replacement, 'gone conflict can save as new with the typed key');

    // ---- Failed reads. -----------------------------------------------------------
    const failRead = route => route.fulfill({ status: 500, json: { ok: false, code: 'store', error: 'Fixture read failed.' } });
    await page.route('**/credentials', failRead); await refresh();
    await target.getByRole('alert').filter({ hasText: 'Fixture read failed.' }).waitFor();
    check(await rowCount() === 0, 'read failure does not expose stale actionable rows'); await capture('read-error'); await fits('read failure');
    await page.unroute('**/credentials', failRead); await target.getByRole('button', { name: 'Try again', exact: true }).click();
    await row('fixture-login').waitFor();

    // ---- Deletion focus. ---------------------------------------------------------
    await row('fixture-login').click();
    await inspector.getByRole('button', { name: 'Credential actions', exact: true }).click();
    await target.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    const deletion = target.getByRole('alertdialog'); await deletion.getByText('Backups of this volume still hold it', { exact: true }).waitFor(); await capture('delete');
    await deletion.getByRole('button', { name: 'Delete credential', exact: true }).click();
    await row('fixture-login').waitFor({ state: 'hidden' });
    await fits('after delete');
    await target.waitForFunction(() => document.activeElement?.matches('#credential-list [data-cred-action="inspect"], #credential-list [data-cred-action="add"]'));
    check(true, 'deletion restores focus to a remaining credential or Add');

    // ---- Long metadata and a partial scan keep the list honest and usable. -------
    const longId = 'long-' + 'a'.repeat(59);
    const partialRead = async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(), data = await response.json(), base = data.credentials.find(row => row.id === 'project-api');
      data.usageWarnings = ['Fixture partial scan'];
      data.credentials.push({ ...base, id: longId, description: 'A long description that keeps going. '.repeat(6).slice(0, 200), fields: { ...base.fields, baseUrl: 'https://' + 'api.'.repeat(25) + 'example.com/' + 'long-path/'.repeat(18) }, test: null, usedIn: [{ name: 'a-very-long-skill-name-'.repeat(4), where: 'All agents', kind: 'skill' }, { name: 'AGENTS.md', kind: 'instructions' }] });
      return route.fulfill({ response, json: data });
    };
    await page.route('**/credentials', partialRead); await refresh();
    await target.getByText('Some skills couldn’t be read. Usage may be incomplete.', { exact: true }).waitFor();
    await fits('long metadata list');
    await go('vault/' + longId);
    await inspector.getByRole('heading', { name: longId, exact: true }).waitFor();
    check((await inspector.innerText()).includes('At least 2 sources'), 'partial usage does not claim completeness');
    await fits('long metadata inspector'); await capture('long-partial');
    await closeDetails();
    await page.unroute('**/credentials', partialRead); await refresh();
    await target.getByText('Some skills couldn’t be read. Usage may be incomplete.', { exact: true }).waitFor({ state: 'hidden' });

    // ---- Every type draws its own form from the server's description. ------------
    for (const type of types) {
      editor = await addDialog(); await pick(editor, type.id);
      check((await editor.locator('.tc-wizard-head .tc-small').textContent()).trim() === type.label, type.id + ' form names its type');
      const defaults = Object.fromEntries(type.fields.filter(entry => entry.default !== undefined).map(entry => [entry.key, entry.default]));
      const applies = entry => !entry.needs && (!entry.when || Object.entries(entry.when).every(([key, values]) => values.includes(defaults[key])));
      for (const entry of type.fields.filter(entry => entry.kind !== 'derived' && applies(entry) && !(type.id === 'ssh' && entry.key === 'auth'))) {
        const control = editor.locator(entry.kind === 'select' ? '[data-cred-editor="select"][data-field="' + entry.key + '"]' : '#cred-fields-' + entry.key);
        check(await control.first().isVisible(), type.id + ' shows ' + entry.key);
      }
      if (type.id === 'ssh') check(await editor.locator('input[data-cred-editor="signin"]').count() === 4, 'ssh offers four ways to sign in');
      else for (const entry of type.secrets.filter(applies)) check(await editor.locator('#cred-secrets-' + entry.key).isVisible(), type.id + ' asks for ' + entry.key);
      for (const entry of [...type.fields, ...type.secrets].filter(entry => entry.editableEnv)) check(await editor.locator('#cred-env-' + entry.key).isVisible(), type.id + ' lets the variable name change for ' + entry.key);
      if (type.dynamic) check(await editor.locator('[data-cred-field="vars.0.name"]').isVisible(), 'custom starts with one variable');
      await fits(type.id + ' form'); await capture('type-' + type.id); await naming(target, type.id + ' form');
      check(await editor.locator('#cred-editor-title').evaluate(el => el.getBoundingClientRect().height < parseFloat(getComputedStyle(el).lineHeight) * 1.5), 'the form title stays on one line');
      same(pageErrors, [], type.id + ' form has no page errors');
      await editor.getByRole('button', { name: 'Close credential editor' }).click();
      await editor.waitFor({ state: 'hidden' }); check(true, 'an untouched ' + type.id + ' form closes without asking');
    }

    // Removing an optional AWS token is explicit, undoable, and persisted by the real API.
    await store.save({ create: true, credential: { id: 'fixture-aws', type: 'aws', fields: { accessKeyId: 'AKIAFIXTURE' }, secrets: { secretAccessKey: secret, sessionToken: token } } });
    await refresh(); await row('fixture-aws').waitFor(); await edit('fixture-aws');
    editor = target.locator('.tc-cred-editor');
    const optionalToken = editor.locator('[data-key="cred-field-secrets.sessionToken"]');
    check(await editor.locator('[data-cred-editor="remove"]').count() === 1, 'only the optional saved secret can be removed');
    await optionalToken.getByRole('button', { name: 'Remove', exact: true }).click();
    await optionalToken.getByText('Removed on save', { exact: true }).waitFor();
    await optionalToken.getByRole('button', { name: 'Undo', exact: true }).click();
    check(await optionalToken.getByRole('button', { name: 'Remove', exact: true }).isVisible(), 'Undo keeps the saved session token');
    await optionalToken.getByRole('button', { name: 'Remove', exact: true }).click();
    await fits('remove optional token'); await capture('remove-aws-token');
    await editor.locator('[data-cred-editor="save"]').click(); await editor.waitFor({ state: 'hidden' });
    const permanent = await store.forUse('fixture-aws');
    check(!Object.hasOwn(permanent.secrets, 'sessionToken'), 'removed token is absent from the real store');
    check(permanent.secrets.secretAccessKey === secret, 'removal keeps the required AWS secret');
    await edit('fixture-aws'); editor = target.locator('.tc-cred-editor');
    check(await editor.locator('#cred-secrets-sessionToken').isVisible(), 'reopening shows an empty optional token');
    await discard(editor);
    const awsPublic = await store.public('fixture-aws');
    await store.remove({ id: awsPublic.id, revision: awsPublic.revision }); await refresh();
    await row('fixture-aws').waitFor({ state: 'hidden' });

    // ---- The side panel's toggle does something wherever it shows. ---------------
    editor = await addDialog(); await pick(editor, 'token');
    const railToggle = editor.locator('.tc-wizard-rail-toggle'), railWrap = editor.locator('.tc-wizard-rail-wrap');
    check(await railWrap.evaluate(el => el.open) === !phone, 'the side panel starts collapsed only on a phone');
    if (await railToggle.isVisible()) {
      const start = await railWrap.evaluate(el => el.open);
      // Focus starts in the Name field, so this press also leaves a field. A late repaint must not undo it.
      const settled = () => railWrap.evaluate(el => new Promise(resolve => setTimeout(() => resolve(el.open), 100)));
      await railToggle.click(); check(await settled() === !start, 'the side panel toggle changes it');
      await editor.locator('#cred-fields-baseUrl').fill(localApi); check(await settled() === !start, 'the side panel stays as it was left while typing');
      await railToggle.click(); check(await settled() === start, 'the side panel toggle changes it back');
    } else {
      check(await editor.locator('.tc-wizard-rail').isVisible(), 'without a toggle the side panel is simply shown');
    }
    await discard(editor);

    // ---- Saving a token and a custom credential, end to end. ---------------------
    editor = await addDialog(); await pick(editor, 'token');
    await editor.locator('#cred-id').fill('fixture-token'); await editor.locator('#cred-secrets-token').fill(saveToken);
    check(!(await markup()).includes(saveToken), 'typed token absent from markup');
    await editor.locator('[data-cred-editor="save"]').click(); await editor.waitFor({ state: 'hidden' }); await row('fixture-token').waitFor();
    check((await store.forUse('fixture-token')).secrets.token === saveToken, 'token saved through the real API');
    same((await store.public('fixture-token')).delivers, ['FIXTURE_TOKEN'], 'token reaches commands as NAME_TOKEN');
    check(!(await pageText()).includes(saveToken), 'saved token not on the page');
    await row('fixture-token').click(); await inspector.waitFor();
    check((await inspector.innerText()).includes('FIXTURE_TOKEN'), 'details show its variable');
    await closeDetails();

    editor = await addDialog(); await pick(editor, 'custom'); await capture('add-custom');
    await editor.locator('#cred-id').fill('fixture-custom');
    await editor.locator('[data-cred-field="vars.0.name"]').fill('FIXTURE_SECRET'); await editor.locator('[data-cred-field="vars.0.value"]').fill(customSecret);
    check(!(await markup()).includes(customSecret), 'typed custom secret absent from markup');
    await editor.getByRole('button', { name: 'Add variable', exact: true }).click();
    await editor.locator('[data-cred-field="vars.1.name"]').fill('FIXTURE_PLAIN'); await editor.locator('[data-cred-editor="var-secret"][data-index="1"]').click(); await editor.locator('[data-cred-field="vars.1.value"]').fill('plain-value');
    check(await editor.locator('[data-cred-field="vars.0.value"]').inputValue() === customSecret, 'adding a variable keeps the typed secret');
    await fits('custom form with values');
    await editor.locator('[data-cred-editor="save"]').click(); await editor.waitFor({ state: 'hidden' }); await row('fixture-custom').waitFor();
    const custom = await store.forUse('fixture-custom');
    check(custom.secrets.FIXTURE_SECRET === customSecret && custom.fields.FIXTURE_PLAIN === 'plain-value', 'custom credential saved through the real API');
    await row('fixture-custom').click(); await inspector.waitFor();
    const customDetails = await inspector.innerText();
    check(customDetails.includes('plain-value') && customDetails.includes('FIXTURE_SECRET') && !customDetails.includes(customSecret), 'details show the plain value and only the name of the secret');
    await closeDetails();

    // ---- Paste detection fills the form, and the token stays out of sight. -------
    editor = await addDialog(); await paste(editor, pasted);
    const detected = editor.locator('.tc-cred-detect'); await detected.waitFor();
    check((await detected.innerText()).includes('Looks like a GitHub token'), 'detection names what it found');
    check(await editor.locator('#cred-id').inputValue() === 'github-2', 'a detected name that is taken gets a free one');
    await detected.getByRole('button', { name: 'Change type', exact: true }).click();
    await editor.locator('#cred-paste').waitFor(); check(await editor.locator('#cred-paste').inputValue() === '', 'Change type does not put the secret back in view');
    await discard(editor);
    const github = await store.public('github'); await store.remove({ id: github.id, revision: github.revision });
    await refresh(); await row('github').waitFor({ state: 'hidden' });
    editor = await addDialog(); await paste(editor, pasted); await detected.waitFor();
    check((await editor.locator('.tc-wizard-head .tc-small').textContent()).trim() === 'Git host', 'a GitHub token becomes the git type');
    check(await editor.locator('#cred-id').inputValue() === 'github', 'a GitHub token gets the name github');
    check(await editor.locator('#cred-env-token').inputValue() === 'GH_TOKEN', 'a GitHub token reaches commands as GH_TOKEN');
    check(await editor.locator('#cred-fields-host').inputValue() === 'github.com', 'detection fills the host');
    check(await editor.locator('#cred-secrets-token').inputValue() === pasted && await editor.locator('#cred-secrets-token').getAttribute('type') === 'password', 'the token lands in a hidden field');
    check(await editor.locator('#cred-paste').count() === 0, 'the paste box is gone');
    check((await editor.locator('.tc-cred-gives').textContent()).includes('GH_TOKEN'), 'the side panel names GH_TOKEN');
    check(!(await pageText()).includes(pasted) && !(await markup()).includes(pasted), 'the pasted token is not in the page text or markup');
    await fits('detected form'); await capture('add-detected'); await naming(target, 'detected form');
    await editor.locator('[data-cred-editor="save"]').click(); await editor.waitFor({ state: 'hidden' }); await row('github').waitFor();
    const savedGithub = await store.forUse('github');
    check(savedGithub.type === 'git' && savedGithub.secrets.token === pasted && savedGithub.env.token === 'GH_TOKEN', 'detected credential saved as detected');
    const listed = await (await f.request('/credentials')).text();
    check(listed.includes('"github"') && !listed.includes(pasted), 'the list response leaves the token out');
    check(!(await pageText()).includes(pasted) && !(await markup()).includes(pasted), 'the token is not on the page after saving');
    // A private key goes to the SSH form, with its own sign-in choice already made.
    editor = await addDialog(); await paste(editor, '-----BEGIN OPENSSH PRIVATE KEY-----\n' + typedKey + '\n-----END OPENSSH PRIVATE KEY-----'); await detected.waitFor();
    check((await detected.innerText()).includes('an SSH private key'), 'detection recognizes a private key');
    check(await editor.locator('input[data-cred-editor="signin"][value="existing"]').isChecked(), 'a pasted key selects Use an existing key');
    await discard(editor);

    // ---- Deep links. -------------------------------------------------------------
    await go('vault/build-server'); await inspector.getByRole('heading', { name: 'build-server', exact: true }).waitFor();
    check(await target.evaluate(() => location.hash) === '#vault/build-server', 'details keep their address');
    await closeDetails(); check(await target.evaluate(() => location.hash) === '#vault', 'closing details restores the address');
    await page.route('**/credentials/scan', route => route.fulfill({ json: { ok: true, hostKey: { state: 'changed', trusted: { type: keys.key.type, fingerprint: keys.key.fingerprint }, presented } } }));
    await store.recordTest({ id: 'old-box', revision: (await store.public('old-box')).revision, hostFingerprint: third.fingerprint, result: { ok: false, code: 'host-key-changed', ms: 5, detail: { trusted: presented, presented } } });
    await refresh(); await go('vault/old-box'); await trustDialog.getByRole('button', { name: 'Keep blocking', exact: true }).waitFor();
    check(await inspector.count() === 1, 'a changed key opens its review from a link');
    await trustDialog.getByRole('button', { name: 'Keep blocking', exact: true }).click(); await trustDialog.waitFor({ state: 'hidden' }); await closeDetails();
    await page.unroute('**/credentials/scan');
    await go('vault/no-such-credential'); await target.getByText('Credential not found', { exact: true }).first().waitFor(); check(await inspector.count() === 0, 'a missing name opens nothing');
    check(await target.locator('.tc-toast', { hasText: 'Credential not found' }).first().getAttribute('data-tone') !== 'ok', 'a missing name is not reported as a success');
    await go('vault');
    await go('vault/new'); await editor.locator('#cred-paste').waitFor(); check(true, 'vault/new opens the first step'); await discard(editor);
    await go('vault/new/git'); await editor.locator('#cred-id').waitFor();
    check((await editor.locator('.tc-wizard-head .tc-small').textContent()).trim() === 'Git host' && await editor.locator('#cred-id').inputValue() === '', 'vault/new/<type> opens that form');
    await discard(editor);
    await go('vault/new/not-a-type'); await editor.locator('#cred-paste').waitFor(); check(true, 'an unknown type falls back to the first step'); await discard(editor);
    // A status poll that lands right after a link must not swallow it.
    const linkDuringPoll = async hash => {
      await target.evaluate(() => { window.__holdStatus = true; });
      await target.waitForFunction(() => window.__releaseStatus, null, { timeout: 40000 });
      await target.evaluate(value => { const release = window.__releaseStatus; window.__releaseStatus = null; location.hash = value; release(); }, hash);
    };
    await linkDuringPoll('vault/new/git'); await editor.locator('#cred-id').waitFor();
    await target.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
    check(await editor.isVisible() && await target.getByRole('alertdialog').count() === 0, 'a form link survives a status poll, without asking to discard anything');
    await discard(editor);
    await linkDuringPoll('vault/build-server'); await inspector.getByRole('heading', { name: 'build-server', exact: true }).waitFor();
    await target.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
    check(await inspector.isVisible(), 'a details link survives a status poll');
    await closeDetails();
    // The row exists, so the form says why it can't save rather than going quiet.
    await go('vault/new/kubernetes/kube-staging'); await editor.locator('#cred-id').waitFor();
    check(await editor.locator('#cred-id').inputValue() === 'kube-staging', 'deep link fills the name');
    check((await editor.locator('.tc-wizard-head .tc-small').textContent()).trim() === 'Kubernetes', 'deep link picks the type');
    check(await target.evaluate(() => location.hash) === '#vault', 'a form link does not stay in the address');
    await editor.getByText('kube-staging is taken.', { exact: true }).waitFor(); check(await editor.locator('[data-cred-editor="save"]').isDisabled(), 'a taken name from a link cannot save and says why');
    await discard(editor);
    const kube = await store.public('kube-staging'); await store.remove({ id: kube.id, revision: kube.revision });
    await refresh(); await row('kube-staging').waitFor({ state: 'hidden' });
    // T3 Code's Setup tab navigates by message rather than by address.
    if (mode === 'tab') await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ source: 't3-code', type: 'navigate', route: 'vault/new/kubernetes/kube-staging' }, location.origin));
    else await go('vault/new/kubernetes/kube-staging');
    await editor.locator('#cred-id').waitFor();
    check(await editor.locator('#cred-id').inputValue() === 'kube-staging', 'a free name from a link is filled in' + (mode === 'tab' ? ' through the host' : ''));
    check(await editor.locator('#cred-secrets-kubeconfig').evaluate(el => document.activeElement === el), 'a filled-in name moves focus to what is missing');
    check(await editor.locator('[data-cred-editor="save"]').isDisabled(), 'a form from a link still needs its secret');
    await fits('deep-linked form'); await capture('deep-link');
    await editor.locator('#cred-secrets-kubeconfig').fill(kubeconfig);
    await editor.locator('[data-cred-editor="save"]').click(); await editor.waitFor({ state: 'hidden' }); await row('kube-staging').waitFor();
    check((await store.forUse('kube-staging')).secrets.kubeconfig === kubeconfig, 'a form from a link saves');

    // ---- SSH sign-in choices. ----------------------------------------------------
    const hostKey = { state: 'new', presented: { type: third.type, fingerprint: third.fingerprint } }, tests = [];
    const answerTest = async route => {
      const body = route.request().postDataJSON(), { draft } = body; tests.push(body);
      check(draft?.type === 'ssh' && isLoopback(draft.fields.host), 'SSH draft tests stay on loopback');
      const at = new Date().toISOString(), user = draft.fields.username;
      if (draft.fields.auth === 'key' || body.trust?.fingerprint === third.fingerprint) return route.fulfill({ json: { ok: true, result: { ok: true, code: 'ok', ms: 130, detail: { user }, hostKey, at } } });
      return route.fulfill({ json: { ok: true, result: { ok: false, code: 'host-key-untrusted', ms: 40, detail: {}, hostKey, at } } });
    };
    await page.route('**/credentials/test', answerTest);
    const sshDraft = async (editor, id) => {
      await editor.locator('#cred-id').fill(id); await editor.locator('#cred-fields-host').fill('127.0.0.40');
      await editor.locator('#cred-fields-port').fill(String(sshPort)); await editor.locator('#cred-fields-username').fill('deploy');
    };
    editor = await addDialog(); await pick(editor, 'ssh');
    check(await editor.locator('input[data-cred-editor="signin"][value="generate"]').isChecked(), 'generate is the first choice');
    const install = editor.locator('.tc-cred-install code'); await install.waitFor();
    check(await editor.locator('.tc-cred-install').count() === 1, 'the install line appears once');
    const installLine = await install.textContent();
    check(installLine.includes('ssh-ed25519') && installLine.includes('authorized_keys'), 'generate shows an install line with the new public key');
    check(await install.isVisible() && await install.evaluate(el => !el.closest('details:not([open])')), 'the install line needs nothing opened');
    if (phone) {
      check(!(await editor.locator('.tc-wizard-rail-wrap').evaluate(el => el.open)), 'the side panel stays collapsed on a phone');
      check(await editor.locator('.tc-wizard-main .tc-cred-install').count() === 1, 'a phone shows the install line in the form');
      await install.scrollIntoViewIfNeeded();
      const box = await install.evaluate(el => { const r = el.getBoundingClientRect(), foot = document.querySelector('.tc-cred-editor .tc-wizard-foot').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, limit: foot.top }; });
      check(box.height > 0 && box.top >= -1 && box.top < box.limit && box.left >= -1 && box.right <= width + 1, 'the install line is on screen on a phone: ' + JSON.stringify(box));
    }
    await fits('generated key form'); await capture('ssh-generate'); await naming(target, 'generated key form');
    await sshDraft(editor, 'fixture-ssh');
    await editor.locator('[data-cred-editor="test"]').click();
    const identity = editor.locator('.tc-cred-hostkey--first'); await identity.waitFor();
    check((await identity.innerText()).includes('Pinned on first use'), 'a key draft says it pins on first use');
    check(await editor.locator('[data-cred-editor="trust"]').count() === 0, 'a key draft has no trust checkbox');
    check(tests.at(-1).generatedKeyId && !tests.at(-1).trust, 'a generated key test names its key and trusts nothing');
    await editor.getByText('Signed in as deploy', { exact: true }).waitFor(); await answerShows(editor, 'key test feedback');
    await fits('key draft tested'); await capture('ssh-key-tested');

    await signIn(editor, 'password');
    await editor.locator('#cred-secrets-password').waitFor();
    check(await identity.count() === 0, 'changing how it signs in forgets the last test');
    await editor.locator('#cred-secrets-password').fill(secret);
    await editor.locator('[data-cred-editor="test"]').click();
    await identity.waitFor();
    check((await identity.innerText()).includes('First connection to 127.0.0.40'), 'a password draft asks about the first connection');
    check(!(await identity.innerText()).includes('Pinned on first use'), 'a password is never pinned on first use');
    const trustBox = editor.locator('[data-cred-editor="trust"]');
    check(await trustBox.isVisible() && !(await trustBox.isChecked()), 'a password draft has an unticked trust checkbox');
    await fits('password draft tested'); await capture('ssh-password-untrusted');
    await trustBox.check(); await editor.getByText('Signed in as deploy', { exact: true }).waitFor(); await answerShows(editor, 'trusted test feedback');
    check(tests.at(-1).trust?.fingerprint === third.fingerprint, 'ticking it retests with that exact key');
    await capture('ssh-password-trusted');
    await discard(editor);

    // A password must not leave before someone has looked at who's receiving it.
    let installs = 0;
    const answerCreate = async route => {
      const body = route.request().postDataJSON(); installs++;
      check(body.install?.password === onceSecret && body.trust?.fingerprint === third.fingerprint && !body.credential.secrets.password, 'the one-time password goes only as an install, for the key that was reviewed');
      return route.fulfill({ status: 409, json: { ok: false, code: 'install-failed', error: 'The server couldn’t be reached.' } });
    };
    await page.route('**/credentials/create', answerCreate);
    editor = await addDialog(); await pick(editor, 'ssh'); await signIn(editor, 'once'); await sshDraft(editor, 'fixture-once');
    await editor.locator('#cred-secrets-password').fill(onceSecret);
    await editor.locator('[data-cred-editor="save"]').click();
    await editor.getByText('Check the server’s identity first, then save.', { exact: true }).waitFor();
    check(installs === 0, 'Save tests first and sends no password');
    await fits('one-time password needs review'); await capture('ssh-once');
    await trustBox.check(); await editor.getByText('Signed in as deploy', { exact: true }).waitFor();
    await editor.locator('[data-cred-editor="save"]').click(); await editor.getByText('The server couldn’t be reached.', { exact: true }).waitFor();
    check(installs === 1, 'after review, Save sends the password once');
    check(await editor.locator('#cred-secrets-password').inputValue() === onceSecret, 'a failed install keeps the draft');
    await discard(editor);
    await page.unroute('**/credentials/create', answerCreate);

    // An existing key, with a passphrase that stays out of the markup.
    const answerKey = route => route.fulfill({ status: 400, json: { ok: false, code: 'invalid', field: 'passphrase', error: 'This key needs its passphrase.' } });
    await page.route('**/credentials/create', answerKey);
    editor = await addDialog(); await pick(editor, 'ssh'); await signIn(editor, 'existing'); await sshDraft(editor, 'fixture-existing');
    const keyBox = editor.locator('#cred-secrets-privateKey'); await keyBox.fill(typedKey);
    check(await keyBox.evaluate(el => el.classList.contains('tc-cred-masked')) && !(await markup()).includes(typedKey), 'a pasted private key stays masked and out of the markup');
    await editor.locator('[data-cred-editor="save"]').click(); await editor.locator('#cred-passphrase').waitFor();
    await editor.locator('#cred-passphrase').fill(passphrase);
    check(!(await markup()).includes(passphrase), 'a typed passphrase stays out of the markup');
    await fits('existing key with passphrase'); await capture('ssh-existing');
    await discard(editor);
    await page.unroute('**/credentials/create', answerKey);
    await page.unroute('**/credentials/test', answerTest);

    // A generated key, saved for real. Its first-use scan finds a closed loopback port.
    editor = await addDialog(); await pick(editor, 'ssh'); await install.waitFor(); await sshDraft(editor, 'fixture-ssh');
    await editor.locator('[data-cred-editor="save"]').click(); await editor.waitFor({ state: 'hidden' });
    await inspector.getByRole('heading', { name: 'fixture-ssh', exact: true }).waitFor();
    const savedSsh = await store.forUse('fixture-ssh');
    check(savedSsh.fields.auth === 'key' && savedSsh.secrets.privateKey.includes('PRIVATE KEY') && savedSsh.fields.publicKey.startsWith('ssh-ed25519 '), 'a generated key saves its pair');
    check((await inspector.innerText()).includes('Add this key to a server') && !(await inspector.innerText()).includes('PRIVATE KEY'), 'details offer the install line and never the private key');
    await fits('saved generated key'); await capture('ssh-saved');
    await closeDetails();

    const final = await markup(), neverSent = [secret, token, replacement, external, customSecret, kubeconfig, passphrase, onceSecret, saveToken], pastedValues = [pasted, typedKey];
    for (const value of [...neverSent, ...pastedValues]) check(!final.includes(value), 'no saved or typed secrets remain in markup');
    // The paste box answers with what was pasted, to sort it into the form. Nothing else may.
    for (const { route, body } of await Promise.all(responseBodies)) for (const value of route.endsWith('/detect') ? neverSent : [...neverSent, ...pastedValues]) check(!body.includes(value), 'no credential response echoes a secret: ' + route);
    same(pageErrors, [], 'no page errors');
    same(unexpected, [], 'nothing left loopback or reached the real SSH paths');
    await fits('end of the run');
    await page.close();
    console.log(`PASS vault ${theme} ${width} ${mode} (${checks} checks so far)`);
  }
  check(!f.logs().includes(secret) && !f.logs().includes(token) && !f.logs().includes(pasted) && !f.logs().includes(customSecret), 'service logs do not expose fixture credentials');
  check((await fs.readFile(path.join(f.home, '.ssh/config'), 'utf8')).includes('Include'), 'the Include line went into the temporary home');
  same(await outside(), outsideBefore, 'the real home was not touched');
  console.log('PASS ' + checks + ' Vault browser checks');
} catch (error) {
  await openPage?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally { await browser.close(); loopback.closeAllConnections(); await new Promise(resolve => loopback.close(resolve)); await f.close(); }
