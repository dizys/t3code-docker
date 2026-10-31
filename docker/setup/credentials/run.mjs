import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { CredentialError } from './errors.mjs';
import { apiTarget } from './model.mjs';
import { outputFilter } from './redact.mjs';
import { createSshDiagnostics } from './diagnostics.mjs';
export { apiTarget } from './model.mjs';
export { outputFilter } from './redact.mjs';

async function pump(stream, write, secret) {
  if (!stream) return;
  stream.setEncoding('utf8');
  const filter = outputFilter(secret, write);
  try { for await (const chunk of stream) filter.write(chunk); }
  finally { filter.end(); }
}
const failure = code => ({ ok: false, code, detail: {} });
function sshResult(code, diagnostics, profile, aborted) {
  if (aborted || /Connection timed out|Operation timed out/i.test(diagnostics)) return failure('timeout');
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|no matching host key type/i.test(diagnostics)) return failure('host-key-changed');
  if (/Could not resolve hostname|Connection refused|No route to host|Network is unreachable|Name or service not known/i.test(diagnostics)) return failure('unreachable');
  if (/Permission denied/i.test(diagnostics)) return failure('auth-rejected');
  if (code === 0) return { ok: true, code: 'ok', detail: { user: profile.username } };
  return { ok: false, code: 'failed', detail: { line: diagnostics.trim().split(/\r?\n/).at(-1)?.slice(-160) || 'SSH did not complete the connection.' } };
}

export async function sshRequest(profile, command, { stdout = process.stdout, stderr = process.stderr, stdin = 'inherit', probe = false, signal, spawnProcess = spawn, diagnosticsFactory = createSshDiagnostics } = {}) {
  if (profile.type !== 'ssh') throw new CredentialError('Choose an SSH credential.');
  if (!profile.knownHostsFile || !profile.hostKeyType) {
    if (probe) return failure('host-key-untrusted');
    throw new CredentialError('Host key not trusted yet. Open Setup → Credentials and review this server’s fingerprint.', 409, 'host-key-untrusted');
  }
  let diagnostics;
  try { diagnostics = await diagnosticsFactory(profile.secret, probe ? () => {} : value => stderr.write(value)); }
  catch { if (probe) return failure('failed'); throw new CredentialError('SSH diagnostics could not start.', 502); }
  const algorithm = profile.hostKeyType === 'ssh-rsa' ? 'rsa-sha2-512,rsa-sha2-256' : profile.hostKeyType;
  const args = ['-T', '-E', diagnostics.file, '-p', String(profile.port), '-l', profile.username,
    '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'BatchMode=no', '-o', 'ControlPath=none', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UserKnownHostsFile=' + profile.knownHostsFile, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'HostKeyAlias=' + profile.id, '-o', 'HostKeyAlgorithms=' + algorithm,
    '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '--', profile.host, ...command];
  let child, code = 1, startFailed = false;
  try {
    child = spawnProcess('/usr/bin/ssh', args, {
      env: { ...process.env, SSH_ASKPASS: fileURLToPath(new URL('./askpass.sh', import.meta.url)),
        SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 't3-credentials', T3_CREDENTIAL_PASSWORD: profile.secret },
      stdio: [stdin, 'pipe', 'pipe'], signal, killSignal: 'SIGKILL',
    });
    // Abort kills the child; waiting for close also drains both output streams.
    const done = new Promise(resolve => {
      child.once('error', () => { startFailed = true; });
      child.once('close', status => resolve(status ?? 1));
    });
    const discard = () => {};
    [, , code] = await Promise.all([
      pump(child.stdout, probe ? discard : value => stdout.write(value), profile.secret),
      pump(child.stderr, probe ? discard : value => stderr.write(value), profile.secret), done,
    ]);
  } catch { startFailed = true; child?.kill('SIGKILL'); }
  const diagnosticText = await diagnostics.close();
  if (probe) return sshResult(startFailed ? 1 : code, diagnosticText, profile, signal?.aborted);
  if (startFailed) throw new CredentialError('SSH could not start or was interrupted.', 502);
  return code;
}
function networkCode(error, signal) {
  if (signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  for (let at = error, depth = 0; at && depth < 8; at = at.cause, depth++) if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(at.code || '')) return 'certificate';
  return 'unreachable';
}
export async function apiRequest(profile, method, relative, { body, stdout = process.stdout, stderr = process.stderr, probe = false, signal = AbortSignal.timeout(30000), fetchRequest = fetch } = {}) {
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new CredentialError('Use GET, HEAD, POST, PUT, PATCH or DELETE.');
  const target = apiTarget(profile, relative);
  try {
    const headers = new Headers({ accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) });
    if (profile.authType === 'query') target.searchParams.set(profile.authName, profile.secret);
    else if (profile.authType === 'header') headers.set(profile.authName, (profile.authPrefix ? profile.authPrefix + ' ' : '') + profile.secret);
    else headers.set('authorization', 'Bearer ' + profile.secret);
    const response = await fetchRequest(target, { method, redirect: 'manual', signal, headers, body });
    const redirected = response.status >= 300 && response.status < 400;
    if (probe || redirected) {
      await response.body?.cancel();
      const code = redirected ? 'redirect' : response.ok ? 'ok' : [401, 403].includes(response.status) ? 'rejected' : response.status === 404 ? 'not-found' : 'http-error';
      if (probe) return { ok: code === 'ok', code, detail: { status: response.status } };
      throw new CredentialError('API request refused a redirect. Use the final API address in Setup → Credentials.', 502, 'redirect');
    }
    if (response.body) await pump(Readable.fromWeb(response.body), value => stdout.write(value), profile.secret);
    if (!response.ok) stderr.write('HTTP ' + response.status + '\n');
    return response.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    const code = networkCode(error, signal);
    if (probe) return failure(code);
    throw new CredentialError('API request failed. Check the address, certificate and network; redirects are not followed.', 502, code);
  }
}
export const testCredential = (profile, { signal = AbortSignal.timeout(15000), ...options } = {}) => profile.type === 'ssh'
  ? sshRequest(profile, ['true'], { ...options, probe: true, stdin: 'ignore', signal })
  : apiRequest(profile, 'GET', profile.testPath || '', { ...options, probe: true, signal });
