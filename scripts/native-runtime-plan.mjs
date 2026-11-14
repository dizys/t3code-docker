import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageRelease, fetchRelease, releaseText } from "../docker/runtime/releases.mjs";
import { exactVersion } from "../docker/runtime/state.mjs";
import { PATCH_REVISION } from "../docker/runtime/distribution-spec.mjs";
import { DOCUMENT_LIMIT } from "../docker/runtime/release-bounds.mjs";

// Native ARM64 SEA packaging injects the host Node executable. Its version
// must match the exact source release, which can differ between channels.
export async function buildNodeImage(version, { fetcher = fetch } = {}) {
  if (!exactVersion(version)) throw new Error("Choose an exact upstream T3 release.");
  const url = `https://raw.githubusercontent.com/pingdotgg/t3code/v${version}/package.json`;
  const response = await fetchRelease(url, { fetcher });
  const manifest = JSON.parse(await releaseText(response, DOCUMENT_LIMIT));
  const node = manifest?.engines?.node;
  if (typeof node !== "string" || !/^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(node) || Number(node.split(".")[0]) < 26) {
    throw new Error(`Upstream v${version} must declare an exact Node 26 or newer build version.`);
  }
  return `node:${node}-trixie-slim`;
}

export async function nativeRuntimePlan({ requested, bundled = false, pinned, fetcher = fetch, resolveRelease = packageRelease } = {}) {
  if (requested && !exactVersion(requested)) throw new Error("Choose an exact upstream T3 release.");
  pinned ??= /ARG T3_VERSION=(\S+)/.exec(fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"))?.[1];
  const versions = requested ? [requested] : bundled
    ? [pinned, (await resolveRelease("nightly", { fetcher })).version]
    : (await Promise.all([resolveRelease("stable", { fetcher }), resolveRelease("nightly", { fetcher })])).map((release) => release.version);
  if (!versions.every(exactVersion)) throw new Error("Native build plan contains an invalid version.");
  const unique = [...new Set(versions)];
  const releases = await Promise.all(unique.map(async version => ({ version, buildNodeImage: await buildNodeImage(version, { fetcher }) })));
  const matrix = { include: releases.flatMap((release) => [
    { ...release, arch: "amd64", nodeArch: "x64", runner: "ubuntu-latest" },
    { ...release, arch: "arm64", nodeArch: "arm64", runner: "ubuntu-24.04-arm" },
  ]) };
  return { matrix: JSON.stringify(matrix), versions: JSON.stringify(unique), revision: PATCH_REVISION, bundled: pinned, nightly: unique.find((version) => version.includes("-nightly.")) || "" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const output = await nativeRuntimePlan({ requested: process.env.NATIVE_VERSION?.trim(), bundled: process.env.NATIVE_BUNDLED === "true" });
  if (process.env.GITHUB_OUTPUT) for (const [name, value] of Object.entries(output)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(JSON.stringify(output));
}
