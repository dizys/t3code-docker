import assert from "node:assert/strict";
import test from "node:test";
import { source } from "./fixtures/opencode-workspace-source.mjs";
import { normalizedSource } from "./fixtures/opencode-workspace-normalized-source.mjs";
import { settledSource } from "./fixtures/opencode-workspace-settled-source.mjs";
import { scansSource } from "./fixtures/opencode-workspace-scans-source.mjs";
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

test("Nightly 5209 waits for config plugins and keeps watching the model catalog", () => {
  const before = structuredClone(scansSource);
  const [driver, status] = files;
  const result = patchOpenCodeSkills(scansSource);
  assert.deepEqual(scansSource, before);
  assert.match(result[driver], /Stream\.runForEach\(openCode2Server\.connections, followMachineCatalog\)/);
  assert.match(result[driver], /const directory = pathService\.resolve\(cwd\);/);
  assert.match(result[driver], /client\.plugin\.list\(\{ location \}\)/);
  assert.match(result[driver], /opencode\.config\.skill/);
  assert.match(result[driver], /opencode\.config\.command/);
  assert.match(result[driver], /scanned,\s+processEnv,/);
  assert.doesNotMatch(result[driver], /followScans|followOpenCode2Scans|seen\.|Deferred/);
  assert.match(result[status], /yield\* read;\s+yield\* scanned\.pipe\(Effect\.timeout\(resolveProviderProbeTimeoutMs\("opencode", 10_000, environment\)\)\);\s+return yield\* read;/);
  assert.doesNotMatch(result[status], /sawScan|timeoutOption/);
  for (const [file, anchor] of [[driver, 'seen.has(directory)'], [status, 'if (sawScan) return first;']]) {
    const changed = { ...scansSource, [file]: scansSource[file].replace(anchor, '') };
    assert.throws(() => patchOpenCodeSkills(changed), /no longer matches/);
  }
});

test("Stable 0.1.13 and Nightly 5319 retain shared skill updates with native readiness", () => {
  const [driver] = files;
  const original = scansSource[driver]
    .replace('import * as Deferred from "effect/Deferred";', 'import * as Deferred from "effect/Deferred";\nimport * as Scope from "effect/Scope";')
    .replace('    const followScans =', `    const skillRescans = yield* Queue.unbounded<string, Cause.Done>();
    // The shared subscription also publishes late skill updates.
    const followScans =`)
    .replace('withConnection(({ client, events, url }) =>\n        Effect.gen(function* () {', `withConnection((connection) =>
        Effect.gen(function* () {
          const { client, events, url } = connection;
          const [, stream] = yield* Effect.all(
            [followScans(connection), events.pipe(Effect.option)],
            {
              concurrency: "unbounded",
            },
          );`)
    .replace('          const stream = yield* events.pipe(Effect.option);\n', '')
    .replace('          return workspace;', `          listed.set(directory, cwd);
          yield* Queue.offer(skillRescans, cwd);
          return workspace;`);
  const result = patchOpenCodeSkills({ ...scansSource, [driver]: original })[driver];
  const start = '    const listOpenCode2Workspace';
  assert.equal(result.slice(0, result.indexOf(start)).replace('import * as Schedule from "effect/Schedule";\n', ''), original.slice(0, original.indexOf(start)));
  const workspace = result.slice(result.indexOf(start));
  assert.match(workspace, /yield\* followScans\(connection\)/);
  assert.match(workspace, /client\.plugin\.list\(\{ location \}\)/);
  assert.match(workspace, /listed\.set\(directory, cwd\)/);
  assert.match(workspace, /Queue\.offer\(skillRescans, cwd\)/);
  assert.doesNotMatch(workspace, /Deferred|events\.pipe|seen\.has/);
});
