import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { patches } from "./patches/index.mjs";

export const REPOSITORY = "dizys/t3code-docker";
export const REGISTRY = "https://ghcr.io";
export const ARTIFACT_TYPE = "application/vnd.t3code.runtime.v1";
export const ARCHIVE_TYPE = "application/vnd.t3code.runtime.v1.tar+gzip";
const hash = createHash("sha256").update(readFileSync(new URL("./patches/index.mjs", import.meta.url)));
for (const patch of patches) hash.update(patch.name).update(readFileSync(patch.module));
export const PATCH_REVISION = hash.digest("hex");
export const distributionTag = (version) => `native-t3-v${version}-p${PATCH_REVISION.slice(0, 16)}`;
export const channelTag = (channel) => `native-t3-${channel}-p${PATCH_REVISION.slice(0, 16)}`;
export const manifestUrl = (reference) => `${REGISTRY}/v2/${REPOSITORY}/manifests/${reference}`;
export const distributionBlob = (digest) => `${REGISTRY}/v2/${REPOSITORY}/blobs/${digest}`;
