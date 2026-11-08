// Shared MCP servers: store validation, TOML preservation, provider
// translation and link-state derivation.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { validateMcpServer, readMcpStore, createMcpServer, saveMcpServer, removeMcpServer, redactMcpServer, mcpRevision } from "../docker/setup/mcp/store.mjs";
import { parseMcpToml, applyMcpToml } from "../docker/setup/mcp/toml.mjs";
import { toClaudeEntry, fromClaudeEntry, toCodexEntry, fromCodexEntry, toOpenCodeEntry, fromOpenCodeEntry, toCursorEntry, fromCursorEntry, readProviderMcp, writeProviderMcpEntry } from "../docker/setup/mcp/adapters.mjs";
import { createMcpService } from "../docker/setup/mcp.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "t3-mcp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, home: path.join(root, "home"), baseDir: path.join(root, ".t3") };
}
const svcFor = (f, extraEnv = {}) => createMcpService({ home: f.home, env: { HOME: f.home, ...extraEnv }, io: fs, baseDir: f.baseDir });

test("validation rejects bad names, commands, urls and secrets", () => {
  assert.equal(validateMcpServer(null).ok, false);
  assert.equal(validateMcpServer({ name: "Bad Name", type: "local", command: ["x"] }).ok, false);
  assert.equal(validateMcpServer({ name: "ok", type: "local", command: [] }).ok, false);
  assert.equal(validateMcpServer({ name: "ok", type: "local", command: ["x"], env: { "bad-key": "v" } }).ok, false);
  assert.equal(validateMcpServer({ name: "ok", type: "remote", url: "ftp://x" }).ok, false);
  assert.equal(validateMcpServer({ name: "ok", type: "remote", url: "https://x", headers: { bad: "a\nb" } }).ok, false);
  const local = validateMcpServer({ name: "playwright", type: "local", command: ["playwright-mcp", "--headless"], env: { A: "1" } });
  assert.equal(local.ok, true);
  assert.deepEqual(local.server, { name: "playwright", type: "local", enabled: true, command: ["playwright-mcp", "--headless"], env: { A: "1" } });
  const remote = validateMcpServer({ name: "notion", type: "remote", url: "https://mcp.notion.com/mcp", enabled: false });
  assert.equal(remote.ok, true);
  assert.deepEqual(remote.server.headers, {});
});

test("the shared store round-trips with revisions and conflicts", async (t) => {
  const f = await fixture(t);
  const svc = svcFor(f);
  assert.equal((await svc.status()).shared.present, false);
  const created = await svc.create({ name: "playwright", type: "local", command: ["playwright-mcp"], env: {} });
  assert.equal(created.ok, true);
  await assert.rejects(svc.create({ name: "playwright", type: "local", command: ["other"], env: {} }), { code: "conflict" });
  const read = await svc.read("playwright");
  assert.deepEqual(read.server.command, ["playwright-mcp"]);
  const saved = await svc.save("playwright", read.revision, { name: "playwright", type: "local", command: ["playwright-mcp", "--headless"], env: {} });
  assert.equal(saved.ok, true);
  await assert.rejects(svc.save("playwright", read.revision, { name: "playwright", type: "local", command: ["stale"], env: {} }), { code: "conflict" });
  await assert.rejects(svc.remove("playwright", "stale"), { code: "conflict" });
  assert.equal((await svc.remove("playwright", saved.revision)).ok, true);
  assert.equal((await svc.status({ refresh: true })).shared.present, false);
  await assert.rejects(svc.read("playwright"), { code: "missing" });
});

test("status never carries secrets", async (t) => {
  const f = await fixture(t);
  const svc = svcFor(f);
  await svc.create({ name: "db", type: "remote", url: "https://db.example/mcp", headers: { Authorization: "Bearer secret" } });
  const status = await svc.status({ refresh: true });
  assert.equal(JSON.stringify(status).includes("Bearer secret"), false);
  assert.equal(status.shared.servers[0].secretCount, 1);
  assert.deepEqual(status.shared.servers[0].headerKeys, ["Authorization"]);
  const redacted = redactMcpServer({ name: "db", type: "remote", enabled: true, url: "https://db.example/mcp", headers: { Authorization: "Bearer secret" } });
  assert.equal(redacted.headers, undefined);
  assert.equal(redacted.headerCount, 1);
});

test("codex TOML edits preserve unrelated sections", () => {
  const original = '# comment\nmodel = "o4-mini"\n\n[mcp_servers.playwright]\ncommand = "playwright-mcp"\nargs = ["--headless"]\n\n[other]\nkey = 1\n';
  const parsed = parseMcpToml(original);
  assert.deepEqual(parsed.get("playwright"), { command: "playwright-mcp", args: ["--headless"] });
  const updated = applyMcpToml(original, "notion", { url: "https://mcp.notion.com/mcp", enabled: false });
  assert.match(updated, /model = "o4-mini"/);
  assert.match(updated, /\[mcp_servers\.playwright\]/);
  assert.deepEqual(parseMcpToml(updated).get("notion"), { url: "https://mcp.notion.com/mcp", enabled: false });
  assert.match(updated, /\[other\]/);
  const removed = applyMcpToml(updated, "notion", null);
  assert.doesNotMatch(removed, /notion/);
  assert.match(removed, /playwright-mcp/);
  assert.throws(() => parseMcpToml("[mcp_servers.a]\ncommand = 1\n[mcp_servers.a]\ncommand = 2\n"), /safely edited/);
});

test("every supported provider translates a local and a remote server", () => {
  const local = { name: "playwright", type: "local", enabled: true, command: ["playwright-mcp", "--headless"], env: { FOO: "bar" } };
  const remote = { name: "notion", type: "remote", enabled: true, url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer x" } };
  assert.deepEqual(toClaudeEntry(local), { command: "playwright-mcp", args: ["--headless"], env: { FOO: "bar" } });
  assert.deepEqual(fromClaudeEntry("playwright", toClaudeEntry(local)), local);
  assert.deepEqual(fromClaudeEntry("notion", toClaudeEntry(remote)), remote);
  assert.deepEqual(toCodexEntry(remote), { url: "https://mcp.notion.com/mcp", http_headers: { Authorization: "Bearer x" } });
  assert.deepEqual(fromCodexEntry("notion", toCodexEntry(remote)), remote);
  assert.deepEqual(toOpenCodeEntry(local), { type: "local", command: ["playwright-mcp", "--headless"], environment: { FOO: "bar" }, enabled: true });
  assert.deepEqual(fromOpenCodeEntry("playwright", toOpenCodeEntry(local)), local);
  assert.deepEqual(fromOpenCodeEntry("notion", toOpenCodeEntry(remote)), remote);
  assert.deepEqual(toCursorEntry(local), toClaudeEntry(local));
  assert.deepEqual(fromCursorEntry("playwright", toCursorEntry(local)), local);
  assert.equal(fromClaudeEntry("x", { nonsense: true }), null);
});

test("links write provider files and derive state by comparison", async (t) => {
  const f = await fixture(t);
  const svc = svcFor(f, { CODEX_HOME: path.join(f.home, ".codex"), XDG_CONFIG_HOME: path.join(f.home, ".config") });
  const created = await svc.create({ name: "playwright", type: "local", command: ["playwright-mcp", "--headless"], env: {} });
  const revision = created.revision;
  for (const provider of ["claude", "codex", "opencode", "cursor"]) {
    await svc.setLink(provider, "playwright", true, revision);
  }
  const status = await svc.status({ refresh: true });
  for (const provider of ["claude", "codex", "opencode", "cursor"]) {
    const row = status.providers.find((entry) => entry.provider === provider);
    assert.deepEqual(row.linked, ["playwright"], provider);
    assert.deepEqual(row.diverged, [], provider);
  }
  // A provider-side edit shows as diverged, not linked.
  await svc.setLink("claude", "playwright", false, revision);
  const unlinked = (await svc.status({ refresh: true })).providers.find((entry) => entry.provider === "claude");
  assert.deepEqual(unlinked.linked, []);
  assert.deepEqual(unlinked.unlinked, ["playwright"]);
  const grok = (await svc.status()).providers.find((entry) => entry.provider === "grok");
  assert.equal(grok.supported, true);
  assert.equal(grok.error, null);
});

test("legacy disabled definitions allow each agent to choose its own state", async (t) => {
  const f = await fixture(t);
  const svc = svcFor(f);
  const created = await svc.create({ name: "quiet", type: "local", enabled: false, command: ["cmd"], env: {} });
  await svc.setLink("codex", "quiet", true, created.revision);
  await svc.setLink("opencode", "quiet", true, created.revision);
  assert.equal((await svc.list("codex")).shared[0].linked, true);
  await svc.setLink("claude", "quiet", true, created.revision);
  assert.equal((await svc.list("claude")).shared[0].linked, true);
  await assert.rejects(svc.setLink("claude", "quiet", true, created.revision, undefined, false), { code: "unsupported" });
  await svc.setLink("grok", "quiet", true, created.revision);
  assert.deepEqual((await svc.list("grok")).disabled, ["quiet"]);
});

test("unsupported and unknown MCP shapes stay in place with a warning", async (t) => {
  const f = await fixture(t);
  const svc = svcFor(f);
  await svc.create({ name: "playwright", type: "local", command: ["playwright-mcp"], env: {} });
  await fs.mkdir(path.join(f.home, ".codex"), { recursive: true });
  await fs.writeFile(path.join(f.home, ".codex", "config.toml"), '[mcp_servers.weird]\nstartup_timeout_ms = 5\n');
  const status = await svc.status({ refresh: true });
  const codex = status.providers.find((entry) => entry.provider === "codex");
  assert.match(codex.warning ?? "", /unsupported shape/);
  assert.deepEqual(codex.own, [{ name: "weird", recognized: false, extra: ["startup_timeout_ms"] }]);
  const list = await svc.list("codex");
  assert.deepEqual(list.unsupported, ["weird"]);
  await assert.rejects(svc.list("nope"), { code: "invalid" });
  await assert.rejects(writeProviderMcpEntry(fs, "codex", { home: f.home, env: {} }, "Bad Name", {}), /Invalid MCP server name/);
});

test("provider files preserve unrelated keys and survive JSONC", async (t) => {
  const f = await fixture(t);
  const env = { HOME: f.home, XDG_CONFIG_HOME: path.join(f.home, ".config"), OPENCODE_CONFIG_DIR: path.join(f.home, ".config", "opencode") };
  await fs.mkdir(path.join(f.home, ".config", "opencode"), { recursive: true });
  await fs.writeFile(path.join(f.home, ".config", "opencode", "opencode.jsonc"), '{\n// comment\n"theme": "dark"\n}\n');
  const svc = createMcpService({ home: f.home, env, io: fs, baseDir: f.baseDir });
  const created = await svc.create({ name: "playwright", type: "local", command: ["playwright-mcp"], env: {} });
  await svc.setLink("opencode", "playwright", true, created.revision);
  const raw = await fs.readFile(path.join(f.home, ".config", "opencode", "opencode.jsonc"), "utf8");
  assert.match(raw, /comment/);
  assert.match(raw, /"theme": "dark"/);
  assert.match(raw, /playwright/);
  const read = await readProviderMcp(fs, "opencode", { home: f.home, env });
  assert.equal(read.servers.find((row) => row.name === "playwright").canonical.command[0], "playwright-mcp");
});

const ctx = vm.createContext({ URL });
vm.runInContext(`${readFileSync(new URL("../docker/setup/client/model.js", import.meta.url), "utf8")}\nthis.M = T3Model;`, ctx);
const M = ctx.M;

test("MCP view model reports shared counts and read errors", () => {
  assert.equal(M.mcpView({context:{mcp:{shared:{servers:[{},{}]}}}}).count, 2);
  assert.equal(M.mcpView({context:{mcp:{ok:false,shared:{error:"Cannot read store"}}}}).error, "Cannot read store");
  assert.equal(M.mcpView({}).count, 0);
});
