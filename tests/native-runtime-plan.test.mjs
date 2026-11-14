import assert from "node:assert/strict";
import test from "node:test";
import { buildNodeImage, nativeRuntimePlan } from "../scripts/native-runtime-plan.mjs";
import { DOCUMENT_LIMIT } from "../docker/runtime/release-bounds.mjs";

const stable = "0.1.9", nightly = "0.1.10-nightly.20261114.4709";
function upstream(packages = { [stable]: "26.12.1", [nightly]: "26.13.1" }) {
  const calls = [];
  return {
    calls,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      const version = Object.keys(packages).find(version => url === `https://raw.githubusercontent.com/pingdotgg/t3code/v${version}/package.json`);
      assert(version, "Read only the exact release's root package manifest.");
      assert.equal(options.redirect, "manual");
      assert(options.signal instanceof AbortSignal);
      assert.equal(options.headers.authorization, undefined, "Public source reads must not forward credentials.");
      return Response.json({ engines: { node: packages[version] } });
    },
    resolveRelease: async channel => ({ version: channel === "stable" ? stable : nightly }),
  };
}

test("native CI uses each exact release's Node version on both architectures when channels diverge", async () => {
  const world = upstream();
  const output = await nativeRuntimePlan({ bundled: true, pinned: stable, ...world });
  const jobs = JSON.parse(output.matrix).include;
  assert.equal(jobs.length, 4);
  assert.deepEqual(JSON.parse(output.versions), [stable, nightly]);
  assert.equal(output.bundled, stable);
  assert.equal(output.nightly, nightly);
  for (const version of [stable, nightly]) {
    const selected = jobs.filter(job => job.version === version);
    assert.deepEqual(selected.map(job => job.arch), ["amd64", "arm64"]);
    assert.deepEqual(selected.map(job => job.nodeArch), ["x64", "arm64"]);
    assert(selected.every(job => job.buildNodeImage === (version === stable ? "node:26.12.1-trixie-slim" : "node:26.13.1-trixie-slim")));
  }
  assert.equal(world.calls.length, 2, "Resolve toolchains once per release, not once per architecture.");
});

test("an exact requested release does not follow either moving channel", async () => {
  const world = upstream();
  const output = await nativeRuntimePlan({ requested: stable, ...world, resolveRelease: () => assert.fail("No channel lookup for an exact request.") });
  assert.deepEqual(JSON.parse(output.versions), [stable]);
  assert.equal(JSON.parse(output.matrix).include.length, 2);
  assert.equal(world.calls.length, 1);
  assert.equal(output.nightly, "");
});

test("scheduled native plans resolve both channels and deduplicate repeated releases", async () => {
  const world = upstream();
  const output = await nativeRuntimePlan({ ...world });
  assert.deepEqual(JSON.parse(output.versions), [stable, nightly]);
  const repeated = upstream();
  const one = await nativeRuntimePlan({ ...repeated, resolveRelease: async () => ({ version: stable }) });
  assert.equal(JSON.parse(one.matrix).include.length, 2);
  assert.equal(repeated.calls.length, 1);
});

test("unsupported Node declarations cannot select arbitrary or floating builder images", async () => {
  for (const node of [undefined, null, 26, "", "26", "^26.13.1", ">=26", "v26.13.1", "026.13.1", "26.013.1", "26.13.01", "26.13.1-alpine", "26.13.1\nIMAGE=other", "25.9.0"]) {
    await assert.rejects(buildNodeImage(stable, upstream({ [stable]: node })), /exact Node 26 or newer/);
  }
});

test("invalid release identities fail before a source request", async () => {
  const fetcher = () => assert.fail("No network request for an invalid release.");
  for (const version of ["latest", "nightly", "../main", "0.1.9\nNODE_IMAGE=other"]) {
    await assert.rejects(buildNodeImage(version, { fetcher }), /exact upstream/);
    await assert.rejects(nativeRuntimePlan({ requested: version, fetcher }), /exact upstream/);
  }
});

test("missing, redirected, malformed or oversized source metadata cannot fall back to the bundled toolchain", async () => {
  for (const response of [
    new Response("not found", { status: 404 }),
    new Response(null, { status: 302, headers: { location: "https://example.test/package.json" } }),
    new Response("{bad json"),
    new Response(" ".repeat(DOCUMENT_LIMIT + 1)),
    Response.json({}),
  ]) {
    await assert.rejects(nativeRuntimePlan({ requested: nightly, fetcher: async () => response }));
  }
});
