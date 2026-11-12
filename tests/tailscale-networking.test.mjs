import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dgram from 'node:dgram';
import net from 'node:net';
import { Resolver } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { openStore, ServiceError } from '../docker/services/store.mjs';
import { systemDefinition } from '../docker/services/definition.mjs';
import { createDNSRelay, question, tailnetQuestion, exchangeDNS } from '../docker/services/dns-relay.mjs';
import { createManagedDNS, resolverConfiguration } from '../docker/services/managed-dns.mjs';
import { createTailscaleNetworking, ownedFirewall } from '../docker/services/tailscale-networking.mjs';
import { createController } from '../docker/services/controller.mjs';

const original = '# Docker DNS\nnameserver 127.0.0.11\nsearch workspace.internal\noptions ndots:0 rotate\n';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-tail-network-'));
  const store = openStore(root, { domain: 'system' }), file = path.join(root, 'resolv.conf');
  await fs.writeFile(file, original, { mode: 0o644 });
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, file };
}
function packet(name, id = 42) {
  const labels = name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const header = Buffer.alloc(12); header.writeUInt16BE(id); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}
function answer(query, address = '100.64.0.9', truncated = false) {
  const response = Buffer.from(query); response.writeUInt16BE(truncated ? 0x8380 : 0x8180, 2);
  if (truncated) return response;
  response.writeUInt16BE(1, 6);
  return Buffer.concat([response, Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 10, 0, 4, ...address.split('.').map(Number)])]);
}
async function upstream(t, address, { truncate = false, spoof = false } = {}) {
  const udp = dgram.createSocket('udp4'), reads = [], clients = new Set();
  udp.on('message', (query, peer) => {
    reads.push({ name: question(query).name, tcp: false });
    if (spoof) udp.send(answer(packet('unrelated.invalid', query.readUInt16BE(0)), '192.0.2.99'), peer.port, peer.address);
    udp.send(answer(query, address, truncate), peer.port, peer.address);
  });
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  const port = udp.address().port;
  const tcp = net.createServer(client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    let buffer = Buffer.alloc(0);
    client.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2 || buffer.length < buffer.readUInt16BE(0) + 2) return;
      const query = buffer.subarray(2, buffer.readUInt16BE(0) + 2); reads.push({ name: question(query).name, tcp: true });
      const response = answer(query, address), header = Buffer.alloc(2); header.writeUInt16BE(response.length);
      client.end(Buffer.concat([header, response]));
    });
  });
  await new Promise(resolve => tcp.listen(port, '127.0.0.1', resolve));
  t.after(async () => { for (const client of clients) client.destroy(); await Promise.all([new Promise(resolve => udp.close(resolve)), new Promise(resolve => tcp.close(resolve))]); });
  return { address: '127.0.0.1', port, reads };
}
const inertRelay = events => options => ({ listen: async () => { events.push(['listen', options]); }, configure: config => { events.push(['configure', config]); }, close: async () => { events.push(['close']); } });

test('legacy Tailscale stays userspace and full mode rejects unknown configuration', () => {
  assert.equal(systemDefinition('tailscale', { enabled: false }).networkMode, 'userspace');
  assert.equal(systemDefinition('tailscale', { enabled: true, networkMode: 'kernel' }).networkMode, 'kernel');
  for (const patch of [{ networkMode: 'host' }, { enabled: 'false' }, { networkMode: '--tun=evil' }, { dns: '8.8.8.8' }]) assert.throws(() => systemDefinition('tailscale', patch));
});
test('the real UDP/TCP split resolver keeps public and Docker queries on their original upstream', async t => {
  const normal = await upstream(t, '192.0.2.10'), tailnet = await upstream(t, '100.64.0.9');
  const relay = createDNSRelay({ address: '127.0.0.1', port: 0, upstreams: [normal], tailnet, suffix: 'test.ts.net' });
  const listener = await relay.listen(); t.after(() => relay.close());
  const resolver = new Resolver({ timeout: 500, tries: 1 }); resolver.setServers([listener.address + ':' + listener.port]);
  assert.deepEqual(await resolver.resolve4('peer.test.ts.net'), ['100.64.0.9']);
  assert.deepEqual(await resolver.resolve4('public.example'), ['192.0.2.10']);
  assert.deepEqual(await resolver.resolve4('docker-service'), ['192.0.2.10']);
  const reply = await exchangeDNS(packet('peer.test.ts.net'), { ...listener, tcp: true });
  assert.equal(reply.subarray(-4).join('.'), '100.64.0.9');
  assert.deepEqual(normal.reads.map(item => item.name), ['public.example', 'docker-service']);
  assert.deepEqual(tailnet.reads, [{ name: 'peer.test.ts.net', tcp: false }, { name: 'peer.test.ts.net', tcp: true }]);
});
test('truncated UDP answers can fall back to TCP and mismatched upstream questions are ignored', async t => {
  const normal = await upstream(t, '192.0.2.10', { truncate: true, spoof: true });
  const relay = createDNSRelay({ address: '127.0.0.1', port: 0, upstreams: [normal] });
  const listener = await relay.listen(); t.after(() => relay.close());
  const resolver = new Resolver({ timeout: 800, tries: 1 }); resolver.setServers([listener.address + ':' + listener.port]);
  assert.deepEqual(await resolver.resolve4('public.example'), ['192.0.2.10']);
  assert.deepEqual(normal.reads.map(item => item.tcp), [false, true]);
});
test('failed tailnet queries never spill into public resolvers and malformed requests remain bounded', async t => {
  const normal = await upstream(t, '192.0.2.10');
  const relay = createDNSRelay({ address: '127.0.0.1', port: 0, upstreams: [normal], suffix: 'test.ts.net', tailnet: { address: '127.0.0.1', port: 1 }, timeout: 50 });
  await relay.listen(); t.after(() => relay.close());
  assert.equal((await relay.query(packet('peer.test.ts.net'))).readUInt16BE(2) & 15, 2);
  assert.deepEqual(normal.reads, []);
  const cyclic = packet('example'); cyclic[12] = 0xc0; cyclic[13] = 12;
  for (const malformed of [Buffer.alloc(3), cyclic, Buffer.alloc(5000)]) assert.equal(await relay.query(malformed), null);
  const response = answer(packet('example')); assert.equal((await relay.query(response)).readUInt16BE(2) & 15, 5);
  assert.ok(tailnetQuestion('9.0.64.100.in-addr.arpa', 'test.ts.net'));
  assert.ok(!tailnetQuestion('9.0.128.100.in-addr.arpa', 'test.ts.net'));
  assert.ok(!tailnetQuestion('peer.test.ts.net.attacker.example', 'test.ts.net'));
});
test('closing the resolver settles in-flight upstream queries', async t => {
  const silent = dgram.createSocket('udp4'); await new Promise(resolve => silent.bind(0, '127.0.0.1', resolve)); t.after(() => silent.close());
  const relay = createDNSRelay({ address: '127.0.0.1', port: 0, upstreams: [{ address: '127.0.0.1', port: silent.address().port }], timeout: 5000 });
  await relay.listen(); const pending = relay.query(packet('example'));
  await new Promise(resolve => setImmediate(resolve)); await relay.close();
  assert.equal((await pending).readUInt16BE(2) & 15, 2);
});
test('DNS installation preserves Docker fallback, search priority and exact original bytes on cleanup', async t => {
  const f = await fixture(t), events = [];
  const dns = createManagedDNS({ ...f, boot: 'one', relayFactory: inertRelay(events) });
  await dns.activate('test.ts.net');
  const active = await fs.readFile(f.file, 'utf8');
  assert.match(active, /nameserver 127\.0\.0\.54\nnameserver 127\.0\.0\.11/);
  assert.match(active, /search workspace\.internal test\.ts\.net/); assert.doesNotMatch(active, /\brotate\b/);
  assert.equal(events[0][0], 'listen'); assert.deepEqual(events[0][1].upstreams, [{ address: '127.0.0.11', port: 53 }]);
  await dns.restore(); assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.equal(dns.owned(), false);
  assert.equal(events.at(-1)[0], 'close');
});
test('controller recovery reuses the original DNS backup and interrupted writes are recoverable', async t => {
  const f = await fixture(t), first = createManagedDNS({ ...f, boot: 'one', relayFactory: inertRelay([]) });
  await first.activate('test.ts.net'); await first.close();
  const saved = f.store.meta('network:tailscale:dns');
  const second = createManagedDNS({ ...f, boot: 'one', relayFactory: inertRelay([]) });
  await second.activate('test.ts.net'); assert.equal(f.store.meta('network:tailscale:dns').original, original); await second.close();
  f.store.setMeta('network:tailscale:dns', { ...saved, phase: 'installing' });
  await fs.writeFile(f.file, saved.applied.slice(0, 25) + original.slice(25));
  await second.restore(); assert.equal(await fs.readFile(f.file, 'utf8'), original);
});
test('DNS recovery preserves every original byte, including Unicode and non-UTF-8 comments', async t => {
  const f = await fixture(t), dns = createManagedDNS({ ...f, boot: 'one', relayFactory: inertRelay([]) });
  const bytes = Buffer.concat([Buffer.from('# DNS 日本語\n'), Buffer.from([35, 32, 255, 254, 10]), Buffer.from(original)]);
  await fs.writeFile(f.file, bytes); await dns.activate('test.ts.net'); await dns.restore();
  assert.deepEqual(await fs.readFile(f.file), bytes);
});
test('DNS cleanup preserves external edits, keeps fallback alive and supports a reviewed retry', async t => {
  const f = await fixture(t), events = [], dns = createManagedDNS({ ...f, boot: 'one', relayFactory: inertRelay(events) });
  await dns.activate('test.ts.net');
  const foreign = await fs.readFile(f.file, 'utf8') + '# administrator edit\n'; await fs.writeFile(f.file, foreign);
  await assert.rejects(dns.restore(), error => error.code === 'dns-conflict');
  assert.equal(await fs.readFile(f.file, 'utf8'), foreign); assert.equal(dns.owned(), true);
  assert.equal(events.at(-1)[1].suffix, null, 'ordinary DNS stays alive while cleanup needs review');
  await fs.writeFile(f.file, 'nameserver 192.0.2.53\n');
  await dns.restore(); assert.equal(await fs.readFile(f.file, 'utf8'), 'nameserver 192.0.2.53\n'); assert.equal(dns.owned(), false);
});
test('recreation adopts fresh deployment DNS without restoring the previous container’s resolver', async t => {
  const f = await fixture(t), first = createManagedDNS({ ...f, boot: 'one', relayFactory: inertRelay([]) });
  await first.activate('test.ts.net'); await first.close();
  const replacement = '# New deployment\nnameserver 192.0.2.53\n'; await fs.writeFile(f.file, replacement);
  const second = createManagedDNS({ ...f, boot: 'two', relayFactory: inertRelay([]) });
  await second.activate('test.ts.net'); await second.restore(); assert.equal(await fs.readFile(f.file, 'utf8'), replacement);
});
test('DNS rejects resolver loops, unsafe suffixes, writable-by-user files and symlinks before changing them', async t => {
  for (const text of ['nameserver 127.0.0.54\n', 'nameserver 100.100.100.100\n', 'nameserver example.com\n', 'search example.com\n']) assert.throws(() => resolverConfiguration(text, 'test.ts.net'));
  const f = await fixture(t), dns = createManagedDNS({ ...f, boot: 'one', relayFactory: inertRelay([]) });
  await assert.rejects(dns.activate('test.ts.net\nnameserver 192.0.2.99'));
  await fs.chmod(f.file, 0o666); await assert.rejects(dns.preflight()); await fs.chmod(f.file, 0o644);
  const alias = path.join(f.root, 'link'); await fs.symlink(f.file, alias);
  await assert.rejects(createManagedDNS({ ...f, file: alias, boot: 'one' }).preflight()); assert.equal(await fs.readFile(f.file, 'utf8'), original);
});

function firewall() {
  const face = { match: { op: '==', left: { meta: { key: 'iifname' } }, right: 'tailscale0' } };
  return { nftables: [
    { table: { family: 'inet', name: 't3code_tailscale', comment: 't3code-services-tailscale-v1' } },
    { chain: { family: 'inet', table: 't3code_tailscale', name: 'input', type: 'filter', hook: 'input', prio: -10, policy: 'accept' } },
    { rule: { chain: 'input', expr: [face, { match: { op: 'in', left: { ct: { key: 'state' } }, right: { set: ['related', 'established'] } } }, { accept: null }] } },
    { rule: { chain: 'input', expr: [face, { drop: null }] } },
  ] };
}
async function networkFixture(t, extra = {}) {
  const f = await fixture(t), calls = [], events = [];
  let table = null, failProbe = false;
  const dns = { preflight: async () => { events.push('dns-preflight'); }, activate: async () => { events.push('dns-activate'); }, restore: async () => { events.push('dns-restore'); }, owned: () => false, close: async () => {} };
  const run = async (file, args) => {
    calls.push([file, args]);
    if (file.endsWith('/nft')) {
      if (args.includes('tables')) return { stdout: JSON.stringify({ nftables: table ? [table.nftables[0]] : [] }) };
      if (args[0] === 'delete') { events.push('filter-remove'); table = null; }
      else if (args[0].startsWith('add table')) { events.push('filter-add'); table = firewall(); }
      return { stdout: JSON.stringify(table) };
    }
    if (file.endsWith('/ip')) return { stdout: JSON.stringify(args.includes('link') ? [{ ifname: 'tailscale0', flags: ['UP'] }] : [{ dev: 'tailscale0' }]) };
    return { stdout: '' };
  };
  const io = { stat: async file => { if (file.startsWith('/sys/')) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { isCharacterDevice: () => true }; }, access: async () => {}, readFile: async () => 'CapEff:\t0000000000001000\n', readlink: async () => 'net:[fixture-one]' };
  const manager = createTailscaleNetworking({ store: f.store, boot: 'one', env: { T3_TAILSCALE_NETWORKING: '1' }, io, run, dns, verifyExecutable: async () => {}, probeDNS: async () => { events.push('dns-probe'); if (failProbe) throw new Error('unreachable'); }, ...extra });
  const resource = { id: 'tailscale', kind: 'service', revision: 1, enabled: true, config: systemDefinition('tailscale', { enabled: true, networkMode: 'kernel' }), artifact: { path: '/fixture/tailscale' } };
  const connection = { state: 'Running', ips: ['100.64.0.9'], dnsName: 'self.test.ts.net.', dnsSuffix: 'test.ts.net', magicDNSEnabled: true };
  f.store.put(resource);
  return { ...f, manager, resource, connection, calls, events, failProbe: () => { failProbe = true; }, changeFilter: () => { table.nftables[3].rule.expr = [{ accept: null }]; } };
}
test('ordinary deployments perform no network probes and userspace never requests extra permissions', async t => {
  const f = await fixture(t); let reads = 0;
  const manager = createTailscaleNetworking({ ...f, boot: 'one', env: {}, io: new Proxy({}, { get: () => async () => { reads++; throw new Error('unexpected network probe'); } }) });
  assert.equal((await manager.requirements()).ready, false);
  await manager.validate({ networkMode: 'userspace' }); await manager.orphaned(); await manager.close();
  assert.equal(reads, 0); assert.equal(await fs.readFile(f.file, 'utf8'), original);
});
test('full networking checks permissions before creating a filter, then verifies DNS and cleans up after stop', async t => {
  const f = await networkFixture(t);
  await f.manager.prepare(f.resource); assert.ok(f.events.indexOf('dns-preflight') < f.events.indexOf('filter-add'));
  let observed = await f.manager.observe(f.resource, { up: true }, f.connection, 'run-one');
  assert.equal(observed.state, 'ready'); assert.equal(observed.dns, 'ready');
  await f.manager.observe(f.resource, { up: true }, f.connection, 'run-one');
  assert.equal(f.calls.filter(([file]) => file.endsWith('/tailscale')).length, 1, 'reattaching must not repeatedly submit preference changes');
  assert.equal(f.events.filter(item => item === 'filter-add').length, 1);
  await f.manager.stopped(); assert.ok(f.events.lastIndexOf('dns-restore') < f.events.indexOf('filter-remove'));
  assert.equal(f.store.meta('network:tailscale:firewall'), null);
});
test('sign-in, device approval and disabled MagicDNS have honest independent readiness', async t => {
  const f = await networkFixture(t); await f.manager.prepare(f.resource);
  for (const [state, expected] of [['NeedsLogin', 'needs-login'], ['NeedsMachineAuth', 'needs-approval'], ['Starting', 'connecting']]) {
    assert.equal((await f.manager.observe(f.resource, { up: true }, { state }, 'run')).state, expected);
  }
  const result = await f.manager.observe(f.resource, { up: true }, { ...f.connection, magicDNSEnabled: false }, 'run');
  assert.equal(result.state, 'ready'); assert.equal(result.dns, 'disabled'); assert.ok(!f.events.includes('dns-activate'));
});
test('MagicDNS verification failure restores deployment DNS and a foreign inbound filter fails closed', async t => {
  const f = await networkFixture(t); await f.manager.prepare(f.resource); f.failProbe();
  let status = await f.manager.observe(f.resource, { up: true }, f.connection, 'run');
  assert.equal(status.state, 'error'); assert.equal(f.events.at(-1), 'dns-restore');
  f.changeFilter(); status = await f.manager.observe(f.resource, { up: true }, f.connection, 'run');
  assert.equal(status.fatal, true); assert.equal(f.events.filter(item => item === 'filter-add').length, 1);
  await assert.rejects(f.manager.stopped(), error => error.code === 'network-conflict');
  const changed = firewall(); changed.nftables.push({ rule: { chain: 'input', expr: [{ accept: null }] } }); assert.equal(ownedFirewall(changed), false);
});
test('recreation without networking privileges does not try to delete the old namespace’s firewall', async t => {
  const f = await fixture(t); f.store.setMeta('network:tailscale:firewall', { boot: 'old', namespace: 'net:[old]' });
  const manager = createTailscaleNetworking({ store: f.store, boot: 'new', env: {}, io: { readlink: async () => 'net:[new]' }, run: async () => { throw new Error('must not invoke nft'); } });
  await manager.stopped(); assert.equal(f.store.meta('network:tailscale:firewall'), null);
});
test('an unsafe inbound filter still requests daemon shutdown when DNS cleanup also fails', async t => {
  const dns = { preflight: async () => {}, activate: async () => {}, restore: async () => { throw new ServiceError('dns-conflict', 'External DNS edit'); }, owned: () => true, close: async () => {} };
  const f = await networkFixture(t, { dns }); await f.manager.prepare(f.resource); f.changeFilter();
  const result = await f.manager.observe(f.resource, { up: true }, f.connection, 'run');
  assert.equal(result.fatal, true); assert.match(result.message, /DNS cleanup also needs attention/);
});
test('installing a stopped userspace service needs no existing s6 run or networking ownership', async t => {
  const f = await fixture(t);
  const manager = createTailscaleNetworking({ store: f.store, boot: 'one', env: {} });
  const controller = createController({ store: f.store, boot: 'one', networking: manager, supervisor: { observe: async () => ({ up: false, unavailable: true }), stop: async () => {} }, artifacts: { selection: () => ({ path: '/fixture/tailscale' }), install: async (_id, value) => value }, system: { configureSystem: async () => ({}) } });
  t.after(() => controller.close());
  const review = await controller.plan({ action: 'install', id: 'tailscale', expectedRevision: 0, configuration: { enabled: false } });
  const op = controller.apply({ planId: review.id, expectedRevision: 0, idempotencyKey: randomUUID() });
  await controller.reconcile(); while (!controller.idle()) await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.operation(op.id).state, 'succeeded'); assert.equal(await fs.readFile(f.file, 'utf8'), original);
});

test('Services rechecks deployment before any download or stop, and reuses a completed operation', async t => {
  const f = await fixture(t), events = [];
  let available = true, running = true, networkChecks = 0;
  const resource = { id: 'tailscale', kind: 'service', revision: 1, enabled: true, config: systemDefinition('tailscale', { hostname: 'old', enabled: true }), artifact: { path: '/fixture/tailscale' } };
  f.store.put(resource);
  const networking = { requirements: async () => ({ ready: available }), validate: async config => { if (config.networkMode === 'kernel' && !available) throw new ServiceError('deployment-required', 'Missing TUN', 'networkMode'); }, prepare: async () => events.push('prepare'), stopped: async () => events.push('cleanup'), orphaned: async () => {}, observe: async resource => ({ mode: resource.config.networkMode, state: resource.config.networkMode === 'kernel' && ++networkChecks < 3 ? 'connecting' : 'ready', dns: 'ready' }) };
  const supervisor = { observe: async () => ({ up: running }), stop: async () => { events.push('stop'); running = false; }, start: async id => { events.push('start'); running = true; f.store.setMeta('run:' + id, { runId: randomUUID(), boot: 'one', revision: f.store.get(id).revision, payloadPid: 9, startedAt: Date.now() - 1000 }); } };
  const controller = createController({ store: f.store, boot: 'one', networking, supervisor, artifacts: { selection: () => ({ path: '/fixture/tailscale' }), install: async (_id, value) => { events.push('download'); return value; } }, system: { configureSystem: async () => ({}), tailscaleStatus: async () => ({ state: 'Running' }) } });
  t.after(() => controller.close());
  const plan = await controller.plan({ action: 'edit', id: 'tailscale', expectedRevision: 1, configuration: { enabled: true, hostname: 'new', networkMode: 'kernel' } });
  available = false;
  const input = { planId: plan.id, expectedRevision: 1, idempotencyKey: randomUUID(), acknowledgeAccessImpact: true };
  const op = controller.apply(input); await controller.reconcile(); while (!controller.idle()) await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.operation(op.id).state, 'failed'); assert.deepEqual(events, []); assert.equal(f.store.get('tailscale').config.networkMode, 'userspace');
  assert.equal(controller.apply(input).id, op.id); assert.deepEqual(events, []);
  available = true;
  const ready = await controller.plan({ action: 'edit', id: 'tailscale', expectedRevision: 1, configuration: { enabled: true, hostname: 'new', networkMode: 'kernel' } });
  const next = controller.apply({ planId: ready.id, expectedRevision: 1, idempotencyKey: randomUUID(), acknowledgeAccessImpact: true });
  await controller.reconcile(); while (!controller.idle()) await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.operation(next.id).state, 'succeeded'); assert.ok(events.indexOf('prepare') < events.indexOf('start')); assert.ok(events.indexOf('cleanup') < events.indexOf('prepare'));
  assert.ok(networkChecks >= 3, 'a running daemon must not finish full-mode activation while its network is still connecting');
});
