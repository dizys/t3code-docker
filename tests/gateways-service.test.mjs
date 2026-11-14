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
import { parse as parseToml } from '../docker/setup/vendor/toml-patch.mjs';
import { createMcpService } from '../docker/setup/mcp.mjs';
import { createSkillsService } from '../docker/setup/skills.mjs';
import { nativeModels } from './fixtures/codex-models.mjs';

const REDACTED = { redacted: true };
const redacted = instance => ({ ...instance, environment: instance.environment?.map(row => row.sensitive ? { ...row, value: '', valueRedacted: true } : row) });

function fakeT3({ instances = {}, models = {}, customModelCapabilityOverrides = false, gatewayModelLimits = false } = {}) {
  const state = { instances: { claudeAgent: { driver: 'claudeAgent', config: { binaryPath: '/launchers/claude' } }, codex: { driver: 'codex', config: { binaryPath: '/launchers/codex' } }, opencode: { driver: 'opencode', config: { binaryPath: '/launchers/opencode', serverPassword: 'must-not-copy' } }, ...instances }, preferences: {} };
  // As on a real server, an instance is only checked again when it's written.
  const checked = new Map();
  const t3 = { state, customModelCapabilityOverrides, gatewayModelLimits, writes: [], refreshed: [], secrets: new Map(), hidden: [], down: false, failFor: null, status: 'ready', hubs: {}, hubWrites: [], reports: [], reportReads: 0, hubFails: false, hubStreamFails: false,
    read: async () => {
      if (t3.down) throw new Error('T3 Code is not answering');
      return { customModelCapabilityOverrides: t3.customModelCapabilityOverrides, gatewayModelLimits: t3.gatewayModelLimits, hubs: true, hubSources: Object.fromEntries(Object.entries(t3.hubs).map(([id, source]) => [id, { ...source, managementKey: REDACTED }])), instances: Object.fromEntries(Object.entries(state.instances).map(([id, instance]) => [id, redacted(instance)])), preferences: state.preferences,
        providers: Object.entries(state.instances).filter(([id]) => id.includes('_gw_')).map(([instanceId, instance]) => ({ instanceId, status: t3.status, installed: true, checkedAt: checked.get(instanceId), models: (models[instance.driver] ?? []).map(slug => ({ slug })) })) };
    },
    refresh: async id => { t3.refreshed.push(id); },
    refreshLimits: async () => { t3.refreshed.push('limits'); },
    // As on a real server, reports are only on the config stream, and a read never carries them.
    hubReports: async () => { t3.reportReads++; if (t3.hubStreamFails) throw new Error('no stream'); return t3.reports; },
    setHub: async (id, source) => {
      if (t3.hubFails) throw new Error('T3 refused the hub');
      t3.hubWrites.push(id);
      if (source === null) { delete t3.hubs[id]; return; }
      t3.hubs[id] = { ...source, managementKey: source.managementKey === REDACTED ? t3.hubs[id].managementKey : source.managementKey };
    },
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
  const state = { models, capabilities: {}, catalog: null, keys: [], status: 200 };
  const server = http.createServer((req, res) => {
    state.keys.push(req.headers.authorization); req.resume();
    req.on('end', () => {
      res.writeHead(req.method === 'GET' ? state.status : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/v1/models' ? { data: state.models.map(id => ({ id, ...(state.capabilities[id] ? { reasoning: state.capabilities[id] } : {}) })) }
        : state.catalog && req.url === '/' ? { message: 'CLIProxyAPI' }
          : state.catalog && req.url === '/v1/models?client_version=0.144.0' ? { models: state.catalog } : {}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // A failed `after` hook skips the ones behind it, and an open server would then hold this file up forever.
  server.unref();
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, state };
}

async function harness(t, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 't3-gateways-'));
  // Retried, because agents settle in the background and can still be writing here when a test ends.
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }));
  const home = path.join(root, 'home'), t3 = fakeT3(options), vault = fakeVault();
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  const stopped = [], processes = { stop: async (agent, instanceId) => { stopped.push(instanceId); return 1; } };
  const service = createGatewayService({ baseDir: path.join(root, 'state'), home, env: {}, io: options.io ?? fs, t3, vault, processes, lookup: options.lookup, nativeCodexModels: options.nativeCodexModels ?? (async () => nativeModels), wait: options.wait ?? (() => Promise.resolve()), ...(options.now ? { now: options.now } : {}), ...(options.getHarness ? { getHarness: options.getHarness } : {}) });
  return { service, t3, vault, home, root, stopped, processes, gateway: await gatewayServer(t, options.gatewayModels) };
}
const add = (h, agents = ['claude', 'codex', 'opencode'], over = {}) => h.service.create({ allowPrivateHost: true, gateway: { name: 'My Proxy', preset: 'cliproxyapi', url: h.gateway.url, agents, ...over }, key: 'sk-first-key' });
const turn = async (h, id, agent, connected, more = {}) => { const { revision } = await h.service.status(); return h.service.setAgent({ id, agent, connected, revision, ...more }); };
const settled = async h => {
  if (!h) return new Promise(resolve => setTimeout(resolve, 30));
  const deadline = Date.now() + 5000;
  while ((await h.service.status()).gateways.some(row => row.settling)) {
    assert.ok(Date.now() < deadline, 'Gateway model discovery must settle before external edits.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('a refused DNS-private create never saves credentials, starts agents or spends a management key', async t => {
  const h = await harness(t, { lookup: async () => '127.0.0.1' });
  const url = `http://new-gateway.invalid:${new URL(h.gateway.url).port}`;
  for (const managementKey of [undefined, 'fixture-management']) {
    await assert.rejects(h.service.create({ gateway: { name: 'Unconfirmed', url, agents: ['codex'] }, key: 'fixture-key', managementKey }), { code: 'private-host' });
  }
  assert.equal(h.vault.rows.size, 0); assert.deepEqual(h.t3.writes, []); assert.deepEqual(h.t3.hubWrites, []);
  assert.deepEqual(h.gateway.state.keys, []);
});

test('moving to an unconfirmed DNS-private host preserves the original Vault revision and agent settings', async t => {
  const h = await harness(t, { lookup: async () => '127.0.0.1' }), { id } = await add(h);
  await settled(h);
  const beforeVault = [...h.vault.rows], beforeT3 = structuredClone(h.t3.state), writes = h.t3.writes.length, attempts = h.gateway.state.keys.length;
  const { revision } = await h.service.status(), url = `http://new-gateway.invalid:${new URL(h.gateway.url).port}`;
  await assert.rejects(h.service.save({ id, revision, gateway: { url }, key: 'replacement-fixture-key' }), { code: 'private-host' });
  assert.deepEqual([...h.vault.rows], beforeVault); assert.deepEqual(h.t3.state, beforeT3);
  assert.equal(h.t3.writes.length, writes); assert.equal(h.gateway.state.keys.length, attempts);
  const saved = (await h.service.status()).gateways.find(row => row.id === id); assert.equal(saved.url, h.gateway.url);
  const result = await h.service.save({ id, revision, gateway: { url }, key: 'replacement-fixture-key', allowPrivateHost: true });
  assert.equal(result.ok, true);
  assert.ok(h.gateway.state.keys.includes('Bearer replacement-fixture-key'));
});

test('adding a gateway creates one instance per agent and leaves default instances alone', async t => {
  const h = await harness(t), before = structuredClone(h.t3.state.instances);
  const created = await add(h);
  assert.deepEqual(created.results.map(result => result.action), ['created', 'created', 'created']);
  assert.deepEqual(Object.keys(h.t3.state.instances).filter(id => id.includes('_gw_')).sort(), ['claudeAgent_gw_my-proxy', 'codex_gw_my-proxy', 'opencode_gw_my-proxy']);
  for (const id of ['claudeAgent', 'codex', 'opencode']) assert.deepEqual(h.t3.state.instances[id], before[id]);
  assert.equal(h.t3.state.instances['claudeAgent_gw_my-proxy'].config.binaryPath, '/launchers/claude');
  assert.equal(h.t3.state.instances['opencode_gw_my-proxy'].config.serverPassword, undefined);
});

test('Pi and Grok lifecycle stays scoped through reapply, rotation, model changes and removal', async t => {
  const h = await harness(t, { gatewayModels: ['grok-custom', 'gpt-custom'], instances: {
    pi: { driver: 'pi', config: { binaryPath: '/launchers/pi', launchArgs: '--offline' } },
    grok: { driver: 'grok', config: { binaryPath: '/launchers/grok' } },
  } });
  const direct = structuredClone(h.t3.state.instances);
  const { id, results } = await add(h, ['pi', 'grok']);
  assert.ok(results.every(row => row.ok), JSON.stringify(results));
  await settled();
  const dir = path.join(h.root, 'state/setup/gateways/agents'), piFile = path.join(dir, `${id}.pi.mjs`), grokHome = path.join(dir, `${id}.grok`);
  assert.match(h.t3.state.instances[`pi_gw_${id}`].config.launchArgs, /^--offline --extension /);
  assert.equal(h.t3.state.instances[`grok_gw_${id}`].config.binaryPath, '/launchers/grok');
  assert.equal(h.t3.secrets.get(`pi_gw_${id}/T3_GATEWAY_KEY`), 'sk-first-key');
  assert.equal(h.t3.secrets.get(`grok_gw_${id}/XAI_API_KEY`), 'sk-first-key');
  for (const file of [piFile, path.join(grokHome, 'config.toml')]) {
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /sk-first-key/);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(grokHome)).mode & 0o777, 0o700);
  h.t3.writes.length = 0; h.stopped.length = 0;
  let view = await h.service.status();
  assert.ok((await h.service.reapply({ id, revision: view.revision })).results.every(row => row.action === 'none'));
  assert.deepEqual(h.t3.writes, []);
  assert.deepEqual(h.stopped, []);
  await h.vault.replace(`${id}-gateway`, 'sk-second-key');
  view = await h.service.status();
  await h.service.reapply({ id, revision: view.revision });
  assert.equal(h.t3.secrets.get(`pi_gw_${id}/T3_GATEWAY_KEY`), 'sk-second-key');
  assert.equal(h.t3.secrets.get(`grok_gw_${id}/XAI_API_KEY`), 'sk-second-key');
  assert.deepEqual(h.stopped.sort(), [`grok_gw_${id}`, `pi_gw_${id}`]);
  await settled();
  h.gateway.state.models.push('grok-new');
  h.gateway.state.capabilities['grok-new'] = { supported_efforts: ['low', 'max', 'ultra'] };
  h.stopped.length = 0;
  view = await h.service.status();
  await h.service.refreshModels({ id, revision: view.revision });
  assert.match(await fs.readFile(piFile, 'utf8'), /grok-new/);
  const config = parseToml(await fs.readFile(path.join(grokHome, 'config.toml'), 'utf8'));
  assert.deepEqual(config.model['grok-new'].reasoning_efforts.map(row => row.value), ['low', 'max']);
  assert.deepEqual(h.stopped.sort(), [`grok_gw_${id}`, `pi_gw_${id}`]);
  await settled();
  await fs.mkdir(path.join(grokHome, 'sessions'));
  await fs.writeFile(path.join(grokHome, 'sessions/keep'), 'history');
  view = await h.service.status();
  await h.service.remove({ id, revision: view.revision });
  assert.equal(await fs.readFile(path.join(grokHome, 'sessions/keep'), 'utf8'), 'history');
  assert.equal(await fs.lstat(path.join(grokHome, 'skills')).catch(() => null), null);
  assert.equal(await fs.stat(piFile).catch(() => null), null);
  assert.equal(await fs.stat(path.join(grokHome, 'config.toml')).catch(() => null), null);
  assert.deepEqual(h.t3.state.instances, direct);
});

test('Grok preserves behavior and resources without sharing direct routing, auth or sessions', async t => {
  const h = await harness(t, { gatewayModels: ['grok-custom'], instances: { grok: { driver: 'grok',
    environment: [{ name: 'GROK_HOME', value: 'my-grok', sensitive: false }], config: {} } } });
  const source = path.join(h.home, 'my-grok');
  await fs.mkdir(path.join(source, 'skills'), { recursive: true });
  const text = '[endpoints]\nxai_api_base_url = "https://direct.invalid/v1"\n[models]\ndefault = "direct"\n[model.direct]\napi_key = "sk-direct"\n[skills]\npaths = ["${GROK_HOME}/extra-skills"]\n[ui]\ntheme = "dark"\n[mcp_servers.local]\ncommand = "${GROK_HOME}/bin/mcp"\n[shell_environment_policy]\nexclude = ["MY_SECRET"]\n';
  await fs.writeFile(path.join(source, 'config.toml'), text);
  await fs.writeFile(path.join(source, 'auth.json'), 'direct auth');
  await fs.writeFile(path.join(source, 'skills/keep'), 'skill');
  const { id, results } = await add(h, ['grok']);
  assert.ok(results[0].ok, JSON.stringify(results));
  const target = path.join(h.root, `state/setup/gateways/agents/${id}.grok`);
  const generated = await fs.readFile(path.join(target, 'config.toml'), 'utf8'), config = parseToml(generated);
  assert.doesNotMatch(generated, /sk-direct|direct.invalid/);
  assert.equal(config.ui.theme, 'dark');
  assert.deepEqual(config.skills.paths, [path.join(source, 'extra-skills')]);
  assert.equal(config.mcp_servers.local.command, path.join(source, 'bin/mcp'));
  assert.deepEqual(config.shell_environment_policy.exclude, ['MY_SECRET', 'XAI_API_KEY']);
  assert.equal(await fs.readlink(path.join(target, 'skills')), path.join(source, 'skills'));
  assert.equal(await fs.stat(path.join(target, 'auth.json')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(source, 'config.toml'), 'utf8'), text);
  await settled();
  const { revision } = await h.service.status();
  await h.service.remove({ id, revision });
  assert.equal(await fs.readFile(path.join(source, 'skills/keep'), 'utf8'), 'skill');
  assert.equal(await fs.readFile(path.join(source, 'auth.json'), 'utf8'), 'direct auth');
});

test('invalid Grok user TOML fails only Grok without overwriting user files', async t => {
  const h = await harness(t, { gatewayModels: ['grok-custom'] }), source = path.join(h.home, '.grok');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'config.toml'), '[invalid');
  const { results } = await add(h, ['pi', 'grok']);
  assert.equal(results.find(row => row.agent === 'pi').ok, true);
  assert.match(results.find(row => row.agent === 'grok').error, /not valid TOML/);
  assert.equal(h.t3.state.instances['grok_gw_my-proxy'], undefined);
  assert.equal(await fs.readFile(path.join(source, 'config.toml'), 'utf8'), '[invalid');
});

test('native Grok resource saves refresh connected gateway homes without rewriting instances or keys', async t => {
  const h = await harness(t, { gatewayModels: ['grok-custom'], instances: { grok: { driver: 'grok', config: {} } } });
  const { id, results } = await add(h, ['grok']); assert.equal(results[0].ok, true);
  await settled();
  const before = structuredClone(h.t3.state.instances), writes = h.t3.writes.length, reads = h.vault.reads, stopped = h.stopped.length;
  const configFile = path.join(h.root, `state/setup/gateways/agents/${id}.grok/config.toml`);
  const routing = parseToml(await fs.readFile(configFile, 'utf8')).models;
  const options = { home: h.home, env: {}, io: fs, baseDir: path.join(h.root, 'state'), onNativeChange: h.service.syncNativeResources };
  const mcp = createMcpService(options), created = await mcp.create({ name: 'resource-probe', type: 'local', command: ['fixture'], env: { PRIVATE_FIXTURE: 'preserved' } });
  await mcp.setLink('grok', 'resource-probe', true, created.revision);
  let config = parseToml(await fs.readFile(configFile, 'utf8'));
  assert.equal(config.mcp_servers['resource-probe'].env.PRIVATE_FIXTURE, 'preserved');
  const skills = createSkillsService(options);
  await skills.create('grok', 'resource-probe', '---\nname: resource-probe\ndescription: Probe native propagation\n---\n# Probe\n');
  const row = (await skills.list('grok')).skills[0];
  await skills.setState('grok', row.id, row.stateRevision, undefined, 'disabled');
  config = parseToml(await fs.readFile(configFile, 'utf8'));
  assert.deepEqual(config.skills.disabled, ['resource-probe']);
  await mcp.setLink('grok', 'resource-probe', false, created.revision, (await mcp.list('grok')).revision);
  config = parseToml(await fs.readFile(configFile, 'utf8'));
  assert.equal(config.mcp_servers?.['resource-probe'], undefined);
  assert.deepEqual(config.models, routing);
  assert.deepEqual(h.t3.state.instances, before);
  assert.equal(h.t3.writes.length, writes); assert.equal(h.vault.reads, reads); assert.equal(h.stopped.length, stopped);
});

test('CLIProxyAPI catalog discovery feeds every supported gateway adapter', async t => {
  const ids = ['claude-model', 'gpt-model', 'grok-model'], h = await harness(t, { gatewayModels: ids });
  h.gateway.state.catalog = ids.map(slug => ({ slug, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] }));
  const { id, results } = await add(h, ['claude', 'codex', 'opencode', 'pi', 'grok']);
  assert.ok(results.every(row => row.ok), JSON.stringify(results));
  const saved = JSON.parse(await fs.readFile(path.join(h.root, 'state/setup/gateways/gateways.json'), 'utf8')).gateways[0];
  assert.deepEqual(Object.keys(saved.models.capabilities).sort(), [...ids].sort());
  assert.deepEqual(h.t3.state.instances[`claudeAgent_gw_${id}`].config.customModels, ['claude-model']);
  assert.deepEqual(h.t3.state.instances[`codex_gw_${id}`].config.customModels, ['gpt-model']);
  const dir = path.join(h.root, 'state/setup/gateways/agents');
  const opencode = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'));
  for (const model of ids) assert.deepEqual(opencode.provider['t3gw-my-proxy'].models[model].variants.max, { reasoningEffort: 'max' });
  assert.match(await fs.readFile(path.join(dir, `${id}.pi.mjs`), 'utf8'), /"max": "max"/);
  const grok = parseToml(await fs.readFile(path.join(dir, `${id}.grok/config.toml`), 'utf8'));
  assert.deepEqual(grok.model['grok-model'].reasoning_efforts.map(row => row.value), ['low', 'max']);
});

test('a typed key goes to the Vault and each instance’s secret, and to nowhere else', async t => {
  const h = await harness(t), { id } = await add(h);
  assert.equal(h.vault.rows.get(`${id}-gateway`).key, 'sk-first-key');
  assert.equal(h.t3.secrets.get('claudeAgent_gw_my-proxy/ANTHROPIC_AUTH_TOKEN'), 'sk-first-key');
  assert.equal(h.t3.secrets.get('codex_gw_my-proxy/T3_GATEWAY_KEY'), 'sk-first-key');
  const keyFile = path.join(h.root, `state/setup/gateways/agents/${id}.key`);
  assert.equal(await fs.readFile(keyFile, 'utf8'), 'sk-first-key');
  assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(path.join(h.root, `state/setup/gateways/agents/${id}.json`), 'utf8'), /sk-first-key/);
  const file = await fs.readFile(path.join(h.root, 'state/setup/gateways/gateways.json'), 'utf8');
  assert.doesNotMatch(file, /sk-first-key/);
  assert.equal((await fs.stat(path.join(h.root, 'state/setup/gateways/gateways.json'))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(await h.service.status()), /sk-first-key/);
});

test('a saved Vault key can be chosen instead of typing one', async t => {
  const h = await harness(t);
  await h.vault.create({ id: 'proxy-key', key: 'sk-vault' });
  const { id } = await h.service.create({ allowPrivateHost: true, gateway: { name: 'Second', url: h.gateway.url, agents: ['codex'] }, credentialId: 'proxy-key' });
  assert.equal(h.t3.secrets.get(`codex_gw_${id}/T3_GATEWAY_KEY`), 'sk-vault');
  assert.equal(h.vault.rows.size, 1);
});

test('a gateway with no key connects, and agents still get a token', async t => {
  const h = await harness(t);
  const { id, gateways } = await h.service.create({ allowPrivateHost: true, gateway: { name: 'Open', url: h.gateway.url, agents: ['claude'] } });
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
  const { gateways } = await service.create({ allowPrivateHost: true, gateway: { name: 'Slow', url: h.gateway.url, agents: ['claude'] }, key: 'sk-first-key' });
  assert.equal(gateways[0].agents[0].state, 'starting');
  assert.equal(gateways[0].settling, true);
  h.t3.read = read;
  release();
});

test('adding an agent later reads the key from the Vault', async t => {
  const h = await harness(t), { id } = await add(h, ['claude']);
  await settled();
  await turn(h, id, 'codex', true);
  assert.equal(h.t3.secrets.get('codex_gw_my-proxy/T3_GATEWAY_KEY'), 'sk-first-key');
});

test('rotating the key here reaches every connected instance', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  const { revision } = await h.service.status();
  await h.service.save({ allowPrivateHost: true, id, revision, gateway: {}, key: 'sk-second-key' });
  assert.equal(h.vault.rows.get(`${id}-gateway`).key, 'sk-second-key');
  assert.equal(h.t3.secrets.get('claudeAgent_gw_my-proxy/ANTHROPIC_AUTH_TOKEN'), 'sk-second-key');
  assert.equal(await fs.readFile(path.join(h.root, `state/setup/gateways/agents/${id}.key`), 'utf8'), 'sk-second-key');
});

test('a process that outlives its instance is retired when it holds something old', async t => {
  const h = await harness(t), { id } = await add(h);
  await settled();
  h.stopped.length = 0;
  const all = ['claudeAgent_gw_my-proxy', 'codex_gw_my-proxy', 'opencode_gw_my-proxy'];
  let view = await h.service.status();
  await h.service.save({ allowPrivateHost: true, id, revision: view.revision, gateway: {}, key: 'sk-second-key' });
  assert.deepEqual(h.stopped.sort(), all, 'a new key');
  h.stopped.length = 0;
  view = await h.service.status();
  await h.service.save({ allowPrivateHost: true, id, revision: view.revision, gateway: { url: `${h.gateway.url}/` } });
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
  await h.service.save({ allowPrivateHost: true, id, revision, gateway: {}, key: 'sk-second-key' });
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
  await h.service.save({ allowPrivateHost: true, id, revision, gateway: { url: other.url } });
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
  await h.service.save({ allowPrivateHost: true, id, revision: view.revision, gateway: { name: 'Renamed' } });
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
  assert.deepEqual(before.gateways[0].agents.filter(agent => agent.connected).map(agent => agent.state), ['key-stale', 'key-stale', 'key-stale']);
  await h.service.reapply({ id, revision: before.revision });
  assert.equal(h.t3.secrets.get('codex_gw_my-proxy/T3_GATEWAY_KEY'), 'sk-rotated');
  assert.deepEqual((await h.service.status()).gateways[0].agents.filter(agent => agent.connected).map(agent => agent.state), ['ready', 'ready', 'ready']);
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
  let clock = Date.now();
  const h = await harness(t, { now: () => clock }), { id } = await add(h, ['claude']);
  await settled(h);
  const instance = h.t3.state.instances['claudeAgent_gw_my-proxy'];
  instance.environment = instance.environment.map(row => row.name === 'ANTHROPIC_BASE_URL' ? { ...row, value: 'http://elsewhere' } : row);
  instance.environment.push({ name: 'MY_FLAG', value: '1', sensitive: false });
  clock += 1001; // External changes become visible after the status cache expires.
  const view = await h.service.status();
  assert.equal(view.gateways[0].agents[0].state, 'drift');
  await h.service.reapply({ id, revision: view.revision });
  const restored = h.t3.state.instances['claudeAgent_gw_my-proxy'].environment;
  assert.equal(restored.find(row => row.name === 'ANTHROPIC_BASE_URL').value, h.gateway.url);
  assert.equal(restored.find(row => row.name === 'MY_FLAG').value, '1');
  assert.equal(h.t3.secrets.get('claudeAgent_gw_my-proxy/ANTHROPIC_AUTH_TOKEN'), 'sk-first-key', 'the saved secret survives');
});

test('renaming an instance in T3 Code is not drift, and survives a later apply', async t => {
  let clock = Date.now();
  const h = await harness(t, { now: () => clock }), { id } = await add(h, ['claude']);
  await settled(h);
  h.t3.state.instances['claudeAgent_gw_my-proxy'].displayName = 'Work Claude';
  clock += 1001;
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
  await h.service.save({ allowPrivateHost: true, id, revision, gateway: { name: 'Renamed' } });
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

test('advertised reasoning facts are kept on create and in the view', async t => {
  const h = await harness(t);
  h.gateway.state.capabilities['gpt-6-astra'] = { supported_efforts: ['high', 'low'] };
  await add(h, ['opencode']);
  const view = await h.service.status();
  assert.deepEqual(view.gateways[0].models.capabilities, { 'gpt-6-astra': { supported: true, effort: ['low', 'high'] } });
  assert.equal(view.gateways[0].latestCapabilities, null);
  const stored = JSON.parse(await fs.readFile(path.join(h.root, 'state/setup/gateways/gateways.json'), 'utf8'));
  assert.deepEqual(stored.gateways[0].models.capabilities, { 'gpt-6-astra': { supported: true, effort: ['low', 'high'] } });
});

test('context-only catalog changes wait for apply, rewrite scoped files, and keep direct instances intact', async t => {
  const h = await harness(t, { gatewayModelLimits: true });
  h.gateway.state.catalog = [{ slug: 'gpt-6-astra', context_window: 500000, max_context_window: 1000000, max_tokens: 128000 }];
  const direct = structuredClone(h.t3.state.instances);
  const { id } = await add(h);
  await settled(h);
  const file = path.join(h.root, 'state/setup/gateways/agents', `${id}.codex-models.json`);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).models[0].context_window, 500000);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const env = () => JSON.parse(h.t3.state.instances[`claudeAgent_gw_${id}`].environment.find(row => row.name === 'T3_GATEWAY_MODEL_LIMITS').value);
  // Claude's default scope excludes GPT models, so the map contains no phantom route.
  assert.deepEqual(env(), {});
  let view = await h.service.status();
  await h.service.setAgent({ id, agent: 'claude', connected: true, scope: 'all', revision: view.revision });
  await settled(h);
  assert.equal(env()['gpt-6-astra'].context, 500000);
  h.t3.writes.length = 0; h.stopped.length = 0;
  view = await h.service.status();
  h.gateway.state.catalog[0].context_window = 872000;
  await h.service.test({ id });
  const pending = await h.service.status();
  assert.equal(pending.revision, view.revision);
  assert.equal(pending.gateways[0].latestCapabilities['gpt-6-astra'].limits.context, 872000);
  assert.deepEqual(h.t3.writes, []);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).models[0].context_window, 500000);
  await h.service.refreshModels({ id, revision: view.revision });
  await settled(h);
  assert.equal(env()['gpt-6-astra'].context, 872000);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).models[0].context_window, 872000);
  assert.ok(h.stopped.includes(`codex_gw_${id}`));
  assert.ok(h.stopped.includes(`claudeAgent_gw_${id}`));
  for (const driver of ['claudeAgent', 'codex', 'opencode']) assert.deepEqual(h.t3.state.instances[driver], direct[driver]);
  h.stopped.length = 0; h.t3.writes.length = 0;
  view = await h.service.status();
  await h.service.reapply({ id, revision: view.revision });
  assert.deepEqual(h.stopped, []);
  assert.deepEqual(h.t3.writes, []);
  h.gateway.state.catalog = [];
  view = await h.service.status();
  await h.service.refreshModels({ id, revision: view.revision });
  await settled(h);
  assert.equal(await fs.stat(file).catch(() => null), null, 'withdrawn limits remove the local catalog');
  assert.doesNotMatch(h.t3.state.instances[`codex_gw_${id}`].config.launchArgs, /model_catalog_json/);
});

test('a failed native Codex catalog export keeps its working file and process intact', async t => {
  let broken = false;
  const h = await harness(t, { nativeCodexModels: async () => {
    if (broken) throw new Error('Update Codex before applying gateway context limits.');
    return nativeModels;
  } });
  h.gateway.state.catalog = [{ slug: 'gpt-6-astra', context_window: 500000 }];
  const { id } = await add(h, ['codex']);
  await settled(h);
  const file = path.join(h.root, 'state/setup/gateways/agents', `${id}.codex-models.json`);
  const before = await fs.readFile(file, 'utf8');
  h.stopped.length = 0; h.t3.writes.length = 0;
  broken = true;
  h.gateway.state.catalog[0].context_window = 872000;
  const result = await h.service.refreshModels({ id, revision: (await h.service.status()).revision });
  assert.equal(result.results.find(row => row.agent === 'codex').ok, false);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(h.stopped, []);
  assert.deepEqual(h.t3.writes, []);
});

test('a capability-only change is pending without bumping the revision', async t => {
  const h = await harness(t), { id } = await add(h, ['opencode']);
  await settled();
  h.t3.writes.length = 0;
  const { revision } = await h.service.status();
  h.gateway.state.capabilities['gpt-6-astra'] = { supported_efforts: ['low', 'high'] };
  await h.service.test({ id });
  const view = await h.service.status();
  assert.equal(view.revision, revision, 'background syncing must not read as a change');
  assert.deepEqual(view.gateways[0].latest, ['claude-opus-4-8', 'gpt-6-astra'], 'same ids, re-set so the apply flow runs');
  assert.deepEqual(view.gateways[0].latestCapabilities, { 'gpt-6-astra': { supported: true, effort: ['low', 'high'] } });
  assert.deepEqual(view.gateways[0].models.capabilities, {}, 'not applied yet');
  assert.deepEqual(h.t3.writes, [], 'noticing facts must not restart anything');
  await h.service.refreshModels({ id, revision: view.revision });
  const applied = await h.service.status();
  assert.deepEqual(applied.gateways[0].models.capabilities, { 'gpt-6-astra': { supported: true, effort: ['low', 'high'] } });
  assert.equal(applied.gateways[0].latest, null);
  assert.equal(applied.gateways[0].latestCapabilities, null);
});

test('advertised reasoning facts are kept on refresh', async t => {
  const h = await harness(t), { id } = await add(h, ['codex']);
  await settled();
  h.gateway.state.capabilities['gpt-6-astra'] = { supported_efforts: ['low', 'high'] };
  const { revision } = await h.service.status();
  await h.service.refreshModels({ id, revision });
  assert.deepEqual((await h.service.status()).gateways[0].models.capabilities, { 'gpt-6-astra': { supported: true, effort: ['low', 'high'] } });
});

test('negotiated Claude and Codex capabilities apply without changing direct instances or restarting helpers', async t => {
  const h = await harness(t, { customModelCapabilityOverrides: true });
  const direct = structuredClone(h.t3.state.instances);
  h.gateway.state.capabilities['claude-opus-4-8'] = { supported_efforts: ['low', 'max', 'ultra'] };
  h.gateway.state.capabilities['gpt-6-astra'] = { supported_efforts: ['none', 'high', 'ultra'] };
  const { id } = await add(h, ['claude', 'codex']);
  await settled();
  const configs = () => ['claudeAgent', 'codex'].map(driver => h.t3.state.instances[`${driver}_gw_${id}`].config.customModels);
  assert.deepEqual(configs().map(entries => entries[0].capabilities.optionDescriptors[0].options.map(row => row.id)), [['low', 'max'], ['none', 'high', 'ultra']]);
  for (const [key, instance] of Object.entries(direct)) assert.deepEqual(h.t3.state.instances[key], instance);
  h.t3.writes.length = 0; h.stopped.length = 0;
  await h.service.setAgent({ id, agent: 'codex', connected: true, revision: (await h.service.status()).revision });
  assert.deepEqual(h.t3.writes, [], 'reapply with the same support and facts is a no-op');
  h.gateway.state.capabilities['gpt-6-astra'] = { supported: false };
  await h.service.test({ id });
  const view = await h.service.status();
  assert.deepEqual(h.t3.writes, [], 'health checks never apply new controls');
  await h.service.refreshModels({ id, revision: view.revision });
  assert.deepEqual(configs()[1][0].capabilities, { optionDescriptors: [] });
  assert.deepEqual(h.stopped, [], 'T3 reads these capabilities without restarting the native helper');
});

test('runtime upgrades and downgrades change desired entry shape consistently in reconciliation and drift detection', async t => {
  let time = Date.now();
  const h = await harness(t, { now: () => time }), { id } = await add(h, ['codex']);
  await settled();
  const instance = `codex_gw_${id}`;
  assert.ok(h.t3.state.instances[instance].config.customModels.every(id => typeof id === 'string'));
  for (const supported of [true, false]) {
    h.t3.customModelCapabilityOverrides = supported;
    time += 60_000; // Expire the normal live-config read cache, without sleeping.
    const view = await h.service.status();
    assert.equal(view.gateways[0].agents.find(agent => agent.id === 'codex').state, 'drift');
    await h.service.setAgent({ id, agent: 'codex', connected: true, revision: view.revision });
    assert.ok(h.t3.state.instances[instance].config.customModels.every(entry => typeof entry === (supported ? 'object' : 'string')));
    assert.notEqual((await h.service.status()).gateways[0].agents.find(agent => agent.id === 'codex').state, 'drift');
  }
});

test('the bridge requires an explicit boolean capability advertisement', async () => {
  for (const flag of [undefined, false, 'true', 1, true]) {
    const t3 = createGatewayT3({ call: async () => ({ settings: { providerInstances: {} }, customModelCapabilityOverrides: flag, gatewayModelLimits: flag }) });
    assert.equal((await t3.read()).customModelCapabilityOverrides, flag === true);
    assert.equal((await t3.read()).gatewayModelLimits, flag === true);
  }
});

test('OpenCode v2 gets the providers config shape from the harness version', async t => {
  const h = await harness(t, { getHarness: async provider => provider === 'opencode' ? { id: 'opencode', version: '2.2.6' } : undefined });
  h.gateway.state.capabilities['gpt-6-astra'] = { supported_efforts: ['low', 'high'] };
  const { id } = await add(h, ['opencode']);
  const config = JSON.parse(await fs.readFile(path.join(h.root, `state/setup/gateways/agents/${id}.json`), 'utf8'));
  assert.equal(config.provider, undefined, 'v1 spelling must not appear');
  const provider = config.providers['t3gw-my-proxy'];
  assert.equal(provider.package, '@opencode/ai/providers/openai-compatible');
  assert.equal(provider.settings.baseURL, `${h.gateway.url}/v1`);
  assert.match(provider.settings.apiKey, /^\{file:.*\.key\}$/);
  assert.deepEqual(provider.models['gpt-6-astra'].capabilities.reasoning, { supported: true, effort: ['low', 'high'] });
  assert.deepEqual(provider.models['claude-opus-4-8'].capabilities.reasoning, { supported: false });
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
  const second = await h.service.create({ allowPrivateHost: true, gateway: { name: 'proxy', url: h.gateway.url, agents: ['codex'] }, key: 'sk-second-key' });
  assert.equal(first.id, 'proxy');
  assert.equal(second.id, 'proxy-2');
  assert.equal(h.t3.secrets.get('codex_gw_proxy/T3_GATEWAY_KEY'), 'sk-first-key');
  assert.equal(h.t3.secrets.get('codex_gw_proxy-2/T3_GATEWAY_KEY'), 'sk-second-key');
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
  assert.equal((await failure(h.service.create({ allowPrivateHost: true, gateway: { name: 'x', url: 'ftp://x', agents: [] } }))).field, 'url');
  assert.equal((await failure(h.service.create({ allowPrivateHost: true, gateway: { name: 'a'.repeat(41), url: h.gateway.url, agents: [] } }))).field, 'name');
  assert.equal((await failure(h.service.create({ allowPrivateHost: true, gateway: { name: 'x', url: h.gateway.url, agents: ['nobody'] } }))).field, 'agents');
  assert.equal((await failure(h.service.create({ allowPrivateHost: true, gateway: { name: 'x', url: h.gateway.url, agents: [] }, key: 'has space' }))).field, 'key');
  assert.equal((await failure(h.service.create({ allowPrivateHost: true, gateway: { name: 'x', url: h.gateway.url, agents: [] }, key: 'short' }))).field, 'key', 'a key too short to mask is refused');
  assert.equal((await failure(h.service.test({ allowPrivateHost: true, url: h.gateway.url, key: 'sk-try-key', managementKey: 'short' }))).field, 'managementKey');
  assert.equal((await failure(h.service.create({ allowPrivateHost: true, gateway: { name: 'x', url: h.gateway.url, agents: [], manual: ['bad id'] } }))).field, 'manual');
});

test('testing an unsaved address changes nothing', async t => {
  const h = await harness(t);
  const { result } = await h.service.test({ allowPrivateHost: true, url: `${h.gateway.url}/v1`, key: 'sk-try-key' });
  assert.equal(result.ok, true);
  assert.equal(h.gateway.state.keys[0], undefined, 'The keyless connectivity check runs first');
  assert.ok(h.gateway.state.keys.includes('Bearer sk-try-key'), 'The key goes out only after the host answers');
  assert.deepEqual(result.offers, { claude: 1, codex: 1, opencode: 2, pi: 2, grok: 0 });
  assert.equal((await h.service.status()).gateways.length, 0);
  assert.equal(h.vault.rows.size, 0);
});

test('a test needs a private-host confirm before any key goes out', async t => {
  const h = await harness(t);
  const before = h.gateway.state.keys.length;
  const denied = await h.service.test({ url: h.gateway.url, key: 'sk-try-key' });
  assert.equal(denied.result.code, 'private-host');
  assert.match(denied.result.message, /Confirm that you trust/);
  assert.equal(denied.result.confirmHost, '127.0.0.1');
  assert.equal(h.gateway.state.keys.length, before, 'Zero requests, keyed or not, without the confirm');
  const allowed = await h.service.test({ allowPrivateHost: true, url: h.gateway.url, key: 'sk-try-key' });
  assert.equal(allowed.result.ok, true);
  assert.ok(h.gateway.state.keys.slice(before).includes('Bearer sk-try-key'), 'The key goes out only after the confirm');
  assert.equal(h.gateway.state.keys[before], undefined, 'Even then the keyless check runs first');
});

test('connecting reuses the test just shown instead of probing again', async t => {
  const h = await harness(t);
  await h.service.test({ allowPrivateHost: true, url: h.gateway.url, key: 'sk-first-key' });
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
  const { id } = await h.service.create({ allowPrivateHost: true, gateway: { name: 'Open', url: h.gateway.url, agents: ['claude'] } });
  await untilQuiet(h);
  // Credentials from before the Vault tracked this have no change time at all.
  h.vault.rows.set('old-key', { id: 'old-key', key: 'sk-old-credential', changedAt: null });
  const view = await h.service.status();
  await h.service.save({ allowPrivateHost: true, id, revision: view.revision, gateway: {}, credentialId: 'old-key' });
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
  assert.equal(h.t3.secrets.get('claudeAgent_gw_my-proxy/ANTHROPIC_AUTH_TOKEN'), 'sk-first-key');
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
  await h.service.save({ allowPrivateHost: true, id, revision, gateway: { name: 'Renamed' } });
  assert.deepEqual(h.stopped, []);
  assert.match(await fs.readFile(path.join(h.root, `state/setup/gateways/agents/${id}.json`), 'utf8'), /Renamed/);
});

test('renaming and moving together still restarts', async t => {
  const h = await harness(t), { id } = await add(h, ['opencode']), other = await gatewayServer(t);
  await untilQuiet(h);
  h.stopped.length = 0;
  const { revision } = await h.service.status();
  await h.service.save({ allowPrivateHost: true, id, revision, gateway: { name: 'Renamed', url: other.url } });
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
  const first = await h.service.create({ allowPrivateHost: true, gateway: { name: 'New', url: h.gateway.url, agents: [] } });
  assert.notEqual(first.id, 'new');
  const long = 'a'.repeat(27) + ' b ' + 'c'.repeat(8);
  await h.service.create({ allowPrivateHost: true, gateway: { name: long, url: h.gateway.url, agents: [] } });
  const second = await h.service.create({ allowPrivateHost: true, gateway: { name: long, url: h.gateway.url, agents: [] }, key: 'sk-extra-key' });
  assert.match(second.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

// ---- usage limits -----------------------------------------------------------

/** A gateway with a management API, counting each attempt: five wrong ones lock a server out. */
async function hubServer(t, { accounts = [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'codex', disabled: true }, { provider: 'gemini' }], key = 'the-management-key' } = {}) {
  const state = { attempts: 0, headers: [] };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url === '/v1/models') return json(200, { data: [{ id: 'claude-opus-4-8' }, { id: 'gpt-6-astra' }] });
      if (req.url === '/') return json(200, { message: 'CLI Proxy API Server', endpoints: [] });
      if (req.url.startsWith('/v0/management/')) {
        state.attempts++; state.headers.push(req.headers.authorization);
        if (req.headers.authorization !== `Bearer ${key}`) return json(401, { error: 'invalid management key' });
        return json(200, { files: accounts.map(account => ({ ...account, access_token: 'never-read' })) });
      }
      return json(400, {});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}
const createInput = (hub, extra = {}) => ({ allowPrivateHost: true, gateway: { name: 'Hub', preset: 'cliproxyapi', url: hub.url, agents: ['claude'] }, key: 'sk-hub-key', ...extra });

test('adding a management key gives T3 a verified hub, and the key stays out of the store', async t => {
  const h = await harness(t), hub = await hubServer(t);
  const result = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  assert.equal(result.ok, true); assert.equal(result.limitsError, null);
  const [[id, source]] = Object.entries(h.t3.hubs);
  assert.match(id, /^cliproxy-127\.0\.0\.1/, 'The id T3’s own dialog would choose, so the two agree');
  assert.deepEqual({ kind: source.kind, url: source.url, label: source.label, enabled: source.enabled, key: source.managementKey }, { kind: 'cliproxy', url: hub.url, label: 'Hub', enabled: true, key: 'the-management-key' });
  const stored = await fs.readFile(path.join(h.root, 'state/setup/gateways/gateways.json'), 'utf8');
  assert.ok(!stored.includes('the-management-key'), 'Only T3’s secret store holds it');
  assert.equal(h.vault.rows.has('hub-management'), false, 'Not the Vault either, where agents could ask for it by name');
  assert.ok(![...h.vault.rows.values()].some(row => row.key === 'the-management-key'));
  assert.equal(result.gateways[0].limits.state, 'reading');
  assert.equal(result.gateways[0].limits.owned, true);
});

test('a wrong management key adds nothing, costs one attempt, and never reaches T3', async t => {
  const h = await harness(t), hub = await hubServer(t);
  await assert.rejects(h.service.create(createInput(hub, { managementKey: 'wrong-management-key' })), error => error.code === 'limits' && error.extra.field === 'managementKey' && /not the hash/.test(error.extra.hint) && /30 minutes/.test(error.extra.hint));
  assert.equal(hub.state.attempts, 1, 'Five of these lock the server out');
  assert.deepEqual(h.t3.hubWrites, [], 'T3 polls with whatever it holds, so a bad key would spend the rest');
  assert.deepEqual(h.t3.writes, [], 'And the gateway isn’t half added');
  assert.equal((await h.service.status()).gateways.length, 0);
});

test('a management key is sent only when asked, so a plain test or health check costs nothing', async t => {
  const h = await harness(t), hub = await hubServer(t);
  await h.service.test({ allowPrivateHost: true, url: hub.url, key: 'sk-hub-key' });
  const { id } = await h.service.create(createInput(hub));
  await h.service.test({ id });
  await h.service.status();
  await h.service.reapply({ id, revision: (await h.service.status()).revision });
  assert.equal(hub.state.attempts, 0, 'Not one request reaches a management route without a key');
  assert.ok(hub.state.headers.every(Boolean));
});

test('a key shown as good isn’t spent again when the gateway is added', async t => {
  const h = await harness(t), hub = await hubServer(t);
  const { result } = await h.service.test({ allowPrivateHost: true, url: hub.url, key: 'sk-hub-key', managementKey: 'the-management-key' });
  assert.deepEqual(result.limits, { ok: true, code: 'ok', accounts: { claude: 1, codex: 1 } }, 'Disabled accounts don’t count, and only what Limits can show does');
  assert.ok(!JSON.stringify(result).includes('never-read'), 'The list can hold credentials, and none of it leaves');
  await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  assert.equal(hub.state.attempts, 1);
});

test('a gateway can’t vouch for a management key when it didn’t answer', async t => {
  const h = await harness(t), hub = await hubServer(t);
  const { result } = await h.service.test({ allowPrivateHost: true, url: 'http://127.0.0.1:1', key: 'sk-hub-key', managementKey: 'the-management-key' });
  assert.equal(result.ok, false); assert.equal(result.limits, undefined);
  assert.equal(hub.state.attempts, 0);
});

test('a gateway keeps working when T3 refuses its hub', async t => {
  const h = await harness(t), hub = await hubServer(t);
  h.t3.hubFails = true;
  const result = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  assert.match(result.limitsError, /refused/);
  assert.equal(result.gateways.length, 1);
  assert.equal(result.gateways[0].limits.state, 'off');
});

test('a hub follows its gateway’s name, and keeps its key', async t => {
  const h = await harness(t), hub = await hubServer(t);
  const { id } = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  const [sourceId] = Object.keys(h.t3.hubs);
  await h.service.save({ allowPrivateHost: true, id, revision: (await h.service.status()).revision, gateway: { name: 'Renamed' } });
  assert.deepEqual(Object.keys(h.t3.hubs), [sourceId], 'The same hub, not a second one');
  assert.equal(h.t3.hubs[sourceId].label, 'Renamed');
  assert.equal(h.t3.hubs[sourceId].managementKey, 'the-management-key', 'T3 reads the redacted value as “keep it”');
});

test('a management key never follows a gateway to a new address', async t => {
  const h = await harness(t), hub = await hubServer(t), other = await hubServer(t);
  const { id } = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  const saved = await h.service.save({ allowPrivateHost: true, id, revision: (await h.service.status()).revision, gateway: { url: other.url } });
  assert.deepEqual(Object.keys(h.t3.hubs), [], 'T3 would send it there at once, and that may be someone else’s server');
  assert.equal(saved.limitsStopped, true, 'And the page says so');
  assert.equal(saved.gateways[0].limits.state, 'off');
  assert.equal(other.state.attempts, 0);
});

test('entering the key again moves the hub with the gateway', async t => {
  const h = await harness(t), hub = await hubServer(t), other = await hubServer(t, { key: 'the-new-key' });
  const { id } = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  const [sourceId] = Object.keys(h.t3.hubs);
  await assert.rejects(h.service.save({ allowPrivateHost: true, id, revision: (await h.service.status()).revision, gateway: { url: other.url }, managementKey: 'the-management-key' }), error => error.extra?.field === 'managementKey');
  assert.equal(h.t3.hubs[sourceId].url, hub.url, 'Refused at the new address, nothing moved');
  const saved = await h.service.save({ allowPrivateHost: true, id, revision: (await h.service.status()).revision, gateway: { url: other.url }, managementKey: 'the-new-key' });
  assert.equal(saved.limitsStopped, false);
  assert.deepEqual(Object.keys(h.t3.hubs), [sourceId]);
  assert.equal(h.t3.hubs[sourceId].url, other.url); assert.equal(h.t3.hubs[sourceId].managementKey, 'the-new-key');
});

test('a hub someone set up in T3 Code can’t be taken over by adding a key here', async t => {
  const h = await harness(t), hub = await hubServer(t);
  h.t3.hubs['cliproxy-theirs'] = { kind: 'cliproxy', url: hub.url, managementKey: 'theirs', label: 'Mine', enabled: true };
  await assert.rejects(h.service.create(createInput(hub, { managementKey: 'the-management-key' })), error => error.code === 'limits-exists' && error.extra.field === 'managementKey');
  assert.equal(hub.state.attempts, 0, 'Refused before spending an attempt');
  const { id } = await h.service.create(createInput(hub));
  await assert.rejects(h.service.setLimits({ id, revision: (await h.service.status()).revision, managementKey: 'the-management-key' }), error => error.code === 'limits-exists');
  await assert.rejects(h.service.save({ allowPrivateHost: true, id, revision: (await h.service.status()).revision, gateway: {}, managementKey: 'the-management-key' }), error => error.code === 'limits-exists');
  assert.deepEqual(h.t3.hubs['cliproxy-theirs'], { kind: 'cliproxy', url: hub.url, managementKey: 'theirs', label: 'Mine', enabled: true });
  assert.deepEqual(h.t3.hubWrites, []);
});

test('a hub removed in T3 Code stops being ours, so the next one at that address is theirs', async t => {
  const h = await harness(t), hub = await hubServer(t);
  const { id } = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  const [sourceId] = Object.keys(h.t3.hubs);
  delete h.t3.hubs[sourceId];
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal((await h.service.status()).gateways[0].limits.state, 'off');
  await settled();
  h.t3.hubs[sourceId] = { kind: 'cliproxy', url: hub.url, managementKey: 'theirs', enabled: true };
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal((await h.service.status()).gateways[0].limits.owned, false);
  await h.service.remove({ id, revision: (await h.service.status()).revision });
  assert.ok(h.t3.hubs[sourceId], 'Same id, because T3’s ids come from the address, but not ours to delete');
});

test('removing a gateway says so when T3 keeps its hub', async t => {
  const h = await harness(t), hub = await hubServer(t);
  const { id } = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  h.t3.hubFails = true;
  const removed = await h.service.remove({ id, revision: (await h.service.status()).revision });
  assert.match(removed.limitsError, /refused/);
  assert.equal(removed.gateways.length, 0, 'The gateway still goes');
});

test('T3 being away isn’t the same as a hub being gone', async t => {
  const h = await harness(t), hub = await hubServer(t);
  await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  await new Promise(resolve => setTimeout(resolve, 1050));
  h.t3.down = true;
  const view = (await h.service.status()).gateways[0].limits;
  assert.equal(view.state, 'unknown'); assert.equal(view.owned, true);
  await settled();
  h.t3.down = false;
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal((await h.service.status()).gateways[0].limits.owned, true, 'Nothing was forgotten meanwhile');
});

test('a health check that finishes after a save can’t describe the new address with the old one', async t => {
  const h = await harness(t), hub = await hubServer(t), other = await hubServer(t);
  const { id } = await h.service.create(createInput(hub));
  let release; const hold = new Promise(resolve => { release = resolve; }), real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith(hub.url)) await hold; return real(url, init); };
  t.after(() => { globalThis.fetch = real; });
  const checking = h.service.test({ id });
  await settled();
  globalThis.fetch = real;
  await h.service.save({ allowPrivateHost: true, id, revision: (await h.service.status()).revision, gateway: { url: other.url } });
  const before = (await h.service.status()).gateways[0].check;
  release();
  await checking;
  assert.deepEqual((await h.service.status()).gateways[0].check, before);
});

test('a key changed in the Vault reaches the sidebar without asking T3', async t => {
  const h = await harness(t), hub = await hubServer(t);
  const { gateways: [row] } = await h.service.create(createInput(hub));
  assert.deepEqual((await h.service.summary()).attention, []);
  await h.vault.replace(row.key.credentialId, 'sk-rotated');
  assert.deepEqual((await h.service.summary()).attention.map(item => item.code), ['key-stale']);
});

test('a hub added in T3 Code’s settings is shown, and is never ours to remove', async t => {
  const h = await harness(t), hub = await hubServer(t);
  h.t3.hubs['cliproxy-theirs'] = { kind: 'cliproxy', url: hub.url, managementKey: 'theirs', enabled: true };
  h.t3.reports = [{ id: 'cliproxy-theirs', kind: 'cliproxy', label: 'Theirs', checkedAt: '2026-11-06T00:00:00Z', accounts: [{ id: 'a', driver: 'codex', email: 'a@b.c', plan: 'Pro', usageLimits: {} }] }];
  const { id, gateways } = await h.service.create(createInput(hub));
  assert.deepEqual({ state: gateways[0].limits.state, owned: gateways[0].limits.owned, count: gateways[0].limits.accounts.length }, { state: 'unavailable', owned: false, count: 1 });
  await h.service.remove({ id, revision: (await h.service.status()).revision });
  assert.ok(h.t3.hubs['cliproxy-theirs'], 'Removing the gateway leaves it');
});

test('stopping limits removes the hub, and removing a gateway takes its hub along', async t => {
  const h = await harness(t), hub = await hubServer(t);
  const { id } = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  const stopped = await h.service.setLimits({ id, revision: (await h.service.status()).revision, remove: true });
  assert.deepEqual(Object.keys(h.t3.hubs), []);
  assert.equal(stopped.gateways[0].limits.state, 'off');
  assert.equal(h.t3.writes.filter(write => write.includes('claudeAgent')).length, 1, 'Limits restart nothing');
  await h.service.setLimits({ id, revision: (await h.service.status()).revision, managementKey: 'the-management-key' });
  assert.equal(Object.keys(h.t3.hubs).length, 1, 'And they can be set up again');
  await h.service.remove({ id, revision: (await h.service.status()).revision });
  assert.deepEqual(Object.keys(h.t3.hubs), []);
});

test('T3’s hub reports are looked at only when there’s a hub, and a lost stream isn’t a verdict', async t => {
  const h = await harness(t), hub = await hubServer(t);
  await h.service.status();
  assert.equal(h.t3.reportReads, 0, 'Opening a stream for nothing costs T3 a subscriber');
  const { gateways: [created] } = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  await h.service.status(); await h.service.status();
  assert.ok(h.t3.reportReads <= 2, 'A polling page shares one look');
  h.t3.hubStreamFails = true;
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(created.limits.state, 'reading');
  const later = (await h.service.status()).gateways[0].limits;
  assert.notEqual(later.state, 'error', 'Not hearing back says nothing about the hub');
});

test('limits report what T3 sees, and only for a gateway that can have them', async t => {
  const h = await harness(t), hub = await hubServer(t);
  const { id, gateways: [created] } = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  const sourceId = created.limits.sourceId;
  h.t3.reports = [{ id: sourceId, kind: 'cliproxy', label: 'Hub', checkedAt: '2026-11-06T00:00:00Z', accounts: [{ id: 'a', driver: 'claudeAgent', email: 'a@b.c', usageLimits: { credentialFingerprint: 'not-for-the-page', windows: [{ id: 'five-hour', kind: 'session', label: 'Session', usedPercent: 25.4 }] } }] }];
  await h.service.setLimits({ id, revision: (await h.service.status()).revision, managementKey: 'the-management-key' });
  const on = (await h.service.status()).gateways[0].limits;
  assert.equal(on.state, 'on'); assert.deepEqual(on.accounts, [{ id: 'a', driver: 'claudeAgent', email: 'a@b.c', plan: null, checkedAt: '2026-11-06T00:00:00Z', unavailable: null, windows: [{ id: 'five-hour', label: 'Session', left: 74.6, resetsAt: null }] }], 'What’s left, and only what the page shows');
  h.t3.reports = [{ id: sourceId, kind: 'cliproxy', label: 'Hub', checkedAt: '2026-11-06T00:00:00Z', accounts: [], error: 'The hub rejected the key.' }];
  await h.service.setLimits({ id, revision: (await h.service.status()).revision, managementKey: 'the-management-key' });
  assert.equal((await h.service.status()).gateways[0].limits.state, 'error');
  const litellm = await h.service.create({ allowPrivateHost: true, gateway: { name: 'Other', preset: 'litellm', url: hub.url, agents: [] }, key: 'sk-hub-key' });
  assert.equal(litellm.gateways.find(row => row.id !== id).limits.supported, false);
});

test('account quota failures keep healthy windows, resets and provider identity without leaking extra response fields', async t => {
  const h = await harness(t), hub = await hubServer(t);
  const { id, gateways: [created] } = await h.service.create(createInput(hub, { managementKey: 'the-management-key' }));
  const sourceId = created.limits.sourceId, checkedAt = '2026-11-07T00:00:00Z', resetsAt = '2026-11-08T00:00:00Z';
  h.t3.reports = [{ id: sourceId, checkedAt, accounts: [
    { id: 'ag', driver: 'antigravity', usageLimits: { checkedAt, windows: [{ id: 'claude:weekly', label: 'Claude · Weekly', usedPercent: 100, resetsAt }], api_key: 'do-not-copy' } },
    { id: 'muse', driver: 'muse', usageLimits: { checkedAt, windows: [], unavailable: { reason: 'probeFailed', message: 'The provider returned HTTP 429.', raw: 'do-not-copy' } } },
    { id: 'go', driver: 'opencode-go', usageLimits: { checkedAt, windows: [{ id: 'weekly', label: 'Weekly', usedPercent: NaN }, { id: 'session', label: 'Session', usedPercent: -1 }] } },
  ] }];
  await h.service.setLimits({ id, revision: (await h.service.status()).revision, managementKey: 'the-management-key' });
  const limits = (await h.service.status()).gateways[0].limits;
  assert.equal(limits.state, 'partial');
  assert.equal(limits.accounts.length, 3);
  assert.deepEqual(limits.accounts[0].windows[0], { id: 'claude:weekly', label: 'Claude · Weekly', left: 0, resetsAt });
  assert.deepEqual(limits.accounts[1].unavailable, { reason: 'probeFailed', message: 'The provider returned HTTP 429.' });
  assert.deepEqual(limits.accounts[2].windows, []);
  assert.ok(!JSON.stringify(limits).includes('do-not-copy'));
  h.t3.reports[0].accounts.shift();
  await h.service.setLimits({ id, revision: (await h.service.status()).revision, managementKey: 'the-management-key' });
  assert.equal((await h.service.status()).gateways[0].limits.state, 'unavailable');
});

test('quota refresh shares in-flight probes, preserves configuration, and sanitizes a failed refresh', async t => {
  // Freeze just the store read so concurrency does not depend on disk timing.
  let cachedFile, cachedText;
  const io = { ...fs, readFile: (file, ...args) => file === cachedFile ? Promise.resolve(cachedText) : fs.readFile(file, ...args) };
  const h = await harness(t, { io }), hub = await hubServer(t);
  const created = await h.service.create(createInput(hub, { managementKey: 'the-management-key' })), id = created.id;
  cachedFile = path.join(h.root, 'state/setup/gateways/gateways.json');
  cachedText = await fs.readFile(cachedFile, 'utf8');
  const snapshot = { revision: created.revision, agents: structuredClone(h.t3.writes), hubs: structuredClone(h.t3.hubWrites), keyReads: h.vault.reads };
  let finish, calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  h.t3.refreshLimits = () => { calls++; return pending; };
  const first = h.service.refreshLimits({ id, revision: created.revision }), second = h.service.refreshLimits({ id, revision: created.revision });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'Concurrent callers share the native refresh');
  finish();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.ok && result.revision === snapshot.revision));
  assert.deepEqual(h.t3.writes, snapshot.agents);
  assert.deepEqual(h.t3.hubWrites, snapshot.hubs);
  assert.equal(h.vault.reads, snapshot.keyReads);
  h.t3.refreshLimits = async () => { throw new Error('secret-or-raw-upstream-body'); };
  await assert.rejects(h.service.refreshLimits({ id, revision: created.revision }), error => error.code === 'quota-refresh-failed' && !error.message.includes('secret-or-raw'));
  h.t3.refreshLimits = async () => { calls++; };
  assert.equal((await h.service.refreshLimits({ id, revision: created.revision })).ok, true, 'A failed refresh can be retried');
});
