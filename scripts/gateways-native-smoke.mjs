#!/usr/bin/env node
// A gateway's real settings -> the real agent -> a fixture gateway. No sign-in,
// no network and no model is involved, and every file is in a disposable home.
//
//   node scripts/gateways-native-smoke.mjs claude /absolute/path/to/claude
//
// The adapters rest on how each agent behaves, and an update can change that:
// what Claude Code does with settings.json, whether `-c` beats config.toml, how
// OpenCode layers a config file. Each assumption is checked here, against the
// exact instance the adapter produces.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

const setup = dir => new URL(`${dir}.mjs`, process.env.T3_SETUP_DIR || new URL("../docker/setup/", import.meta.url));
const { desiredInstance, fileText, filesFor, mergeInstance } = await import(setup("gateways/adapters"));
const { agentOf } = await import(setup("gateways/catalog"));
const { scanClaudeSettings } = await import(setup("gateways/conflicts"));
const { withNativeProcess } = await import(process.env.T3_NATIVE_PROCESS_MODULE || new URL("../docker/harness/native-process.mjs", import.meta.url));

const [agentId, executable] = process.argv.slice(2);
assert.ok(["claude", "codex", "opencode"].includes(agentId) && path.isAbsolute(executable || ""), "Pass an agent and the absolute path to it.");
const agent = agentOf(agentId), KEY = "sk-smoke-gateway", MODELS = ["claude-smoke-opus", "claude-haiku-5-5", "gpt-smoke-codex", "smoke-model"];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gateway-native-"));
const home = path.join(root, "home"), work = path.join(home, "work"), files = path.join(root, "files");
await fs.mkdir(work, { recursive: true });
let ids = 0;

/** Records what arrives. Each reply has fresh ids, since agents drop repeats. */
const gatewayServer = async () => {
  const requests = [];
  const sse = (response, events) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [event, data] of events) response.write(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    response.end();
  };
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      const url = new URL(request.url, "http://fixture"), body = text ? JSON.parse(text) : {}, id = `fixture_${++ids}`;
      requests.push({ method: request.method, path: url.pathname, authorization: request.headers.authorization, apiKey: request.headers["x-api-key"], model: body.model });
      if (url.pathname.endsWith("/models")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: MODELS.map(model => ({ id: model, type: "model", display_name: model, created_at: "2026-01-01T00:00:00Z" })), has_more: false })); return; }
      if (url.pathname.endsWith("/messages")) {
        const message = { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ...message, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })); return; }
        sse(response, [["message_start", { type: "message_start", message }], ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }], ["content_block_stop", { type: "content_block_stop", index: 0 }], ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }], ["message_stop", { type: "message_stop" }]]);
        return;
      }
      if (url.pathname.endsWith("/responses")) {
        const item = { type: "message", id: `item_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
        sse(response, [["response.created", { type: "response.created", response: { id } }], ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }], ["response.completed", { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]]);
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
};

const gatewayFor = url => ({ id: "smoke", name: "Smoke", url, accent: "#6366f1", models: { ids: MODELS, manual: [] }, agents: { [agentId]: { on: true } } });
const instanceFor = gateway => mergeInstance(agent, desiredInstance(agent, gateway, { dir: files }), undefined, { key: KEY });
const processEnv = (instance, more = {}) => ({ HOME: home, PATH: process.env.PATH, ...Object.fromEntries(instance.environment.map(row => [row.name, row.value])), ...more });
// T3's tokenizer: single quotes are literal.
const tokenize = text => [...String(text).matchAll(/'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2]);
const posts = gateway => gateway.requests.filter(request => request.method === "POST");

const runClaude = async (env, stdin = "") => new Promise((resolve, reject) => {
  const child = spawn(executable, ["-p", "reply ok", "--model", "claude-smoke-opus", "--output-format", "json"], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Claude Code did not finish.")); }, 45_000);
  child.once("error", reject);
  child.once("close", () => { clearTimeout(timer); resolve(output); });
  child.stdin.end(stdin);
});

const smokes = {
  async claude() {
    const gateway = await gatewayServer(), elsewhere = await gatewayServer(), settings = path.join(home, ".claude", "settings.json");
    try {
      const env = processEnv(instanceFor(gatewayFor(gateway.url)));
      await fs.mkdir(path.dirname(settings), { recursive: true });
      // A cached sign-in in the shared home must not win over the gateway's key.
      await fs.writeFile(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-sign-in", refreshToken: "fixture", expiresAt: 9999999999999, scopes: ["user:inference"], subscriptionType: "max" } }));
      await runClaude(env);
      const [turn] = posts(gateway).filter(request => request.model === "claude-smoke-opus");
      assert.ok(turn, "the turn reached the gateway");
      assert.equal(turn.path, "/v1/messages");
      assert.equal(turn.authorization, `Bearer ${KEY}`, "the gateway's key beats a cached sign-in");
      assert.ok(!gateway.requests.some(request => request.method === "GET" && request.path === "/v1/models"), "model discovery stays off: a gateway's renamed models would show up as duplicates");
      // The conflict the page warns about: settings.json beats the process, and it's detected.
      await fs.writeFile(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: elsewhere.url } }));
      await runClaude(env);
      assert.ok(elsewhere.requests.length, "settings.json still overrides the environment, so the warning is still true");
      const found = await scanClaudeSettings({ io: fs, home, env: {} });
      assert.deepEqual(found?.keys, ["ANTHROPIC_BASE_URL"]);
    } finally { await Promise.all([gateway.close(), elsewhere.close()]); }
  },
  async codex() {
    const gateway = await gatewayServer(), elsewhere = await gatewayServer(), codexHome = path.join(home, ".codex"), instance = instanceFor(gatewayFor(gateway.url));
    await fs.mkdir(codexHome, { recursive: true });
    // Someone's own settings and sign-in, in the home the instance shares.
    await fs.writeFile(path.join(codexHome, "config.toml"), `model = "theirs"\nmodel_provider = "theirs"\n[model_providers.theirs]\nname = "Theirs"\nbase_url = "${elsewhere.url}/v1"\nwire_api = "responses"\n`);
    await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture-stored" }));
    const child = spawn(executable, ["app-server", ...tokenize(instance.config.launchArgs)], { cwd: work, env: processEnv(instance, { CODEX_HOME: codexHome }), stdio: ["pipe", "pipe", "ignore"] });
    try {
      let next = 1;
      const waiting = new Map(), notices = [];
      readline.createInterface({ input: child.stdout }).on("line", line => {
        const message = JSON.parse(line);
        if (message.id !== undefined && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); } else if (message.method) notices.push(message.method);
      });
      const call = (method, params) => new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, message => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result));
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        setTimeout(() => waiting.delete(id) && reject(new Error(`${method} timed out`)), 25_000).unref();
      });
      await call("initialize", { clientInfo: { name: "t3code", title: "t3code", version: "0" }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      assert.deepEqual((await call("account/read", {})).account, null, "a custom provider doesn't report the stored sign-in");
      assert.equal((await call("config/read", { includeLayers: false })).config.model_provider, "t3gw_smoke", "launch arguments beat config.toml");
      const { thread } = await call("thread/start", { cwd: work, model: "smoke-model", approvalPolicy: "never", sandbox: "read-only", experimentalRawEvents: false, persistExtendedHistory: false });
      await call("turn/start", { threadId: thread.id, input: [{ type: "text", text: "reply ok", text_elements: [] }] });
      for (let tries = 0; tries < 100 && !notices.includes("turn/completed"); tries++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(notices.includes("turn/completed"), "the turn finished");
      const [turn] = posts(gateway);
      assert.equal(turn?.path, "/v1/responses");
      assert.equal(turn.authorization, `Bearer ${KEY}`, "the key comes from the variable, not auth.json");
      assert.equal(turn.model, "smoke-model", "a model Codex doesn't know still runs");
      assert.equal(elsewhere.requests.length, 0, "nothing reached the provider in config.toml");
    } finally { child.kill("SIGKILL"); await Promise.all([gateway.close(), elsewhere.close()]); }
  },
  async opencode() {
    const gateway = gatewayFor("http://127.0.0.1:9"), paths = filesFor(agent, gateway, files), password = "fixture-password";
    await fs.mkdir(files, { recursive: true });
    await fs.writeFile(paths.config, fileText(agent, gateway, files));
    await fs.writeFile(paths.key, KEY, { mode: 0o600 });
    const env = processEnv(desiredInstance(agent, gateway, { dir: files }), { OPENCODE_SERVER_PASSWORD: password, OPENCODE_USERNAME: "opencode", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_CONFIG_CONTENT: "{}" });
    assert.equal(env.OPENCODE_CONFIG, paths.config);
    // The person's own config stays underneath.
    await fs.mkdir(path.join(home, ".config/opencode"), { recursive: true });
    await fs.writeFile(path.join(home, ".config/opencode/opencode.json"), JSON.stringify({ model: "theirs/model" }));
    // OpenCode 1 announces itself in a sentence and keeps its catalog elsewhere.
    const { stdout } = await promisify(execFile)(executable, ["--version"], { env });
    const legacy = /(?:^|\D)1\.\d+\.\d+/.test(stdout), port = ["--hostname", "127.0.0.1", "--port", "0"];
    await withNativeProcess({ executable, home: work, env, timeoutMs: 30_000 }, legacy ? ["serve", ...port] : ["serve", "--stdio", ...port], async ({ nextLine, signal }) => {
      const line = await nextLine(), url = new URL(legacy ? /https?:\/\/\S+/.exec(line)[0] : JSON.parse(line).url), location = `directory=${encodeURIComponent(work)}`;
      const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
      const read = async route => (await fetch(new URL(`${route}?${location}`, url), { headers, signal })).json();
      const catalog = legacy
        ? (await read("/config/providers")).providers.map(provider => ({ id: provider.id, models: Object.keys(provider.models) }))
        : [{ id: ((await read("/api/provider")).data ?? [])[0]?.id, models: ((await read("/api/model")).data ?? []).map(model => model.id) }];
      assert.deepEqual(catalog.map(provider => provider.id), ["t3gw-smoke"], "the catalog is narrowed to the gateway");
      assert.deepEqual(catalog[0].models.sort(), [...MODELS].sort());
    });
  },
};

try {
  await smokes[agentId]();
  console.log(`${agent.name}: a gateway works through its real settings.`);
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
