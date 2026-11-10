// Routes describe a deliberate network binding. They never publish a port or
// adopt an externally owned process as a local managed service.
import net from "node:net";
import { randomUUID } from "node:crypto";
import { object, validId } from "./definition.mjs";
import { ServiceError, hash } from "./store.mjs";
const text = (value, max = 100) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
export const validHost = value => typeof value === "string" && (net.isIP(value) > 0 || value.length <= 253 && /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/.test(value));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function clientConfiguration(route, fingerprint = null) {
  if (!validHost(route.host) || !Number.isInteger(route.port) || route.port < 1 || route.port > 65535) throw new ServiceError("invalid", "Choose a valid client hostname and port.");
  const name = "t3-" + route.id.slice(-12), cloud = route.topology === "cloudflare";
  return { command: `ssh ${cloud ? "-o " + quote("ProxyCommand=cloudflared access ssh --hostname " + route.host) + " " : ""}-p ${route.port} ${quote("t3@" + route.host)}`,
    config: `Host ${name}\n  HostName ${route.host}\n  User t3\n  Port ${route.port}\n  IdentitiesOnly yes\n${cloud ? "  ProxyCommand cloudflared access ssh --hostname %h\n" : ""}`,
    fingerprint, note: cloud ? "Install cloudflared on your client and complete your Cloudflare Access policy. An HTTP quick tunnel is not an SSH route." : "Check the host fingerprint through this trusted console before accepting the first connection. Port mappings and network policy must already allow this route." };
}
export function createNetwork({ store, systemSnapshot = async () => ({ services: [] }), systemRequest }) {
  const targetService = async (domain, id) => domain === "user" ? store.get(id) : (await systemSnapshot()).services.find(row => row.id === id);
  const plan = async input => {
    if (store.domain !== "user") throw new ServiceError("invalid", "Connection and route registrations belong to the user controller.");
    object(input, ["action", "id", "configuration", "expectedRevision"]);
    const action = input.action;
    if (!["connection-save", "connection-remove", "route-save", "route-remove", "client-observed"].includes(action)) throw new ServiceError("invalid", "Choose a supported network action.");
    const id = input.id || (action.startsWith("connection") ? "connection-" : "route-") + randomUUID().replaceAll("-", "").slice(0, 20);
    if (!validId(id)) throw new ServiceError("invalid", "Choose a valid network registration.");
    const previous = store.get(id), expectedKind = action.startsWith("connection") ? "connection" : "route";
    if (action.startsWith('connection') && store.pending().some(op => op.plan.network && op.plan.candidate?.connection === id)) throw new ServiceError('busy', 'A route operation is using this connection. Wait for it to finish before changing the connection.');
    if (previous && previous.kind !== expectedKind || input.expectedRevision !== (previous?.revision || 0)) throw new ServiceError("conflict", "This network registration changed. Review it again.");
    if (action.endsWith("remove") && !previous) throw new ServiceError("missing", "This registration is already gone.");
    if (action === "connection-remove" && store.list().some(row => row.kind === "route" && row.connection === id)) throw new ServiceError("dependencies", "Move or remove the routes using this connection first.");
    let candidate = previous, systemPlan = null;
    if (action === "connection-save") {
      const draft = object(input.configuration, ["name", "provider", "notes"]);
      if (!text(draft.name) || !["existing-network", "host-tailscale", "sidecar-cloudflare", "tailscale", "cloudflared"].includes(draft.provider) || draft.notes !== undefined && draft.notes !== '' && !text(draft.notes, 1000)) throw new ServiceError("invalid", "Enter a connection name and choose its owner.");
      if (previous && previous.provider !== draft.provider && store.list().some(row => row.kind === 'route' && row.connection === id)) throw new ServiceError('dependencies', 'Move or remove this connection’s routes before changing its owner.');
      candidate = { id, kind: "connection", name: draft.name.trim(), provider: draft.provider, ownership: ["tailscale", "cloudflared"].includes(draft.provider) ? "managed-system" : "external", notes: draft.notes || "", serviceId: ["tailscale", "cloudflared"].includes(draft.provider) ? draft.provider : null };
    } else if (action === "route-save") {
      const draft = object(input.configuration, ["name", "serviceDomain", "serviceId", "connection", "endpoint", "host", "port", "topology"]);
      if (!text(draft.name) || !["system", "user"].includes(draft.serviceDomain) || !validId(draft.serviceId) || !validHost(draft.host) || !Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535 || !["host-mapping", "container-network", "tailnet", "cloudflare"].includes(draft.topology)) throw new ServiceError("invalid", "Enter a route name, reachable client hostname, port and topology.");
      const connection = store.get(draft.connection);
      if (connection?.kind !== "connection") throw new ServiceError("missing", "Choose a configured connection first.", "connection");
      const service = await targetService(draft.serviceDomain, draft.serviceId);
      const endpoint = service?.config?.endpoints?.find(item => item.port === draft.endpoint);
      if (!endpoint) throw new ServiceError("invalid", "Choose an endpoint declared by the saved service.", "endpoint");
      const requiredTopology = { tailscale: 'tailnet', 'host-tailscale': 'tailnet', cloudflared: 'cloudflare', 'sidecar-cloudflare': 'cloudflare' }[connection.provider];
      if (requiredTopology && draft.topology !== requiredTopology) throw new ServiceError('protocol', 'Choose the topology supported by this connection.', 'topology');
      if (service.id === 'openssh' && draft.serviceDomain === 'system' && service.config.listen === '127.0.0.1' && ['host-mapping', 'container-network'].includes(draft.topology)) throw new ServiceError('listener', 'This SSH listener is loopback-only. Select Container interfaces in SSH before using a host mapping or sidecar.', 'topology');
      if (draft.topology === "cloudflare" && endpoint.protocol !== "ssh") throw new ServiceError("protocol", "This Cloudflare Access recipe is for SSH. Publish HTTP from Ports.");
      if (connection.provider === 'tailscale') {
        const systems = await systemSnapshot(), connector = systems.services.find(item => item.id === 'tailscale');
        if (!connector?.enabled || connector.observation?.connection?.state !== 'Running' || !systemRequest) throw new ServiceError('authentication', 'Enable and sign in to the managed tailnet connector before adding an inbound route.');
        if (store.list().some(item => item.kind === 'route' && item.id !== id && store.get(item.connection)?.provider === 'tailscale' && item.port === draft.port)) throw new ServiceError('port-conflict', 'That tailnet TCP port already belongs to another service route.', 'port');
        systemPlan = await systemRequest('plan', { action: 'serve', id: 'tailscale', expectedRevision: connector.revision, configuration: { listenPort: draft.port, targetPort: draft.endpoint } });
      }
      candidate = { id, kind: "route", name: draft.name, serviceDomain: draft.serviceDomain, service: draft.serviceId, connection: connection.id, endpoint, host: draft.host, port: draft.port, topology: draft.topology, verified: null,
        generation: hash([service.revision, service.details?.hostFingerprint, connection.revision, connection.provider === 'tailscale' ? (await systemSnapshot()).services.find(item => item.id === 'tailscale')?.details?.authGeneration || null : null, draft.host, draft.port, draft.endpoint]) };
    } else if (action === "client-observed") {
      if (!previous || input.configuration?.reported !== true) throw new ServiceError("invalid", "Report a successful test from your client after checking the fingerprint.");
      const live = (await snapshot()).routes.find(route => route.id === id);
      if (!live || ['blocked', 'service-not-ready'].includes(live.state)) throw new ServiceError('not-ready', 'Restore the local service and connection before recording a successful client test.');
      candidate = { ...previous, generation: live.currentGeneration, verified: { at: Date.now(), method: "user-reported", generation: live.currentGeneration } };
    }
    if (action === 'route-remove' && store.get(previous.connection)?.provider === 'tailscale' && systemRequest) {
      const systems = await systemSnapshot(), connector = systems.services.find(item => item.id === 'tailscale');
      if (connector?.details?.forwarding?.some(item => item.listenPort === previous.port && item.targetPort === previous.endpoint.port)) {
        systemPlan = await systemRequest('plan', { action: 'unserve', id: 'tailscale', expectedRevision: connector.revision, configuration: { listenPort: previous.port } });
      }
    }
    if (action === 'route-save' && previous && store.get(previous.connection)?.provider === 'tailscale' && (previous.connection !== candidate.connection || previous.port !== candidate.port || previous.endpoint.port !== candidate.endpoint.port)) throw new ServiceError('dependencies', 'Add and test a replacement route first, then remove this managed route. Its forwarding is retained until explicitly removed.');
    const route = candidate?.kind === 'route' ? candidate : null;
    const connection = route && store.get(route.connection), service = route && await targetService(route.serviceDomain, route.service);
    const dependencies = route ? { connection: connection?.revision, service: service?.revision, generation: route.generation } : null;
    return store.plan({ target: id, action, expectedRevision: input.expectedRevision, network: true, previous, candidate, systemPlan, dependencies,
      review: { name: candidate?.name || id, action, domain: "user", requiresFallback: Boolean(systemPlan?.review.requiresFallback), effect: systemPlan ? systemPlan.review.effect : action.endsWith("remove") ? "Removes this registration. It does not stop an external connector or revoke its provider account." : "Saves network configuration. It does not change Docker, a host connector, firewall, tailnet policy or Cloudflare Access policy.", config: candidate, retains: "Service identities, application data and external provider configuration are retained." } });
  };
  const execute = async op => {
    const route = op.plan.candidate;
    if (op.action.startsWith('connection') && store.pending().some(other => other.id !== op.id && other.plan.network && other.plan.candidate?.connection === op.target)) throw new ServiceError('busy', 'A route operation is using this connection. Let it finish before changing the connection.');
    if (route?.kind === 'route' && !op.nestedComplete) {
      const connection = store.get(route.connection), service = await targetService(route.serviceDomain, route.service);
      if (!connection || !service || connection.revision !== op.plan.dependencies.connection || service.revision !== op.plan.dependencies.service || !service.config.endpoints.some(item => item.port === route.endpoint.port && item.protocol === route.endpoint.protocol)) throw new ServiceError('conflict', 'The service endpoint or connection changed. Review this route again.');
      if (op.action === 'client-observed') {
        const live = (await snapshot()).routes.find(item => item.id === route.id);
        if (!live || live.currentGeneration !== op.plan.dependencies.generation || ['blocked', 'service-not-ready'].includes(live.state)) throw new ServiceError('conflict', 'This route changed since its client test was reviewed. Test and review it again.');
      }
    }
    if (op.action === 'connection-remove' && store.list().some(item => item.kind === 'route' && item.connection === op.target)) throw new ServiceError('dependencies', 'A route now uses this connection. Move its routes and review again.');
    if (op.plan.systemPlan && !op.nestedComplete) {
      const plan = op.plan.systemPlan;
      let operation = await systemRequest('apply', { planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: op.id, acknowledgeAccessImpact: op.accessImpactAcknowledged });
      const deadline = Date.now() + 30000;
      while (['committed', 'working', 'recovering'].includes(operation.state) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        operation = await systemRequest('operation', { id: operation.id });
      }
      if (['committed', 'working', 'recovering'].includes(operation.state)) throw new ServiceError('operation-pending', 'The existing forwarding operation is still running.');
      if (operation.state !== 'succeeded') throw new ServiceError('forwarding', operation.error || 'Tailnet forwarding has not completed. Inspect its existing operation in Services before retrying.');
      op.nestedComplete = operation.id; store.saveOperation(op);
    }
    store.transaction(() => {
      if (op.action.endsWith("remove")) store.remove(op.target);
      else store.put({ ...op.plan.candidate, revision: op.plan.expectedRevision + 1, lastOperationId: op.id });
    });
  };
  const snapshot = async () => {
    let systems;
    try { systems = await systemSnapshot(); } catch { systems = null; }
    const connections = store.list().filter(row => row.kind === "connection").map(row => {
      const service = systems?.services?.find(item => item.id === row.serviceId);
      return { ...row, authGeneration: service?.details?.authGeneration || null, state: row.ownership === "external" ? "external" : service?.observation?.connection?.state === "Running" ? "authenticated" : service?.observation?.state || "unavailable" };
    });
    const routes = store.list().filter(row => row.kind === "route").map(row => {
      const service = row.serviceDomain === "user" ? store.get(row.service) : systems?.services?.find(item => item.id === row.service);
      const connection = connections.find(item => item.id === row.connection);
      const generation = service && connection ? hash([service.revision, service.details?.hostFingerprint, connection.revision, connection.provider === 'tailscale' ? connection.authGeneration : null, row.host, row.port, row.endpoint.port]) : null;
      const observation = row.serviceDomain === "user" ? store.meta("observation:" + row.service) : service?.observation;
      const local = ["running", "ready"].includes(observation?.state);
      const forwarding = systems?.services?.find(item => item.id === 'tailscale')?.details?.forwarding;
      const routeApplied = connection?.provider !== 'tailscale' || forwarding?.some(item => item.listenPort === row.port && item.targetPort === row.endpoint.port);
      const connectorReady = connection?.ownership === 'external' || connection?.provider === 'tailscale' && connection.state === 'authenticated' || connection?.provider === 'cloudflared' && ['running', 'ready'].includes(connection.state);
      const state = !service || !connection || !routeApplied ? "blocked" : !local || !connectorReady ? "service-not-ready" : row.verified?.generation === generation ? "client-reported" : "client-test-needed";
      return { ...row, state, currentGeneration: generation, verificationStale: Boolean(row.verified && row.verified.generation !== generation), client: row.endpoint.protocol === "ssh" ? clientConfiguration(row, service?.details?.hostFingerprint) : null };
    });
    return { connections, routes };
  };
  return { plan, execute, snapshot };
}
