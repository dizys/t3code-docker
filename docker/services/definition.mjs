import path from "node:path";
import { ServiceError } from "./store.mjs";

export const validId = id => typeof id === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(id);
const fail = (message, field) => { throw new ServiceError("invalid", message, field); };
export function object(value, keys, field = "configuration") {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail("Use only the supported " + field + " fields.", field);
  return value;
}
const text = (value, max, field, empty = false) => {
  if (typeof value !== "string" || value.includes("\0") || value.length > max || (!empty && !value.trim())) fail("Enter a valid " + field + ".", field);
  return value;
};
const integer = (value, min, max, field) => { if (!Number.isInteger(value) || value < min || value > max) fail(`Choose ${field} between ${min} and ${max}.`, field); return value; };
const absolute = (value, field) => { text(value, 4096, field); if (!path.isAbsolute(value)) fail("Use an absolute " + field + ".", field); return path.normalize(value); };
export function customDefinition(input) {
  object(input, ["name", "mode", "executable", "argv", "script", "shell", "cwd", "tools", "env", "secrets", "restart", "health", "shutdownMs", "enabled", "endpoints"]);
  const mode = input.mode;
  if (!["executable", "mise", "script"].includes(mode)) fail("Choose an executable, installed tool, or shell script.", "mode");
  const argv = input.argv ?? [];
  if (!Array.isArray(argv) || argv.length > 128) fail("Use at most 128 literal arguments.", "argv");
  argv.forEach(value => text(value, 8192, "argv", true));
  const tools = input.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 12) fail("Select at most twelve exact installed tools.", "tools");
  const selected = tools.map(tool => {
    object(tool, ["tool", "version"]);
    if (typeof tool.tool !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_@./:+-]{0,127}$/.test(tool.tool) || typeof tool.version !== "string" || !/^\d+\.[0-9A-Za-z._+-]{1,62}$/.test(tool.version)) fail("Select an exact installed tool version.", "tools");
    return { tool: tool.tool, version: tool.version };
  });
  if (new Set(selected.map(tool => tool.tool)).size !== selected.length) fail("Select each tool once.", "tools");
  if (mode === "mise" && !tools.length) fail("Choose an installed tool first.", "tools");
  const env = input.env ?? {}, secrets = input.secrets ?? {};
  for (const [values, field] of [[env, "env"], [secrets, "secrets"]]) {
    object(values, Object.keys(values), field);
    if (Object.keys(values).length > 64) fail("Use at most 64 variables.", field);
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || /^(?:T3_SETUP_|T3_SERVICES_|MISE_|LD_|DYLD_|NODE_OPTIONS$|BASH_ENV$|ENV$)/.test(key)) fail("That environment variable is reserved for infrastructure.", field);
      text(value, field === "secrets" ? 128 : 8192, field, field === "env");
      if (field === "secrets" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) fail("Choose a saved Vault credential.", field);
      if (Object.hasOwn(env, key) && Object.hasOwn(secrets, key)) fail("Each variable can have one value source.", field);
    }
  }
  const restart = input.restart ?? "on-failure";
  if (!["never", "on-failure", "always"].includes(restart)) fail("Choose a restart policy.", "restart");
  const health = input.health ?? { kind: "process" };
  object(health, ["kind", "port", "path", "intervalMs", "graceMs"]);
  if (!["process", "tcp", "http"].includes(health.kind)) fail("Choose process, TCP, or HTTP health.", "health");
  const endpoints = input.endpoints ?? [];
  if (!Array.isArray(endpoints) || endpoints.length > 8) fail("Declare at most eight local endpoints.", "endpoints");
  const ports = endpoints.map(endpoint => { object(endpoint, ["port", "protocol"]); integer(endpoint.port, 1024, 65535, "port"); if (!["tcp", "http", "ssh"].includes(endpoint.protocol)) fail("Choose an endpoint protocol.", "endpoints"); return { port: endpoint.port, protocol: endpoint.protocol }; });
  if (new Set(ports.map(item => item.port)).size !== ports.length) fail("Declare each port once.", "endpoints");
  if (health.kind !== "process") {
    integer(health.port, 1024, 65535, "health port");
    if (!ports.some(item => item.port === health.port && (health.kind !== "http" || item.protocol === "http"))) fail("Declare the local health endpoint first.", "health");
  }
  const healthPath = health.path ?? "/";
  if (typeof healthPath !== "string" || !/^\/(?!\/)[^\s#]{0,1023}$/.test(healthPath)) fail("Use a local HTTP path.", "health");
  if (typeof (input.enabled ?? false) !== "boolean") fail("Choose whether to enable after adding.", "enabled");
  const executable = mode === "script" ? absolute(input.shell ?? "/bin/bash", "shell") : text(input.executable, 4096, "executable");
  if (mode === "executable") absolute(executable, "executable");
  if (mode === "mise" && (executable.includes("/") || executable.startsWith("-"))) fail("Choose a binary name from the selected tool environment.", "executable");
  return { name: text(input.name, 100, "name").trim(), mode, executable, argv: [...argv],
    ...(mode === "script" ? { script: text(input.script, 32768, "script"), shell: executable } : {}),
    cwd: absolute(input.cwd, "working directory"), tools: selected, env: { ...env }, secrets: { ...secrets }, restart,
    health: { kind: health.kind, ...(health.kind !== "process" ? { port: health.port, path: healthPath } : {}), intervalMs: integer(health.intervalMs ?? 15000, 1000, 300000, "health interval"), graceMs: integer(health.graceMs ?? 10000, 0, 300000, "startup grace") },
    shutdownMs: integer(input.shutdownMs ?? 10000, 100, 30000, "shutdown time"), enabled: input.enabled ?? false, endpoints: ports };
}

export function systemDefinition(id, input) {
  if (input && typeof (input.enabled ?? false) !== 'boolean') fail('Choose whether to enable the service.', 'enabled');
  if (id === "openssh") {
    object(input, ["port", "listen", "keys", "enabled", "name"]);
    integer(input.port ?? 2222, 1024, 65535, "port");
    if (!["127.0.0.1", "0.0.0.0"].includes(input.listen ?? "127.0.0.1")) fail("Choose a loopback or container-interface listener.", "listen");
    if (!Array.isArray(input.keys) || !input.keys.length || input.keys.length > 32) fail("Authorize at least one public key, up to 32.", "keys");
    return { name: "SSH", port: input.port ?? 2222, listen: input.listen ?? "127.0.0.1", keys: input.keys.map(key => text(key, 16384, "keys")), enabled: Boolean(input.enabled), restart: "on-failure", shutdownMs: 10000, health: { kind: "tcp", port: input.port ?? 2222, intervalMs: 15000, graceMs: 5000 }, endpoints: [{ protocol: "ssh", port: input.port ?? 2222 }] };
  }
  if (id === "tailscale") {
    object(input, ["hostname", "enabled", "networkMode"]);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.hostname ?? "t3code")) fail("Use a DNS hostname for this tailnet device.", "hostname");
    if (!["userspace", "kernel"].includes(input.networkMode ?? "userspace")) fail("Choose published routes only or full container networking.", "networkMode");
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('Choose whether to enable Tailscale.', 'enabled');
    return { name: "Tailscale", hostname: input.hostname ?? "t3code", networkMode: input.networkMode ?? "userspace", enabled: Boolean(input.enabled), restart: "on-failure", shutdownMs: 10000, endpoints: [], health: { kind: "process", intervalMs: 15000, graceMs: 5000 } };
  }
  if (id === "cloudflared") {
    object(input, ["token", "enabled"]);
    // A token is supplied only on replacement. Never echo it in validation.
    if (input.token !== undefined && (typeof input.token !== "string" || !/^[A-Za-z0-9_=-]{80,8192}$/.test(input.token))) fail("Enter the named tunnel connector token.", "token");
    return { name: "Cloudflare Tunnel", ...(input.token ? { token: input.token } : {}), enabled: Boolean(input.enabled), restart: "on-failure", shutdownMs: 10000, endpoints: [], health: { kind: "process", intervalMs: 15000, graceMs: 5000 } };
  }
  throw new ServiceError("invalid", "Choose a service from the image catalogue.");
}
