import { createHash } from "node:crypto";
import { PATCH_REVISION, ARTIFACT_TYPE, ARCHIVE_TYPE, distributionTag, channelTag, manifestUrl } from "../../docker/runtime/distribution-spec.mjs";

const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
export function nativeRegistry({ stable = "0.0.45", nightly = "0.0.46-nightly.20261011.2980", layerDigest = "sha256:" + "0".repeat(64), layerSize = 100 } = {}) {
  const records = new Map(), calls = [];
  for (const [channel, version] of [["stable", stable], ["nightly", nightly]]) {
    if (!version) continue;
    const annotations = { "io.t3code.runtime.version": version, "io.t3code.runtime.patch": PATCH_REVISION };
    const manifests = ["amd64", "arm64"].map((architecture) => {
      const text = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: ARTIFACT_TYPE, annotations,
        layers: [{ mediaType: ARCHIVE_TYPE, digest: layerDigest, size: layerSize }] });
      const digest = hash(text); records.set(manifestUrl(digest), text);
      return { mediaType: "application/vnd.oci.image.manifest.v1+json", digest, size: Buffer.byteLength(text), platform: { os: "linux", architecture } };
    });
    const text = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", artifactType: ARTIFACT_TYPE, annotations, manifests });
    records.set(manifestUrl(distributionTag(version)), text);
    records.set(manifestUrl(channelTag(channel)), text);
  }
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("/token?")) return new Response(JSON.stringify({ token: "public-native-fixture", expires_in: 300 }));
    const text = records.get(url);
    return text === undefined ? new Response("not found", { status: 404 }) : new Response(text, { headers: { "docker-content-digest": hash(text) } });
  };
  return { fetcher, calls, records };
}
