// Stage a real nightly in a disposable home, without selecting it or restarting
// the container. CI runs this inside both images on native amd64 and arm64.
// Locally: node scripts/t3-runtime-smoke.mjs docker/runtime docker/t3-client/setup-bridge.js
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const directory = path.resolve(process.argv[2] || "/opt/t3-runtime");
const bridge = path.resolve(process.argv[3] || "/usr/local/share/t3-client/setup-bridge.js");
const { packageRelease, installRelease } = await import(pathToFileURL(path.join(directory, "manager.mjs")));
const { runtimePaths, readJson } = await import(pathToFileURL(path.join(directory, "state.mjs")));
const { PATCH_REVISION, distributionBlob } = await import(pathToFileURL(path.join(directory, "distribution-spec.mjs")));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-runtime-smoke-"));
try {
  const env = { ...process.env, HOME: root, T3CODE_HOME: path.join(root, "home") };
  const paths = runtimePaths(env);
  const local = process.env.T3_RUNTIME_SMOKE_ARCHIVE;
  const bytes = local ? await fs.readFile(local) : null;
  const version = process.env.T3_RUNTIME_SMOKE_VERSION;
  const stem = `t3-${version}-linux-${process.arch}`;
  const hash = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
  const release = bytes ? { version, name: "t3-runtime", root: stem, url: distributionBlob(`sha256:${hash}`), integrity: `sha256-${hash}`, patchRevision: PATCH_REVISION } : await packageRelease("nightly");
  assert.match(release.integrity, /^sha256-[a-f0-9]{64}$/);
  assert.ok(release.root.endsWith(`-linux-${process.arch}`));
  const staged = await installRelease(paths, release, { env, bridge, ...(bytes ? { fetcher: async (url) => new Response(url.includes("/token?") ? JSON.stringify({ token: "local-smoke" }) : bytes) } : {}) });
  const metadata = await readJson(path.join(staged, ".installed.json"));
  assert.equal(metadata.version, release.version);
  assert.equal(metadata.integrity, release.integrity);
  assert.equal(metadata.patchRevision, PATCH_REVISION, "the image integration patch survives native updates");
  assert.ok(metadata.database && metadata.scopes.length, "native auth capabilities were probed");
  const output = await promisify(execFile)(path.join(staged, "t3"), ["--version"], { env, timeout: 30_000 });
  assert.ok(output.stdout.includes(release.version));
  const html = await fs.readFile(path.join(staged, "client/index.html"), "utf8");
  assert.equal(html.split("<script data-t3-setup-bridge>").length, 2, "one Setup bridge");
  assert.equal(await readJson(paths.selection), null, "staging cannot select a runtime");
  assert.equal(await readJson(paths.request), null, "staging cannot request a restart");
  console.log(`Verified maintained Nightly ${release.version} on linux/${process.arch}; Setup, protocol and native auth probes passed.`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
