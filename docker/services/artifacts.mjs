import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { ServiceError, hash } from "./store.mjs";
import { inspectTar } from "./archive.mjs";
const exec = promisify(execFile);
async function manifest(directory, { durable = false } = {}) {
  const entries = [];
  const walk = async relative => {
    const location = path.join(directory, relative);
    for (const name of (await fs.readdir(location)).sort()) {
      if (!relative && ['receipt.json', 'manifest.json'].includes(name)) continue;
      const member = path.join(relative, name), file = path.join(directory, member), info = await fs.lstat(file);
      if (info.uid !== 0 || !info.isSymbolicLink() && info.mode & 0o022) throw new ServiceError('artifact-unsafe', 'A cached service payload has unsafe ownership or permissions.');
      const entry = { path: member, mode: info.mode & 0o7777 };
      if (info.isSymbolicLink()) {
        const link = await fs.readlink(file), target = path.resolve(path.dirname(file), link);
        if (path.isAbsolute(link) || !target.startsWith(directory + path.sep)) throw new ServiceError('artifact-unsafe', 'A service payload link leaves its verified directory.');
        entries.push({ ...entry, type: 'link', target: link });
      } else if (info.isDirectory()) { entries.push({ ...entry, type: 'directory' }); await walk(member); }
      else if (info.isFile()) {
        const digest = createHash('sha256'), handle = await fs.open(file, 'r');
        try { for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk); if (durable) await handle.sync(); }
        finally { await handle.close(); }
        entries.push({ ...entry, type: 'file', size: info.size, sha256: digest.digest('hex') });
      } else throw new ServiceError('artifact-unsafe', 'A service payload contains an unsupported member.');
    }
    if (durable) { const handle = await fs.open(location, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  };
  await walk(''); return entries;
}
export const CATALOGUE_FILE = "/opt/t3-services/catalogue.json";
export async function readCatalogue(file = CATALOGUE_FILE) {
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  if (data.schema !== 1 || !["arm64", "amd64"].includes(data.arch) || data.arch !== (process.arch === "x64" ? "amd64" : process.arch)) throw new ServiceError("catalogue", "This service catalogue does not match this image architecture.");
  return data;
}
export async function protectedPath(target, { directory = true } = {}) {
  let current = target;
  for (;;) {
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022 || (current === target && (directory ? !info.isDirectory() : !info.isFile()))) throw new ServiceError("storage-unsafe", "System service storage must have root-owned ancestors and no group or other write access.");
    if (current === "/") break;
    current = path.dirname(current);
  }
}
export async function protectedDirectory(target, mode = 0o700) {
  let ancestor = target;
  for (;;) {
    try { await protectedPath(ancestor); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; ancestor = path.dirname(ancestor); }
  }
  await fs.mkdir(target, { recursive: true, mode });
  await protectedPath(target);
}
export async function protectedWrite(file, text, mode = 0o600) {
  await protectedPath(path.dirname(file));
  try { await protectedPath(file, { directory: false }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = path.join(path.dirname(file), ".write-" + randomUUID());
  const handle = await fs.open(temporary, "wx", mode);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), "r"); await directory.sync(); await directory.close();
}
export async function systemStorage(root) {
  if (process.getuid() !== 0) throw new ServiceError("rootless", "System services require the root entrypoint. Custom services remain available.");
  const mounts = await fs.readFile("/proc/self/mountinfo", "utf8");
  if (!mounts.split("\n").some(line => line.split(" ")[4] === root)) throw new ServiceError("storage-required", "Add a persistent volume at /var/lib/t3code/services before installing system services. Core T3 and custom services remain available.");
  await protectedPath(root);
  for (const file of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) {
    try { await protectedPath(path.join(root, file), { directory: false }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  try { await fs.access(root, constants.W_OK); } catch { throw new ServiceError("storage-readonly", "System service storage is read-only. Mount /var/lib/t3code/services writable before installing or enabling services."); }
}
export async function downloadVerified(item, file, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(item.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) : AbortSignal.timeout(5 * 60_000), redirect: "follow" });
  if (!response.ok || !response.body) throw new ServiceError("download", "The verified service payload could not be downloaded. Its existing installation was kept.");
  const handle = await fs.open(file, "wx", 0o600), digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > item.bytes) throw new ServiceError("digest", "The service payload has an unexpected size.");
      digest.update(chunk); await handle.writeFile(chunk);
    }
    await handle.sync();
  } finally { await handle.close(); }
  if (bytes !== item.bytes || digest.digest("hex") !== item.sha256) throw new ServiceError("digest", "The service payload failed verification. Nothing was activated.");
}
export function createArtifacts({ root, catalogue, fetchImpl = fetch, run = exec, signal }) {
  const selection = id => {
    const definition = catalogue.services[id];
    if (!definition) throw new ServiceError("invalid", "Choose an image-approved service.");
    return { ...definition, digest: hash(definition), arch: catalogue.arch, catalogue: hash(catalogue) };
  };
  const install = async (id, expected) => {
    const selected = selection(id);
    if (hash(selected) !== hash(expected)) throw new ServiceError("conflict", "The service catalogue changed. Review this installation again.");
    const target = path.join(root, "artifacts", id, selected.digest);
    try {
      await protectedPath(target);
      const receipt = JSON.parse(await fs.readFile(path.join(target, "receipt.json"), "utf8"));
      await protectedPath(path.join(target, 'receipt.json'), { directory: false });
      // An unrelated catalogue entry can change in a new image. A verified
      // artifact remains reusable when its own exact definition is unchanged.
      if (receipt.digest === selected.digest && receipt.arch === selected.arch && receipt.manifest === hash(await manifest(target))) return { ...receipt, path: target };
      throw new Error("receipt");
    } catch (error) { if (error.code !== "ENOENT") throw new ServiceError("artifact-unsafe", "An existing service artifact is incomplete or unsafe. It was kept for inspection."); }
    const space = await fs.statfs(root);
    const bytes = selected.payloads.reduce((total, item) => total + item.bytes, 0);
    if (Number(space.bavail) * Number(space.bsize) < bytes * 8 + 128 * 1024 * 1024) throw new ServiceError("space", "Free space is too low to stage and retain this service safely. Open Storage and retry.");
    const stage = path.join(root, "staging", randomUUID());
    // This controller is the only installer in its domain. A dead install's
    // unpublished staging data is safe to discard before the next attempt.
    const staging = path.dirname(stage);
    await protectedDirectory(staging);
    for (const old of await fs.readdir(staging)) {
      if (!/^[a-f0-9-]{36}$/.test(old)) continue;
      await protectedPath(path.join(staging, old));
      await fs.rm(path.join(staging, old), { recursive: true, force: true });
    }
    await protectedDirectory(stage);
    const unpacked = path.join(stage, "payload"); await fs.mkdir(unpacked, { mode: 0o755 });
    try {
      for (const item of selected.payloads) {
        const payload = path.join(stage, item.name);
        await downloadVerified(item, payload, { fetchImpl, signal });
        if (item.format === "deb") {
          const { stdout } = await run("/usr/bin/dpkg-deb", ["--fsys-tarfile", payload], { signal, timeout: 30000, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
          inspectTar(stdout);
          await run("/usr/bin/dpkg-deb", ["-x", payload, unpacked], { signal, timeout: 30000 });
        }
        else if (item.format === "tgz") {
          const { stdout } = await run("/usr/bin/gzip", ["-dc", payload], { signal, timeout: 30000, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
          const members = inspectTar(stdout);
          for (const executable of ["tailscale", "tailscaled"]) if (!members.some(member => member.path === item.prefix + "/" + executable && member.kind === '0')) throw new ServiceError('archive-unsafe', 'The connector archive is incomplete. Nothing was activated.');
          await run("/usr/bin/tar", ["-xzf", payload, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "-C", unpacked, "--", item.prefix + "/tailscale", item.prefix + "/tailscaled"], { signal, timeout: 30000 });
        }
        else { await fs.copyFile(payload, path.join(unpacked, item.name)); await fs.chmod(path.join(unpacked, item.name), 0o755); }
      }
      const executable = await fs.realpath(path.join(unpacked, selected.executable));
      if (!executable.startsWith(unpacked + "/")) throw new ServiceError("artifact-unsafe", "The payload executable leaves its verified artifact.");
      await fs.access(executable, constants.X_OK);
      const receipt = { id, version: selected.version, arch: selected.arch, digest: selected.digest, catalogue: selected.catalogue, manifest: hash(await manifest(unpacked, { durable: true })), payloads: selected.payloads.map(({ name, sha256, bytes, url }) => ({ name, sha256, bytes, url })), installedAt: Date.now() };
      await fs.writeFile(path.join(unpacked, "receipt.json"), JSON.stringify(receipt) + "\n", { mode: 0o644 });
      const durable = await fs.open(path.join(unpacked, "receipt.json"), "r"); await durable.sync(); await durable.close();
      await protectedDirectory(path.dirname(target), 0o755);
      await fs.rename(unpacked, target);
      const directory = await fs.open(path.dirname(target), "r"); await directory.sync(); await directory.close();
      return { ...receipt, path: target };
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  };
  return { selection, install };
}
