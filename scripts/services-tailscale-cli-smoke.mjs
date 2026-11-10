// Exercise the installed CLI against a disposable LocalAPI. This verifies the
// command/config contract without signing in, contacting a provider or opening
// a real forwarding route. Remote tailnet acceptance remains a separate gate.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executable = process.argv[2];
assert.ok(executable, 'Usage: node scripts/services-tailscale-cli-smoke.mjs TAILSCALE');
const exec = promisify(execFile), root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-tail-cli-'));
const socket = path.join(root, 'localapi.sock');
const original = { TCP: { '22223': { TCPForward: '127.0.0.1:8080' } } };
let config = structuredClone(original);
const writes = [], unexpected = [];
const status = { BackendState: 'Running', TailscaleIPs: ['100.64.0.1'], Self: { DNSName: 'fixture.test.ts.net.', Online: true }, CurrentTailnet: { MagicDNSSuffix: 'test.ts.net' } };
const server = http.createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  const pathname = new URL(request.url, 'http://local-tailscaled.sock').pathname;
  if (request.method === 'GET' && pathname === '/localapi/v0/status') return response.end(JSON.stringify(status));
  if (request.method === 'GET' && pathname === '/localapi/v0/serve-config') return response.end(JSON.stringify(config));
  if (request.method === 'POST' && pathname === '/localapi/v0/serve-config') {
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; assert.ok(body.length <= 65536); }
      config = JSON.parse(body); writes.push(structuredClone(config));
      return response.end('{}');
    } catch {
      unexpected.push('invalid serve configuration');
      response.writeHead(400); return response.end('{}');
    }
  }
  unexpected.push(request.method + ' ' + pathname);
  response.writeHead(501); response.end('{}');
});
const run = args => exec(executable, ['--socket=' + socket, 'serve', ...args], {
  timeout: 10000, maxBuffer: 65536,
  env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await run(['--bg', '--tcp=22222', 'tcp://127.0.0.1:22222']);
  assert.equal(writes.length, 1);
  assert.equal(config.TCP['22222'].TCPForward, '127.0.0.1:22222');
  assert.deepEqual(config.TCP['22223'], original.TCP['22223']);
  assert.equal(config.Foreground, undefined);
  const enabled = JSON.parse((await run(['status', '--json'])).stdout);
  assert.deepEqual(enabled, config);
  await run(['--tcp=22222', 'off']);
  assert.equal(writes.length, 2);
  assert.deepEqual(config, original);
  const disabled = JSON.parse((await run(['status', '--json'])).stdout);
  assert.deepEqual(disabled, original);
  assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ ok: true, arch: process.arch, checks: ['real pinned Tailscale CLI', 'background TCP Serve', 'JSON status', 'targeted off command', 'unrelated route preserved', 'isolated LocalAPI only'] }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
