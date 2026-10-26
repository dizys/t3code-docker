import assert from "node:assert/strict";
import test from "node:test";
import { nativeRegistry } from "./fixtures/native-registry.mjs";
import { registryRequest } from "../docker/runtime/registry.mjs";
import { packageRelease, releaseForVersion } from "../docker/runtime/distribution.mjs";
import { PATCH_REVISION, distributionTag, channelTag, manifestUrl } from "../docker/runtime/distribution-spec.mjs";
import { files, patchProjectDirectory } from "../docker/runtime/patches/project-directory.mjs";

const version = "0.1.3-nightly.20261025.3692";

test("native discovery binds the channel, image patch and tested architecture", async () => {
  const world = nativeRegistry({ stable: "0.1.2", nightly: version });
  const [stable, nightly] = await Promise.all([packageRelease("stable", world), packageRelease("nightly", world)]);
  assert.equal(stable.version, "0.1.2");
  assert.equal(nightly.version, version);
  assert.equal(stable.patchRevision, PATCH_REVISION);
  assert.match(nightly.url, /^https:\/\/ghcr.io\/v2\/dizys\/t3code-docker\/blobs\/sha256:/);
  assert.equal(world.calls.filter((call) => call.url.includes('/token?')).length, 1);
  assert.ok(world.calls.filter((call) => !call.url.includes('/token?')).every((call) => call.options.headers.authorization === 'Bearer public-native-fixture'));
});

test("a missing Nightly artifact does not block a successful Stable check", async () => {
  const world = nativeRegistry({ stable: "0.1.2", nightly: null });
  const results = await Promise.allSettled([packageRelease("stable", world), packageRelease("nightly", world)]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /HTTP 404/);
});

test("image indexes, other patch revisions, wrong channels and duplicate platforms are rejected", async () => {
  for (const mutate of [
    (index) => { delete index.artifactType; },
    (index) => { index.annotations['io.t3code.runtime.patch'] = 'b'.repeat(64); },
    (index) => { index.annotations['io.t3code.runtime.version'] = version; },
    (index) => { index.manifests.push(index.manifests.find((entry) => entry.platform.architecture === 'arm64')); },
  ]) {
    const world = nativeRegistry({ stable: '0.1.2' });
    const url = manifestUrl(channelTag('stable')), index = JSON.parse(world.records.get(url));
    mutate(index); world.records.set(url, JSON.stringify(index));
    await assert.rejects(packageRelease('stable', { ...world, arch: 'arm64' }), /patch|channel|exactly one/);
  }
});

test("exact version requests and child manifest bytes are verified independently", async () => {
  const world = nativeRegistry({ stable: '0.1.2' });
  const url = manifestUrl(distributionTag('0.1.2'));
  const index = JSON.parse(world.records.get(url));
  index.annotations['io.t3code.runtime.version'] = '0.1.3'; world.records.set(url, JSON.stringify(index));
  await assert.rejects(releaseForVersion('0.1.2', world), /different upstream version/);
  const other = nativeRegistry({ stable: '0.1.2' });
  for (const [key, value] of other.records) if (key.includes('/manifests/sha256:')) other.records.set(key, value + ' ');
  await assert.rejects(packageRelease('stable', other), /integrity check/);
});

test("incomplete platforms, corrupt root digests and invalid archive sizes fail discovery", async () => {
  const incomplete = nativeRegistry({ stable: '0.1.2' }), url = manifestUrl(channelTag('stable'));
  const index = JSON.parse(incomplete.records.get(url)); index.manifests.pop();
  incomplete.records.set(url, JSON.stringify(index));
  await assert.rejects(packageRelease('stable', incomplete), /missing a tested architecture/);
  const corrupt = nativeRegistry({ stable: '0.1.2' });
  await assert.rejects(packageRelease('stable', { fetcher: async (url, options) => {
    const response = await corrupt.fetcher(url, options);
    if (!url.includes('/token?')) response.headers.set('docker-content-digest', 'sha256:' + '0'.repeat(64));
    return response;
  } }), /integrity check/);
  for (const layerSize of [0, -1, 1.5, 301 * 1024 * 1024]) await assert.rejects(packageRelease('stable', nativeRegistry({ stable: '0.1.2', layerSize })), /descriptor is invalid/);
});

test("registry reads use only a scoped anonymous token and retry expired access once", async () => {
  const world = nativeRegistry({ stable: '0.1.2' });
  let requests = 0, tokens = 0;
  const fetcher = async (url, options) => {
    if (url.includes('/token?')) { tokens++; assert.equal(new URL(url).searchParams.get('scope'), 'repository:dizys/t3code-docker:pull'); }
    else if (requests++ === 0) return new Response('expired', { status: 401 });
    return world.fetcher(url, options);
  };
  await packageRelease('stable', { fetcher });
  assert.equal(tokens, 2);
  await assert.rejects(registryRequest('https://example.test/v2/runtime'), /Unsupported/);
  await assert.rejects(packageRelease('preview'), /Stable or Nightly/);
  await assert.rejects(releaseForVersion('../escape'), /exact Stable/);
});

test("invalid public-token responses are bounded and can recover on the next check", async () => {
  for (const body of ['not JSON', JSON.stringify({ token: '' }), JSON.stringify({ token: 'a'.repeat(70_000) })]) {
    const world = nativeRegistry({ stable: '0.1.2' }); let failed = true, downloads = 0;
    const fetcher = async (url, options) => {
      if (url.includes('/token?') && failed) return new Response(body);
      downloads++; return world.fetcher(url, options);
    };
    await assert.rejects(packageRelease('stable', { fetcher }));
    assert.equal(downloads, 0, 'invalid access cannot reach the package');
    failed = false;
    assert.equal((await packageRelease('stable', { fetcher })).version, '0.1.2');
  }
  let requests = 0;
  await assert.rejects(packageRelease('stable', { fetcher: async (url) => {
    if (url.includes('/token?')) return new Response(JSON.stringify({ token: 'denied' }));
    requests++; return new Response('unauthorized', { status: 401 });
  } }), /HTTP 401/);
  assert.equal(requests, 2, 'authentication retries are bounded');
});

const fixture = () => ({
  [files[0]]: '  t3Home: Config.String("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),\n  const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));\n    baseDir,\n    ...derivedPaths,',
  [files[1]]: '    readonly baseDir: string;',
  [files[2]]: '  const namedProjectsRoot = path.resolve(config.baseDir, "projects");',
});

test("source patch changes only the named-project configuration and preserves its fallback", () => {
  const input = fixture(), before = structuredClone(input), patched = patchProjectDirectory(input);
  assert.deepEqual(input, before);
  assert.match(patched[files[0]], /T3CODE_PROJECTS_DIR/);
  assert.match(patched[files[2]], /config.projectsDir \?\? path.resolve\(config.baseDir, "projects"\)/);
  assert.deepEqual(Object.keys(patched), files);
});

test("upstream source drift or an ambiguous anchor fails before modifying any input", () => {
  for (const ambiguous of [false, true]) {
    const input = fixture();
    input[files[2]] = ambiguous ? input[files[2]] + "\n" + input[files[2]] : "upstream changed this service";
    const before = structuredClone(input);
    assert.throws(() => patchProjectDirectory(input), /no longer matches/);
    assert.deepEqual(input, before);
  }
});
