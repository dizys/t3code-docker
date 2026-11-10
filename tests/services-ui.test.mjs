import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../docker/setup/client/services.js', import.meta.url), 'utf8');
const model = await readFile(new URL('../docker/setup/client/service-model.js', import.meta.url), 'utf8');
const fixture = (hash = '#services/new', ready = true, services = [], domains = []) => {
  let status = ready ? {} : null, opened = 0, reads = 0, unavailable = false;
  const listeners = {}, menus = [];
  const location = { origin: 'https://fixture.test', hash };
  const context = vm.createContext({
    Kit: { html: (parts, ...values) => parts.reduce((text, part, i) => text + part + (Array.isArray(values[i]) ? values[i].join('') : values[i] ?? ''), ''), raw: value => value, icon: () => '', menu: (_button, options) => menus.push(options.items) }, BASE: '/__setup', location,
    T3ServiceEditor: { create: () => ({ open: () => { opened++; } }) },
    document: { addEventListener: (name, listener) => { listeners[name] = listener; } },
    sessionStorage: { getItem: () => null },
    setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(model, context);
  const create = vm.runInContext(source + '\nT3ServicesUI.create;', context);
  const ui = create({
    api: async () => { reads++; return unavailable ? { ok: false, error: 'Fixture disconnected' } : { ok: true, data: { services, domains, operations: [], connections: [], routes: [] } }; },
    render() {}, go() {}, getStatus: () => status,
  });
  return { ui, location, ready: () => { status = {}; }, opened: () => opened, reads: () => reads, unavailable: () => { unavailable = true; },
    settle: () => new Promise(resolve => setImmediate(resolve)),
    menu: async resource => { await listeners.click({ target: { closest: () => ({ dataset: { serviceAction: 'menu', domain: resource.domain, id: resource.id } }) } }); return Array.from(menus.at(-1), item => item.label); } };
};

test('status refreshes do not reopen a deep-linked custom-service editor', () => {
  const f = fixture();
  f.ui.activate(true);
  assert.equal(f.opened(), 1);
  for (let i = 0; i < 3; i++) f.ui.activate();
  assert.equal(f.opened(), 1, 'polling must leave the current editor or review alone');
  f.ui.activate(true);
  assert.equal(f.opened(), 2, 'explicitly visiting the same entry can open it again');
});

test('the initial service editor waits for status and opens once when ready', () => {
  const f = fixture('#services/new', false);
  f.ui.activate(true);
  assert.equal(f.opened(), 0);
  assert.equal(f.reads(), 0, 'recording navigation does not request protected data before status is ready');
  f.ready(); f.ui.activate(); f.ui.activate();
  assert.equal(f.opened(), 1);
});

test('an unhandled or superseded route cannot open the custom-service editor', () => {
  const f = fixture('#services');
  f.ui.activate(true);
  f.location.hash = '#services/new';
  f.ui.activate();
  assert.equal(f.opened(), 0, 'a status response cannot accept a navigation before its guard');
  f.ui.activate(true);
  assert.equal(f.opened(), 1);

  const pending = fixture('#services/new', false);
  pending.ui.activate(true);
  pending.location.hash = '#services'; pending.ui.activate(true);
  pending.ready(); pending.ui.activate();
  assert.equal(pending.opened(), 0, 'leaving before status arrives cancels the pending editor entry');
});

test('the service menu distinguishes a first sign-in from a pending authorization', async () => {
  const resource = { domain: 'system', id: 'tailscale', enabled: true, artifact: { version: '1.0' }, config: { name: 'Tailscale' }, observation: { state: 'running', connection: { state: 'NeedsLogin', signInPending: false } } };
  const f = fixture('#services', true, [resource]); f.ui.activate(true); await f.settle();
  const authentication = labels => labels.filter(label => /sign.in|sign out|approval/i.test(label));
  assert.deepEqual(authentication(await f.menu(resource)), ['Sign in…']);
  resource.observation.connection.signInPending = true;
  assert.deepEqual(authentication(await f.menu(resource)), ['Continue sign-in']);
  resource.observation.connection.state = 'Running';
  assert.deepEqual(authentication(await f.menu(resource)), ['Sign out…']);
  resource.observation.connection.state = 'NeedsMachineAuth';
  assert.deepEqual(authentication(await f.menu(resource)), ['Check device approval', 'Sign out…']);
  f.unavailable(); f.ui.activate(); await f.settle();
  assert.deepEqual(authentication(await f.menu(resource)), [], 'a failed refresh must not offer actions from stale identity state');
});

test('Toolchains shows installed service runtimes with their Services management links', async () => {
  const ssh = { domain: 'system', id: 'openssh', enabled: true, config: { name: 'SSH' }, artifact: { version: '10.2p1' }, observation: { state: 'ready' } };
  const custom = { domain: 'user', id: 'custom', config: { name: 'Custom preview' }, artifact: {}, observation: { state: 'running' } };
  const f = fixture('#toolchains', true, [ssh, custom]); f.ui.activate(true); await f.settle();
  const markup = f.ui.toolchainsContent();
  assert.match(markup, /Service runtimes/); assert.match(markup, /SSH/); assert.match(markup, /10.2p1/);
  assert.match(markup, /Managed in Services/); assert.match(markup, /href="#services\/openssh"/);
  assert.doesNotMatch(markup, /Custom preview|package\.uninstall|package\.update/);
  f.unavailable(); f.ui.activate(); await f.settle();
  assert.match(f.ui.toolchainsContent(), /Showing last-known installations/);
});

test('Toolchains does not invent an installed runtime when Services has no registrations', async () => {
  const f = fixture('#toolchains'); f.ui.activate(true); await f.settle();
  assert.equal(f.ui.toolchainsContent(), '');
});

test('Toolchains stays quiet when optional system services have not been enabled for this deployment', async () => {
  for (const code of ['rootless', 'storage-required']) {
    const f = fixture('#toolchains', true, [], [{ domain: 'system', code, error: 'Optional system services need deployment configuration' }]);
    f.ui.activate(true); await f.settle(); assert.equal(f.ui.toolchainsContent(), '');
  }
});
