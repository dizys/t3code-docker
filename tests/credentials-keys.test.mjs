// Real OpenSSH with throwaway keys made in a temporary folder.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rebuildPrivateKey, openPrivateKey, generateKey, installCommand } from '../docker/setup/credentials/keys.mjs';

const KEYGEN = '/usr/bin/ssh-keygen', run = promisify(execFile);
const passphrase = 'fixture-key-passphrase';
async function folder(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-vault-keys-test-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
/** Makes a key with ssh-keygen itself, the way a person would have one. */
async function makeKey(root, { type = 'ed25519', phrase = '', format } = {}) {
  const file = path.join(root, 'made-' + Math.random().toString(16).slice(2));
  await run(KEYGEN, ['-q', '-t', type, '-N', phrase, '-C', 'fixture', ...(format ? ['-m', format] : []), '-f', file]);
  return { file, privateKey: await fs.readFile(file, 'utf8'), publicKey: (await fs.readFile(file + '.pub', 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ') };
}
const publicOf = async (root, text, phrase = '') => {
  const file = path.join(root, 'check-' + Math.random().toString(16).slice(2));
  await fs.writeFile(file, text, { mode: 0o600, flag: 'wx' });
  const { stdout } = await run(KEYGEN, ['-y', '-P', phrase, '-f', file]);
  return stdout.trim().split(/\s+/).slice(0, 2).join(' ');
};
const flatten = text => text.replace(/\r?\n/g, '');

test('a key whose line breaks were removed rebuilds into one OpenSSH derives the same public key from', async t => {
  const root = await folder(t), made = await makeKey(root);
  for (const [name, pasted] of [['no breaks', flatten(made.privateKey)], ['spaces for breaks', made.privateKey.replace(/\n/g, ' ')], ['Windows line ends', made.privateKey.replace(/\n/g, '\r\n')]]) {
    const rebuilt = rebuildPrivateKey(pasted);
    assert.ok(rebuilt, name);
    assert.equal(await publicOf(root, rebuilt), made.publicKey, name);
    assert.equal(rebuilt, made.privateKey, name + ' gives back the file ssh-keygen wrote');
  }
});

test('other key formats rebuild too', async t => {
  const root = await folder(t);
  for (const [type, format] of [['rsa', 'PEM'], ['rsa', 'PKCS8'], ['ecdsa', 'PEM']]) {
    const made = await makeKey(root, { type, format });
    assert.equal(await publicOf(root, rebuildPrivateKey(flatten(made.privateKey))), made.publicKey, type + ' ' + format);
  }
});

test('an old-style encrypted key keeps its header lines, which can\'t be rebuilt', async t => {
  const root = await folder(t), made = await makeKey(root, { type: 'rsa', format: 'PEM', phrase: passphrase });
  assert.match(made.privateKey, /Proc-Type:/);
  assert.equal(rebuildPrivateKey(made.privateKey), made.privateKey);
  assert.equal(rebuildPrivateKey(made.privateKey.replace(/\n/g, '\r\n')), made.privateKey, 'Windows line ends are still fine');
  assert.equal(rebuildPrivateKey(flatten(made.privateKey)), null, 'flattening one loses it for good');
});

test('things that aren\'t keys don\'t rebuild', () => {
  for (const value of ['', 'just text', 'ssh-ed25519 AAAA fixture', '-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----', ['-----BEGIN', 'OPENSSH PRIVATE KEY-----', 'not base64!!!', '-----END', 'OPENSSH PRIVATE KEY-----'].join(' '), ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ')]) {
    assert.equal(rebuildPrivateKey(value), null, value);
  }
});

test('a generated key is a working ed25519 pair with the comment asked for, and leaves nothing behind', async t => {
  const root = await folder(t), { execute } = await import('../docker/setup/credentials/hostkeys.mjs'); let directory;
  const made = await generateKey('t3-vault:fixture', { run: (program, args, options) => { directory = path.dirname(args.at(-1)); return execute(program, args, options); } });
  assert.match(made.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
  assert.match(made.publicKey, /^ssh-ed25519 \S+ t3-vault:fixture$/);
  assert.equal(await publicOf(root, made.privateKey), made.publicKey.split(' ').slice(0, 2).join(' '), 'needs no passphrase and matches its public half');
  const other = await generateKey('t3-vault:fixture');
  assert.notEqual(other.privateKey, made.privateKey);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('a key that doesn\'t need a passphrase opens as it is, with a public half and the comment asked for', async t => {
  const root = await folder(t), made = await makeKey(root);
  const opened = await openPrivateKey(made.privateKey, { comment: 't3-vault:fixture' });
  assert.equal(opened.privateKey, made.privateKey);
  assert.equal(opened.publicKey, made.publicKey + ' t3-vault:fixture');
  assert.equal((await openPrivateKey(flatten(made.privateKey))).privateKey, made.privateKey, 'a flattened paste opens too');
  assert.equal((await openPrivateKey(made.privateKey)).publicKey, made.publicKey, 'no comment, none added');
});

test('a key with a passphrase opens with it, and the result no longer needs one', async t => {
  const root = await folder(t), made = await makeKey(root, { phrase: passphrase });
  await assert.rejects(publicOf(root, made.privateKey), 'the fixture really is encrypted');
  const opened = await openPrivateKey(made.privateKey, { passphrase, comment: 't3-vault:fixture' });
  assert.notEqual(opened.privateKey, made.privateKey);
  assert.equal(await publicOf(root, opened.privateKey), made.publicKey, 'passphrase removed');
  assert.equal(opened.publicKey, made.publicKey + ' t3-vault:fixture');
  assert.equal(opened.privateKey.includes(passphrase), false);
  assert.equal((await openPrivateKey(flatten(made.privateKey), { passphrase })).publicKey, made.publicKey, 'a flattened encrypted key opens too');
});

test('a passphrase on an unencrypted key does no harm', async t => {
  const root = await folder(t), made = await makeKey(root);
  const opened = await openPrivateKey(made.privateKey, { passphrase: 'fixture-not-needed' });
  assert.equal(await publicOf(root, opened.privateKey), made.publicKey);
});

test('the wrong passphrase, or none, is asked about on the passphrase field', async t => {
  const root = await folder(t), made = await makeKey(root, { phrase: passphrase });
  await assert.rejects(openPrivateKey(made.privateKey, { passphrase: 'fixture-wrong-passphrase' }), error => {
    assert.equal(error.code, 'key-passphrase'); assert.equal(error.status, 400); assert.equal(error.extra.field, 'passphrase');
    assert.match(error.message, /passphrase didn’t open/);
    assert.equal(error.message.includes('fixture-wrong-passphrase'), false);
    return true;
  });
  await assert.rejects(openPrivateKey(made.privateKey), error => error.code === 'key-passphrase' && /needs its passphrase/.test(error.message) && error.extra.field === 'passphrase');
});

test('text that isn\'t a key is refused on the key field, before OpenSSH is asked', async () => {
  let ran = 0;
  for (const value of ['', 'fixture text that is not a key', 'ssh-ed25519 AAAA fixture']) {
    await assert.rejects(openPrivateKey(value, { run: async () => { ran++; return { code: 0, stdout: '' }; } }), error => error.code === 'key-invalid' && error.status === 400 && error.extra.field === 'privateKey' && !error.message.includes(value || '\0'));
  }
  assert.equal(ran, 0);
  const garbled = [['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '), 'Zml4dHVyZS1ub3QtYS1yZWFsLWtleQ==', ['-----END', 'OPENSSH PRIVATE KEY-----'].join(' ')].join('\n');
  await assert.rejects(openPrivateKey(garbled), { code: 'key-passphrase' }, 'well formed but not a key: OpenSSH cannot tell that from a missing passphrase');
});

test('a key that OpenSSH can\'t generate is an error, and the temporary folder still goes', async () => {
  let directory;
  await assert.rejects(generateKey('fixture', { run: async (_program, args) => { directory = path.dirname(args.at(-1)); return { code: 1, stdout: '' }; } }), { status: 500, code: 'key-failed' });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('the temporary key file is private while OpenSSH reads it, and gone afterwards', async t => {
  const root = await folder(t), made = await makeKey(root); let seen;
  const { execute } = await import('../docker/setup/credentials/hostkeys.mjs');
  await openPrivateKey(made.privateKey, { run: async (program, args, options) => {
    const file = args[args.indexOf('-f') + 1];
    seen = { file, mode: (await fs.stat(file)).mode & 0o777, folder: (await fs.stat(path.dirname(file))).mode & 0o777 };
    return execute(program, args, options);
  } });
  assert.deepEqual([seen.mode, seen.folder], [0o600, 0o700]);
  await assert.rejects(fs.stat(path.dirname(seen.file)), { code: 'ENOENT' });
});

test('the install line appends the key with owner-only permissions', () => {
  const line = installCommand('ssh-ed25519 AAAAfixture t3-vault:fixture');
  assert.equal(line, "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAAAfixture t3-vault:fixture' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys");
});
