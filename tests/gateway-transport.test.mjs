import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeGateway } from '../docker/setup/gateways/probe.mjs';
import { probeHub } from '../docker/setup/gateways/hub.mjs';
import { gatewayFetch } from '../docker/setup/gateways/transport.mjs';
import { isBlockedIp, parseAddress } from '../docker/setup/gateways/address.mjs';

const json = (response, body) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
async function server(t, handler, tls) {
  const requests = [];
  const listener = (request, response) => {
    requests.push({ url: request.url, headers: request.headers, servername: request.socket.servername });
    request.resume(); handler(request, response);
  };
  const instance = tls ? https.createServer(tls, listener) : http.createServer(listener);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return { requests, port: instance.address().port };
}
const api = (request, response) => json(response, request.url === '/v1/models' ? { data: [{ id: 'model-one' }] } : {});

test('real credential requests use the checked DNS answer for every route and preserve Host', async t => {
  const peer = await server(t, api); let lookups = 0;
  const result = await probeGateway({ url: `http://pinned-gateway.invalid:${peer.port}`, key: 'fixture-key', allowPrivateHost: true,
    lookup: async () => ++lookups === 1 ? '127.0.0.1' : '169.254.169.254' });
  assert.equal(result.ok, true); assert.equal(lookups, 1);
  assert.ok(peer.requests.filter(request => request.headers.authorization === 'Bearer fixture-key').length >= 4);
  assert.ok(peer.requests.every(request => request.headers.host === `pinned-gateway.invalid:${peer.port}`));
  assert.equal(peer.requests[0].headers.authorization, undefined);
});

test('mixed public/private DNS answers require consent and DNS failure sends no request', async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched++; throw new Error('No request should be made'); };
  const result = await probeGateway({ url: 'https://public-gateway.invalid', key: 'fixture-key', fetchImpl,
    lookup: async () => [{ address: '1.1.1.1' }, { address: '::ffff:7f00:1' }] });
  assert.equal(result.code, 'private-host'); assert.equal(fetched, 0);
  for (const lookup of [async () => null, async () => [], async () => { throw Object.assign(new Error(), { code: 'ENOTFOUND' }); }]) {
    assert.equal((await probeGateway({ url: 'https://public-gateway.invalid', key: 'fixture-key', fetchImpl, lookup })).code, 'dns');
  }
  assert.equal(fetched, 0);
});

test('DNS resolution uses the same bounded probe deadline', async t => {
  const peer = await server(t, api);
  const result = await probeGateway({ url: `http://slow.invalid:${peer.port}`, key: 'fixture-key', timeoutMs: 30, lookup: () => new Promise(() => {}) });
  assert.equal(result.code, 'timeout'); assert.equal(peer.requests.length, 0);
});

test('IPv6 link-local, metadata and mapped loopback forms require literal boolean consent', () => {
  for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a9fe:a9fe', 'fe80::1', 'febf::1', 'fd00:ec2::254', '::']) {
    assert.equal(isBlockedIp(address), true, address);
    assert.equal(parseAddress(`http://[${address}]`).code, 'private-host', address);
    assert.equal(parseAddress(`http://[${address}]`, { allowPrivateHost: 'false' }).code, 'private-host', address);
    assert.equal(parseAddress(`http://[${address}]`, { allowPrivateHost: true }).ok, true, address);
  }
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
});

test('a landing-page redirect does not reject working API paths or send a key to the target', async t => {
  const target = await server(t, api);
  const peer = await server(t, (request, response) => {
    if (request.url === '/') { response.writeHead(302, { location: `http://127.0.0.1:${target.port}` }); response.end(); }
    else api(request, response);
  });
  const result = await probeGateway({ url: `http://127.0.0.1:${peer.port}`, allowPrivateHost: true, key: 'fixture-key' });
  assert.equal(result.ok, true); assert.equal(target.requests.length, 0);
});

test('management credentials use a pinned transport and never follow redirects', async t => {
  const target = await server(t, api); let redirect = false, lookups = 0;
  const peer = await server(t, (request, response) => {
    if (request.url === '/v0/management/auth-files' && redirect) { response.writeHead(302, { location: `http://127.0.0.1:${target.port}` }); response.end(); }
    else json(response, { files: [{ provider: 'claude', token: 'must-not-leave-probe' }] });
  });
  const input = { url: `http://management.invalid:${peer.port}`, key: 'fixture-management', allowPrivateHost: true, lookup: async () => { lookups++; return '127.0.0.1'; } };
  const result = await probeHub(input);
  assert.equal(result.ok, true); assert.equal(lookups, 1);
  assert.equal(peer.requests[0].headers.authorization, undefined);
  assert.equal(peer.requests[1].headers.authorization, 'Bearer fixture-management');
  assert.ok(!JSON.stringify(result).includes('must-not-leave-probe'));
  redirect = true; assert.equal((await probeHub(input)).ok, false); assert.equal(target.requests.length, 0);
});

test('a pinned probe cannot send a key to a different origin', async t => {
  const peer = await server(t, api);
  const fetchPinned = await gatewayFetch(parseAddress(`http://127.0.0.1:${peer.port}`, { allowPrivateHost: true }), { allowPrivateHost: true });
  await assert.rejects(fetchPinned('http://different.invalid/', { headers: { authorization: 'fixture-key' } }), /change origin/);
  assert.equal(peer.requests.length, 0);
});

test('HTTPS pinning preserves SNI and certificate hostname checks', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 't3-gateway-tls-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem'), exec = promisify(execFile);
  await exec('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=pinned-gateway.invalid', '-addext', 'subjectAltName=DNS:pinned-gateway.invalid', '-keyout', key, '-out', cert]);
  const peer = await server(t, api, { key: await fs.readFile(key), cert: await fs.readFile(cert) });
  const input = { url: `https://pinned-gateway.invalid:${peer.port}`, allowPrivateHost: true, key: 'fixture-key' };
  assert.equal((await probeGateway({ ...input, lookup: async () => '127.0.0.1' })).code, 'tls');
  assert.equal(peer.requests.length, 0, 'untrusted TLS never receives credentials');
  const probeModule = new URL('../docker/setup/gateways/probe.mjs', import.meta.url).href;
  const child = async url => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', `import { probeGateway } from ${JSON.stringify(probeModule)}; console.log(JSON.stringify(await probeGateway({ ...${JSON.stringify({ ...input, url })}, lookup: async () => '127.0.0.1' })));`], { env: { PATH: '/usr/bin:/bin', NODE_EXTRA_CA_CERTS: cert }, timeout: 5000 })).stdout);
  assert.equal((await child(input.url)).ok, true);
  assert.ok(peer.requests.every(request => request.servername === 'pinned-gateway.invalid'));
  const before = peer.requests.length;
  assert.equal((await child(`https://wrong-name.invalid:${peer.port}`)).code, 'tls');
  assert.equal(peer.requests.length, before, 'a mismatched certificate never receives a request');
});
