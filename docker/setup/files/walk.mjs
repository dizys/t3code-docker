import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { opendirRaw } from './io.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });
export const allocatedBytes = stat => Number.isSafeInteger(Number(stat.blocks) * 512) ? Number(stat.blocks) * 512 : Number(stat.size);
export const sameEntry = (a, b) => a.dev === b.dev && a.ino === b.ino;
export const internalName = name => name === '.t3-trash' || /^\.t3-(?:upload|extract|write|zip|copy)-(?:[a-z]+_)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.(?:part|tmp))?$/.test(name);

/** A bounded, same-device, no-follow walk. An open parent descriptor pins each
 * lookup even if another process replaces a directory with a symlink. Linux's
 * /proc descriptor path is intentional here; it is never a user-supplied link. */
export async function walk(root, { timeoutMs = 20_000, maxEntries = 500_000, maxDepth = 128,
  signal, visit = () => {}, skip = () => false, progress = () => {}, now = Date.now } = {}) {
  const started = now(), initial = await fs.lstat(root), directories = new Map(), seen = new Set();
  const result = { bytes: 0, files: 0, folders: 0, entries: 0, partial: false, unreadable: 0, invalidNames: 0, directories };
  const expired = () => signal?.aborted || now() - started >= timeoutMs || result.entries >= maxEntries;
  const count = stat => {
    const key = `${stat.dev}:${stat.ino}`;
    if (seen.has(key)) return 0;
    seen.add(key); return allocatedBytes(stat);
  };
  const descend = async (absolute, lookup, stat, depth) => {
    if (expired()) { result.partial = true; return { bytes: 0, complete: false }; }
    result.entries++;
    const bytes = count(stat);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      result.files++; await visit({ path: absolute, stat, bytes, depth }); return { bytes, complete: true };
    }
    result.folders++;
    if (depth > 0 && await skip(absolute, stat)) return { bytes: 0, complete: true };
    if (stat.dev !== initial.dev || depth > maxDepth) {
      result.partial = true; await visit({ path: absolute, stat, bytes: null, depth }); return { bytes: 0, complete: false };
    }
    const filesBefore = result.files;
    let handle, directory, total = bytes, complete = true;
    try {
      handle = await fs.open(lookup, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!sameEntry(stat, opened)) { result.partial = true; return { bytes: 0, complete: false }; }
      const pinned = `/proc/self/fd/${handle.fd}`;
      directory = await opendirRaw(pinned);
      await visit({ path: absolute, stat, bytes: null, depth });
      for await (const entry of directory) {
        if (expired()) { result.partial = true; complete = false; break; }
        let name;
        try { name = decoder.decode(entry.name); } catch { result.invalidNames++; result.partial = true; complete = false; continue; }
        if (internalName(name)) continue;
        const child = path.join(absolute, name), childLookup = path.join(pinned, name);
        try {
          const childStat = await fs.lstat(childLookup);
          const value = await descend(child, childLookup, childStat, depth + 1);
          total += value.bytes; complete &&= value.complete;
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ESTALE'].includes(error.code)) throw error;
          complete = false; result.partial = true; if (error.code !== 'ENOENT') result.unreadable++;
        }
        if (result.entries % 128 === 0) progress({ files: result.files, folders: result.folders });
      }
      const after = await handle.stat();
      if (after.mtimeMs !== opened.mtimeMs) { complete = false; result.partial = true; }
    } catch (error) {
      if (depth === 0) throw error;
      complete = false; result.partial = true; result.unreadable++;
    } finally {
      await directory?.close().catch(() => {}); await handle?.close();
    }
    directories.set(absolute, { bytes: total, complete, mtimeMs: stat.mtimeMs, files: result.files - filesBefore });
    return { bytes: total, complete };
  };
  if (initial.isSymbolicLink()) throw Object.assign(new Error('Open the link’s destination before measuring.'), { code: 'ELOOP' });
  result.bytes = (await descend(root, root, initial, 0)).bytes;
  progress({ files: result.files, folders: result.folders });
  return result;
}
