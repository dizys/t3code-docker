// Shared definitions and native copies. Inventory never executes or connects
// to a server; only authenticated detail reads expose credential values.
import path from 'node:path';
import { mcpStorePathFor, readMcpStore, createMcpServer, saveMcpServer, removeMcpServer, adoptMcpServer,
  redactMcpServer, validateMcpServer, MCP_PROVIDERS, UNSUPPORTED_MCP_PROVIDERS, withStore } from './mcp/store.mjs';
import { readProviderMcp, writeProviderMcpEntry, toClaudeEntry, toCodexEntry, toOpenCodeEntry, toCursorEntry, toAdditionalEntry, isSupportedMcpProvider } from './mcp/adapters.mjs';
import { parseMcpSnippet } from './mcp/parse.mjs';

const problem = (code, message) => Object.assign(new Error(message), { code });
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
const equal = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
const content = ({ enabled, disabled, ...rest }) => rest;
const matches = (row, server) => Boolean(row?.canonical && !row.extra && equal(content(row.canonical), content(server)));
const assertProvider = provider => {
  if (UNSUPPORTED_MCP_PROVIDERS[provider]) throw problem('unsupported', UNSUPPORTED_MCP_PROVIDERS[provider]);
  if (!isSupportedMcpProvider(provider)) throw problem('invalid', 'Unknown MCP provider.');
};
export function mcpProviders() {
  return [...Object.entries(MCP_PROVIDERS).map(([id, name]) => ({ id, name })),
    ...Object.entries(UNSUPPORTED_MCP_PROVIDERS).map(([id, unsupported]) => ({ id, name: { grok: 'Grok Build', muse: 'Muse Code', antigravity: 'Antigravity' }[id], unsupported }))];
}

export function mcpDifferences(shared, row) {
  const agent = row.canonical, fields = [];
  if (!agent) return { fields: [{ field: 'format', kind: 'changed', shared: 'Shared definition', agent: 'Unsupported native entry' }], extraOptions: row.extraOptions || [], adoptable: false, dropped: row.extraOptions || [] };
  const add = (field, a, b, more = {}) => {
    if (equal(a, b)) return;
    const kind = a === undefined ? 'onlyAgent' : b === undefined ? 'onlyShared' : 'changed';
    fields.push({ field, kind, ...more, ...(!more.secret ? { ...(a !== undefined ? { shared: a } : {}), ...(b !== undefined ? { agent: b } : {}) } : {}) });
  };
  add('type', shared.type, agent.type);
  add('command', shared.command?.[0], agent.command?.[0]);
  add('args', shared.command?.slice(1), agent.command?.slice(1));
  add('url', shared.url, agent.url);
  for (const [prop, field] of [['env', 'env'], ['headers', 'header']]) {
    const a = shared[prop] || {}, b = agent[prop] || {};
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) add(field, a[key], b[key], { key, secret: true });
  }
  return { fields, extraOptions: row.extraOptions || [], adoptable: true, dropped: row.extraOptions || [] };
}

export function createMcpService({ home, env = process.env, io, baseDir, getHarness = async () => null, onNativeChange = async () => {}, ttlMs = 15000 } = {}) {
  if (!io) throw new Error('mcp service needs an fs implementation');
  home = path.resolve(home || env.HOME || '/home/t3');
  baseDir = baseDir || env.T3CODE_HOME || path.join(home, '.t3');
  let cached = null, at = 0;
  const invalidate = () => { cached = null; at = 0; };
  const native = provider => readProviderMcp(io, provider, { home, env });
  const capabilityError = async provider => {
    if (provider !== 'pi') return null;
    const harness = await getHarness(provider), version = harness?.installedVersion || harness?.version;
    if (!harness?.installed && !harness?.runnable) return null;
    const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version || '');
    if (match && (Number(match[1]) > 0 || Number(match[2]) >= 99)) return null;
    return 'Update Pi to 0.99.0 or later to use native MCP servers. This installed version does not have verified mcp.json support.';
  };
  const storeRead = async () => {
    const store = await readMcpStore(io, baseDir);
    if (store.error) throw problem(store.code || 'unavailable', store.error);
    return store;
  };
  const getServer = (store, name) => {
    const server = store.servers.find(s => s.name === name);
    if (!server) throw problem('missing', 'This shared MCP server no longer exists. Refresh the list.');
    return server;
  };
  const stateFor = (provider, read, shared) => {
    const linked = [], diverged = [], unlinked = [], disabled = [];
    for (const server of shared) {
      const row = read.servers.find(r => r.name === server.name);
      (row ? matches(row, server) ? linked : diverged : unlinked).push(server.name);
      if (row?.canonical?.enabled === false) disabled.push(server.name);
    }
    const own = read.servers.filter(r => !shared.some(s => s.name === r.name)).map(row => row.canonical
      ? { ...redactMcpServer(row.canonical), recognized: true, extra: row.extraOptions || [] }
      : { name: row.name, recognized: false, extra: row.extraOptions || [] });
    return { provider, supported: true, path: read.path, present: read.present, revision: read.revision, linked, diverged, unlinked, disabled, own, ownCount: own.length,
      error: null, warning: read.servers.some(row => !row.canonical) ? 'One or more entries use an unsupported shape and are left in place.' : null };
  };
  const status = async ({ refresh = false } = {}) => {
    if (!refresh && cached && Date.now() - at < ttlMs) return cached;
    const promise = (async () => {
      const store = await readMcpStore(io, baseDir), reads = new Map();
      const providers = await Promise.all(Object.keys(MCP_PROVIDERS).map(async provider => {
        if (UNSUPPORTED_MCP_PROVIDERS[provider]) return { provider, supported: false, error: UNSUPPORTED_MCP_PROVIDERS[provider], ...(provider === 'grok' ? { imports: ['claude', 'cursor'] } : {}), linked: [], diverged: [], unlinked: [], disabled: [], own: [], ownCount: 0 };
        try {
          const unavailable = await capabilityError(provider);
          if (unavailable) throw problem('upgrade-required', unavailable);
          const read = await native(provider); reads.set(provider, read); return stateFor(provider, read, store.servers);
        }
        catch (error) { return { provider, supported: true, revision: null, linked: [], diverged: [], unlinked: [], disabled: [], own: [], ownCount: 0,
          error: String(error?.message || error).slice(0, 240), code: error?.code }; }
      }));
      const groups = new Map();
      for (const provider of providers) for (const own of provider.own) {
        if (!groups.has(own.name)) groups.set(own.name, []);
        groups.get(own.name).push(provider.provider);
      }
      const ownGroups = [...groups].map(([name, ids]) => {
        const rows = ids.map(id => reads.get(id).servers.find(r => r.name === name));
        return { name, providers: ids, identical: rows.every(row => row.canonical && equal(content(row.canonical), content(rows[0].canonical))) };
      });
      return { ok: !store.error, shared: { path: store.path, present: store.present, count: store.servers.length, revision: store.revision, bytes: store.bytes,
        error: store.error ?? null, servers: store.servers.map(redactMcpServer) }, providers, ownGroups, scannedAt: Date.now() };
    })();
    cached = promise; at = Date.now();
    promise.catch(() => { if (cached === promise) invalidate(); });
    return promise;
  };
  const read = async (name, provider) => {
    const store = await storeRead();
    if (!provider) return { ok: true, server: getServer(store, name), revision: store.revision };
    assertProvider(provider);
    const detail = await native(provider), row = detail.servers.find(r => r.name === name);
    if (!row) throw problem('missing', 'This agent no longer has that server. Rescan to see the current state.');
    return { ok: true, server: row.canonical, recognized: Boolean(row.canonical), extra: row.extraOptions, path: detail.path,
      revision: store.revision, providerRevision: detail.revision };
  };
  const diff = async (provider, name) => {
    assertProvider(provider);
    const store = await storeRead(), server = getServer(store, name), detail = await native(provider), row = detail.servers.find(r => r.name === name);
    if (!row) throw problem('missing', 'This agent no longer has that server. Rescan to see the current state.');
    return { ok: true, provider, name, sharedRevision: store.revision, providerRevision: detail.revision, ...mcpDifferences(server, row) };
  };
  const setLink = async (provider, name, linked, sharedRevision, providerRevision, enabled) => withStore(mcpStorePathFor(baseDir), async () => {
    assertProvider(provider);
    if (typeof linked !== 'boolean' || (enabled !== undefined && typeof enabled !== 'boolean')) throw problem('invalid', 'Expected boolean linked and enabled values.');
    const unavailable = linked && await capabilityError(provider);
    if (unavailable) throw problem('upgrade-required', unavailable);
    if (enabled === false && !['codex', 'opencode', 'grok', 'muse', 'pi', 'antigravity'].includes(provider)) throw problem('unsupported', `${MCP_PROVIDERS[provider]} has no global off switch. Remove it instead.`);
    const store = await storeRead();
    if (store.revision !== sharedRevision) throw problem('conflict', 'Shared MCP servers changed. Refresh the list before changing links.');
    const server = getServer(store, name);
    const current = await native(provider), existing = current.servers.find(r => r.name === name);
    const on = enabled ?? existing?.canonical?.enabled ?? server.enabled !== false;
    const entry = !linked ? null : provider === 'codex' ? toCodexEntry(server, on) : provider === 'opencode' ? toOpenCodeEntry(server, false, on)
      : provider === 'claude' ? toClaudeEntry(server) : provider === 'cursor' ? toCursorEntry(server) : toAdditionalEntry(provider, server, on);
    const result = await writeProviderMcpEntry(io, provider, { home, env }, name, entry, { revision: providerRevision });
    invalidate();
    const propagation = await onNativeChange(provider);
    return { ...result, ok: true, provider, name, linked, ...(propagation ? { propagation } : {}) };
  });
  const adopt = async (provider, name, providerRevision, sharedRevision, replace = false) => {
    assertProvider(provider);
    if (typeof replace !== 'boolean') throw problem('invalid', 'Expected a boolean replacement choice.');
    const result = await adoptMcpServer(io, baseDir, name, sharedRevision, async () => {
      const detail = await native(provider);
      if (detail.revision !== providerRevision) throw problem('conflict', 'Agent settings changed. Review the current entry before sharing it.');
      const row = detail.servers.find(r => r.name === name);
      if (!row?.canonical) throw problem('unsupported', 'This entry’s format isn’t supported here.');
      return { server: row.canonical, dropped: row.extraOptions, verify: async () => {
        if ((await native(provider)).revision !== providerRevision) throw problem('conflict', 'Agent settings changed. Review the current entry before sharing it.');
      } };
    }, replace);
    invalidate(); return result;
  };
  const mutation = operation => async (...args) => {
    const result = await operation(io, baseDir, ...args);
    if (!result.ok) throw problem(result.code || 'invalid', result.error);
    invalidate(); return { ok: true, ...result };
  };
  return { status, read, diff, setLink, adopt, parse: parseMcpSnippet, providers: mcpProviders, validate: validateMcpServer,
    list: async provider => {
      assertProvider(provider);
      const store = await storeRead(), detail = await native(provider), state = stateFor(provider, detail, store.servers);
      const unavailable = await capabilityError(provider);
      return { ok: true, ...state, sharedRevision: store.revision, shared: store.servers.map(s => ({ ...redactMcpServer(s),
        linked: state.linked.includes(s.name), diverged: state.diverged.includes(s.name), linkable: !unavailable })), ...(unavailable ? { error: unavailable, code: 'upgrade-required' } : {}), unsupported: detail.servers.filter(r => !r.canonical).map(r => r.name) };
    },
    create: mutation(createMcpServer), save: mutation(saveMcpServer),
    remove: async (name, revision) => {
      const result = await removeMcpServer(io, baseDir, name, revision, async () => {
        for (const provider of Object.keys(MCP_PROVIDERS)) if ((await native(provider)).servers.some(r => r.name === name))
          throw problem('conflict', 'Unlink this server from every provider before removing its shared definition.');
      });
      if (!result.ok) throw problem(result.code || 'invalid', result.error);
      invalidate(); return { ok: true, ...result };
    },
  };
}
export { mcpStorePathFor };
