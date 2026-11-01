import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiAuth, parsePiModelList, piAgentDir, piEnvCredentials, PI_KEY_PROVIDERS, PI_CREDENTIAL_ENV, readPiAuth } from '../docker/harness/pi-auth.mjs';
import { CATALOGUE } from '../docker/harness/catalogue.mjs';
import { detectAuth } from '../docker/harness/probe.mjs';
import { authFixture } from './fixtures/opencode-auth.mjs';

const tempHome = async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-pi-auth-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
};
const authPath = (home) => path.join(home, '.pi/agent/auth.json');
const readAuth = async (home) => JSON.parse(await fs.readFile(authPath(home), 'utf8'));
const seed = async (home, value) => {
  await fs.mkdir(path.dirname(authPath(home)), { recursive: true });
  await fs.writeFile(authPath(home), typeof value === 'string' ? value : JSON.stringify(value));
};
const SUBSCRIPTION = { type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: 1 };

test('a saved key joins auth.json beside subscriptions and other keys, private to the user', async (t) => {
  const home = await tempHome(t);
  await seed(home, { anthropic: SUBSCRIPTION, openai: { type: 'api_key', key: 'sk-old' } });
  let changes = 0;
  const auth = createPiAuth({ home, env: {}, onChange: async () => { changes++; } });
  assert.deepEqual(await auth.saveKey('openrouter', '  sk-or-new  '), { ok: true, replaced: null });
  assert.deepEqual(await readAuth(home), { anthropic: SUBSCRIPTION, openai: { type: 'api_key', key: 'sk-old' }, openrouter: { type: 'api_key', key: 'sk-or-new' } });
  assert.equal((await fs.stat(authPath(home))).mode & 0o777, 0o600);
  assert.equal(changes, 1);
  await assert.rejects(fs.access(authPath(home) + '.lock'), 'the lock is released');
  assert.deepEqual((await fs.readdir(path.dirname(authPath(home)))).sort(), ['auth.json'], 'no temporary file is left behind');
  // Listing names providers and kinds only, never a secret.
  const listed = await auth.list();
  assert.deepEqual(listed.saved, [{ provider: 'anthropic', type: 'oauth' }, { provider: 'openai', type: 'api_key' }, { provider: 'openrouter', type: 'api_key' }]);
  assert.ok(!JSON.stringify(listed).includes('sk-'));
});

test('a key replaces a subscription only when asked, and keeps settings saved with an earlier key', async (t) => {
  const home = await tempHome(t);
  await seed(home, { anthropic: SUBSCRIPTION, 'cloudflare-workers-ai': { type: 'api_key', key: 'old', env: { CLOUDFLARE_ACCOUNT_ID: 'account' } } });
  const auth = createPiAuth({ home, env: {} });
  await assert.rejects(auth.saveKey('anthropic', 'sk-ant-new'), (error) => error.code === 'subscription-exists' && /subscription/.test(error.message));
  assert.deepEqual((await readAuth(home)).anthropic, SUBSCRIPTION, 'a refused save leaves the sign-in in place');
  assert.deepEqual(await auth.saveKey('anthropic', 'sk-ant-new', { replaceSubscription: true }), { ok: true, replaced: 'oauth' });
  assert.deepEqual((await readAuth(home)).anthropic, { type: 'api_key', key: 'sk-ant-new' });
  assert.deepEqual(await auth.saveKey('cloudflare-workers-ai', 'new'), { ok: true, replaced: 'api_key' });
  assert.deepEqual((await readAuth(home))['cloudflare-workers-ai'], { type: 'api_key', key: 'new', env: { CLOUDFLARE_ACCOUNT_ID: 'account' } });
});

test('keys Pi would run or expand, and malformed input, are refused before anything is written', async (t) => {
  const home = await tempHome(t);
  const auth = createPiAuth({ home, env: {} });
  for (const key of ['!cat ~/.ssh/id_rsa', 'sk-$HOME', 'sk-${OPENAI_API_KEY}', 'two words', 'line\nbreak', '', '   ', 'x'.repeat(1001)]) {
    await assert.rejects(auth.saveKey('openai', key), Error, JSON.stringify(key));
  }
  for (const provider of ['', '../evil', 'a b', '-dash', 'x'.repeat(65), null]) {
    await assert.rejects(auth.saveKey(provider, 'sk-fine'), /provider/, String(provider));
  }
  await assert.rejects(fs.access(authPath(home)), 'nothing was created');
});

test('removing a provider leaves every other sign-in', async (t) => {
  const home = await tempHome(t);
  await seed(home, { anthropic: SUBSCRIPTION, openai: { type: 'api_key', key: 'sk-old' } });
  const auth = createPiAuth({ home, env: {} });
  assert.deepEqual(await auth.removeProvider('anthropic'), { ok: true, removed: true });
  assert.deepEqual(await readAuth(home), { openai: { type: 'api_key', key: 'sk-old' } });
  const before = await fs.stat(authPath(home));
  assert.deepEqual(await auth.removeProvider('anthropic'), { ok: true, removed: false });
  assert.equal((await fs.stat(authPath(home))).mtimeMs, before.mtimeMs, 'removing nothing writes nothing');
});

test('an unreadable auth.json is reported and never overwritten', async (t) => {
  const home = await tempHome(t);
  const auth = createPiAuth({ home, env: {} });
  for (const text of ['{broken', '[]', '{"openai":"sk-plain"}']) {
    await seed(home, text);
    await assert.rejects(auth.saveKey('openai', 'sk-new'), /not valid/);
    await assert.rejects(auth.list(), /not valid/);
    assert.equal(await fs.readFile(authPath(home), 'utf8'), text);
  }
  await seed(home, '﻿' + JSON.stringify({ openai: { type: 'api_key', key: 'k' } }));
  assert.deepEqual(Object.keys(await readPiAuth({ home, env: {} })), ['openai'], 'a byte order mark is tolerated, as Pi does');
  await seed(home, '');
  assert.deepEqual(await readPiAuth({ home, env: {} }), {}, 'Pi creates the file empty');
});

test('a linked auth.json is written through its link; a dangling link is refused', async (t) => {
  const home = await tempHome(t);
  const real = path.join(home, 'state/pi-auth.json');
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, JSON.stringify({ openai: { type: 'api_key', key: 'sk-old' } }));
  await fs.mkdir(path.dirname(authPath(home)), { recursive: true });
  await fs.symlink(real, authPath(home));
  const auth = createPiAuth({ home, env: {} });
  await auth.saveKey('groq', 'gsk-new');
  assert.ok((await fs.lstat(authPath(home))).isSymbolicLink(), 'the link stays a link');
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(real, 'utf8'))).sort(), ['groq', 'openai']);
  await fs.rm(real);
  await assert.rejects(auth.saveKey('groq', 'gsk-other'), /links to a missing file/);
  await assert.rejects(fs.access(real), 'nothing is created at the link target');
});

test('Setup waits for Pi’s lock, gives up on a busy one, and clears an abandoned one', async (t) => {
  const home = await tempHome(t);
  await seed(home, {});
  const lock = authPath(home) + '.lock';
  let clock = Date.now();
  const lockOptions = { now: () => clock, wait: async (ms) => { clock += ms; } };
  await fs.mkdir(lock);
  const auth = createPiAuth({ home, env: {}, lockOptions });
  await assert.rejects(auth.saveKey('openai', 'sk-new'), /saving its sign-ins right now/);
  assert.deepEqual(await readAuth(home), {});
  await fs.access(lock);
  // proper-lockfile refreshes a held lock; one untouched past Pi's 30 s is abandoned.
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lock, old, old);
  clock = Date.now();
  await auth.saveKey('openai', 'sk-new');
  assert.equal((await readAuth(home)).openai.key, 'sk-new');
  await assert.rejects(fs.access(lock));

  // A lock released while Setup waits is taken over.
  await fs.mkdir(lock);
  const released = { now: () => Date.now(), wait: async () => { await fs.rm(lock, { recursive: true, force: true }); } };
  await createPiAuth({ home, env: {}, lockOptions: released }).saveKey('groq', 'gsk-new');
  assert.equal((await readAuth(home)).groq.key, 'gsk-new');
});

test('PI_CODING_AGENT_DIR moves the file, with ~ meaning the home directory', async (t) => {
  const home = await tempHome(t);
  assert.equal(piAgentDir(home, {}), path.join(home, '.pi/agent'));
  assert.equal(piAgentDir(home, { PI_CODING_AGENT_DIR: '~/profiles/work' }), path.join(home, 'profiles/work'));
  assert.equal(piAgentDir(home, { PI_CODING_AGENT_DIR: '/srv/pi' }), '/srv/pi');
  assert.equal(piAgentDir(home, { PI_CODING_AGENT_DIR: 'relative' }), path.join(home, 'relative'));
  await createPiAuth({ home, env: { PI_CODING_AGENT_DIR: '~/profiles/work' } }).saveKey('openai', 'sk-work');
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'profiles/work/auth.json'), 'utf8')).openai.key, 'sk-work');
  await assert.rejects(fs.access(authPath(home)));
});

test('environment keys are found the way Pi reads them', () => {
  assert.deepEqual(piEnvCredentials({ ANTHROPIC_OAUTH_TOKEN: 't', OPENROUTER_API_KEY: ' ', COPILOT_GITHUB_TOKEN: 'g', UNRELATED: 'x' }),
    [{ provider: 'anthropic', variable: 'ANTHROPIC_OAUTH_TOKEN' }, { provider: 'github-copilot', variable: 'COPILOT_GITHUB_TOKEN' }]);
  assert.equal(new Set(PI_KEY_PROVIDERS.map((provider) => provider.id)).size, PI_KEY_PROVIDERS.length);
  const pi = CATALOGUE.find((entry) => entry.id === 'pi');
  assert.equal(pi.auth, 'pi');
  assert.deepEqual(pi.credentials.env, PI_CREDENTIAL_ENV);
  assert.ok(pi.credentials.env.includes('OPENAI_API_KEY') && pi.credentials.env.includes('COPILOT_GITHUB_TOKEN'));
});

test('the model list decides sign-in, and output it cannot read decides nothing', () => {
  const table = 'provider    model                 context  max-out  thinking  images\nanthropic   claude-fable-5        1M       128K     yes       yes\nopenrouter  qwen/qwen3-coder      262K     66K      no        no\n';
  assert.deepEqual(parsePiModelList(table), { available: true, providers: ['anthropic', 'openrouter'] });
  assert.deepEqual(parsePiModelList('No models available. Use /login to log into a provider via OAuth or API key. See:\n  /docs/providers.md'), { available: false, providers: [] });
  assert.equal(parsePiModelList('provider    model\n').available, null, 'a header alone is not a verdict');
  assert.equal(parsePiModelList('Error: something else').available, null);
  assert.equal(parsePiModelList('').available, null);
});

test('the Pi probe asks the managed executable for its models, offline', async () => {
  const entry = CATALOGUE.find((item) => item.id === 'pi');
  const calls = [];
  const ctx = (result) => ({ home: '/home/t3', env: { HOME: '/home/t3' }, timeouts: { probe: 1000 },
    run: async (argv, options) => { calls.push({ argv, options }); return { code: 0, stdout: '', stderr: '', error: null, ...result }; } });
  const facts = { executable: '/mise/pi', runnable: true, version: '1.4.0' };
  assert.equal(await detectAuth(ctx({ stdout: 'provider  model\nopenai    gpt-5\n' }), entry, facts), true);
  assert.deepEqual(calls[0].argv, ['/mise/pi', '--list-models']);
  assert.equal(calls[0].options.env.PI_OFFLINE, '1');
  assert.equal(calls[0].options.env.HOME, '/home/t3');
  assert.equal(await detectAuth(ctx({ stdout: 'No models available. Use /login' }), entry, facts), false);
  assert.equal(await detectAuth(ctx({ error: 'timed out', stdout: 'provider  model\nopenai    gpt-5\n' }), entry, facts), null);
  assert.equal(await detectAuth(ctx({ code: 1, stderr: 'Unknown flag' }), entry, facts), null);
  assert.equal(await detectAuth(ctx({}), entry, { ...facts, runnable: false }), false);
});

test('Setup saves, lists and removes Pi sign-ins over HTTP without returning a secret', { timeout: 20000 }, async (t) => {
  const f = await authFixture(); t.after(f.close);
  const file = path.join(f.home, '.pi/agent/auth.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ anthropic: SUBSCRIPTION }));
  assert.equal((await fetch(f.base + '/providers?agent=pi')).status, 401);
  const listed = await (await f.request('/providers?agent=pi')).json();
  assert.ok(listed.providers.some((provider) => provider.id === 'openrouter' && provider.name === 'OpenRouter'));
  assert.deepEqual(listed.credentials.saved, [{ provider: 'anthropic', type: 'oauth' }]);
  assert.equal(listed.names.anthropic, 'Anthropic');
  assert.equal((await f.request('/auth/apikey', { agent: 'pi', provider: 'openrouter', key: 'sk-or-fixture' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const saved = await f.request('/auth/apikey', { agent: 'pi', provider: 'openrouter', key: 'sk-or-fixture' });
  assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes('sk-or-fixture'));
  const refused = await f.request('/auth/apikey', { agent: 'pi', provider: 'anthropic', key: 'sk-ant-fixture' });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, 'subscription-exists');
  assert.equal((await f.request('/auth/apikey', { agent: 'pi', provider: 'anthropic', key: 'sk-ant-fixture', replace: true })).status, 200);
  const after = await (await f.request('/providers?agent=pi')).json();
  assert.deepEqual(after.credentials.saved, [{ provider: 'anthropic', type: 'api_key' }, { provider: 'openrouter', type: 'api_key' }]);
  assert.ok(!JSON.stringify(after).includes('sk-'), 'the catalogue never carries a key');
  const removed = await f.request('/auth/apikey/remove', { agent: 'pi', provider: 'openrouter' });
  assert.deepEqual(await removed.json(), { ok: true, removed: true });
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))), ['anthropic']);
  const failure = await f.request('/auth/apikey', { agent: 'pi', provider: 'openai', key: '!echo leaked-sentinel' });
  assert.equal(failure.status, 400);
  assert.ok(!(await failure.text()).includes('leaked-sentinel'));
});
