import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeviceLabels, DEVICE_LABEL_FILE } from "../docker/setup/device-labels.mjs";

const fixture = (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "t3-device-labels-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const sessions = [
    { sessionId: "phone", client: { label: "iPhone", os: "iOS" }, connected: true, expiresAt: "2026-11-09T12:00:00Z", scopes: ["terminal:write"] },
    { sessionId: "laptop", client: { browser: "Chrome", os: "Linux" }, connected: false },
    { sessionId: "console", subject: "t3-setup-console" },
  ];
  const options = { stateDir, listSessions: async () => sessions, isDevice: (session) => session.subject !== "t3-setup-console" };
  return { stateDir, sessions, options, labels: createDeviceLabels(options), file: path.join(stateDir, DEVICE_LABEL_FILE) };
};

test("renaming keeps the existing pairing and original metadata, and survives a new service instance", async (t) => {
  const { labels, sessions, options, file, stateDir } = fixture(t);
  const original = structuredClone(sessions);
  const result = await labels.rename({ id: "phone", label: "  Work phone 📱  " });
  assert.equal(result.http, 200);
  assert.equal(result.body.label, "Work phone 📱");
  assert.equal(result.body.changed, true);
  assert.deepEqual(result.body.session, { ...original[0], setupLabel: "Work phone 📱" });
  assert.deepEqual(sessions, original, "the credentials, expiration, connection state and native label are untouched");
  assert.equal(createDeviceLabels(options).apply(sessions)[0].setupLabel, "Work phone 📱");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(stateDir), [DEVICE_LABEL_FILE], "no partial or temporary file remains");
});

test("clearing a custom label restores the native name, and a repeat save is unchanged", async (t) => {
  const { labels, sessions, options } = fixture(t);
  await labels.rename({ id: "phone", label: "Work phone" });
  assert.equal((await labels.rename({ id: "phone", label: "Work phone" })).body.changed, false);
  const reset = await labels.rename({ id: "phone", label: "  " });
  assert.equal(reset.body.label, null);
  assert.deepEqual(reset.body.session, sessions[0]);
  assert.deepEqual(createDeviceLabels(options).apply(sessions), sessions);
});

test("invalid requests cannot create a label or trigger a session lookup", async (t) => {
  const { options, stateDir } = fixture(t);
  let lookups = 0;
  const labels = createDeviceLabels({ ...options, listSessions: async () => { lookups++; return []; } });
  for (const input of [null, {}, { id: "../phone", label: "Phone" }, { id: "phone", label: null },
    { id: "phone", label: "x".repeat(65) }, { id: "phone", label: "two\nlines" }, { id: "phone", label: "two\u2028lines" }, { id: "phone", label: "null\0byte" }]) {
    assert.equal((await labels.rename(input)).http, 400, JSON.stringify(input));
  }
  assert.equal(lookups, 0);
  assert.deepEqual(readdirSync(stateDir), []);
});

test("only an active device can be renamed, and the internal console session is excluded", async (t) => {
  const { labels, sessions, stateDir } = fixture(t);
  for (const id of ["unknown", "console"]) assert.equal((await labels.rename({ id, label: "New name" })).http, 404);
  sessions.splice(0, 1);
  assert.equal((await labels.rename({ id: "phone", label: "New name" })).http, 404);
  assert.deepEqual(readdirSync(stateDir), []);
});

test("concurrent renames of different devices preserve both labels", async (t) => {
  const { labels, sessions } = fixture(t);
  const results = await Promise.all([
    labels.rename({ id: "phone", label: "Personal phone" }),
    labels.rename({ id: "laptop", label: "Work laptop" }),
  ]);
  assert.ok(results.every((result) => result.http === 200));
  assert.deepEqual(labels.apply(sessions).slice(0, 2).map((session) => session.setupLabel), ["Personal phone", "Work laptop"]);
});

test("a later save discards labels for sessions revoked elsewhere", async (t) => {
  const { labels, sessions, file } = fixture(t);
  await labels.rename({ id: "phone", label: "Old phone" });
  sessions.splice(0, 1);
  await labels.rename({ id: "laptop", label: "Laptop" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).labels, { laptop: "Laptop" });
});

test("a failed or malformed session lookup does not report a successful rename", async (t) => {
  const { options, stateDir } = fixture(t);
  for (const listSessions of [async () => { throw new Error("T3 is down"); }, async () => null]) {
    const labels = createDeviceLabels({ ...options, listSessions });
    assert.equal((await labels.rename({ id: "phone", label: "Phone" })).http, 502);
  }
  assert.deepEqual(readdirSync(stateDir), []);
});

test("damaged saved labels are not overwritten by a rename", async (t) => {
  const { labels, file } = fixture(t);
  for (const data of ['{"unfinished":', JSON.stringify({ version: 2, labels: {} }), JSON.stringify({ version: 1, labels: { phone: "two\nlines" } })]) {
    writeFileSync(file, data);
    assert.throws(() => labels.apply([]));
    assert.equal((await labels.rename({ id: "phone", label: "Phone" })).http, 500);
    assert.equal(readFileSync(file, "utf8"), data);
  }
});
