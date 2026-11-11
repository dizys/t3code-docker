import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../docker/services/store.mjs';
import { createController, publicResource } from '../docker/services/controller.mjs';
import { systemDefinition } from '../docker/services/definition.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-services-auth-'));
  const store = openStore(root, { domain: 'system' });
  const resource = { kind: 'service', id: 'tailscale', revision: 1, enabled: true, config: systemDefinition('tailscale', { hostname: 'fixture' }), artifact: { version: 'fixture' } };
  let connection = { state: 'NeedsLogin', authUrl: null, ips: [] }, controls = 0;
  store.put(resource); store.setMeta('run:tailscale', { revision: 1, boot: 'fixture', payloadPid: 123, runId: 'fixture', startedAt: Date.now() - 1000 });
  const controller = createController({ store, boot: 'fixture', supervisor: { observe: async () => ({ up: true }) }, health: async () => ({ ok: true, at: Date.now() }), system: {
    tailscaleStatus: async () => ({ ...connection }), controlTailscale: async () => { controls++; },
  } });
  t.after(async () => { controller.close(); while (!controller.idle()) await new Promise(resolve => setTimeout(resolve, 5)); store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { store, controller, connect: value => { connection = value; }, controls: () => controls };
}

test('service observations expose pending sign-in without exposing the authorization link', async t => {
  const f = await fixture(t);
  for (const [connection, pending] of [
    [{ state: 'NeedsLogin', authUrl: null }, false],
    [{ state: 'NeedsLogin', authUrl: 'https://login.tailscale.com/a/private-ceremony' }, true],
    [{ state: 'Running', authUrl: 'https://login.tailscale.com/a/stale-ceremony' }, false],
  ]) {
    f.connect(connection); await f.controller.reconcile();
    const snapshot = await f.controller.snapshot(), observed = snapshot.services[0].observation.connection;
    assert.equal(observed.signInPending, pending); assert.equal(observed.state, connection.state);
    assert.equal(Object.hasOwn(observed, 'authUrl'), false); assert.doesNotMatch(JSON.stringify(snapshot), /private-ceremony|stale-ceremony/);
  }
  assert.equal(f.controls(), 0, 'observing a service must not start authentication');
});

test('authentication reads distinguish a pending operation from an absent or expired link', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.controller.authentication('tailscale'), { state: 'NeedsLogin', url: null, starting: false });
  const plan = await f.controller.plan({ action: 'sign-in', id: 'tailscale', expectedRevision: 1 });
  f.store.apply({ planId: plan.id, expectedRevision: 1, idempotencyKey: randomUUID() });
  assert.deepEqual(await f.controller.authentication('tailscale'), { state: 'NeedsLogin', url: null, starting: true });
  assert.equal(f.controls(), 0, 'reading the sign-in dialog cannot submit a second operation');
});

test('legacy observations also redact their nested authorization URL', () => {
  const resource = { observation: { authUrl: 'old-private-link', connection: { state: 'NeedsLogin', authUrl: 'https://login.tailscale.com/a/private-link' } } };
  const safe = publicResource(resource);
  assert.equal(safe.observation.connection.signInPending, true);
  assert.doesNotMatch(JSON.stringify(safe), /private-link|authUrl/);
  assert.equal(resource.observation.connection.authUrl, 'https://login.tailscale.com/a/private-link', 'serialization must leave the original observation untouched');
});
