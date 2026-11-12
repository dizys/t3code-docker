import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ServiceError, hash } from "./store.mjs";
import { customDefinition, systemDefinition, validId, object } from "./definition.mjs";
import { containerBoot } from "./paths.mjs";
import { checkHealth } from "./health.mjs";
import { readLogs } from "./logs.mjs";
import { createNetwork } from "./network.mjs";

const terminal = new Set(["succeeded", "failed", "rolled-back", "cancelled"]);
const publicConnection = ({ authUrl, ...connection }) => ({ ...connection, signInPending: connection.state === 'NeedsLogin' && Boolean(authUrl) });
export function publicResource(value) {
  const result = structuredClone(value);
  if (result.config?.token) { delete result.config.token; result.config.tokenSaved = true; }
  if (result.previous?.config?.token) delete result.previous.config.token;
  if (result.observation?.authUrl) delete result.observation.authUrl;
  if (result.observation?.connection && Object.hasOwn(result.observation.connection, 'authUrl')) result.observation.connection = publicConnection(result.observation.connection);
  return result;
}
const publicOperation = value => {
  const { plan, ...result } = value;
  return { ...result, planId: plan.id, review: plan.review };
};
export function createController({ store, supervisor, tools, secrets = async () => ({ receipts: [] }), artifacts, system = null, networking = null, systemSnapshot, systemRequest, networkReferences, peerPorts = async () => [], toolLock = async fn => fn(), boot = containerBoot(), health = checkHealth, now = Date.now, reservedPorts = [] }) {
  let working = false, closed = false, timer = null;
  const services = () => store.list().filter(item => item.kind === "service");
  const packageReferences = (id, operationId) => [...services().filter(item => item.id !== id).map(item => item.artifact), ...store.pending().filter(op => op.id !== operationId).flatMap(op => [op.plan.previous?.artifact, op.plan.candidate?.artifact])].filter(Boolean);
  const network = createNetwork({ store, systemSnapshot, systemRequest });
  const snapshot = async () => ({ schema: 1, domain: store.domain, observedAt: now(), services: services().map(resource => publicResource({ ...resource, observation: store.meta("observation:" + resource.id) || { state: "unknown", at: null } })),
    ...(networking ? { requirements: { tailscale: await networking.requirements() } } : {}),
    ...await network.snapshot(),
    operations: store.operations().map(publicOperation), catalogue: store.domain === "system" ? Object.values(artifacts?.catalogue?.services || {}).map(({ id, name, version, payloads }) => ({ id, name, version, digest: artifacts.selection(id).digest, bytes: payloads.reduce((n, item) => n + item.bytes, 0) })) : [{ id: "http-preview", name: "Python preview", description: "Serve a selected folder using an installed Python version. Runs as your user; no automatic port publishing." }] });
  const localReferences = () => [...store.list().filter(item => item.kind === 'route'), ...store.pending().filter(op => op.plan.network && op.plan.candidate?.kind === 'route').map(op => ({ ...op.plan.candidate, pendingOperation: op.id }))].map(item => ({ id: item.id, name: item.name, service: item.service, serviceDomain: item.serviceDomain, endpoint: item.endpoint, connectionProvider: store.get(item.connection)?.provider, pendingOperation: item.pendingOperation }));
  const references = async () => networkReferences ? await networkReferences() : localReferences();
  const consumersOf = async id => (await references()).filter(item => item.service === id && (item.serviceDomain || store.domain) === store.domain || item.connectionProvider === id);
  const checkPendingRoutes = async (id, action) => {
    if (!['serve', 'unserve'].includes(action) && (await consumersOf(id)).some(item => item.pendingOperation)) throw new ServiceError('busy', 'A route operation is using this service. Let that operation finish before changing the service.');
  };
  const checkBindings = async (id, config) => {
    if (config.endpoints.some(item => reservedPorts.includes(item.port))) throw new ServiceError("port-conflict", "That port belongs to T3 or Setup. Choose another port.", "port");
    if ([...services().filter(item => item.id !== id && !item.uninstalled).map(item => ({ endpoints: item.config.endpoints })), ...await peerPorts()].some(item => item.endpoints.some(endpoint => config.endpoints.some(candidate => candidate.port === endpoint.port)))) throw new ServiceError("port-conflict", "Another registered service declares that port. Disabled registrations keep their ports until removed or edited.", "port");
    if ((await consumersOf(id)).some(item => item.endpoint && !config.endpoints.some(endpoint => endpoint.port === item.endpoint.port && endpoint.protocol === item.endpoint.protocol))) throw new ServiceError('dependencies', 'Move or remove this service’s routes before changing their declared endpoints.', 'endpoints');
  };
  const validate = async (id, input) => {
    const config = store.domain === "user" ? customDefinition(input) : systemDefinition(id, input);
    if (store.domain === 'system' && id === 'tailscale' && config.networkMode === 'kernel') {
      if (!networking) throw new ServiceError('deployment-required', 'This controller does not support full networking. Update the container image first.', 'networkMode');
      await networking.validate(config);
    }
    await checkBindings(id, config);
    if (store.domain === "user") {
      const resolved = await tools.resolve(config), selectedSecrets = await secrets(config);
      return { config, receipt: resolved.receipt, secretReceipts: selectedSecrets.receipts };
    }
    if (id === 'cloudflared' && !config.token) {
      const saved = store.get(id)?.config.token;
      if (!saved) throw new ServiceError('invalid', 'Enter the named tunnel connector token before installation.', 'token');
      config.token = saved;
    }
    if (id === "openssh") config.keys = (await system.publicKeys(config.keys)).map(key => key.publicKey);
    return { config, artifact: artifacts.selection(id) };
  };
  const plan = async input => {
    if (/^(?:connection-|route-|client-observed)/.test(input?.action || "")) return network.plan(input);
    object(input, ["action", "id", "configuration", "expectedRevision"]);
    const { action, expectedRevision } = input;
    if (!["add", "edit", "enable", "disable", "start", "stop", "restart", "remove", "install", "update", "migrate", "uninstall", "sign-in", "sign-out", "serve", "unserve"].includes(action)) throw new ServiceError("invalid", "Choose a supported service action.");
    let id = input.id;
    if (action === "add" && store.domain === "user" && !id) id = "custom-" + randomUUID().replaceAll("-", "").slice(0, 20);
    if (!validId(id) || store.domain === "system" && !["openssh", "tailscale", "cloudflared"].includes(id)) throw new ServiceError("invalid", "Choose a valid service.");
    const previous = store.get(id);
    if (expectedRevision !== (previous?.revision ?? 0)) throw new ServiceError("conflict", "This service changed. Refresh and review again.");
    if (action !== "add" && action !== "install" && !previous) throw new ServiceError("missing", "This service is no longer registered.");
    if (action === "add" && previous) throw new ServiceError("conflict", "This service is already registered.");
    if (action === "uninstall" && store.domain !== "system") throw new ServiceError("invalid", "Remove a custom registration to retain its tools and application files.");
    if (store.domain === 'system' && action === 'remove') throw new ServiceError('invalid', 'Uninstall this service to remove its software while keeping saved settings and identity.');
    if (action === 'migrate' && (store.domain !== 'system' || !previous?.artifact || previous.artifact.manager === 'mise')) throw new ServiceError('invalid', 'Choose an existing service installation that has not moved to Mise yet.');
    if (store.domain === 'system' && ['enable', 'start', 'restart'].includes(action) && !previous?.artifact) throw new ServiceError('artifact', 'Install this service again before enabling it. Its saved identity and configuration are retained.');
    if (action === 'start') {
      if (!previous.enabled) throw new ServiceError('invalid', 'Enable this service to start it now and at container startup.');
      const live = await supervisor.observe(id);
      if (live.unavailable) throw new ServiceError('unavailable', 'Current process status is unavailable. Refresh before starting this service.');
      if (live.up) throw new ServiceError('conflict', 'This service is already running. Refresh to review a restart.');
    }
    const consumers = await consumersOf(id);
    await checkPendingRoutes(id, action);
    if (["remove", "uninstall"].includes(action) && consumers.length) throw new ServiceError("dependencies", "Remove this service’s routes before removing its registration or payload.");
    let control = null;
    if (['sign-in', 'sign-out', 'serve', 'unserve'].includes(action)) {
      if (store.domain !== 'system' || id !== 'tailscale' || !previous?.enabled || !previous.artifact) throw new ServiceError('invalid', 'Enable the managed tailnet connector before changing its authentication or TCP forwarding.');
      control = {};
      if (['serve', 'unserve'].includes(action)) {
        const draft = object(input.configuration, ['listenPort', 'targetPort']);
        for (const field of ['listenPort', ...(action === 'serve' ? ['targetPort'] : [])]) if (!Number.isInteger(draft[field]) || draft[field] < 1024 || draft[field] > 65535) throw new ServiceError('invalid', 'Choose TCP ports between 1024 and 65535.', field);
        control = { listenPort: draft.listenPort, ...(action === 'serve' ? { targetPort: draft.targetPort } : {}) };
      }
    }
    let candidate = {};
    if (["add", "edit", "install"].includes(action)) {
      candidate = await toolLock(() => validate(id, input.configuration));
      // Editing a legacy service keeps its existing runtime. Changing package
      // ownership requires its own explicit migration/update/install review.
      if (action === 'edit' && store.domain === 'system' && previous?.artifact && previous.artifact.manager !== 'mise') delete candidate.artifact;
    }
    else if (["update", "migrate", "restart", "enable", "start"].includes(action)) {
      if (store.domain === 'system') await checkBindings(id, previous.config);
      candidate = store.domain === "system" ? { config: previous.config, ...(['update', 'migrate'].includes(action) ? { artifact: artifacts.selection(id) } : {}) } : await toolLock(() => validate(id, previous.config));
      if (store.domain === "user" && action !== "update" && hash(candidate.receipt) !== hash(previous.receipt)) throw new ServiceError("tool-changed", "The selected tool or executable changed. Review its configuration before enabling it.", "executable");
    }
    const selected = candidate.config || previous?.config;
    if (id === 'tailscale' && store.domain === 'system' && ['enable', 'start', 'restart', 'update', 'migrate'].includes(action)) await networking?.validate(selected);
    const effect = action === 'uninstall' ? 'Stops this service and removes its installed software, old cached versions and dependencies that no other service or pending operation needs. Existing connections may end.' : action === 'migrate' ? 'Installs the image-approved packages through Mise and switches this service to them. A running service restarts; a stopped or disabled service stays stopped. The previous installation is retained for recovery until uninstall.' : ["disable", "remove"].includes(action) ? "Stops this service. Existing connections may end." : action === "start" ? "Starts the stopped service with its pinned configuration. Startup remains enabled." : action === "stop" ? "Stops until the next container start. Startup remains enabled." : action === "edit" && hash(candidate.config) === hash(previous?.config) ? "No configuration change." : "May restart this service. Other services and T3 keep running.";
    return store.plan({ target: id, action, expectedRevision, previous, candidate, control, review: {
      name: selected?.name || id, action, domain: store.domain, effect: control ? action === 'sign-in' ? 'Starts or resumes tailnet sign-in. Device identity and provider policy stay with Tailscale.' : action === 'sign-out' ? 'Signs this connector out. Every route using it will lose access until sign-in is completed again.' : action === 'serve' ? `Forwards tailnet TCP port ${control.listenPort} to container loopback port ${control.targetPort}. Tailnet policy still applies.` : `Removes tailnet TCP forwarding on port ${control.listenPort}.` : effect,
      ...(control ? { control } : {}),
      runAs: store.domain === "user" ? "t3 (current user)" : id === "openssh" ? "root listener; t3 sessions only" : "system service",
      config: publicResource({ config: selected }).config, version: candidate.artifact?.version || previous?.artifact?.version || null,
      downloads: candidate.artifact?.payloads?.map(({ bytes, name, version, sha256, url }) => ({ bytes, name, version: version || candidate.artifact.version, sha256, url })) || [],
      tools: candidate.receipt?.installations || previous?.receipt?.installations || [],
      retains: store.domain === "user" ? "Installed tools, application data and Vault entries are retained. Configuration recovery cannot undo application data changes." : action === 'uninstall' ? 'Saved settings, SSH host keys and provider identities are kept for reinstall. Software still needed by another service is kept. User Mise tools are unchanged.' : "Host and provider identities and previous verified artifacts are retained.",
      packageManager: candidate.artifact?.manager || previous?.artifact?.manager || null,
      requiresFallback: store.domain === 'system' && Boolean(previous?.enabled) && ['edit', 'update', 'migrate', 'restart', 'disable', 'stop', 'remove', 'uninstall', 'sign-out', 'unserve'].includes(action),
      routes: consumers.map(item => item.name || item.id), network: id === 'tailscale' && (selected?.networkMode === 'kernel' || previous?.config.networkMode === 'kernel') ? 'Full networking affects every program in this container. Services manages tailnet routes and split DNS, restores deployment DNS when disconnected, and blocks unsolicited inbound traffic to ordinary listeners. Incoming access uses explicit published routes and tailnet policy. Exit nodes and subnet routing are not enabled.' : "Declaring a port does not publish it. Container port mappings and external network policy are managed separately." } });
  };
  const stopService = async (id, grace) => {
    await supervisor.stop(id, grace);
    if (store.domain === 'system' && id === 'tailscale' && networking) {
      const state = await supervisor.observe(id);
      if (state.up || state.unavailable && networking.needsStopConfirmation?.()) throw new ServiceError('network-cleanup', 'Tailscale has not been confirmed stopped. The inbound filter and saved DNS recovery record were retained.');
      await networking.stopped();
    }
  };
  const prepareNetworking = async resource => {
    if (resource.id !== 'tailscale' || !networking) return;
    // Register an inert s6 entry before acquiring network ownership. If
    // prerequisites fail, Stop/Disable can still confirm there is no payload
    // and retry cleanup through the same supervisor.
    if (resource.config.networkMode === 'kernel') await supervisor.prepare?.(resource.id, resource.config.shutdownMs);
    await networking.prepare(resource);
  };
  const phase = (op, state, detail = {}) => {
    Object.assign(op, { state: "working", phase: state, updatedAt: now(), ...detail });
    store.transaction(() => { store.saveOperation(op); store.event(op.id, { phase: state, ...detail }); });
  };
  const finish = (op, state, detail = {}) => {
    Object.assign(op, { state, phase: state, updatedAt: now(), finishedAt: now(), ...detail });
    store.transaction(() => { store.saveOperation(op); store.event(op.id, { phase: state, ...detail }); });
  };
  const observe = async resource => {
    const state = await supervisor.observe(resource.id), run = store.meta("run:" + resource.id), exit = store.meta("exit:" + resource.id);
    let result = { state: "unknown", at: now(), process: state, run, exit, health: null, ...(resource.restart?.reason ? { reason: resource.restart.reason } : {}) };
    if (state.unavailable && resource.enabled) result.state = "unavailable";
    else if (resource.uninstalled) result.state = "uninstalled";
    else if (!resource.enabled) result.state = "disabled";
    else if (resource.stoppedBoot === boot) result.state = "stopped";
    else if (state.up && run?.revision === resource.revision && run?.boot === boot && run?.payloadPid) {
      const old = store.meta("observation:" + resource.id), interval = resource.config.health.intervalMs;
      result.health = old?.run?.runId === run?.runId && now() - (old.health?.at || 0) < interval ? old.health : await health(resource.config.health, { ssh: resource.id === "openssh" && store.domain === "system" });
      const grace = now() - (run?.startedAt || now()) < resource.config.health.graceMs;
      result.state = result.health.ok ? resource.config.health.kind === "process" ? "running" : "ready" : grace ? "starting" : "unhealthy";
    } else if (state.up) result.state = "starting";
    else if (resource.restart?.exhausted) result.state = resource.restart.code === 'tool-unavailable' || resource.restart.code === 'tool-changed' ? 'tool-unavailable' : "failed";
    else if (resource.restart?.nextAt) result.state = "restarting";
    else if (exit?.boot === boot) result.state = exit.exitCode === 0 ? "exited" : "failed";
    else result.state = "starting";
    if (store.domain === "system" && resource.id === "tailscale" && state.up) {
      result.connection = publicConnection(await system.tailscaleStatus(resource));
    }
    if (store.domain === 'system' && resource.id === 'tailscale' && networking) {
      try { result.networking = await networking.observe(resource, state, result.connection, run?.runId); }
      catch (error) { try { await networking.disconnected?.(); } catch {} result.networking = { mode: resource.config.networkMode || 'userspace', state: 'error', message: error instanceof ServiceError ? error.message : 'Container networking needs attention. Check the deployment and retry.' }; }
      if (result.networking.fatal) {
        try { await supervisor.stop(resource.id, resource.config.shutdownMs); } catch { result.networking.message += ' Stopping the daemon could not be confirmed; check its supervisor.'; }
        store.put({ ...resource, restart: { exhausted: true, reason: result.networking.message } });
        result.state = 'failed'; result.reason = result.networking.message; result.process = await supervisor.observe(resource.id);
      }
    }
    store.setMeta("observation:" + resource.id, result);
    return result;
  };
  const startAndCheck = async resource => {
    const old = await supervisor.observe(resource.id);
    if (!old.up) { await prepareNetworking(resource); await supervisor.start(resource.id, resource.config.shutdownMs); }
    const deadline = now() + Math.max(4000, resource.config.health.graceMs + 2000);
    do {
      if (closed) throw new ServiceError("interrupted", "The controller is restarting; the operation will resume.");
      const status = await observe(resource);
      const networkReady = !status.networking || status.networking.mode !== 'kernel' || ['ready', 'needs-login', 'needs-approval'].includes(status.networking.state);
      if (["ready", "running"].includes(status.state) && networkReady && !['error', 'blocked'].includes(status.networking?.state) && now() - status.run.startedAt >= 300) return;
      if (status.exit?.revision === resource.revision && status.exit?.boot === boot && status.exit?.endedAt > (resource.activatedAt || 0)) {
        if (resource.id !== 'tailscale' && status.exit.exitCode === 0 && resource.config.health.kind === 'process' && resource.config.restart !== 'always') return;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (now() < deadline);
    throw new ServiceError("startup", "The service did not pass its startup check. Review its logs and configuration.");
  };
  const restorePrevious = async op => {
    const original = op.plan.previous;
    await stopService(op.target, original.config.shutdownMs);
    let restored = store.get(op.target);
    if (!op.restored) {
      restored = { ...original, revision: (restored?.revision ?? original.revision) + 1, lastOperationId: op.id, restart: {} };
      store.transaction(() => { store.put(restored); op.restored = true; store.saveOperation(op); });
    }
    if (store.domain === "system") await system.configureSystem(restored, system.paths);
    if (restored.enabled && restored.stoppedBoot !== boot) await startAndCheck(restored); else await observe(restored);
    finish(op, "rolled-back", { recovery: "The previous configuration was restored and checked. Application data was not rolled back." });
  };
  const execute = async op => {
    const { target: id, action } = op, original = op.plan.previous;
    let changed = Boolean(op.activated);
    try {
      if (op.phase === 'restore') { await restorePrevious(op); return; }
      if (op.plan.control) {
        phase(op, 'network-control');
        const current = store.get(id);
        const details = await system.controlTailscale(current, action, op.plan.control);
        if (action === 'sign-out') await networking?.disconnected?.();
        store.transaction(() => { store.put({ ...current, revision: current.revision + 1, details: { ...current.details, ...details }, lastOperationId: op.id }); const run = store.meta('run:' + id); if (run) store.setMeta('run:' + id, { ...run, revision: current.revision + 1 }); Object.assign(op, { state: 'succeeded', phase: 'succeeded', finishedAt: now(), updatedAt: now() }); store.saveOperation(op); store.event(op.id, { phase: 'succeeded' }); });
        return;
      }
      if (op.plan.network) { phase(op, "configure"); await network.execute(op); finish(op, "succeeded"); return; }
      await checkPendingRoutes(id, action);
      if (["disable", "stop", "remove", "uninstall"].includes(action)) {
        if (['remove', 'uninstall'].includes(action) && (await consumersOf(id)).length) throw new ServiceError('dependencies', 'A route now depends on this service. Remove its routes and review again.');
        phase(op, "stopping");
        let current = store.get(id);
        if (current) {
          // Desired intent wins over every exit event or pending restart.
          if (!op.activated) { current = { ...current, revision: current.revision + 1, enabled: action === "stop" ? current.enabled : false, stoppedBoot: action === "stop" ? boot : null, restart: {}, config: { ...current.config, enabled: action === "stop" ? current.enabled : false }, lastOperationId: op.id }; store.transaction(() => { store.put(current); op.activated = true; store.saveOperation(op); }); }
          await stopService(id, current.config.shutdownMs);
          if (action === "remove") { store.remove(id); await fs.rm(path.join(store.root, "logs", id), { recursive: true, force: true }); }
          if (action === "uninstall") {
            phase(op, 'removing-software');
            const removal = await artifacts.remove(id, { references: () => packageReferences(id, op.id) });
            store.transaction(() => { store.put({ ...current, artifact: null, uninstalled: true, removal }); op.removal = removal; store.saveOperation(op); });
          }
          if (action !== "remove") await observe(store.get(id));
        }
        finish(op, "succeeded"); return;
      }
      let resource = store.get(id);
      if (!op.activated) {
        phase(op, "preflight");
        const checkStart = async () => { if (action === 'start') {
          const live = await supervisor.observe(id);
          if (live.unavailable || live.up) throw new ServiceError('conflict', 'Process status changed. Refresh before starting this service; no running process was restarted.');
        } };
        await checkStart();
        let candidate = op.plan.candidate;
        if (store.domain === "user") {
          await toolLock(async () => {
            const validated = await validate(id, candidate.config || original.config);
            if (candidate.receipt && hash(validated.receipt) !== hash(candidate.receipt) || candidate.secretReceipts && hash(validated.secretReceipts) !== hash(candidate.secretReceipts)) throw new ServiceError("conflict", "A selected tool or credential changed. Review the preserved draft again.");
            candidate = { ...candidate, ...validated };
            await checkStart();
            resource = { ...original, ...candidate, id, kind: "service", uninstalled: false, revision: (original?.revision ?? 0) + 1, enabled: ["enable", "restart"].includes(action) ? true : action === 'start' ? original.enabled : candidate.config.enabled, stoppedBoot: null, restart: {}, activatedAt: now(), lastOperationId: op.id };
            // Registration/pins and tool deletion share the harness lock.
            store.transaction(() => { store.put(resource); op.activated = true; store.saveOperation(op); });
          });
        } else {
          await checkBindings(id, candidate.config || original.config);
          if (id === 'tailscale') await networking?.validate(candidate.config || original.config);
          if (candidate.artifact) { phase(op, "stage"); candidate = { ...candidate, artifact: await artifacts.install(id, candidate.artifact) }; }
          await checkStart();
          resource = { ...original, ...candidate, id, kind: "service", uninstalled: false, removal: null, revision: (original?.revision ?? 0) + 1, enabled: ["enable", "restart"].includes(action) ? true : ['update', 'migrate', 'start'].includes(action) ? original?.enabled : candidate.config?.enabled ?? original?.enabled, stoppedBoot: ['update', 'migrate'].includes(action) ? original?.stoppedBoot : null, restart: {}, activatedAt: now(), lastOperationId: op.id };
          store.transaction(() => { store.put(resource); op.activated = true; store.saveOperation(op); });
        }
        op.activated = true; changed = true; store.saveOperation(op);
      }
      // A lost controller response after activation attaches to the same run.
      // It must not stop/restart a payload that this operation already started.
      const live = await supervisor.observe(id), run = store.meta("run:" + id);
      if (op.phase === "activate" && live.up && run?.revision === resource.revision) { await startAndCheck(resource); finish(op, "succeeded"); return; }
      const comparable = config => { if (!config) return null; const { name, ...rest } = config; return rest; };
      if (action === "edit" && original && hash(comparable(resource.config)) === hash(comparable(original.config)) && live.up && hash(resource.receipt) === hash(original.receipt) && hash(resource.artifact) === hash(original.artifact)) {
        store.setMeta("run:" + id, { ...run, revision: resource.revision, originalLaunchRevision: run.originalLaunchRevision || run.revision });
        await observe(resource); finish(op, "succeeded"); return;
      }
      phase(op, "configure");
      if (action !== 'start') await stopService(id, resource.config.shutdownMs);
      if (store.domain === "system") {
        const details = await system.configureSystem(resource, system.paths);
        resource = { ...resource, details }; store.put(resource);
      }
      if (resource.enabled && resource.stoppedBoot !== boot) { phase(op, "activate"); await startAndCheck(resource); }
      else await observe(resource);
      finish(op, "succeeded");
    } catch (error) {
      if (closed) return;
      if (op.plan.network && ['operation-pending', 'controller-unavailable'].includes(error.code)) { phase(op, 'waiting-for-connector'); return; }
      const message = error instanceof ServiceError ? error.message : "The service operation could not finish. Existing artifacts and identity were retained.";
      if (changed && original?.config && !["disable", "stop", "remove", "uninstall"].includes(action)) {
        phase(op, "restore", { error: message });
        try { await restorePrevious(op); }
        catch { if (!closed) finish(op, "failed", { error: message, recovery: "The previous configuration is retained, but recovery did not pass. Review logs before retrying." }); }
      } else {
        if (changed) { const current = store.get(id); if (current) store.put({ ...current, restart: { exhausted: true, reason: message } }); await stopService(id).catch(() => {}); }
        finish(op, "failed", { error: message, code: error.code || "operation" });
      }
    }
  };
  const reconcile = async () => {
    if (working || closed) return;
    working = true;
    try {
      await networking?.orphaned();
      for (const operation of store.pending()) { if (closed) break; await execute(operation); }
      for (let resource of services()) {
        if (closed) break;
        const status = await observe(resource);
        if (!resource.enabled || resource.uninstalled || resource.stoppedBoot === boot || status.process.up || resource.restart?.exhausted || status.networking?.fatal) continue;
        const exit = status.exit, restart = resource.restart || {};
        if (exit?.boot === boot && exit.runId !== restart.exitRun) {
          if (resource.config.restart === "never" || resource.config.restart === "on-failure" && exit.exitCode === 0) continue;
          const failures = (restart.failures || []).filter(at => now() - at < 5 * 60_000);
          failures.push(now());
          resource = { ...resource, restart: { failures, exitRun: exit.runId, exhausted: failures.length > 5, nextAt: now() + Math.min(60000, 1000 * 2 ** failures.length) + Math.floor(Math.random() * 500) } };
          store.put(resource); continue;
        }
        if (restart.nextAt && restart.nextAt > now()) continue;
        // A boot or interrupted controller reconciles the same desired run.
        // s6's FIFO is its exclusive owner; there is no PID-file adoption.
        try {
          if (store.domain === "user") {
            const resolved = await tools.resolve(resource.config);
            if (hash(resolved.receipt) !== hash(resource.receipt)) throw new ServiceError("tool-changed", "The selected executable or tool environment changed. Review this service before restarting.");
            const credentials = await secrets(resource.config);
            if (hash(credentials.receipts) !== hash(resource.secretReceipts || [])) throw new ServiceError('credential-changed', 'A referenced Vault credential changed. Review this service before restarting.');
          } else await system.configureSystem(resource, system.paths);
          await prepareNetworking(resource);
          await supervisor.start(resource.id, resource.config.shutdownMs);
          if (restart.nextAt) store.put({ ...resource, restart: { ...restart, nextAt: null } });
        } catch (error) {
          store.put({ ...resource, restart: { ...restart, exhausted: true, code: error.code, reason: error instanceof ServiceError ? error.message : "Service recovery needs attention." } });
          store.setMeta("observation:" + resource.id, { ...status, state: error.code === "tool-unavailable" ? "tool-unavailable" : "failed", reason: error instanceof ServiceError ? error.message : "Service recovery needs attention.", at: now() });
        }
      }
    } finally { working = false; }
  };
  const apply = input => { object(input, ["planId", "expectedRevision", "idempotencyKey", 'acknowledgeAccessImpact']); const operation = store.apply(input); queueMicrotask(() => void reconcile()); return publicOperation(operation); };
  return { plan: async input => { const value = await plan(input); return { id: value.id, domain: value.domain, target: value.target, expectedRevision: value.expectedRevision, expiresAt: value.expiresAt, review: value.review }; }, apply, snapshot, reconcile,
    requirements: async () => ({ tailscale: networking ? await networking.requirements({ fresh: true }) : null }),
    logs: (id, after) => { if (!validId(id) || !store.get(id)) throw new ServiceError("missing", "Choose a registered service."); return readLogs(store.root, id, after); },
    operation: id => { const op = store.operation(id); if (!op) throw new ServiceError("missing", "This operation is no longer available."); return publicOperation(op); },
    requiresMaintenance: input => {
      if (store.domain === 'system') return true;
      if (input.planId) return Boolean(store.review(input.planId)?.systemPlan);
      const route = input.id ? store.get(input.id) : null;
      const connection = store.get(input.configuration?.connection || route?.connection);
      return ['route-save', 'route-remove'].includes(input.action) && connection?.provider === 'tailscale';
    },
    authentication: async id => { if (store.domain !== 'system' || id !== 'tailscale') throw new ServiceError('invalid', 'Choose the managed tailnet connector.'); const resource = store.get(id); if (!resource?.enabled || !resource.artifact) throw new ServiceError('missing', 'Enable Tailscale first.'); const state = await system.tailscaleStatus(resource); return { state: state.state, url: state.authUrl, starting: store.pending().some(op => op.target === id && op.action === 'sign-in') }; },
    references: localReferences,
    ports: () => services().filter(item => !item.uninstalled).map(item => ({ id: item.id, endpoints: item.config.endpoints })),
    events: after => store.events(after),
    start: () => { if (!timer) { void reconcile(); timer = setInterval(() => void reconcile(), 1000); } },
    close: () => { closed = true; clearInterval(timer); timer = null; },
    idle: () => !working, terminal };
}
