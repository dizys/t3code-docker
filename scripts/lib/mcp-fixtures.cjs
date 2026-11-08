// Synthetic MCP files in memory. The real parser/difference implementation is
// reused; this adapter cannot access an agent home, execute or connect servers.
const path = require('node:path');
const fs = require('node:fs');
const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/console/mcp.json'), 'utf8'));
const { pathToFileURL } = require('node:url');
const setup = pathToFileURL(process.env.T3_SETUP_MODULE || (fs.existsSync(path.join(__dirname, '../../docker/setup/mcp.mjs')) ? path.join(__dirname, '../../docker/setup/mcp.mjs') : '/opt/t3-setup/mcp.mjs')).href;
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function createMcpFixtures(initial) {
  let data = clone(initial || fixture()), revision = 1;
  data.scannedAt = Date.now() - 120000;
  const definitions = Object.fromEntries(data.shared.servers.map(s => [s.name, s.type === 'remote' ? { name: s.name, type: 'remote', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer synthetic-shared-token' } }
    : { name: s.name, type: 'local', command: s.command, env: Object.fromEntries((s.envKeys || []).map(k => [k, 'synthetic-' + k])) }]));
  const entries = {};
  for (const p of data.providers.filter(p => p.supported)) {
    entries[p.provider] = {};
    for (const name of [...p.linked, ...p.diverged]) entries[p.provider][name] = { server: clone(definitions[name]), extra: [], enabled: !p.disabled.includes(name) };
    for (const own of p.own) entries[p.provider][own.name] = { server: { name: own.name, type: own.type, command: own.command, env: Object.fromEntries((own.envKeys || []).map(k => [k, 'synthetic-' + k])) }, enabled: true, extra: own.extra || [] };
  }
  if (entries.claude?.docs) { entries.claude.docs.server.url = 'https://docs.example.test/v1/mcp'; entries.claude.docs.server.headers.Authorization = 'Bearer synthetic-agent-token'; }
  const summarize = s => ({ name: s.name, type: s.type, ...(s.type === 'local' ? { command: s.command } : { url: new URL(s.url).origin }), envKeys: Object.keys(s.env || {}), headerKeys: Object.keys(s.headers || {}) });
  const rebuild = () => {
    data.shared.servers = Object.values(definitions).map(summarize); data.shared.count = data.shared.servers.length; data.shared.present = data.shared.count > 0;
    for (const p of data.providers.filter(p => p.supported)) {
      p.linked = []; p.diverged = []; p.disabled = []; p.unlinked = []; p.own = [];
      for (const s of Object.values(definitions)) {
        const e = entries[p.provider][s.name];
        (e ? equal(e.server, s) && !e.extra.length ? p.linked : p.diverged : p.unlinked).push(s.name);
        if (e && !e.enabled) p.disabled.push(s.name);
      }
      for (const [name, entry] of Object.entries(entries[p.provider])) if (!definitions[name]) p.own.push({ ...summarize(entry.server), recognized: true, extra: entry.extra });
      p.ownCount = p.own.length;
    }
    const groups = {};
    for (const p of data.providers) for (const own of p.own) (groups[own.name] ||= []).push(p.provider);
    data.ownGroups = Object.entries(groups).map(([name, providers]) => ({ name, providers, identical: providers.every(id => equal(entries[id][name].server, entries[providers[0]][name].server)) }));
  };
  const status = () => { rebuild(); return clone(data); };
  const failure = (code, error) => ({ status: code, body: { ok: false, code: code === 409 ? 'conflict' : 'invalid', error } });
  const respond = async (method, url, input = {}) => {
    const route = url.pathname.replace(/^\/__setup/, '');
    if (!route.startsWith('/context/mcp')) return null;
    const p = data.providers.find(p => p.provider === (input.provider || url.searchParams.get('provider'))), name = input.name || url.searchParams.get('name');
    const body = value => ({ status: 200, body: { ok: true, ...value } });
    if (method === 'GET') {
      if (route === '/context/mcp') { if (url.searchParams.has('refresh')) data.scannedAt = Date.now(); return body(status()); }
      if (route === '/context/mcp/read') {
        const entry = p ? entries[p.provider]?.[name] : null, server = p ? entry?.server : definitions[name];
        if (!server) return failure(404, 'This server no longer exists.');
        return body({ server: clone(server), revision: data.shared.revision, providerRevision: p?.revision, path: p?.path, extra: entry?.extra || [] });
      }
      if (route === '/context/mcp/diff') {
        const entry = entries[p?.provider]?.[name]; if (!entry || !definitions[name]) return failure(404, 'Server unavailable.');
        const { mcpDifferences } = await import(setup);
        return body({ provider: p.provider, name, sharedRevision: data.shared.revision, providerRevision: p.revision, ...mcpDifferences(definitions[name], { canonical: entry.server, extraOptions: entry.extra }) });
      }
    }
    if (method === 'POST') {
      if (route === '/context/mcp/parse') return body((await import(new URL('./mcp/parse.mjs', setup))).parseMcpSnippet(input.text));
      if (route === '/context/mcp/create' || route === '/context/mcp/save') {
        const { validateMcpServer } = await import(new URL('./mcp/store.mjs', setup)); const result = validateMcpServer(input.server);
        if (!result.ok) return failure(400, result.error);
        if (route.endsWith('/create') && definitions[result.server.name]) return failure(409, 'A shared server with that name exists.');
        if (route.endsWith('/save') && input.revision !== data.shared.revision) return failure(409, 'Shared servers changed elsewhere.');
        const { enabled, ...server } = result.server; definitions[server.name] = server; data.shared.revision = 'mcp-fixture-' + ++revision;
        return body({ server, revision: data.shared.revision });
      }
      if (route === '/context/mcp/adopt') {
        if (!p || p.revision !== input.providerRevision || data.shared.revision !== input.sharedRevision) return failure(409, 'Settings changed elsewhere.');
        if (Boolean(definitions[name]) !== Boolean(input.replace)) return failure(409, 'Shared server changed elsewhere.');
        const entry = entries[p.provider][name]; if (!entry) return failure(404, 'Entry no longer exists.');
        definitions[name] = clone(entry.server); data.shared.revision = 'mcp-fixture-' + ++revision; rebuild();
        return body({ server: summarize(definitions[name]), revision: data.shared.revision, dropped: entry.extra });
      }
      if (route === '/context/mcp/link') {
        if (!p || input.sharedRevision !== data.shared.revision || input.providerRevision !== p.revision) return failure(409, 'Settings changed elsewhere.');
        if (input.enabled === false && !['codex', 'opencode', 'grok', 'muse', 'pi', 'antigravity'].includes(p.provider)) return failure(403, 'This agent has no global off switch.');
        if (input.linked) entries[p.provider][name] = { server: clone(definitions[name]), enabled: input.enabled ?? entries[p.provider][name]?.enabled ?? true, extra: [] };
        else delete entries[p.provider][name];
        p.revision = p.provider + '-fixture-' + ++revision; rebuild(); return body({ provider: p.provider, name, linked: input.linked, revision: p.revision });
      }
      if (route === '/context/mcp/remove') {
        if (input.revision !== data.shared.revision) return failure(409, 'Shared servers changed elsewhere.');
        if (Object.values(entries).some(e => e[name])) return failure(409, 'Unlink this server from every agent first.');
        delete definitions[name]; data.shared.revision = 'mcp-fixture-' + ++revision; rebuild(); return body({ revision: data.shared.revision });
      }
    }
    return failure(405, 'Unsupported fixture action.');
  };
  rebuild(); return { status, respond };
}
module.exports = { createMcpFixtures };
