// The same verified upstream CLI archives supply image builds and Setup updates.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CHANNELS, channelOf, exactVersion, readJson, writeJson } from "./state.mjs";
import { PATCH_REVISION, distributionBlob } from "./distribution-spec.mjs";
import { registryRequest } from "./registry.mjs";

const execute = promisify(execFile);
const API = "https://api.github.com/repos/pingdotgg/t3code/releases";
const DOWNLOAD = "https://github.com/pingdotgg/t3code/releases/download";
const LIMIT = 300 * 1024 * 1024;
const UNPACKED_LIMIT = 1024 * 1024 * 1024;
const HEADROOM = 64 * 1024 * 1024;
const SPACE_CHECK_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 20;
const downloadHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "ghcr.io", "pkg-containers.githubusercontent.com"]);
export const executableVersion = (output) => /^(?:t3\s+)?v?(\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?)$/i.exec(String(output).trim())?.[1] ?? null;

export function archiveStem(version, arch = process.arch) {
  if (!exactVersion(version)) throw new Error("Choose an exact Stable or Nightly release.");
  if (!["x64", "arm64"].includes(arch) || process.platform !== "linux") throw new Error("T3 Code updates support Linux amd64 and arm64.");
  return `t3-${version}-linux-${arch}`;
}

// GitHub and GHCR redirect release assets to signed storage URLs. Follow only
// download hosts, without forwarding any authorization or accepting HTTP.
async function get(url, { fetcher, api = false, token, timeout = 15_000 }) {
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const headers = api ? { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) } : {};
    const response = new URL(url).origin === "https://ghcr.io"
      ? await registryRequest(url, { fetcher, timeout })
      : await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(timeout), headers });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location") ?? "", url);
      if (api || !downloadHosts.has(next.hostname) || next.protocol !== "https:" || next.username || next.password || next.port) throw new Error("The release redirected to an unsupported download host.");
      url = next.href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      throw new Error(limited ? "GitHub's release API rate limit was reached. Try checking again later; the running version was kept." : `Could not fetch T3 Code releases (HTTP ${response.status}).`);
    }
    return response;
  }
  throw new Error("The release download redirected too many times.");
}
export { get as fetchRelease };

async function boundedText(response, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("T3 Code's release metadata exceeded the supported size.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
export { boundedText as releaseText };

export function archiveChecksum(text, name) {
  const matches = text.split(/\r?\n/).map((line) => /^([a-fA-F0-9]{64}) [ *](\S+)$/.exec(line)).filter((line) => line?.[2] === name);
  if (matches.length !== 1) throw new Error(`The release must list exactly one SHA-256 checksum for ${name}.`);
  return matches[0][1].toLowerCase();
}

export async function releaseForVersion(version, { fetcher = fetch, arch = process.arch } = {}) {
  const root = archiveStem(version, arch);
  const name = `${root}.tar.gz`;
  const base = `${DOWNLOAD}/v${version}`;
  const sums = await boundedText(await get(`${base}/SHA256SUMS`, { fetcher }), 1024 * 1024);
  return { version, name: "t3-runtime", root, url: `${base}/${name}`, integrity: `sha256-${archiveChecksum(sums, name)}` };
}

export async function packageRelease(channel, { fetcher = fetch, arch = process.arch, token = process.env.GITHUB_TOKEN } = {}) {
  if (!CHANNELS.includes(channel)) throw new Error("Choose Stable or Nightly.");
  // Validate the architecture before making requests.
  archiveStem("0.0.0", arch);
  for (let page = 1; page <= 5; page += 1) {
    const url = channel === "stable" ? `${API}/latest` : `${API}?per_page=${PAGE_SIZE}&page=${page}`;
    const data = JSON.parse(await boundedText(await get(url, { fetcher, api: true, token }), 4 * 1024 * 1024));
    const entries = channel === "stable" ? [data] : data;
    if (!Array.isArray(entries)) throw new Error("GitHub did not return a release list.");
    const release = entries.find((entry) => {
      const tag = typeof entry?.tag_name === "string" ? entry.tag_name : "";
      const version = tag.replace(/^v/, "");
      return !entry?.draft && exactVersion(version) && tag === `v${version}` && channelOf(version) === channel && (channel !== "stable" || entry.prerelease === false);
    });
    if (release) return releaseForVersion(release.tag_name.replace(/^v/, ""), { fetcher, arch });
    if (channel === "stable" || entries.length < PAGE_SIZE) break;
  }
  throw new Error(`GitHub did not return a published ${channel} release. Try checking again later.`);
}

/** Only ordinary files/directories under this exact archive root may extract. */
export function validateArchive(names, types, root) {
  if (!/^t3-\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?-linux-(?:x64|arm64)$/.test(root)) throw new Error("Invalid release archive root.");
  const seen = new Set();
  for (const name of names.trimEnd().split("\n")) {
    const parts = name.replace(/\/$/, "").split("/");
    if (parts[0] !== root || parts.some((part) => !part || part === "." || part === "..") || /[\\\x00-\x1f\x7f]/.test(name) || seen.has(name)) throw new Error("The release archive contains an unsafe path.");
    seen.add(name);
  }
  let unpacked = 0;
  for (const row of types.trimEnd().split("\n")) {
    if (!/^[d-]/.test(row)) throw new Error("The release archive contains unsupported links or entries.");
    const size = Number(row.trim().split(/\s+/)[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Could not determine the release archive's unpacked size.");
    unpacked += size;
  }
  if (unpacked > UNPACKED_LIMIT) throw new Error("The unpacked release exceeded the supported size.");
  return unpacked;
}

const spaceError = () => new Error("There is not enough free space to stage this T3 Code release. Free up storage and try again.");
async function writableSpace(directory, required) {
  const space = await fs.statfs(directory);
  const available = Number(space.bavail) * Number(space.bsize) - HEADROOM;
  if (available < required) throw spaceError();
  return available;
}

export async function unpackRelease(stage, release, { fetcher = fetch, run = execute } = {}) {
  const expectedUrl = release.patchRevision === undefined ? `${DOWNLOAD}/v${release.version}/${release.root}.tar.gz` : distributionBlob(String(release.integrity).replace("sha256-", "sha256:"));
  if (!["x64", "arm64"].some((arch) => archiveStem(release.version, arch) === release.root)
    || (release.patchRevision !== undefined && release.patchRevision !== PATCH_REVISION)
    || (release.size !== undefined && (!Number.isSafeInteger(release.size) || release.size <= 0 || release.size > LIMIT))
    || release.url !== expectedUrl
    || !/^sha256-[a-f0-9]{64}$/.test(release.integrity)) throw new Error("Invalid release download or checksum information.");
  const archive = path.join(stage, "download.tgz");
  const destination = path.join(stage, "contents");
  // Refuse a full volume before requesting the archive. Once headers arrive,
  // admit its actual size (or the download limit when no length is supplied).
  await writableSpace(stage, 1);
  const response = await get(release.url, { fetcher, timeout: 180_000 });
  const hash = createHash("sha256");
  let bytes = 0;
  let file;
  try {
    const header = response.headers.get("content-length");
    const length = /^\d+$/.test(header ?? "") && Number.isSafeInteger(Number(header)) ? Number(header) : null;
    if (length !== null && length > LIMIT) throw new Error("The release download exceeded the supported size.");
    if (release.size !== undefined && length !== null && release.size !== length) throw new Error("T3 Code's download did not match its verified archive size.");
    const expectedLength = release.size ?? length;
    let writable = await writableSpace(stage, expectedLength ?? LIMIT);
    let checkedAt = 0;
    file = await fs.open(archive, "wx", 0o600);
    for await (const chunk of response.body) {
      if (bytes + chunk.length > LIMIT) throw new Error("The release download exceeded the supported size.");
      if (expectedLength !== null && bytes + chunk.length > expectedLength) throw new Error("T3 Code's download did not match its declared size.");
      // Other processes keep using this volume while T3 runs. Recheck in
      // bounded batches, and before a chunk could consume the reserved space.
      if (bytes + chunk.length - checkedAt >= SPACE_CHECK_BYTES || chunk.length > writable) {
        writable = await writableSpace(stage, expectedLength === null ? chunk.length : expectedLength - bytes);
        checkedAt = bytes;
      }
      writable -= chunk.length;
      hash.update(chunk);
      await file.writeFile(chunk);
      bytes += chunk.length;
    }
    if (expectedLength !== null && bytes !== expectedLength) throw new Error("T3 Code's download did not match its declared size.");
    await file.sync();
  } catch (error) {
    if (error.code === "ENOSPC" || error.code === "EDQUOT") throw spaceError();
    throw error;
  } finally {
    try { await file?.close(); }
    finally { await response.body?.cancel().catch(() => {}); }
  }
  if (!timingSafeEqual(hash.digest(), Buffer.from(release.integrity.slice(7), "hex"))) throw new Error("T3 Code's download failed its integrity check. The running version was kept.");
  const options = { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } };
  const names = await run("/usr/bin/tar", ["-tzf", archive], options);
  const types = await run("/usr/bin/tar", ["-tvzf", archive], options);
  const unpacked = validateArchive(names.stdout, types.stdout, release.root);
  await writableSpace(stage, unpacked);
  await fs.mkdir(destination, { mode: 0o700 });
  await run("/usr/bin/tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "--strip-components=1", "-C", destination], options);
  const pkg = await readJson(path.join(destination, "package.json"));
  if (pkg && (pkg.name !== "t3-runtime" || pkg.version !== release.version)) throw new Error("The downloaded archive does not match the requested release.");
  if (release.patchRevision && (pkg?.containerPatch?.revision !== release.patchRevision || !/^[a-f0-9]{40}$/.test(pkg.containerPatch.source) || !/^sha256-[a-f0-9]{64}$/.test(pkg.containerPatch.upstreamIntegrity))) throw new Error("The downloaded runtime is missing its verified container patch metadata.");
  // CLI archives omit the staging package.json. Keep a container-owned audit
  // manifest so bundled version resolution also works with older supervisors.
  if (!pkg) await writeJson(path.join(destination, "package.json"), { name: "t3-runtime", version: release.version, distribution: release.url, integrity: release.integrity });
  await fs.chmod(path.join(destination, "t3"), 0o755);
  await fs.access(path.join(destination, "client/index.html"));
  return destination;
}
