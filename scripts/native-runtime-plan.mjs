import fs from "node:fs";
import { packageRelease } from "../docker/runtime/releases.mjs";
import { exactVersion } from "../docker/runtime/state.mjs";
import { PATCH_REVISION } from "../docker/runtime/distribution-spec.mjs";

const requested = process.env.NATIVE_VERSION?.trim();
if (requested && !exactVersion(requested)) throw new Error("Choose an exact upstream T3 release.");
const pinned = /ARG T3_VERSION=(\S+)/.exec(fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"))?.[1];
const versions = requested ? [requested] : process.env.NATIVE_BUNDLED === "true"
  ? [pinned, (await packageRelease("nightly")).version]
  : (await Promise.all([packageRelease("stable"), packageRelease("nightly")])).map((release) => release.version);
if (!versions.every(exactVersion)) throw new Error("Native build plan contains an invalid version.");
const unique = [...new Set(versions)];
const matrix = { include: unique.flatMap((version) => [
  { version, arch: "amd64", nodeArch: "x64", runner: "ubuntu-latest" },
  { version, arch: "arm64", nodeArch: "arm64", runner: "ubuntu-24.04-arm" },
]) };
const output = { matrix: JSON.stringify(matrix), versions: JSON.stringify(unique), revision: PATCH_REVISION, bundled: pinned, nightly: unique.find((version) => version.includes("-nightly.")) || "" };
if (process.env.GITHUB_OUTPUT) for (const [name, value] of Object.entries(output)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
console.log(JSON.stringify(output));
