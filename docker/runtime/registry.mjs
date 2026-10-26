import { REGISTRY, REPOSITORY } from "./distribution-spec.mjs";

const tokens = new WeakMap();
async function tokenFor(fetcher, fresh = false) {
  let cached = tokens.get(fetcher);
  if (fresh || !cached || cached.expiresAt <= Date.now()) {
    cached = { expiresAt: Date.now() + 240_000, promise: null };
    cached.promise = (async () => {
      const url = `${REGISTRY}/token?${new URLSearchParams({ service: "ghcr.io", scope: `repository:${REPOSITORY}:pull` })}`;
      const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Could not access the public native runtime registry (HTTP ${response.status}).`);
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 64 * 1024) throw new Error("Native registry authentication response is too large."); chunks.push(Buffer.from(chunk)); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof data.token !== "string" || !data.token || data.token.length > 32_768) throw new Error("The native registry did not issue public read access.");
      if (Number.isFinite(data.expires_in)) cached.expiresAt = Math.min(cached.expiresAt, Date.now() + Math.max(0, data.expires_in - 30) * 1000);
      return data.token;
    })().catch((error) => { tokens.delete(fetcher); throw error; });
    tokens.set(fetcher, cached);
  }
  return cached.promise;
}

// Only an anonymous pull token for this public package is sent. Redirects never
// carry it to storage hosts, and the user's GitHub credentials are not used.
export async function registryRequest(url, { fetcher = fetch, headers = {}, timeout = 15_000 } = {}) {
  const target = new URL(url);
  if (target.origin !== REGISTRY || !target.pathname.startsWith(`/v2/${REPOSITORY}/`) || target.username || target.password) throw new Error("Unsupported native registry address.");
  const request = async (fresh) => fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(timeout), headers: { ...headers, authorization: `Bearer ${await tokenFor(fetcher, fresh)}` } });
  let response = await request(false);
  if (response.status === 401) { await response.body?.cancel(); response = await request(true); }
  return response;
}
