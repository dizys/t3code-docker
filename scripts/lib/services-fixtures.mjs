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
import { TAILSCALE_COMPOSE } from '../../docker/services/tailscale-networking.mjs';
export async function createServicesFixtures() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-services-ui-'));
  const controllers = {}, stores = {}, running = new Map();
  let tailnet = { state: 'NeedsLogin', ips: [], authUrl: null };
  for (const domain of ['system', 'user']) {
    const store = stores[domain] = openStore(path.join(root, domain), { domain });
    const supervisor = {
      observe: async id => ({ up: running.get(domain + id) || false }),
      start: async id => { running.set(domain + id, true); const resource = store.get(id); store.setMeta('run:' + id, { revision: resource.revision, boot: 'fixture', runId: randomUUID(), payloadPid: 500, startedAt: Date.now() - 1000 }); },
      stop: async id => { running.set(domain + id, false); },
    };
    const catalogue = { services: Object.fromEntries(['openssh', 'tailscale', 'cloudflared'].map(id => [id, { id, name: id, version: 'fixture-version', payloads: (id === 'openssh' ? ['openssh-server', 'libwrap0', 'libwtmpdb0', 'libtalloc2'] : [id]).map(name => ({ bytes: 2048, name, sha256: 'fixture-digest', url: 'https://example.invalid/' + name })) }])) };
    controllers[domain] = createController({ store, supervisor, boot: 'fixture', reservedPorts: [3773, 3774],
      networking: domain === 'system' ? {
        requirements: async () => ({ ready: true, checks: ['Deployment opt-in', 'TUN device', 'NET_ADMIN capability', 'Writable deployment DNS', 'Kernel firewall'].map((label, id) => ({ id: String(id), label, ok: true })), compose: TAILSCALE_COMPOSE, message: 'This deployment supports full networking.' }),
        validate: async () => {}, prepare: async () => {}, stopped: async () => {}, disconnected: async () => {}, orphaned: async () => {},
        observe: async resource => resource.config.networkMode === 'kernel' ? { mode: 'kernel', state: tailnet.state === 'Running' ? 'ready' : 'needs-login', dns: tailnet.state === 'Running' ? 'ready' : 'deployment', message: tailnet.state === 'Running' ? 'All programs can reach tailnet peers. MagicDNS is verified.' : 'Sign in to connect this container to your tailnet.' } : { mode: 'userspace', state: 'userspace', dns: 'deployment', message: 'Published TCP routes only. Ordinary programs use deployment networking.' },
      } : null,
      tools: { resolve: async config => ({ receipt: { executable: { path: config.executable, digest: 'fixture' }, installations: config.tools.map(item => ({ ...item, path: '/fixture/tools/' + item.tool })) } }) },
      artifacts: { catalogue, selection: id => ({ ...catalogue.services[id], manager: 'mise' }), install: async (id, selection) => ({ ...selection, manager: 'mise', path: '/fixture/mise/' + id, arch: 'arm64', components: selection.payloads.map(item => ({ ...item, version: 'fixture-version', manager: 'mise', path: '/fixture/mise/' + item.name })) }), remove: async () => ({ softwareRemoved: true, retainedPackages: [], settingsRetained: true, identitiesRetained: true }) },
      system: { publicKeys, configureSystem: async resource => resource.id === 'tailscale' ? { ...resource.details } : { hostFingerprint: 'SHA256:fixture-public-fingerprint', keys: [] }, tailscaleStatus: async () => ({ ...tailnet }), controlTailscale: async (_resource, action) => { tailnet = { state: 'NeedsLogin', ips: [], authUrl: action === 'sign-in' ? 'https://login.tailscale.com/a/fixture-only' : null }; return { authGeneration: Date.now() }; }, paths: {} },
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
    if (action === 'authentication') return controller.authentication(input.id);
    if (action === 'requirements') return controller.requirements();
    if (action === 'snapshot') return controller.snapshot();
    if (action === 'plan') return controller.plan(input);
    if (action === 'apply') return controller.apply(input);
    if (action === 'operation') return controller.operation(input.id);
    if (action === 'logs') return { entries: [{ at: Date.now(), stream: 'stdout', sequence: 1, runId: 'fixture', text: 'Serving the selected folder on loopback.' }], bounded: true };
    if (action === 'events') return { events: controller.events(input.after) };
    throw new Error('Unsupported fixture operation.');
  };
  const api = createServicesAPI({ request });
  const close = async () => {
    for (const controller of Object.values(controllers)) controller.close();
    while (Object.values(controllers).some(controller => !controller.idle())) await new Promise(resolve => setTimeout(resolve, 20));
    for (const store of Object.values(stores)) store.close();
    await fs.rm(root, { recursive: true, force: true });
  };
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
