import { isIP } from 'node:net';
import { CredentialError, object, validText as text } from './errors.mjs';
const fail = message => { throw new CredentialError(message); };

export function apiTarget(profile, relative) {
  if (profile.type !== 'api') throw new CredentialError('Choose an API connection.');
  if (typeof relative !== 'string' || relative.length > 2048 || !relative.isWellFormed() || /[\x00-\x1f\x7f]/.test(relative) || relative.startsWith('/') || relative.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(relative)) throw new CredentialError('Use a path relative to the saved API address, such as projects/123.');
  const base = new URL(profile.baseUrl), target = new URL(relative || '.', base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.username || target.password || target.hash) throw new CredentialError('The request must stay inside the saved API address.');
  return target;
}

export function normalize(input, previous) {
  if (!object(input)) fail('Enter connection details.');
  if (!text(input.id, 64) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)) fail('Use up to 64 lowercase letters, numbers and single hyphens for the credential name.');
  if (!['ssh', 'api'].includes(input.type)) fail('Choose SSH server or HTTP API.');
  if (previous && previous.type !== input.type) fail('Create a new connection to change its type.');
  const secret = input.secret === undefined || input.secret === '' ? previous?.secret : input.secret;
  if (!text(secret, 8192)) fail('Enter a password or API key of up to 8192 characters, without line breaks.');
  if (previous && previous.id !== input.id) fail('The credential name cannot change.');
  const profile = { id: input.id, type: input.type, secret };
  if (input.type === 'ssh') {
    if (!text(input.host, 253) || !(isIP(input.host) || /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(input.host))) fail('Enter a hostname or IP address, without a username or port.');
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

