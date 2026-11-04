import assert from "node:assert/strict";
import test from "node:test";
import { source } from "./fixtures/opencode-workspace-source.mjs";
import { files, patchOpenCodeSkills } from "../docker/runtime/patches/opencode-skills.mjs";
import { patches } from "../docker/runtime/patches/index.mjs";

test("runtime registers native plugin readiness before workspace inventory is cached", () => {
  const before = structuredClone(source), result = patchOpenCodeSkills(source);
  assert.deepEqual(source, before);
  assert.ok(patches.some((patch) => patch.name === "opencode-skills"));
  assert.match(result[files[0]], /client\.plugin\.list\(\{ location \}\)/);
  assert.match(result[files[0]], /opencode\.config\.skill/);
  assert.match(result[files[0]], /opencode\.config\.command/);
  assert.match(result[files[0]], /plugin\.state\?\.status === "active"/);
  assert.match(result[files[1]], /Effect\.timeout\("10 seconds"\)/);
  assert.doesNotMatch(result[files[1]], /timeoutOption|first\.commands/);
});

test("workspace loading awaits native completion even with built-in or custom commands", () => {
  const result = patchOpenCodeSkills(source)[files[1]];
  const start = result.indexOf("    // The first read starts discovery;");
  const body = result.slice(start, result.indexOf("\n  },", start));
  const run = new Function("read", "scanned", "Effect", `return (function* () {${body}})()`);
  const read = { *[Symbol.iterator]() { return yield "read"; } };
  const scanned = { pipe(timeout) { assert.equal(timeout, "timeout"); return { *[Symbol.iterator]() { yield "ready"; } }; } };
  for (const first of [
    { commands: [], skills: [] },
    { commands: [{ name: "help" }], skills: [] },
    { commands: [{ name: "custom" }], skills: [{ id: "opencode" }] },
  ]) {
    const iterator = run(read, scanned, { timeout(duration) { assert.equal(duration, "10 seconds"); return "timeout"; } });
    assert.equal(iterator.next().value, "read");
    assert.equal(iterator.next(first).value, "ready");
    assert.equal(iterator.next().value, "read");
    const complete = { commands: [], skills: [] };
    assert.deepEqual(iterator.next(complete), { done: true, value: complete }, "A genuinely empty workspace is valid after native completion.");
  }
});

test("source drift and repeated anchors fail before modifying input", () => {
  for (const file of files) for (const ambiguous of [false, true]) {
    const input = structuredClone(source);
    input[file] = ambiguous ? input[file] + input[file] : "upstream changed";
    const before = structuredClone(input);
    assert.throws(() => patchOpenCodeSkills(input), /no longer matches/);
    assert.deepEqual(input, before);
  }
});
