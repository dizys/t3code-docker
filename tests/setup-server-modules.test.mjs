// Unit tests for the setup service's helper modules.
//
//   node --test tests/setup-server-modules.test.mjs
//
// ports.mjs parses `ss` and names listeners, storage/system.mjs judges mounts the way
// t3-doctor does, and latest.mjs keeps release lookups off the poll path. All
// are pure or take their effects as arguments, so none of this needs a
// container.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { looksLikeDatabase, parseListeners, processLabel, splitLocal } from "../docker/setup/ports.mjs";
import { countProjects, coveringMount, mountKind, mountSource } from "../docker/harness/storage/system.mjs";
import { createLatestCache } from "../docker/setup/latest.mjs";
import { clientAddress, isLoopback, plainAddress } from "../docker/setup/client-address.mjs";

// --------------------------------------------------------------------- ports --

const SS = [
  'LISTEN 0      511          127.0.0.1:3000       0.0.0.0:*    users:(("next-server",pid=101,fd=20))',
  'LISTEN 0      511            0.0.0.0:5173       0.0.0.0:*    users:(("MainThread",pid=102,fd=21))',
  'LISTEN 0      511               [::]:5173          [::]:*    users:(("MainThread",pid=102,fd=22))',
  'LISTEN 0      244          127.0.0.1:5432       0.0.0.0:*    users:(("postgres",pid=103,fd=7))',
  'LISTEN 0      244              [::1]:5432          [::]:*    users:(("postgres",pid=103,fd=8))',
  'LISTEN 0      4096     127.0.0.53%lo:53         0.0.0.0:*',
  'LISTEN 0      4096         127.0.0.1:20241      0.0.0.0:*    users:(("cloudflared",pid=104,fd=3))',
  'LISTEN 0      511            0.0.0.0:3773       0.0.0.0:*    users:(("t3",pid=105,fd=9))',
  'LISTEN 0      511          127.0.0.1:41234      0.0.0.0:*    users:(("t3",pid=105,fd=10))',
  '',
].join("\n");

test("listeners are one per port, in order, without plumbing or the ephemeral range", () => {
  const found = parseListeners(SS, { reserved: new Set([3773, 3774]), ephemeral: [32768, 60999] });
  assert.deepEqual(found, [
    { port: 53, process: null, pid: null, address: "127.0.0.53", looksLikeDatabase: false },
    { port: 3000, process: "next-server", pid: 101, address: "127.0.0.1", looksLikeDatabase: false },
    { port: 5173, process: "MainThread", pid: 102, address: "0.0.0.0", looksLikeDatabase: false },
    { port: 5432, process: "postgres", pid: 103, address: "127.0.0.1", looksLikeDatabase: true },
  ]);
  assert.deepEqual(parseListeners(""), []);
});

test("local addresses split across IPv4, IPv6 and interface suffixes", () => {
  assert.deepEqual(splitLocal("127.0.0.1:3000"), { address: "127.0.0.1", port: 3000 });
  assert.deepEqual(splitLocal("[::1]:5432"), { address: "::1", port: 5432 });
  assert.deepEqual(splitLocal("*:8080"), { address: "*", port: 8080 });
  assert.deepEqual(splitLocal("127.0.0.53%lo:53"), { address: "127.0.0.53", port: 53 });
  assert.equal(splitLocal("nonsense"), null);
  assert.equal(splitLocal("1.2.3.4:99999"), null);
});

test("a listener is named for what it runs, not for its runtime", () => {
  assert.equal(processLabel(["node", "/app/node_modules/vite/bin/vite.js", "--port", "5173"], "MainThread"), "vite");
  assert.equal(processLabel(["node", "/app/node_modules/.bin/vite"], "MainThread"), "vite");
  assert.equal(processLabel(["node", "/x/node_modules/@scope/cli/dist/index.js"]), "cli");
  assert.equal(processLabel(["python3", "-m", "http.server", "3000"]), "http.server");
  assert.equal(processLabel(["/usr/lib/postgresql/16/bin/postgres", "-D", "/data"]), "postgres");
  assert.equal(processLabel(["next-server (v15.0.3)"]), "next-server");
  assert.equal(processLabel(["npx", "vite"]), "vite");
  assert.equal(processLabel(["node", "server.mjs"]), "server");
  assert.equal(processLabel(null, "MainThread"), "MainThread");
  assert.equal(processLabel([], "postgres"), "postgres");
});

test("databases are recognised by port or by process", () => {
  for (const port of [5432, 3306, 6379, 27017, 9000]) assert.equal(looksLikeDatabase(port, "anything"), true, String(port));
  for (const name of ["postgres", "mysqld", "mariadbd", "redis-server", "mongod", "clickhouse-server"]) {
    assert.equal(looksLikeDatabase(7000, name), true, name);
  }
  assert.equal(looksLikeDatabase(5173, "vite"), false);
});

// ------------------------------------------------------------------- storage --

const MOUNTINFO = [
  "21 1 0:20 / / rw,relatime - overlay overlay rw",
  "300 21 8:1 /var/lib/docker/volumes/t3-home/_data /home/t3 rw,relatime - ext4 /dev/sda1 rw",
  "301 21 8:1 /srv/projects /workspace rw,relatime - ext4 /dev/sda1 rw",
  "302 21 8:1 /var/lib/docker/volumes/2f1a9b0c7d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90/_data /data rw - ext4 /dev/sda1 rw",
  "303 300 8:1 /@/var/lib/docker/volumes/t3-state/_data /home/t3/.t3 rw - btrfs /dev/sda2 rw",
].join("\n");

test("mounts are judged the way t3-doctor judges them", () => {
  assert.deepEqual(coveringMount("/home/t3/.t3/state.db", MOUNTINFO), { point: "/home/t3/.t3", root: "/@/var/lib/docker/volumes/t3-state/_data" });
  assert.equal(mountKind("/home/t3", MOUNTINFO), "durable", "a named volume");
  assert.equal(mountKind("/workspace", MOUNTINFO), "durable", "a host path");
  assert.equal(mountKind("/data", MOUNTINFO), "anonymous", "a volume named by a hash");
  assert.equal(mountKind("/home/t3/.t3", MOUNTINFO), "durable", "however the data root is prefixed");
  assert.equal(mountKind("/opt/elsewhere", MOUNTINFO), "none", "the root filesystem is not a mount");
  assert.equal(mountKind("/home/t3x", MOUNTINFO), "none", "a prefix is not a parent");
  // A volume is named, so the page can name it in the command that moves it.
  assert.deepEqual(mountSource("/home/t3", MOUNTINFO), { kind: "durable", volume: "t3-home" });
  assert.deepEqual(mountSource("/data", MOUNTINFO), { kind: "anonymous", volume: "2f1a9b0c7d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90" });
  assert.deepEqual(mountSource("/home/t3/.t3", MOUNTINFO), { kind: "durable", volume: "t3-state" });
  assert.deepEqual(mountSource("/workspace", MOUNTINFO), { kind: "durable", volume: null }, "a host directory has no volume name");
  assert.deepEqual(mountSource("/opt/elsewhere", MOUNTINFO), { kind: "none", volume: null });
});

test("projects are the git repositories T3 Code registers on start", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-projects-"));
  try {
    assert.equal(await countProjects(root), 0);
    await mkdir(path.join(root, "a", ".git"), { recursive: true });
    await mkdir(path.join(root, "b", ".git"), { recursive: true });
    await mkdir(path.join(root, "notes"));
    assert.equal(await countProjects(root), 2);
    await mkdir(path.join(root, ".git"));
    assert.equal(await countProjects(root), 1, "a workspace that is itself a repository is one project");
    assert.equal(await countProjects(path.join(root, "missing")), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- latest --

const latestWorld = ({ answers = {}, saved = null, ttlMs = 1000 } = {}) => {
  const world = { lookups: [], written: null, clock: 1_000_000 };
  world.cache = createLatestCache({
    keys: () => Object.keys(answers),
    lookup: async (key) => {
      world.lookups.push(key);
      const answer = answers[key];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    read: async () => {
      if (saved === null) throw new Error("ENOENT");
      return saved;
    },
    write: async (text) => { world.written = text; },
    ttlMs,
    now: () => world.clock,
  });
  return world;
};

test("a pass looks every tool up once and remembers the answers", async () => {
  const world = latestWorld({ answers: { "harness:claude": "2.1.290", "toolchain:go": "1.27.1" } });
  assert.deepEqual(world.cache.get("harness:claude"), { latestVersion: null, latestCheckedAt: null, newestVersion: null, newestReleasedAt: null });
  assert.equal(await world.cache.refresh(), true);
  assert.deepEqual(world.cache.get("harness:claude"), { latestVersion: "2.1.290", latestCheckedAt: 1_000_000, newestVersion: null, newestReleasedAt: null });
  assert.deepEqual(world.lookups, ["harness:claude", "toolchain:go"]);
  assert.deepEqual(JSON.parse(world.written).versions["toolchain:go"], { version: "1.27.1", at: 1_000_000 });
});

test("a release mise is still holding back is kept beside the one it offers", async () => {
  const world = latestWorld({ answers: {
    "harness:claude": { version: "2.1.287", newest: "2.1.288", newestAt: "2026-10-02T20:19:57.000Z" },
    "harness:codex": { version: "0.160.0", newest: null, newestAt: null },
  } });
  await world.cache.refresh();
  assert.deepEqual(world.cache.get("harness:claude"), {
    latestVersion: "2.1.287", latestCheckedAt: 1_000_000, newestVersion: "2.1.288", newestReleasedAt: "2026-10-02T20:19:57.000Z",
  });
  assert.equal(world.cache.get("harness:codex").newestVersion, null);
  assert.deepEqual(JSON.parse(world.written).versions["harness:codex"], { version: "0.160.0", at: 1_000_000 }, "nothing held back, nothing stored");
});

test("saved Rust channels are discarded without losing a numbered cached release", async () => {
  const answers = { "toolchain:rust": { version: "1.99.1", newest: "stable" } };
  const saved = JSON.stringify({ versions: { "toolchain:rust": { version: "1.99.1", at: 1, newest: "stable", newestAt: "2026-10-15T00:00:00Z" } } });
  const world = latestWorld({ answers, saved });
  await world.cache.load();
  assert.equal(world.cache.get("toolchain:rust").latestVersion, "1.99.1");
  assert.equal(world.cache.get("toolchain:rust").newestVersion, null);
  await world.cache.refresh({ force: true });
  assert.deepEqual(JSON.parse(world.written).versions["toolchain:rust"], { version: "1.99.1", at: 1_000_000 });
  answers["toolchain:rust"] = { version: "stable" };
  await world.cache.refreshOne("toolchain:rust");
  assert.equal(world.cache.get("toolchain:rust").latestVersion, "1.99.1", "a bad reply keeps the last usable release");
  assert.match(world.cache.errors()["toolchain:rust"], /release version/i);
});

test("an old Rust channel target is refreshed immediately even inside the cache TTL", async () => {
  const saved = JSON.stringify({ versions: { "toolchain:rust": { version: "stable", at: 1_000_000 } } });
  const world = latestWorld({ saved, answers: { "toolchain:rust": "1.99.1" } });
  await world.cache.load();
  assert.equal(world.cache.get("toolchain:rust").latestVersion, null);
  assert.equal(await world.cache.refresh(), true);
  assert.deepEqual(world.lookups, ["toolchain:rust"]);
  assert.equal(world.cache.get("toolchain:rust").latestVersion, "1.99.1");
});

test("a fresh pass is not repeated, unless someone asks", async () => {
  const world = latestWorld({ answers: { "harness:claude": "1" } });
  await world.cache.refresh();
  world.clock += 500;
  assert.equal(await world.cache.refresh(), false);
  assert.equal(world.lookups.length, 1);
  assert.equal(await world.cache.refresh({ force: true }), true);
  assert.equal(world.lookups.length, 2);
  world.clock += 2000;
  assert.equal(await world.cache.refresh(), true, "stale after the TTL");
});

test("a failed lookup keeps the last answer instead of forgetting the update", async () => {
  const saved = JSON.stringify({ checkedAt: 1, versions: { "harness:claude": { version: "2.1.280", at: 1 } } });
  const world = latestWorld({ answers: { "harness:claude": new Error("offline") }, saved });
  await world.cache.refresh();
  assert.equal(world.cache.get("harness:claude").latestVersion, "2.1.280");
});

test("concurrent callers share one pass", async () => {
  const world = latestWorld({ answers: { "harness:claude": "1", "harness:codex": "2" } });
  await Promise.all([world.cache.refresh({ force: true }), world.cache.refresh(), world.cache.refresh({ force: true })]);
  assert.equal(world.lookups.length, 2);
});

test("one key can be looked up now, outside the schedule, and a failure changes nothing", async () => {
  const world = latestWorld({ answers: { "package:jq": "1.8.2", "package:bad": new Error("offline") } });
  await world.cache.refreshOne("package:jq");
  assert.equal(world.cache.get("package:jq").latestVersion, "1.8.2");
  assert.deepEqual(JSON.parse(world.written).versions["package:jq"], { version: "1.8.2", at: 1_000_000 });
  await world.cache.refreshOne("package:bad");
  assert.equal(world.cache.get("package:bad").latestVersion, null);
});

test("failed rows retry independently while successful rows stay cached", async () => {
  const answers = { "harness:claude": new Error("offline"), "toolchain:go": "1" };
  const world = latestWorld({ answers, ttlMs: 3_600_000 });
  await world.cache.refresh();
  assert.equal(world.cache.errors()["harness:claude"], "offline");
  assert.equal(await world.cache.refresh(), false, "failures have a short retry backoff");
  const retry = latestWorld({ answers, saved: world.written, ttlMs: 3_600_000 });
  await retry.cache.load();
  assert.equal(retry.cache.errors()["harness:claude"], "offline", "restart keeps the warning");
  retry.clock += 60_000;
  answers["harness:claude"] = "2";
  await retry.cache.refresh();
  assert.deepEqual(retry.lookups, ["harness:claude"]);
  assert.equal(retry.cache.get("harness:claude").latestVersion, "2");
  assert.deepEqual(retry.cache.errors(), {});
});

test("a failed forced lookup retains the last successful version and timestamp", async () => {
  const answers = { "harness:claude": "1" };
  const world = latestWorld({ answers });
  await world.cache.refresh();
  const before = world.cache.get("harness:claude");
  world.clock += 500;
  answers["harness:claude"] = new Error("offline");
  await world.cache.refresh({ force: true });
  assert.deepEqual(world.cache.get("harness:claude"), before);
  assert.equal(world.cache.errors()["harness:claude"], "offline");
  // A manual retry bypasses the failure backoff as well as the success TTL.
  answers["harness:claude"] = "2";
  await world.cache.refresh({ force: true });
  assert.equal(world.cache.get("harness:claude").latestVersion, "2");
  assert.deepEqual(world.cache.errors(), {});
});

test("a manual check queues one fresh pass behind a background check", async () => {
  let unblock, started;
  const gate = new Promise((resolve) => { started = resolve; });
  let version = "1", calls = 0;
  const cache = createLatestCache({
    keys: () => ["harness:claude"], read: async () => "{}", write: async () => {},
    lookup: async (key, { fresh }) => {
      assert.equal(fresh, true);
      calls++;
      const answer = version;
      if (calls === 1) { started(); await new Promise((resolve) => { unblock = resolve; }); }
      return answer;
    },
  });
  const background = cache.refresh({ force: true, manual: false });
  await gate;
  version = "2";
  const manual = cache.refresh({ force: true });
  const secondClick = cache.refresh({ force: true });
  unblock();
  await Promise.all([background, manual, secondClick]);
  assert.equal(calls, 2);
  assert.equal(cache.get("harness:claude").latestVersion, "2");
  assert.equal(cache.refreshing(), false);
});

test("new keys are checked immediately even after a recent successful pass", async () => {
  const answers = { "harness:claude": "1" };
  const world = latestWorld({ answers });
  await world.cache.refresh();
  answers["package:jq"] = "2";
  await world.cache.refresh();
  assert.deepEqual(world.lookups, ["harness:claude", "package:jq"]);
});

for (const olderFails of [false, true]) {
  test(`a superseded ${olderFails ? "failure" : "success"} cannot replace a newer targeted result`, async () => {
    let release, started;
    const gate = new Promise((resolve) => { started = resolve; });
    let calls = 0, saved;
    const cache = createLatestCache({
      keys: () => ["package:jq"], read: async () => "{}", write: async (text) => { saved = JSON.parse(text); },
      lookup: async () => {
        if (++calls > 1) return "2.0.0";
        started();
        await new Promise((resolve) => { release = resolve; });
        if (olderFails) throw new Error("obsolete failure");
        return "1.0.0";
      },
    });
    const background = cache.refresh();
    await gate;
    try { await cache.refreshOne("package:jq"); }
    finally { release(); await background; }
    assert.equal(cache.get("package:jq").latestVersion, "2.0.0");
    assert.deepEqual(cache.errors(), {});
    assert.equal(saved.versions["package:jq"].version, "2.0.0");
    assert.deepEqual(saved.failures, {});
  });
}

test("an older success cannot clear a newer targeted failure", async () => {
  let release, started;
  const gate = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const cache = createLatestCache({
    keys: () => ["package:jq"], read: async () => JSON.stringify({ versions: { "package:jq": { version: "1.8.0", at: 1 } } }), write: async () => {},
    lookup: async () => {
      if (++calls > 1) throw new Error("current failure");
      started(); await new Promise((resolve) => { release = resolve; }); return "1.9.0";
    },
  });
  const background = cache.refresh({ force: true, manual: false });
  await gate;
  try { await cache.refreshOne("package:jq"); }
  finally { release(); await background; }
  assert.equal(cache.get("package:jq").latestVersion, "1.8.0");
  assert.deepEqual(cache.errors(), { "package:jq": "current failure" });
});

test("overlapping saves cannot leave an older snapshot on disk", async () => {
  let release, started;
  const gate = new Promise((resolve) => { started = resolve; });
  let writes = 0, saved, version = "1";
  const cache = createLatestCache({
    keys: () => ["package:jq"], read: async () => "{}", lookup: async () => version,
    write: async (text) => {
      if (++writes === 1) { started(); await new Promise((resolve) => { release = resolve; }); }
      saved = JSON.parse(text);
    },
  });
  const first = cache.refreshOne("package:jq");
  await gate;
  version = "2";
  const second = cache.refreshOne("package:jq");
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cache.get("package:jq").latestVersion, "2");
  } finally { release(); await Promise.all([first, second]); }
  assert.equal(saved.versions["package:jq"].version, "2");
});

test("failure-only retries do not recheck successful rows past their TTL", async () => {
  const answers = { "harness:claude": new Error("offline"), "toolchain:go": "1" };
  const world = latestWorld({ answers, ttlMs: 1000 });
  await world.cache.refresh();
  world.clock += 60_000;
  await world.cache.refresh({ failedOnly: true });
  assert.deepEqual(world.lookups, ["harness:claude", "toolchain:go", "harness:claude"]);
  assert.equal(await world.cache.refresh({ failedOnly: true }), false, "failure backoff still applies");
});

test("slow lookups allow other rows to finish with at most three in flight", async () => {
  let unblock, started;
  const gate = new Promise((resolve) => { started = resolve; });
  let active = 0, maximum = 0;
  const cache = createLatestCache({
    keys: () => ["slow", "a", "b", "c", "d"], read: async () => "{}", write: async () => {},
    lookup: async (key) => {
      maximum = Math.max(maximum, ++active);
      if (key === "slow") { started(); await new Promise((resolve) => { unblock = resolve; }); }
      else await new Promise((resolve) => setImmediate(resolve));
      active--;
      return "2";
    },
  });
  const pass = cache.refresh();
  await gate;
  const deadline = Date.now() + 1000;
  try {
    while (!cache.get("d").latestVersion && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cache.get("d").latestVersion, "2", "later rows finish before the slow source");
    assert.equal(cache.refreshing(), true);
    assert.equal(cache.get("slow").latestVersion, null);
    assert.equal(maximum, 3);
  } finally { unblock(); await pass; }
});

// ----------------------------------------------------------- client address --

const fromPeer = (remoteAddress, forwardedFor) => ({
  socket: { remoteAddress },
  headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
});

test("a visitor connecting directly is its own address, whatever it claims", () => {
  assert.equal(clientAddress(fromPeer("192.168.1.20")), "192.168.1.20");
  assert.equal(clientAddress(fromPeer("::ffff:192.168.1.20")), "192.168.1.20");
  assert.equal(clientAddress(fromPeer("172.17.0.1", "127.0.0.1")), "172.17.0.1", "a header from outside the container is not believed");
  assert.equal(clientAddress(fromPeer(undefined)), "?");
});

test("through the router on loopback, the visitor is the address the router saw", () => {
  assert.equal(clientAddress(fromPeer("127.0.0.1", "203.0.113.9")), "203.0.113.9");
  assert.equal(clientAddress(fromPeer("::ffff:127.0.0.1", "203.0.113.9")), "203.0.113.9");
  assert.equal(clientAddress(fromPeer("::1", "2001:db8::7")), "2001:db8::7");
  assert.equal(clientAddress(fromPeer("127.0.0.1", "6.6.6.6, 10.0.0.4")), "10.0.0.4", "only the router's own entry, not what the visitor wrote before it");
  assert.equal(clientAddress(fromPeer("127.0.0.1", ["6.6.6.6", "10.0.0.4"])), "10.0.0.4", "repeated headers read as one list");
  assert.equal(clientAddress(fromPeer("127.0.0.1", "::ffff:10.0.0.4")), "10.0.0.4");
});

test("a loopback request without a usable forwarded address stays loopback", () => {
  assert.equal(clientAddress(fromPeer("127.0.0.1")), "127.0.0.1", "t3-expose and the other CLIs");
  assert.equal(clientAddress(fromPeer("127.0.0.1", "")), "127.0.0.1");
  assert.equal(clientAddress(fromPeer("127.0.0.1", "not-an-address")), "127.0.0.1");
  assert.ok(isLoopback("127.0.0.53") && isLoopback("::1") && isLoopback("::ffff:127.0.0.1"));
  assert.ok(!isLoopback("10.0.0.1") && !isLoopback("::2"));
  assert.equal(plainAddress("::ffff:1.2.3.4"), "1.2.3.4");
});
