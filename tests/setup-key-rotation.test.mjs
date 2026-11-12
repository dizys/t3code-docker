// Run key replacement through the real HTTP server, including its returned
// cookie and a new server process reading the same persistent key file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('key rotation keeps its browser signed in, rejects old keys and survives a Setup restart', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-key-rotation-'));
  const home = path.join(root, 'home'), state = path.join(home, '.t3'), keyFile = path.join(state, 'setup-key');
  await fs.mkdir(state, { recursive: true });
  const oldKey = 'rotation-fixture-old-key';
  await fs.writeFile(keyFile, oldKey + '\n', { mode: 0o600 });
  const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}/__setup`;
  const env = { ...process.env, HOME: home, T3CODE_HOME: state, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), T3_WORKSPACE: root,
    MISE_DATA_DIR: path.join(root, 'mise-data'), MISE_STATE_DIR: path.join(root, 'mise-state'), MISE_CONFIG_DIR: path.join(root, 'mise-config'),
    T3_HARNESS_MODULE: fileURLToPath(new URL('../docker/harness/index.mjs', import.meta.url)),
    T3_SETUP_KEY: oldKey, T3_SETUP_KEY_SOURCE: 'volume', T3_SETUP_PORT: String(port), T3CODE_PORT: '1', T3_INFRA_LAUNCHER: '/bin/false',
    T3_RUN_DIR: path.join(root, 'run'), T3_RUNTIME_MODULE: fileURLToPath(new URL('../docker/runtime/manager.mjs', import.meta.url)),
  };
  let child, logs = '';
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  };
  t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, [fileURLToPath(new URL('../docker/setup/server.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error('Fixture Setup exited before readiness');
      try { if ((await fetch(base + '/hello')).ok) return; } catch {}
      await pause(20);
    }
    throw new Error('Fixture Setup did not become ready');
  };
  const post = (route, headers, body = '{}') => fetch(base + route, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...headers }, body });
  await start();
  const login = await fetch(base + '/login', { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams({ key: oldKey }) });
  assert.equal(login.status, 200);
  const oldCookie = login.headers.get('set-cookie').split(';')[0];
  const response = await post('/setup-key/replace', { cookie: oldCookie });
  assert.equal(response.status, 200, 'replacement must finish after writing the new key');
  const result = await response.json();
  assert.equal(result.ok, true); assert.notEqual(result.key, oldKey);
  assert.equal(await fs.readFile(keyFile, 'utf8'), result.key + '\n');
  const newCookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal(newCookie, `t3setup=${encodeURIComponent(result.key)}`);
  assert.match(response.headers.get('set-cookie'), /; Path=\/__setup;/);
  assert.equal((await post('/setup-key/reveal', { cookie: oldCookie })).status, 401);
  assert.equal((await post('/setup-key/reveal', { 'x-t3-setup-key': oldKey })).status, 401);
  const reveal = await post('/setup-key/reveal', { cookie: newCookie });
  assert.equal(reveal.status, 200); assert.equal((await reveal.json()).key, result.key);
  assert.equal((await post('/setup-key/reveal', { 'x-t3-setup-key': result.key })).status, 200);
  await stop(); await start();
  assert.equal((await post('/setup-key/reveal', { cookie: oldCookie })).status, 401);
  const after = await post('/setup-key/reveal', { cookie: newCookie });
  assert.equal(after.status, 200); assert.equal((await after.json()).key, result.key);
  assert.equal(logs.includes(oldKey), false); assert.equal(logs.includes(result.key), false);
});
