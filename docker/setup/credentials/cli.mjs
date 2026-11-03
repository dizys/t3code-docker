// t3-vault: how agents and people use saved credentials from a shell. Its output
// is read by agents, so every failure says what to do next. No command prints a
// secret: whatever an agent prints ends up in its transcript.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createCredentialStore, credentialFailure, CredentialError } from '../credentials.mjs';
import { apiRequest, canTest, runWith, sshRequest } from './run.mjs';
import { callerThread } from './state.mjs';
import { detect } from './detect.mjs';
import { TYPES, publicTypes, primarySecret, isType, withDefaults } from './types.mjs';
import { installCommand } from './keys.mjs';
import { deliveredNames } from './deliver.mjs';
import { validId } from './errors.mjs';
import { validEnvName } from './model.mjs';
import { readSaved, resolvePublicUrl } from '../public-url.mjs';

const USAGE = `t3-vault uses saved credentials without putting their values in chats or commands.

  t3-vault list                             What's saved, and how to use each one
  t3-vault show NAME                        Details of one credential
  t3-vault run NAME... -- COMMAND [ARG...]  Run a command with those secrets in its environment
                                            NAME=VAR gives the main secret another variable name
  t3-vault ssh NAME [-- COMMAND [ARG...]]   Run a command on a saved SSH server
  t3-vault http NAME METHOD PATH [--stdin]  Call a saved API. --stdin sends a JSON body
  t3-vault add NAME [--type TYPE] [OPTIONS] Save a credential. See t3-vault types
  t3-vault replace NAME --secret-file FILE  Replace its secret. --stdin also works
  t3-vault test NAME                        Check that it still works
  t3-vault trust NAME [FINGERPRINT]         Review or confirm an SSH server's identity
  t3-vault use-key NAME                     Move a password sign-in to a new key
  t3-vault rm NAME --yes                    Delete it
  t3-vault types                            Every type and its options

Saved SSH servers also work with plain ssh, scp and git, such as: ssh NAME uptime
Secrets are hidden in the output of run, ssh and http. Manage everything in Setup → Vault.
`;

const ASK = `Ask the user with request_secret (delivery: "file"), and say in its reason that you'll save it.`;
const out = text => process.stdout.write(text + '\n');
const fail = (message, status = 400, code = 'invalid') => { throw new CredentialError(message, status, code); };
const kebab = key => key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());

const readOnlyStore = () => createCredentialStore({ readOnly: true });
const usageFor = () => createCredentialStore({ readOnly: true }).usage;
async function writeService() {
  const { createCredentialsService } = await import('./service.mjs');
  const store = createCredentialStore();
  return { store, service: createCredentialsService({ store, usage: { annotate: async credentials => ({ credentials }), invalidate() {} } }) };
}
const origin = () => {
  const threadId = callerThread();
  return threadId ? { by: 'agent', threadId } : { by: 'terminal' };
};

// ---- reading secrets ----------------------------------------------------------
// T3 Code's request_secret writes here. These are one-use, so they go once saved.
const isCardFile = file => /[\\/]secrets[\\/]files[\\/][0-9a-f]{32}$/.test(path.resolve(file));

async function readSecretFile(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) fail(`${file} isn't a regular file.`);
    if (stat.size > 48 * 1024) fail(`${file} is larger than the 48 KiB limit.`);
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    fail(`Couldn't read ${file}. ${error.code === 'ENOENT' ? `It may have expired. ${ASK}` : ''}`.trim());
  } finally { await handle?.close(); }
}
async function readStdin() {
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 48 * 1024) fail('The secret on stdin is larger than the 48 KiB limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
// For people at a terminal. The value is never echoed.
async function promptHidden(label) {
  const readline = await import('node:readline');
  process.stderr.write(label + ': ');
  const rl = readline.createInterface({ input: process.stdin, output: null, terminal: true });
  const answer = await new Promise(resolve => rl.question('', resolve));
  rl.close(); process.stderr.write('\n');
  return answer;
}

// ---- argument parsing -----------------------------------------------------------
function parseFlags(args) {
  const flags = new Map(), rest = [], vars = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) { rest.push(arg); continue; }
    // --var values hold their own = sign and may repeat.
    if (arg === '--var') { const value = args[++index]; if (value === undefined) fail('Use --var NAME=VALUE.'); vars.push(value); continue; }
    const equal = arg.indexOf('=');
    if (equal > 0) { flags.set(arg.slice(2, equal), arg.slice(equal + 1)); continue; }
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) flags.set(arg.slice(2), true);
    else { flags.set(arg.slice(2), next); index++; }
  }
  return { flags, rest, vars };
}
const stringFlag = (flags, name) => { const value = flags.get(name); if (value === true) fail(`--${name} needs a value.`); return value; };

// ---- what agents read -------------------------------------------------------------
// Plain ssh can't answer a password prompt, so only key sign-ins get the short form.
function howToUse(credential, sshAliases) {
  if (credential.type === 'ssh') return (sshAliases && credential.fields?.auth === 'key' ? [`ssh ${credential.id} <command>`] : []).concat(`t3-vault ssh ${credential.id} -- <command>`);
  const lines = [`t3-vault run ${credential.id} -- <command>`];
  if (credential.fields?.baseUrl) lines.push(`t3-vault http ${credential.id} GET ${credential.fields.testPath || '<path>'}`);
  return lines;
}
const describeTarget = credential => {
  const { fields = {} } = credential;
  if (credential.type === 'ssh') return `${fields.username}@${fields.host}${fields.port !== 22 ? ':' + fields.port : ''}, ${fields.auth === 'key' ? 'key' : 'password'}`;
  return credential.delivers?.join(', ') || TYPES[credential.type]?.label || '';
};
const sshState = credential => {
  if (credential.type !== 'ssh' || credential.hostKey) return '';
  return credential.fields.auth === 'password' ? ` (blocked: run t3-vault trust ${credential.id})` : ' (not connected yet: run t3-vault test ' + credential.id + ')';
};

async function list(args) {
  const { flags } = parseFlags(args);
  const { credentials, sshAliases } = await readOnlyStore().list();
  if (flags.has('json')) { out(JSON.stringify({ credentials: credentials.map(row => ({ name: row.id, type: row.type, description: row.description || undefined, gives: row.delivers, use: howToUse(row, sshAliases) })) }, null, 2)); return; }
  if (!credentials.length) {
    out(`The vault is empty.\n${ASK}\nThen save it: t3-vault add NAME --secret-file <file>`);
    return;
  }
  const rows = [...credentials].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const width = Math.max(...rows.map(row => row.id.length));
  for (const row of rows) {
    out(`${row.id.padEnd(width)}  ${TYPES[row.type].badge.padEnd(10)} ${describeTarget(row)}${sshState(row)}${row.description ? ' - ' + row.description : ''}`);
    out(`${' '.repeat(width)}  use: ${howToUse(row, sshAliases)[0]}`);
  }
}

async function show([name]) {
  if (!name) fail('Use t3-vault show NAME.');
  const store = readOnlyStore(), { credentials, sshAliases } = await store.list();
  const row = credentials.find(entry => entry.id === name);
  if (!row) throw notFound(name);
  const lines = [`${row.id} (${TYPES[row.type].label})`];
  if (row.description) lines.push(row.description);
  for (const [key, value] of Object.entries(row.fields || {})) if (value !== '' && key !== 'publicKey') lines.push(`  ${key}: ${value}`);
  if (row.delivers?.length) lines.push(`  gives commands: ${row.delivers.join(', ')}`);
  if (row.hostKey) lines.push(`  server's key: ${row.hostKey.type} ${row.hostKey.fingerprint}`);
  if (row.fields?.publicKey) lines.push(`  public key: ${row.fields.publicKey}`);
  if (row.test) lines.push(`  last test: ${row.test.ok ? 'passed' : row.test.code}`);
  lines.push('Use it with:', ...howToUse(row, sshAliases).map(line => '  ' + line));
  out(lines.join('\n'));
}

function notFound(name) {
  const stem = validId(name) ? name : 'NAME';
  return new CredentialError(`No saved credential named ${name}. Run t3-vault list to see what's saved.\n${ASK}\nThen save it: t3-vault add ${stem} --secret-file <file>`, 404, 'not-found');
}
const forUse = async (store, name) => {
  try { return await store.forUse(name); }
  catch (error) { if (error.code === 'not-found') throw notFound(name); throw error; }
};

async function run(args) {
  const split = args.indexOf('--');
  if (split < 1 || split === args.length - 1) fail('Use t3-vault run NAME... -- COMMAND [ARGUMENT...].');
  const store = readOnlyStore(), credentials = [];
  for (const token of args.slice(0, split)) {
    const [name, rename] = token.split('=');
    if (rename !== undefined && !validEnvName(rename)) fail(`${rename} can't be used as a variable name.`);
    credentials.push({ credential: await forUse(store, name), rename });
  }
  const command = args.slice(split + 1);
  const code = await runWith(credentials, command);
  await Promise.all(credentials.map(({ credential }) => store.usage.record(credential.id, { command: command[0] })));
  process.exitCode = code;
}

async function pinIfNew(name, credential) {
  if (credential.knownHostsFile || credential.fields.auth !== 'key') return credential;
  const { store, service } = await writeService();
  const pinned = await service.pinFirstUse(name);
  if (!pinned.ok) return credential;
  process.stderr.write(`First connection to ${name}. Pinned its key: ${pinned.hostKey.type} ${pinned.hostKey.fingerprint}\n`);
  return store.forUse(name);
}

async function ssh(args) {
  const [name, ...rest] = args;
  if (!name) fail('Use t3-vault ssh NAME -- COMMAND.');
  const command = rest[0] === '--' ? rest.slice(1) : rest;
  const store = readOnlyStore(), interactive = !command.length && process.stdin.isTTY && process.stdout.isTTY;
  if (!command.length && !interactive) fail(`Supply a command, such as t3-vault ssh ${name} -- uptime.`);
  const credential = await pinIfNew(name, await forUse(store, name));
  process.exitCode = await sshRequest(credential, command, { interactive });
  await store.usage.record(name, { command: 'ssh' });
}

async function http(args) {
  const { flags, rest } = parseFlags(args), [name, method, relative = ''] = rest;
  if (!name || !method || rest.length > 3 || [...flags.keys()].some(key => key !== 'stdin')) fail('Use t3-vault http NAME METHOD RELATIVE_PATH [--stdin].');
  let body;
  if (flags.has('stdin')) {
    if (['GET', 'HEAD'].includes(method)) fail('GET and HEAD requests cannot have a body.');
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 1024 * 1024) fail('The JSON request body exceeds 1 MiB.');
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString('utf8');
    try { JSON.parse(body); } catch { fail('Supply a valid JSON request body on stdin.'); }
  }
  const store = readOnlyStore(), credential = await forUse(store, name);
  process.exitCode = await apiRequest(credential, method, relative, { body });
  await store.usage.record(name, { command: 'http' });
}

// ---- saving -------------------------------------------------------------------------
const secretFlag = entry => entry.flag || kebab(entry.key) + '-file';

function typeOptions(id) {
  const spec = TYPES[id];
  if (spec.dynamic) return ['--var NAME=VALUE (not secret, repeatable)', '--secret-file FILE (NAME=value lines, all secret)'];
  const fields = spec.fields.filter(entry => entry.kind !== 'derived').map(entry => `--${kebab(entry.key)} ${entry.kind === 'select' ? entry.options.map(([value]) => value).join('|') : 'VALUE'}${entry.optional || entry.default !== undefined ? ' (optional)' : ''}`);
  const secrets = spec.secrets.map(entry => `--${secretFlag(entry)} FILE${entry.optional ? ' (optional)' : ''}`);
  return [...fields, ...secrets, ...(spec.secrets.some(entry => entry.editableEnv) ? ['--env VAR'] : [])];
}
function types() {
  for (const type of publicTypes()) {
    out(`${type.id}: ${type.label}`);
    for (const line of typeOptions(type.id)) out('  ' + line);
  }
  out(`\nFor any type, --secret-file FILE reads the main secret. Without --type, a recognized secret picks its own type.\nSSH also takes --generate-key, --passphrase-file FILE, --install-with-password-file FILE and --trust FINGERPRINT.`);
}

async function gatherSecret(flags, label) {
  const file = stringFlag(flags, 'secret-file');
  if (file !== undefined) return { text: await readSecretFile(file), file };
  if (flags.has('stdin')) return { text: await readStdin(), file: null };
  if (process.stdin.isTTY && label) return { text: await promptHidden(label), file: null };
  return { text: null, file: null };
}

async function add(args) {
  const { flags, rest, vars } = parseFlags(args), [name, extra] = rest;
  if (!name || extra !== undefined) fail('Use t3-vault add NAME [--type TYPE] [OPTIONS]. See t3-vault types.');
  if (!validId(name)) fail('Use up to 64 lowercase letters, numbers and single hyphens for the name, such as cloudflare-token.');
  const requested = stringFlag(flags, 'type');
  if (requested !== undefined && !isType(requested)) fail(`There's no type called ${requested}. See t3-vault types.`);
  const fromFiles = [], generating = flags.has('generate-key');
  const installFile = stringFlag(flags, 'install-with-password-file');
  const sshHinted = ['host', 'key-file', 'password-file'].some(flag => flags.has(flag)) || generating || installFile !== undefined;
  const needsPrompt = !generating && installFile === undefined && !flags.has('key-file') && !flags.has('password-file');
  const { text, file } = await gatherSecret(flags, needsPrompt && (requested || !sshHinted) ? `Secret for ${name}` : null);
  if (file) fromFiles.push(file);
  const detected = text ? detect(text) : null;
  const type = requested ?? (sshHinted ? 'ssh' : detected?.type ?? 'token');
  const spec = TYPES[type], usable = detected?.type === type ? detected : null;
  const fields = { ...usable?.fields }, secrets = { ...usable?.secrets }, env = { ...usable?.env };
  const consumed = new Set(['type', 'secret-file', 'stdin', 'description', 'env', 'generate-key', 'install-with-password-file', 'trust', 'passphrase-file']);

  for (const entry of spec.fields) {
    // --user is what anyone used to ssh will type.
    for (const flag of entry.key === 'username' ? ['username', 'user'] : [kebab(entry.key)]) {
      const value = stringFlag(flags, flag);
      if (value !== undefined) { fields[entry.key] = value; consumed.add(flag); }
    }
  }
  // A secret on the command line would land in the transcript and in `ps`.
  for (const entry of spec.secrets) {
    const flag = secretFlag(entry);
    if (flags.has(kebab(entry.key))) fail(`Secrets can't go on the command line, where the transcript keeps them. Use --${flag} FILE.`);
    const from = stringFlag(flags, flag);
    if (from !== undefined) { secrets[entry.key] = await readSecretFile(from); fromFiles.push(from); consumed.add(flag); }
  }
  if (type === 'ssh') {
    if (flags.has('key-file') || generating || installFile !== undefined) fields.auth = 'key';
    if (flags.has('password-file')) fields.auth = 'password';
  }
  const withDefault = withDefaults(type, fields), primary = primarySecret(type, withDefault);
  if (text && !usable) {
    if (!primary) fail(`${spec.label} takes NAME=value lines in its secret file.`);
    secrets[primary.key] = text;
  }
  if (flags.has('env')) {
    if (!primary?.editableEnv) fail(`${spec.label} uses fixed variable names, so --env doesn't apply.`);
    env[primary.key] = stringFlag(flags, 'env');
  }
  const unknown = [...flags.keys()].filter(flag => !consumed.has(flag));
  if (unknown.length) fail(`Unknown option --${unknown[0]} for ${spec.label}. See t3-vault types.`);

  if (spec.dynamic) {
    for (const pair of vars) { const at = pair.indexOf('='); if (at < 1) fail('Use --var NAME=VALUE.'); withDefault[pair.slice(0, at)] = pair.slice(at + 1); }
  } else if (vars.length) fail(`--var only applies to the custom type.`);
  const missingSecret = primary && !primary.optional && secrets[primary.key] === undefined && !generating && installFile === undefined;
  if (missingSecret) {
    // T3's card has a single-line box, which can't hold a multi-line file.
    if (primary.multiline && type !== 'ssh') fail(`This doesn't fit T3's single-line secret card. Ask the user to paste it here: ${setupForm(type, name)}\nThen check with t3-vault list.`);
    fail(`Nothing to save yet. ${ASK}\nThen run: t3-vault add ${name} --secret-file <file>${requested ? ' --type ' + requested : ''}`);
  }

  const passphraseFile = stringFlag(flags, 'passphrase-file');
  const passphrase = passphraseFile === undefined ? undefined : (await readSecretFile(passphraseFile)).replace(/\r?\n$/, '');
  if (passphraseFile) fromFiles.push(passphraseFile);
  const trust = stringFlag(flags, 'trust');
  const credential = { id: name, type, description: stringFlag(flags, 'description') ?? '', fields: withDefault, secrets, env };
  const { service, store } = await writeService();
  const input = { credential, generate: generating || installFile !== undefined || undefined, passphrase, ...(trust ? { trust: { fingerprint: trust } } : {}) };

  if (installFile !== undefined) {
    if (!trust) {
      const scanned = await scanTarget(service, withDefault);
      fail(`Before your password goes to ${withDefault.host}, confirm that server's identity.\n${scanned}\nShow the user this fingerprint. Once they confirm it, run this again with --trust FINGERPRINT.`, 409, 'host-key-untrusted');
    }
    const password = (await readSecretFile(installFile)).replace(/\r?\n$/, '');
    input.install = { password };
    fromFiles.push(installFile);
  }
  const saved = await service.save(input, { create: true, origin: origin() });
  await Promise.all(fromFiles.filter(isCardFile).map(item => fs.rm(item, { force: true }).catch(() => {})));
  // Whether the key already works decides what the next step is.
  if (saved.credential.type === 'ssh' && saved.credential.hostKey) {
    saved.signIn = await service.testInput({ id: name }).then(answer => answer.result, () => null);
    saved.credential = { ...saved.credential, hostKey: saved.credential.hostKey };
  }
  saved.sshAliases = (await store.list()).sshAliases;
  report(saved, fromFiles.some(isCardFile));
}

// A link when this server knows its own address, directions when it doesn't.
function setupForm(type, name) {
  const state = process.env.T3CODE_HOME || path.join(process.env.HOME || '/home/t3', '.t3');
  const { url } = resolvePublicUrl({ env: process.env, saved: readSaved(state) });
  return url ? `${url.replace(/\/$/, '')}/__setup/#vault/new/${type}/${name}` : `Setup → Vault → Add credential → ${TYPES[type].label}, with the name ${name}`;
}

async function scanTarget(service, fields) {
  const answer = await service.handle('/credentials/scan', { host: fields.host, port: Number(fields.port ?? 22) });
  if (answer.hostKey) return `Server's key: ${answer.hostKey.presented.type} ${answer.hostKey.presented.fingerprint}`;
  fail(`Couldn't reach ${fields.host}: ${answer.result?.code || 'no answer'}.`, 502, 'unreachable');
}

function report({ credential, trust, signIn, sshAliases = true }, deleted) {
  const { id, fields = {} } = credential, lines = [`Saved ${id}${deleted ? ' and deleted the file' : ''}.`];
  if (credential.type === 'ssh') {
    if (credential.hostKey) lines.push(`Server's key: ${credential.hostKey.type} ${credential.hostKey.fingerprint}${credential.hostKey.firstUse ? ' (pinned on first use)' : ''}`);
    else if (trust?.code && fields.auth === 'key') lines.push(`Couldn't reach ${fields.host} yet (${trust.code}). Its key gets pinned on the first connection.`);
    if (signIn?.ok) lines.push(`Signed in as ${fields.username}.`);
    else if (fields.auth === 'key' && fields.publicKey) lines.push('The server doesn\'t accept this key yet. Ask the user to run this on it, then run t3-vault test ' + id + ':', '  ' + installCommand(fields.publicKey));
    if (fields.auth === 'password' && !credential.hostKey) lines.push(`It can't be used until the server's identity is confirmed. Run t3-vault trust ${id}.`);
    lines.push(`Use it with: ${howToUse(credential, sshAliases)[0]}`);
  } else {
    if (credential.delivers?.length) lines.push(`Commands get: ${credential.delivers.join(', ')}`);
    lines.push(`Use it with: t3-vault run ${id} -- <command>`);
    if (fields.baseUrl) lines.push(`Or: t3-vault http ${id} GET ${fields.testPath || '<path>'}`);
  }
  out(lines.join('\n'));
}

async function replace(args) {
  const { flags, rest } = parseFlags(args), [name] = rest;
  if (!name) fail('Use t3-vault replace NAME --secret-file FILE.');
  const { store, service } = await writeService();
  let current;
  try { current = await store.public(name); } catch (error) { if (error.code === 'not-found') throw notFound(name); throw error; }
  const spec = TYPES[current.type], primary = primarySecret(current.type, current.fields);
  if (!primary) fail(`${spec.label} has more than one secret. Change it in Setup → Vault.`);
  if (flags.has('passphrase')) fail(`Secrets can't go on the command line, where the transcript keeps them. Use --passphrase-file FILE.`);
  const passphraseFile = stringFlag(flags, 'passphrase-file');
  const passphrase = passphraseFile === undefined ? undefined : (await readSecretFile(passphraseFile)).replace(/\r?\n$/, '');
  const { text, file } = await gatherSecret(flags, `New ${primary.label.toLowerCase()} for ${name}`);
  if (text === null) fail(`Nothing to replace it with. ${ASK}\nThen run: t3-vault replace ${name} --secret-file <file>`);
  const usable = detect(text);
  const secret = usable?.type === current.type && usable.secrets[primary.key] !== undefined ? usable.secrets[primary.key] : text;
  const saved = await service.save({ credential: { id: name, type: current.type, fields: current.fields, secrets: { [primary.key]: secret }, env: {} }, revision: current.revision, passphrase }, { create: false, origin: origin() });
  const deleted = file && isCardFile(file);
  if (deleted) await fs.rm(file, { force: true }).catch(() => {});
  if (passphraseFile && isCardFile(passphraseFile)) await fs.rm(passphraseFile, { force: true }).catch(() => {});
  report(saved, deleted);
}

const FAILURES = {
  'auth-rejected': 'The server rejected the sign-in. If the key isn\'t on the server yet, run t3-vault show NAME and add it. Otherwise replace the secret.',
  rejected: 'The service rejected the secret. Ask the user for a new one and run t3-vault replace NAME.',
  'host-key-changed': 'The server presented a different key. Don\'t connect until the user has checked it: run t3-vault trust NAME.',
  'host-key-untrusted': 'The server\'s identity isn\'t confirmed yet. Run t3-vault trust NAME.',
  unreachable: 'The server couldn\'t be reached.',
  timeout: 'The server took too long to respond.',
  certificate: 'The server\'s certificate couldn\'t be verified.',
  redirect: 'The service redirected the request. Save its final address instead.',
  'not-found': 'The test path wasn\'t found. Check the API address.',
  'http-error': 'The service returned an error.',
  'scan-failed': 'The server\'s key couldn\'t be read.',
};

async function testCommand([name]) {
  if (!name) fail('Use t3-vault test NAME.');
  const { store, service } = await writeService();
  let credential;
  try { credential = await store.public(name); } catch (error) { if (error.code === 'not-found') throw notFound(name); throw error; }
  if (!canTest(credential)) { out(`${name} has no test set up. To check it, run a real command with t3-vault run ${name} -- <command>.`); return; }
  const { result } = await service.testInput({ id: name });
  if (result.ok) { out(`${name} works.${result.hostKey?.presented ? ` Pinned the server's key: ${result.hostKey.presented.type} ${result.hostKey.presented.fingerprint}` : ''}`); return; }
  process.exitCode = 1;
  out(`${name} failed: ${(FAILURES[result.code] || result.detail?.line || 'The test failed.').replaceAll('NAME', name)}`);
  if (result.detail?.status) out(`HTTP ${result.detail.status}`);
  if (result.detail?.presented) out(`Server's key now: ${result.detail.presented.type} ${result.detail.presented.fingerprint}`);
}

const keyCheck = type => `ssh-keygen -lf /etc/ssh/ssh_host_${type === 'ssh-rsa' ? 'rsa' : type?.startsWith('ecdsa') ? 'ecdsa' : 'ed25519'}_key.pub`;

async function trust([name, fingerprint]) {
  if (!name) fail('Use t3-vault trust NAME [FINGERPRINT].');
  const { store, service } = await writeService();
  let credential;
  try { credential = await store.public(name); } catch (error) { if (error.code === 'not-found') throw notFound(name); throw error; }
  if (credential.type !== 'ssh') fail(`${name} isn't an SSH credential.`);
  if (!fingerprint) {
    const scanned = await service.scan(name);
    if (!scanned.ok) fail(`Couldn't reach ${credential.fields.host}: ${scanned.code}.`, 502, 'unreachable');
    if (scanned.hostKey.state === 'trusted') { out(`${name} is already trusted: ${scanned.hostKey.presented.type} ${scanned.hostKey.presented.fingerprint}`); return; }
    out(`${scanned.hostKey.state === 'changed' ? `Warning: this is different from the key saved for ${name}. Only accept it if the server was reinstalled.\nSaved key:   ${scanned.hostKey.trusted.type} ${scanned.hostKey.trusted.fingerprint}\n` : ''}Server's key: ${scanned.hostKey.presented.type} ${scanned.hostKey.presented.fingerprint}\nThe user can check it on the server with: ${keyCheck(scanned.hostKey.presented.type)}\nShow them this fingerprint. Once they confirm it, run: t3-vault trust ${name} ${scanned.hostKey.presented.fingerprint}`);
    return;
  }
  const answer = await service.trust(name, fingerprint, credential.revision);
  if (!answer.ok) fail(`Couldn't reach ${credential.fields.host}: ${answer.code}.`, 502, 'unreachable');
  out(`Trusted ${name}: ${answer.hostKey.type} ${answer.hostKey.fingerprint}`);
}

async function useKey([name]) {
  if (!name) fail('Use t3-vault use-key NAME.');
  const { service } = await writeService();
  try {
    await service.installKey({ id: name }, { origin: origin() });
    const { sshAliases } = await readOnlyStore().list();
    out(`${name} now signs in with a new key, and its password has been deleted.\nUse it with: ${sshAliases ? `ssh ${name} <command>` : `t3-vault ssh ${name} -- <command>`}`);
  } catch (error) { if (error.code === 'not-found') throw notFound(name); throw error; }
}

async function remove(args) {
  const { flags, rest } = parseFlags(args), [name] = rest;
  if (!name) fail('Use t3-vault rm NAME --yes.');
  if (!flags.has('yes')) fail(`This erases ${name} from the vault and can't be undone. Only do this if the user asked. Add --yes to confirm.`);
  const { store } = await writeService();
  let current;
  try { current = await store.public(name); } catch (error) { if (error.code === 'not-found') throw notFound(name); throw error; }
  await store.remove({ id: name, revision: current.revision });
  out(`Deleted ${name}. This doesn't revoke it at the service.`);
}

const COMMANDS = { list, ls: list, show, run, ssh, http, add, replace, test: testCommand, trust, 'use-key': useKey, rm: remove, types };

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command)) { process.stdout.write(USAGE); return; }
  const action = COMMANDS[command];
  if (!action) fail(`There's no t3-vault command called ${command}. Run t3-vault --help.`);
  await action(args);
}

main().catch(error => {
  const failure = credentialFailure(error);
  process.stderr.write(failure.body.error + '\n');
  process.exitCode = failure.status === 127 ? 127 : failure.status === 126 ? 126 : 1;
}).finally(() => {
  // A pending key scan or stdin shouldn't hold the process open once it's done.
  if (process.exitCode === undefined) process.exitCode = 0;
});
