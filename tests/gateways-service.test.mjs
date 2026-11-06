// The reconciler, against a stand-in for T3 that behaves like the real one: it
// redacts secrets on read and restarts an instance on every write, which is why
// the write count matters here.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGatewayService, gatewayFailure } from '../docker/setup/gateways.mjs';
import { createGatewayT3 } from '../docker/setup/gateways/t3.mjs';

const redacted = instance => ({ ...instance, environment: instance.environment?.map(row => row.sensitive ? { ...row, value: '', valueRedacted: true } : row) });

function fakeT3({ instances = {}, models = {} } = {}) {
  const state = { instances: { claudeAgent: { driver: 'claudeAgent', config: { binaryPath: '/launchers/claude' } }, codex: { driver: 'codex', config: { binaryPath: '/launchers/codex' } }, opencode: { driver: 'opencode', config: { binaryPath: '/launchers/opencode', serverPassword: 'must-not-copy' } }, ...instances }, preferences: {} };
  // As on a real server, an instance is only checked again when it's written.
  const checked = new Map();
  const t3 = { state, writes: [], refreshed: [], secrets: new Map(), hidden: [], down: false, failFor: null, status: 'ready',
    read: async () => {
      if (t3.down) throw new Error('T3 Code is not answering');
      return { instances: Object.fromEntries(Object.entries(state.instances).map(([id, instance]) => [id, redacted(instance)])), preferences: state.preferences,
        providers: Object.entries(state.instances).filter(([id]) => id.includes('_gw_')).map(([instanceId, instance]) => ({ instanceId, status: t3.status, installed: true, checkedAt: checked.get(instanceId), models: (models[instance.driver] ?? []).map(slug => ({ slug })) })) };
    },
    refresh: async id => { t3.refreshed.push(id); },
    upsert: async (id, instance) => {
      if (t3.failFor === instance.driver) throw new Error('T3 refused this instance');
      t3.writes.push(id);
      checked.set(id, new Date().toISOString());
      for (const row of instance.environment ?? []) if (row.sensitive && !row.valueRedacted) t3.secrets.set(`${id}/${row.name}`, row.value);
      state.instances[id] = instance;
    },
    remove: async id => { t3.writes.push(`remove:${id}`); delete state.instances[id]; },
    setModelsHidden: async changes => { t3.hidden.push(...changes); for (const { provider, model, hidden } of changes) { const list = state.preferences[provider]?.hiddenModels ?? []; state.preferences[provider] = { hiddenModels: hidden ? [...list, model] : list.filter(entry => entry !== model) }; } },
  };
  return t3;
}

function fakeVault() {
  const rows = new Map(); let tick = 0;
  const vault = { rows, reads: 0,
    list: async () => [...rows.values()].map(({ key, ...row }) => row),
    read: async id => { vault.reads++; if (!rows.has(id)) throw new Error('gone'); return rows.get(id).key; },
    available: async id => rows.has(id) ? `${id}-2` : id,
    create: async ({ id, key }) => { rows.set(id, { id, key, changedAt: `t${++tick}` }); return { id, changedAt: `t${tick}` }; },
    replace: async (id, key) => { rows.set(id, { ...rows.get(id), key, changedAt: `t${++tick}` }); return { id, changedAt: `t${tick}` }; },
    remove: async id => { rows.delete(id); },
  };
  return vault;
}

async function gatewayServer(t, models = ['claude-opus-4-8', 'gpt-6-astra']) {
  const state = { models, keys: [], status: 200 };
  const server = http.createServer((req, res) => {
    state.keys.push(req.headers.authorization); req.resume();
    req.on('end', () => {
      res.writeHead(req.method === 'GET' ? state.status : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/v1/models' ? { data: state.models.map(id => ({ id })) } : {}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, state };
}

async function harness(t, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 't3-gateways-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), t3 = fakeT3(options), vault = fakeVault();
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  const stopped = [], processes = { stop: async (agent, instanceId) => { stopped.push(instanceId); return 1; } };
  const service = createGatewayService({ baseDir: path.join(root, 'state'), home, env: {}, io: fs, t3, vault, processes, wait: options.wait ?? (() => Promise.resolve()) });
  return { service, t3, vault, home, root, stopped, processes, gateway: await gatewayServer(t, options.gatewayModels) };
}
const add = (h, agents = ['claude', 'codex', 'opencode'], over = {}) => h.service.create({ gateway: { name: 'My Proxy', preset: 'cliproxyapi', url: h.gateway.url, agents, ...over }, key: 'sk-one' });
const turn = async (h, id, agent, connected, more = {}) => { const { revision } = await h.service.status(); return h.service.setAgent({ id, agent, connected, revision, ...more }); };
const settled = () => new Promise(resolve => setTimeout(resolve, 30));

test('adding a gateway creates one instance per agent and leaves default instances alone', async t => {
  const h = await harness(t), before = structuredClone(h.t3.state.instances);
  const created = await add(h);
  assert.deepEqual(created.results.map(result => result.action), ['created', 'created', 'created']);
  assert.deepEqual(Object.keys(h.t3.state.instances).filter(id => id.includes('_gw_')).sort(), ['claudeAgent_gw_my-proxy', 'codex_gw_my-proxy', 'opencode_gw_my-proxy']);
  for (const id of ['claudeAgent', 'codex', 'opencode']) assert.deepEqual(h.t3.state.instances[id], before[id]);
  assert.equal(h.t3.state.instances['claudeAgent_gw_my-proxy'].config.binaryPath, '/launchers/claude');
  assert.equal(h.t3.state.instances['opencode_gw_my-proxy'].config.serverPassword, undefined);
});

test('a typed key goes to the Vault and each instance’s secret, and to nowhere else', async t => {
  const h = await harness(t), { id } = await add(h);
  assert.equal(h.vault.rows.get(`${id}-gateway`).key, 'sk-one');
  assert.equal(h.t3.secrets.get('claudeAgent_gw_my-proxy/ANTHROPIC_AUTH_TOKEN'), 'sk-one');
  assert.equal(h.t3.secrets.get('codex_gw_my-proxy/T3_GATEWAY_KEY'), 'sk-one');
  const keyFile = path.join(h.root, `state/setup/gateways/agents/${id}.key`);
  assert.equal(await fs.readFile(keyFile, 'utf8'), 'sk-one');
  assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(path.join(h.root, `state/setup/gateways/agents/${id}.json`), 'utf8'), /sk-one/);
  const file = await fs.readFile(path.join(h.root, 'state/setup/gateways/gateways.json'), 'utf8');
  assert.doesNotMatch(file, /sk-one/);
  assert.equal((await fs.stat(path.join(h.root, 'state/setup/gateways/gateways.json'))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(await h.service.status()), /sk-one/);
});

test('a saved Vault key can be chosen instead of typing one', async t => {
  const h = await harness(t);
  await h.vault.create({ id: 'proxy-key', key: 'sk-vault' });
  const { id } = await h.service.create({ gateway: { name: 'Second', url: h.gateway.url, agents: ['codex'] }, credentialId: 'proxy-key' });
  assert.equal(h.t3.secrets.get(`codex_gw_${id}/T3_GATEWAY_KEY`), 'sk-vault');
  assert.equal(h.vault.rows.size, 1);
});

test('a gateway with no key connects, and agents still get a token', async t => {
  const h = await harness(t);
  const { id, gateways } = await h.service.create({ gateway: { name: 'Open', url: h.gateway.url, agents: ['claude'] } });
  assert.equal(h.t3.secrets.get(`claudeAgent_gw_${id}/ANTHROPIC_AUTH_TOKEN`), 'no-key-needed');
  assert.deepEqual(gateways[0].key, { state: 'none' });
});

test('reapplying with nothing changed writes nothing, so no thread is interrupted', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  h.t3.writes.length = 0;
  const { revision } = await h.service.status();
  const { results } = await h.service.reapply({ id, revision });
  assert.deepEqual(results.map(result => result.action), ['none', 'none', 'none']);
  assert.deepEqual(h.t3.writes, []);
});

test('changing one agent only touches that agent', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  h.t3.writes.length = 0;
  await turn(h, id, 'codex', false);
  assert.deepEqual(h.t3.writes, ['codex_gw_my-proxy']);
  assert.equal(h.t3.state.instances['codex_gw_my-proxy'].enabled, false, 'its threads stay readable');
});

test('an agent turned off shows as off and can come back without the key being asked for', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  await turn(h, id, 'codex', false);
  const view = (await h.service.status()).gateways[0].agents.find(agent => agent.id === 'codex');
  assert.equal(view.state, 'off');
  await turn(h, id, 'codex', true);
  assert.equal(h.t3.state.instances['codex_gw_my-proxy'].enabled, true);
});

test('an instance still starting reads as starting, whatever T3’s placeholder says', async t => {
  const h = await harness(t);
  let release;
  const read = h.t3.read;
  h.t3.read = async () => ({ ...await read(), providers: Object.keys(h.t3.state.instances).filter(id => id.includes('_gw_')).map(instanceId => ({ instanceId, status: 'warning', installed: false, checkedAt: '2000-01-01T00:00:00.000Z' })) });
  h.waitFor = new Promise(resolve => { release = resolve; });
  const service = createGatewayService({ baseDir: path.join(h.root, 'state2'), home: h.home, env: {}, io: fs, t3: h.t3, vault: h.vault, processes: h.processes, wait: () => h.waitFor });
  const { gateways } = await service.create({ gateway: { name: 'Slow', url: h.gateway.url, agents: ['claude'] }, key: 'sk-one' });
  assert.equal(gateways[0].agents[0].state, 'starting');
  assert.equal(gateways[0].settling, true);
  h.t3.read = read;
  release();
});

test('adding an agent later reads the key from the Vault', async t => {
  const h = await harness(t), { id } = await add(h, ['claude']);
  await settled();
  await turn(h, id, 'codex', true);
  assert.equal(h.t3.secrets.get('codex_gw_my-proxy/T3_GATEWAY_KEY'), 'sk-one');
});

test('rotating the key here reaches every connected instance', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  const { revision } = await h.service.status();
  await h.service.save({ id, revision, gateway: {}, key: 'sk-two' });
  assert.equal(h.vault.rows.get(`${id}-gateway`).key, 'sk-two');
  assert.equal(h.t3.secrets.get('claudeAgent_gw_my-proxy/ANTHROPIC_AUTH_TOKEN'), 'sk-two');
  assert.equal(await fs.readFile(path.join(h.root, `state/setup/gateways/agents/${id}.key`), 'utf8'), 'sk-two');
});

test('a process that outlives its instance is retired when it holds something old', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  h.stopped.length = 0;
  const all = ['claudeAgent_gw_my-proxy', 'codex_gw_my-proxy', 'opencode_gw_my-proxy'];
  let view = await h.service.status();
  await h.service.save({ id, revision: view.revision, gateway: {}, key: 'sk-two' });
  assert.deepEqual(h.stopped.sort(), all, 'a new key');
  h.stopped.length = 0;
  view = await h.service.status();
  await h.service.save({ id, revision: view.revision, gateway: { url: `${h.gateway.url}/` } });
  assert.deepEqual(h.stopped, [], 'the same address after normalizing');
});

test('OpenCode’s models live in its file, so a new list reaches it through a restart', async t => {
  const h = await harness(t), { id } = await add(h, ['opencode']);
  await settled();
  h.stopped.length = 0;
  h.gateway.state.models = ['gpt-6-astra', 'gpt-7'];
  h.t3.writes.length = 0;
  const { revision } = await h.service.status();
  await h.service.refreshModels({ id, revision });
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(h.root, `state/setup/gateways/agents/${id}.json`), 'utf8')).provider['t3gw-my-proxy'].models), ['gpt-6-astra', 'gpt-7']);
  assert.deepEqual(h.stopped, ['opencode_gw_my-proxy']);
});

test('a key rotated in the Vault reaches OpenCode’s key file, not its instance', async t => {
  const h = await harness(t), { id } = await add(h, ['opencode']);
  await settled();
  h.stopped.length = 0;
  await h.vault.replace(`${id}-gateway`, 'sk-rotated');
  const { revision } = await h.service.status();
  await h.service.reapply({ id, revision });
  assert.equal(await fs.readFile(path.join(h.root, `state/setup/gateways/agents/${id}.key`), 'utf8'), 'sk-rotated');
  assert.deepEqual(h.stopped, ['opencode_gw_my-proxy']);
  assert.equal((await h.service.status()).gateways[0].agents.find(agent => agent.id === 'opencode').state, 'ready');
});

test('processes are stopped before the write, because T3 checks the new instance with the same command', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await settled();
  const order = [], stop = h.processes.stop, upsert = h.t3.upsert;
  h.processes.stop = async (...args) => { order.push('stop'); return stop(...args); };
  h.t3.upsert = async (...args) => { order.push('write'); return upsert(...args); };
  const { revision } = await h.service.status();
  await h.service.save({ id, revision, gateway: {}, key: 'sk-two' });
  assert.deepEqual(order, ['stop', 'write']);
});

test('a gateway added back under the same name doesn’t inherit a process left running', async t => {
  const h = await harness(t), { id } = await add(h, ['opencode']);
  await settled();
  const { revision } = await h.service.status();
  await h.service.remove({ id, revision });
  h.stopped.length = 0;
  await add(h, ['opencode']);
  assert.deepEqual(h.stopped, ['opencode_gw_my-proxy']);
});

test('moving a gateway retires its processes', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']), other = await gatewayServer(t);
  await settled();
  h.stopped.length = 0;
  const { revision } = await h.service.status();
  await h.service.save({ id, revision, gateway: { url: other.url } });
  assert.deepEqual(h.stopped, ['codex_gw_my-proxy']);
});

test('turning an agent off retires its process, so existing threads stop using the gateway', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  h.stopped.length = 0;
  await turn(h, id, 'codex', false);
  assert.deepEqual(h.stopped, ['codex_gw_my-proxy']);
});

test('new models and new names leave running processes alone', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await settled();
  h.stopped.length = 0;
  h.gateway.state.models = ['gpt-6-astra', 'gpt-7'];
  let view = await h.service.status();
  await h.service.refreshModels({ id, revision: view.revision });
  view = await h.service.status();
  await h.service.save({ id, revision: view.revision, gateway: { name: 'Renamed' } });
  assert.deepEqual(h.stopped, []);
});

test('removing a gateway retires its processes, or re-adding the name would reattach to them', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await settled();
  h.stopped.length = 0;
  const { revision } = await h.service.status();
  await h.service.remove({ id, revision });
  assert.ok(h.stopped.includes('codex_gw_my-proxy'));
});

test('a key rotated in the Vault page is noticed, and applied on request', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  await h.vault.replace(`${id}-gateway`, 'sk-rotated');
  const before = await h.service.status();
  assert.deepEqual(before.gateways[0].agents.map(agent => agent.state), ['key-stale', 'key-stale', 'key-stale']);
  await h.service.reapply({ id, revision: before.revision });
  assert.equal(h.t3.secrets.get('codex_gw_my-proxy/T3_GATEWAY_KEY'), 'sk-rotated');
  assert.deepEqual((await h.service.status()).gateways[0].agents.map(agent => agent.state), ['ready', 'ready', 'ready']);
});

test('a key deleted from the Vault is flagged, and working agents are left running', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  h.vault.rows.delete(`${id}-gateway`);
  const view = await h.service.status();
  assert.equal(view.gateways[0].key.state, 'missing');
  h.t3.writes.length = 0;
  await h.service.reapply({ id, revision: view.revision });
  assert.deepEqual(h.t3.writes, []);
});

test('an owned setting changed in T3 Code is flagged, and additions are kept when restored', async t => {
  const h = await harness(t), { id } = await add(h, ['claude']);
  await settled();
  const instance = h.t3.state.instances['claudeAgent_gw_my-proxy'];
  instance.environment = instance.environment.map(row => row.name === 'ANTHROPIC_BASE_URL' ? { ...row, value: 'http://elsewhere' } : row);
  instance.environment.push({ name: 'MY_FLAG', value: '1', sensitive: false });
  const view = await h.service.status();
  assert.equal(view.gateways[0].agents[0].state, 'drift');
  await h.service.reapply({ id, revision: view.revision });
  const restored = h.t3.state.instances['claudeAgent_gw_my-proxy'].environment;
  assert.equal(restored.find(row => row.name === 'ANTHROPIC_BASE_URL').value, h.gateway.url);
  assert.equal(restored.find(row => row.name === 'MY_FLAG').value, '1');
  assert.equal(h.t3.secrets.get('claudeAgent_gw_my-proxy/ANTHROPIC_AUTH_TOKEN'), 'sk-one', 'the saved secret survives');
});

test('renaming an instance in T3 Code is not drift, and survives a later apply', async t => {
  const h = await harness(t), { id } = await add(h, ['claude']);
  await settled();
  h.t3.state.instances['claudeAgent_gw_my-proxy'].displayName = 'Work Claude';
  const view = await h.service.status();
  assert.equal(view.gateways[0].agents[0].state, 'ready');
  assert.equal(view.gateways[0].agents[0].displayName, 'Work Claude');
  h.t3.writes.length = 0;
  await h.service.reapply({ id, revision: view.revision });
  assert.deepEqual(h.t3.writes, []);
});

test('renaming a gateway renames its instances', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await settled();
  const { revision } = await h.service.status();
  await h.service.save({ id, revision, gateway: { name: 'Renamed' } });
  assert.equal(h.t3.state.instances['codex_gw_my-proxy'].displayName, 'Codex · Renamed');
});

test('one agent failing leaves the others connected and says which', async t => {
  const h = await harness(t);
  h.t3.failFor = 'codex';
  const { results, gateways } = await add(h);
  assert.deepEqual(results.map(result => [result.agent, result.ok]), [['claude', true], ['codex', false], ['opencode', true]]);
  assert.match(results[1].error, /refused/);
  assert.equal(gateways[0].agents.find(agent => agent.id === 'codex').state, 'missing');
  h.t3.failFor = null;
  const { revision } = await h.service.status();
  await h.service.reapply({ id: gateways[0].id, revision });
  assert.ok(h.t3.state.instances['codex_gw_my-proxy']);
});

test('nothing is saved while T3 Code is down, and the page can say why', async t => {
  const h = await harness(t);
  h.t3.down = true;
  await assert.rejects(add(h), error => error.status === 503);
  const view = await h.service.status();
  assert.equal(view.gateways.length, 0);
  assert.equal(view.t3.available, false);
  assert.equal(h.vault.rows.size, 0, 'no orphaned key in the Vault');
});

test('a change from an older list is refused', async t => {
  const h = await harness(t), { id } = await add(h, ['claude']);
  const { revision } = await h.service.status();
  await turn(h, id, 'codex', true);
  await assert.rejects(h.service.setAgent({ id, agent: 'codex', connected: false, revision }), error => error.code === 'conflict' && gatewayFailure(error).status === 409);
});

test('a health check is not a change anyone has to refresh for', async t => {
  const h = await harness(t), { id } = await add(h, ['claude']);
  await settled();
  const { revision } = await h.service.status();
  await h.service.test({ id });
  assert.equal((await h.service.status()).revision, revision);
});

test('background model syncing is not a change either', async t => {
  const h = await harness(t, { models: { codex: ['gpt-old'] } });
  await add(h, ['codex']);
  const { revision } = await h.service.status();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(h.t3.hidden.length, 'the sync ran');
  assert.equal((await h.service.status()).revision, revision);
});

test('new models from a health check wait until someone applies them', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await settled();
  h.gateway.state.models = ['gpt-6-astra', 'gpt-7'];
  h.t3.writes.length = 0;
  await h.service.test({ id });
  const view = await h.service.status();
  assert.deepEqual(view.gateways[0].latest, ['gpt-6-astra', 'gpt-7']);
  assert.deepEqual(h.t3.writes, [], 'noticing a model must not restart anything');
  await h.service.refreshModels({ id, revision: view.revision });
  assert.deepEqual(h.t3.state.instances['codex_gw_my-proxy'].config.customModels, ['gpt-6-astra', 'gpt-7']);
  assert.equal((await h.service.status()).gateways[0].latest, null);
});

test('refreshing with the same models restarts nothing', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await settled();
  h.t3.writes.length = 0;
  const { revision } = await h.service.status();
  await h.service.refreshModels({ id, revision });
  assert.deepEqual(h.t3.writes, []);
});

test('a failed refresh keeps the models it had', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await settled();
  h.gateway.state.status = 401;
  const { revision } = await h.service.status();
  const { result, gateways } = await h.service.refreshModels({ id, revision });
  assert.equal(result.ok, false);
  assert.equal(gateways[0].models.ids.length, 2);
  assert.equal(gateways[0].check.code, 'unauthorized');
});

test('built-in models the gateway lacks are hidden once instances report them', async t => {
  const h = await harness(t, { models: { claudeAgent: ['claude-opus-4-8', 'claude-opus-5-5'] } });
  await add(h, ['claude']);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(h.t3.hidden, [{ provider: 'claudeAgent_gw_my-proxy', model: 'claude-opus-5-5', hidden: true }]);
});

test('a model the gateway starts serving comes back, and one hidden by hand stays hidden', async t => {
  const h = await harness(t, { models: { claudeAgent: ['claude-opus-4-8', 'claude-opus-5-5', 'hand-hidden'] }, gatewayModels: ['claude-opus-4-8', 'hand-hidden'] });
  const { id } = await add(h, ['claude']);
  await new Promise(resolve => setTimeout(resolve, 60));
  h.t3.state.preferences['claudeAgent_gw_my-proxy'].hiddenModels.push('hand-hidden');
  h.gateway.state.models = ['claude-opus-4-8', 'claude-opus-5-5', 'hand-hidden'];
  const { revision } = await h.service.status();
  await h.service.refreshModels({ id, revision });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(h.t3.state.preferences['claudeAgent_gw_my-proxy'].hiddenModels, ['hand-hidden']);
});

test('removing a gateway removes its instances and files, keeps default ones and leaves the key in the Vault', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  const { revision } = await h.service.status();
  await h.service.remove({ id, revision });
  assert.deepEqual(Object.keys(h.t3.state.instances).sort(), ['claudeAgent', 'codex', 'opencode']);
  assert.deepEqual(await fs.readdir(path.join(h.root, 'state/setup/gateways/agents')), []);
  assert.equal(h.vault.rows.size, 1);
  assert.equal((await h.service.status()).gateways.length, 0);
});

test('names become unique ids, and each gateway keeps its own instances', async t => {
  const h = await harness(t);
  const first = await add(h, ['codex'], { name: 'Proxy!' });
  await settled();
  const second = await h.service.create({ gateway: { name: 'proxy', url: h.gateway.url, agents: ['codex'] }, key: 'sk-two' });
  assert.equal(first.id, 'proxy');
  assert.equal(second.id, 'proxy-2');
  assert.equal(h.t3.secrets.get('codex_gw_proxy/T3_GATEWAY_KEY'), 'sk-one');
  assert.equal(h.t3.secrets.get('codex_gw_proxy-2/T3_GATEWAY_KEY'), 'sk-two');
});

test('Claude’s settings file is reported with no values, and cleared key by key', async t => {
  const h = await harness(t), file = path.join(h.home, '.claude/settings.json');
  await fs.writeFile(file, JSON.stringify({ model: 'opus', apiKeyHelper: 'echo sk-helper', env: { ANTHROPIC_BASE_URL: 'http://other:1', ANTHROPIC_AUTH_TOKEN: 'sk-settings', KEEP_ME: '1' } }), { mode: 0o640 });
  const before = await h.service.status();
  assert.deepEqual(before.conflicts.map(conflict => [conflict.keys, conflict.host, conflict.active, conflict.file]), [[['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper'], 'other:1', false, '~/.claude/settings.json']]);
  assert.doesNotMatch(JSON.stringify(before), /sk-settings|sk-helper/);
  const { conflicts } = await h.service.clearConflict({ id: 'claude-settings' });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { model: 'opus', env: { KEEP_ME: '1' } });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
});

test('a conflict becomes active once Claude uses a gateway', async t => {
  const h = await harness(t);
  await fs.writeFile(path.join(h.home, '.claude/settings.json'), '{"env":{"ANTHROPIC_BASE_URL":"http://other:1"}}');
  await add(h, ['claude']);
  assert.equal((await h.service.status()).conflicts[0].active, true);
});

test('a settings file that can’t be parsed is left alone', async t => {
  const h = await harness(t), file = path.join(h.home, '.claude/settings.json');
  await fs.writeFile(file, '{ not json');
  assert.deepEqual((await h.service.status()).conflicts, []);
  await h.service.clearConflict({ id: 'claude-settings' });
  assert.equal(await fs.readFile(file, 'utf8'), '{ not json');
});

test('bad input is refused with a sentence and the field it belongs to', async t => {
  const h = await harness(t);
  const failure = async work => { try { await work; } catch (error) { return gatewayFailure(error).body; } assert.fail('expected a refusal'); };
  assert.equal((await failure(h.service.create({ gateway: { name: 'x', url: 'ftp://x', agents: [] } }))).field, 'url');
  assert.equal((await failure(h.service.create({ gateway: { name: 'a'.repeat(41), url: h.gateway.url, agents: [] } }))).field, 'name');
  assert.equal((await failure(h.service.create({ gateway: { name: 'x', url: h.gateway.url, agents: ['nobody'] } }))).field, 'agents');
  assert.equal((await failure(h.service.create({ gateway: { name: 'x', url: h.gateway.url, agents: [] }, key: 'has space' }))).field, 'key');
  assert.equal((await failure(h.service.create({ gateway: { name: 'x', url: h.gateway.url, agents: [], manual: ['bad id'] } }))).field, 'manual');
});

test('testing an unsaved address changes nothing', async t => {
  const h = await harness(t);
  const { result } = await h.service.test({ url: `${h.gateway.url}/v1`, key: 'sk-try' });
  assert.equal(result.ok, true);
  assert.equal(h.gateway.state.keys[0], 'Bearer sk-try');
  assert.deepEqual(result.offers, { claude: 1, codex: 1, opencode: 2 });
  assert.equal((await h.service.status()).gateways.length, 0);
  assert.equal(h.vault.rows.size, 0);
});

test('connecting reuses the test just shown instead of probing again', async t => {
  const h = await harness(t);
  await h.service.test({ url: h.gateway.url, key: 'sk-one' });
  const seen = h.gateway.state.keys.length;
  await add(h, ['claude']);
  assert.equal(h.gateway.state.keys.length, seen);
});

test('the sidebar summary needs neither T3 nor the network', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await settled();
  h.gateway.state.status = 401;
  await h.service.test({ id });
  h.t3.down = true;
  assert.deepEqual(await h.service.summary(), { count: 1, attention: [{ id, name: 'My Proxy', code: 'unauthorized', message: 'The gateway turned this key down.' }] });
});

// These names are T3's API. A stand-in can't tell if they drift, so only the ones
// that exist on a real server are allowed here, and the native smoke runs them for real.
test('the T3 bridge only uses methods a real server has', async () => {
  const calls = [];
  const api = { call: async (method, input) => {
    calls.push([method, input]);
    if (method !== 'server.getConfig' && method !== 'server.updateSettings') throw new Error(`Unknown request tag: ${method}`);
    return { settings: { providerInstances: { codex: {} }, providerModelPreferences: { codex: { hiddenModels: ['x'], modelOrder: [] } } }, providers: [{ instanceId: 'codex' }] };
  } };
  const t3 = createGatewayT3(api), state = await t3.read();
  assert.deepEqual(Object.keys(state.instances), ['codex']);
  assert.equal(state.providers.length, 1);
  assert.deepEqual(state.preferences.codex.hiddenModels, ['x']);
  await t3.upsert('codex_gw_x', { driver: 'codex' });
  await t3.remove('codex_gw_x');
  await t3.setModelsHidden([{ provider: 'codex_gw_x', model: 'm', hidden: true }]);
  assert.deepEqual(calls.slice(1).map(([, input]) => input.providerInstanceMutation?.operation ?? Object.keys(input.patch)[0]), ['upsert', 'remove', 'setModelsHidden']);
});

test('a T3 too old to have provider instances says so', async () => {
  const t3 = createGatewayT3({ call: async () => ({ settings: {} }) });
  await assert.rejects(t3.read(), error => error.code === 'unsupported');
});

const untilQuiet = async h => { for (let index = 0; index < 50 && (await h.service.status()).gateways.some(gateway => gateway.settling); index++) await new Promise(resolve => setTimeout(resolve, 5)); };

test('an agent added later has its models synced, without waiting for ones nobody touched', async t => {
  const h = await harness(t, { models: { codex: ['gpt-old'] } }), { id } = await add(h, ['claude']);
  await untilQuiet(h);
  await turn(h, id, 'codex', true);
  await untilQuiet(h);
  assert.deepEqual(h.t3.hidden.filter(change => change.provider === 'codex_gw_my-proxy').map(change => change.model), ['gpt-old']);
});

test('an agent that never starts doesn’t hold back the ones that did', async t => {
  const h = await harness(t, { models: { codex: ['gpt-old'], claudeAgent: ['claude-old'] } });
  const read = h.t3.read;
  h.t3.read = async () => { const state = await read(); return { ...state, providers: state.providers.map(provider => provider.instanceId.startsWith('claudeAgent') ? { ...provider, installed: false } : provider) }; };
  await add(h, ['claude', 'codex']);
  await untilQuiet(h);
  assert.deepEqual(h.t3.hidden.map(change => change.model), ['gpt-old']);
});

test('a key chosen for a keyless gateway applies, even when both stamps are empty', async t => {
  const h = await harness(t);
  const { id } = await h.service.create({ gateway: { name: 'Open', url: h.gateway.url, agents: ['claude'] } });
  await untilQuiet(h);
  // Credentials from before the Vault tracked this have no change time at all.
  h.vault.rows.set('old-key', { id: 'old-key', key: 'sk-old-credential', changedAt: null });
  const view = await h.service.status();
  await h.service.save({ id, revision: view.revision, gateway: {}, credentialId: 'old-key' });
  assert.equal(h.t3.secrets.get(`claudeAgent_gw_${id}/ANTHROPIC_AUTH_TOKEN`), 'sk-old-credential');
});

test('a model sync that started before a change can’t undo it', async t => {
  let release = () => {};
  const h = await harness(t, { models: { codex: ['gpt-old'] }, wait: () => new Promise(resolve => { release = resolve; }) });
  const { id } = await add(h, ['claude', 'codex']);
  const { revision } = await h.service.status();
  await h.service.setAgent({ id, agent: 'codex', connected: false, revision });
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await h.service.status()).gateways[0].agents.find(agent => agent.id === 'codex').connected, false);
});

test('Restore puts back a key row someone deleted in T3 Code', async t => {
  const h = await harness(t), { id } = await add(h, ['claude']);
  await untilQuiet(h);
  const instance = h.t3.state.instances['claudeAgent_gw_my-proxy'];
  instance.environment = instance.environment.filter(row => row.name !== 'ANTHROPIC_AUTH_TOKEN');
  h.t3.secrets.clear();
  await new Promise(resolve => setTimeout(resolve, 1050)); // past the service's one-second read of T3
  const view = await h.service.status();
  assert.equal(view.gateways[0].agents[0].state, 'drift');
  const { results } = await h.service.reapply({ id, revision: view.revision });
  assert.deepEqual(results.map(result => result.ok), [true]);
  assert.equal(h.t3.secrets.get('claudeAgent_gw_my-proxy/ANTHROPIC_AUTH_TOKEN'), 'sk-one');
});

test('an agent can be turned off even when its instance has lost its key row', async t => {
  const h = await harness(t), { id } = await add(h, ['claude']);
  await untilQuiet(h);
  const instance = h.t3.state.instances['claudeAgent_gw_my-proxy'];
  instance.environment = instance.environment.filter(row => row.name !== 'ANTHROPIC_AUTH_TOKEN');
  const { results } = await turn(h, id, 'claude', false);
  assert.deepEqual(results.map(result => result.ok), [true]);
  assert.equal(h.t3.state.instances['claudeAgent_gw_my-proxy'].enabled, false);
});

test('a model id can’t reach OpenCode’s config expansion', async t => {
  const h = await harness(t, { gatewayModels: ['good-model', '{file:~/.ssh/id_rsa}', '{env:T3_SETUP_KEY}', 'a}b'] }), { id } = await add(h, ['opencode'], { name: 'Bad {file:/etc/passwd}' });
  const text = await fs.readFile(path.join(h.root, `state/setup/gateways/agents/${id}.json`), 'utf8');
  assert.deepEqual(text.match(/\{(?:env|file):/g), ['{file:'], 'Only the key reference remains');
  assert.ok(text.includes('good-model'));
  assert.doesNotMatch(text, /id_rsa|T3_SETUP_KEY/);
});

test('renaming a gateway restarts nothing, OpenCode included, but its file follows', async t => {
  const h = await harness(t), { id } = await add(h);
  await untilQuiet(h);
  h.stopped.length = 0;
  const { revision } = await h.service.status();
  await h.service.save({ id, revision, gateway: { name: 'Renamed' } });
  assert.deepEqual(h.stopped, []);
  assert.match(await fs.readFile(path.join(h.root, `state/setup/gateways/agents/${id}.json`), 'utf8'), /Renamed/);
});

test('renaming and moving together still restarts', async t => {
  const h = await harness(t), { id } = await add(h, ['opencode']), other = await gatewayServer(t);
  await untilQuiet(h);
  h.stopped.length = 0;
  const { revision } = await h.service.status();
  await h.service.save({ id, revision, gateway: { name: 'Renamed', url: other.url } });
  assert.deepEqual(h.stopped, ['opencode_gw_my-proxy']);
});

test('removing a gateway removes files an instance deleted in T3 Code left behind', async t => {
  const h = await harness(t), { id } = await add(h, ['opencode']);
  await untilQuiet(h);
  delete h.t3.state.instances['opencode_gw_my-proxy'];
  const { revision } = await h.service.status();
  await h.service.remove({ id, revision });
  assert.deepEqual(await fs.readdir(path.join(h.root, 'state/setup/gateways/agents')), []);
});

test('an agent the gateway can’t serve can’t be turned on', async t => {
  const h = await harness(t), { id } = await add(h, ['claude']);
  await untilQuiet(h);
  const file = path.join(h.root, 'state/setup/gateways/gateways.json'), data = JSON.parse(await fs.readFile(file, 'utf8'));
  data.gateways[0].check.protocols.responses = 'missing';
  await fs.writeFile(file, JSON.stringify(data));
  const view = await h.service.status();
  assert.equal(view.gateways[0].agents.find(agent => agent.id === 'codex').offered, false);
  await assert.rejects(h.service.setAgent({ id, agent: 'codex', connected: true, revision: view.revision }), /no OpenAI Responses API/);
});

test('a turn-off T3 refused doesn’t read as off', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await untilQuiet(h);
  h.t3.failFor = 'codex';
  const { results, gateways } = await turn(h, id, 'codex', false);
  assert.equal(results[0].ok, false);
  assert.equal(gateways[0].agents.find(agent => agent.id === 'codex').connected, true);
});

test('Try again has T3 look again when nothing needs changing', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await untilQuiet(h);
  h.t3.status = 'error';
  h.t3.writes.length = 0;
  const { revision } = await h.service.status();
  await h.service.reapply({ id, revision });
  assert.deepEqual(h.t3.writes, []);
  assert.deepEqual(h.t3.refreshed, ['codex_gw_my-proxy']);
});

test('ids stay valid for T3 and the Vault, and never collide with the Add sheet', async t => {
  const h = await harness(t);
  const first = await h.service.create({ gateway: { name: 'New', url: h.gateway.url, agents: [] } });
  assert.notEqual(first.id, 'new');
  const long = 'a'.repeat(27) + ' b ' + 'c'.repeat(8);
  await h.service.create({ gateway: { name: long, url: h.gateway.url, agents: [] } });
  const second = await h.service.create({ gateway: { name: long, url: h.gateway.url, agents: [] }, key: 'sk-x' });
  assert.match(second.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});
