import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { CredentialError } from './errors.mjs';
import { apiTarget } from './model.mjs';
import { byteFilter } from './redact.mjs';
import { createSshDiagnostics } from './diagnostics.mjs';
import { delivery, secretValues } from './deliver.mjs';
export { apiTarget } from './model.mjs';
export { outputFilter, byteFilter } from './redact.mjs';

export const askpassPath = fileURLToPath(new URL('./askpass.sh', import.meta.url));

async function pump(stream, write, secrets) {
  if (!stream) return;
  const filter = byteFilter(secrets, write);
  try { for await (const chunk of stream) filter.write(chunk); }
  finally { filter.end(); }
}

// Memory-backed where the container has it, so secrets in files never reach the disk.
async function privateFolder(prefix) {
  let parent = os.tmpdir();
  try { await fs.access('/dev/shm', fs.constants.W_OK); parent = '/dev/shm'; } catch { /* Use the default. */ }
  const directory = await fs.mkdtemp(path.join(parent, prefix));
  await fs.chmod(directory, 0o700);
  return directory;
}

const failure = code => ({ ok: false, code, detail: {} });
function sshResult(code, diagnostics, credential, aborted) {
  if (aborted || /Connection timed out|Operation timed out/i.test(diagnostics)) return failure('timeout');
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|no matching host key type/i.test(diagnostics)) return failure('host-key-changed');
  if (/Could not resolve hostname|Connection refused|No route to host|Network is unreachable|Name or service not known/i.test(diagnostics)) return failure('unreachable');
  if (/Permission denied/i.test(diagnostics)) return failure('auth-rejected');
  if (code === 0) return { ok: true, code: 'ok', detail: { user: credential.fields.username } };
  return { ok: false, code: 'failed', detail: { line: diagnostics.trim().split(/\r?\n/).at(-1)?.slice(-160) || 'SSH did not complete the connection.' } };
}

const pinOptions = (credential, knownHostsFile, hostKeyType) => {
  const algorithm = hostKeyType === 'ssh-rsa' ? 'rsa-sha2-512,rsa-sha2-256' : hostKeyType;
  return ['-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + knownHostsFile.replace(/%/g, '%%'), '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'HostKeyAlias=' + credential.id, '-o', 'HostKeyAlgorithms=' + algorithm];
};
const authOptions = (credential, keyFile) => credential.fields.auth === 'key'
  ? ['-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'BatchMode=yes']
  : ['-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'BatchMode=no'];

export async function sshRequest(credential, command, { stdout = process.stdout, stderr = process.stderr, stdin = 'inherit', probe = false, interactive = false, signal, spawnProcess = spawn, diagnosticsFactory = createSshDiagnostics } = {}) {
  if (credential.type !== 'ssh') throw new CredentialError(`${credential.id} isn't an SSH credential. Use t3-vault run instead.`);
  if (!credential.knownHostsFile || !credential.hostKeyType) {
    if (probe) return failure('host-key-untrusted');
    throw new CredentialError(`The host key for ${credential.id} isn't trusted yet. Run t3-vault trust ${credential.id}, or review it in Setup → Vault.`, 409, 'host-key-untrusted');
  }
  const secrets = secretValues(credential), keyAuth = credential.fields.auth === 'key';
  let folder = null, keyFile = null, passwordFile = null;
  if (keyAuth) {
    folder = await privateFolder('t3-vault-ssh-');
    keyFile = path.join(folder, 'key');
    await fs.writeFile(keyFile, credential.secrets.privateKey, { mode: 0o600, flag: 'wx' });
  } else {
    // The password itself never enters the environment (/proc/<pid>/environ
    // shows it to every same-user process); only this private file's path does.
    folder = await privateFolder('t3-vault-ssh-');
    passwordFile = path.join(folder, 'password');
    await fs.writeFile(passwordFile, credential.secrets.password, { mode: 0o600, flag: 'wx' });
  }
  const env = { ...process.env, ...(keyAuth ? {} : { SSH_ASKPASS: askpassPath, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 't3-vault', T3_CREDENTIAL_PASSWORD_FILE: passwordFile }) };
  const target = ['-p', String(credential.fields.port), '-l', credential.fields.username, '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ControlPath=none',
    ...pinOptions(credential, credential.knownHostsFile, credential.hostKeyType), ...authOptions(credential, keyFile), '--', credential.fields.host];
  try {
    if (interactive) {
      const child = spawnProcess('/usr/bin/ssh', ['-o', 'LogLevel=ERROR', ...target, ...command], { env, stdio: 'inherit', signal });
      return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', status => resolve(status ?? 1)); });
    }
    let diagnostics;
    try { diagnostics = await diagnosticsFactory(secrets, probe ? () => {} : value => stderr.write(value)); }
    catch { if (probe) return failure('failed'); throw new CredentialError('SSH diagnostics could not start.', 502); }
    let child, code = 1, startFailed = false;
    try {
      child = spawnProcess('/usr/bin/ssh', ['-T', '-E', diagnostics.file, '-o', 'LogLevel=ERROR', ...target, ...command], { env, stdio: [stdin, 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
      // Abort kills the child; waiting for close also drains both output streams.
      const done = new Promise(resolve => {
        child.once('error', () => { startFailed = true; });
        child.once('close', status => resolve(status ?? 1));
      });
      const discard = () => {};
      [, , code] = await Promise.all([
        pump(child.stdout, probe ? discard : value => stdout.write(value), secrets),
        pump(child.stderr, probe ? discard : value => stderr.write(value), secrets), done,
      ]);
    } catch { startFailed = true; child?.kill('SIGKILL'); }
    const diagnosticText = await diagnostics.close();
    if (probe) return sshResult(startFailed ? 1 : code, diagnosticText, credential, signal?.aborted);
    if (startFailed) throw new CredentialError('SSH could not start or was interrupted.', 502);
    return code;
  } finally { if (folder) await fs.rm(folder, { recursive: true, force: true }); }
}

function networkCode(error, signal) {
  if (signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  for (let at = error, depth = 0; at && depth < 8; at = at.cause, depth++) if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(at.code || '')) return 'certificate';
  return 'unreachable';
}
export async function apiRequest(credential, method, relative, { body, stdout = process.stdout, stderr = process.stderr, probe = false, signal = AbortSignal.timeout(30000), fetchRequest = fetch } = {}) {
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new CredentialError('Use GET, HEAD, POST, PUT, PATCH or DELETE.');
  const target = apiTarget(credential, relative), { authType, authName, authPrefix } = credential.fields, secret = credential.secrets.token;
  const secrets = secretValues(credential);
  try {
    const headers = new Headers({ accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) });
    if (authType === 'query') target.searchParams.set(authName, secret);
    else if (authType === 'header') headers.set(authName, (authPrefix ? authPrefix + ' ' : '') + secret);
    else headers.set('authorization', 'Bearer ' + secret);
    const response = await fetchRequest(target, { method, redirect: 'manual', signal, headers, body });
    const redirected = response.status >= 300 && response.status < 400;
    if (probe || redirected) {
      await response.body?.cancel();
      const code = redirected ? 'redirect' : response.ok ? 'ok' : [401, 403].includes(response.status) ? 'rejected' : response.status === 404 ? 'not-found' : 'http-error';
      if (probe) return { ok: code === 'ok', code, detail: { status: response.status } };
      throw new CredentialError('API request refused a redirect. Use the final API address in Setup → Vault.', 502, 'redirect');
    }
    if (response.body) await pump(Readable.fromWeb(response.body), value => stdout.write(value), secrets);
    if (!response.ok) stderr.write('HTTP ' + response.status + '\n');
    return response.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    const code = networkCode(error, signal);
    if (probe) return failure(code);
    throw new CredentialError('API request failed. Check the address, certificate and network; redirects are not followed.', 502, code);
  }
}

/**
 * Runs a command with saved credentials in its environment and hides their
 * values in its output. Returns the exit code a shell would report.
 */
export async function runWith(credentials, command, { stdout = process.stdout, stderr = process.stderr, stdin = 'inherit', env = process.env, spawnProcess = spawn, signals = process } = {}) {
  const merged = { ...env }, masks = [], set = new Map(), files = [];
  const claim = (name, owner) => {
    if (set.has(name) && set.get(name) !== owner) throw new CredentialError(`${set.get(name)} and ${owner} both set ${name}. Give one a different name with ${owner}=OTHER_NAME.`);
    set.set(name, owner);
  };
  for (const { credential, rename } of credentials) {
    const given = delivery(credential, { rename, base: merged, askpass: askpassPath });
    // Botocore checks the legacy alias first, so clear both inherited tokens.
    // Keep values explicitly supplied by other selected credentials.
    if (credential.type === 'aws') for (const name of ['AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN']) {
      if (given.env[name] === undefined && !set.has(name)) delete merged[name];
    }
    for (const [name, value] of Object.entries(given.env)) { if (!name.startsWith('GIT_CONFIG_')) claim(name, credential.id); merged[name] = value; }
    for (const file of given.files) { claim(file.env, credential.id); files.push(file); }
    masks.push(...given.masks);
  }
  let folder = null;
  try {
    if (files.length) {
      folder = await privateFolder('t3-vault-run-');
      for (const [index, file] of files.entries()) {
        const directory = path.join(folder, String(index));
        await fs.mkdir(directory, { mode: 0o700 });
        const target = path.join(directory, file.name);
        await fs.writeFile(target, file.content, { mode: 0o600, flag: 'wx' });
        merged[file.env] = target;
      }
    }
    const child = spawnProcess(command[0], command.slice(1), { env: merged, stdio: [stdin, 'pipe', 'pipe'] });
    const forward = name => () => { child.kill(name); };
    const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => [name, forward(name)]);
    for (const [name, handler] of handlers) signals.on(name, handler);
    try {
      const closed = new Promise(resolve => {
        child.once('error', error => resolve({ error }));
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const [, , result] = await Promise.all([
        pump(child.stdout, value => stdout.write(value), masks),
        pump(child.stderr, value => stderr.write(value), masks), closed,
      ]);
      if (result.error?.code === 'ENOENT') throw new CredentialError(`Command not found: ${command[0]}`, 127, 'command-not-found');
      if (result.error) throw new CredentialError(`${command[0]} could not start.`, 126, 'command-failed');
      return result.signal ? 128 + (os.constants.signals[result.signal] || 0) : result.code ?? 1;
    } finally { for (const [name, handler] of handlers) signals.off(name, handler); }
  } finally { if (folder) await fs.rm(folder, { recursive: true, force: true }); }
}

export const canTest = credential => credential.type === 'ssh' || Boolean(credential.fields?.baseUrl);
export const testCredential = (credential, { signal = AbortSignal.timeout(15000), ...options } = {}) => credential.type === 'ssh'
  ? sshRequest(credential, ['true'], { ...options, probe: true, stdin: 'ignore', signal })
  : apiRequest(credential, 'GET', credential.fields.testPath || '', { ...options, probe: true, signal });
