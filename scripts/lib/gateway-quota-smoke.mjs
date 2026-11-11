// Exercises the built T3 reader, RPC encoding and config stream. All credentials
// and upstream replies are synthetic; the fixture cannot forward an API call.
import assert from "node:assert/strict";
import http from "node:http";

export async function verifyGatewayQuota({ api, gatewayT3, until }) {
  const key = "quota-smoke-management", sourceId = "cliproxy-quota-smoke", requests = [];
  const reset = "2099-01-01T00:00:00.000Z";
  let failing = false, metaUnknown = false;
  const files = [
    { id: "claude-one", provider: "claude" }, { id: "claude-two", provider: "claude" },
    { id: "codex", provider: "codex" },
    { id: "antigravity", provider: "antigravity", project_id: "fixture-project" },
    { id: "meta", provider: "meta", name: "muse.json" },
    { id: "go", provider: "opencode-go", supports_quota: true, quota_plugin_id: "opencode-plugin" },
  ].map(file => ({ ...file, auth_index: file.id }));
  const grouped = { subscription: { plan: "Pro" }, groups: [{ displayName: "All models", buckets: [
    { bucketId: "3p-session", window: "5h", remainingFraction: 0, resetTime: reset },
    { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.75, resetTime: reset },
  ] }] };
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      const url = new URL(req.url, "http://fixture.test"); requests.push({ path: url.pathname, body });
      const send = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
      if (url.pathname.endsWith("/auth-files")) return send({ files: [...files, { bad: true }, { id: "disabled", auth_index: "disabled", provider: "meta", disabled: true }] });
      if (url.pathname.endsWith("/auth-files/download")) {
        assert.equal(url.searchParams.get("name"), "muse.json");
        return send({ dca_token: "dca:fixture-only", api_key: "LLM|private-fixture" });
      }
      if (url.pathname.endsWith("/quota/fetch")) {
        assert.equal(body.auth_index, "go"); assert.equal(body.plugin_id, "opencode-plugin");
        return failing ? send({ error: "private-fixture-error" }, 501) : send(grouped);
      }
      assert.ok(url.pathname.endsWith("/api-call"));
      if (body.auth_index === "meta") {
        assert.equal(body.header.Authorization, "Bearer dca:fixture-only");
        assert.equal(body.url, "https://api.meta.ai/muse-code/key");
        assert.equal(body.method, "POST"); assert.deepEqual(JSON.parse(body.data), {});
        return send({ status_code: 200, body: failing ? "invalid-private-fixture" : JSON.stringify(metaUnknown
          ? { api_key: "LLM|private-fixture", subs_tier_name: "Max Usage", is_subs_active: true }
          : { api_key: "LLM|private-fixture", subs_usage: { window: { used_percent: 20, window_duration_mins: 300, resets_at: 4070908800 }, weekly: { used_percent: 0 } } }) });
      }
      assert.equal(body.header.Authorization, "Bearer $TOKEN$");
      let upstream;
      if (body.auth_index === "antigravity") {
        if (body.url === "https://www.googleapis.com/oauth2/v2/userinfo") {
          assert.equal(body.method, "GET"); assert.equal(body.data, undefined);
          upstream = { id: "private-fixture-google-account" };
        } else {
          assert.equal(body.method, "POST"); assert.deepEqual(JSON.parse(body.data), { project: "fixture-project" });
          assert.ok([
            "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
            "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
            "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
          ].includes(body.url));
          // Retain the legacy reader's host-retry check. The new native reader
          // uses its own user agent and reads the daily host directly.
          if (body.header["User-Agent"] === "antigravity/hub/2.23.0 darwin/arm64" && !body.url.includes("sandbox")) {
            return send({ status_code: 503, body: "private-fixture-error" });
          }
          upstream = grouped;
        }
      } else if (body.auth_index === "codex") upstream = body.url.endsWith("/rate-limit-reset-credits") ? { credits: [] } : { plan_type: "pro", rate_limit: { primary_window: { used_percent: 30, reset_at: 4070908800, limit_window_seconds: 18000 } } };
      else { assert.ok(body.auth_index.startsWith("claude-")); upstream = { five_hour: { utilization: 10, resets_at: reset }, seven_day: { utilization: 20, resets_at: reset } }; }
      return send({ status_code: 200, body: JSON.stringify(upstream) });
    } catch (error) { res.writeHead(500); res.end("Fixture contract failed"); requests.push({ error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await gatewayT3.setHub(sourceId, { kind: "cliproxy", url: `http://127.0.0.1:${server.address().port}`, managementKey: key, label: "Quota smoke", enabled: true });
    const read = async () => (await gatewayT3.hubReports()).find(source => source.id === sourceId);
    const healthy = await until(async () => { const report = await read(); return report?.accounts.length === 6 && report.accounts.every(account => account.usageLimits.windows.length) && report; });
    const account = id => healthy.accounts.find(entry => entry.id === id);
    assert.equal(account("antigravity").driver, "antigravity");
    assert.equal(account("meta").driver, "muse");
    assert.equal(account("go").driver, "opencode-go");
    assert.equal(account("go").usageLimits.windows[0].usedPercent, 100);
    assert.equal(account("go").usageLimits.windows[0].resetsAt, reset);
    assert.equal(account("meta").usageLimits.windows[1].usedPercent, 0);
    assert.ok(!JSON.stringify(healthy).includes("private-fixture"));
    failing = true;
    await api.call("server.refreshProviders", {}, { timeoutMs: 90_000 });
    const partial = await read();
    assert.equal(partial.accounts.length, 6);
    for (const id of ["meta", "go"]) {
      const entry = partial.accounts.find(account => account.id === id);
      assert.deepEqual(entry.usageLimits.windows, [], "Failed reads must not masquerade as fresh success");
      assert.equal(entry.usageLimits.unavailable.reason, id === "go" ? "unsupported" : "probeFailed");
    }
    assert.equal(partial.accounts.filter(account => account.usageLimits.windows.length).length, 4);
    assert.ok(!JSON.stringify(partial).includes("private-fixture"));
    failing = false; metaUnknown = true;
    await api.call("server.refreshProviders", {}, { timeoutMs: 90_000 });
    const unknown = await read(), meta = unknown.accounts.find(account => account.id === "meta");
    assert.equal(meta.plan, "Max Usage");
    assert.deepEqual(meta.usageLimits.windows, []);
    assert.match(meta.usageLimits.unavailable.message, /Meta did not include subscription usage/);
    assert.equal(unknown.accounts.filter(account => account.usageLimits.windows.length).length, 5);
    assert.ok(!JSON.stringify(unknown).includes("private-fixture"));
    assert.ok(!requests.some(request => request.error), JSON.stringify(requests.filter(request => request.error)));
  } finally {
    await gatewayT3.setHub(sourceId, null);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
