// SSH private keys, handled only through OpenSSH's own tools in a private
// temporary folder. The folder never outlives the call.
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialError } from './errors.mjs';
import { execute } from './hostkeys.mjs';

const KEYGEN = '/usr/bin/ssh-keygen';
// ssh-keygen's -P would put the passphrase in the process list, and its
// environment would put it in /proc, so only the file's path travels in env.
const askpassEnv = file => ({ ...process.env, SSH_ASKPASS: fileURLToPath(new URL('./askpass.sh', import.meta.url)), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 't3-vault', T3_CREDENTIAL_PASSWORD_FILE: file });

/**
 * A key in its normal form, or null if this isn't one. T3's secret card has a
 * single-line box, and browsers drop line breaks from those, so a pasted key
 * arrives as one long line. The body is base64, so it can be wrapped again.
 */
export function rebuildPrivateKey(input) {
  // Old-style encrypted keys have headers that line breaks are part of. They
  // can't be rebuilt, but one that still has its line breaks is fine as it is.
  if (/^-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\nProc-Type:/.test(String(input).trim())) return String(input).trim().replace(/\r\n/g, '\n') + '\n';
  // Plain string steps, because a backtracking pattern here slows badly on long pastes.
  const text = String(input).trim();
  const head = /^-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA) )?PRIVATE KEY-----/.exec(text)?.[0];
  const foot = /-----END (?:(?:OPENSSH|RSA|EC|DSA) )?PRIVATE KEY-----$/.exec(text.slice(-64))?.[0];
  if (!head || !foot || text.length < head.length + foot.length) return null;
  const inner = text.slice(head.length, text.length - foot.length).replace(/\s+/g, '');
  if (!inner || !/^[A-Za-z0-9+/=]+$/.test(inner)) return null;
  return head + '\n' + inner.match(/.{1,70}/g).join('\n') + '\n' + foot + '\n';
}

async function workspace(work) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 't3-vault-key-'));
  try { await fs.chmod(directory, 0o700); return await work(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Generates a new ed25519 key without a passphrase: the store has its own protection. */
export const generateKey = (comment, { run = execute } = {}) => workspace(async directory => {
  const file = path.join(directory, 'key');
  const answer = await run(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { timeout: 10000 });
  if (answer.code !== 0) throw new CredentialError('A new SSH key could not be generated.', 500, 'key-failed');
  return { privateKey: await fs.readFile(file, 'utf8'), publicKey: (await fs.readFile(file + '.pub', 'utf8')).trim() };
});

/**
 * Checks a pasted key and returns it without a passphrase, plus its public half.
 * The store is plain text either way, and `ssh prod` can't answer a passphrase
 * prompt, so a passphrase here would add a failure without adding protection.
 */
export const openPrivateKey = (input, { passphrase, comment, run = execute } = {}) => workspace(async directory => {
  const text = rebuildPrivateKey(input);
  if (!text) throw new CredentialError('That doesn’t look like a private key. Paste the whole file, including its BEGIN and END lines.', 400, 'key-invalid', { field: 'privateKey' });
  const file = path.join(directory, 'key');
  await fs.writeFile(file, text, { mode: 0o600, flag: 'wx' });
  let passphraseFile = null;
  if (passphrase) {
    passphraseFile = path.join(directory, 'passphrase');
    await fs.writeFile(passphraseFile, passphrase, { mode: 0o600, flag: 'wx' });
  }
  let open = await run(KEYGEN, passphrase ? ['-y', '-f', file] : ['-y', '-P', '', '-f', file], { timeout: 10000, ...(passphrase ? { env: askpassEnv(passphraseFile) } : {}) });
  if (open.code !== 0 && !passphrase) throw new CredentialError('This key needs its passphrase, or it isn’t a valid private key.', 400, 'key-passphrase', { field: 'passphrase' });
  if (open.code !== 0) throw new CredentialError('That passphrase didn’t open this key.', 400, 'key-passphrase', { field: 'passphrase' });
  const publicKey = open.stdout.trim().split(/\s+/).slice(0, 2).join(' ') + (comment ? ' ' + comment : '');
  if (passphrase) {
    open = await run(KEYGEN, ['-q', '-p', '-N', '', '-f', file], { timeout: 10000, env: askpassEnv(passphraseFile) });
    if (open.code !== 0) throw new CredentialError('This key’s passphrase could not be removed.', 400, 'key-passphrase', { field: 'passphrase' });
    return { privateKey: await fs.readFile(file, 'utf8'), publicKey };
  }
  return { privateKey: text, publicKey };
});

/** The line to run on a server so this key can sign in. */
export const installCommand = publicKey => `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${String(publicKey).replace(/'/g, `'\\''`)}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
