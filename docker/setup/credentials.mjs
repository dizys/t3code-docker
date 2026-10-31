// Secrets stay in an owner-only store. Revisions are random, independent tokens;
// testing and trust metadata never change a credential's revision.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCredentialIO } from './credentials/io.mjs';
import { createCredentialState, emptyState, cleanResult } from './credentials/state.mjs';
import { createHostKeys, publicKey, keyFile } from './credentials/hostkeys.mjs';
import { normalize } from './credentials/model.mjs';
import { CredentialError, validId, object } from './credentials/errors.mjs';
export { CredentialError, credentialFailure } from './credentials/errors.mjs';
export { apiTarget } from './credentials/model.mjs';

export const credentialDirectory = (env = process.env) => path.join(env.T3CODE_HOME || path.join(env.HOME || '/home/t3', '.t3'), 'server-credentials');
const revision = () => randomBytes(8).toString('hex');
const stamp = value => typeof value === 'string' && value.length < 40 && Number.isFinite(Date.parse(value));
const serialize = profiles => JSON.stringify({ version: 2, profiles }, null, 2) + '\n';
const unreadable = () => new CredentialError('Saved credentials could not be read. Restore the credential file before making changes.', 500, 'store');
const requireId = id => { if (!validId(id)) throw new CredentialError('Choose a valid credential name.'); };

export function createCredentialStore({ directory = credentialDirectory(), readOnly = false, home = process.env.HOME || '/home/t3', io = createCredentialIO({ directory, readOnly }), hostKeys = createHostKeys({ io, home }), clock = Date.now } = {}) {
  const state = createCredentialState({ io });
  const now = () => new Date(clock()).toISOString();
  const commit = async (data, profiles, metadata, keys = new Map(), writeStore = true) => {
    if (io.readOnly) throw new CredentialError('Helpers cannot change saved credentials.', 500, 'read-only');
    // In-memory recovery only: never make another plaintext credential backup.
    const previousState = await io.read('state.json').catch(() => null);
    const previousKeys = new Map();
    for (const id of keys.keys()) previousKeys.set(id, await io.read(keyFile(id), { maxBytes: 64 * 1024 }).catch(() => null));
    let attemptedStore = false;
    try {
      for (const [id, key] of keys) { if (key) await hostKeys.write(id, key); else await hostKeys.forget(id); }
      await state.write(metadata);
      if (writeStore) { attemptedStore = true; await io.write('credentials.json', serialize(profiles)); }
    } catch (error) {
      let restored = true;
      if (attemptedStore) {
        try { if (data.raw === null) await io.remove('credentials.json'); else await io.write('credentials.json', data.raw); }
        catch {
          try { const current = await io.read('credentials.json'); restored = (current?.text ?? null) === data.raw; }
          catch { restored = false; }
        }
      }
      if (restored) {
        try {
          for (const [id, key] of previousKeys) { if (key) await io.write(keyFile(id), key.text, { maxBytes: 64 * 1024, recover: true }); else await hostKeys.forget(id); }
          if (previousState) await io.write('state.json', previousState.text, { recover: true }); else await io.remove('state.json');
        } catch { restored = false; }
      }
      if (!restored) {
        // A failed rollback must block SSH rather than silently trusting a key.
        for (const id of keys.keys()) await hostKeys.forget(id).catch(() => {});
        throw new CredentialError('The credential change could not be recovered. Check the state volume before trying again.', 500, 'store');
      }
      throw error;
    }
  };
  const migrate = async (data, file) => {
    if (io.readOnly) throw new CredentialError('Open Setup once to finish upgrading saved credentials.', 409, 'migration');
    const at = file.mtime, profiles = data.profiles.map(input => ({ ...normalize(input), createdAt: at, updatedAt: at, secretChangedAt: null, revision: revision() }));
    const metadata = emptyState(), keys = new Map();
    for (const profile of profiles.filter(row => row.type === 'ssh')) {
      let key;
      key = await hostKeys.legacy(profile);
      keys.set(profile.id, key || null);
      if (key) metadata.hostKeys[profile.id] = hostKeys.metadata(key, true);
    }
    await commit({ raw: file.text }, profiles, metadata, keys);
    return { profiles, raw: serialize(profiles) };
  };
  const read = async () => {
    const file = await io.read('credentials.json');
    if (!file) return { profiles: [], raw: null };
    let data;
    try {
      data = JSON.parse(file.text);
      if (!object(data) || ![1, 2].includes(data.version) || !Array.isArray(data.profiles) || data.profiles.length > 64) throw unreadable();
      if (new Set(data.profiles.map(profile => profile?.id)).size !== data.profiles.length) throw unreadable();
      if (data.version === 2) data.profiles = data.profiles.map(input => {
        const profile = normalize(input);
        if (![input.createdAt, input.updatedAt].every(stamp) || !(input.secretChangedAt === null || stamp(input.secretChangedAt)) || !/^[a-f0-9]{16}$/.test(input.revision || '')) throw unreadable();
        return { ...profile, createdAt: input.createdAt, updatedAt: input.updatedAt, secretChangedAt: input.secretChangedAt, revision: input.revision };
      });
      else data.profiles.forEach(input => normalize(input));
    } catch { throw unreadable(); }
    if (data.version === 1) {
      try { return await migrate(data, file); }
      catch (error) { if (error.code === 'migration') throw error; throw unreadable(); }
    }
    return { profiles: data.profiles, raw: file.text };
  };
  const publicProfile = async (profile, metadata) => {
    const { secret, ...visible } = profile;
    let key = null;
    if (profile.type === 'ssh') { try { key = await hostKeys.read(profile.id); } catch { /* Unsafe files cannot confer trust. */ } }
    const saved = metadata.hostKeys[profile.id], test = metadata.tests[profile.id];
    return { ...visible, hasSecret: true, test: test && (!test.revision || test.revision === profile.revision) ? cleanResult(test, secret) : null,
      hostKey: profile.type === 'ssh' && key ? { ...publicKey(key), trustedAt: saved?.fingerprint === key.fingerprint ? saved.trustedAt : key.trustedAt, carried: saved?.fingerprint === key.fingerprint && saved.carried === true } : null };
  };
  const current = async (data, id, expected) => {
    requireId(id);
    const profile = data.profiles.find(row => row.id === id);
    if (!profile) throw new CredentialError('This credential was deleted in another window.', 409, 'gone');
    if (expected !== profile.revision) throw new CredentialError('This credential changed in another window.', 409, 'changed', { current: await publicProfile(profile, await state.read(data.profiles)) });
    return profile;
  };
  const privateProfile = (data, id) => {
    requireId(id);
    const profile = data.profiles.find(row => row.id === id);
    if (!profile) throw new CredentialError('Saved credential not found. Add it in Setup → Credentials.', 404, 'not-found');
    return profile;
  };
  const store = {
    io, hostKeys,
    initialize: () => io.transaction(async () => { await read(); }),
    list: () => io.transaction(async () => { const data = await read(), metadata = await state.read(data.profiles); return { credentials: await Promise.all(data.profiles.map(profile => publicProfile(profile, metadata))) }; }),
    public: id => io.transaction(async () => { const data = await read(); return publicProfile(privateProfile(data, id), await state.read(data.profiles)); }),
    draft: ({ draft, id }) => io.transaction(async () => {
      const data = await read(), previous = id === undefined ? undefined : privateProfile(data, id), profile = normalize(draft, previous);
      if (profile.type === 'ssh' && previous && profile.host === previous.host && profile.port === previous.port) {
        const key = await hostKeys.read(id).catch(() => null);
        if (key) return { ...profile, knownHostsFile: key.file, hostKeyType: key.type };
      }
      return profile;
    }),
    save: ({ credential, revision: expected, create = false }) => io.transaction(async () => {
      const data = await read();
      requireId(credential?.id);
      const previous = data.profiles.find(row => row.id === credential.id);
      if (create && previous) throw new CredentialError('That name is already taken. Choose another credential name.', 409, 'taken');
      if (!create) await current(data, credential.id, expected);
      if (!previous && data.profiles.length >= 64) throw new CredentialError('Save at most 64 credentials.');
      const normalized = normalize(credential, previous), at = new Date(Math.max(clock(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
      const saved = { ...normalized, createdAt: previous?.createdAt || at, updatedAt: at, secretChangedAt: !previous || normalized.secret !== previous.secret ? at : previous.secretChangedAt, revision: revision() };
      const metadata = await state.read(data.profiles), keys = new Map();
      const changed = !previous || JSON.stringify(normalize(previous)) !== JSON.stringify(normalized);
      if (changed) delete metadata.tests[saved.id];
      else if (metadata.tests[saved.id]) metadata.tests[saved.id].revision = saved.revision;
      if (saved.type === 'ssh' && (!previous || saved.host !== previous.host || saved.port !== previous.port)) { keys.set(saved.id, null); delete metadata.hostKeys[saved.id]; }
      const profiles = [...data.profiles.filter(row => row.id !== saved.id), saved];
      await commit(data, profiles, metadata, keys);
      return { credential: await publicProfile(saved, metadata) };
    }),
    remove: ({ id, revision: expected }) => io.transaction(async () => {
      const data = await read(), profile = await current(data, id, expected), metadata = await state.read(data.profiles);
      delete metadata.tests[id]; delete metadata.hostKeys[id];
      await commit(data, data.profiles.filter(row => row.id !== id), metadata, profile.type === 'ssh' ? new Map([[id, null]]) : new Map());
      return {};
    }),
    forUse: id => io.transaction(async () => {
      const profile = privateProfile(await read(), id);
      if (profile.type !== 'ssh') return profile;
      let key = null;
      try { key = await hostKeys.read(id); } catch { /* Helpers must stop at missing or unsafe trust. */ }
      return { ...profile, knownHostsFile: key?.file || null, hostKeyType: key?.type || null, hostFingerprint: key?.fingerprint || null };
    }),
    trust: ({ id, revision: expected, key }) => io.transaction(async () => {
      const data = await read(), profile = await current(data, id, expected);
      if (profile.type !== 'ssh') throw new CredentialError('Choose an SSH credential.');
      const metadata = await state.read(data.profiles);
      metadata.hostKeys[id] = hostKeys.metadata(key); delete metadata.tests[id];
      await commit(data, data.profiles, metadata, new Map([[id, key]]), false);
      return publicProfile(profile, metadata);
    }),
    forget: id => io.transaction(async () => {
      const data = await read(), profile = privateProfile(data, id);
      if (profile.type !== 'ssh') throw new CredentialError('Choose an SSH credential.');
      const metadata = await state.read(data.profiles);
      delete metadata.hostKeys[id]; delete metadata.tests[id];
      await commit(data, data.profiles, metadata, new Map([[id, null]]), false);
      return publicProfile(profile, metadata);
    }),
    recordTest: ({ id, revision: expected, hostFingerprint, result }) => io.transaction(async () => {
      const data = await read(), profile = data.profiles.find(row => row.id === id);
      if (!profile || profile.revision !== expected) return false;
      if (profile.type === 'ssh') { const key = await hostKeys.read(id).catch(() => null); if ((key?.fingerprint || null) !== hostFingerprint) return false; }
      const metadata = await state.read(data.profiles), previous = metadata.tests[id], cleaned = cleanResult(result, profile.secret);
      if (!cleaned) throw new CredentialError('The connection test returned an invalid result.', 500);
      metadata.tests[id] = { ...cleaned, at: now(), revision: expected, consecutiveTimeouts: result.code === 'timeout' ? (previous?.consecutiveTimeouts || 0) + 1 : 0 };
      await state.write(metadata); return true;
    }),
    summary: () => io.transaction(async () => {
      const data = await read(), metadata = await state.read(data.profiles), credentials = await Promise.all(data.profiles.map(profile => publicProfile(profile, metadata)));
      return { count: credentials.length, attention: credentials.flatMap(profile => {
        let code = profile.test?.ok === false ? profile.test.code : null;
        if (code === 'timeout' && (metadata.tests[profile.id]?.consecutiveTimeouts || 0) < 2) code = null;
        if (profile.type === 'ssh' && !profile.hostKey) code = 'host-key-untrusted';
        return code ? [{ id: profile.id, code }] : [];
      }) };
    }),
  };
  return store;
}
