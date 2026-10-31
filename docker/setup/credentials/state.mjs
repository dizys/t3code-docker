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
        const result = cleanResult(value, profiles.find(profile => profile.id === id)?.secret);
        if (validId(id) && result && stamp(result.at)) state.tests[id] = { ...result, consecutiveTimeouts: Number.isSafeInteger(value.consecutiveTimeouts) ? Math.min(100000, Math.max(0, value.consecutiveTimeouts)) : 0, ...(typeof value.revision === 'string' && /^[a-f0-9]{16}$/.test(value.revision) ? { revision: value.revision } : {}) };
      }
      for (const [id, value] of Object.entries(object(data.hostKeys) ? data.hostKeys : {})) if (validId(id) && key(value) && stamp(value.trustedAt)) state.hostKeys[id] = { ...key(value), trustedAt: value.trustedAt, carried: value.carried === true };
    } catch { /* Display metadata is disposable; damaged state cannot hide credentials. */ }
    return state;
  };
  return { read, write: state => io.write('state.json', JSON.stringify(state, null, 2) + '\n', { recover: true }) };
}
