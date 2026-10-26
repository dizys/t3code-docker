import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { exactVersion, channelOf } from "../docker/runtime/state.mjs";
import { archiveStem } from "../docker/runtime/releases.mjs";
import { compareVersions } from "../docker/harness/version.mjs";
import { releaseForVersion, validateDistributionIndex } from "../docker/runtime/distribution.mjs";
import { PATCH_REVISION, REPOSITORY, ARTIFACT_TYPE, ARCHIVE_TYPE, distributionTag, channelTag } from "../docker/runtime/distribution-spec.mjs";

const execute = promisify(execFile), INDEX = "application/vnd.oci.image.index.v1+json";
export async function publishRuntime(version, directory, { run = execute, layout = process.env.T3_RUNTIME_PUBLISH_LAYOUT, sourceSha = process.env.GITHUB_SHA } = {}) {
  if (!exactVersion(version) || !/^[a-f0-9]{40}$/.test(sourceSha || "")) throw new Error("Publishing requires an exact native version and Docker source commit.");
  const destination = layout ? path.resolve(layout) : `ghcr.io/${REPOSITORY}`;
  const flags = layout ? ["--oci-layout"] : [], tag = distributionTag(version);
  const command = (args, cwd) => run("oras", [...args, ...flags], { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60_000 });
  const lookup = async (ref) => {
    try { return JSON.parse((await command(["manifest", "fetch", `${destination}:${ref}`])).stdout); }
    catch (error) { if (/not found|HTTP 404|no such file|NAME_UNKNOWN|MANIFEST_UNKNOWN/i.test(error.stderr || error.message)) return null; throw error; }
  };
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "native-publish-"));
  try {
    let existing = await lookup(tag);
    if (existing) validateDistributionIndex(existing);
    if (existing && (existing.artifactType !== ARTIFACT_TYPE || existing.annotations?.["io.t3code.runtime.patch"] !== PATCH_REVISION || existing.annotations?.["io.t3code.runtime.version"] !== version)) throw new Error("An immutable native tag has conflicting provenance.");
    if (!existing) {
      const prepared = [];
      for (const arch of ["x64", "arm64"]) {
        const stem = archiveStem(version, arch), file = `${stem}.tar.gz`, platform = arch === "x64" ? "amd64" : "arm64";
        const dir = path.join(directory, `native-${version}-${platform}`), archive = path.join(dir, file);
        const bytes = await fs.readFile(archive), hash = createHash("sha256").update(bytes).digest("hex");
        if ((await fs.readFile(path.join(dir, "SHA256SUMS"), "utf8")).trim() !== `${hash}  ${file}`) throw new Error("A tested native artifact failed its checksum.");
        const manifest = JSON.parse((await execute("tar", ["-xOf", archive, `${stem}/package.json`], { maxBuffer: 1024 * 1024 })).stdout);
        if (manifest.name !== "t3-runtime" || manifest.version !== version || manifest.containerPatch?.revision !== PATCH_REVISION || !/^[a-f0-9]{40}$/.test(manifest.containerPatch.source) || !/^sha256-[a-f0-9]{64}$/.test(manifest.containerPatch.upstreamIntegrity)) throw new Error("Native artifact provenance differs from this source patch.");
        await fs.copyFile(archive, path.join(output, file));
        prepared.push({ file, platform, source: manifest.containerPatch.source });
      }
      if (prepared[0].source !== prepared[1].source) throw new Error("The native architectures have different upstream sources.");
      const annotations = { "io.t3code.runtime.version": version, "io.t3code.runtime.patch": PATCH_REVISION,
        "org.opencontainers.image.source": `https://github.com/${REPOSITORY}`, "org.opencontainers.image.revision": sourceSha,
        "io.t3code.upstream.source": prepared[0].source };
      const manifests = [];
      for (const artifact of prepared) {
        const archTag = `${tag}-${artifact.platform}`, exported = path.join(output, `${artifact.platform}.json`);
        const args = ["push", `${destination}:${archTag}`, `${artifact.file}:${ARCHIVE_TYPE}`, "--artifact-type", ARTIFACT_TYPE, "--export-manifest", exported];
        for (const [key, value] of Object.entries(annotations)) args.push("--annotation", `${key}=${value}`);
        await command(args, output);
        const bytes = await fs.readFile(exported), manifest = JSON.parse(bytes);
        if (manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" || manifest.artifactType !== ARTIFACT_TYPE) throw new Error("ORAS returned an unsupported native manifest.");
        manifests.push({ mediaType: manifest.mediaType, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"), size: bytes.length, platform: { os: "linux", architecture: artifact.platform } });
      }
      existing = { schemaVersion: 2, mediaType: INDEX, artifactType: ARTIFACT_TYPE, manifests, annotations };
      const indexFile = path.join(output, "index.json");
      await fs.writeFile(indexFile, JSON.stringify(existing));
      await command(["manifest", "push", "--media-type", INDEX, `${destination}:${tag}`, indexFile]);
    }
    // Do not advance an alias until both platforms can be read without login.
    if (!layout) for (const arch of ["x64", "arm64"]) {
      for (let attempt = 0; ; attempt++) {
        try { await releaseForVersion(version, { arch }); break; }
        catch (error) {
          if (attempt >= 2 || !/HTTP (?:404|429|50[0234])/.test(error.message)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }
    const channel = channelOf(version), alias = channelTag(channel), current = await lookup(alias);
    if (current) validateDistributionIndex(current);
    const currentVersion = current?.annotations?.["io.t3code.runtime.version"];
    if (current && (current.artifactType !== ARTIFACT_TYPE || current.annotations?.["io.t3code.runtime.patch"] !== PATCH_REVISION || !exactVersion(currentVersion) || channelOf(currentVersion) !== channel)) throw new Error("Native channel alias has invalid provenance.");
    if (!current || compareVersions(version, currentVersion) >= 0) {
      const aliasFile = path.join(output, "alias.json"); await fs.writeFile(aliasFile, JSON.stringify(existing));
      await command(["manifest", "push", "--media-type", INDEX, `${destination}:${alias}`, aliasFile]);
    }
    return { version, patchRevision: PATCH_REVISION, tag, channel, registry: layout ? "local OCI layout" : "ghcr.io", publicReadVerified: !layout };
  } finally { await fs.rm(output, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const input = process.argv[2], versions = input?.startsWith("[") ? JSON.parse(input) : [input];
  if (!Array.isArray(versions) || !versions.length || !versions.every(exactVersion)) throw new Error("Choose exact native versions to publish.");
  for (const version of versions) console.log(JSON.stringify(await publishRuntime(version, path.resolve(process.argv[3] || "native-artifacts"))));
}
