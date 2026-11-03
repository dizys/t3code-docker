import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, validId } from './errors.mjs';
import { redactText } from './redact.mjs';
const CODES = new Set(['ok', 'unreachable', 'timeout', 'scan-failed', 'host-key-untrusted', 'host-key-changed', 'auth-rejected', 'failed', 'rejected', 'not-found', 'http-error', 'redirect', 'certificate']);
const stamp = value => typeof value === 'string' && value.length < 40 && Number.isFinite(Date.parse(value));
const key = value => object(value) && typeof value.type === 'string' && /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(value.type) && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint || '') ? { type: value.type, fingerprint: value.fingerprint } : null;
export const emptyState = () => ({ version: 1, tests: Object.create(null), hostKeys: Object.create(null) });

export function cleanResult(value, secret) {
  if (!object(value) || !CODES.has(value.code) || typeof value.ok !== 'boolean' || value.ok !== (value.code === 'ok')) return null;
  const detail = {}, raw = object(value.detail) ? value.detail : {};
  if (Number.isInteger(raw.status) && raw.status >= 100 && raw.status <= 599) detail.status = raw.status;
  if (typeof raw.user === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(raw.user) && raw.user.length <= 64) detail.user = raw.user;
  if (typeof raw.line === 'string') detail.line = redactText(raw.line, secret).replace(/[\x00-\x1f\x7f]/g, ' ').slice(-160);
  for (const name of ['trusted', 'presented']) if (key(raw[name])) detail[name] = key(raw[name]);
  const result = { ok: value.ok, code: value.code, ms: Number.isFinite(value.ms) ? Math.min(120000, Math.max(0, Math.round(value.ms))) : 0, detail };
  if (stamp(value.at)) result.at = value.at;
  if (value.hostKey && ['new', 'changed', 'trusted'].includes(value.hostKey.state) && key(value.hostKey.presented)) result.hostKey = { state: value.hostKey.state, presented: key(value.hostKey.presented), ...(key(value.hostKey.trusted) ? { trusted: key(value.hostKey.trusted) } : {}) };
  return result;
}

export function createCredentialState({ io }) {
  const read = async (profiles = []) => {
    const state = emptyState();
    try {
      const file = await io.read('state.json');
      if (!file) return state;
      const data = JSON.parse(file.text);
      if (!object(data) || data.version !== 1) return state;
      for (const [id, value] of Object.entries(object(data.tests) ? data.tests : {})) {
        const result = cleanResult(value, Object.values(profiles.find(profile => profile.id === id)?.secrets ?? {}));
        if (validId(id) && result && stamp(result.at)) state.tests[id] = { ...result, consecutiveTimeouts: Number.isSafeInteger(value.consecutiveTimeouts) ? Math.min(100000, Math.max(0, value.consecutiveTimeouts)) : 0, ...(typeof value.revision === 'string' && /^[a-f0-9]{16}$/.test(value.revision) ? { revision: value.revision } : {}) };
      }
      for (const [id, value] of Object.entries(object(data.hostKeys) ? data.hostKeys : {})) if (validId(id) && key(value) && stamp(value.trustedAt)) state.hostKeys[id] = { ...key(value), trustedAt: value.trustedAt, carried: value.carried === true, firstUse: value.firstUse === true };
    } catch { /* Display metadata is disposable; damaged state cannot hide credentials. */ }
    return state;
  };
  return { read, write: state => io.write('state.json', JSON.stringify(state, null, 2) + '\n', { recover: true }) };
}

// Which thread started this command, when T3 Code ran it.
export const callerThread = (env = process.env) => {
  const id = env.T3CODE_THREAD_ID;
  return typeof id === 'string' && /^[\w:.-]{1,128}$/.test(id) ? id : null;
};

/**
 * When each credential was last used. Each one has its own disposable file,
 * written without the store's lock, so a busy command never waits on a save or
 * blocks one. Losing an update here only makes a "last used" line slightly old.
 */
export function createUsageLog({ directory, clock = Date.now, effects = fs }) {
  const folder = path.join(directory, 'usage');
  const fileFor = id => path.join(folder, id + '.json');
  const read = async id => {
    if (!validId(id)) return null;
    let saved = null, touched = null;
    try {
      const data = JSON.parse(await effects.readFile(fileFor(id), 'utf8'));
      if (object(data) && typeof data.at === 'string' && Number.isFinite(Date.parse(data.at))) saved = { at: data.at, count: Number.isSafeInteger(data.count) ? data.count : 1, ...(typeof data.threadId === 'string' ? { threadId: data.threadId } : {}), ...(typeof data.command === 'string' ? { command: data.command } : {}) };
    } catch { /* Disposable. */ }
    // ssh's own LocalCommand touches this, so plain `ssh prod` counts as a use.
    try { touched = (await effects.stat(path.join(folder, id + '.touch'))).mtime.toISOString(); } catch { /* Never used that way. */ }
    if (touched && (!saved || touched > saved.at)) return { count: saved?.count ?? 1, at: touched, viaSsh: true };
    return saved;
  };
  const record = async (id, { command, env = process.env } = {}) => {
    if (!validId(id)) return;
    try {
      await effects.mkdir(folder, { recursive: true, mode: 0o700 });
      const previous = await read(id), thread = callerThread(env), name = typeof command === 'string' ? path.basename(command).slice(0, 64) : null;
      const temporary = path.join(folder, '.' + randomUUID() + '.tmp');
      await effects.writeFile(temporary, JSON.stringify({ at: new Date(clock()).toISOString(), count: (previous?.count ?? 0) + 1, ...(thread ? { threadId: thread } : {}), ...(name ? { command: name } : {}) }) + '\n', { mode: 0o600, flag: 'wx' });
      await effects.rename(temporary, fileFor(id));
    } catch { /* Never let bookkeeping fail a command that worked. */ }
  };
  const remove = async id => { if (!validId(id)) return; await Promise.all([fileFor(id), path.join(folder, id + '.touch')].map(file => effects.rm(file, { force: true }).catch(() => {}))); };
  return { read, record, remove };
}
