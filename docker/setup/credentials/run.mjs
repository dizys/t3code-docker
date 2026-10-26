import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { CredentialError } from '../credentials.mjs';

// Keep matches that straddle output chunks private too. Encoded JSON/API
// echoes and URL-encoded diagnostics are scrubbed alongside the literal value.
export function outputFilter(secret, write) {
  const values = [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')])].filter(Boolean).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const keep = Math.max(...values.map(value => value.length)) - 1;
  let pending = '';
  const flush = final => {
    let cut = final ? pending.length : Math.max(0, pending.length - keep);
    for (const match of pending.matchAll(pattern)) {
      if (match.index < cut && match.index + match[0].length > cut) cut = match.index + match[0].length;
    }
    if (cut) { write(pending.slice(0, cut).replace(pattern, '[redacted]')); pending = pending.slice(cut); }
  };
  return { write(chunk) { pending += chunk; flush(false); }, end() { flush(true); } };
}

async function pump(stream, write, secret) {
  stream.setEncoding('utf8');
  const filter = outputFilter(secret, write);
  try { for await (const chunk of stream) filter.write(chunk); }
  finally { filter.end(); }
}

export async function sshRequest(profile, command, { stdout = process.stdout, stderr = process.stderr, stdin = 'inherit', probe = false, signal, spawnProcess = spawn } = {}) {
  if (profile.type !== 'ssh') throw new CredentialError('Choose an SSH connection.');
  const args = ['-T', '-p', String(profile.port), '-l', profile.username,
    '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'BatchMode=no', '-o', 'ControlPath=none',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'PubkeyAuthentication=no', '--', profile.host, ...command];
  const child = spawnProcess('/usr/bin/ssh', args, {
    env: { ...process.env, SSH_ASKPASS: fileURLToPath(new URL('./askpass.sh', import.meta.url)),
      SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 't3-credentials', T3_CREDENTIAL_PASSWORD: profile.secret },
    stdio: [stdin, 'pipe', 'pipe'], signal,
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', () => reject(new CredentialError('SSH could not start or was interrupted.', 502)));
    child.once('close', code => resolve(code ?? 1));
  });
  const discard = () => {};
  const [, , code] = await Promise.all([
    pump(child.stdout, probe ? discard : value => stdout.write(value), profile.secret),
    pump(child.stderr, probe ? discard : value => stderr.write(value), profile.secret), done,
  ]);
  if (probe && code !== 0) throw new CredentialError('SSH connection failed. Check the address, login details and saved host key.', 502);
  return code;
}

export function apiTarget(profile, relative) {
  if (profile.type !== 'api') throw new CredentialError('Choose an API token connection.');
  if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(relative)) throw new CredentialError('Use a path relative to the saved API address, such as states/light.kitchen.');
  const base = new URL(profile.baseUrl), target = new URL(relative || '.', base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.username || target.password || target.hash) throw new CredentialError('The request must stay inside the saved API address.');
  return target;
}

export async function apiRequest(profile, method, relative, { body, stdout = process.stdout, probe = false, signal = AbortSignal.timeout(30000) } = {}) {
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new CredentialError('Use GET, HEAD, POST, PUT, PATCH or DELETE.');
  const target = apiTarget(profile, relative);
  try {
    const response = await fetch(target, { method, redirect: 'error', signal,
      headers: { authorization: 'Bearer ' + profile.secret, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body });
    if (probe) {
      await response.body?.cancel();
      if (!response.ok) throw new CredentialError('The API did not accept the request (HTTP ' + response.status + '). Check the address and token.', 502);
    } else if (response.body) await pump(Readable.fromWeb(response.body), value => stdout.write(value), profile.secret);
    return response.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError('API request failed. Check the address, certificate and network; redirects are not followed.', 502);
  }
}

export const testCredential = (profile, { signal = AbortSignal.timeout(15000) } = {}) => {
  return profile.type === 'ssh' ? sshRequest(profile, ['true'], { probe: true, stdin: 'ignore', signal })
    : apiRequest(profile, 'GET', '', { probe: true, signal });
};
