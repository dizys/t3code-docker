import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPluginInventory } from "../docker/setup/plugins/inventory.mjs";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-plugin-inv-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const put = async (relative, content) => {
    const file = path.join(home, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };
  const putJson = (relative, value) => put(relative, JSON.stringify(value, null, 2));
  return { home, env: {}, put, putJson };
}

const manifest = (name, extra = {}) => JSON.stringify({ name, description: `${name} plugin`, version: "1.0.0", ...extra }, null, 2);

test("inventory lists every manifest format variant with format retained", async (t) => {
  const f = await fixture(t);
  await f.put(".codex/plugins/root-manifest/plugin.json", manifest("codex-root"));
  await f.put(".codex/plugins/overlay/.codex-plugin/plugin.json", manifest("codex-overlay"));
  await f.put(".claude/plugins/cache/market-a/claude-one/.claude-plugin/plugin.json", manifest("claude-one"));
  await f.put(".cursor/plugins/cursor-one/.cursor-plugin/plugin.json", manifest("cursor-one"));
  await f.put(".cursor/plugins/local/cursor-local/plugin.json", manifest("cursor-local"));
  await f.put(".grok/plugins/grok-one/plugin.json", manifest("grok-one"));
  await f.put(".gemini/config/plugins/agy-one/.antigravity-plugin/plugin.json", manifest("agy-one"));
  const inventory = createPluginInventory(f);
  const listed = await inventory.list();
  assert.equal(listed.ok, true);
  assert.equal(listed.providers.length, 8);
  const byName = new Map(listed.plugins.map((plugin) => [plugin.name, plugin]));
  for (const name of ["codex-root", "codex-overlay", "claude-one", "cursor-one", "cursor-local", "grok-one", "agy-one"]) {
    assert.ok(byName.has(name), `missing ${name}`);
  }
  assert.equal(byName.get("codex-root").format, "plugin.json");
  assert.equal(byName.get("codex-overlay").format, ".codex-plugin/plugin.json");
  assert.equal(byName.get("claude-one").format, ".claude-plugin/plugin.json");
  assert.equal(byName.get("cursor-one").format, ".cursor-plugin/plugin.json");
  assert.equal(byName.get("agy-one").format, ".antigravity-plugin/plugin.json");
  assert.ok(byName.get("codex-root").manifestPath.endsWith("plugin.json"));
  for (const plugin of listed.plugins) {
    assert.equal(plugin.scope, "user");
    assert.equal(plugin.coverage, "filesystem");
    assert.match(plugin.id, /^[a-f0-9]{32}$/);
    assert.match(plugin.revision, /^[a-f0-9]{64}$/);
    assert.ok(plugin.readOnlyReason);
  }
});

test("tools-only plugin without skills is inventoried with hook and mcp components", async (t) => {
  const f = await fixture(t);
  await f.put(".codex/plugins/toolbox/plugin.json", manifest("toolbox"));
  await f.put(".codex/plugins/toolbox/hooks/on-start.sh", "#!/bin/sh\nexit 0\n");
  await f.put(".codex/plugins/toolbox/mcp.json", JSON.stringify({ mcpServers: {} }));
  const inventory = createPluginInventory(f);
  const listed = await inventory.list({ provider: "codex" });
  assert.equal(listed.plugins.length, 1);
  const [plugin] = listed.plugins;
  const types = plugin.components.map((component) => component.type).sort();
  assert.ok(types.includes("hook"));
  assert.ok(types.includes("mcp"));
  assert.ok(!types.includes("skill"));
  for (const component of plugin.components) {
    assert.ok(!path.isAbsolute(component.path));
    assert.ok(!component.path.startsWith(".."));
  }
});

test("same plugin name from two sources gets distinct stable IDs", async (t) => {
  const f = await fixture(t);
  await f.put(".codex/plugins/dup-a/plugin.json", manifest("dup"));
  await f.put(".cursor/plugins/dup-b/plugin.json", manifest("dup"));
  const inventory = createPluginInventory(f);
  const listed = await inventory.list();
  const dups = listed.plugins.filter((plugin) => plugin.name === "dup");
  assert.equal(dups.length, 2);
  assert.notEqual(dups[0].id, dups[1].id);
  assert.notEqual(dups[0].path, dups[1].path);
  const again = await inventory.list();
  const ids = new Set(again.plugins.map((plugin) => plugin.id));
  assert.equal(ids.size, again.plugins.length);
  for (const plugin of dups) {
    const reread = await inventory.read(plugin.id);
    assert.equal(reread.plugin.id, plugin.id);
  }
});

test("malformed claude registry is a partial inventory with warnings, not empty success", async (t) => {
  const f = await fixture(t);
  await f.put(".claude/plugins/installed_plugins.json", "{ not json,,,");
  await f.put(".claude/plugins/cache/market-a/orphan/.claude-plugin/plugin.json", manifest("orphan"));
  const inventory = createPluginInventory(f);
  const listed = await inventory.list({ provider: "claude" });
  assert.equal(listed.ok, true);
  assert.equal(listed.providers[0].coverage, "partial");
  assert.ok(listed.providers[0].warnings.length > 0);
  assert.ok(listed.warnings.length > 0);
  assert.ok(listed.plugins.some((plugin) => plugin.name === "orphan"));
});

test("symlink escaping home is skipped and directory bounds are reported", async (t) => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "t3-plugin-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "plugin.json"), manifest("escaped"));
  await fs.mkdir(path.join(f.home, ".codex/plugins"), { recursive: true });
  await fs.symlink(outside, path.join(f.home, ".codex/plugins/evil"));
  await f.put(".codex/plugins/good/plugin.json", manifest("good"));
  const inventory = createPluginInventory(f);
  const listed = await inventory.list({ provider: "codex" });
  assert.ok(listed.plugins.some((plugin) => plugin.name === "good"));
  assert.ok(!listed.plugins.some((plugin) => plugin.name === "escaped"));
  assert.ok(listed.warnings.some((warning) => warning.includes("outside the home directory")));
});

test("sentinel executable code never runs during list and read", async (t) => {
  const f = await fixture(t);
  const sentinel = path.join(f.home, "pwned-by-plugin");
  await f.put(".codex/plugins/sneaky/plugin.json", manifest("sneaky", { scripts: { postinstall: `touch ${sentinel}` } }));
  await f.put(".codex/plugins/sneaky/hooks/run.sh", `#!/bin/sh\ntouch ${sentinel}\n`);
  const inventory = createPluginInventory(f);
  const listed = await inventory.list({ provider: "codex" });
  const plugin = listed.plugins.find((entry) => entry.name === "sneaky");
  assert.ok(plugin);
  assert.ok(plugin.components.some((component) => component.type === "hook"));
  await inventory.read(plugin.id);
  await assert.rejects(fs.stat(sentinel), { code: "ENOENT" });
  assert.ok(listed.warnings.some((warning) => warning.includes("sneaky")));
});

test("fake secrets in configs never appear in the public response", async (t) => {
  const f = await fixture(t);
  const secret = `sk-fake-${"x".repeat(16)}-never-emit`;
  await f.put(".config/opencode/opencode.json", JSON.stringify({ plugins: ["./local-one", "some-registry-plugin"], apiKey: secret }));
  await f.put(".config/opencode/plugins/local-one/package.json", JSON.stringify({ name: "local-one", version: "2.0.0" }));
  await f.put(".pi/agent/settings.json", JSON.stringify({ packages: ["fake-package"], token: secret }));
  await f.put(".pi/agent/packages/fake-package/package.json", JSON.stringify({ name: "fake-package", description: "d", pi: { extensions: ["ext"] } }));
  const inventory = createPluginInventory({ ...f, env: { XDG_CONFIG_HOME: ".config" } });
  const listed = await inventory.list();
  const serialized = JSON.stringify(listed);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes("apiKey"));
  assert.ok(listed.plugins.some((plugin) => plugin.name === "local-one"));
  const detailed = await inventory.read(listed.plugins.find((plugin) => plugin.name === "local-one").id);
  assert.ok(!JSON.stringify(detailed).includes(secret));
  assert.ok(listed.warnings.some((warning) => warning.includes("remote or registry specs")));
});

test("home overrides are respected like skills and adapters", async (t) => {
  const f = await fixture(t);
  const env = { CODEX_HOME: ".codex-alt", CLAUDE_CONFIG_DIR: ".claude-alt", GROK_HOME: ".grok-alt", XDG_CONFIG_HOME: ".cfg" };
  await f.put(".codex-alt/plugins/alt-codex/plugin.json", manifest("alt-codex"));
  await f.put(".codex/plugins/ignored/plugin.json", manifest("ignored"));
  await f.put(".cfg/opencode/plugins/alt-open/plugin.json", manifest("alt-open"));
  const inventory = createPluginInventory({ home: f.home, env });
  const codex = await inventory.list({ provider: "codex" });
  assert.ok(codex.plugins.some((plugin) => plugin.name === "alt-codex"));
  assert.ok(!codex.plugins.some((plugin) => plugin.name === "ignored"));
  const opencode = await inventory.list({ provider: "opencode" });
  assert.ok(opencode.plugins.some((plugin) => plugin.name === "alt-open"));
});

test("plugin count bound is reported instead of silently truncating", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.home, ".grok/plugins"), { recursive: true });
  for (let index = 0; index < 135; index++) {
    await f.put(`.grok/plugins/bulk-${String(index).padStart(3, "0")}/plugin.json`, manifest(`bulk-${index}`));
  }
  const inventory = createPluginInventory(f);
  const listed = await inventory.list({ provider: "grok" });
  assert.equal(listed.plugins.length, 128);
  assert.ok(listed.warnings.some((warning) => warning.includes("limit of 128 plugins")));
});

test("muse is explicitly unsupported and read validates identifiers", async (t) => {
  const f = await fixture(t);
  const inventory = createPluginInventory(f);
  const listed = await inventory.list({ provider: "muse" });
  assert.equal(listed.providers[0].coverage, "unavailable");
  assert.ok(listed.providers[0].unsupportedReason);
  assert.equal(listed.plugins.length, 0);
  await assert.rejects(inventory.read("not-an-id"), { code: "invalid" });
  await assert.rejects(inventory.read("0".repeat(32)), { code: "missing" });
  await assert.rejects(inventory.list({ provider: "nope" }), { code: "invalid" });
});

test("opencode v1 plugin key and pi declarations stay filesystem-only", async (t) => {
  const f = await fixture(t);
  await f.put(".config/opencode/opencode.json", JSON.stringify({ plugin: ["./legacy-one"] }));
  await f.put(".config/opencode/plugins/legacy-one/package.json", JSON.stringify({ name: "legacy-one", version: "0.1.0", description: "legacy" }));
  const inventory = createPluginInventory({ ...f, env: { XDG_CONFIG_HOME: ".config" } });
  const listed = await inventory.list({ provider: "opencode" });
  const plugin = listed.plugins.find((entry) => entry.name === "legacy-one");
  assert.ok(plugin);
  assert.equal(plugin.format, "package.json");
  assert.equal(plugin.enabled, null);
});

test('OpenCode JSONC supports trailing commas and v2 package objects without execution',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'t3-plugin-jsonc-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const root=path.join(home,'.config/opencode'),pkg=path.join(root,'local');
 await fs.mkdir(pkg,{recursive:true});await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'local-jsonc',version:'1.0.0'}));
 await fs.writeFile(path.join(root,'opencode.jsonc'),'{ // a real JSONC config\n "plugins": [{"package":"./local", "options":{},},],\n}');
 const result=await createPluginInventory({home,env:{}}).list({provider:'opencode'});
 assert(result.plugins.some(p=>p.name==='local-jsonc'));assert.equal(result.providers[0].coverage,'filesystem');
});
