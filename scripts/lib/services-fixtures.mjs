// Browser fixtures exercise the real controller and journals, with inert
// process/artifact adapters. No command, account or production file is used.
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openStore } from '../../docker/services/store.mjs';
import { createController } from '../../docker/services/controller.mjs';
import { createServicesAPI } from '../../docker/services/client.mjs';
import { publicKeys } from '../../docker/services/system.mjs';
export async function createServicesFixtures() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-services-ui-'));
  const controllers = {}, stores = {}, running = new Map();
  for (const domain of ['system', 'user']) {
    const store = stores[domain] = openStore(path.join(root, domain), { domain });
    const supervisor = {
      observe: async id => ({ up: running.get(domain + id) || false }),
      start: async id => { running.set(domain + id, true); const resource = store.get(id); store.setMeta('run:' + id, { revision: resource.revision, boot: 'fixture', runId: randomUUID(), payloadPid: 500, startedAt: Date.now() - 1000 }); },
      stop: async id => { running.set(domain + id, false); },
    };
    const catalogue = { services: Object.fromEntries(['openssh', 'tailscale', 'cloudflared'].map(id => [id, { id, name: id, version: 'fixture-version', payloads: [{ bytes: 2048, name: id, sha256: 'fixture-digest', url: 'https://example.invalid/' + id }] }])) };
    controllers[domain] = createController({ store, supervisor, boot: 'fixture', reservedPorts: [3773, 3774],
      tools: { resolve: async config => ({ receipt: { executable: { path: config.executable, digest: 'fixture' }, installations: config.tools.map(item => ({ ...item, path: '/fixture/tools/' + item.tool })) } }) },
      artifacts: { catalogue, selection: id => catalogue.services[id], install: async (id, selection) => ({ ...selection, path: '/fixture/artifacts/' + id, arch: 'arm64' }) },
      system: { publicKeys, configureSystem: async () => ({ hostFingerprint: 'SHA256:fixture-public-fingerprint', keys: [] }), tailscaleStatus: async () => ({ state: 'NeedsLogin', ips: [] }), paths: {} },
      health: async () => ({ ok: true, at: Date.now(), message: 'Fixture endpoint answered.' }),
      systemSnapshot: domain === 'user' ? async () => controllers.system.snapshot() : undefined,
    });
  }
  for (const controller of Object.values(controllers)) controller.start();
  const request = async (domain, action, input = {}) => {
    const controller = controllers[domain];
    if (!controller) throw new Error('Choose a user or system service.');
    if (action === 'inventory') return { tools: [{ tool: 'python', version: '3.14.0', path: '/fixture/tools/python' }, { tool: 'node', version: '24.13.0', path: '/fixture/tools/node' }] };
    if (action === 'permissions') return { maintenance: false };
    if (action === 'authentication') return { state: 'NeedsLogin', url: 'https://login.tailscale.com/a/fixture-only' };
    if (action === 'snapshot') return controller.snapshot();
    if (action === 'plan') return controller.plan(input);
    if (action === 'apply') return controller.apply(input);
    if (action === 'operation') return controller.operation(input.id);
    if (action === 'logs') return { entries: [{ at: Date.now(), stream: 'stdout', sequence: 1, runId: 'fixture', text: 'Serving the selected folder on loopback.' }], bounded: true };
    if (action === 'events') return { events: controller.events(input.after) };
    throw new Error('Unsupported fixture operation.');
  };
  const api = createServicesAPI({ request });
  const close = () => { for (const controller of Object.values(controllers)) controller.close(); };
  return {
    close,
    respond: async (method, url, input) => {
      const route = url.pathname.replace(/^\/__setup/, '');
      if (!route.startsWith('/services')) return null;
      try { return { body: await api.handle(route, input) }; }
      catch (error) { return { status: error.code === 'conflict' ? 409 : 400, body: { ok: false, error: error.message, code: error.code, field: error.field } }; }
    },
  };
}
