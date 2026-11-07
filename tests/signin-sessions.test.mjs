// Unit tests for the sign-in session store.
//
//   node --test tests/signin-sessions.test.mjs
//
// Terminal sessions keep their verdict briefly, then the entry is freed, so
// completed sign-ins cannot pile up child handles and output buffers.
import assert from "node:assert/strict";
import test from "node:test";

import { createSessionStore, SESSION_KEEP_MS, TERMINAL_STATES } from "../docker/setup/signin-sessions.mjs";

test("completed sessions stay readable briefly, then leave the map", async () => {
  const store = createSessionStore({ keepMs: 30 });
  const N = 25;
  for (let i = 0; i < N; i++) {
    store.add({ id: `s${i}`, state: "awaiting-browser", output: "x".repeat(1000), child: null });
    store.settle(`s${i}`, "done");
  }
  assert.equal(store.size(), N);
  assert.equal(store.get("s0").state, "done", "the verdict is still there during the tombstone");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(store.size(), 0);
  assert.equal(store.get("s0"), undefined, "a freed id reads like an unknown one");
});

test("the first verdict wins and only terminal states schedule removal", async () => {
  const store = createSessionStore({ keepMs: 20 });
  store.add({ id: "a", state: "starting", child: null });
  assert.equal(store.settle("a", "failed", "nope").state, "failed");
  assert.equal(store.settle("a", "done").state, "failed", "a later verdict does not overwrite");
  store.add({ id: "b", state: "awaiting-browser", child: null });
  store.settle("b");
  assert.equal(store.get("b").state, "awaiting-browser", "scheduling alone changes nothing");
  assert.equal(store.settle("missing", "failed"), null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("b").state, "awaiting-browser", "a session still waiting is kept");
});

test("freeing stops the watch and drops the child and flow handles", async () => {
  const store = createSessionStore({ keepMs: 20 });
  let killed = 0, cleared = null, closed = 0;
  const session = {
    id: "c", state: "submitted", output: "", child: { kill: () => { killed++; } },
    watch: "watch-handle", flow: { close: () => { closed++; } },
  };
  const realClear = clearInterval;
  global.clearInterval = (handle) => { cleared = handle; };
  try {
    store.add(session);
    store.settle("c", "failed", "nope");
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    global.clearInterval = realClear;
  }
  assert.equal(store.size(), 0);
  assert.equal(killed, 1);
  assert.equal(cleared, "watch-handle");
  assert.equal(closed, 1);
});

test("the tombstone defaults to a minute", () => {
  assert.equal(SESSION_KEEP_MS, 60 * 1000);
  assert.deepEqual([...TERMINAL_STATES].sort(), ["cancelled", "done", "failed"]);
});
