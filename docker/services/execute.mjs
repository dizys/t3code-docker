// s6 executes this image-owned program. Custom invocations have already lost
// UID/GID, groups, capabilities and privilege escalation in bootstrap.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { openStore, hash } from "./store.mjs";
import { paths, containerBoot } from "./paths.mjs";
import { createUserTools } from "./user-tools.mjs";
import { resolveSecrets } from "./user-secrets.mjs";
import { logWriter } from "./logs.mjs";
import { validId } from "./definition.mjs";

const [domain, id] = process.argv.slice(2);
if (!["user", "system"].includes(domain) || !validId(id) || domain === "user" && process.getuid() === 0) process.exit(100);
const p = paths(domain), store = openStore(p.root, { domain }), resource = store.get(id), runId = randomUUID();
let child;
try {
  if (!resource?.config || !resource.enabled || resource.stoppedBoot === containerBoot()) process.exit(125);
  let command, masks = [];
  if (domain === "user") {
    const tools = createUserTools({ home: p.home, stateHome: p.root, dataDir: process.env.MISE_DATA_DIR });
    command = await tools.resolve(resource.config);
    if (hash(command.receipt) !== hash(resource.receipt)) throw new Error("tool-changed");
    const secrets = await resolveSecrets(resource.config, { home: p.home, stateHome: process.env.T3CODE_HOME || path.join(p.home, ".t3") });
    if (hash(secrets.receipts) !== hash(resource.secretReceipts || [])) throw new Error('credential-changed');
    command.env = { ...command.env, ...secrets.env };
    masks = secrets.masks;
  } else {
    const { systemCommand } = await import("./system.mjs");
    command = await systemCommand(resource, p);
    masks = command.masks || [];
  }
  const run = { runId, pid: process.pid, boot: containerBoot(), startedAt: Date.now(), revision: resource.revision, receipt: resource.receipt };
  const out = logWriter(p.root, id, runId, "stdout", masks), err = logWriter(p.root, id, runId, "stderr", masks);
  child = spawn(command.executable, command.argv, { cwd: resource.config.cwd || "/", env: command.env, stdio: ["ignore", "pipe", "pipe"] });
  child.once("spawn", () => store.setMeta("run:" + id, { ...run, payloadPid: child.pid }));
  child.stdout.on("data", out.write); child.stderr.on("data", err.write);
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; child.kill("SIGTERM"); } };
  process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", stop);
  const code = await new Promise(resolve => { child.once("error", () => resolve(126)); child.once("close", (status, signal) => resolve(status ?? (signal ? 128 : 1))); });
  out.end(); err.end();
  store.setMeta("exit:" + id, { ...run, exitCode: code, stopped: stopping, endedAt: Date.now() });
  store.close(); process.exitCode = code;
} catch {
  // The command/script, environment and provider tokens never enter errors.
  store.setMeta("exit:" + id, { runId, boot: containerBoot(), revision: resource?.revision, exitCode: 126, endedAt: Date.now(), reason: "The selected tool, credential or configuration changed. Review it before retrying." });
  store.close(); process.exitCode = 126;
}
