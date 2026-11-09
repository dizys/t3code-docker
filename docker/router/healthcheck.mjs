// Probe the same paths the router serves, within one Docker healthcheck budget.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePrefix, setupStarts } from "./router.mjs";

export async function checkHealth(env = process.env, { timeoutMs = 4000 } = {}) {
  const singlePort = env.T3_SINGLE_PORT?.trim();
  const port = singlePort || String(env.T3CODE_PORT || "3773").trim();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return false;
  const paths = ["/.well-known/t3/environment"];
  // Docker sees the original environment, before entrypoint.sh defaults
  // empty values with :=. Apply those defaults here too.
  if (singlePort && setupStarts(env.T3_SETUP_ENABLED || "1")) {
    const prefix = normalizePrefix(env.T3_SETUP_BASE_PATH);
    if (!prefix) return false;
    paths.push(`${prefix}/hello`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return (await Promise.all(paths.map((pathname) => new Promise((resolve) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: pathname, signal: controller.signal }, (response) => {
        response.on("end", () => resolve(response.statusCode >= 200 && response.statusCode < 400));
        response.on("error", () => resolve(false));
        response.resume();
      });
      request.on("error", () => resolve(false));
    })))).every(Boolean);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await checkHealth() ? 0 : 1;
}
