#!/usr/bin/env node
// Configuration -> native MCP discovery, without authentication or inference.
// node scripts/mcp-native-smoke.mjs codex /absolute/path/to/codex
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const setup = process.env.T3_SETUP_MODULE || new URL("../docker/setup/mcp.mjs", import.meta.url).href;
const { createMcpService } = await import(setup);
const { withNativeProcess } = await import(process.env.T3_NATIVE_PROCESS_MODULE || new URL("../docker/harness/native-process.mjs", import.meta.url).href);
const [provider, executable] = process.argv.slice(2);
assert.ok(["claude", "codex", "opencode", "cursor", "grok", "muse", "pi"].includes(provider) && path.isAbsolute(executable || ""), "Pass a provider and its absolute executable path.");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-mcp-native-"));
const requests = [];
const answer = (request) => request.method === "initialize"
  ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "setup-fixture", version: "1.0.0" } }
  : request.method === "tools/list" ? { tools: [{ name: "fixture", description: "Disposable test", inputSchema: { type: "object", properties: {} } }] }
    : request.method === "resources/list" ? { resources: [] }
      : request.method === "resources/templates/list" ? { resourceTemplates: [] }
        : request.method === "prompts/list" ? { prompts: [] } : {};
const http = createServer(async (request, response) => {
  if (request.method !== "POST") { response.writeHead(405).end(); return; }
  let body = ""; for await (const chunk of request) body += chunk;
  const message = JSON.parse(body);
  requests.push({ method: message.method, auth: request.headers.authorization, custom: request.headers["x-fixture"] });
  if (message.id === undefined) { response.writeHead(202).end(); return; }
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message) }));
});
await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
const mock = path.join(root, "server.cjs");
await fs.writeFile(mock, `const fs = require('node:fs'); const answer = ${answer.toString()};
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.argv[2], JSON.stringify({method:request.method,env:process.env.SETUP_FIXTURE_VALUE})+'\\n');
  if(request.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:answer(request)})+'\\n');
});`);
const nativeCommand = async (env, home, args) => (await promisify(execFile)(executable, args, { env, cwd: home, timeout: 20000, maxBuffer: 1024 * 1024 })).stdout;

async function inventory(env, home, major, waitForMcp) {
  if (provider === 'grok') return nativeCommand(env, home, ['mcp', 'doctor', '--json']);
  if (provider === 'pi') return nativeCommand(env, home, ['mcp', 'list', '--json']);
  // Muse 1.4.15 also gates user-configured MCP startup on workspace trust.
  // Trust only this disposable fixture, for both enabled and disabled probes.
  if (provider === 'muse' && !waitForMcp) return nativeCommand(env, home, ['exec', '--provider', 'echo', '--trust-workspace', '--disable-shell', '--disable-write', '--disable-sandbox', 'Reply OK']);
  // A short echo turn can exit before Muse's background MCP startup. Keep its
  // native session host alive until this fresh session has discovered tools.
  if (provider === 'muse') return withNativeProcess({ executable, env, home, timeoutMs: 20000 }, ['serve', '--provider', 'echo', '--no-session-log', '--trust-workspace', '--disable-shell', '--disable-write', '--disable-sandbox'], async ({ child, nextLine, signal }) => {
    const request = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      for (;;) { const message = JSON.parse(await nextLine()); if (message.id === id) { assert.ok(!message.error, JSON.stringify(message.error)); return message.result; } }
    };
    await request(1, 'initialize', { clientInfo: { name: 'setup_native_smoke', version: '1' } });
    child.stdin.write('{"jsonrpc":"2.0","method":"initialized","params":{}}\n');
    // Muse requires a UUIDv7 command handle for each new session.
    const stamp = Date.now().toString(16).padStart(12, '0'), random = randomUUID();
    const commandId = `${stamp.slice(0, 8)}-${stamp.slice(8)}-7${random.slice(15, 18)}-${random.slice(19)}`;
    const result = await request(2, 'session/start', { commandId, workspaceRoot: home });
    await waitForMcp(signal);
    return result;
  });
  if (provider === "codex") return withNativeProcess({ executable, env, home, timeoutMs: 20000 }, ["app-server", "--stdio"], async ({ child, nextLine }) => {
    const request = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      for (;;) { const message = JSON.parse(await nextLine()); if (message.id === id) { assert.ok(!message.error); return message.result; } }
    };
    await request(1, "initialize", { clientInfo: { name: "setup-native-smoke", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized","params":{}}\n');
    return request(2, "mcpServerStatus/list", {});
  });
  if (provider === "opencode" && major === 2) return withNativeProcess({ executable, home, env: { ...env, OPENCODE_USERNAME: "opencode", OPENCODE_PASSWORD: "fixture" }, timeoutMs: 20000 }, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], async ({ nextLine, signal }) => {
    const ready = JSON.parse(await nextLine()), base = new URL(ready.url);
    assert.ok(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
    let result;
    for (let i = 0; i < 120; i++) {
      const response = await fetch(new URL("/api/mcp?directory=" + encodeURIComponent(home), base), { signal, headers: { authorization: "Basic " + Buffer.from("opencode:fixture").toString("base64") } });
      assert.equal(response.status, 200); result = await response.json();
      if (result.data?.some(row => row.name === "fixture" && ["connected", "disabled", "failed"].includes(row.status?.status))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return result;
  });
  if (provider === "cursor") {
    await nativeCommand(env, home, ["mcp", "enable", "fixture"]);
    return nativeCommand(env, home, ["mcp", "list-tools", "fixture"]);
  }
  return nativeCommand(env, home, ["mcp", provider === "claude" ? "get" : "list", ...(provider === "claude" ? ["fixture"] : [])]);
}

try {
  for (const transport of ["local", "remote"]) {
    const home = path.join(root, transport); await fs.mkdir(home);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/TOKEN|API_KEY|PASSWORD|^OPENCODE|^CLAUDE|^ANTHROPIC|^GEMINI|^GROK|^MUSE|^PI_|^CURSOR|^T3_/.test(key)) delete env[key];
    Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".data"), XDG_STATE_HOME: path.join(home, ".state"), XDG_CACHE_HOME: path.join(home, ".cache"), GROK_HOME: path.join(home, '.grok'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
      OPENCODE_CONFIG_DIR: path.join(home, ".config/opencode"), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    const version = (await nativeCommand(env, home, ["--version"])).trim(), major = Number(/(?:^|\s|v)(\d+)\./.exec(version)?.[1]);
    console.log(`Checking ${provider} ${version}: ${transport} MCP discovery.`);
    if (provider === 'claude' && transport === 'local') {
      delete env.CLAUDE_CONFIG_DIR;
      const target = path.join(root, 'persisted-claude.json');
      await fs.writeFile(target, '{}\n', {mode:0o600});
      await fs.symlink(target, path.join(home,'.claude.json'));
      await nativeCommand(env,home,['mcp','add','--scope','user','writer-fixture','--','/usr/bin/false']);
      assert.equal((await fs.lstat(path.join(home,'.claude.json'))).isSymbolicLink(),true,'native Claude writes must preserve state-volume persistence');
      assert.ok(JSON.parse(await fs.readFile(target,'utf8')).mcpServers['writer-fixture']);
    }
    if (provider === "opencode" && major === 2) {
      await fs.mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true });
      await fs.writeFile(path.join(env.OPENCODE_CONFIG_DIR, "opencode.json"), '{"mcp":{"servers":{}}}\n');
    }
    const marker = path.join(home, "requests.jsonl");
    const svc = createMcpService({ home, env, io: fs, baseDir: path.join(home, ".t3") });
    const input = transport === "local"
      ? { name: "fixture", type: "local", command: [process.execPath, mock, marker], env: { SETUP_FIXTURE_VALUE: "received" } }
      : { name: "fixture", type: "remote", url: `http://127.0.0.1:${http.address().port}/mcp`, headers: { Authorization: "Bearer fixture", "X-Fixture": "received" } };
    const created = await svc.create(input);
    await svc.setLink(provider, "fixture", true, created.revision, (await svc.list(provider)).revision);
    const before = requests.length;
    const readTraffic = async () => transport === 'remote' ? requests.slice(before) : (await fs.readFile(marker, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(JSON.parse);
    const waitForMcp = async (signal, after = 0) => {
      for (;;) {
        const traffic = (await readTraffic()).slice(after);
        if (['initialize', 'tools/list'].every(method => traffic.some(row => row.method === method))) return;
        await delay(25, undefined, { signal });
      }
    };
    const result = await inventory(env, home, major, waitForMcp);
    const traffic = await readTraffic();
    assert.ok(traffic.some(row => row.method === "initialize"), "native runtime did not initialize MCP");
    if (provider === "codex" || provider === "opencode" && major === 2 || provider === "cursor" || provider === 'muse') assert.ok(traffic.some(row => row.method === "tools/list"), "native runtime did not discover tools");
    if (transport === "local") assert.ok(traffic.every(row => row.env === "received"));
    else assert.ok(traffic.every(row => row.auth === "Bearer fixture" && row.custom === "received"));
    if (provider === "codex") assert.ok(result.data.some(row => row.tools?.fixture));
    if (provider === "opencode" && major === 2) assert.equal(result.data.find(row => row.name === "fixture").status.status, "connected");
    let currentRevision = created.revision;
    if (["codex", "opencode", "grok", "muse", "pi"].includes(provider)) {
      await svc.setLink(provider, 'fixture', true, currentRevision, (await svc.list(provider)).revision, false);
      const count = transport === 'local' ? (await fs.readFile(marker, 'utf8')).length : requests.length;
      await inventory(env, home, major);
      assert.equal(transport === 'local' ? (await fs.readFile(marker, 'utf8')).length : requests.length, count, 'a disabled server must not start or connect');
      assert.deepEqual((await svc.list(provider)).disabled, ['fixture']);
      await svc.setLink(provider, 'fixture', true, currentRevision, (await svc.list(provider)).revision, true);
      const priorTraffic = (await readTraffic()).length;
      const enabled = await inventory(env, home, major, signal => waitForMcp(signal, priorTraffic));
      assert.deepEqual((await svc.list(provider)).disabled, []);
      assert.ok(transport === 'local' ? (await fs.readFile(marker, 'utf8')).length > count : requests.length > count, 'turning the copy back on must start it in a fresh native read');
      if (provider === 'codex') assert.ok(enabled.data.some(row => row.tools?.fixture));
      if (provider === 'opencode' && major === 2) assert.equal(enabled.data.find(row => row.name === 'fixture').status.status, 'connected');
    }
    await svc.setLink(provider, "fixture", false, currentRevision, (await svc.list(provider)).revision);
    assert.equal((await svc.list(provider)).shared[0].linked, false);
    console.log(`${provider} ${version}: ${transport} MCP initialize, credentials, unlink${['codex','opencode','grok','muse','pi'].includes(provider) ? ' and native disable' : ''} passed.`);
  }
} finally {
  http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
}
