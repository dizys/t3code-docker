import { isIP } from 'node:net';
import { CredentialError, object, validId, validText as text } from './errors.mjs';
import { TYPES, applies, isType, withDefaults } from './types.mjs';

const fail = (message, field) => { throw new CredentialError(message, 400, 'invalid', field ? { field } : {}); };
const MULTILINE_MAX = 48 * 1024;
const SECRET_MAX = 8192;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// A saved value under these names would break the command, or change what it runs.
const RESERVED_ENV = /^(?:PATH|HOME|USER|SHELL|PWD|IFS|LD_.*|DYLD_.*|NODE_OPTIONS|BASH_ENV|ENV)$/;

export const validHost = value => text(value, 253) && Boolean(isIP(value) || /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value));
export const validEnvName = value => typeof value === 'string' && ENV_NAME.test(value) && !RESERVED_ENV.test(value);

export function apiTarget(credential, relative) {
  const base = credential.fields?.baseUrl;
  if (!base) throw new CredentialError(`${credential.id} has no API address. Add one in Setup → Vault, or use t3-vault run instead.`);
  if (typeof relative !== 'string' || relative.length > 2048 || !relative.isWellFormed() || /[\x00-\x1f\x7f]/.test(relative) || relative.startsWith('/') || relative.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(relative)) throw new CredentialError('Use a path relative to the saved API address, such as projects/123.');
  const root = new URL(base), target = new URL(relative || '.', root);
  if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname) || target.username || target.password || target.hash) throw new CredentialError('The request must stay inside the saved API address.');
  return target;
}

function normalizeApi(fields, id) {
  let url;
  try { url = new URL(fields.baseUrl); } catch { fail('Enter a complete http:// or https:// address.', 'baseUrl'); }
  if (!text(fields.baseUrl, 2048) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('Use an HTTP or HTTPS address without credentials, a query or a fragment.', 'baseUrl');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  fields.baseUrl = url.href;
  if (fields.authType !== 'bearer') {
    if (!text(fields.authName, 128)) fail('Enter an authentication header or parameter name of up to 128 characters.', 'authName');
    if (fields.authType === 'header') {
      try { new Headers({ [fields.authName]: 'placeholder' }); } catch { fail('Enter a valid HTTP header name.', 'authName'); }
      if (['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'expect', 'trailer', 'te', 'accept', 'content-type'].includes(fields.authName.toLowerCase())) fail('Choose an authentication header, not a request transport or content header.', 'authName');
      if (fields.authPrefix !== undefined && (fields.authPrefix.length > 128 || /[^\x20-\x7e]/.test(fields.authPrefix))) fail('Use up to 128 printable ASCII characters for the optional header prefix.', 'authPrefix');
      if (fields.authPrefix !== undefined) fields.authPrefix = fields.authPrefix.trim();
    }
  }
  fields.testPath ??= '';
  apiTarget({ id, fields }, fields.testPath);
}

function normalizeField(entry, raw) {
  const blank = raw === undefined || raw === null || raw === '';
  if (entry.kind === 'number') {
    if (blank) { if (entry.optional) return undefined; fail(entry.message, entry.key); }
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isInteger(value) || value < entry.min || value > entry.max) fail(entry.message, entry.key);
    return value;
  }
  if (blank) { if (entry.optional) return undefined; fail(entry.message || `Enter ${entry.label.toLowerCase()}.`, entry.key); }
  if (entry.kind === 'select') { if (!entry.options.some(([value]) => value === raw)) fail(`Choose ${entry.label.toLowerCase()}.`, entry.key); return raw; }
  if (!text(raw, entry.max ?? 2048)) fail(entry.message || `Enter ${entry.label.toLowerCase()} of up to ${entry.max ?? 2048} characters, without line breaks.`, entry.key);
  if (entry.kind === 'host' && !validHost(raw)) fail(entry.message, entry.key);
  if (entry.pattern && !new RegExp(entry.pattern).test(raw)) fail(entry.message, entry.key);
  return raw;
}

function normalizeSecret(entry, raw, previous) {
  const value = raw === undefined || raw === null || raw === '' ? previous : raw;
  if (value === undefined) { if (entry.optional) return undefined; fail(`Enter ${entry.label.toLowerCase()}.`, entry.key); }
  if (typeof value !== 'string' || !value.isWellFormed()) fail(`Enter ${entry.label.toLowerCase()} as plain text.`, entry.key);
  if (entry.multiline) {
    if (value.length > MULTILINE_MAX || value.includes('\0') || !value.trim()) fail(`Enter ${entry.label.toLowerCase()} as text of up to 48 KiB.`, entry.key);
    return value;
  }
  // A pasted value or a file often ends in a line break that isn't part of it.
  const line = value.replace(/\r?\n$/, '');
  if (!text(line, SECRET_MAX)) fail(`Enter ${entry.label.toLowerCase()}, up to ${SECRET_MAX} characters without line breaks.`, entry.key);
  return line;
}

function normalizeCustom(input, previous) {
  const fields = {}, secrets = {}, kept = Array.isArray(input.secretNames) ? input.secretNames : Object.keys(input.secrets ?? {});
  const rawFields = object(input.fields) ? input.fields : {}, rawSecrets = object(input.secrets) ? input.secrets : {};
  if (Object.keys(rawFields).length + kept.length > 64) fail('Save at most 64 variables in one credential.');
  for (const [name, value] of Object.entries(rawFields)) {
    if (!validEnvName(name)) fail(`${String(name).slice(0, 64)} can't be used as a variable name.`, 'vars');
    if (typeof value !== 'string' || value.length > SECRET_MAX || !value.isWellFormed() || value.includes('\0')) fail(`Enter ${name} as text of up to ${SECRET_MAX} characters.`, 'vars');
    fields[name] = value;
  }
  for (const name of kept) {
    if (!validEnvName(name)) fail(`${String(name).slice(0, 64)} can't be used as a variable name.`, 'vars');
    if (Object.hasOwn(fields, name)) fail(`${name} is listed twice.`, 'vars');
    const value = normalizeSecret({ key: name, label: name, multiline: true }, rawSecrets[name], previous?.secrets?.[name]);
    secrets[name] = value;
  }
  if (!Object.keys(fields).length && !Object.keys(secrets).length) fail('Add at least one variable.', 'vars');
  return { fields, secrets, env: {} };
}

export function normalize(input, previous) {
  if (!object(input)) fail('Enter credential details.');
  if (!validId(input.id)) fail('Use up to 64 lowercase letters, numbers and single hyphens for the credential name.', 'id');
  if (input.id === 'new') fail('That name is reserved. Choose another.', 'id');
  if (!isType(input.type)) fail('Choose a credential type.', 'type');
  if (previous && previous.type !== input.type) fail('Create a new credential to change its type.', 'type');
  if (previous && previous.id !== input.id) fail('The credential name cannot change.', 'id');
  const description = input.description ?? previous?.description ?? '';
  if (typeof description !== 'string' || description.length > 200 || (description && !text(description, 200))) fail('Use up to 200 characters for the description, on one line.', 'description');
  const base = { id: input.id, type: input.type, description };
  const spec = TYPES[input.type];
  if (spec.dynamic) return { ...base, ...normalizeCustom(input, previous) };
  const raw = withDefaults(input.type, object(input.fields) ? { ...previous?.fields, ...input.fields } : previous?.fields);
  const fields = {};
  // API settings only mean something beside an address, so they vanish with it.
  for (const entry of spec.fields) {
    if (!applies(entry, raw)) continue;
    const value = normalizeField(entry, raw[entry.key]);
    if (value !== undefined) fields[entry.key] = value;
  }
  if (fields.baseUrl) normalizeApi(fields, input.id);
  const secrets = {}, rawSecrets = object(input.secrets) ? input.secrets : {};
  for (const entry of spec.secrets) {
    if (!applies(entry, fields)) continue;
    const value = normalizeSecret(entry, rawSecrets[entry.key], previous?.secrets?.[entry.key]);
    if (value !== undefined) secrets[entry.key] = value;
  }
  const env = {}, rawEnv = object(input.env) ? { ...previous?.env, ...input.env } : previous?.env ?? {};
  for (const entry of [...spec.fields, ...spec.secrets]) {
    const name = rawEnv[entry.key];
    if (!entry.editableEnv || name === undefined || name === '') continue;
    if (!validEnvName(name)) fail(`Use letters, numbers and underscores for the variable name, not a name the system relies on.`, 'env');
    env[entry.key] = name;
  }
  return { ...base, fields, secrets, env };
}

// One record from before the Vault, in the shape above.
export function upgradeProfile(profile) {
  const { id, type, secret, createdAt, updatedAt, secretChangedAt, revision } = profile;
  const stamps = { ...(createdAt ? { createdAt } : {}), ...(updatedAt ? { updatedAt } : {}), ...(secretChangedAt !== undefined ? { secretChangedAt } : {}), ...(revision ? { revision } : {}) };
  if (type === 'ssh') return { id, type: 'ssh', description: '', fields: { host: profile.host, port: profile.port, username: profile.username, auth: 'password' }, secrets: { password: secret }, env: {}, ...stamps };
  const fields = { baseUrl: profile.baseUrl, authType: profile.authType ?? 'bearer', ...(profile.authName ? { authName: profile.authName } : {}), ...(profile.authPrefix ? { authPrefix: profile.authPrefix } : {}), testPath: profile.testPath ?? '' };
  return { id, type: 'token', description: '', fields, secrets: { token: secret }, env: {}, ...stamps };
}
