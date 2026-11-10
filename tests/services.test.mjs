import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openStore } from "../docker/services/store.mjs";
import { customDefinition, systemDefinition } from "../docker/services/definition.mjs";
import { createController } from "../docker/services/controller.mjs";
import { downloadVerified } from "../docker/services/artifacts.mjs";
import { hash } from "../docker/services/store.mjs";
import { deriveHostPublicKey, publicKeys } from "../docker/services/system.mjs";
import { logWriter, readLogs } from "../docker/services/logs.mjs";
import { serviceReferences, assertToolUnreferenced } from "../docker/harness/service-references.mjs";
const configuration = (extra = {}) => ({ name: "Preview", mode: "executable", executable: "/usr/bin/python3", argv: ["-m", "http.server", "8081", "", "a b", "$(touch /tmp/never)", "雪"], cwd: "/tmp", enabled: false, ...extra });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-services-test-"));
  const store = openStore(root), running = new Map(), starts = [], stops = [];
  const receipt = { executable: { path: "/usr/bin/python3", digest: "a" }, installations: [] };
  let fail = false;
  const tools = { resolve: async () => ({ receipt, executable: "/usr/bin/python3", env: {}, argv: [] }) };
  const supervisor = {
    observe: async id => ({ up: running.get(id) || false }),
    start: async id => { starts.push(id); if (fail) throw new Error("startup"); running.set(id, true); const resource = store.get(id); store.setMeta("run:" + id, { revision: resource.revision, boot: "boot", runId: randomUUID(), payloadPid: 123, startedAt: Date.now() - 1000 }); },
    stop: async id => { stops.push(id); running.set(id, false); },
  };
  const controller = createController({ store, tools, supervisor, boot: "boot", reservedPorts: [3773, 3774] });
  t.after(async () => { controller.close(); while (!controller.idle()) await new Promise(resolve => setTimeout(resolve, 5)); store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const apply = async review => { const op = controller.apply({ planId: review.id, expectedRevision: review.expectedRevision, idempotencyKey: randomUUID() }); await controller.reconcile(); while (!controller.idle()) await new Promise(resolve => setTimeout(resolve, 5)); return controller.operation(op.id); };
  const add = extra => controller.plan({ action: "add", configuration: configuration(extra), expectedRevision: 0 });
  return { root, store, receipt, controller, supervisor, starts, stops, running, apply, add, fail: value => { fail = value; } };
}
test("literal argv, shell selection and privilege metadata are validated independently", () => {
  const normalized = customDefinition(configuration());
  assert.deepEqual(normalized.argv.slice(-4), ["", "a b", "$(touch /tmp/never)", "雪"]);
  for (const patch of [{ runAs: "root" }, { capabilities: ["all"] }, { mode: "direct" }, { env: { T3_SETUP_KEY: "no" } }, { env: { BASH_ENV: "/tmp/evil" } }, { mode: "mise", tools: [{ tool: "python", version: "latest" }] }, { health: { kind: "http", port: 3774, path: "/" } }, { enabled: "false" }]) assert.throws(() => customDefinition(configuration(patch)));
  assert.equal(customDefinition(configuration({ mode: "script", script: "printf '%s' hello" })).mode, "script");
  assert.throws(() => systemDefinition("custom", configuration()));
  assert.throws(() => systemDefinition("openssh", { keys: ["x"], port: 22 }));
});
test("a durable apply is idempotent across reconnect, conflicts and controller restart", async t => {
  const f = await fixture(t), review = await f.add();
  const input = { planId: review.id, expectedRevision: 0, idempotencyKey: randomUUID() };
  const first = f.controller.apply(input), second = f.controller.apply(input);
  assert.equal(first.id, second.id);
  await f.controller.reconcile();
  assert.equal(f.store.get(review.target).revision, 1);
  assert.equal(f.controller.apply(input).id, first.id);
  assert.throws(() => f.controller.apply({ ...input, planId: randomUUID() }), /another review/);
  assert.equal(f.controller.operation(first.id).state, "succeeded");
  const concurrent = await f.controller.plan({ action: "enable", id: review.target, expectedRevision: 1 });
  const other = await f.controller.plan({ action: "disable", id: review.target, expectedRevision: 1 });
  await f.apply(concurrent);
  assert.throws(() => f.controller.apply({ planId: other.id, expectedRevision: 1, idempotencyKey: randomUUID() }), /changed/);
});
test("stop for now, disable and removal have distinct boot and retention semantics", async t => {
  const f = await fixture(t), review = await f.add({ enabled: true }); await f.apply(review);
  let resource = f.store.get(review.target);
  assert.equal(f.starts.length, 1);
  await f.apply(await f.controller.plan({ action: "stop", id: resource.id, expectedRevision: resource.revision }));
  resource = f.store.get(resource.id); assert.equal(resource.enabled, true); assert.equal(resource.stoppedBoot, "boot");
  await f.controller.reconcile(); assert.equal(f.starts.length, 1);
  await f.apply(await f.controller.plan({ action: "disable", id: resource.id, expectedRevision: resource.revision }));
  resource = f.store.get(resource.id); assert.equal(resource.enabled, false); assert.equal(resource.stoppedBoot, null);
  await f.apply(await f.controller.plan({ action: "remove", id: resource.id, expectedRevision: resource.revision }));
  assert.equal(f.store.get(resource.id), null);
});
test("tool changes and reserved ports fail before stopping an existing service", async t => {
  const f = await fixture(t);
  await assert.rejects(f.add({ endpoints: [{ port: 3774, protocol: "http" }] }), /belongs to T3/);
  const review = await f.add({ enabled: true }); f.receipt.executable.digest = "changed";
  const op = await f.apply(review); assert.equal(op.state, "failed"); assert.equal(f.starts.length, 0); assert.equal(f.stops.length, 0);
});
test("failed candidate restores previous configuration and reports recovery honestly", async t => {
  const f = await fixture(t), review = await f.add(); await f.apply(review);
  const resource = f.store.get(review.target);
  const edit = await f.controller.plan({ action: "edit", id: resource.id, expectedRevision: resource.revision, configuration: configuration({ name: "Changed", enabled: true }) });
  f.fail(true); const op = await f.apply(edit);
  assert.equal(op.state, "rolled-back"); assert.equal(f.store.get(resource.id).config.name, "Preview"); assert.match(op.recovery, /data was not rolled back/);
});
test("expired reviews and unsupported schema cannot mutate an authority", async t => {
  const f = await fixture(t), review = await f.add();
  f.store.db.prepare("UPDATE plans SET expires=0,value=? WHERE id=?").run(JSON.stringify({ ...f.store.db.prepare("SELECT value FROM plans WHERE id=?").get(review.id), expiresAt: 0 }), review.id);
  assert.throws(() => f.controller.apply({ planId: review.id, expectedRevision: 0, idempotencyKey: randomUUID() }), /expired/);
  const root = path.join(f.root, "future"); const store = openStore(root); store.db.exec("PRAGMA user_version=99"); store.close();
  assert.throws(() => openStore(root), /newer/);
});
test("hash and byte mismatch never activate a downloaded payload", async t => {
  const f = await fixture(t), file = path.join(f.root, "payload");
  await assert.rejects(downloadVerified({ url: "https://fixture.invalid", bytes: 4, sha256: hash("good") }, file, { fetchImpl: async () => new Response("evil") }), /verification/);
  assert.equal(await fs.readFile(file, "utf8"), "evil");
});
test("SSH key parser fingerprints, deduplicates and rejects options/private input without echoes", async () => {
  const type = Buffer.from("ssh-ed25519"), blob = Buffer.concat([Buffer.from([0, 0, 0, type.length]), type, Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 11)]);
  const key = "ssh-ed25519 " + blob.toString("base64");
  const keys = await publicKeys([key + " one", key + " two"]);
  assert.equal(keys.length, 1); assert.match(keys[0].fingerprint, /^SHA256:/);
  await assert.rejects(publicKeys(["-----BEGIN PRIVATE KEY----- canary"]), error => /private key/.test(error.message) && !error.message.includes("canary"));
  await assert.rejects(publicKeys(['command="sudo x" ' + key]), /without authorized_keys options/);
});
test("SSH host public derivation ignores comments and preserves the private identity", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-host-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "ed25519"), exec = promisify(execFile);
  await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "host identity multiword comment", "-f", file], { timeout: 10000 });
  const privateDigest = hash(await fs.readFile(file));
  const sidecar = (await fs.readFile(file + ".pub", "utf8")).trim();
  const material = sidecar.split(/\s+/).slice(0, 2).join(" ");
  assert.ok(sidecar.endsWith("host identity multiword comment"));
  assert.equal(await deriveHostPublicKey(file), material);
  await fs.writeFile(file + ".pub", material + " changed public comment\n");
  assert.equal(await deriveHostPublicKey(file), material);
  await fs.rm(file + ".pub");
  assert.equal(await deriveHostPublicKey(file), material);
  await assert.rejects(fs.access(file + ".pub"));
  assert.equal(hash(await fs.readFile(file)), privateDigest);
});
test("unreadable SSH host identities fail without disclosing paths or changing their bytes", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-host-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "private-key-canary");
  const safeError = error => error.code === "identity" && /preserved/.test(error.message) && !error.message.includes(file);
  await assert.rejects(deriveHostPublicKey(file), safeError);
  await fs.writeFile(file, "invalid-private-key-canary", { mode: 0o600 });
  await assert.rejects(deriveHostPublicKey(file), safeError);
  assert.equal(await fs.readFile(file, "utf8"), "invalid-private-key-canary");
});
test("logs redact split secrets, remain bounded and separate stdout from stderr", async t => {
  const f = await fixture(t), writer = logWriter(f.root, "preview", "run", "stdout", ["canary-secret"]);
  writer.write(Buffer.from("one canary-")); writer.write(Buffer.from("secret two\n")); writer.end();
  const output = readLogs(f.root, "preview"); assert.match(output.entries[0].text, /\[redacted\]/); assert.ok(!JSON.stringify(output).includes("canary-secret"));
  for (let i = 0; i < 100; i++) writer.write(Buffer.from("x".repeat(8192) + "\n"));
  const dir = path.join(f.root, "logs/preview");
  for (const file of await fs.readdir(dir)) assert.ok((await fs.stat(path.join(dir, file))).size <= 256 * 1024);
});
test("disabled registrations retain exact tool and Vault dependency references", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-services-refs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = root + "/.t3", store = openStore(state + "/setup/services/user");
  store.put({ id: "preview", kind: "service", revision: 1, enabled: false, config: { name: "Preview", tools: [{ tool: "python", version: "3.14.0" }], secrets: { TOKEN: "fixture" } } });
  const ctx = { home: root, env: { T3CODE_HOME: state } };
  assert.equal(serviceReferences(ctx)[0].credentials[0], "fixture");
  assert.throws(() => assertToolUnreferenced(ctx, "python", "3.14.0"), /Disabled services retain/);
  assert.doesNotThrow(() => assertToolUnreferenced(ctx, "python", "3.15.0")); store.close();
});
test('pending changes retain both candidate and previous tool and Vault references', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-services-pending-refs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = root + '/.t3', store = openStore(state + '/setup/services/user');
  t.after(() => store.close());
  const previous = { id: 'preview', kind: 'service', revision: 1, config: { name: 'Preview', tools: [{ tool: 'python', version: '3.14.0' }], secrets: { TOKEN: 'old-token' } } };
  store.put(previous);
  const candidate = { config: { ...previous.config, tools: [{ tool: 'python', version: '3.15.0' }], secrets: { TOKEN: 'new-token' } } };
  const plan = store.plan({ target: 'preview', action: 'edit', expectedRevision: 1, previous, candidate, review: {} });
  store.apply({ planId: plan.id, expectedRevision: 1, idempotencyKey: randomUUID() });
  store.put({ ...previous, ...candidate, revision: 2 });
  const ctx = { home: root, env: { T3CODE_HOME: state } };
  for (const version of ['3.14.0', '3.15.0']) assert.throws(() => assertToolUnreferenced(ctx, 'python', version), /Required by service/);
  for (const id of ['old-token', 'new-token']) assert.ok(serviceReferences(ctx).some(row => row.credentials.includes(id)));
});
