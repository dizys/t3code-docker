import { createHash } from "node:crypto";
import { archiveStem, releaseText } from "./releases.mjs";
import { CHANNELS, channelOf, exactVersion } from "./state.mjs";
import { PATCH_REVISION, ARTIFACT_TYPE, ARCHIVE_TYPE, distributionTag, channelTag, manifestUrl, distributionBlob } from "./distribution-spec.mjs";
import { registryRequest } from "./registry.mjs";

const INDEX = "application/vnd.oci.image.index.v1+json", MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const digestOf = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
const digest = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);

export function validateDistributionIndex(index) {
  if (index?.schemaVersion !== 2 || index.mediaType !== INDEX || index.artifactType !== ARTIFACT_TYPE || index.annotations?.["io.t3code.runtime.patch"] !== PATCH_REVISION || !exactVersion(index.annotations?.["io.t3code.runtime.version"]) || !Array.isArray(index.manifests)) throw new Error("The native runtime index does not match this image's integration patch.");
  const architectures = new Set();
  for (const entry of index.manifests) {
    const architecture = entry?.platform?.architecture;
    if (entry?.platform?.os !== "linux" || !["amd64", "arm64"].includes(architecture) || architectures.has(architecture) || !digest(entry.digest) || entry.mediaType !== MANIFEST || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > 4 * 1024 * 1024) throw new Error("The native runtime index must contain exactly one tested build for each supported architecture.");
    architectures.add(architecture);
  }
  if (architectures.size !== 2) throw new Error("The native runtime index is missing a tested architecture.");
  return index;
}

export async function distributionIndex(reference, { fetcher = fetch } = {}) {
  const response = await registryRequest(manifestUrl(reference), { fetcher, headers: { accept: INDEX } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Could not fetch the container-maintained T3 runtime (HTTP ${response.status}). Check again later or update the Docker image; the running version was kept.`); }
  const text = await releaseText(response, 4 * 1024 * 1024), index = validateDistributionIndex(JSON.parse(text));
  const supplied = response.headers.get("docker-content-digest");
  if (supplied && supplied !== digestOf(text)) throw new Error("The native runtime index failed its integrity check.");
  return { index, digest: digestOf(text), version: index.annotations["io.t3code.runtime.version"] };
}

async function fromIndex(root, { fetcher, arch }) {
  const { version, index } = root, stem = archiveStem(version, arch), targetArch = arch === "x64" ? "amd64" : "arm64";
  const platforms = index.manifests.filter((entry) => entry.platform?.os === "linux" && entry.platform?.architecture === targetArch);
  if (platforms.length !== 1 || !digest(platforms[0].digest) || platforms[0].mediaType !== MANIFEST) throw new Error("The native runtime index must contain exactly one tested build for this architecture.");
  const response = await registryRequest(manifestUrl(platforms[0].digest), { fetcher, headers: { accept: MANIFEST } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`The native runtime manifest is unavailable (HTTP ${response.status}).`); }
  const text = await releaseText(response, 4 * 1024 * 1024);
  if (digestOf(text) !== platforms[0].digest || Buffer.byteLength(text) !== platforms[0].size) throw new Error("The native runtime manifest failed its integrity check.");
  const manifest = JSON.parse(text);
  if (manifest.schemaVersion !== 2 || manifest.mediaType !== MANIFEST || manifest.artifactType !== ARTIFACT_TYPE || manifest.annotations?.["io.t3code.runtime.patch"] !== PATCH_REVISION || manifest.annotations?.["io.t3code.runtime.version"] !== version || manifest.layers?.length !== 1) throw new Error("The native runtime manifest has invalid integration metadata.");
  const layer = manifest.layers[0];
  if (layer.mediaType !== ARCHIVE_TYPE || !digest(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size <= 0 || layer.size > 300 * 1024 * 1024) throw new Error("The native runtime archive descriptor is invalid.");
  return { version, name: "t3-runtime", root: stem, url: distributionBlob(layer.digest), integrity: layer.digest.replace("sha256:", "sha256-"), size: layer.size, patchRevision: PATCH_REVISION, distributionDigest: root.digest, manifestDigest: platforms[0].digest };
}

export async function releaseForVersion(version, { fetcher = fetch, arch = process.arch } = {}) {
  archiveStem(version, arch);
  const root = await distributionIndex(distributionTag(version), { fetcher });
  if (root.version !== version) throw new Error("The native runtime tag points at a different upstream version.");
  return fromIndex(root, { fetcher, arch });
}

export async function packageRelease(channel, { fetcher = fetch, arch = process.arch } = {}) {
  if (!CHANNELS.includes(channel)) throw new Error("Choose Stable or Nightly.");
  archiveStem("0.0.0", arch);
  const root = await distributionIndex(channelTag(channel), { fetcher });
  if (channelOf(root.version) !== channel) throw new Error("The native runtime channel points at a different release channel.");
  return fromIndex(root, { fetcher, arch });
}
