// Unit tests for reading auth off a request (docker/setup/request-auth.mjs).
//
//   node --test tests/request-auth.test.mjs
//
// A custom setup key may be any printable ASCII (validKey), so the cookie
// /login sets - encodeURIComponent(KEY) - must read back as the key itself
// for every one of them. Before, a key with `@ # %` logged in once and
// then bounced back to the unlock screen, and a value containing `=`
// never parsed at all.
import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { cookieValue, forwardedPrefix } from "../docker/setup/request-auth.mjs";
import { validKey } from "../docker/setup/setup-key.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const headerFor = (key) => `other=1; t3setup=${encodeURIComponent(key)}; theme=dark`;

test("every valid key round-trips through the cookie /login sets", () => {
  for (const key of ["p@ss#x", "a=b;c", "100%", "p@ss-word_!~", "eq=uals==", "%41bc", "a%2Fb", "plain-key-123"]) {
    assert.ok(validKey(key), key);
    assert.equal(cookieValue(headerFor(key), "t3setup"), key, key);
  }
});

test("the cookie is found by name, split on the first = only", () => {
  assert.equal(cookieValue("t3setup=a=b=c", "t3setup"), "a=b=c");
  assert.equal(cookieValue("t3setupx=nope; t3setup=yes", "t3setup"), "yes");
  assert.equal(cookieValue("theme=dark", "t3setup"), undefined);
  assert.equal(cookieValue(undefined, "t3setup"), undefined);
  assert.equal(cookieValue("", "t3setup"), undefined);
  assert.equal(cookieValue("t3setup", "t3setup"), undefined, "no value is no cookie");
  assert.equal(cookieValue("t3setup=", "t3setup"), "");
});

test("a hand-set cookie carrying the key itself still reads back", () => {
  // Not valid percent-encoding, so never what /login set - but the raw text
  // is the key, and the caller still compares it in full.
  assert.equal(cookieValue("t3setup=x%zz", "t3setup"), "x%zz");
  assert.equal(cookieValue("t3setup=raw-key", "t3setup"), "raw-key");
});

const prefix = (value) => forwardedPrefix({ "x-forwarded-prefix": value });

test("a plain forwarded prefix is kept, trailing slashes trimmed", () => {
  assert.equal(prefix("/__setup"), "/__setup");
  assert.equal(prefix("/__setup/"), "/__setup");
  assert.equal(prefix("/a/b-c.d~e"), "/a/b-c.d~e");
  assert.equal(prefix(" /__setup "), "/__setup");
});

test("dot segments are refused, as the router refuses them", () => {
  for (const bad of ["/../evil", "/a/../b", "/./x", "/a/./b", "/..", "/."]) {
    assert.equal(prefix(bad), "", bad);
  }
});

test("empty segments are refused: //host would make redirects absolute", () => {
  for (const bad of ["//evil.com", "/a//b", "///evil.com"]) {
    assert.equal(prefix(bad), "", bad);
  }
});

test("anything that is not a plain path is refused", () => {
  for (const bad of ["", "setup", "/%2e%2e/evil", "/..;evil", "/a\\b", "/a b", undefined, 42]) {
    assert.equal(prefix(bad), "", JSON.stringify(bad));
  }
  assert.equal(forwardedPrefix({}), "");
  assert.equal(forwardedPrefix(undefined), "");
});

// Concurrent wrong guesses against the real server must queue per IP and
// spill past the in-flight cap with 429: before, N parallel guesses shared
// one delay window and were all answered together, so trying many keys at
// once cost little more than trying one.
test("concurrent bad guesses queue per IP and flood past the cap with 429", { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-login-queue-"));
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
      T3_SETUP_KEY: "queue-fixture-setup-key", T3_SETUP_KEY_SOURCE: "env",
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
  const login = (guess) => fetch(`${base}/login`, {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ key: guess }),
  });
  // Six wrong guesses at once: the admitted ones wait in turn (0ms, 250ms,
  // 500ms, 750ms, ...), so the batch takes well over one delay window, and
  // the flood past the in-flight cap is refused outright.
  const at = Date.now();
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => login(`wrong-${i}`)));
  const ms = Date.now() - at;
  const statuses = answers.map((r) => r.status);
  assert.ok(statuses.includes(429), `a flood of parallel guesses should spill past the cap, got ${statuses}`);
  assert.ok(statuses.every((s) => s === 401 || s === 429), `guesses answer 401 or 429, got ${statuses}`);
  assert.ok(ms >= 1200, `queued guesses should take their delays in turn, took ${ms}ms`);
});
