import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { checkHealth } from "../docker/router/healthcheck.mjs";

async function server(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return String(server.address().port);
}

test("healthchecks use the router's canonical setup prefix", async (t) => {
  const paths = [];
  const port = await server(t, (req, res) => { paths.push(req.url); res.end("healthy"); });
  for (const [configured, expected] of [[undefined, "/__setup"], ["/", "/__setup"], ["setup", "/setup"], [" /admin/setup/ ", "/admin/setup"]]) {
    paths.length = 0;
    assert.equal(await checkHealth({ T3_SINGLE_PORT: port, T3_SETUP_BASE_PATH: configured }), true);
    assert.deepEqual(paths.sort(), ["/.well-known/t3/environment", `${expected}/hello`].sort());
  }
  assert.equal(await checkHealth({ T3_SINGLE_PORT: port, T3_SETUP_BASE_PATH: "/api" }), false);
});

test("an unavailable setup service fails one-port health but disabled Setup and two-port mode do not probe it", async (t) => {
  const paths = [];
  const port = await server(t, (req, res) => {
    paths.push(req.url);
    res.writeHead(req.url.endsWith("/hello") ? 503 : 200); res.end();
  });
  assert.equal(await checkHealth({ T3_SINGLE_PORT: port }), false);
  paths.length = 0;
  assert.equal(await checkHealth({ T3_SINGLE_PORT: port, T3_SETUP_ENABLED: "0" }), true);
  assert.equal(await checkHealth({ T3CODE_PORT: port }), true);
  assert.deepEqual(paths, ["/.well-known/t3/environment", "/.well-known/t3/environment"]);
  for (const disabled of ["", "false", "2"]) {
    assert.equal(await checkHealth({ T3_SINGLE_PORT: port, T3_SETUP_ENABLED: disabled }), true);
  }
  assert.equal(await checkHealth({ T3_SINGLE_PORT: port, T3_SETUP_ENABLED: " 1 " }), false);
});

test("both probes share a deadline, including a server that never sends headers", async (t) => {
  const paths = [];
  const port = await server(t, (req) => { paths.push(req.url); });
  const started = Date.now();
  assert.equal(await checkHealth({ T3_SINGLE_PORT: port }, { timeoutMs: 100 }), false);
  assert.equal(paths.length, 2, "both probes run within the same budget");
  assert.ok(Date.now() - started < 1500);
});

test("headers alone cannot make a truncated or unfinished health response succeed", async (t) => {
  const port = await server(t, (_req, res) => { res.writeHead(200, { "Content-Length": "100" }); res.flushHeaders(); res.write("partial"); });
  assert.equal(await checkHealth({ T3_SINGLE_PORT: port }, { timeoutMs: 100 }), false);
});
