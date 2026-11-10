// Trial the real patched binary against the same upstream native version.
// Every server, session, project and database belongs to a disposable home.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createGatewayT3 } from "../docker/setup/gateways/t3.mjs";
import { createT3Api } from "../docker/setup/t3-api.mjs";
import { createRuntimeManager } from "../docker/runtime/manager.mjs";
import { releaseForVersion, unpackRelease, archiveStem } from "../docker/runtime/releases.mjs";
import { runtimePaths, readJson, readSelection, selectedRuntime, writeJson } from "../docker/runtime/state.mjs";
import { PATCH_REVISION, distributionBlob } from "../docker/runtime/distribution-spec.mjs";
import { nativeRegistry } from "../tests/fixtures/native-registry.mjs";
import { verifyGatewayQuota } from "./lib/gateway-quota-smoke.mjs";

const execute = promisify(execFile), binary = path.resolve(process.argv[2]);
const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(binary), "package.json"), "utf8"));
assert.equal(manifest.containerPatch?.revision, PATCH_REVISION);
const version = manifest.version, root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-integration-smoke-"));
let supervisor, stopped, api;
try {
  const original = path.join(root, "upstream"); await fs.mkdir(original);
  const upstream = await unpackRelease(original, await releaseForVersion(version));
  const home = path.join(root, "home"), workspace = path.join(root, "Work spaces 世界");
  await fs.mkdir(home); await fs.mkdir(workspace);
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, T3CODE_HOME: path.join(home, ".t3"), T3_WORKSPACE: workspace,
    T3_INFRA_BINARY: path.join(upstream, "t3"), T3_RUN_DIR: path.join(root, "run"), XDG_CONFIG_HOME: path.join(home, ".config"),
    CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, "[user]\n name = Integration smoke\n email = smoke@example.test\n");
  const issued = await execute(env.T3_INFRA_BINARY, ["auth", "session", "issue", "--ttl", "5m", "--subject", "integration-smoke", "--json"], { env, timeout: 60_000 });
  const session = JSON.parse(issued.stdout.slice(issued.stdout.indexOf("{")));
  const reserve = net.createServer();
  await new Promise((resolve, reject) => { reserve.once("error", reject); reserve.listen(0, "127.0.0.1", resolve); });
  const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  const log = await fs.open(path.join(root, "supervisor.log"), "wx", 0o600);
  const args = ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser", workspace];
  const driver = `import {runSupervisor} from ${JSON.stringify(new URL("../docker/runtime/supervisor.mjs", import.meta.url).href)}; process.exitCode=await runSupervisor(${JSON.stringify(args)});`;
  supervisor = spawn(process.execPath, ["--input-type=module", "-e", driver], { env, stdio: ["ignore", log.fd, log.fd] });
  stopped = new Promise((resolve, reject) => { supervisor.once("exit", resolve); supervisor.once("error", reject); });
  await log.close();
  api = createT3Api({ url: `ws://127.0.0.1:${port}/ws`, issueSession: async () => session, renewWithinMs: 0, connectTimeoutMs: 1000 });
  const until = async (read) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) { try { const value = await read(); if (value) return value; } catch { /* startup reconnect */ } await new Promise((resolve) => setTimeout(resolve, 200)); }
    throw new Error("The native integration smoke did not finish within its deadline.");
  };
  const before = await until(() => api.call("server.getConfig", {}));
  assert.equal(before.newProjectsRoot, path.join(env.T3CODE_HOME, "projects"));
  // Gateways rest on these exact calls, and on T3 redacting what it was given.
  const gatewayT3 = createGatewayT3(api), gatewayInstance = "codex_gw_smoke", gatewaySecret = "sk-integration-smoke";
  // This phase deliberately runs upstream, before installing our patched runtime.
  const customModels = ["smoke-model"];
  await gatewayT3.upsert(gatewayInstance, { driver: "codex", displayName: "Codex · Smoke", enabled: false, environment: [{ name: "T3_GATEWAY_KEY", value: gatewaySecret, sensitive: true }, { name: "PLAIN", value: "", sensitive: false }], config: { customModels } });
  await gatewayT3.setModelsHidden([{ provider: gatewayInstance, model: "smoke-hidden", hidden: true }]);
  const gatewayRead = await until(async () => { const state = await gatewayT3.read(); return state.instances[gatewayInstance] && state; });
  const [gatewayKey, gatewayPlain] = gatewayRead.instances[gatewayInstance].environment;
  assert.deepEqual([gatewayKey.value, gatewayKey.sensitive, gatewayKey.valueRedacted], ["", true, true], "T3 redacts a sensitive value on the way out");
  assert.equal(gatewayPlain.value, "", "T3 keeps an explicitly empty value");
  assert.equal(gatewayRead.customModelCapabilityOverrides, false, "upstream must not advertise our override contract");
  assert.equal(gatewayRead.gatewayModelLimits, false, "upstream must not advertise our gateway context-limit contract");
  assert.deepEqual(gatewayRead.instances[gatewayInstance].config.customModels, customModels);
  assert.deepEqual(gatewayRead.preferences[gatewayInstance].hiddenModels, ["smoke-hidden"]);
  await fs.access(path.join(env.T3CODE_HOME, "userdata/secrets", `provider-env-${Buffer.from(gatewayInstance).toString("base64url")}-${Buffer.from("T3_GATEWAY_KEY").toString("base64url")}.bin`));
  assert.ok(!(await fs.readFile(path.join(env.T3CODE_HOME, "userdata/settings.json"), "utf8")).includes(gatewaySecret), "the secret isn't in settings.json");

  // Limits rest on T3 taking a hub through settings, its key as a secret that a redacted value keeps.
  const hubId = "cliproxy-smoke", hubKey = "hub-integration-smoke";
  await gatewayT3.setHub(hubId, { kind: "cliproxy", label: "Smoke", url: "http://127.0.0.1:9", managementKey: hubKey, enabled: false });
  const hubRead = await until(async () => { const state = await gatewayT3.read(); return state.hubSources[hubId] && state; });
  assert.equal(hubRead.hubs, true, "T3 reports hubs in its settings");
  assert.notEqual(hubRead.hubSources[hubId].managementKey, hubKey, "T3 redacts a management key on the way out");
  assert.ok(!(await fs.readFile(path.join(env.T3CODE_HOME, "userdata/settings.json"), "utf8")).includes(hubKey), "the management key isn't in settings.json");
  const hubSecret = path.join(env.T3CODE_HOME, "userdata/secrets", `usage-limit-source-${Buffer.from(hubId).toString("base64url")}.bin`);
  await fs.access(hubSecret);
  assert.ok(Array.isArray(await gatewayT3.hubReports({ timeoutMs: 15_000 })), "T3 sends hub reports on its config stream");
  await gatewayT3.setHub(hubId, { ...hubRead.hubSources[hubId], label: "Renamed" });
  await until(async () => (await gatewayT3.read()).hubSources[hubId]?.label === "Renamed");
  await fs.access(hubSecret);
  await gatewayT3.setHub(hubId, null);
  await until(async () => !(await gatewayT3.read()).hubSources[hubId]);
  await gatewayT3.remove(gatewayInstance);
  assert.equal((await gatewayT3.read()).instances[gatewayInstance], undefined);
  const connectFacts = async (executable) => {
    const output = await execute(executable, ["connect", "status", "--json"], { env, timeout: 60_000 });
    const result = JSON.parse(output.stdout.slice(output.stdout.indexOf("{")));
    return { desired: result.desired, authenticated: result.authenticated, linked: result.linked,
      relayClient: { status: result.relayClient?.status, version: result.relayClient?.version } };
  };
  const connectBefore = await connectFacts(env.T3_INFRA_BINARY);
  const existing = await api.call("projects.createNew", { name: "Existing project" });
  const identityBefore = await (await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`)).json();

  const stem = archiveStem(version), archive = path.join(root, "patched.tar.gz");
  await fs.symlink(path.dirname(binary), path.join(root, stem), "dir");
  // This is a disposable local fixture, so favor fast compression over size.
  await execute("tar", ["-h", "--use-compress-program=gzip -1", "-cf", archive, "-C", root, stem], { timeout: 60_000 });
  const bytes = await fs.readFile(archive), hash = createHash("sha256").update(bytes).digest("hex");
  const registry = nativeRegistry({ stable: version.includes("nightly") ? null : version, nightly: version.includes("nightly") ? version : null, layerDigest: `sha256:${hash}`, layerSize: bytes.length });
  const fetcher = (url, options) => url === distributionBlob(`sha256:${hash}`) ? Promise.resolve(new Response(bytes, { headers: { "content-length": String(bytes.length) } })) : registry.fetcher(url, options);
  const paths = runtimePaths(env);
  const manager = createRuntimeManager({ env, fetcher, supervised: () => true, install: undefined,
    restart: async () => { await fs.writeFile(path.join(paths.run, "restart"), "requested"); process.kill(Number(await fs.readFile(path.join(paths.run, "t3.pid"), "utf8")), "SIGTERM"); } });
  env.T3_SETUP_BRIDGE = new URL("../docker/t3-client/setup-bridge.js", import.meta.url).pathname;
  const channel = version.includes("nightly") ? "nightly" : "stable";
  if (channel === "nightly") await writeJson(paths.selection, { schema: 1, channel, version: null });
  const answer = await manager.update({ channel, version });
  assert.equal(answer.http, 202, answer.body.error);
  const finished = await until(async () => { const operation = await readJson(paths.operation); return operation && ["succeeded", "failed", "rolled-back"].includes(operation.phase) ? operation : null; });
  assert.equal(finished.phase, "succeeded", finished.error);
  assert.equal((await readSelection(paths)).patchRevision, PATCH_REVISION);
  api.reset();
  const after = await until(() => api.call("server.getConfig", {}));
  await verifyGatewayQuota({ api, gatewayT3, until });
  assert.equal(after.newProjectsRoot, workspace);
  // The new capability contract belongs to the patched server, not upstream.
  assert.equal((await gatewayT3.read()).customModelCapabilityOverrides, true, "the selected patched runtime advertises capability overrides");
  assert.equal((await gatewayT3.read()).gatewayModelLimits, true, "the upgraded runtime advertises gateway context-limit support");
  const richCustomModels = [{ slug: "smoke-model", capabilities: { optionDescriptors: [{ id: "reasoningEffort", label: "Reasoning", type: "select", options: [{ id: "ultra", label: "ultra" }] }] } }, { slug: "smoke-unknown", capabilities: { optionDescriptors: [] } }];
  await gatewayT3.upsert(gatewayInstance, { driver: "codex", displayName: "Codex · Smoke", enabled: false, config: { customModels: richCustomModels } });
  const patchedGatewayRead = await until(async () => { const state = await gatewayT3.read(); return state.instances[gatewayInstance] && state; });
  assert.deepEqual(patchedGatewayRead.instances[gatewayInstance].config.customModels, richCustomModels, "the patched runtime preserves explicit and empty model capabilities");
  await gatewayT3.remove(gatewayInstance);
  assert.equal((await gatewayT3.read()).instances[gatewayInstance], undefined);
  const created = await api.call("projects.createNew", { name: "Workspace project" });
  assert.equal(created.workspaceRoot, path.join(workspace, "workspace-project"));
  assert.match(await fs.readFile(path.join(existing.workspaceRoot, "README.md"), "utf8"), /Existing project/);
  const identityAfter = await (await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`)).json();
  assert.equal(identityAfter.environmentId, identityBefore.environmentId);
  assert.equal(identityAfter.serverVersion, identityBefore.serverVersion);
  assert.equal(identityAfter.serverVersion, version);
  assert.deepEqual(await connectFacts((await selectedRuntime(paths)).binary), connectBefore, "The integration must retain upstream's public Connect capability and relay discovery");
  console.log(JSON.stringify({ sameVersionIntegration: version, patchRevision: PATCH_REVISION, identityPreserved: true, originalSessionPreserved: true, existingProjectsPreserved: true, newProjectInWorkspace: true, connectPreserved: true }));
} finally {
  api?.close();
  if (supervisor && supervisor.exitCode === null) {
    supervisor.kill("SIGTERM"); let timeout;
    await Promise.race([stopped, new Promise((resolve) => { timeout = setTimeout(() => { supervisor.kill("SIGKILL"); resolve(); }, 15_000); })]); clearTimeout(timeout);
  }
  await fs.rm(root, { recursive: true, force: true });
}
