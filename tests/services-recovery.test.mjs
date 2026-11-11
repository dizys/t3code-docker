import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, ServiceError } from '../docker/services/store.mjs';
import { createController } from '../docker/services/controller.mjs';
import { createNetwork } from '../docker/services/network.mjs';
import { createServicesAPI } from '../docker/services/client.mjs';
import { customDefinition, systemDefinition } from '../docker/services/definition.mjs';
import { inspectTar } from '../docker/services/archive.mjs';
import { logWriter, readLogs } from '../docker/services/logs.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-services-recovery-'));
  const store = openStore(root, { domain: options.domain || 'user' });
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { store, root };
}
const connection = { id: 'lan', kind: 'connection', revision: 1, name: 'LAN', provider: 'existing-network', ownership: 'external' };
const service = { id: 'preview', kind: 'service', revision: 1, enabled: true, config: { name: 'Preview', endpoints: [{ port: 8080, protocol: 'http' }] } };
const routeInput = { action: 'route-save', expectedRevision: 0, configuration: { name: 'Preview route', serviceDomain: 'user', serviceId: 'preview', connection: 'lan', endpoint: 8080, host: 'localhost', port: 8080, topology: 'host-mapping' } };
const commit = (store, plan) => store.apply({ planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: randomUUID() });

test('routes recheck dependencies before making any forwarding changes', async t => {
  const { store } = await fixture(t);
  store.put(connection); store.put(service);
  const network = createNetwork({ store });
  const plan = await network.plan(routeInput), op = commit(store, plan);
  store.put({ ...connection, revision: 2 });
  await assert.rejects(network.execute(op), /changed/);
  assert.equal(store.get(plan.target), null);
});
test('disabled service ports remain reserved and routed endpoints cannot silently change', async t => {
  const { store } = await fixture(t);
  const config = customDefinition({ name: 'Preview', mode: 'executable', executable: '/bin/true', cwd: '/tmp', enabled: false, endpoints: [{ port: 8080, protocol: 'http' }] });
  store.put({ ...service, enabled: false, config });
  const controller = createController({ store, supervisor: {}, tools: { resolve: async () => ({ receipt: {} }) }, peerPorts: async () => [{ id: 'openssh', endpoints: [{ port: 2222, protocol: 'ssh' }] }] });
  t.after(() => controller.close());
  for (const port of [8080, 2222]) await assert.rejects(controller.plan({ action: 'add', expectedRevision: 0, configuration: { ...config, endpoints: [{ port, protocol: 'http' }] } }), /declares that port/);
  store.put({ id: 'route', kind: 'route', revision: 1, service: 'preview', serviceDomain: 'user', connection: 'lan', endpoint: { port: 8080, protocol: 'http' } });
  await assert.rejects(controller.plan({ action: 'edit', id: 'preview', expectedRevision: 1, configuration: { ...config, endpoints: [] } }), /before changing their declared endpoints/);
});

test('client evidence becomes stale after edits and can be renewed against the current generation', async t => {
  const { store } = await fixture(t);
  store.put(connection); store.put(service); store.setMeta('observation:preview', { state: 'ready' });
  const network = createNetwork({ store });
  const save = async input => { const op = commit(store, await network.plan(input)); await network.execute(op); op.state = 'succeeded'; store.saveOperation(op); return store.get(op.target); };
  let route = await save(routeInput);
  route = await save({ action: 'client-observed', id: route.id, expectedRevision: route.revision, configuration: { reported: true } });
  assert.equal((await network.snapshot()).routes[0].state, 'client-reported');
  store.put({ ...service, revision: 2 });
  assert.equal((await network.snapshot()).routes[0].verificationStale, true);
  await save({ action: 'client-observed', id: route.id, expectedRevision: route.revision, configuration: { reported: true } });
  assert.equal((await network.snapshot()).routes[0].state, 'client-reported');
});

test('forwarding recovery reuses the exact nested operation and requires maintenance permission', async t => {
  const { store } = await fixture(t);
  store.put({ ...connection, provider: 'tailscale', serviceId: 'tailscale', ownership: 'managed-system' }); store.put(service);
  const connector = { id: 'tailscale', revision: 5, enabled: true, details: { authGeneration: 1 }, observation: { connection: { state: 'Running' } } };
  let attempts = [], lost = true;
  const rootPlan = { id: randomUUID(), expectedRevision: 5, review: { effect: 'Forward TCP' } };
  const systemRequest = async (action, input) => {
    if (action === 'plan') return rootPlan;
    assert.equal(action, 'apply'); attempts.push(input);
    if (lost) { lost = false; throw new ServiceError('controller-unavailable', 'Response lost'); }
    return { id: 'same-root-operation', state: 'succeeded' };
  };
  const network = createNetwork({ store, systemSnapshot: async () => ({ services: [connector] }), systemRequest });
  const plan = await network.plan({ ...routeInput, configuration: { ...routeInput.configuration, topology: 'tailnet' } });
  const controller = createController({ store, supervisor: {}, tools: {} });
  t.after(() => controller.close());
  assert.equal(controller.requiresMaintenance({ planId: plan.id }), true);
  const op = commit(store, plan);
  await assert.rejects(network.execute(op), /Response lost/);
  await network.execute(store.operation(op.id));
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(attempts[0].idempotencyKey, op.id);
  assert.equal(store.get(plan.target).connection, 'lan');
  const api = createServicesAPI({ request: async (domain, action, input) => ({ maintenance: controller.requiresMaintenance(input) }) });
  assert.equal(await api.requiresMaintenance('/services/apply', { domain: 'user', planId: plan.id }), true);
  assert.equal(await api.requiresMaintenance('/services/authentication', { domain: 'system', id: 'tailscale' }), true);
  assert.equal(await api.requiresMaintenance('/services/logs', { domain: 'user', id: 'preview' }), false);
});

test('new cross-domain dependents block system uninstall before the payload is stopped', async t => {
  const { store } = await fixture(t, { domain: 'system' });
  const resource = { ...service, id: 'openssh', config: { ...service.config, shutdownMs: 100, enabled: true } };
  store.put(resource);
  let references = [], stops = 0;
  const controller = createController({ store, supervisor: { stop: async () => { stops++; }, observe: async () => ({ up: true }) }, networkReferences: async () => references });
  t.after(() => controller.close());
  const plan = await controller.plan({ action: 'uninstall', id: 'openssh', expectedRevision: 1 });
  references = [{ service: 'openssh', serviceDomain: 'system', name: 'New route' }];
  assert.throws(() => controller.apply({ planId: plan.id, expectedRevision: 1, idempotencyKey: randomUUID() }), /another way to reach/);
  const op = controller.apply({ planId: plan.id, expectedRevision: 1, idempotencyKey: randomUUID(), acknowledgeAccessImpact: true });
  await controller.reconcile(); while (!controller.idle()) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.operation(op.id).code, 'dependencies'); assert.equal(stops, 0); assert.equal(store.get('openssh').enabled, true);
});
test('uninstall waits for actual software removal and leaves a truthful retryable registration on failure', async t => {
  const { store } = await fixture(t, { domain: 'system' });
  const artifact = { path: '/fixture/installed', manager: 'mise', components: [] };
  store.put({ ...service, id: 'openssh', artifact, config: { ...service.config, shutdownMs: 100, enabled: true } });
  let fail = true, removals = 0;
  const controller = createController({ store, boot: 'fixture', supervisor: { stop: async () => {}, observe: async () => ({ up: false }) },
    artifacts: { remove: async () => { removals++; if (fail) throw new ServiceError('package-manager', 'Removal failed'); return { softwareRemoved: true, settingsRetained: true, identitiesRetained: true }; } } });
  t.after(() => controller.close());
  const apply = async () => {
    const plan = await controller.plan({ action: 'uninstall', id: 'openssh', expectedRevision: store.get('openssh').revision });
    const args = { planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: randomUUID(), acknowledgeAccessImpact: true };
    const op = controller.apply(args); await controller.reconcile(); while (!controller.idle()) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(controller.apply(args).id, op.id); return controller.operation(op.id);
  };
  assert.equal((await apply()).state, 'failed'); assert.deepEqual(store.get('openssh').artifact, artifact); assert.equal(store.get('openssh').uninstalled, undefined); assert.equal(store.get('openssh').enabled, false);
  fail = false; assert.equal((await apply()).state, 'succeeded'); assert.equal(removals, 2);
  assert.equal(store.get('openssh').artifact, null); assert.equal(store.get('openssh').uninstalled, true); assert.equal(store.get('openssh').removal.softwareRemoved, true);
});
test('reviewed Mise migration keeps a temporarily stopped legacy service stopped and retains rollback software', async t => {
  const { store } = await fixture(t, { domain: 'system' });
  const oldArtifact = { path: '/fixture/old', version: '1.0.0' }, nextArtifact = { manager: 'mise', version: '1.0.0', path: '/fixture/mise', payloads: [] };
  const config = { name: 'Tailscale', enabled: true, shutdownMs: 100, endpoints: [] };
  store.put({ id: 'tailscale', kind: 'service', revision: 1, enabled: true, config, artifact: oldArtifact, stoppedBoot: 'fixture' });
  let starts = 0, removals = 0;
  const controller = createController({ store, boot: 'fixture', supervisor: { stop: async () => {}, start: async () => { starts++; }, observe: async () => ({ up: false }) },
    artifacts: { selection: () => nextArtifact, install: async () => nextArtifact, remove: async () => { removals++; } }, system: { configureSystem: async () => ({}), paths: {} } });
  t.after(() => controller.close());
  await controller.reconcile(); assert.equal(store.get('tailscale').artifact.manager, undefined);
  const plan = await controller.plan({ action: 'migrate', id: 'tailscale', expectedRevision: 1 }); assert.match(plan.review.effect, /stopped or disabled service stays stopped/);
  const op = controller.apply({ planId: plan.id, expectedRevision: 1, idempotencyKey: randomUUID(), acknowledgeAccessImpact: true });
  await controller.reconcile(); while (!controller.idle()) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.operation(op.id).state, 'succeeded'); assert.equal(store.get('tailscale').artifact.manager, 'mise');
  assert.equal(store.get('tailscale').stoppedBoot, 'fixture'); assert.equal(starts, 0); assert.equal(removals, 0);
});
test('editing a legacy service does not silently migrate its package ownership', async t => {
  const { store } = await fixture(t, { domain: 'system' });
  const config = systemDefinition('tailscale', { hostname: 'fixture', enabled: false }), artifact = { path: '/fixture/old', version: '1.0.0' };
  store.put({ id: 'tailscale', kind: 'service', revision: 1, enabled: false, config, artifact });
  let installs = 0;
  const controller = createController({ store, supervisor: { stop: async () => {}, observe: async () => ({ up: false }) },
    artifacts: { selection: () => ({ manager: 'mise' }), install: async () => { installs++; } }, system: { configureSystem: async () => ({}), paths: {} } });
  t.after(() => controller.close());
  const plan = await controller.plan({ action: 'edit', id: 'tailscale', expectedRevision: 1, configuration: { hostname: 'fixture-renamed', enabled: false } });
  assert.deepEqual(plan.review.downloads, []);
  const op = controller.apply({ planId: plan.id, expectedRevision: 1, idempotencyKey: randomUUID() });
  await controller.reconcile(); while (!controller.idle()) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.operation(op.id).state, 'succeeded'); assert.equal(installs, 0); assert.deepEqual(store.get('tailscale').artifact, artifact);
});

test('restart budget is bounded and temporary stop takes precedence over an expired backoff', async t => {
  const { store } = await fixture(t);
  let now = 10000, starts = 0;
  const config = customDefinition({ name: 'Crash', mode: 'executable', executable: '/bin/true', cwd: '/tmp', enabled: true });
  store.put({ id: 'crash', kind: 'service', revision: 1, enabled: true, config, receipt: {} });
  const supervisor = { observe: async () => ({ up: false }), start: async () => { starts++; }, stop: async () => {} };
  const controller = createController({ store, supervisor, now: () => now, boot: 'boot', tools: { resolve: async () => ({ receipt: {} }) } });
  t.after(() => controller.close());
  for (let i = 0; i < 6; i++) { store.setMeta('exit:crash', { runId: String(i), boot: 'boot', exitCode: 1 }); await controller.reconcile(); now += 1000; }
  assert.equal(store.get('crash').restart.exhausted, true); assert.equal(starts, 0);
  store.put({ ...store.get('crash'), restart: { nextAt: 1 }, stoppedBoot: 'boot' }); now += 60000;
  await controller.reconcile(); assert.equal(starts, 0); assert.equal(store.meta('observation:crash').state, 'stopped');
});

test('a restart during configuration recovery resumes the saved previous configuration', async t => {
  const { store } = await fixture(t);
  const config = customDefinition({ name: 'Original', mode: 'executable', executable: '/bin/true', cwd: '/tmp', enabled: false });
  const previous = { id: 'preview', kind: 'service', revision: 1, enabled: false, config, receipt: {} };
  store.put(previous);
  const plan = store.plan({ target: previous.id, action: 'edit', expectedRevision: 1, previous, candidate: { config: { ...config, name: 'Bad candidate' } }, review: {} });
  const op = commit(store, plan);
  store.put({ ...previous, revision: 2, config: { ...config, name: 'Bad candidate' } });
  store.saveOperation({ ...op, state: 'working', phase: 'restore', activated: true });
  const controller = createController({ store, supervisor: { observe: async () => ({ up: false }), stop: async () => {} } });
  t.after(() => controller.close());
  await controller.reconcile(); assert.equal(store.get('preview').config.name, 'Original');
  assert.equal(controller.operation(op.id).state, 'rolled-back'); assert.equal(store.get('preview').revision, 3);
});

function tar(members) {
  const buffers = [];
  for (const [name, kind = '0', link = ''] of members) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write('00000000000\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write(kind, 156); header.write(link, 157, 100); header.write('ustar\0', 257);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    buffers.push(header);
  }
  return Buffer.concat([...buffers, Buffer.alloc(1024)]);
}
test('archive inspection rejects traversal, link ancestry, hardlinks, devices and corrupt headers', () => {
  assert.equal(inspectTar(tar([['usr/bin/service']])).length, 1);
  for (const entries of [[['../escape']], [['/absolute']], [['usr', '2', '../outside'], ['usr/bin/payload']], [['link', '2', '../../outside']], [['hard', '1']], [['device', '3']], [['receipt.json']]]) assert.throws(() => inspectTar(tar(entries)), /unsafe layout/);
  const corrupt = tar([['okay']]); corrupt[0] ^= 1; assert.throws(() => inspectTar(corrupt), /unsafe layout/);
});

test('logs redact multiline and long-line boundaries and cursors retain equal-time stream entries', async t => {
  const { root } = await fixture(t), originalNow = Date.now;
  Date.now = () => 123456;
  try {
    const out = logWriter(root, 'preview', 'run', 'stdout', ['canary-secret', 'multi\nline']);
    const err = logWriter(root, 'preview', 'run', 'stderr');
    err.write(Buffer.from('first\n')); err.end(); const first = readLogs(root, 'preview');
    out.write(Buffer.from('x'.repeat(8190) + 'canary-')); out.write(Buffer.from('secret\nmulti\n')); out.write(Buffer.from('line\n')); out.end();
    const next = readLogs(root, 'preview', first.cursor);
    assert.ok(next.entries.length); assert.ok(next.entries.every(entry => entry.stream === 'stdout'));
    assert.ok(!JSON.stringify(next).includes('canary-secret')); assert.ok(!JSON.stringify(next).includes('multi')); assert.ok(next.entries.some(entry => entry.text.includes('[redacted]')));
    assert.equal(readLogs(root, 'preview', next.cursor).entries.length, 0);
  } finally { Date.now = originalNow; }
});
