// Public reads return connection details only. Helpers read secrets directly,
// so saved passwords and tokens never need to pass through an agent prompt.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class CredentialError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new CredentialError(message, status); };
const MAX_BYTES = 512 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
export const credentialDirectory = (env = process.env) => path.join(env.T3CODE_HOME || path.join(env.HOME || '/home/t3', '.t3'), 'server-credentials');

export function apiTarget(profile, relative) {
  if (profile.type !== 'api') throw new CredentialError('Choose an API connection.');
  if (typeof relative !== 'string' || relative.length > 2048 || !relative.isWellFormed() || /[\x00-\x1f\x7f]/.test(relative) || relative.startsWith('/') || relative.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(relative)) throw new CredentialError('Use a path relative to the saved API address, such as projects/123.');
  const base = new URL(profile.baseUrl), target = new URL(relative || '.', base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.username || target.password || target.hash) throw new CredentialError('The request must stay inside the saved API address.');
  return target;
}

function normalize(input, previous) {
  if (!object(input)) fail('Enter connection details.');
  if (!text(input.id, 64) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)) fail('Use up to 64 lowercase letters, numbers and single hyphens for the connection ID.');
  if (!text(input.label, 120) || !input.label.trim()) fail('Enter a connection name of up to 120 characters.');
  if (!['ssh', 'api'].includes(input.type)) fail('Choose SSH password or API key / token.');
  if (previous && previous.type !== input.type) fail('Create a new connection to change its type.');
  const secret = input.secret === undefined || input.secret === '' ? previous?.secret : input.secret;
  if (!text(secret, 8192)) fail('Enter a password or API key of up to 8192 characters, without line breaks.');
  const profile = { id: input.id, label: input.label.trim(), type: input.type, secret };
  if (input.type === 'ssh') {
    if (!text(input.host, 253) || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(input.host)) fail('Enter a hostname or IP address, without a username or port.');
    if (!text(input.username, 64) || !/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(input.username)) fail('Enter a valid SSH username.');
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) fail('Enter an SSH port from 1 to 65535.');
    Object.assign(profile, { host: input.host, username: input.username, port: input.port });
  } else {
    let url;
    try { url = new URL(input.baseUrl); } catch { fail('Enter a complete http:// or https:// API address.'); }
    if (!text(input.baseUrl, 2048) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('Use an HTTP or HTTPS API address without credentials, a query or a fragment.');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    profile.baseUrl = url.href;
    profile.authType = input.authType ?? previous?.authType ?? 'bearer';
    if (!['bearer', 'header', 'query'].includes(profile.authType)) fail('Choose bearer token, custom header or query parameter authentication.');
    if (profile.authType !== 'bearer') {
      const name = input.authName ?? previous?.authName;
      if (!text(name, 128)) fail('Enter an authentication header or parameter name of up to 128 characters.');
      if (profile.authType === 'header') {
        try { new Headers({ [name]: 'placeholder' }); } catch { fail('Enter a valid HTTP header name.'); }
        if (['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'expect', 'trailer', 'te', 'accept', 'content-type'].includes(name.toLowerCase())) fail('Choose an authentication header, not a request transport or content header.');
        const prefix = input.authPrefix ?? previous?.authPrefix ?? '';
        if (typeof prefix !== 'string' || prefix.length > 128 || /[^\x20-\x7e]/.test(prefix)) fail('Use up to 128 printable ASCII characters for the optional header prefix.');
        profile.authPrefix = prefix.trim();
      }
      profile.authName = name;
    }
    profile.testPath = input.testPath ?? previous?.testPath ?? '';
    apiTarget(profile, profile.testPath);
  }
  return profile;
}

const publicProfile = ({ secret, ...profile }) => ({ ...profile, hasSecret: true });
const revisionOf = text => createHash('sha256').update(text).digest('hex');
const EMPTY = JSON.stringify({ version: 1, profiles: [] });
export const credentialFailure = error => error instanceof CredentialError
  ? { status: error.status, body: { ok: false, error: error.message } }
  : { status: 500, body: { ok: false, error: 'Could not access saved credentials. Check the state volume and its permissions.' } };

export function createCredentialStore({ directory = credentialDirectory() } = {}) {
  const file = path.join(directory, 'credentials.json');
  let queue = Promise.resolve();
  const serial = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const secureDirectory = async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid()) fail('The credential directory must belong to the container user and must not be a symbolic link.', 500);
    await fs.chmod(directory, 0o700);
  };
  const read = async () => {
    await secureDirectory();
    let handle, raw = EMPTY;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > MAX_BYTES) fail('The credential file is unsafe or exceeds its size limit. Repair it before continuing.', 500);
      await handle.chmod(0o600);
      raw = await handle.readFile('utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally { await handle?.close(); }
    let data;
    try {
      data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 64) throw new Error();
      data.profiles = data.profiles.map(profile => normalize(profile));
      if (new Set(data.profiles.map(profile => profile.id)).size !== data.profiles.length) throw new Error();
    } catch { fail('Saved credentials could not be read. Restore the credential file before making changes.', 500); }
    return { profiles: data.profiles, revision: revisionOf(raw) };
  };
  const write = async profiles => {
    const raw = JSON.stringify({ version: 1, profiles }, null, 2) + '\n';
    if (Buffer.byteLength(raw) > MAX_BYTES) fail('Saved credentials exceed the 512 KiB limit.');
    const temporary = path.join(directory, '.' + randomUUID() + '.tmp');
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return revisionOf(raw);
  };
  const checkRevision = (expected, actual) => {
    if (expected !== actual) fail('Connections changed in another window. Close this editor, reload the list and reopen the connection before saving again.', 409);
  };
  return {
    async list() {
      const data = await read();
      return { profiles: data.profiles.map(publicProfile), revision: data.revision };
    },
    save: ({ profile, revision, create = false }) => serial(async () => {
      const data = await read();
      checkRevision(revision, data.revision);
      const index = data.profiles.findIndex(row => row.id === profile?.id);
      if (create && index >= 0) fail('This connection ID is already in use. Choose another ID.', 409);
      if (!create && index < 0) fail('This connection no longer exists. Reload the list.', 409);
      const saved = normalize(profile, data.profiles[index]);
      if (index < 0) {
        if (data.profiles.length >= 64) fail('Save at most 64 connections.');
        data.profiles.push(saved);
      } else data.profiles[index] = saved;
      return { profile: publicProfile(saved), revision: await write(data.profiles) };
    }),
    remove: ({ id, revision }) => serial(async () => {
      const data = await read();
      checkRevision(revision, data.revision);
      if (!data.profiles.some(row => row.id === id)) fail('This connection no longer exists.', 404);
      return { revision: await write(data.profiles.filter(row => row.id !== id)) };
    }),
    async forUse(id) {
      const data = await read();
      const profile = data.profiles.find(row => row.id === id);
      if (!profile) fail('Saved connection not found. Add it in Setup → Server credentials.', 404);
      return profile;
    },
  };
}
