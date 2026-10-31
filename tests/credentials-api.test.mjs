import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { credentialsFixture } from './fixtures/credentials.mjs';

test('credential HTTP boundary is authenticated, write-only and revision checked', { timeout: 20000 }, async t => {
  const f = await credentialsFixture(); t.after(f.close);
  for (const route of ['/credentials', '/credentials/create', '/credentials/save', '/credentials/test', '/credentials/remove', '/credentials/scan', '/credentials/trust', '/credentials/forget-host-key']) {
    const method = route === '/credentials' ? 'GET' : 'POST';
    assert.equal((await fetch(f.base + route, { method })).status, 401);
  }
  assert.equal((await f.request('/credentials/create', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.request('/credentials', {})).status, 405);
  assert.equal((await f.request('/credentials/create')).status, 405);
  const initial = await (await f.request('/credentials')).json();
  assert.deepEqual(initial.credentials, []);
  const secret = 'fixture-http-credential-456';
  const profile = { id: 'staging-server', label: 'Staging server', type: 'ssh', host: '192.0.2.2', username: 'root', port: 22, secret };
  const created = await (await f.request('/credentials/create', { credential: profile })).json();
  assert.equal(created.ok, true); assert.equal(JSON.stringify(created).includes(secret), false);
  const snapshotResponse = await f.request('/credentials');
  assert.equal(snapshotResponse.headers.get('cache-control'), 'no-store');
  const snapshot = await snapshotResponse.json(); assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(snapshot.credentials[0].hasSecret, true);
  assert.equal((await f.request('/credentials/save', { credential: profile, revision: 'stale' })).status, 409);
  assert.equal((await f.request('/credentials/create', { credential: profile })).status, 409);
  assert.equal((await f.request('/credentials/save', { credential: { ...profile, secret: '' }, revision: created.credential.revision })).status, 200);
  const malformed = await fetch(f.base + '/credentials/create', { method: 'POST', headers: { 'x-t3-setup-key': 'credential-fixture-key' }, body: '{"secret":"' + secret });
  assert.equal(malformed.status, 400); assert.equal((await malformed.text()).includes(secret), false);
  const oversized = await fetch(f.base + '/credentials/create', { method: 'POST', headers: { 'x-t3-setup-key': 'credential-fixture-key' }, body: JSON.stringify({ secret: secret.repeat(4000) }) });
  assert.equal(oversized.status, 413); assert.equal((await oversized.text()).includes(secret), false);
  assert.equal((await f.request('/credentials/create', null)).status, 400);
  const latest = await (await f.request('/credentials')).json();
  assert.equal((await f.request('/credentials/test', { id: profile.id, draft: { ...profile, id: 'different', secret: '' } })).status, 400);
  assert.equal((await f.request('/credentials/remove', { id: profile.id, revision: latest.credentials[0].revision })).status, 200);
  assert.deepEqual((await (await f.request('/credentials')).json()).credentials, []);
  assert.equal(f.logs().includes(secret), false);
});

test('saved API token works through the CLI and connection test without returning the token', { timeout: 20000 }, async t => {
  const f = await credentialsFixture(); t.after(f.close);
  const secret = 'fixture-api-token-789'; let target, failAuth = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + secret);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    target = { url: req.url, method: req.method, body: Buffer.concat(chunks).toString() };
    if (failAuth) { res.writeHead(401); res.end(secret); return; }
    res.end(JSON.stringify({ message: secret, ok: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const initial = await (await f.request('/credentials')).json();
  const saved = await (await f.request('/credentials/create', { credential: { id: 'project-api', label: 'Project API', type: 'api', baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/', secret } })).json();
  const probe = await f.request('/credentials/test', { id: 'project-api', revision: saved.revision });
  assert.equal(probe.status, 200); assert.equal((await probe.text()).includes(secret), false);
  failAuth = true;
  const rejected = await f.request('/credentials/test', { id: 'project-api', revision: saved.revision });
  assert.equal(rejected.status, 200); assert.equal((await rejected.clone().json()).result.code, 'rejected'); assert.equal((await rejected.text()).includes(secret), false);
  failAuth = false;
  const helperEnv = { ...f.env, T3_INFRA_NODE: process.execPath, T3_CREDENTIAL_CLI: fileURLToPath(new URL('../docker/setup/credentials/cli.mjs', import.meta.url)) };
  const child = spawn('/bin/bash', [fileURLToPath(new URL('../docker/bin/t3-api', import.meta.url)), 'project-api', 'POST', 'projects', '--stdin'], { env: helperEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  child.stdin.end('{"name":"demo-project"}');
  const [code] = await once(child, 'close');
  assert.equal(code, 0, err); assert.equal(err, '');
  assert.deepEqual(JSON.parse(out), { message: '[redacted]', ok: true });
  assert.deepEqual(target, { url: '/api/projects', method: 'POST', body: '{"name":"demo-project"}' });
  const help = spawn('/bin/bash', [fileURLToPath(new URL('../docker/bin/t3-ssh', import.meta.url)), '--help'], { env: helperEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let helpText = ''; help.stdout.on('data', chunk => { helpText += chunk; });
  assert.equal((await once(help, 'close'))[0], 0); assert.match(helpText, /t3-ssh CONNECTION/);
  assert.equal(f.logs().includes(secret), false);
});
