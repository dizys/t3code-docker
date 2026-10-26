// Exercise the real ORAS writer and runtime reader in a local OCI layout.
// All archives are synthetic and no registry login or network is used.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publishRuntime } from "./publish-t3-runtime.mjs";
import { packageRelease, releaseForVersion } from "../docker/runtime/distribution.mjs";
import { archiveStem } from "../docker/runtime/releases.mjs";
import { PATCH_REVISION } from "../docker/runtime/distribution-spec.mjs";

const execute = promisify(execFile), root = await fs.mkdtemp(path.join(os.tmpdir(), "native-oci-smoke-"));
const layout = path.join(root, "layout"), artifacts = path.join(root, "artifacts");
try {
  for (const version of ["0.1.2", "0.1.3", "0.1.4-nightly.20261026.1", "0.1.4"]) {
    for (const arch of ["x64", "arm64"]) {
      const stem = archiveStem(version, arch), content = path.join(root, stem), output = path.join(artifacts, `native-${version}-${arch === "x64" ? "amd64" : "arm64"}`);
      await fs.mkdir(content, { recursive: true }); await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(content, "package.json"), JSON.stringify({ name: "t3-runtime", version, containerPatch: { revision: PATCH_REVISION, source: "a".repeat(40), upstreamIntegrity: "sha256-" + "b".repeat(64) } }));
      const archive = path.join(output, `${stem}.tar.gz`);
      await execute("tar", ["-czf", archive, "-C", root, stem]);
      await fs.writeFile(path.join(output, "SHA256SUMS"), createHash("sha256").update(await fs.readFile(archive)).digest("hex") + `  ${stem}.tar.gz\n`);
    }
    if (version !== "0.1.4") await publishRuntime(version, artifacts, { layout, sourceSha: "c".repeat(40) });
  }
  await publishRuntime("0.1.2", artifacts, { layout, sourceSha: "c".repeat(40) });
  const fetcher = async (url) => {
    if (url.includes("/token?")) return new Response(JSON.stringify({ token: "offline-layout" }));
    const target = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
    let digest = target;
    if (!target.startsWith("sha256:")) {
      const index = JSON.parse(await fs.readFile(path.join(layout, "index.json"), "utf8"));
      digest = index.manifests.find((entry) => entry.annotations?.["org.opencontainers.image.ref.name"] === target)?.digest;
    }
    if (!digest) return new Response("not found", { status: 404 });
    return new Response(await fs.readFile(path.join(layout, "blobs/sha256", digest.slice(7))));
  };
  const stable = await packageRelease("stable", { fetcher }), nightly = await packageRelease("nightly", { fetcher });
  assert.equal(stable.version, "0.1.3", "publishing an older version cannot move the Stable alias back");
  assert.equal(nightly.version, "0.1.4-nightly.20261026.1");
  await fs.writeFile(path.join(artifacts, "native-0.1.4-arm64/SHA256SUMS"), "0".repeat(64) + "  t3-0.1.4-linux-arm64.tar.gz\n");
  await assert.rejects(publishRuntime("0.1.4", artifacts, { layout, sourceSha: "c".repeat(40) }), /failed its checksum/);
  await assert.rejects(releaseForVersion("0.1.4", { fetcher }), /HTTP 404/);
  assert.equal((await packageRelease("stable", { fetcher })).version, "0.1.3", "a failed architecture cannot advance the public channel");
  for (const arch of ["arm64", "x64"]) {
    const exact = await releaseForVersion("0.1.2", { fetcher, arch });
    assert.equal(exact.patchRevision, PATCH_REVISION);
    const response = await fetcher(exact.url), bytes = Buffer.from(await response.arrayBuffer());
    assert.equal("sha256-" + createHash("sha256").update(bytes).digest("hex"), exact.integrity);
  }
  console.log("Native OCI publication, architecture selection, immutable versions, checksum rejection and monotonic channel aliases passed.");
} finally { await fs.rm(root, { recursive: true, force: true }); }
