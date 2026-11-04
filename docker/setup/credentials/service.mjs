import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createCredentialStore } from '../credentials.mjs';
import { createCredentialUsage } from './usage.mjs';
import { canTest, sshRequest, testCredential } from './run.mjs';
import { CredentialError, object, validId } from './errors.mjs';
import { cleanResult } from './state.mjs';
import { detect } from './detect.mjs';
import { generateKey, installCommand, openPrivateKey } from './keys.mjs';
import { publicTypes, withDefaults } from './types.mjs';
import { secretValues } from './deliver.mjs';
import { normalize } from './model.mjs';

export const CREDENTIAL_ROUTES = ['/credentials', '/credentials/create', '/credentials/save', '/credentials/remove', '/credentials/scan', '/credentials/test', '/credentials/trust', '/credentials/forget-host-key', '/credentials/detect', '/credentials/generate-key', '/credentials/install-key'];
const PENDING_KEY_MS = 30 * 60_000;
const fingerprint = value => typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);
const target = credential => ({ ...(credential.id ? { id: credential.id } : {}), host: credential.fields.host, port: credential.fields.port });
const INSTALL_PROBLEMS = {
  'auth-rejected': 'The server rejected that password, so the key wasn’t installed.',
  'host-key-changed': 'The server’s key changed during setup, so nothing was sent.',
  unreachable: 'The server couldn’t be reached.',
  timeout: 'The server took too long to respond.',
};

export function createCredentialsService({ store = createCredentialStore(), usage = createCredentialUsage(), test = testCredential, ssh = sshRequest, clock = Date.now, environmentId = async () => null, keygen = generateKey, keyOpener = openPrivateKey } = {}) {
  let running = 0;
  const shutdown = new AbortController(), keys = store.hostKeys, pending = new Map();
  const network = async work => {
    if (shutdown.signal.aborted) throw new CredentialError('Setup is restarting. Try again in a moment.', 503, 'busy');
    if (running >= 3) throw new CredentialError('Three connection checks are already running. Try again in a moment.', 409, 'busy');
    running++;
    try { return await work(shutdown.signal); } finally { running--; }
  };
  const scan = async (credential, signal) => keys.inspect(credential, { signal: AbortSignal.any([AbortSignal.timeout(10000), signal]) });
  const validTrust = trust => {
    if (!object(trust) || !fingerprint(trust.fingerprint)) throw new CredentialError('Review and choose a host-key fingerprint before trusting it.');
    return trust.fingerprint;
  };
  const trustSaved = async (id, expected, signal, revision) => {
    const credential = await store.public(id);
    if (credential.type !== 'ssh') throw new CredentialError('Choose an SSH credential.');
    if (revision !== undefined && revision !== credential.revision) throw new CredentialError('This credential changed before its key could be reviewed. Read the current details first.', 409, 'changed', { current: credential });
    const scanned = await scan(target(credential), signal);
    if (!scanned.ok) return { ok: false, code: scanned.code };
    if (scanned.key.fingerprint !== expected) throw new CredentialError('The server presented another key. Review its new fingerprint before trusting it.', 409, 'key-changed', { presented: scanned.hostKey.presented });
    const saved = await store.trust({ id, revision: credential.revision, key: scanned.key });
    return { ok: true, hostKey: saved.hostKey };
  };

  // A key sign-in can't hand the key to an impostor, so a new host is pinned the
  // first time it's reached. From then on, a different key blocks it.
  const pinFirstUse = async (id, signal) => {
    const credential = await store.public(id);
    if (credential.type !== 'ssh' || credential.fields.auth !== 'key') return { ok: false, code: 'host-key-untrusted' };
    if (credential.hostKey) return { ok: true, hostKey: credential.hostKey };
    const scanned = await scan(target(credential), signal);
    if (!scanned.ok) return { ok: false, code: scanned.code };
    const saved = await store.trust({ id, revision: credential.revision, key: scanned.key, firstUse: true });
    return { ok: true, firstUse: true, hostKey: saved.hostKey };
  };

  const takePending = id => {
    for (const [key, value] of pending) if (clock() - value.at > PENDING_KEY_MS) pending.delete(key);
    const value = pending.get(id);
    if (!value) throw new CredentialError('That generated key has expired. Generate a new one.', 409, 'key-expired');
    return value;
  };
  const generate = async id => {
    const made = await keygen(validId(id) ? 't3-vault:' + id : 't3-vault');
    for (const [key, value] of pending) if (clock() - value.at > PENDING_KEY_MS) pending.delete(key);
    while (pending.size >= 16) pending.delete(pending.keys().next().value);
    const keyId = randomBytes(16).toString('hex');
    pending.set(keyId, { ...made, at: clock() });
    return { keyId, publicKey: made.publicKey, install: installCommand(made.publicKey) };
  };

  // Everything key-related happens before the store is touched, so a bad key
  // leaves nothing behind. A key's passphrase isn't kept: see openPrivateKey.
  const withKey = async ({ credential, generatedKeyId, generate: fresh, passphrase }) => {
    if (!object(credential) || credential.type !== 'ssh') return credential;
    const fields = withDefaults('ssh', credential.fields), secrets = { ...credential.secrets };
    delete fields.publicKey; // Only ever derived from the key itself.
    if (fields.auth !== 'key') return { ...credential, fields, secrets };
    if (fresh) { const made = await keygen('t3-vault:' + credential.id); secrets.privateKey = made.privateKey; fields.publicKey = made.publicKey; }
    else if (generatedKeyId !== undefined) { const made = takePending(generatedKeyId); secrets.privateKey = made.privateKey; fields.publicKey = made.publicKey; }
    else if (secrets.privateKey) { const opened = await keyOpener(secrets.privateKey, { passphrase, comment: 't3-vault:' + credential.id }); secrets.privateKey = opened.privateKey; fields.publicKey = opened.publicKey; }
    return { ...credential, fields, secrets };
  };

  const withKnownHost = async (credential, key, work) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3-credential-key-'));
    try {
      await fs.chmod(temporary, 0o700);
      const file = path.join(temporary, 'known_hosts');
      await fs.writeFile(file, `${credential.id} ${key.type} ${key.key}\n`, { mode: 0o600, flag: 'wx' });
      return await work({ ...credential, knownHostsFile: file, hostKeyType: key.type });
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  };

  /** Installs a key with a password, proves the key works, then saves only the key. */
  const installWithPassword = async ({ credential, password, expected, revision, create, origin }) => network(async signal => {
    if (!credential.secrets?.privateKey || !credential.fields.publicKey) throw new CredentialError('A key is needed before it can be installed.');
    const scanned = await scan(target({ ...credential, id: undefined }), signal);
    if (!scanned.ok) throw new CredentialError(INSTALL_PROBLEMS[scanned.code] || 'The server couldn’t be checked.', 409, 'install-failed', { detail: scanned.code });
    if (scanned.key.fingerprint !== expected) throw new CredentialError('The server presented another key. Review its new fingerprint before trusting it.', 409, 'key-changed', { presented: scanned.hostKey.presented });
    await withKnownHost(credential, scanned.key, async pinned => {
      const withPassword = { ...pinned, fields: { ...pinned.fields, auth: 'password' }, secrets: { password } };
      const installed = await ssh(withPassword, [installCommand(credential.fields.publicKey)], { probe: true, stdin: 'ignore', signal: AbortSignal.any([AbortSignal.timeout(20000), signal]) });
      if (!installed.ok) throw new CredentialError(INSTALL_PROBLEMS[installed.code] || 'The key couldn’t be installed on the server.', 409, 'install-failed', { detail: installed.code });
      const verified = await test(pinned, { signal: AbortSignal.any([AbortSignal.timeout(15000), signal]) });
      if (!verified.ok) throw new CredentialError('The key was added to the server, but signing in with it failed. Your password wasn’t saved.', 409, 'install-failed', { detail: verified.code });
    });
    return store.save({ credential, revision, create, origin, pin: { key: scanned.key } });
  });

  const save = async (input, { create, origin = { by: 'setup' } }) => {
    if (input.trust !== undefined) validTrust(input.trust);
    const credential = await withKey(input);
    if (input.install !== undefined) {
      if (!object(input.install) || typeof input.install.password !== 'string' || !input.install.password) throw new CredentialError('Enter the server’s password so the key can be installed.', 400, 'invalid', { field: 'password' });
      if (input.trust === undefined) throw new CredentialError('Review the server’s fingerprint before sending it your password.', 409, 'host-key-untrusted');
      if (!create) throw new CredentialError('Save this credential first, then move it to a key.');
      const saved = await installWithPassword({ credential: normalize(credential), password: input.install.password, expected: input.trust.fingerprint, revision: input.revision, create, origin });
      if (input.generatedKeyId !== undefined) pending.delete(input.generatedKeyId);
      return { ok: true, ...saved };
    }
    const saved = await store.save({ credential, revision: input.revision, create, origin });
    if (input.generatedKeyId !== undefined) pending.delete(input.generatedKeyId);
    const { id } = saved.credential;
    if (input.trust !== undefined) {
      try { saved.trust = await network(signal => trustSaved(id, input.trust.fingerprint, signal, saved.credential.revision)); }
      catch (error) { saved.trust = error instanceof CredentialError ? { ok: false, code: error.code, ...(error.extra.presented ? { presented: error.extra.presented } : {}) } : { ok: false, code: 'failed' }; }
      saved.credential = await store.public(id);
    } else if (saved.credential.type === 'ssh' && saved.credential.fields.auth === 'key' && !saved.credential.hostKey) {
      try { saved.trust = await network(signal => pinFirstUse(id, signal)); }
      catch (error) { saved.trust = { ok: false, code: error.code || 'failed' }; }
      saved.credential = await store.public(id);
    }
    return { ok: true, ...saved };
  };

  /** Moves a saved password sign-in to a new key, then forgets the password. */
  const installKey = async ({ id, revision }, { origin = { by: 'setup' } } = {}) => {
    const credential = await store.forUse(id);
    if (credential.type !== 'ssh' || credential.fields.auth !== 'password') throw new CredentialError(`${id} isn't an SSH credential that signs in with a password.`);
    if (!credential.knownHostsFile) throw new CredentialError(`Trust the host key for ${id} before sending it the password.`, 409, 'host-key-untrusted');
    if (revision !== undefined && revision !== credential.revision) throw new CredentialError('This credential changed in another window.', 409, 'changed');
    const made = await keygen('t3-vault:' + id);
    const { hostFingerprint, knownHostsFile, hostKeyType } = credential;
    return network(async signal => {
      const installed = await ssh(credential, [installCommand(made.publicKey)], { probe: true, stdin: 'ignore', signal: AbortSignal.any([AbortSignal.timeout(20000), signal]) });
      if (!installed.ok) throw new CredentialError(INSTALL_PROBLEMS[installed.code] || 'The key couldn’t be installed on the server.', 409, 'install-failed', { detail: installed.code });
      const next = { id, type: 'ssh', description: credential.description, fields: { host: credential.fields.host, port: credential.fields.port, username: credential.fields.username, auth: 'key', publicKey: made.publicKey }, secrets: { privateKey: made.privateKey } };
      const verified = await test({ ...next, knownHostsFile, hostKeyType }, { signal: AbortSignal.any([AbortSignal.timeout(15000), signal]) });
      if (!verified.ok) throw new CredentialError('The key was added to the server, but signing in with it failed. The password is still saved.', 409, 'install-failed', { detail: verified.code });
      const saved = await store.save({ credential: next, revision: credential.revision, origin });
      return { ok: true, ...saved, fingerprint: hostFingerprint };
    });
  };

  const testInput = async (input, signal) => {
    const started = clock(), draft = input.draft !== undefined;
    let credential = draft ? await store.draft({ draft: await withKey({ credential: input.draft, generatedKeyId: input.generatedKeyId, passphrase: input.passphrase }), id: input.id }) : await store.forUse(input.id);
    if (!canTest(credential)) return { ok: true, result: null };
    let hostFingerprint = credential.hostFingerprint || null, result, shown = null;
    const run = async pinned => {
      const answer = result || await test(pinned, { signal: AbortSignal.any([AbortSignal.timeout(15000), signal]) });
      const cleaned = cleanResult({ ...answer, ...(shown ? { hostKey: shown } : {}), ms: clock() - started }, secretValues(credential));
      if (!cleaned) throw new CredentialError('The connection test could not be read.', 500);
      if (!draft) await store.recordTest({ id: pinned.id, revision: pinned.revision, hostFingerprint, result: cleaned });
      return { ok: true, result: { ...cleaned, at: new Date(clock()).toISOString() } };
    };
    if (credential.type !== 'ssh') return run(credential);
    // A saved credential that already pins a host key is verified by the
    // connection itself (StrictHostKeyChecking=yes), with no discovery scan.
    // A changed key still fails there as host-key-changed.
    if (!draft && credential.knownHostsFile) return run(credential);
    const scanned = await scan(draft && !credential.knownHostsFile ? target({ ...credential, id: undefined }) : target(credential), signal);
    if (!scanned.ok) { result = scanned; return run(credential); }
    const presented = scanned.hostKey.presented, trusted = scanned.hostKey.trusted, keyAuth = credential.fields.auth === 'key';
    // Explicit trust may replace a previous key for this draft only.
    const agreed = draft && input.trust !== undefined ? validTrust(input.trust) : null;
    if (agreed && presented.fingerprint !== agreed) { result = { ok: false, code: 'host-key-changed', detail: { trusted: { type: presented.type, fingerprint: agreed }, presented } }; return run(credential); }
    if (!agreed && scanned.hostKey.state === 'changed') { result = { ok: false, code: 'host-key-changed', detail: { trusted, presented }, hostKey: scanned.hostKey }; return run(credential); }
    if (!agreed && scanned.hostKey.state === 'new' && !keyAuth) { result = { ok: false, code: 'host-key-untrusted', detail: {}, hostKey: scanned.hostKey }; return run(credential); }
    if (scanned.hostKey.state === 'new' || agreed) {
      shown = scanned.hostKey;
      if (draft) return withKnownHost(credential, scanned.key, run);
      const saved = await store.trust({ id: credential.id, revision: credential.revision, key: scanned.key, firstUse: true });
      hostFingerprint = saved.hostKey.fingerprint;
      credential = await store.forUse(credential.id);
    }
    return run(credential);
  };

  return {
    initialize: store.initialize,
    summary: store.summary,
    invalidateUsage: () => usage.invalidate(),
    close: () => shutdown.abort(),
    save, installKey, testInput: input => network(signal => testInput(input, signal)), pinFirstUse: id => network(signal => pinFirstUse(id, signal)),
    trust: (id, expected, revision) => network(signal => trustSaved(id, expected, signal, revision)),
    scan: id => network(async signal => { const credential = await store.public(id); return scan(target(credential), signal); }),
    async handle(route, input = {}) {
      if (route === '/credentials') {
        const listed = await store.list();
        return { ok: true, ...await usage.annotate(listed.credentials), sshAliases: listed.sshAliases, types: publicTypes(), environmentId: await environmentId().catch(() => null) };
      }
      if (route === '/credentials/create' || route === '/credentials/save') return save(input, { create: route === '/credentials/create' });
      if (route === '/credentials/remove') return { ok: true, ...await store.remove(input) };
      if (route === '/credentials/forget-host-key') { await store.forget(input.id); return { ok: true }; }
      if (route === '/credentials/test') return network(signal => testInput(input, signal));
      if (route === '/credentials/trust') { const expected = validTrust({ fingerprint: input.fingerprint }); return network(signal => trustSaved(input.id, expected, signal, input.revision)); }
      if (route === '/credentials/detect') {
        if (typeof input.text !== 'string' || input.text.length > 48 * 1024) throw new CredentialError('Paste at most 48 KiB.');
        return { ok: true, detected: detect(input.text) };
      }
      if (route === '/credentials/generate-key') return { ok: true, ...await generate(input.id) };
      if (route === '/credentials/install-key') return installKey(input);
      if (route === '/credentials/scan') return network(async signal => {
        const credential = input.id === undefined ? { fields: { host: input.host, port: input.port } } : await store.public(input.id);
        if (input.id !== undefined && credential.type !== 'ssh') throw new CredentialError('Choose an SSH credential.');
        if (input.revision !== undefined && input.revision !== credential.revision) throw new CredentialError('This credential changed before its key could be reviewed. Read the current details first.', 409, 'changed', { current: credential });
        const started = clock(), scanned = await scan(target(credential), signal);
        return scanned.ok ? { ok: true, hostKey: scanned.hostKey } : { ok: true, result: { ...scanned, ms: clock() - started } };
      });
      throw new CredentialError('Credential action not found.', 404, 'not-found');
    },
  };
}
