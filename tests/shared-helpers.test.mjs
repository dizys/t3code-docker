// Parity for the shared helper extraction: release bounds, capped reads,
// atomic writes and chatter-tolerant JSON parsing. Each case pins the exact
// behavior the duplicated copies had, so the shared modules must agree with
// the legacy inline logic and with each other.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARCHIVE_LIMIT, UNPACKED_LIMIT, RELEASE_HEADROOM, SUMS_LIMIT, DOCUMENT_LIMIT,
  isSha256Digest, isSha256Integrity, digestOfText,
} from "../docker/runtime/release-bounds.mjs";
import { chatterSlice } from "../docker/runtime/releases.mjs";
import { chatterSlice as harnessSlice, jsonFromChatter as harnessJson } from "../docker/harness/chatter-json.mjs";
import { chatterSlice as setupSlice, jsonFromChatter as setupJson } from "../docker/setup/chatter-json.mjs";
import { jsonFrom } from "../docker/setup/connect.mjs";
import { READ_FLAGS, readCappedFile, readHandleCapped } from "../docker/setup/bounded-read.mjs";
import { writeFileAtomic, writeJsonAtomic } from "../docker/setup/atomic-write.mjs";
import { readSkillFile } from "../docker/setup/skills.mjs";

test("release bounds match the legacy per-file limits", () => {
  assert.equal(ARCHIVE_LIMIT, 300 * 1024 * 1024);
  assert.equal(UNPACKED_LIMIT, 1024 * 1024 * 1024);
  assert.equal(RELEASE_HEADROOM, 64 * 1024 * 1024);
  assert.equal(SUMS_LIMIT, 1024 * 1024);
  assert.equal(DOCUMENT_LIMIT, 4 * 1024 * 1024);
});

test("shared digest predicates match the legacy inline checks", () => {
  const legacyDigest = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
  const legacyIntegrity = (value) => typeof value === "string" && /^sha256-[a-f0-9]{64}$/.test(value);
  const cases = ["sha256:" + "a".repeat(64), "sha256-" + "b".repeat(64), "sha256:" + "A".repeat(64),
    "sha256-" + "c".repeat(63), "sha256:xyz", "", null, undefined, 42, "sha256-" + "d".repeat(65)];
  for (const value of cases) {
    assert.equal(isSha256Digest(value), legacyDigest(value), String(value));
    assert.equal(isSha256Integrity(value), legacyIntegrity(value), String(value));
  }
  for (const text of ["", "index", "manifest-bytes"]) {
    assert.equal(digestOfText(text), "sha256:" + createHash("sha256").update(text).digest("hex"));
  }
});

test("every chatter parser agrees, including the runtime slice", () => {
  const inputs = ["{\"a\":1}", "log line\n{\"a\":1}\ntrailing", "no json here", "{ broken",
    "", null, undefined, 42, "{\"nested\":{\"b\":[1,2]}} chatter", "{{}}"];
  for (const input of inputs) {
    const slices = [chatterSlice(input), harnessSlice(input), setupSlice(input)];
    assert.deepEqual(slices.slice(1), [slices[0], slices[0]], JSON.stringify(input));
    const parsed = [harnessJson(input), setupJson(input), jsonFrom(input)];
    assert.deepEqual(parsed.slice(1), [parsed[0], parsed[0]], JSON.stringify(input));
    if (slices[0] === null) assert.equal(parsed[0], null);
    else {
      let expected = null;
      try { expected = JSON.parse(slices[0]); } catch { /* stays null */ }
      assert.deepEqual(parsed[0], expected);
    }
  }
});

test("capped reads enforce limits before open and bound short reads", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-shared-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exact = path.join(root, "exact.md");
  await fs.writeFile(exact, "x".repeat(64));
  assert.equal((await readCappedFile(fs, exact, 64)).bytes, 64);
  const over = path.join(root, "over.md");
  await fs.writeFile(over, "x".repeat(65));
  let opened = 0;
  const guarded = { ...fs, open: async () => { opened += 1; throw new Error("oversized file opened"); } };
  await assert.rejects(readCappedFile(guarded, over, 64), /limit/);
  assert.equal(opened, 0);
  await assert.rejects(readCappedFile(fs, root, 64), /regular/);
  // Symlinks are not followed.
  const link = path.join(root, "link.md");
  await fs.symlink(exact, link);
  await assert.rejects(readCappedFile(fs, link, 64), { code: "ELOOP" });
  // Short reads accumulate until the limit plus one.
  const growing = path.join(root, "growing.md");
  await fs.writeFile(growing, "y".repeat(10));
  let calls = 0;
  const short = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { ...handle, stat: () => handle.stat(), close: () => handle.close(),
      read: async (buffer, offset, length, position) => {
        calls += 1;
        if (calls === 2) await fs.writeFile(growing, "y".repeat(100));
        return handle.read(buffer, offset, Math.min(length, 3), position);
      } };
  } };
  await assert.rejects(readCappedFile(short, growing, 64, { tooLarge: (bytes) => Object.assign(new Error("big:" + bytes), { code: "too_large", bytes }) }), { code: "too_large" });
  assert.ok(calls > 3);
  // The plain-"r" open used for the shared instruction file still follows links.
  const via = await readCappedFile(fs, link, 64, { flags: "r" });
  assert.equal(via.bytes, 64);
});

test("capped reads agree with the skill reader", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-shared-skill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "SKILL.md");
  await fs.writeFile(file, "---\nname: x\n---\nbody\n");
  const shared = await readCappedFile(fs, file, 64 * 1024, {
    invalid: () => Object.assign(new Error("The skill must be a regular Markdown file."), { code: "invalid" }),
    tooLarge: () => Object.assign(new Error("This skill exceeds the 64 KiB viewer limit."), { code: "too_large" }),
  });
  const direct = await readSkillFile(file);
  assert.equal(shared.content, direct.content);
  assert.equal(shared.mode, direct.mode);
});

test("handle-level reads match the settings snapshot loop", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-shared-handle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "settings.toml");
  await fs.writeFile(file, "a".repeat(5000));
  const handle = await fs.open(file, READ_FLAGS);
  try {
    const read = await readHandleCapped(handle, 1024 * 1024);
    assert.equal(read.bytes, 5000);
    assert.equal(read.raw.length, 5000);
    assert.equal(read.content, "a".repeat(5000));
  } finally { await handle.close(); }
});

test("atomic writes replace durably with exact modes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-shared-atomic-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "nested", "store.json");
  await writeJsonAtomic(fs, file, { version: 1, servers: [{ name: "a" }] });
  assert.equal(await fs.readFile(file, "utf8"), '{\n  "version": 1,\n  "servers": [\n    {\n      "name": "a"\n    }\n  ]\n}\n');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await writeFileAtomic(fs, file, "replaced\n", 0o640);
  assert.equal(await fs.readFile(file, "utf8"), "replaced\n");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  const leftovers = (await fs.readdir(path.dirname(file))).filter((name) => name.includes(".tmp."));
  assert.deepEqual(leftovers, []);
});
