// The real gateway service over stand-ins: files in memory, a T3 that keeps its
// settings in an object, and a pretend gateway whose answers depend on the
// address. The page's sentences and rules are therefore the real ones, and
// nothing here can reach a network, a Vault or T3 Code.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const setup = pathToFileURL(process.env.T3_GATEWAYS_MODULE || path.join(__dirname, '../../docker/setup/gateways.mjs')).href;
const MODELS = ['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gemini-2.5-pro', 'gemini-3-flash', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra'];
const windows = (session, weekly) => ({ windows: [{ id: 'session', kind: 'session', label: 'Session', usedPercent: session, resetsAt: '2099-01-01T00:00:00Z' }, { id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: weekly, resetsAt: '2099-01-02T00:00:00Z' }] });
const ACCOUNTS = [{ id: 'a', driver: 'claudeAgent', email: 'claude@example.com', plan: 'Max', usageLimits: windows(25, 40) }, { id: 'b', driver: 'codex', email: 'codex-one@example.com', plan: 'Pro', usageLimits: windows(30, 55) }, { id: 'c', driver: 'codex', email: 'codex-two@example.com', plan: 'Plus', usageLimits: windows(10, 20) },
  { id: 'antigravity', driver: 'antigravity', email: 'antigravity@example.com', usageLimits: windows(100, 50) },
  { id: 'muse', driver: 'muse', email: 'muse@example.com', plan: 'Everyday', usageLimits: windows(2, 0) },
  { id: 'go', driver: 'opencode-go', email: 'go@example.com', plan: 'Go', usageLimits: windows(60, 25) }];
const BUILT_IN = { claudeAgent: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5'] };

const memoryFiles = () => {
  const files = new Map(), links = new Map();
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    files,
    readFile: async file => { if (!files.has(file)) throw missing(); return files.get(file); },
    writeFile: async (file, text) => { files.set(file, text); },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    rm: async file => { files.delete(file); links.delete(file); },
    mkdir: async () => {},
    realpath: async file => file,
    stat: async () => ({ mode: 0o600 }),
    lstat: async file => {
      if (!files.has(file) && !links.has(file)) throw missing();
      return { mode: 0o600, isSymbolicLink: () => links.has(file) };
    },
    symlink: async (origin, target) => {
      if (files.has(target) || links.has(target)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      links.set(target, origin);
    },
    readlink: async file => { if (!links.has(file)) throw missing(); return links.get(file); },
    unlink: async file => { if (!links.delete(file)) throw missing(); },
  };
};

const memoryVault = () => {
  const rows = new Map();
  const stamp = () => new Date().toISOString();
  return {
    rows,
    list: async () => [...rows.values()].map(({ key, ...row }) => row),
    read: async id => { if (!rows.has(id)) throw new Error('gone'); return rows.get(id).key; },
    available: async id => rows.has(id) ? `${id}-2` : id,
    create: async ({ id, key }) => { const row = { id, description: '', baseUrl: null, changedAt: stamp(), key }; rows.set(id, row); return row; },
    replace: async (id, key) => { const row = { ...rows.get(id), key, changedAt: stamp() }; rows.set(id, row); return row; },
    remove: async id => { rows.delete(id); },
  };
};

const redacted = instance => ({ ...instance, environment: instance.environment?.map(row => row.sensitive ? { ...row, value: '', valueRedacted: true } : row) });
const memoryT3 = () => {
  const state = { down: false, hubs: {}, reports: [], instances: {
    claudeAgent: { driver: 'claudeAgent', config: { binaryPath: '/launchers/claude' } },
    codex: { driver: 'codex', config: { binaryPath: '/launchers/codex' } },
    opencode: { driver: 'opencode', config: { binaryPath: '/launchers/opencode' } },
    pi: { driver: 'pi', config: { binaryPath: '/launchers/pi' } },
    grok: { driver: 'grok', config: { binaryPath: '/launchers/grok' } } }, preferences: {} };
  const t3 = { state,
    read: async () => {
      if (state.down) throw new Error('T3 Code is not answering');
      return { hubs: true, hubSources: Object.fromEntries(Object.entries(state.hubs).map(([id, source]) => [id, { ...source, managementKey: '__redacted__' }])),
        instances: Object.fromEntries(Object.entries(state.instances).map(([id, instance]) => [id, redacted(instance)])), preferences: state.preferences,
        providers: Object.entries(state.instances).filter(([id]) => id.includes('_gw_') && state.instances[id].enabled !== false).map(([instanceId, instance]) => ({ instanceId, status: 'ready', installed: true, checkedAt: new Date().toISOString(), models: (BUILT_IN[instance.driver] ?? []).map(slug => ({ slug })) })) };
    },
    upsert: async (id, instance) => { state.instances[id] = instance; },
    // Like T3: null removes, a redacted key keeps the saved one, and a hub is read a moment later.
    setHub: async (id, source) => {
      if (source === null) { delete state.hubs[id]; state.reports = state.reports.filter(report => report.id !== id); return; }
      state.hubs[id] = { ...source, managementKey: source.managementKey === '__redacted__' ? state.hubs[id]?.managementKey : source.managementKey };
      state.reports = state.reports.filter(report => report.id !== id);
      setTimeout(() => { if (state.hubs[id]) state.reports.push({ id, kind: 'cliproxy', label: source.label, checkedAt: new Date().toISOString(), accounts: structuredClone(ACCOUNTS) }); }, 1200);
    },
    // Like T3: reports only come from the stream, never from a read.
    hubReports: async () => state.reports,
    refresh: async () => {},
    refreshLimits: async () => {},
    remove: async id => { delete state.instances[id]; },
    setModelsHidden: async changes => { for (const { provider, model, hidden } of changes) { const list = state.preferences[provider]?.hiddenModels ?? []; state.preferences[provider] = { hiddenModels: hidden ? [...list, model] : list.filter(entry => entry !== model) }; } },
  };
  return t3;
};

// Addresses that behave a particular way, so a failure can be seen without one.
const respond = (url, init = {}) => {
  const target = new URL(url), host = target.hostname, key = init.headers?.authorization ?? '';
  const fail = code => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); };
  if (host === 'down.example.test' || target.port === '1' || host === '127.0.0.1' || host === 'localhost') fail('ECONNREFUSED');
  if (host === 'missing.example.test') fail('ENOTFOUND');
  if (host === 'slow.example.test') fail('UND_ERR_CONNECT_TIMEOUT');
  if (host === 'selfsigned.example.test') fail('DEPTH_ZERO_SELF_SIGNED_CERT');
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (host === 'web.example.test') return new Response('<h1>hello</h1>', { status: 404 });
  // Like CLIProxyAPI: who it is at its root, and its management API behind a key of its own.
  if (target.pathname === '/') return host.includes('cliproxy') || target.port === '8317' ? json(200, { message: 'CLI Proxy API Server', endpoints: [] }) : json(404, {});
  if (target.pathname.endsWith('/auth-files')) {
    if (key.includes('locked')) return json(403, { error: 'IP banned due to too many failed attempts. Try again in 29m12s' });
    if (key.includes('remote-off')) return json(403, { error: 'remote management disabled' });
    if (!key.includes('management')) return json(401, { error: 'invalid management key' });
    return json(200, { files: [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'codex' }, { provider: 'gemini' }] });
  }
  if (key.includes('wrong')) return json(401, { error: 'bad key' });
  if (target.pathname.endsWith('/models')) return json(200, { data: (host === 'tiny.example.test' ? ['claude-sonnet-5-5'] : MODELS).map(id => ({ id })) });
  if (host === 'tiny.example.test' && target.pathname.endsWith('/responses')) return json(404, {});
  return json(400, { error: 'invalid request' });
};

function createGatewaysFixtures({ scenario = 'set-up', installed = ['claude', 'codex', 'opencode'] } = {}) {
  const modules = import(setup);
  let current = null;
  const build = async name => {
    const { createGatewayService, gatewayFailure } = await modules;
    const io = memoryFiles(), t3 = memoryT3(), vault = memoryVault();
    let tick = 0;
    const service = createGatewayService({ baseDir: '/state', home: '/home/t3', env: {}, io, t3, vault, processes: { stop: async () => 0 }, fetchImpl: async (url, init) => { await new Promise(resolve => setTimeout(resolve, 120)); return respond(url, init); },
      now: () => Date.now() + tick, wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 400))) });
    const set = { service, gatewayFailure, io, t3, vault, name };
    if (name === 'set-up' || name === 'attention') {
      await service.create({ gateway: { name: 'CLIProxy', preset: 'cliproxyapi', url: 'http://host.docker.internal:8317', agents: ['claude', 'codex'] }, key: 'sk-fixture', managementKey: 'fixture-management' });
      await service.create({ gateway: { name: 'Team LiteLLM', preset: 'litellm', url: 'https://llm.example.net', agents: ['opencode'] }, key: 'sk-fixture-team' });
    }
    if (name === 'attention') {
      const { gateways } = await service.status();
      await vault.replace('cliproxy-gateway', 'sk-rotated');
      await service.test({ id: gateways[0].id });
      const instance = t3.state.instances['opencode_gw_team-litellm'];
      instance.environment = instance.environment.map(row => row.name === 'OPENCODE_CONFIG_CONTENT' ? { ...row, value: '{}' } : row);
      await vault.replace('team-litellm-gateway', 'wrong-key');
      io.files.set('/home/t3/.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://old-proxy:8080' } }));
    }
    return set;
  };
  const ready = () => current ??= build(scenario);
  return {
    respond: async (method, url, input = {}) => {
      const route = url.pathname.replace(/^\/__setup/, '');
      if (route === '/gateways/__scenario') { current = build(input.name); await current; return { body: { ok: true } }; }
      if (route === '/gateways/__t3') { (await ready()).t3.state.down = input.down === true; return { body: { ok: true } }; }
      if (!/^\/gateways(?:\/|$)/.test(route)) return null;
      const set = await ready();
      try { return { body: route === '/gateways' ? await set.service.status() : await set.service.handle(route, input) }; }
      catch (error) { const failure = set.gatewayFailure(error); return { status: failure.status, body: failure.body }; }
    },
    summary: async () => (await ready()).service.summary(),
    t3: async () => (await ready()).t3,
  };
}
module.exports = { createGatewaysFixtures, MODELS };
