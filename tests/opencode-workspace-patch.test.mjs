import assert from "node:assert/strict";
import test from "node:test";
import { source } from "./fixtures/opencode-workspace-source.mjs";
import { normalizedSource } from "./fixtures/opencode-workspace-normalized-source.mjs";
import { settledSource } from "./fixtures/opencode-workspace-settled-source.mjs";
import { files, patchOpenCodeSkills } from "../docker/runtime/patches/opencode-skills.mjs";
import { patches } from "../docker/runtime/patches/index.mjs";

for (const [version, input] of [["retained and Stable", source], ["normalized Nightly", normalizedSource], ["settled Nightly 4606", settledSource]]) {
  test(`${version}: runtime registers native plugin readiness before workspace inventory is cached`, () => {
    const before = structuredClone(input), result = patchOpenCodeSkills(input);
    assert.deepEqual(input, before);
    assert.ok(patches.some((patch) => patch.name === "opencode-skills"));
    assert.match(result[files[0]], /client\.plugin\.list\(\{ location \}\)/);
    assert.match(result[files[0]], /opencode\.config\.skill/);
    assert.match(result[files[0]], /opencode\.config\.command/);
    assert.match(result[files[0]], /plugin\.state\?\.status === "active"/);
    assert.match(result[files[1]], /Effect\.timeout\("10 seconds"\)/);
    assert.doesNotMatch(result[files[1]], /timeoutOption|first\.commands/);
  });

  test(`${version}: workspace loading awaits native completion even with built-in or custom commands`, () => {
    const result = patchOpenCodeSkills(input)[files[1]];
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

  test(`${version}: source drift and repeated anchors fail before modifying input`, () => {
    for (const file of files) for (const ambiguous of [false, true]) {
      const changed = structuredClone(input);
      changed[file] = ambiguous ? changed[file] + changed[file] : "upstream changed";
      const before = structuredClone(changed);
      assert.throws(() => patchOpenCodeSkills(changed), /no longer matches/);
      assert.deepEqual(changed, before);
    }
    assert.throws(() => patchOpenCodeSkills(patchOpenCodeSkills(input)), /no longer matches/);
  });
}

test("normalized Nightly paths are preserved and loaded-location shortcuts cannot bypass plugin readiness", () => {
  const result = patchOpenCodeSkills(normalizedSource);
  assert.match(result[files[0]], /const directory = pathService\.resolve\(cwd\);\n\s+const location = \{ directory \};/);
  assert.match(result[files[0]], /client\.plugin\.list\(\{ location \}\)/);
  assert.doesNotMatch(result[files[0]], /events|stream\._tag|client\.debug\.location|Deferred|Stream/);
  assert.doesNotMatch(result[files[1]], /wasLoaded|loaded:|first\.commands|timeoutOption/);
  assert.throws(() => patchOpenCodeSkills({ ...normalizedSource, [files[0]]: normalizedSource[files[0]].replace('pathService.resolve(cwd)', 'cwd') }), /no longer matches/);
});

test("settled Nightly replaces the upstream catalog barrier with native plugin readiness", () => {
  const result = patchOpenCodeSkills(settledSource);
  assert.match(result[files[0]], /const directory = pathService\.resolve\(cwd\);/);
  assert.match(result[files[0]], /client\.plugin\.list\(\{ location \}\)/);
  assert.doesNotMatch(result[files[0]], /client\.provider\.list|client\.debug\.location|Deferred|Stream|stream\._tag/);
  assert.doesNotMatch(result[files[1]], /settled|wasLoaded|loaded:|first\.commands|timeoutOption/);
  for (const [file, before, after] of [
    [files[0], 'client.provider.list({ location })', 'client.provider.list({ directory })'],
    [files[1], 'settled: Effect.Effect<void> = Effect.void,', 'settled: Effect.Effect<void>,'],
  ]) {
    const changed = { ...settledSource, [file]: settledSource[file].replace(before, after) };
    assert.throws(() => patchOpenCodeSkills(changed), /no longer matches/, "unreviewed settlement changes fail closed");
  }
});
