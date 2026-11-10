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
import { stripTypeScriptTypes } from "node:module";
import { promisify } from "node:util";

const setup = dir => new URL(`${dir}.mjs`, process.env.T3_SETUP_DIR || new URL("../docker/setup/", import.meta.url));
const { desiredInstance, fileText, filesFor, mergeInstance } = await import(setup("gateways/adapters"));
const { agentOf } = await import(setup("gateways/catalog"));
const { scanClaudeSettings } = await import(setup("gateways/conflicts"));
const { readCodexModels } = await import(setup("gateways/codex"));
const { withNativeProcess } = await import(process.env.T3_NATIVE_PROCESS_MODULE || new URL("../docker/harness/native-process.mjs", import.meta.url));

const [agentId, executable] = process.argv.slice(2);
assert.ok(["claude", "codex", "opencode", "pi", "grok"].includes(agentId) && path.isAbsolute(executable || ""), "Pass an agent and the absolute path to it.");
const agent = agentOf(agentId), KEY = "sk-smoke-gateway", MODELS = ["claude-smoke-opus", "claude-haiku-5-5", "gpt-smoke-codex", "grok-4.6", "smoke-model", "smoke-small", "gemini-smoke"];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gateway-native-"));
const home = path.join(root, "home"), work = path.join(home, "work"), files = path.join(root, "gateway files");
await fs.mkdir(work, { recursive: true });
let ids = 0;

/** Records what arrives. Each reply has fresh ids, since agents drop repeats. */
const gatewayServer = async () => {
  const requests = [], usageInputs = [];
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
      requests.push({ method: request.method, path: url.pathname, authorization: request.headers.authorization, apiKey: request.headers["x-api-key"], model: body.model, reasoningEffort: body.reasoning_effort ?? body.reasoning?.effort,
        compaction: /CONTEXT CHECKPOINT|context compaction|summariz/i.test(JSON.stringify(body.input ?? body.messages ?? [])) });
      if (url.pathname.endsWith("/models")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: MODELS.map(model => ({ id: model, type: "model", display_name: model, created_at: "2026-01-01T00:00:00Z" })), has_more: false })); return; }
      if (url.pathname.endsWith("/messages")) {
        const message = { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: usageInputs.shift() ?? 1, output_tokens: 1 } };
        if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ...message, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })); return; }
        sse(response, [["message_start", { type: "message_start", message }], ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }], ["content_block_stop", { type: "content_block_stop", index: 0 }], ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }], ["message_stop", { type: "message_stop" }]]);
        return;
      }
      if (url.pathname.endsWith("/responses")) {
        const item = { type: "message", id: `item_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
        const inputTokens = usageInputs.shift() ?? 1;
        const result = { id, object: 'response', created_at: 1, model: body.model, status: 'completed', output: [item],
          error: null, incomplete_details: null, instructions: null, metadata: {}, parallel_tool_calls: true,
          tools: [], tool_choice: 'auto', temperature: 1, top_p: 1,
          usage: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
        sse(response, [["response.created", { type: "response.created", sequence_number: 0, response: { ...result, status: 'in_progress', output: [] } }],
          ["response.output_item.done", { type: "response.output_item.done", sequence_number: 1, output_index: 0, item }],
          ["response.completed", { type: "response.completed", sequence_number: 2, response: result }]]);
        return;
      }
      if (url.pathname.endsWith('/chat/completions')) {
        sse(response, [[null, { id, created: 1, model: body.model, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }],
          [null, { id, created: 1, model: body.model, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]]);
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, setUsage: values => usageInputs.splice(0, usageInputs.length, ...values), close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
};

const gatewayFor = url => ({ id: "smoke", name: "Smoke", url, accent: "#6366f1", models: { ids: MODELS, manual: [] }, agents: { [agentId]: { on: true } } });
const instanceFor = gateway => mergeInstance(agent, desiredInstance(agent, gateway, { dir: files, gatewayModelLimits: true }), undefined, { key: KEY });
const processEnv = (instance, more = {}) => ({ HOME: home, PATH: process.env.PATH, ...Object.fromEntries(instance.environment.map(row => [row.name, row.value])), ...more });
// The generated subset of T3's tokenizer: literal single quotes and escaped double quotes.
const tokenize = text => [...String(text).matchAll(/'([^']*)'|("(?:\\.|[^"\\])*")|(\S+)/g)]
  .map(match => match[1] ?? (match[2] ? JSON.parse(match[2]) : match[3]));
const posts = gateway => gateway.requests.filter(request => request.method === "POST");

const runClaude = async (env, stdin = "", { model = "claude-smoke-opus", settings } = {}) => new Promise((resolve, reject) => {
  const child = spawn(executable, ["-p", "reply ok", "--model", model, "--output-format", "json", ...(settings ? ["--settings", JSON.stringify(settings)] : [])], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Claude Code did not finish.")); }, 45_000);
  child.once("error", reject);
  child.once("close", () => { clearTimeout(timer); resolve(output); });
  child.stdin.end(stdin);
});

const smokes = {
  async pi() {
    const gateway = await gatewayServer(), gw = gatewayFor(gateway.url), paths = filesFor(agent, gw, files);
    gw.models.capabilities = { 'smoke-model': { supported: true, effort: ['low', 'high', 'ultra'], limits: { context: 1048576, output: 65536 } } };
    await fs.mkdir(files, { recursive: true });
    await fs.writeFile(paths.config, fileText(agent, gw, files));
    const env = processEnv(instanceFor(gw), { PI_OFFLINE: '1' });
    const args = tokenize(instanceFor(gw).config.launchArgs);
    try {
      const { stdout } = await promisify(execFile)(executable, [...args, '--offline', '--list-models'], { cwd: work, env, timeout: 30000 });
      assert.match(stdout, /smoke-model/);
      await withNativeProcess({ executable, home: work, env, timeoutMs: 30000 }, [...args, '--offline', '--no-session', '--provider', 't3gw_smoke', '--model', 'smoke-model', '--mode', 'rpc'], async ({ child, nextLine }) => {
        child.stdin.write(JSON.stringify({ id: 'context', type: 'get_state' }) + '\n');
        let response;
        do { response = JSON.parse(await nextLine()); } while (response.id !== 'context');
        assert.equal(response.data.model.contextWindow, 1048576);
        assert.equal(response.data.model.maxTokens, 65536);
      });
      await new Promise((resolve, reject) => {
        const child = execFile(executable, [...args, '--offline', '--no-session', '--provider', 't3gw_smoke', '--model', 'smoke-model', '--thinking', 'low', '--print', 'reply ok'],
          { cwd: work, env, timeout: 30000 }, error => error ? reject(error) : resolve());
        child.stdin.end();
      });
      const [turn] = posts(gateway);
      assert.equal(turn?.path, '/v1/chat/completions');
      assert.equal(turn.authorization, `Bearer ${KEY}`);
      assert.equal(turn.model, 'smoke-model');
      assert.equal(turn.reasoningEffort, 'low');
    } finally { await gateway.close(); }
  },
  async grok() {
    const gateway = await gatewayServer(), gw = gatewayFor(gateway.url), paths = filesFor(agent, gw, files);
    gw.agents.grok.scope = 'all';
    gw.models.capabilities = { 'smoke-model': { supported: true, effort: ['low', 'high', 'ultra'] } };
    await fs.mkdir(path.dirname(paths.config), { recursive: true });
    await fs.writeFile(paths.config, fileText(agent, gw, files));
    const env = processEnv(instanceFor(gw));
    try {
      const { stdout } = await promisify(execFile)(executable, ['models'], { cwd: work, env, timeout: 30000 });
      assert.match(stdout, /smoke-model/);
      await withNativeProcess({ executable, home: work, env, timeoutMs: 30000 }, ['agent', 'stdio'], async ({ child, nextLine }) => {
        let id = 0;
        const call = async (method, params) => {
          const requestId = ++id;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
          for (;;) {
            const line = JSON.parse(await nextLine());
            if (line.id !== requestId) continue;
            assert.equal(line.error, undefined, JSON.stringify(line.error));
            return line.result;
          }
        };
        await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
        await call('authenticate', { methodId: 'xai.api_key' });
        const session = await call('session/new', { cwd: work, mcpServers: [] });
        assert.deepEqual(session.models.availableModels.map(model => model.modelId).sort(), [...MODELS].sort());
        for (const model of session.models.availableModels) {
          const meta = model._meta;
          if (model.modelId === 'smoke-model') {
            assert.equal(meta.supportsReasoningEffort, true);
            assert.deepEqual(meta.reasoningEfforts.map(option => option.value).sort(), ['high', 'low']);
          } else {
            assert.notEqual(meta.supportsReasoningEffort, true);
            assert.deepEqual(meta.reasoningEfforts ?? [], []);
          }
        }
        await call('session/set_model', { sessionId: session.sessionId, modelId: 'smoke-model' });
        await call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'reply ok' }] });
      });
      const turns = posts(gateway), turn = turns.find(request => request.model === 'smoke-model');
      assert.ok(turn, JSON.stringify(turns));
      assert.equal(turn.reasoningEffort, 'low');
      assert.ok(turns.every(request => request.path === '/v1/responses' && request.authorization === `Bearer ${KEY}` && MODELS.includes(request.model)), JSON.stringify(turns));
    } finally { await gateway.close(); }
  },
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
      await fs.writeFile(settings, '{}');
      const baseline = JSON.parse(await runClaude(env, '', { model: 'gemini-smoke' }));
      assert.equal(baseline.modelUsage['gemini-smoke'].contextWindow, 200000);
      const source = new URL(process.env.T3_SETUP_DIR ? 'file:///opt/t3-runtime/patches/gateway-context.ts' : '../docker/runtime/patches/gateway-context.ts', import.meta.url);
      const helper = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(await fs.readFile(source, 'utf8')))}`);
      const gw = gatewayFor(gateway.url);
      gw.agents.claude.scope = 'all';
      gw.models.capabilities = { 'gemini-smoke': { limits: { context: 1048576 } }, 'smoke-small': { limits: { context: 128000, output: 8192 } } };
      const scopedEnv = processEnv(instanceFor(gw));
      for (const model of ['gemini-smoke', 'smoke-small']) {
        const result = JSON.parse(await runClaude(scopedEnv, '', { model, settings: helper.applyClaudeGatewayContext(scopedEnv, model) }));
        assert.equal(result.modelUsage[model].contextWindow, gw.models.capabilities[model].limits.context);
        assert.equal(posts(gateway).at(-1).model, model, 'model ids remain unchanged on the wire');
      }
      for (const [settings, nearBoundary] of [[undefined, 990000], [{ autoCompactWindow: 750000 }, 790000]]) {
        const windowSettings = helper.applyClaudeGatewayContext(scopedEnv, 'gemini-smoke', settings);
        gateway.setUsage([220000, nearBoundary, 1, 1, 1]);
        await withNativeProcess({ executable, home: work, env: { ...scopedEnv, CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP: '1' }, timeoutMs: 45000 },
          ['-p', '--model', 'gemini-smoke', '--settings', JSON.stringify(windowSettings), '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
          async ({ child, nextLine }) => {
            let compacted = false;
            const prompt = async () => {
              child.stdin.write(JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'reply ok' } }) + '\n');
              for (;;) {
                const message = JSON.parse(await nextLine());
                if (message.type === 'system' && message.subtype === 'compact_boundary') compacted = true;
                if (message.type === 'result') { assert.equal(message.is_error, false, message.result); return; }
              }
            };
            await prompt();
            child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'effort-change',
              request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high', fastMode: null, ultracode: null } } }) + '\n');
            for (;;) {
              const message = JSON.parse(await nextLine());
              if (message.type !== 'control_response' || message.response?.request_id !== 'effort-change') continue;
              assert.equal(message.response.subtype, 'success', JSON.stringify(message));
              break;
            }
            const before = posts(gateway).length;
            await prompt();
            assert.equal(posts(gateway).length, before + 1, '220K usage must not compact a model configured for 1M, including after a live effort change');
            assert.equal(compacted, false);
            await prompt();
            assert.equal(compacted, true, 'Claude must keep its compaction cap after a live effort change');
          });
      }
    } finally { await Promise.all([gateway.close(), elsewhere.close()]); }
  },
  async codex() {
    const gateway = await gatewayServer(), elsewhere = await gatewayServer(), codexHome = path.join(home, ".codex"), gw = gatewayFor(gateway.url);
    gw.agents.codex.scope = 'all';
    gw.models.capabilities = { 'smoke-model': { limits: { context: 1048576 } }, 'smoke-small': { limits: { context: 128000 } } };
    const instance = instanceFor(gw), paths = filesFor(agent, gw, files);
    const nativeModels = await readCodexModels({ executable, home, env: { HOME: home, PATH: process.env.PATH } });
    await fs.mkdir(files, { recursive: true });
    await fs.writeFile(paths.config, fileText(agent, gw, files, { nativeModels }));
    await fs.mkdir(codexHome, { recursive: true });
    // Someone's own settings and sign-in, in the home the instance shares.
    await fs.writeFile(path.join(codexHome, "config.toml"), `model = "theirs"\nmodel_provider = "theirs"\n[model_providers.theirs]\nname = "Theirs"\nbase_url = "${elsewhere.url}/v1"\nwire_api = "responses"\n`);
    await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture-stored" }));
    const child = spawn(executable, ["app-server", ...tokenize(instance.config.launchArgs)], { cwd: work, env: processEnv(instance, { CODEX_HOME: codexHome }), stdio: ["pipe", "pipe", "ignore"] });
    try {
      let next = 1;
      const waiting = new Map(), notices = [], usages = [];
      readline.createInterface({ input: child.stdout }).on("line", line => {
        const message = JSON.parse(line);
        if (message.id !== undefined && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); } else if (message.method) notices.push(message.method);
        if (message.method === 'thread/tokenUsage/updated') usages.push(message.params.tokenUsage);
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
      gateway.setUsage([1000000, 1, 1]);
      await call("turn/start", { threadId: thread.id, input: [{ type: "text", text: "reply ok", text_elements: [] }] });
      for (let tries = 0; tries < 100 && !notices.includes("turn/completed"); tries++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(notices.includes("turn/completed"), "the turn finished");
      assert.equal(usages.at(-1).modelContextWindow, Math.floor(1048576 * 0.95));
      notices.length = 0;
      await call('turn/start', { threadId: thread.id, model: 'smoke-small', input: [{ type: 'text', text: 'reply ok', text_elements: [] }] });
      for (let tries = 0; tries < 100 && !notices.includes('turn/completed'); tries++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(notices.includes('turn/completed'), 'the model switch finished');
      assert.equal(usages.at(-1).modelContextWindow, Math.floor(128000 * 0.95), 'the smaller model does not inherit the large window');
      assert.ok(posts(gateway).some(request => request.compaction), 'Codex performed local compaction at the reported usage boundary');
      const [turn] = posts(gateway);
      assert.equal(turn?.path, "/v1/responses");
      assert.equal(turn.authorization, `Bearer ${KEY}`, "the key comes from the variable, not auth.json");
      assert.equal(turn.model, "smoke-model", "a model Codex doesn't know still runs");
      assert.equal(elsewhere.requests.length, 0, "nothing reached the provider in config.toml");
    } finally { child.kill("SIGKILL"); await Promise.all([gateway.close(), elsewhere.close()]); }
  },
  async opencode() {
    const gateway = gatewayFor("http://127.0.0.1:9"), paths = filesFor(agent, gateway, files), password = "fixture-password";
    gateway.models.capabilities = { 'smoke-model': { limits: { context: 1048576, output: 65536 } }, 'gemini-smoke': { limits: { context: 1048576 } } };
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
    await fs.writeFile(paths.config, fileText(agent, gateway, files, { major: legacy ? 1 : 2 }));
    await withNativeProcess({ executable, home: work, env, timeoutMs: 30_000 }, legacy ? ["serve", ...port] : ["serve", "--stdio", ...port], async ({ nextLine, signal }) => {
      const line = await nextLine(), url = new URL(legacy ? /https?:\/\/\S+/.exec(line)[0] : JSON.parse(line).url), location = `directory=${encodeURIComponent(work)}`;
      const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
      const read = async route => {
        const response = await fetch(new URL(`${route}?${location}`, url), { headers, signal }), body = await response.json();
        assert.equal(response.ok, true, `${route} (${response.status}): ${JSON.stringify(body)}`);
        return body;
      };
      const providers = legacy ? (await read('/config/providers')).providers : (await read('/api/provider')).data ?? [];
      const nativeModels = legacy ? Object.entries(providers[0].models).map(([id, model]) => ({ ...model, id })) : (await read('/api/model')).data ?? [];
      const catalog = [{ id: providers[0]?.id, models: nativeModels.map(model => model.id) }];
      assert.deepEqual(catalog.map(provider => provider.id), ["t3gw-smoke"], "the catalog is narrowed to the gateway");
      assert.deepEqual(catalog[0].models.sort(), [...MODELS].sort());
      assert.equal(nativeModels.find(model => model.id === 'smoke-model').limit.context, 1048576);
      assert.equal(nativeModels.find(model => model.id === 'smoke-model').limit.output, 65536);
      assert.equal(nativeModels.find(model => model.id === 'gemini-smoke').limit.context, 1048576, 'a context-only limit is valid native config');
      if (legacy) assert.equal(nativeModels.find(model => model.id === 'gemini-smoke').limit.output, 0, 'v1 keeps its native unknown-output sentinel');
    });
  },
};

try {
  await smokes[agentId]();
  console.log(`${agent.name}: a gateway works through its real settings.`);
} finally {
  if (process.env.T3_GATEWAY_SMOKE_KEEP) console.log(`Fixture files: ${root}`);
  else await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
