import { execFile } from 'node:child_process';
import { createConnection, isIP } from 'node:net';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CredentialError, validId, validText } from './errors.mjs';

const TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];
export const publicKey = key => key ? { type: key.type, fingerprint: key.fingerprint } : null;
export const keyFile = id => { if (!validId(id)) throw new CredentialError('Choose a valid credential name.'); return 'known_hosts/' + id; };
export const execute = (program, args, { input, signal, timeout = 5000 } = {}) => new Promise((resolve, reject) => {
  const child = execFile(program, args, { encoding: 'utf8', maxBuffer: 64 * 1024, timeout, signal, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
    if (error?.code === 'ENOENT' || error?.code === 'ABORT_ERR' || error?.killed) return reject(error);
    resolve({ code: error?.code || 0, stdout, stderr });
  });
  child.stdin?.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
  child.stdin?.end(input || '');
});

// These are public-key fingerprints, never revisions derived from passwords.
export function parseKey(line) {
  const fields = String(line).trim().split(/\s+/);
  if (fields[0]?.startsWith('#') || fields[0]?.startsWith('@') || fields.length < 3) return null;
  const [alias, type, encoded] = fields;
  if (!TYPES.includes(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 16384) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== Buffer.byteLength(type) || bytes.subarray(4, 4 + Buffer.byteLength(type)).toString() !== type) return null;
  return { alias, type, key: encoded, fingerprint: 'SHA256:' + createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '') };
}
const choose = keys => [...keys].sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type))[0] || null;
const row = (id, key) => `${id} ${key.type} ${key.key}\n`;
const result = (code, detail = {}) => ({ ok: false, code, detail });

export const reachHost = ({ host, port }, { signal, connect = createConnection } = {}) => new Promise(resolve => {
  if (signal?.aborted) return resolve(result('timeout'));
  let socket, settled = false;
  const finish = value => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); socket?.destroy(); resolve(value); };
  const abort = () => finish(result('timeout'));
  try {
    socket = connect({ host, port });
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', error => finish(result(error.code === 'ETIMEDOUT' ? 'timeout' : 'unreachable')));
    socket.setTimeout(5000, () => finish(result('timeout')));
    signal?.addEventListener('abort', abort, { once: true });
  } catch { finish(result('unreachable')); }
});

export function createHostKeys({ io, run = execute, reach = reachHost, home = process.env.HOME || '/home/t3', clock = () => new Date().toISOString() }) {
  const validate = profile => {
    if (!validText(profile?.host, 253) || !(isIP(profile.host) || /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(profile.host)) || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new CredentialError('Enter a valid host and port.');
  };
  const read = async id => {
    const data = await io.read(keyFile(id), { maxBytes: 64 * 1024 });
    if (!data) return null;
    const keys = data.text.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map(parseKey);
    if (keys.length !== 1 || !keys[0] || keys[0].alias !== id) return null;
    return { ...keys[0], trustedAt: data.mtime, file: io.file(keyFile(id)) };
  };
  const scan = async (profile, { signal = AbortSignal.timeout(10000) } = {}) => {
    validate(profile);
    const reachable = await reach(profile, { signal });
    if (!reachable.ok) return reachable;
    try {
      const answer = await run('/usr/bin/ssh-keyscan', ['-T', '5', '-p', String(profile.port), '-t', 'ed25519,ecdsa,rsa', '--', profile.host], { signal, timeout: 5000 });
      const keys = answer.stdout.split(/\r?\n/).map(parseKey).filter(Boolean);
      const key = choose(keys);
      if (!key) return result('scan-failed');
      const checked = await run('/usr/bin/ssh-keygen', ['-lf', '-', '-E', 'sha256'], { input: `${key.type} ${key.key}\n`, signal, timeout: 2000 });
      if (checked.code !== 0 || !checked.stdout.split(/\s+/).includes(key.fingerprint)) return result('scan-failed');
      return { ok: true, key };
    } catch (error) { return result(signal.aborted || error?.killed || error?.code === 'ABORT_ERR' ? 'timeout' : 'scan-failed'); }
  };
  const inspect = async (profile, options) => {
    const scanned = await scan(profile, options);
    if (!scanned.ok) return scanned;
    let trusted = null;
    if (profile.id) { try { trusted = await read(profile.id); } catch { /* unsafe files never confer trust */ } }
    return { ok: true, key: scanned.key, hostKey: { state: !trusted ? 'new' : trusted.fingerprint === scanned.key.fingerprint ? 'trusted' : 'changed', presented: publicKey(scanned.key), ...(trusted ? { trusted: publicKey(trusted) } : {}) } };
  };
  const legacy = async profile => {
    const file = path.join(home, '.ssh/known_hosts');
    const target = profile.port === 22 ? profile.host : `[${profile.host}]:${profile.port}`;
    const answer = await run('/usr/bin/ssh-keygen', ['-F', target, '-f', file], { timeout: 5000 });
    if (answer.code !== 0) return null;
    const lines = answer.stdout.split(/\r?\n/), revoked = new Set(lines.filter(line => line.startsWith('@revoked ')).map(line => line.trim().split(/\s+/)[3]));
    return choose(lines.map(parseKey).filter(key => key && !revoked.has(key.key)));
  };
  return { read, scan, inspect, legacy,
    write: (id, key) => io.write(keyFile(id), row(id, key), { maxBytes: 64 * 1024, recover: true }),
    forget: id => io.remove(keyFile(id)),
    metadata: (key, carried = false) => ({ ...publicKey(key), trustedAt: clock(), carried }),
  };
}
