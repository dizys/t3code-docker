import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { openStore, ServiceError } from "./store.mjs";
import { paths } from "./paths.mjs";
import { createController } from "./controller.mjs";
import { createSupervision } from "./supervision.mjs";
import { createUserTools } from "./user-tools.mjs";
import { resolveSecrets } from "./user-secrets.mjs";
import { withToolLock } from "./tool-lock.mjs";
import { systemStorage, readCatalogue, createArtifacts } from "./artifacts.mjs";
import * as system from "./system.mjs";
import { serviceRequest } from "./client.mjs";
const domain = process.argv[2];
if (!["user", "system"].includes(domain)) process.exit(100);
if (domain === "user") {
  if (process.getuid() === 0 || process.geteuid() === 0) process.exit(100);
  const status = await fs.readFile("/proc/self/status", "utf8");
  if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^CapEff:\s+0+$/m.test(status) || !/^CapPrm:\s+0+$/m.test(status)) process.exit(100);
}
const p = paths(domain);
let store = null, controller = null, blocked = null;
const shutdown = new AbortController();
try {
  if (domain === "system") await systemStorage(p.root);
  store = openStore(p.root, { domain });
  const catalogue = domain === "system" ? await readCatalogue() : null;
  const artifacts = catalogue ? { ...createArtifacts({ root: p.root, catalogue, signal: shutdown.signal }), catalogue } : null;
  const supervisor = createSupervision({ ...p, domain });
  const tools = domain === "user" ? createUserTools({ home: p.home, stateHome: p.root, dataDir: process.env.MISE_DATA_DIR }) : null;
  const reservedPorts = (process.env.T3_SERVICES_RESERVED_PORTS || "3773,3774").split(",").map(Number).filter(Boolean);
  controller = createController({ store, supervisor, tools, artifacts, reservedPorts, systemSnapshot: domain === "user" ? () => serviceRequest("system", "snapshot", {}, { timeout: 2000 }) : undefined,
    secrets: config => resolveSecrets(config, { home: p.home, stateHome: process.env.T3CODE_HOME || path.join(p.home, ".t3") }),
    systemRequest: domain === 'user' ? (action, input) => serviceRequest('system', action, input) : undefined,
    networkReferences: domain === 'system' ? async () => (await serviceRequest('user', 'references', {}, { timeout: 2000 })).references : undefined,
    peerPorts: async () => {
      if (domain === 'user' && process.env.T3_SERVICES_SYSTEM_MODE === 'rootless') return [];
      try { return (await serviceRequest(domain === 'user' ? 'system' : 'user', 'ports', {}, { timeout: 2000 })).services; }
      catch (error) { if (domain === 'user' && error.code === 'storage-required') return []; throw error; }
    },
    toolLock: domain === "user" ? withToolLock : undefined, system: { ...system, paths: p } });
} catch (error) { blocked = { code: error.code || "store-unavailable", error: error instanceof ServiceError ? error.message : "Service management is unavailable. Check its persistent storage and container image." }; }
await fs.mkdir(path.dirname(p.socket), { recursive: true, mode: 0o700 });
await fs.rm(p.socket, { force: true });
const server = createServer(async (req, res) => {
  const respond = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  try {
    if (req.method !== "POST" || req.url !== "/v1") return respond(404, { error: "not found" });
    let bytes = 0, body = "";
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new ServiceError("too-large", "Service requests must be at most 64 KiB."); body += chunk; }
    let input; try { input = JSON.parse(body); } catch { throw new ServiceError("invalid", "Send a JSON service request."); }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["action", "input"].includes(key))) throw new ServiceError("invalid", "Use the versioned service protocol.");
    if (blocked) return respond(input.action === "snapshot" ? 200 : 409, { domain, ...blocked, services: [], operations: [], connections: [], routes: [], catalogue: [] });
    const args = input.input || {};
    let result;
    if (input.action === "snapshot") result = await controller.snapshot();
    else if (input.action === "plan") result = await controller.plan(args);
    else if (input.action === "apply") result = controller.apply(args);
    else if (input.action === "operation") result = controller.operation(args.id);
    else if (input.action === 'permissions') result = { maintenance: controller.requiresMaintenance(args) };
    else if (input.action === 'authentication') result = await controller.authentication(args.id);
    else if (input.action === 'references') result = { references: controller.references() };
    else if (input.action === 'ports') result = { services: controller.ports() };
    else if (input.action === "events") result = { events: controller.events(args.after) };
    else if (input.action === "logs") result = controller.logs(args.id, args.after);
    else if (input.action === "inventory" && domain === "user") result = await toolsInventory();
    else throw new ServiceError("invalid", "Choose an allowlisted service operation.");
    respond(200, { ok: true, ...result });
  } catch (error) { respond(error.code === "missing" ? 404 : ["conflict", "busy", "expired", "tools-busy"].includes(error.code) ? 409 : 400, { ok: false, code: error.code || "unavailable", field: error.field, error: error instanceof ServiceError ? error.message : "The service request could not finish. Check its status before retrying." }); }
});
async function toolsInventory() {
  const tools = createUserTools({ home: p.home, stateHome: p.root, dataDir: process.env.MISE_DATA_DIR });
  return { tools: await tools.inventory() };
}
server.requestTimeout = 10000; server.headersTimeout = 10000;
server.maxConnections = 32;
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(p.socket, resolve); });
await fs.chmod(p.socket, domain === "system" ? 0o660 : 0o600);
if (domain === "system") await fs.chown(p.socket, 0, Number(process.env.T3_SERVICES_GID));
controller?.start();
let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  controller?.close(); shutdown.abort(); server.close();
  // s6 owns child shutdown; do not turn a container shutdown into Disable.
  while (controller && !controller.idle()) await new Promise(resolve => setTimeout(resolve, 20));
  store?.close(); await fs.rm(p.socket, { force: true }); process.exit(0);
};
process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop());
