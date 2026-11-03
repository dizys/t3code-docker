// Secrets stay in an owner-only store. Revisions are random, independent tokens;
// testing and trust metadata never change a credential's revision.
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createCredentialIO } from './credentials/io.mjs';
import { createCredentialState, createUsageLog, emptyState, cleanResult } from './credentials/state.mjs';
import { createHostKeys, publicKey, keyFile } from './credentials/hostkeys.mjs';
import { normalize, upgradeProfile } from './credentials/model.mjs';
import { CredentialError, validId, object } from './credentials/errors.mjs';
import { envNames } from './credentials/types.mjs';
import { deliveredNames, secretValues } from './credentials/deliver.mjs';
import { ensureInclude, hasInclude, sshConfigText } from './credentials/sshconfig.mjs';
export { CredentialError, credentialFailure } from './credentials/errors.mjs';
export { apiTarget } from './credentials/model.mjs';

export const credentialDirectory = (env = process.env) => path.join(env.T3CODE_HOME || path.join(env.HOME || '/home/t3', '.t3'), 'server-credentials');
const VERSION = 3;
const revision = () => randomBytes(8).toString('hex');
const stamp = value => typeof value === 'string' && value.length < 40 && Number.isFinite(Date.parse(value));
const serialize = credentials => JSON.stringify({ version: VERSION, credentials }, null, 2) + '\n';
const unreadable = () => new CredentialError('Saved credentials could not be read. Restore the credential file before making changes.', 500, 'store');
const requireId = id => { if (!validId(id)) throw new CredentialError('Choose a valid credential name.'); };
const missing = id => new CredentialError(`No saved credential named ${id}.`, 404, 'not-found');
const cleanOrigin = value => object(value) && ['agent', 'setup', 'terminal'].includes(value.by) ? { by: value.by, ...(typeof value.threadId === 'string' && /^[\w:.-]{1,128}$/.test(value.threadId) ? { threadId: value.threadId } : {}) } : null;
const sameContent = (a, b) => JSON.stringify([a.fields, a.secrets, a.env]) === JSON.stringify([b.fields, b.secrets, b.env]);

export function createCredentialStore({ directory = credentialDirectory(), readOnly = false, home = process.env.HOME || '/home/t3', io = createCredentialIO({ directory, readOnly }), hostKeys = createHostKeys({ io, home }), clock = Date.now, sshEffects = fs } = {}) {
  const state = createCredentialState({ io }), usage = createUsageLog({ directory, clock });
  const now = () => new Date(clock()).toISOString();
  const configFile = () => io.file('ssh_config');

  // Files OpenSSH reads, rebuilt from the store. Failing here costs plain `ssh`,
  // not the saved credential, and `t3-vault ssh` doesn't need them.
  const syncSsh = async credentials => {
    if (io.readOnly) return false;
    const rows = credentials.filter(row => row.type === 'ssh');
    try {
      const wanted = new Set();
      await io.prepare('usage');
      for (const row of rows.filter(entry => entry.fields.auth === 'key')) {
        wanted.add(row.id);
        await io.write('keys/' + row.id, row.secrets.privateKey, { maxBytes: 64 * 1024, recover: true });
      }
      for (const name of await io.list('keys')) if (!wanted.has(name)) await io.remove('keys/' + name);
      await io.write('ssh_config', sshConfigText(credentials, { root: io.directory }), { recover: true });
      return rows.length ? await ensureInclude({ home, file: configFile(), effects: sshEffects }) : true;
    } catch { return false; }
  };

  const commit = async (data, credentials, metadata, keys = new Map(), writeStore = true) => {
    if (io.readOnly) throw new CredentialError('This command can\'t change saved credentials.', 500, 'read-only');
    // In-memory recovery only: never make another plaintext credential backup.
    const previousState = await io.read('state.json').catch(() => null);
    const previousKeys = new Map();
    for (const id of keys.keys()) previousKeys.set(id, await io.read(keyFile(id), { maxBytes: 64 * 1024 }).catch(() => null));
    let attemptedStore = false;
    try {
      for (const [id, key] of keys) { if (key) await hostKeys.write(id, key); else await hostKeys.forget(id); }
      await state.write(metadata);
      if (writeStore) { attemptedStore = true; await io.write('credentials.json', serialize(credentials)); }
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
    await syncSsh(credentials);
  };

  // Version 1 had no dates or revisions. Version 2 had one secret per credential.
  const migrate = async (data, file) => {
    if (io.readOnly) throw new CredentialError('Open Setup once to finish upgrading saved credentials.', 409, 'migration');
    const at = file.mtime, metadata = data.version === 1 ? emptyState() : await state.read([]), keys = new Map();
    const credentials = data.profiles.map(input => {
      const upgraded = upgradeProfile(input), normalized = normalize(upgraded);
      return { ...normalized, createdAt: upgraded.createdAt || at, updatedAt: upgraded.updatedAt || at, secretChangedAt: upgraded.secretChangedAt ?? null, revision: upgraded.revision || revision() };
    });
    if (data.version === 1) {
      for (const credential of credentials.filter(row => row.type === 'ssh')) {
        const key = await hostKeys.legacy({ host: credential.fields.host, port: credential.fields.port });
        keys.set(credential.id, key || null);
        if (key) metadata.hostKeys[credential.id] = hostKeys.metadata(key, { carried: true });
      }
    }
    await commit({ raw: file.text }, credentials, metadata, keys);
    return { credentials, raw: serialize(credentials) };
  };

  const read = async () => {
    const file = await io.read('credentials.json');
    if (!file) return { credentials: [], raw: null };
    let data;
    try {
      data = JSON.parse(file.text);
      if (!object(data) || ![1, 2, VERSION].includes(data.version)) throw unreadable();
      const rows = data.version === VERSION ? data.credentials : data.profiles;
      if (!Array.isArray(rows) || rows.length > 64) throw unreadable();
      if (new Set(rows.map(row => row?.id)).size !== rows.length) throw unreadable();
      if (data.version === VERSION) data.credentials = rows.map(input => {
        const credential = normalize(input);
        if (![input.createdAt, input.updatedAt].every(stamp) || !(input.secretChangedAt === null || stamp(input.secretChangedAt)) || !/^[a-f0-9]{16}$/.test(input.revision || '')) throw unreadable();
        const origin = cleanOrigin(input.origin), changedBy = cleanOrigin(input.changedBy);
        return { ...credential, createdAt: input.createdAt, updatedAt: input.updatedAt, secretChangedAt: input.secretChangedAt, revision: input.revision, ...(origin ? { origin } : {}), ...(changedBy ? { changedBy } : {}) };
      });
      else rows.forEach(input => normalize(upgradeProfile(input)));
    } catch { throw unreadable(); }
    if (data.version !== VERSION) {
      try { return await migrate(data, file); }
      catch (error) { if (error.code === 'migration') throw error; throw unreadable(); }
    }
    return { credentials: data.credentials, raw: file.text };
  };

  const publicCredential = async (credential, metadata) => {
    const { secrets, ...visible } = credential;
    let key = null;
    if (credential.type === 'ssh') { try { key = await hostKeys.read(credential.id); } catch { /* Unsafe files cannot confer trust. */ } }
    const saved = metadata.hostKeys[credential.id], test = metadata.tests[credential.id], values = secretValues(credential);
    const same = saved?.fingerprint === key?.fingerprint;
    return { ...visible, env: envNames(credential), delivers: deliveredNames(credential), secretNames: Object.keys(secrets), hasSecret: values.length > 0,
      test: test && (!test.revision || test.revision === credential.revision) ? cleanResult(test, values) : null,
      usage: await usage.read(credential.id),
      hostKey: credential.type === 'ssh' && key ? { ...publicKey(key), trustedAt: same ? saved.trustedAt : key.trustedAt, carried: same && saved.carried === true, firstUse: same && saved.firstUse === true } : null };
  };
  const current = async (data, id, expected) => {
    requireId(id);
    const credential = data.credentials.find(row => row.id === id);
    if (!credential) throw new CredentialError('This credential was deleted in another window.', 409, 'gone');
    if (expected !== credential.revision) throw new CredentialError('This credential changed in another window.', 409, 'changed', { current: await publicCredential(credential, await state.read(data.credentials)) });
    return credential;
  };
  const privateCredential = (data, id) => {
    requireId(id);
    const credential = data.credentials.find(row => row.id === id);
    if (!credential) throw missing(id);
    return credential;
  };
  const store = {
    io, hostKeys, usage,
    initialize: () => io.transaction(async () => { const data = await read(); await syncSsh(data.credentials); }),
    list: () => io.transaction(async () => {
      const data = await read(), metadata = await state.read(data.credentials);
      return { credentials: await Promise.all(data.credentials.map(credential => publicCredential(credential, metadata))),
        sshAliases: await hasInclude({ home, file: configFile(), effects: sshEffects }) };
    }),
    public: id => io.transaction(async () => { const data = await read(); return publicCredential(privateCredential(data, id), await state.read(data.credentials)); }),
    draft: ({ draft, id }) => io.transaction(async () => {
      const data = await read(), previous = id === undefined ? undefined : privateCredential(data, id), credential = normalize(draft, previous);
      if (credential.type === 'ssh' && previous && credential.fields.host === previous.fields.host && credential.fields.port === previous.fields.port) {
        const key = await hostKeys.read(id).catch(() => null);
        if (key) return { ...credential, knownHostsFile: key.file, hostKeyType: key.type };
      }
      return credential;
    }),
    save: ({ credential, revision: expected, create = false, origin = { by: 'setup' }, pin = null }) => io.transaction(async () => {
      const data = await read();
      requireId(credential?.id);
      const previous = data.credentials.find(row => row.id === credential.id);
      if (create && previous) throw new CredentialError(`${credential.id} is already saved. Choose another name, or replace it.`, 409, 'taken');
      if (!create) await current(data, credential.id, expected);
      if (!previous && data.credentials.length >= 64) throw new CredentialError('Save at most 64 credentials.');
      const normalized = normalize(credential, previous), at = new Date(Math.max(clock(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
      const who = cleanOrigin(origin) || { by: 'setup' };
      const secretsChanged = !previous || JSON.stringify(normalized.secrets) !== JSON.stringify(previous.secrets);
      const saved = { ...normalized, createdAt: previous?.createdAt || at, updatedAt: at, secretChangedAt: secretsChanged ? at : previous.secretChangedAt, revision: revision(), origin: previous?.origin || who, ...(previous ? { changedBy: who } : {}) };
      const metadata = await state.read(data.credentials), keys = new Map();
      const changed = !previous || !sameContent(normalized, previous);
      if (changed) delete metadata.tests[saved.id];
      else if (metadata.tests[saved.id]) metadata.tests[saved.id].revision = saved.revision;
      if (saved.type === 'ssh' && (!previous || saved.fields.host !== previous.fields.host || saved.fields.port !== previous.fields.port)) { keys.set(saved.id, null); delete metadata.hostKeys[saved.id]; }
      if (pin) { keys.set(saved.id, pin.key); metadata.hostKeys[saved.id] = hostKeys.metadata(pin.key, { firstUse: pin.firstUse === true }); }
      await commit(data, [...data.credentials.filter(row => row.id !== saved.id), saved], metadata, keys);
      return { credential: await publicCredential(saved, metadata) };
    }),
    remove: ({ id, revision: expected }) => io.transaction(async () => {
      const data = await read(), credential = await current(data, id, expected), metadata = await state.read(data.credentials);
      delete metadata.tests[id]; delete metadata.hostKeys[id];
      await commit(data, data.credentials.filter(row => row.id !== id), metadata, credential.type === 'ssh' ? new Map([[id, null]]) : new Map());
      await usage.remove(id);
      return {};
    }),
    forUse: id => io.transaction(async () => {
      const credential = privateCredential(await read(), id);
      if (credential.type !== 'ssh') return credential;
      let key = null;
      try { key = await hostKeys.read(id); } catch { /* Commands must stop at missing or unsafe trust. */ }
      return { ...credential, knownHostsFile: key?.file || null, hostKeyType: key?.type || null, hostFingerprint: key?.fingerprint || null };
    }),
    trust: ({ id, revision: expected, key, firstUse = false }) => io.transaction(async () => {
      const data = await read(), credential = await current(data, id, expected);
      if (credential.type !== 'ssh') throw new CredentialError('Choose an SSH credential.');
      const metadata = await state.read(data.credentials);
      metadata.hostKeys[id] = hostKeys.metadata(key, { firstUse }); delete metadata.tests[id];
      await commit(data, data.credentials, metadata, new Map([[id, key]]), false);
      return publicCredential(credential, metadata);
    }),
    forget: id => io.transaction(async () => {
      const data = await read(), credential = privateCredential(data, id);
      if (credential.type !== 'ssh') throw new CredentialError('Choose an SSH credential.');
      const metadata = await state.read(data.credentials);
      delete metadata.hostKeys[id]; delete metadata.tests[id];
      await commit(data, data.credentials, metadata, new Map([[id, null]]), false);
      return publicCredential(credential, metadata);
    }),
    recordTest: ({ id, revision: expected, hostFingerprint, result }) => io.transaction(async () => {
      const data = await read(), credential = data.credentials.find(row => row.id === id);
      if (!credential || credential.revision !== expected) return false;
      if (credential.type === 'ssh') { const key = await hostKeys.read(id).catch(() => null); if ((key?.fingerprint || null) !== hostFingerprint) return false; }
      const metadata = await state.read(data.credentials), previous = metadata.tests[id], cleaned = cleanResult(result, secretValues(credential));
      if (!cleaned) throw new CredentialError('The connection test returned an invalid result.', 500);
      metadata.tests[id] = { ...cleaned, at: now(), revision: expected, consecutiveTimeouts: result.code === 'timeout' ? (previous?.consecutiveTimeouts || 0) + 1 : 0 };
      await state.write(metadata); return true;
    }),
    summary: () => io.transaction(async () => {
      const data = await read(), metadata = await state.read(data.credentials), credentials = await Promise.all(data.credentials.map(credential => publicCredential(credential, metadata)));
      return { count: credentials.length, attention: credentials.flatMap(credential => {
        let code = credential.test?.ok === false ? credential.test.code : null;
        if (code === 'timeout' && (metadata.tests[credential.id]?.consecutiveTimeouts || 0) < 2) code = null;
        // A password is never sent to an unconfirmed host, so someone has to look.
        // A key waits for its first connection, which pins the host by itself.
        if (credential.type === 'ssh' && !credential.hostKey && credential.fields.auth === 'password') code = 'host-key-untrusted';
        return code ? [{ id: credential.id, code }] : [];
      }) };
    }),
  };
  return store;
}
