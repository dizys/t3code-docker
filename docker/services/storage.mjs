import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ServiceError } from "./store.mjs";

export async function manifest(directory, { durable = false, owner = 0 } = {}) {
  const entries = [];
  const walk = async relative => {
    const location = path.join(directory, relative);
    for (const name of (await fs.readdir(location)).sort()) {
      if (!relative && ['receipt.json', 'manifest.json'].includes(name)) continue;
      const member = path.join(relative, name), file = path.join(directory, member), info = await fs.lstat(file);
      if (info.uid !== owner || !info.isSymbolicLink() && info.mode & 0o022) throw new ServiceError('artifact-unsafe', 'A cached service payload has unsafe ownership or permissions.');
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
