import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCredentialStore } from '../credentials.mjs';
import { createCredentialUsage } from './usage.mjs';
import { testCredential } from './run.mjs';
import { CredentialError, object } from './errors.mjs';
import { cleanResult } from './state.mjs';

export const CREDENTIAL_ROUTES = ['/credentials', '/credentials/create', '/credentials/save', '/credentials/remove', '/credentials/scan', '/credentials/test', '/credentials/trust', '/credentials/forget-host-key'];
const fingerprint = value => typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);
export function createCredentialsService({ store = createCredentialStore(), usage = createCredentialUsage(), test = testCredential, clock = Date.now } = {}) {
  let running = 0;
  const shutdown = new AbortController(), keys = store.hostKeys;
  const network = async work => {
    if (shutdown.signal.aborted) throw new CredentialError('Setup is restarting. Try again in a moment.', 503, 'busy');
    if (running >= 3) throw new CredentialError('Three connection checks are already running. Try again in a moment.', 409, 'busy');
    running++;
    try { return await work(shutdown.signal); } finally { running--; }
  };
  const scan = async (profile, signal) => keys.inspect(profile, { signal: AbortSignal.any([AbortSignal.timeout(10000), signal]) });
  const validTrust = trust => {
    if (!object(trust) || !fingerprint(trust.fingerprint)) throw new CredentialError('Review and choose a host-key fingerprint before trusting it.');
    return trust.fingerprint;
  };
  const trustSaved = async (id, expected, signal, revision) => {
    const profile = await store.public(id);
    if (profile.type !== 'ssh') throw new CredentialError('Choose an SSH credential.');
    if (revision !== undefined && revision !== profile.revision) throw new CredentialError('This credential changed before its key could be trusted.', 409, 'changed');
    const scanned = await scan(profile, signal);
    if (!scanned.ok) return { ok: false, code: scanned.code };
    if (scanned.key.fingerprint !== expected) throw new CredentialError('The server presented another key. Review its new fingerprint before trusting it.', 409, 'key-changed', { presented: scanned.hostKey.presented });
    const saved = await store.trust({ id, revision: profile.revision, key: scanned.key });
    return { ok: true, hostKey: saved.hostKey };
  };
  const testInput = async (input, signal) => {
    const started = clock(), draft = input.draft !== undefined;
    let profile = draft ? await store.draft(input) : await store.forUse(input.id), hostFingerprint = profile.hostFingerprint || null;
    let result, temporary = null;
    try {
      if (profile.type === 'ssh') {
        const scanned = await scan(draft && !profile.knownHostsFile ? { ...profile, id: undefined } : profile, signal);
        if (!scanned.ok) result = scanned;
        else {
          const presented = scanned.hostKey.presented, trusted = scanned.hostKey.trusted;
          // Explicit trust may replace a previous key for this draft only.
          const agreed = draft && input.trust !== undefined ? validTrust(input.trust) : null;
          if (agreed && presented.fingerprint !== agreed) result = { ok: false, code: 'host-key-changed', detail: { trusted: { type: presented.type, fingerprint: agreed }, presented } };
          else if (!agreed && scanned.hostKey.state !== 'trusted') result = { ok: false, code: trusted ? 'host-key-changed' : 'host-key-untrusted', detail: trusted ? { trusted, presented } : {}, hostKey: scanned.hostKey };
          else if (draft) {
            temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3-credential-key-')); await fs.chmod(temporary, 0o700);
            const file = path.join(temporary, 'known_hosts');
            await fs.writeFile(file, `${profile.id} ${scanned.key.type} ${scanned.key.key}\n`, { mode: 0o600, flag: 'wx' });
            profile = { ...profile, knownHostsFile: file, hostKeyType: scanned.key.type };
          }
        }
      }
      result ||= await test(profile, { signal: AbortSignal.any([AbortSignal.timeout(15000), signal]) });
      const cleaned = cleanResult({ ...result, ms: clock() - started }, profile.secret);
      if (!cleaned) throw new CredentialError('The connection test could not be read.', 500);
      if (!draft) await store.recordTest({ id: profile.id, revision: profile.revision, hostFingerprint, result: cleaned });
      return { ok: true, result: { ...cleaned, at: new Date(clock()).toISOString() } };
    } finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
  };
  return {
    initialize: store.initialize,
    summary: store.summary,
    invalidateUsage: () => usage.invalidate(),
    close: () => shutdown.abort(),
    async handle(route, input = {}) {
      if (route === '/credentials') return { ok: true, ...await usage.annotate((await store.list()).credentials) };
      if (route === '/credentials/create' || route === '/credentials/save') {
        if (input.trust !== undefined) validTrust(input.trust);
        const saved = await store.save({ ...input, create: route === '/credentials/create' });
        if (input.trust !== undefined) {
          try { saved.trust = await network(signal => trustSaved(saved.credential.id, input.trust.fingerprint, signal, saved.credential.revision)); }
          catch (error) { saved.trust = error instanceof CredentialError ? { ok: false, code: error.code, ...(error.extra.presented ? { presented: error.extra.presented } : {}) } : { ok: false, code: 'failed' }; }
          saved.credential = await store.public(saved.credential.id);
        }
        return { ok: true, ...saved };
      }
      if (route === '/credentials/remove') return { ok: true, ...await store.remove(input) };
      if (route === '/credentials/forget-host-key') { await store.forget(input.id); return { ok: true }; }
      if (route === '/credentials/test') return network(signal => testInput(input, signal));
      if (route === '/credentials/trust') { const expected = validTrust({ fingerprint: input.fingerprint }); return network(signal => trustSaved(input.id, expected, signal)); }
      if (route === '/credentials/scan') return network(async signal => {
        const profile = input.id === undefined ? { host: input.host, port: input.port } : await store.public(input.id);
        if (input.id !== undefined && profile.type !== 'ssh') throw new CredentialError('Choose an SSH credential.');
        const started = clock(), scanned = await scan(profile, signal);
        return scanned.ok ? { ok: true, hostKey: scanned.hostKey } : { ok: true, result: { ...scanned, ms: clock() - started } };
      });
      throw new CredentialError('Credential action not found.', 404, 'not-found');
    },
  };
}
