import http from "node:http";
import { paths } from "./paths.mjs";
import { ServiceError } from "./store.mjs";
export function serviceRequest(domain, action, input = {}, { env = process.env, timeout = 25000 } = {}) {
  if (!["user", "system"].includes(domain)) return Promise.reject(new ServiceError("invalid", "Choose a user or system service."));
  const data = JSON.stringify({ action, input });
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: paths(domain, env).socket, path: "/v1", method: "POST", timeout, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, res => {
      let text = "", bytes = 0;
      res.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) req.destroy(new Error("response-too-large")); else text += chunk; });
      res.on("end", () => { try { const body = JSON.parse(text); if (res.statusCode >= 400) reject(new ServiceError(body.code, body.error, body.field)); else resolve(body); } catch (error) { reject(error); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => reject(new ServiceError("controller-unavailable", "The service controller is unavailable. Existing services may still be running. Reconnect to inspect them; do not submit another operation.")));
    req.end(data);
  });
}
export const SERVICE_ROUTES = ["/services", "/services/plan", "/services/apply", "/services/operation", "/services/logs", "/services/events", "/services/inventory", "/services/authentication", "/services/requirements"];
export function createServicesAPI({ request = serviceRequest } = {}) {
  const snapshot = async () => {
    const domains = await Promise.all(["user", "system"].map(async domain => {
      try { return { domain, ...await request(domain, "snapshot") }; }
      catch (error) { const rootless = domain === 'system' && process.env.T3_SERVICES_SYSTEM_MODE === 'rootless'; return { domain, error: rootless ? 'System services need the root entrypoint and protected services volume. Custom services remain available in this rootless container.' : error.message, code: rootless ? 'rootless' : error.code, services: [], operations: [], connections: [], routes: [], catalogue: [] }; }
    }));
    return { ok: true, observedAt: Date.now(), domains, services: domains.flatMap(item => item.services.map(service => ({ ...service, domain: item.domain }))), operations: domains.flatMap(item => item.operations), connections: domains.flatMap(item => item.connections), routes: domains.flatMap(item => item.routes) };
  };
  const handle = async (route, input = {}) => {
    if (route === "/services") return snapshot();
    const { domain, ...args } = input;
    return request(domain, route.slice("/services/".length), args);
  };
  const requiresMaintenance = async (route, input) => {
    if (!['/services/plan', '/services/apply', '/services/authentication'].includes(route)) return false;
    if (input.domain === 'system') return true;
    return Boolean((await request('user', 'permissions', input)).maintenance);
  };
  return { snapshot, handle, requiresMaintenance };
}
