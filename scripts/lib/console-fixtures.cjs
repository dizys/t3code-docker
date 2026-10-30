// Sample data for photographing the setup console, shared by
// scripts/console-screens.js and scripts/readme-media.js.
//
// The console's own code renders every page; only its data is replaced:
// /status, /ports, /providers and the skills inventories come from
// scripts/fixtures/console, shifted to the present and changed per scenario,
// and every POST is answered here without reaching the server.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const FIXTURES = path.join(__dirname, "..", "fixtures", "console");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

/** The console's own table of pages. */
const routesTable = () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "..", "docker/setup/client/routes.js"), "utf8"), context);
  return vm.runInContext("T3Routes", context);
};

// ------------------------------------------------------------ the data --
/** Move every timestamp in a fixture by the same amount, so "2 hours ago" stays true today. */
const shiftTimes = (value, by) => {
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, by));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftTimes(v, by)]));
  if (typeof value === "number" && value > 1.6e12 && value < 2.2e12) return value + by;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return new Date(Date.parse(value) + by).toISOString();
  return value;
};

const harness = (s, id) => s.harnesses.find((h) => h.id === id);
const SCENARIOS = {
  ready: (s) => {
    s.paths.volumeKind = "durable";
    s.paths.volumeName = "t3-home";
    return s;
  },
  skills: (s) => {
    SCENARIOS.ready(s);
    for (const id of ['cursor', 'grok', 'muse', 'antigravity']) {
      let agent = harness(s, id);
      if (!agent) { agent = { id, name: { cursor: 'Cursor', grok: 'Grok Build', muse: 'Muse Code', antigravity: 'Antigravity' }[id] }; s.harnesses.push(agent); }
      Object.assign(agent, { installed: ['cursor', 'grok'].includes(id), runnable: true, version: '1.0.0', installedVersion: '1.0.0', signedIn: true });
    }
    s.context.agentsMd = { ...s.context.agentsMd, present: true, path: '/home/t3/.t3/setup/context/AGENTS.md', revision: 'fixture-shared', modifiedAt: Date.now() - 120000, bytes: 384 };
    s.context.providers = s.context.providers.map(row => ({ ...row, mode: row.provider === 'opencode' ? 'separate' : 'shared', bytes: 1280, sourceRevision: 'fixture-instructions-' + row.provider }));
    return s;
  },
  setup: (s, now) => {
    s.publicUrl = null;
    s.publicUrlSource = null;
    s.sessions = [];
    s.events = [];
    s.paths.volumeKind = "durable";
    s.connect = { ...s.connect, state: "off" };
    const installing = ["opencode", "go", "rust", "bun", "deno", "uv"];
    s.setup = {
      state: "running", startedAt: now - 90_000, finishedAt: null, current: "opencode",
      items: s.setup.items.map((item) => ({ ...item, state: item.id === "opencode" ? "installing" : installing.includes(item.id) ? "pending" : "done",
        progress: item.id === "opencode" ? { phase: "downloading", done: 41_000_000, total: 96_000_000 } : undefined })),
    };
    for (const h of s.harnesses) {
      if (h.managedBy) continue;
      if (h.id === "claude" || h.id === "codex") { h.signedIn = false; h.credentialsPresent = false; h.latestVersion = h.installedVersion; }
      else Object.assign(h, { installed: false, runnable: false, version: null, installedVersion: null, signedIn: null, credentialsPresent: false });
    }
    for (const t of s.toolchains) if (installing.includes(t.id)) Object.assign(t, { installed: false, version: null });
    s.packages = [];
    return s;
  },
  attention: (s) => {
    Object.assign(harness(s, "codex"), { signedIn: false });
    Object.assign(s.toolchains.find((t) => t.id === "go"), { failed: true, failure: "Download timed out after 120 s", operation: "update" });
    s.storage.disk = { ...s.storage.disk, usedPercent: 86, availableBytes: 29_000_000_000 };
    s.legacyEnv = ["GOROOT", "PATH"];
    s.paths.volumeKind = "anonymous";
    s.paths.volumeName = "6c1f0e9a4b2d8c7e5f3a1b9d0e8c6a4f2b7d5e3c1a9f8e6d4c2b0a7f5e3d1c9b";
    return s;
  },
};
const PORTS = {
  ready: (p, now) => ({ ...p, tunnels: [{ port: 5173, state: "open", url: "https://quiet-river-1234.trycloudflare.com", startedAt: now - 12 * 60_000 }] }),
  setup: (p) => ({ ...p, listening: [], details: [], tunnels: [] }),
  attention: (p) => ({ ...p, tunnels: [{ port: 8787, state: "failed", error: "The tunnel could not reach Cloudflare’s edge" }] }),
};

/** /status for a scenario, as of now; `change` adjusts it further. */
const statusFor = (scenario, change) => {
  const base = fixture("status.json");
  const now = Date.now();
  const status = SCENARIOS[scenario](shiftTimes(base, now - base.storage.at), now);
  const mcp = fixture('mcp.json');
  if (scenario === 'setup') {
    Object.assign(mcp.shared, { present: false, count: 0, servers: [] });
    mcp.ownGroups = [];
    for (const row of mcp.providers) Object.assign(row, { linked: [], unlinked: [], diverged: [], disabled: [], own: [], ownCount: 0 });
  }
  if (scenario === 'attention') Object.assign(mcp.providers.find(p => p.provider === 'codex'), { error: 'Codex config.toml cannot be safely edited. Check its TOML syntax before changing MCP servers.', linked: [], unlinked: ['playwright', 'docs', 'database'] });
  status.context = { ...status.context, mcp };
  return change ? change(status, now) || status : status;
};
const portsFor = (scenario, change) => {
  const ports = (PORTS[scenario] || PORTS.ready)(fixture("ports.json"), Date.now());
  return change ? change(ports, Date.now()) || ports : ports;
};

/**
 * Answer the console's data requests on `page` from the fixtures: every POST
 * is accepted here and none reaches the server.
 */
const routeConsole = async (page, { status, ports, skillOptions, downloadHTTP = false }) => {
  const skills = require('./skills-fixtures.cjs').createSkillsFixtures(skillOptions);
  const mcp = require('./mcp-fixtures.cjs').createMcpFixtures(status().context?.mcp);
  const files = require('./files-fixtures.cjs').createFilesFixtures();
  await page.route(downloadHTTP ? url => !url.pathname.endsWith('/files/zip') : "**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const at = (suffix) => url.pathname.endsWith(suffix);
    const fileResponse = await files.respond(request.method(), url, request.method() === 'POST' ? (url.pathname.endsWith('/files/upload/chunk')?request.postDataBuffer():request.postDataJSON()) : undefined);
    if (fileResponse) return route.fulfill({ status: fileResponse.status || 200, ...(fileResponse.raw ? { body: fileResponse.raw, headers: fileResponse.headers } : { json: fileResponse.body }) });
    const mcpResponse = await mcp.respond(request.method(), url, request.method() === 'POST' ? (url.pathname.endsWith('/files/upload/chunk')?request.postDataBuffer():request.postDataJSON()) : undefined);
    if (mcpResponse) return route.fulfill({ status: mcpResponse.status, json: mcpResponse.body });
    const skillResponse = skills.respond(request.method(), url, request.method() === 'POST' ? (url.pathname.endsWith('/files/upload/chunk')?request.postDataBuffer():request.postDataJSON()) : undefined);
    if (skillResponse) return route.fulfill({ status: skillResponse.status, json: skillResponse.body });
    if (request.method() === "POST" && !at("/login")) return route.fulfill({ json: { ok: true } });
    if (at("/status")) return route.fulfill({ json: status() });
    if (at("/ports")) return route.fulfill({ json: ports() });
    if (at("/providers")) return route.fulfill({ json: fixture("providers.json") });
    if (at("/credentials")) return route.fulfill({ json: fixture("credentials.json") });
    // Allow a native-shell substitution at the context level to run too.
    return route.fallback();
  });
};

/** The console in a frame on its own origin, as T3 Code's settings show it. */
const framed = async (page, url) => {
  const host = new URL("/__console-screens-host", url).href;
  await page.route(host, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style><iframe src="${url}"></iframe>`,
  }));
  await page.goto(host, { waitUntil: "domcontentloaded" });
  return (await page.waitForSelector("iframe")).contentFrame();
};

/** Unlock the console with its key and wait for the first page. */
const unlock = async (target, key) => {
  if (await target.locator('#app').count()) return; // fixture preview has no login
  await target.waitForSelector("input[type=password]");
  await target.fill("input[type=password]", key);
  await target.click("button[type=submit]");
  await target.waitForSelector("#page-overview .tc-page-head", { timeout: 30000 });
};

/** Go to a page (or a page's tab, "instructions/skills") and let its data land. */
const visit = async (target, page, route) => {
  await target.evaluate((r) => { location.hash = r; window.scrollTo(0, 0); }, route);
  await target.waitForSelector(`#page-${route.split("/")[0]}:not([hidden]) .tc-page-head`, { timeout: 30000, state: "attached" });
  await target.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(route === "instructions/skills" ? 1200 : 400);
};

module.exports = { FIXTURES, fixture, routesTable, shiftTimes, SCENARIOS, PORTS, statusFor, portsFor, routeConsole, framed, unlock, visit };
