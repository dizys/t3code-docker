// Real HTTP service: a custom key with punctuation must survive the
// login round-trip, an accepted key must reset the guessing delay however
// it arrived, and a hostile X-Forwarded-Prefix must never become the
// mount. Same harness as setup-auth-lists, against the real server in a
// disposable home.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Exercises every step that used to break: @ and # need decoding, = needs
// the first-= split, ; and % would corrupt an unencoded value.
const KEY = 'p@ss#x=1;100%';

test('punctuated key round-trips, throttle resets on any accepted key, hostile prefix is refused', { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-login-auth-'));
  const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const home = path.join(root, 'home'); await fs.mkdir(home);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/setup/server.mjs', import.meta.url))], { env: {
    ...process.env, HOME: home, T3CODE_HOME: path.join(home, '.t3'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), T3_WORKSPACE: root,
    MISE_DATA_DIR: path.join(root, 'mise-data'), MISE_STATE_DIR: path.join(root, 'mise-state'), MISE_CONFIG_DIR: path.join(root, 'mise-config'),
    T3_HARNESS_MODULE: fileURLToPath(new URL('../docker/harness/index.mjs', import.meta.url)),
    T3_SETUP_KEY: KEY, T3_SETUP_KEY_SOURCE: 'env', T3_SETUP_PORT: String(port), T3CODE_PORT: '1', T3_INFRA_LAUNCHER: '/bin/false',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', (x) => { logs += x; }); child.stderr.on('data', (x) => { logs += x; });
  t.after(async () => { if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) { if (child.exitCode !== null) throw new Error(logs); try { await fetch(`${base}/hello`); break; } catch { await pause(20); } }
  const timed = async (promise) => { const at = Date.now(); const response = await promise; return { response, ms: Date.now() - at }; };
  const login = (key, headers = {}) => fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual', headers, body: new URLSearchParams({ key }),
  });

  // The cookie /login sets is accepted on the next request: before, the
  // encoded value never matched the raw key and this looped to unlock.
  const good = await login(KEY);
  assert.equal(good.status, 303);
  const setCookie = good.headers.get('set-cookie');
  assert.ok(setCookie?.startsWith(`t3setup=${encodeURIComponent(KEY)};`), setCookie);
  const cookie = setCookie.split(';')[0];
  const signedIn = await (await fetch(`${base}/hello`, { headers: { cookie } })).json();
  assert.equal(signedIn.signedIn, true, 'the cookie just set must authenticate');
  const raw = await (await fetch(`${base}/hello`, { headers: { cookie: `t3setup=${KEY}` } })).json();
  assert.equal(raw.signedIn, false, 'the unencoded key is not the cookie (its ; ends the value)');

  // Wrong keys make later answers wait; an accepted header key - how
  // t3-expose and scripts authenticate - clears that wait again, as a
  // successful /login does. Before, only /login cleared it. Each failure
  // adds 250ms to the *next* throttled answer, so four wrong keys make
  // the following one wait a second - unless a right key reset the count.
  for (let i = 0; i < 4; i++) assert.equal((await login('wrong')).status, 303);
  const throttled = await timed(fetch(`${base}/status`));
  assert.equal(throttled.response.status, 401);
  assert.ok(throttled.ms >= 750, `wrong guesses should slow the next answer, took ${throttled.ms}ms`);
  for (let i = 0; i < 3; i++) assert.equal((await login('wrong')).status, 303);
  const viaHeader = await fetch(`${base}/hello`, { headers: { 'x-t3-setup-key': KEY } });
  assert.equal((await viaHeader.json()).signedIn, true);
  const cleared = await timed(fetch(`${base}/status`));
  assert.equal(cleared.response.status, 401);
  assert.ok(cleared.ms < 250, `an accepted header key should reset the delay, took ${cleared.ms}ms`);

  // A prefix that is not a plain path on this origin must not become the
  // redirect target or the cookie Path.
  for (const prefix of ['/../evil', '//evil.example', '/a//b']) {
    const response = await login(KEY, { 'x-forwarded-prefix': prefix });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/', prefix);
    assert.match(response.headers.get('set-cookie') ?? '', /; Path=\/;/, prefix);
  }
  const mounted = await login(KEY, { 'x-forwarded-prefix': '/__setup' });
  assert.equal(mounted.headers.get('location'), '/__setup/', 'a plain prefix still mounts');
  assert.match(mounted.headers.get('set-cookie') ?? '', /; Path=\/__setup;/);
});
