#!/usr/bin/env node
// Runs inside either built image, using a disposable connection and local API.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
const run = promisify(execFile), secret = 'fixture-image-credential-' + process.pid;
const state = process.env.T3CODE_HOME || '/home/t3/.t3';
const key = process.env.T3_SETUP_KEY || (await readFile(state + '/setup-key', 'utf8')).trim();
const port = process.env.T3_SETUP_PORT || '3774';
const request = async (route, body) => {
  const response = await fetch('http://127.0.0.1:' + port + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-t3-setup-key': key, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); assert.equal(text.includes(secret), false); assert.equal(response.status, 200, text); return JSON.parse(text);
};
const server = createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer ' + secret);
  res.end(JSON.stringify({ status: 'ok', echo: secret }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const id = 'smoke-credential-' + process.pid;
let created = false;
try {
  await access('/opt/t3-setup/credentials/askpass.sh', constants.X_OK);
  for (const cli of ['t3-ssh', 't3-api']) assert.match((await run('/usr/local/bin/' + cli, ['--help'])).stdout, /Manage connections/);
  let snapshot = await request('/credentials');
  await request('/credentials/create', { revision: snapshot.revision, profile: { id, label: 'Disposable image check', type: 'api', baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/', secret } });
  created = true; snapshot = await request('/credentials');
  assert.equal(snapshot.profiles.find(profile => profile.id === id).hasSecret, true);
  await request('/credentials/test', { id, revision: snapshot.revision });
  const { stdout, stderr } = await run('/usr/local/bin/t3-api', [id, 'GET', 'states']);
  assert.deepEqual(JSON.parse(stdout), { status: 'ok', echo: '[redacted]' }); assert.equal(stderr, '');
  console.log('PASS saved API credentials and installed SSH/API helpers');
} finally {
  try { if (created) { const snapshot = await request('/credentials'); await request('/credentials/remove', { id, revision: snapshot.revision }); } }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
