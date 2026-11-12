// Only for the disposable real-image tailnet in test-services-tailscale-e2e.sh.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { DatabaseSync } from 'node:sqlite';
import { serviceRequest } from '/opt/t3-services/client.mjs';

const phase = process.argv[2], exec = promisify(execFile), receipt = '/home/t3/.t3/tailscale-fixture-receipt.json';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (domain, action, input = {}) => serviceRequest(domain, action, input);
const until = async (label, fn, timeout = 90000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await pause(200); } throw new Error('Timed out: ' + label); };
const snapshot = () => call('system', 'snapshot');
const tail = async () => (await snapshot()).services.find(item => item.id === 'tailscale');
const apply = async (domain, input) => {
  const plan = await call(domain, 'plan', input), args = { planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: randomUUID(), acknowledgeAccessImpact: true };
  const op = await call(domain, 'apply', args); assert.equal((await call(domain, 'apply', args)).id, op.id);
  const result = await until('service operation', async () => { const value = await call(domain, 'operation', { id: op.id }); return ['succeeded', 'failed', 'rolled-back'].includes(value.state) && value; }, 300000);
  assert.equal(result.state, 'succeeded', result.error || result.state); return { plan, op: result };
};
const edit = async action => { const current = await tail(); return apply('system', { action, id: 'tailscale', expectedRevision: current.revision }); };
const cli = async args => exec((await tail()).artifact.path + '/tailscale', ['--socket=/run/t3code-services/tailscale.sock', ...args], { timeout: 60000, maxBuffer: 65536 });
const connected = () => until('full networking and MagicDNS', async () => { const value = await tail(); return value?.observation.networking?.state === 'ready' && value.observation.networking.dns === 'ready' && value; });
const publicIdentity = async () => { const value = JSON.parse((await cli(['status', '--json'])).stdout); assert.equal(typeof value.Self.PublicKey, 'string'); assert.ok(value.Self.PublicKey.startsWith('nodekey:')); return { key: value.Self.PublicKey, dnsName: value.Self.DNSName, ips: value.TailscaleIPs }; };
const baselineDNS = () => {
  const db = new DatabaseSync('/var/lib/t3code/services/state.sqlite', { readOnly: true });
  try { const row = db.prepare('SELECT value FROM meta WHERE id=?').get('network:tailscale:dns'); return row && JSON.parse(row.value)?.original; } finally { db.close(); }
};
const ordinary = async () => {
  assert.ok((await lookup('control', { family: 4 })).address);
  assert.ok((await lookup('github.com', { family: 4 })).address);
};
const tcp = (host, port, text = 'tcp-roundtrip') => new Promise((resolve, reject) => {
  const socket = net.connect({ host, port }); let received = '';
  const finish = error => { socket.destroy(); error ? reject(error) : resolve(received); };
  socket.setTimeout(5000, () => finish(new Error('TCP deadline'))); socket.on('error', finish);
  socket.on('connect', () => socket.write(text)); socket.on('data', chunk => { received += chunk; if (received.length >= text.length) finish(); });
});
const udp = (host, ipv6 = false) => new Promise((resolve, reject) => {
  const socket = dgram.createSocket(ipv6 ? 'udp6' : 'udp4');
  const timeout = setTimeout(() => { socket.close(); reject(new Error('UDP deadline')); }, 5000);
  socket.on('error', error => { clearTimeout(timeout); socket.close(); reject(error); });
  socket.on('message', message => { clearTimeout(timeout); socket.close(); resolve(message.toString()); });
  socket.send('udp-roundtrip', 9089, host);
});
const httpGet = (url, options = {}) => new Promise((resolve, reject) => {
  const request = (url.startsWith('https:') ? https : http).get(url, options, response => { let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(body)); });
  request.setTimeout(5000, () => request.destroy(new Error('HTTP deadline'))); request.on('error', reject);
});
const exercise = async () => {
  assert.ok(process.getuid() > 0, 'ordinary applications must not need root or proxy settings');
  const peer = JSON.parse(await fs.readFile('/tmp/tailscale-fixture-peer.json', 'utf8')), name = peer.dnsName.replace(/\.$/, ''), address = peer.ips.find(ip => net.isIP(ip) === 4);
  assert.equal((await lookup(name, { family: 4 })).address, address);
  assert.equal((await lookup(name.split('.')[0], { family: 4 })).address, address);
  assert.equal(await tcp(name, 9088), 'tcp-roundtrip'); assert.equal(await tcp(address, 9088), 'tcp-roundtrip');
  assert.equal(await udp(name), 'udp-roundtrip'); assert.equal(await udp(address), 'udp-roundtrip');
  assert.equal(await httpGet('http://' + name + ':8088'), 'tailnet-http');
  assert.equal(await httpGet('https://' + name + ':8089', { ca: await fs.readFile('/tmp/tailscale-fixture-peer.crt') }), 'tailnet-https');
  const ipv6 = peer.ips.find(ip => net.isIP(ip) === 6);
  assert.ok(ipv6, 'the disposable tailnet supplies IPv6'); assert.equal(await tcp(ipv6, 9088), 'tcp-roundtrip'); assert.equal(await udp(ipv6, true), 'udp-roundtrip');
  await ordinary();
};
if (phase === 'exercise') { await exercise(); console.log(JSON.stringify({ ok: true, phase, arch: process.arch, checks: ['unprivileged applications', 'IPv4/IPv6 TCP and UDP', 'HTTP and certificate-verified HTTPS', 'MagicDNS full and short names', 'Docker and public DNS'] })); process.exit(0); }
if (phase === 'ordinary') { await ordinary(); assert.doesNotMatch(await fs.readFile('/etc/resolv.conf', 'utf8'), /Managed by t3code/); console.log(JSON.stringify({ ok: true, phase, arch: process.arch })); process.exit(0); }
await until('system service controller', async () => !(await snapshot()).error);
await until('user service controller', async () => !(await call('user', 'snapshot')).error);
if (phase === 'install-peer' || phase === 'install-client') {
  assert.equal((await snapshot()).requirements.tailscale.ready, true);
  await apply('system', { action: 'install', id: 'tailscale', expectedRevision: 0, configuration: { hostname: phase === 'install-client' ? 'container-client' : 'fixture-peer', enabled: phase === 'install-client', networkMode: phase === 'install-client' ? 'kernel' : 'userspace' } });
} else if (phase === 'connect') {
  await cli(['up', '--login-server=http://control:8080', '--auth-key=file:/run/tailscale-fixture-authkey', '--hostname=container-client', '--accept-dns=false', '--accept-routes=false', '--timeout=45s']);
  await connected(); await fs.rm('/run/tailscale-fixture-authkey', { force: true });
} else if (phase === 'peer') {
  const artifact = (await tail()).artifact;
  const daemon = spawn(artifact.path + '/tailscaled', ['--tun=tailscale0', '--state=/run/tailscale-fixture-peer.state', '--socket=/run/t3code-services/tailscale.sock', '--statedir=/run/tailscale-fixture-peer'], { stdio: 'ignore', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/', TS_DEBUG_FIREWALL_MODE: 'nftables' } });
  daemon.on('error', () => process.exit(1)); daemon.on('exit', () => process.exit(1));
  await until('peer daemon', async () => { await cli(['status', '--json']); return true; });
  await cli(['up', '--login-server=http://control:8080', '--auth-key=file:/run/tailscale-fixture-authkey', '--hostname=fixture-peer', '--accept-dns=false', '--accept-routes=false', '--timeout=45s']);
  const identity = await publicIdentity(), name = identity.dnsName.replace(/\.$/, '');
  await exec('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=' + name, '-addext', 'subjectAltName=DNS:' + name, '-keyout', '/run/tailscale-fixture-peer.key', '-out', '/tmp/tailscale-fixture-peer.crt'], { timeout: 20000 });
  const serve = server => new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
  const plain = http.createServer((_req, res) => res.end('tailnet-http')); const p1 = serve(plain); plain.listen(8088); await p1;
  const secure = https.createServer({ key: await fs.readFile('/run/tailscale-fixture-peer.key'), cert: await fs.readFile('/tmp/tailscale-fixture-peer.crt') }, (_req, res) => res.end('tailnet-https')); const p2 = serve(secure); secure.listen(8089); await p2;
  const echo = net.createServer(socket => socket.pipe(socket)); const p3 = serve(echo); echo.listen(9088); await p3;
  for (const ipv6 of [false, true]) { const socket = dgram.createSocket({ type: ipv6 ? 'udp6' : 'udp4', ipv6Only: ipv6 }); socket.on('message', (message, peer) => socket.send(message, peer.port, peer.address)); await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind({ port: 9089, address: ipv6 ? '::' : '0.0.0.0' }, resolve); }); }
  await fs.writeFile('/tmp/tailscale-fixture-peer.json', JSON.stringify(identity), { mode: 0o644 }); await fs.rm('/run/tailscale-fixture-authkey', { force: true });
  // Keep this disposable peer alive until its container is removed by the trap.
  await new Promise(() => {});
} else if (phase === 'wait-peer') {
  await until('peer applications', async () => { await fs.access('/tmp/tailscale-fixture-peer.json'); return true; });
} else if (phase === 'capture') {
  const resource = await connected(), identity = await publicIdentity(), previous = await fs.readFile(receipt, 'utf8').then(JSON.parse).catch(() => null);
  if (previous) assert.equal(identity.key, previous.identity.key, 'restart and recreation retain the same Tailscale device identity');
  const originalDNS = baselineDNS(); assert.ok(originalDNS); assert.doesNotMatch(originalDNS, /Managed by t3code/);
  await fs.writeFile(receipt, JSON.stringify({ identity, originalDNS, runId: resource.observation.run.runId, custom: previous?.custom, connection: previous?.connection }), { mode: 0o600 });
  await fs.writeFile('/tmp/tailscale-fixture-client.json', JSON.stringify(identity), { mode: 0o644 });
} else if (phase === 'publish') {
  const data = JSON.parse(await fs.readFile(receipt, 'utf8')), script = '/home/t3/tailscale-fixture-listener.mjs';
  await fs.writeFile(script, "import net from 'node:net'; net.createServer(socket => socket.pipe(socket)).listen(9188, '0.0.0.0');\n", { mode: 0o644 }); await fs.chown(script, 1000, 1000);
  const custom = await apply('user', { action: 'add', expectedRevision: 0, configuration: { name: 'Tailnet inbound fixture', mode: 'executable', executable: '/usr/local/bin/node', argv: [script], cwd: '/home/t3', enabled: true, endpoints: [{ protocol: 'tcp', port: 9188 }], health: { kind: 'tcp', port: 9188, intervalMs: 1000, graceMs: 5000 } } });
  const connection = await apply('user', { action: 'connection-save', expectedRevision: 0, configuration: { name: 'Disposable managed tailnet', provider: 'tailscale' } });
  await apply('user', { action: 'route-save', expectedRevision: 0, configuration: { name: 'Explicit TCP publication', serviceDomain: 'user', serviceId: custom.plan.target, connection: connection.plan.target, endpoint: 9188, host: data.identity.dnsName.replace(/\.$/, ''), port: 29188, topology: 'tailnet' } });
  await fs.writeFile(receipt, JSON.stringify({ ...data, custom: custom.plan.target, connection: connection.plan.target }), { mode: 0o600 });
} else if (phase === 'incoming') {
  const client = JSON.parse(await fs.readFile('/tmp/tailscale-fixture-client.json', 'utf8')), address = client.ips.find(ip => net.isIP(ip) === 4);
  await until('explicit TCP Serve publication', async () => await tcp(address, 29188) === 'tcp-roundtrip');
  await assert.rejects(tcp(address, 9188), 'an ordinary all-interface listener must not become implicitly public to the tailnet');
} else if (phase === 'stop' || phase === 'disable') {
  const data = JSON.parse(await fs.readFile(receipt, 'utf8'));
  await edit(phase === 'stop' ? 'stop' : 'disable');
  assert.equal(await fs.readFile('/etc/resolv.conf', 'utf8'), data.originalDNS);
  await assert.rejects(fs.access('/sys/class/net/tailscale0'));
  const tables = JSON.parse((await exec('/usr/sbin/nft', ['-j', 'list', 'tables'])).stdout);
  assert.ok(!tables.nftables.some(item => item.table?.name === 't3code_tailscale'));
  if (data.custom) assert.equal(await tcp('127.0.0.1', 9188), 'tcp-roundtrip', 'other services keep running');
} else if (phase === 'crash') {
  const before = await connected(), previous = before.observation.run.runId;
  process.kill(before.observation.run.payloadPid, 'SIGKILL');
  await until('crash DNS cleanup', async () => !(await fs.readFile('/etc/resolv.conf', 'utf8')).includes('Managed by t3code'), 10000);
  await ordinary();
  const after = await connected(); assert.notEqual(after.observation.run.runId, previous);
} else if (phase === 'disabled') {
  const value = await until('disabled service observation', async () => { const value = await tail(); return value?.observation.state === 'disabled' && value; });
  assert.equal(value.enabled, false); await assert.rejects(fs.access('/sys/class/net/tailscale0')); await ordinary();
} else throw new Error('Unknown disposable test phase');
console.log(JSON.stringify({ ok: true, phase, arch: process.arch }));
