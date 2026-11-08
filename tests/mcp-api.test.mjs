// Check the authenticated MCP HTTP boundary in a disposable agent home.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("shared MCP API creates, links and removes servers without leaking secrets", { timeout: 20000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-mcp-api-"));
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../docker/setup/server.mjs", import.meta.url))], { env: {
    ...process.env, HOME: home, T3CODE_HOME: path.join(home, ".t3"), T3_WORKSPACE: path.join(root, "workspace"),
    CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), XDG_CONFIG_HOME: path.join(home, ".config"),
    MISE_DATA_DIR: path.join(home, ".local/share/mise"), MISE_STATE_DIR: path.join(home, ".local/state/mise"),
    MISE_CONFIG_DIR: path.join(home, ".config/mise"), T3_SETUP_PORT: String(port), T3_SETUP_KEY: "mcp-fixture-key",
    T3_SETUP_KEY_SOURCE: "env", T3_INFRA_LAUNCHER: "/bin/false", T3CODE_PORT: "1",
  }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    // Match the other API fixtures: native probes may be draining work after
    // the setup process exits, so cleanup retries are bounded.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const base = `http://127.0.0.1:${port}/__setup`;
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/hello")).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(ready, logs);
  const get = (route) => fetch(base + route, { headers: { "x-t3-setup-key": "mcp-fixture-key" } });
  const post = (route, body, headers = {}) => fetch(base + route, { method: "POST", headers: { "x-t3-setup-key": "mcp-fixture-key", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + "/context/mcp")).status, 401);
  const embeddedPage = await (await get('/?embed=t3')).text();
  assert.match(embeddedPage, /<html lang="en" data-embed="t3">/);
  assert.match(await (await get('/?embed=1')).text(), /<html lang="en">/);
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ key: 'mcp-fixture-key', embed: 't3' }) });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/__setup/?embed=t3', 'Unlocking must retain T3 embedding for the MCP close action');
  assert.equal((await post("/context/mcp/create", { server: { name: "x", type: "local", command: ["x"] } }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("/context/mcp/create", { server: { name: "Bad Name", type: "local", command: ["x"] } })).status, 400);
  assert.equal((await post("/context/mcp/create", null)).status, 400);

  const created = await (await post("/context/mcp/create", { server: { name: "playwright", type: "local", command: ["playwright-mcp", "--headless"], env: { TOKEN: "secret" } } })).json();
  assert.equal(created.ok, true);
  const status = await (await get("/status")).json();
  assert.equal(status.context.mcp.shared.count, 1);
  assert.equal(JSON.stringify(status).includes('"secret"'), false);
  assert.deepEqual(status.context.mcp.providers.find((row) => row.provider === "codex").linked, []);
  assert.equal(status.context.mcp.providers.find((row) => row.provider === "grok").supported, true);

  const read = await (await get("/context/mcp/read?name=playwright")).json();
  assert.equal(read.server.env.TOKEN, "secret");
  assert.equal((await get("/context/mcp/read")).status, 400);
  assert.equal((await get("/context/mcp/read?name=missing")).status, 404);
  assert.equal((await get("/context/mcp?provider=nope")).status, 400);
  assert.equal((await get("/context/mcp?provider=grok")).status, 200);

  const providerRevision = (provider) => get('/context/mcp?provider=' + provider).then(r => r.json()).then(r => r.revision);
  const link = await post("/context/mcp/link", { provider: "codex", name: "playwright", linked: true, sharedRevision: created.revision, providerRevision: await providerRevision('codex') });
  assert.equal(link.status, 200);
  assert.match(await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8"), /playwright-mcp/);
  const codex = await (await get("/context/mcp?provider=codex")).json();
  assert.equal(codex.shared[0].linked, true);
  assert.equal((await post("/context/mcp/link", { provider: "codex", name: "playwright", linked: true, sharedRevision: "stale", providerRevision: await providerRevision('codex') })).status, 409);
  assert.equal((await post("/context/mcp/link", { provider: "codex", name: "playwright", linked: false, sharedRevision: created.revision })).status, 400);
  const unlink = await post("/context/mcp/link", { provider: "claude", name: "playwright", linked: false, sharedRevision: created.revision, providerRevision: await providerRevision('claude') });
  assert.equal(unlink.status, 200);
  assert.equal((await post("/context/mcp/link", { provider: "grok", name: "playwright", linked: true, sharedRevision: created.revision, providerRevision: 'unused' })).status, 409);

  const saved = await post("/context/mcp/save", { name: "playwright", revision: "stale", server: { name: "playwright", type: "local", command: ["other"], env: {} } });
  assert.equal(saved.status, 409);
  assert.equal((await post("/context/mcp/remove", { name: "playwright", revision: created.revision })).status, 409);
  assert.equal((await post("/context/mcp/link", { provider: "codex", name: "playwright", linked: false, sharedRevision: created.revision, providerRevision: await providerRevision('codex') })).status, 200);
  const removed = await post("/context/mcp/remove", { name: "playwright", revision: created.revision });
  assert.equal(removed.status, 200);
  assert.equal((await get("/context/mcp/read?name=playwright")).status, 404);
  const malformed = await fetch(base + '/context/mcp/create', { method: 'POST', headers: { 'x-t3-setup-key': 'mcp-fixture-key', 'content-type': 'application/json' }, body: '{\"server\":{\"env\":{\"TOKEN\":\"fixture-secret-malformed\"' });
  assert.equal(malformed.status, 400); assert.equal((await malformed.text()).includes('fixture-secret-malformed'), false);
  const parsed = await (await post('/context/mcp/parse', { text: 'uvx mcp-server-fetch' })).json();
  assert.equal(parsed.servers[0].name, 'fetch');
  assert.equal((await post('/context/mcp/parse', { text: 'x'.repeat(65537) })).status, 413);
  assert.equal((await post('/context/mcp/parse', { text: 123 })).status, 400);
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude/.claude.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.test/mcp', headers: { Authorization: 'fixture-private-header' }, timeout: 10 } } }));
  const own = await (await get('/context/mcp?refresh=1')).json();
  assert.equal(own.ownGroups[0].name, 'docs');
  assert.equal(JSON.stringify(own).includes('fixture-private-header'), false);
  const claude = own.providers.find(p => p.provider === 'claude');
  assert.equal((await fetch(base + '/context/mcp/read?provider=claude&name=docs')).status, 401);
  assert.equal((await fetch(base + '/context/mcp/diff?provider=claude&name=docs')).status, 401);
  assert.equal((await post('/context/mcp/adopt', { provider: 'claude', name: 'docs', providerRevision: 'stale', sharedRevision: own.shared.revision })).status, 409);
  const adopted = await (await post('/context/mcp/adopt', { provider: 'claude', name: 'docs', providerRevision: claude.revision, sharedRevision: own.shared.revision })).json();
  assert.deepEqual(adopted.dropped, ['timeout']);
  const diff = await (await get('/context/mcp/diff?provider=claude&name=docs')).json();
  assert.equal(diff.adoptable, true); assert.equal(JSON.stringify(diff).includes('fixture-private-header'), false);
  const agentRead = await (await get('/context/mcp/read?provider=claude&name=docs')).json();
  assert.equal(agentRead.server.headers.Authorization, 'fixture-private-header');
  assert.equal((await post('/context/mcp/link', { provider: 'claude', name: 'docs', linked: true, enabled: false, providerRevision: claude.revision, sharedRevision: adopted.revision })).status, 403);

});
