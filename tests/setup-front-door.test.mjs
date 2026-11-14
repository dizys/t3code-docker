// Regression tests for the setup front door (DB port confirmation, login
// lockout, forwarded-header trust, /pair validation).
//
//   node --test tests/setup-front-door.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { createKeyThrottle } from "../docker/setup/key-throttle.mjs";
import { clientAddress, peerIsLoopback } from "../docker/setup/client-address.mjs";
import { forwardedHost, forwardedPrefix, forwardedProto } from "../docker/setup/request-auth.mjs";

// ------------------------------------------------------- login lockout --

test("guessing past the failure budget locks the address out at once", async () => {
  let clock = 1_000_000;
  const waits = [];
  const throttle = createKeyThrottle({
    matches: (key) => key === "good",
    wait: async (ms) => { waits.push(ms); },
    now: () => clock,
    lockoutAfter: 5,
    lockoutBaseMs: 30_000,
    lockoutMaxMs: 120_000,
  });
  for (let i = 0; i < 5; i++) assert.equal(await throttle.check("attacker", "bad"), false);
  // The next guess is refused immediately: no slot taken, no delay queued.
  const at = Date.now();
  await assert.rejects(throttle.check("attacker", "bad"), { code: "login-limit" });
  await assert.rejects(throttle.check("attacker", "good"), { code: "login-limit" });
  assert.ok(Date.now() - at < 1000, "a locked-out guess must not wait out another delay");
  assert.equal(waits.length, 5, "locked-out guesses queue no further delays");
  // Another address is unaffected, before and during the attacker's window.
  assert.equal(await throttle.check("operator", "good"), true);
  // The window passes: guessing resumes, and a right key still ends it.
  clock += 30_001;
  assert.equal(await throttle.check("attacker", "bad"), false, "guesses resume once the window lapses");
  assert.equal(waits.at(-1), 1500, "the delay keeps capping at 12 steps");
  await assert.rejects(throttle.check("attacker", "bad"), { code: "login-limit" }, "that failure locks the address again at once");
  clock += 30_001;
  assert.equal(await throttle.check("attacker", "good"), true, "a right key still ends the lockout");
  assert.equal(await throttle.check("attacker", "bad"), false);
  assert.equal(waits.at(-1), 250, "a success resets the failure count");
});

test("the lockout window grows while failures keep coming", async () => {
  let clock = 0;
  const throttle = createKeyThrottle({
    matches: () => false,
    wait: async () => {},
    now: () => clock,
    lockoutAfter: 1,
    lockoutBaseMs: 10_000,
    lockoutMaxMs: 60_000,
  });
  await throttle.check("attacker", "bad"); // strike 1: a 10s window
  for (let strike = 2; strike <= 6; strike++) {
    clock += 10_001; // each window lapses
    assert.equal(await throttle.check("attacker", "bad"), false, `strike ${strike} is answered, then locks again`);
  }
  // Six strikes in, the window has doubled to 20s: 10s past is still locked.
  clock += 10_001;
  await assert.rejects(throttle.check("attacker", "bad"), { code: "login-limit" }, "the sixth window lasts twice as long");
  clock += 9_999;
  assert.equal(await throttle.check("attacker", "bad"), false, "doubled window over, guesses resume");
});

test("a locked-out flood holds no shared slots, so others keep logging in", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let clock = 0;
  const throttle = createKeyThrottle({
    matches: (key) => key === "good",
    wait: () => gate,
    now: () => clock,
    perAddress: 4,
    pendingLimit: 4,
    lockoutAfter: 4,
    lockoutBaseMs: 60_000,
  });
  // The attacker fills every shared slot with slow failures, then drains them.
  const flood = Array.from({ length: 4 }, () => throttle.check("attacker", "bad"));
  await assert.rejects(throttle.check("operator", "good"), { code: "login-limit" }, "at capacity even a right key waits");
  release();
  assert.deepEqual(await Promise.all(flood), [false, false, false, false]);
  // Past the budget the attacker is locked out: their guesses are refused
  // without taking slots, so the operator logs in while the flood continues.
  clock += 60_001; // let the first lockout (if any) lapse; strikes stand
  await throttle.check("attacker", "bad"); // 5th strike: locked again at once afterwards
  const spam = Array.from({ length: 20 }, () => throttle.check("attacker", "bad").then(() => "kept", (error) => error.code));
  assert.equal(await throttle.check("operator", "good"), true, "locked-out spam must not crowd out a legitimate login");
  assert.deepEqual(await Promise.all(spam), Array(20).fill("login-limit"));
  assert.equal(await throttle.check("operator", "good"), true);
});

// ------------------------------------------------- forwarded headers --

test("forwarded scheme/host/prefix are only believed from loopback", () => {
  const headers = {
    host: "direct.example",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "proxy.example",
    "x-forwarded-prefix": "/__setup",
  };
  assert.equal(forwardedProto(headers, { trusted: true }), "https");
  assert.equal(forwardedProto(headers, { trusted: false }), "", "a direct peer's scheme claim is not believed");
  assert.equal(forwardedHost(headers, { trusted: true }), "proxy.example");
  assert.equal(forwardedHost(headers, { trusted: false }), "direct.example", "a direct peer's host claim is not believed");
  assert.equal(forwardedPrefix(headers, { trusted: true }), "/__setup");
  assert.equal(forwardedPrefix(headers, { trusted: false }), "", "a direct peer's prefix claim is not believed");
  assert.equal(forwardedProto({ "x-forwarded-proto": "https, http" }, { trusted: true }), "https", "first value wins, as before");
});

test("the peer gate follows the socket, not the headers", () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(peerIsLoopback(req("127.0.0.1")), true);
  assert.equal(peerIsLoopback(req("::ffff:127.0.0.1")), true);
  assert.equal(peerIsLoopback(req("::1")), true);
  assert.equal(peerIsLoopback(req("192.168.1.20", { "x-forwarded-for": "127.0.0.1" })), false, "headers never promote a peer");
  assert.equal(peerIsLoopback(req("10.0.0.4")), false);
  assert.equal(clientAddress(req("192.168.1.20", { "x-forwarded-for": "127.0.0.1" })), "192.168.1.20");
});

// ------------------------------------------------------- live server --

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const launch = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-front-door-"));
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../docker/setup/server.mjs", import.meta.url))], {
    env: {
      ...process.env, HOME: home, T3CODE_HOME: path.join(home, ".t3"),
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"), T3_WORKSPACE: root,
      MISE_DATA_DIR: path.join(root, "mise-data"), MISE_STATE_DIR: path.join(root, "mise-state"),
      MISE_CONFIG_DIR: path.join(root, "mise-config"),
      T3_HARNESS_MODULE: fileURLToPath(new URL("../docker/harness/index.mjs", import.meta.url)),
      T3_SETUP_KEY: "front-door-fixture-key", T3_SETUP_KEY_SOURCE: "env",
      T3_SETUP_PORT: String(port), T3CODE_PORT: "1", T3_INFRA_LAUNCHER: "/bin/false",
      T3_RUN_DIR: path.join(root, "run"),
      T3_RUNTIME_MODULE: fileURLToPath(new URL("../docker/runtime/manager.mjs", import.meta.url)),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (x) => { logs += x; });
  child.stderr.on("data", (x) => { logs += x; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { await fetch(`${base}/hello`); break; } catch { await pause(20); }
  }
  return base;
};

test("a database port is refused without confirmation and published with it", { timeout: 30000 }, async (t) => {
  const base = await launch(t);
  const auth = { "x-t3-setup-key": "front-door-fixture-key", "content-type": "application/json" };
  const refused = await fetch(`${base}/ports/expose`, { method: "POST", headers: auth, body: JSON.stringify({ port: 5432 }) });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /looks like a database/i);
  const confirmed = await fetch(`${base}/ports/expose`, { method: "POST", headers: auth, body: JSON.stringify({ port: 5432, confirmDatabase: true }) });
  assert.equal(confirmed.status, 200, `confirmed expose should start, got ${confirmed.status}: ${await confirmed.text()}`);
  const other = await fetch(`${base}/ports/expose`, { method: "POST", headers: auth, body: JSON.stringify({ port: 3000 }) });
  assert.equal(other.status, 200, "an ordinary port still needs no confirmation");
  const unauth = await fetch(`${base}/ports/expose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ port: 5432, confirmDatabase: true }) });
  assert.equal(unauth.status, 401, "confirmation is not a substitute for authentication");
});

test("the Secure cookie still follows the proxy's scheme over loopback", { timeout: 30000 }, async (t) => {
  const base = await launch(t);
  const login = (headers = {}) => fetch(`${base}/login`, {
    method: "POST", redirect: "manual", headers,
    body: new URLSearchParams({ key: "front-door-fixture-key" }),
  });
  const plain = await login();
  assert.equal(plain.status, 303);
  assert.doesNotMatch(plain.headers.get("set-cookie") ?? "", /; Secure(;|$)/, "plain http sets no Secure flag");
  const viaProxy = await login({ "x-forwarded-proto": "https" });
  assert.match(viaProxy.headers.get("set-cookie") ?? "", /; Secure(;|$)/, "the router's https still earns the Secure flag");
});

test("/pair refuses flag-like ttl and label values", { timeout: 30000 }, async (t) => {
  const base = await launch(t);
  const auth = { "x-t3-setup-key": "front-door-fixture-key", "content-type": "application/json" };
  const pair = (input) => fetch(`${base}/pair`, { method: "POST", headers: auth, body: JSON.stringify(input) });
  for (const ttl of ["--help", "-h", "--ttl", "30d;id", "1h --label x", "", " ", "0d", "ten-days", 30, ["30d"]]) {
    if (ttl === "") continue; // empty means “no ttl”, as before
    const response = await pair({ ttl });
    assert.equal(response.status, 400, `ttl ${JSON.stringify(ttl)}`);
    assert.match((await response.json()).error, /invalid ttl/, `ttl ${JSON.stringify(ttl)}`);
  }
  for (const label of ["--label", "-x", "a\nb", "a\0b", "x".repeat(129), 42, { text: "phone" }]) {
    const response = await pair({ label });
    assert.equal(response.status, 400, `label ${JSON.stringify(label)}`);
    assert.match((await response.json()).error, /invalid label/, `label ${JSON.stringify(label)}`);
  }
  // Well-formed values get past validation: whatever the launcher or the
  // public URL then says, it is not a complaint about the value itself.
  for (const input of [{ ttl: "30d" }, { ttl: "5m", label: "my phone" }, { label: "tablet" }, {}]) {
    const response = await pair(input);
    assert.equal(response.status, 400, JSON.stringify(input));
    assert.doesNotMatch((await response.json()).error, /invalid (ttl|label)/, JSON.stringify(input));
  }
});
