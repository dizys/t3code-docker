// One writer owns changes across the store, state and trust files. Helpers use
// readOnly mode: no mkdir, chmod, migration, lock or metadata write on a read.
import * as fs from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CredentialError } from './errors.mjs';

const localHarness = new URL('../../harness/', import.meta.url);
const harness = existsSync(new URL('lock.mjs', localHarness)) ? localHarness : new URL('file:///opt/t3-harness/');
const [{ acquireLock }, { createFs }] = await Promise.all([import(new URL('lock.mjs', harness)), import(new URL('io.mjs', harness))]);
const queues = new Map();
const unsafe = () => new CredentialError('A credential file is unsafe or exceeds its size limit. Repair it before continuing.', 500, 'store');

export function createCredentialIO({ directory, readOnly = false, effects = fs }) {
  const root = path.resolve(directory);
  const file = name => {
    const target = path.resolve(root, name);
    if (!name || target === root || !target.startsWith(root + path.sep)) throw unsafe();
    return target;
  };
  const prepare = async (relative = '') => {
    if (relative && relative !== 'known_hosts') throw unsafe();
    for (const target of relative ? [root, path.join(root, relative)] : [root]) {
      if (!readOnly) await effects.mkdir(target, { recursive: true, mode: 0o700 });
      let stat;
      try { stat = await effects.lstat(target); } catch (error) { if (readOnly && error.code === 'ENOENT') return false; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw unsafe();
      if (readOnly) { if ((stat.mode & 0o777) !== 0o700) throw unsafe(); }
      else if ((stat.mode & 0o777) !== 0o700) await effects.chmod(target, 0o700);
    }
    return true;
  };
  const read = async (name, { maxBytes = 512 * 1024, missing = null } = {}) => {
    if (!await prepare(name.startsWith('known_hosts/') ? 'known_hosts' : '')) return missing;
    let handle;
    try {
      handle = await effects.open(file(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > maxBytes) throw unsafe();
      if (readOnly) { if ((stat.mode & 0o777) !== 0o600) throw unsafe(); }
      else if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      const buffer = Buffer.allocUnsafe(maxBytes + 1); let at = 0;
      while (at < buffer.length) { const { bytesRead } = await handle.read(buffer, at, buffer.length - at, at); if (!bytesRead) break; at += bytesRead; }
      if (at > maxBytes) throw unsafe();
      let data;
      try { data = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, at)); } catch { throw unsafe(); }
      return { text: data, mtime: stat.mtime.toISOString() };
    } catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
    finally { await handle?.close(); }
  };
  const write = async (name, text, { maxBytes = 512 * 1024, recover = false } = {}) => {
    if (readOnly) throw new CredentialError('Helpers cannot change saved credentials.', 500, 'read-only');
    if (Buffer.byteLength(text) > maxBytes) throw new CredentialError('Saved credentials exceed their size limit.');
    await prepare(name.startsWith('known_hosts/') ? 'known_hosts' : '');
    if (!recover) await read(name, { maxBytes });
    const target = file(name), temporary = path.join(path.dirname(target), '.' + randomUUID() + '.tmp');
    try {
      const handle = await effects.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await effects.rename(temporary, target);
      const parent = await effects.open(path.dirname(target), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await effects.rm(temporary, { force: true }); }
  };
  const remove = async name => {
    if (readOnly) throw new CredentialError('Helpers cannot change saved credentials.', 500, 'read-only');
    await prepare(name.startsWith('known_hosts/') ? 'known_hosts' : '');
    // Unlink the directory entry, never follow a damaged metadata symlink.
    await effects.rm(file(name), { force: true });
  };
  const transaction = action => {
    if (readOnly) return Promise.resolve().then(action);
    const previous = queues.get(root) || Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      await prepare();
      const lockFs = { ...createFs(), writeFile: (name, data, options) => effects.writeFile(name, data, { ...options, mode: 0o600 }) };
      const ctx = { fs: lockFs, lockPath: path.join(root, 'credentials.lock'), pid: process.pid, now: Date.now, lockStaleMs: 10 * 60_000 };
      const deadline = Date.now() + 5000;
      let lock;
      do {
        lock = await acquireLock(ctx, { id: randomUUID(), operation: 'credentials' });
        if (lock.acquired) break;
        if (lock.error || Date.now() >= deadline) throw new CredentialError('Credentials are being changed. Try again in a moment.', 409, 'busy');
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (true);
      try { return await action(); } finally { await lock.release(); }
    });
    queues.set(root, result);
    void result.finally(() => { if (queues.get(root) === result) queues.delete(root); }).catch(() => {});
    return result;
  };
  return { directory: root, readOnly, file, prepare, read, write, remove, transaction };
}
