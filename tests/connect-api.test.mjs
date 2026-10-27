import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);

test('connection saves survive failed refreshes and sign-in forwards only supported modes', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-connect-api-'));
  const launcher = path.join(root, 't3.mjs');
  const nativeState = { linked: true, managedTunnelActive: true, publishAgentActivity: false, holdWebhooksWhileOffline: false };
  let nativeReads = 0;
  let heldRead = null;
  const native = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/connect/link-state') {
      nativeReads++;
      const snapshot = JSON.stringify(nativeState), held = heldRead; heldRead = null;
      if (held) { held.started(); await held.wait; }
      res.end(snapshot);
    }
    else if (req.url === '/api/connect/preferences') {
      let body = ''; for await (const chunk of req) body += chunk;
      Object.assign(nativeState, JSON.parse(body));
      res.end(JSON.stringify(nativeState));
    } else { res.statusCode = 404; res.end('{}'); }
  }).listen(0, '127.0.0.1');
  await once(native, 'listening');
  await fs.writeFile(launcher, `#!${process.execPath}
import fs from 'node:fs/promises';
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
if (args[0] === 'connect' && args[1] === 'status') {
  try { await fs.access(root + '/fail-status'); process.exit(1); } catch {}
  console.log(JSON.stringify({ desired: true, authenticated: true, linked: true }));
} else if (args[0] === 'connect' && args[1] === 'link') {
  // The parent waits for this file to appear. Publish only complete JSON.
  await fs.writeFile(root + '/link-args.tmp', JSON.stringify(args));
  await fs.rename(root + '/link-args.tmp', root + '/link-args');
  console.log('Open this URL on a device with a browser:\\nhttps://fixture.invalid/device\\nConfirm this code when asked: TEST-CODE');
  setInterval(() => {}, 1000);
} else if (args[0] === 'auth' && args[2] === 'issue') {
  console.log(JSON.stringify({ token: 'fixture', sessionId: 'console', expiresAt: '2099-01-01T00:00:00Z' }));
} else if (args[0] === 'auth') console.log('[]');
else process.exit(1);
`, { mode: 0o700 });
  const portProbe = createServer().listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const home = path.join(root, 'home'); await fs.mkdir(home);
  const env = { ...process.env, HOME: home, T3CODE_HOME: path.join(home, '.t3'), T3_WORKSPACE: root,
    T3_SETUP_KEY: 'fixture', T3_SETUP_KEY_SOURCE: 'env', T3_SETUP_PORT: String(port), T3CODE_PORT: String(native.address().port),
    T3_INFRA_LAUNCHER: launcher, T3_HARNESS_MODULE: fileURLToPath(new URL('../docker/harness/index.mjs', import.meta.url)),
    MISE_DATA_DIR: path.join(root, 'mise-data'), MISE_STATE_DIR: path.join(root, 'mise-state'), MISE_CONFIG_DIR: path.join(root, 'mise-config') };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/setup/server.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
  t.after(async () => {
    if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
    native.closeAllConnections(); await new Promise(resolve => native.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = (route, body, headers = { 'x-t3-setup-key': 'fixture' }) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { await request('/hello'); break; } catch { await pause(20); }
  }
  const first = await (await request('/status')).json();
  assert.equal(first.connect.preferences.publishAgentActivity, false);
  assert.equal((await request('/connect/preferences', { publishAgentActivity: true }, {})).status, 401);
  assert.equal((await request('/connect/preferences', { publishAgentActivity: true }, { 'x-t3-setup-key': 'fixture', 'sec-fetch-site': 'cross-site' })).status, 403);
  await fs.writeFile(path.join(root, 'fail-status'), 'yes');
  const beforeReads = nativeReads;
  const saved = await request('/connect/preferences', { publishAgentActivity: true });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).preferences.publishAgentActivity, true);
  assert.equal(nativeReads - beforeReads, 1, 'only the pre-save read is needed');
  const after = await (await request('/status')).json();
  assert.equal(after.connect.preferences.publishAgentActivity, true, 'a failed CLI refresh must keep the confirmed save');
  assert.equal(after.connect.publishAgentActivity, true, 'the CLI-shaped field must agree with preferences');

  await fs.rm(path.join(root, 'fail-status'));
  await request('/connect/preferences', { publishAgentActivity: false });
  let started, release;
  const reading = new Promise(resolve => { started = resolve; });
  heldRead = { started, wait: new Promise(resolve => { release = resolve; }) };
  t.after(() => release());
  const oldPoll = request('/status');
  await reading;
  const newer = await request('/connect/preferences', { publishAgentActivity: true });
  assert.equal(newer.status, 200);
  release(); await oldPoll; await pause(20);
  assert.equal((await (await request('/status')).json()).connect.preferences.publishAgentActivity, true, 'an older in-flight read cannot replace a confirmed save');

  nativeState.linkRevoked = true;
  assert.equal((await request('/connect/preferences', { publishAgentActivity: false })).status, 409);
  const revoked = (await (await request('/status')).json()).connect;
  assert.equal(revoked.state, 'signin', 'live revocation wins over an older CLI link');
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.linked, false);

  for (const mode of ['publish_only', 'managed']) {
    const start = await request('/auth/signin', { agent: 'connect', mode });
    assert.equal(start.status, 200);
    const session = await start.json();
    for (let i = 0; i < 100; i++) { try { await fs.access(path.join(root, 'link-args')); break; } catch { await pause(10); } }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'link-args'), 'utf8')), ['connect', 'link', '--headless', ...(mode === 'publish_only' ? ['--publish-only'] : [])]);
    await request('/auth/cancel', { id: session.id });
    await fs.rm(path.join(root, 'link-args'));
  }
  for (const mode of ['invalid', '--headless', null, true, {}]) assert.equal((await request('/auth/signin', { agent: 'connect', mode })).status, 400);
  await assert.rejects(fs.access(path.join(root, 'link-args')), { code: 'ENOENT' });

  const login = fileURLToPath(new URL('../docker/bin/t3-login', import.meta.url));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = ['bash', login, 'connect', 'link', '--publish-only', '--help'].map(quote).join(' ');
  // A help-only launcher exits immediately; no account or device sign-in is used.
  await fs.writeFile(launcher, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const result = await exec('script', ['-q', '-e', '-c', command, '/dev/null'], { env, timeout: 10000 });
  assert.match(result.stdout, /\["connect","link","--publish-only","--help"\]/);
});
