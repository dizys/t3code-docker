// t3-vault as agents and people run it: a real subprocess, with a home of its
// own. It gets a clean environment rather than this one, so a thread id or a real
// T3CODE_HOME around the test can't change what it does or where it writes.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createCredentialStore } from '../docker/setup/credentials.mjs';

const CLI = fileURLToPath(new URL('../docker/setup/credentials/cli.mjs', import.meta.url));
const secret = 'fixture-cli-secret-value-123';
const NODE = process.execPath;

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-vault-cli-')), home = path.join(root, 'home'), t3 = path.join(home, '.t3'), files = path.join(root, 'files');
  await fs.mkdir(home, { recursive: true }); await fs.mkdir(files, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const baseEnv = { PATH: process.env.PATH, HOME: home, T3CODE_HOME: t3 };
  const cli = (args, { env = {}, input } = {}) => new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args], { env: { ...baseEnv, ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.once('error', reject);
    child.once('close', code => resolve({ code, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString(), bytes: Buffer.concat(out) }));
    if (input !== undefined) child.stdin.end(input);
  });
  let count = 0;
  const file = async (text, name = 'secret-' + ++count) => { const target = path.join(files, name); await fs.writeFile(target, text, { mode: 0o600 }); return target; };
  /** A file where T3 Code's request_secret leaves one. */
  const card = async (text, name = '0123456789abcdef0123456789abcdef') => { const folder = path.join(home, 'secrets/files'); await fs.mkdir(folder, { recursive: true, mode: 0o700 }); const target = path.join(folder, name); await fs.writeFile(target, text, { mode: 0o600 }); return target; };
  const directory = path.join(t3, 'server-credentials');
  const rows = async () => JSON.parse(await fs.readFile(path.join(directory, 'credentials.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{"credentials":[]}'; throw error; })).credentials;
  const row = async id => (await rows()).find(entry => entry.id === id);
  const saved = async () => createCredentialStore({ directory, home, readOnly: true });
  return { root, home, directory, cli, file, card, rows, row, saved };
}
const ok = answer => { assert.equal(answer.code, 0, answer.err); return answer; };
const never = (answer, value = secret) => { assert.equal((answer.out + answer.err).includes(value), false, 'the secret was printed'); return answer; };
const ask = /request_secret/;
const compare = (name, value) => `process.stdout.write(process.env.${name} === ${JSON.stringify(value)} ? 'matched' : 'different')`;
/** A port with nothing listening on it. */
async function closedPort() {
  const server = createNetServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address(); await new Promise(resolve => server.close(resolve));
  return port;
}
async function apiServer(t, respond) {
  const server = createServer(respond).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port + '/';
}

test('add from a secret file, then run, list and show, and no output ever holds the secret', async t => {
  const s = await sandbox(t), source = await s.file(secret + '\n');
  const added = never(ok(await s.cli(['add', 'demo-token', '--secret-file', source, '--env', 'DEMO_TOKEN', '--description', 'A fixture'])));
  assert.match(added.out, /^Saved demo-token\.$/m); assert.match(added.out, /Commands get: DEMO_TOKEN/); assert.match(added.out, /t3-vault run demo-token -- <command>/);
  assert.equal(await fs.readFile(source, 'utf8'), secret + '\n', 'a file that isn\'t T3\'s one-use card is kept');
  const stored = await s.row('demo-token');
  assert.deepEqual(stored.secrets, { token: secret }, 'the line break at the end of the file isn\'t part of it');
  assert.equal(stored.description, 'A fixture'); assert.deepEqual(stored.env, { token: 'DEMO_TOKEN' });
  assert.equal(ok(await s.cli(['run', 'demo-token', '--', NODE, '-e', compare('DEMO_TOKEN', secret)])).out, 'matched');
  const echoed = never(ok(await s.cli(['run', 'demo-token', '--', NODE, '-e', 'process.stdout.write(process.env.DEMO_TOKEN); process.stderr.write(process.env.DEMO_TOKEN);'])));
  assert.equal(echoed.out, '[redacted]'); assert.equal(echoed.err, '[redacted]');
  const listed = never(ok(await s.cli(['list'])));
  assert.match(listed.out, /^demo-token\s+Token\s+DEMO_TOKEN - A fixture$/m); assert.match(listed.out, /use: t3-vault run demo-token -- <command>/);
  never(ok(await s.cli(['ls'])));
  const json = JSON.parse(never(ok(await s.cli(['list', '--json']))).out);
  assert.deepEqual(json.credentials, [{ name: 'demo-token', type: 'token', description: 'A fixture', gives: ['DEMO_TOKEN'], use: ['t3-vault run demo-token -- <command>'] }]);
  const shown = never(ok(await s.cli(['show', 'demo-token'])));
  assert.match(shown.out, /^demo-token \(API token\)$/m); assert.match(shown.out, /gives commands: DEMO_TOKEN/); assert.match(shown.out, /t3-vault run demo-token -- <command>/);
  const usage = await (await s.saved()).usage.read('demo-token');
  assert.equal(usage.count, 2); assert.equal(usage.command, path.basename(NODE), 'the command\'s name, never its arguments');
});

test('an empty vault says what to do next', async t => {
  const s = await sandbox(t), listed = ok(await s.cli(['list']));
  assert.match(listed.out, /The vault is empty/); assert.match(listed.out, ask); assert.match(listed.out, /t3-vault add NAME --secret-file/);
  assert.deepEqual(JSON.parse(ok(await s.cli(['list', '--json'])).out), { credentials: [] });
  await assert.rejects(fs.stat(s.directory), { code: 'ENOENT' }, 'reading creates nothing');
});

test('origin records who added it: an agent\'s thread, or a terminal', async t => {
  const s = await sandbox(t);
  ok(await s.cli(['add', 'from-agent', '--secret-file', await s.file(secret)], { env: { T3CODE_THREAD_ID: 'thread-fixture-1' } }));
  assert.deepEqual((await s.row('from-agent')).origin, { by: 'agent', threadId: 'thread-fixture-1' });
  ok(await s.cli(['add', 'from-terminal', '--secret-file', await s.file(secret)]));
  assert.deepEqual((await s.row('from-terminal')).origin, { by: 'terminal' });
  ok(await s.cli(['add', 'odd-thread', '--secret-file', await s.file(secret)], { env: { T3CODE_THREAD_ID: 'not a valid id' } }));
  assert.deepEqual((await s.row('odd-thread')).origin, { by: 'terminal' }, 'a value that can\'t be a thread id isn\'t believed');
  ok(await s.cli(['replace', 'from-terminal', '--secret-file', await s.file(secret + '-new')], { env: { T3CODE_THREAD_ID: 'thread-fixture-2' } }));
  const changed = await s.row('from-terminal');
  assert.deepEqual(changed.origin, { by: 'terminal' }); assert.deepEqual(changed.changedBy, { by: 'agent', threadId: 'thread-fixture-2' });
  ok(await s.cli(['run', 'from-agent', '--', NODE, '-e', ''], { env: { T3CODE_THREAD_ID: 'thread-fixture-3' } }));
  assert.equal((await (await s.saved()).usage.read('from-agent')).threadId, 'thread-fixture-3');
});

test('a secret on the command line is refused, and nothing is saved', async t => {
  const s = await sandbox(t);
  for (const args of [['--token', secret], ['--token=' + secret], ['--type', 'token', '--token', secret], ['--type', 'login', '--username', 'me', '--password', secret], ['--type', 'ssh', '--host', 'example.test', '--user', 'me', '--password', secret], ['--type', 'ssh', '--host', 'example.test', '--user', 'me', '--private-key', secret], ['--type', 'aws', '--access-key-id', 'AKIAFIXTURE', '--secret-access-key', secret], ['--type', 'kubernetes', '--kubeconfig', secret]]) {
    const refused = never(await s.cli(['add', 'refused', ...args]));
    assert.equal(refused.code, 1, args.join(' '));
    assert.match(refused.err, /can't go on the command line/, args.join(' '));
    assert.match(refused.err, /FILE/, 'and it says what to use instead');
  }
  assert.equal(ok(await s.cli(['list', '--json'])).out.includes('refused'), false);
  // An option no type knows, which a secret might be sitting in, is refused too.
  const unknown = never(await s.cli(['add', 'refused', '--secret', secret]));
  assert.equal(unknown.code, 1); assert.match(unknown.err, /Unknown option --secret/);
});

test('every command that names a missing credential says how to get it', async t => {
  const s = await sandbox(t);
  for (const args of [['show', 'nothing'], ['run', 'nothing', '--', NODE, '-e', ''], ['ssh', 'nothing', '--', 'true'], ['http', 'nothing', 'GET', 'x'], ['replace', 'nothing', '--secret-file', await s.file(secret)], ['test', 'nothing'], ['trust', 'nothing'], ['use-key', 'nothing'], ['rm', 'nothing', '--yes']]) {
    const answer = await s.cli(args);
    assert.equal(answer.code, 1, args.join(' '));
    assert.match(answer.err, /No saved credential named nothing/, args.join(' '));
    assert.match(answer.err, ask, args.join(' '));
    assert.match(answer.err, /t3-vault add nothing --secret-file/, args.join(' '));
  }
});

test('having nothing to save, or a file that has expired, also says how to get it', async t => {
  const s = await sandbox(t);
  const nothing = await s.cli(['add', 'demo']);
  assert.equal(nothing.code, 1); assert.match(nothing.err, /Nothing to save yet/); assert.match(nothing.err, ask);
  const expired = await s.cli(['add', 'demo', '--secret-file', path.join(s.root, 'gone')]);
  assert.equal(expired.code, 1); assert.match(expired.err, /may have expired/); assert.match(expired.err, ask);
  const folder = await s.cli(['add', 'demo', '--secret-file', s.root]);
  assert.equal(folder.code, 1); assert.match(folder.err, /isn't a regular file/);
  const big = await s.cli(['add', 'demo', '--secret-file', await s.file('x'.repeat(48 * 1024 + 1))]);
  assert.equal(big.code, 1); assert.match(big.err, /48 KiB/);
  assert.deepEqual(JSON.parse(ok(await s.cli(['list', '--json'])).out).credentials, []);
});

test('T3\'s one-use card file is deleted once saved, and any other file is kept', async t => {
  const s = await sandbox(t);
  const card = await s.card(secret + '\n');
  const added = never(ok(await s.cli(['add', 'from-card', '--secret-file', card])));
  assert.match(added.out, /Saved from-card and deleted the file\./);
  await assert.rejects(fs.stat(card), { code: 'ENOENT' });
  assert.equal((await s.row('from-card')).secrets.token, secret);
  const kept = await s.file(secret + '\n');
  assert.doesNotMatch(ok(await s.cli(['add', 'from-file', '--secret-file', kept])).out, /deleted/);
  assert.equal(await fs.readFile(kept, 'utf8'), secret + '\n');
  // Nearly the right place or nearly the right name isn't T3's file.
  const folder = path.join(s.home, 'secrets/files');
  for (const name of ['0123456789ABCDEF0123456789ABCDEF', '0123456789abcdef', '0123456789abcdef0123456789abcdef0', 'notes.txt']) {
    const other = path.join(folder, name); await fs.writeFile(other, secret, { mode: 0o600 });
    ok(await s.cli(['add', 'near-' + name.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x') + '-' + name.length, '--secret-file', other]));
    assert.equal(await fs.readFile(other, 'utf8'), secret, name);
  }
  const elsewhere = path.join(s.home, 'files', '0123456789abcdef0123456789abcdef'); await fs.mkdir(path.dirname(elsewhere));
  await fs.writeFile(elsewhere, secret, { mode: 0o600 });
  ok(await s.cli(['add', 'elsewhere', '--secret-file', elsewhere]));
  assert.equal(await fs.readFile(elsewhere, 'utf8'), secret);
});

test('a card file stays when the save fails, so the user isn\'t asked again', async t => {
  const s = await sandbox(t), card = await s.card(secret);
  ok(await s.cli(['add', 'taken', '--secret-file', await s.file(secret)]));
  const refused = await s.cli(['add', 'taken', '--secret-file', card]);
  assert.equal(refused.code, 1); assert.match(refused.err, /already saved/);
  assert.equal(await fs.readFile(card, 'utf8'), secret);
  assert.equal((await s.cli(['add', 'Bad Name', '--secret-file', card])).code, 1);
  assert.equal(await fs.readFile(card, 'utf8'), secret);
});

test('replace changes only the secret, and takes it from a file or stdin', async t => {
  const s = await sandbox(t);
  ok(await s.cli(['add', 'demo', '--secret-file', await s.file(secret), '--env', 'DEMO_TOKEN', '--description', 'Kept']));
  const before = await s.row('demo'), next = secret + '-replaced';
  const answer = never(never(ok(await s.cli(['replace', 'demo', '--secret-file', await s.file(next + '\n')]))), next);
  assert.match(answer.out, /^Saved demo\.$/m);
  const after = await s.row('demo');
  assert.equal(after.secrets.token, next); assert.deepEqual(after.env, before.env); assert.equal(after.description, 'Kept');
  assert.notEqual(after.revision, before.revision); assert.equal(after.createdAt, before.createdAt); assert.notEqual(after.secretChangedAt, before.secretChangedAt);
  assert.equal(ok(await s.cli(['run', 'demo', '--', NODE, '-e', compare('DEMO_TOKEN', next)])).out, 'matched');
  const card = await s.card(secret + '-card\n');
  assert.match(ok(await s.cli(['replace', 'demo', '--secret-file', card])).out, /deleted the file/);
  await assert.rejects(fs.stat(card), { code: 'ENOENT' });
  ok(await s.cli(['replace', 'demo', '--stdin'], { input: secret + '-stdin\n' }));
  assert.equal((await s.row('demo')).secrets.token, secret + '-stdin');
  const empty = await s.cli(['replace', 'demo']);
  assert.equal(empty.code, 1); assert.match(empty.err, ask);
  assert.equal((await s.row('demo')).secrets.token, secret + '-stdin', 'a failed replace changes nothing');
  ok(await s.cli(['add', 'many', '--type', 'custom', '--var', 'A=1']));
  assert.match((await s.cli(['replace', 'many', '--secret-file', await s.file(secret)])).err, /more than one secret/);
});

test('replacing a recognized value of the same type unwraps it, instead of saving the wrapper', async t => {
  const s = await sandbox(t);
  ok(await s.cli(['add', 'app-db', '--secret-file', await s.file('postgres://app:fixture%40first@db.example.test/app')]));
  assert.equal((await s.row('app-db')).type, 'database');
  ok(await s.cli(['replace', 'app-db', '--secret-file', await s.file('postgres://app:fixture%40second@db.example.test/app')]));
  assert.equal((await s.row('app-db')).secrets.password, 'fixture@second');
  ok(await s.cli(['replace', 'app-db', '--secret-file', await s.file('fixture-plain-password')]));
  assert.equal((await s.row('app-db')).secrets.password, 'fixture-plain-password');
});

test('a passphrase never goes on the command line for replace either, and a file works', async t => {
  const s = await sandbox(t), port = await closedPort(), passphrase = 'fixture-key-passphrase', keyFile = path.join(s.root, 'made-key');
  ok(await s.cli(['add', 'box', '--host', '127.0.0.1', '--port', String(port), '--user', 'deploy', '--generate-key']));
  const before = await s.row('box');
  assert.equal(spawnSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'fixture', '-f', keyFile]).status, 0);
  const refused = never(await s.cli(['replace', 'box', '--secret-file', keyFile, '--passphrase', passphrase]), passphrase);
  assert.equal(refused.code, 1); assert.match(refused.err, /can't go on the command line/); assert.match(refused.err, /--passphrase-file/);
  assert.equal((await s.row('box')).revision, before.revision);
  const card = await s.card(passphrase + '\n');
  never(ok(await s.cli(['replace', 'box', '--secret-file', keyFile, '--passphrase-file', card])), passphrase);
  await assert.rejects(fs.stat(card), { code: 'ENOENT' }, 'T3\'s one-use file goes once it\'s been used');
  const after = await s.row('box');
  assert.notEqual(after.fields.publicKey, before.fields.publicKey);
  assert.equal(after.fields.publicKey.split(' ')[1], (await fs.readFile(keyFile + '.pub', 'utf8')).split(' ')[1]);
  assert.equal(spawnSync('/usr/bin/ssh-keygen', ['-y', '-P', '', '-f', path.join(s.directory, 'keys/box')]).status, 0, 'and the saved key needs no passphrase');
});

test('rm needs --yes, and says what it doesn\'t do', async t => {
  const s = await sandbox(t);
  ok(await s.cli(['add', 'demo', '--secret-file', await s.file(secret)]));
  const refused = await s.cli(['rm', 'demo']);
  assert.equal(refused.code, 1); assert.match(refused.err, /--yes/); assert.match(refused.err, /Only do this if the user asked/);
  assert.ok(await s.row('demo'), 'still there');
  const removed = ok(await s.cli(['rm', 'demo', '--yes']));
  assert.match(removed.out, /Deleted demo/); assert.match(removed.out, /doesn't revoke it/);
  assert.equal(await s.row('demo'), undefined);
  assert.equal((await fs.readFile(path.join(s.directory, 'credentials.json'), 'utf8')).includes(secret), false, 'the value is gone from the store');
});

test('--var repeats for the custom type, holds its own = signs, and isn\'t secret', async t => {
  const s = await sandbox(t);
  const added = ok(await s.cli(['add', 'settings', '--type', 'custom', '--var', 'REGION=eu-west-1', '--var', 'FLAGS=a=1,b=2', '--var', 'EMPTY_OK=x']));
  assert.match(added.out, /Commands get: REGION, FLAGS, EMPTY_OK/);
  const stored = await s.row('settings');
  assert.deepEqual(stored.fields, { REGION: 'eu-west-1', FLAGS: 'a=1,b=2', EMPTY_OK: 'x' }); assert.deepEqual(stored.secrets, {});
  assert.equal(ok(await s.cli(['run', 'settings', '--', NODE, '-e', 'process.stdout.write(process.env.REGION + " " + process.env.FLAGS)'])).out, 'eu-west-1 a=1,b=2', 'not secret, so not hidden');
  // Alongside secrets from a file.
  ok(await s.cli(['add', 'mixed', '--type', 'custom', '--var', 'REGION=eu', '--secret-file', await s.file(`API_KEY=${secret}\nOTHER=fixture-other\n`)]));
  const mixed = await s.row('mixed');
  assert.deepEqual([mixed.fields, mixed.secrets], [{ REGION: 'eu' }, { API_KEY: secret, OTHER: 'fixture-other' }]);
  for (const [args, message] of [[['--type', 'custom', '--var', 'NO_EQUALS'], /--var NAME=VALUE/], [['--type', 'custom', '--var', '=x'], /--var NAME=VALUE/], [['--type', 'custom', '--var'], /--var NAME=VALUE/], [['--type', 'custom', '--var', 'PATH=/tmp'], /can't be used as a variable name/], [['--type', 'token', '--var', 'A=1', '--secret-file', await s.file(secret)], /only applies to the custom type/], [['--type', 'custom'], /at least one variable/]]) {
    const refused = await s.cli(['add', 'refused', ...args]);
    assert.equal(refused.code, 1, args.join(' ')); assert.match(refused.err, message, args.join(' '));
  }
  assert.equal(await s.row('refused'), undefined);
});

test('a .env file becomes a custom credential whose values are all secret', async t => {
  const s = await sandbox(t), card = await s.card(`# a fixture\nexport API_KEY=${secret}\nOTHER_VALUE="fixture other value"\n`);
  const added = never(ok(await s.cli(['add', 'app-env', '--secret-file', card])));
  assert.match(added.out, /Commands get: API_KEY, OTHER_VALUE/); assert.match(added.out, /deleted the file/);
  const stored = await s.row('app-env');
  assert.equal(stored.type, 'custom'); assert.deepEqual(stored.fields, {}); assert.deepEqual(stored.secrets, { API_KEY: secret, OTHER_VALUE: 'fixture other value' });
  const used = never(ok(await s.cli(['run', 'app-env', '--', NODE, '-e', 'process.stdout.write(process.env.API_KEY + " | " + process.env.OTHER_VALUE)'])));
  assert.equal(used.out, '[redacted] | [redacted]');
  const refused = await s.cli(['add', 'not-env', '--type', 'custom', '--secret-file', await s.file(secret)]);
  assert.equal(refused.code, 1); assert.match(refused.err, /NAME=value lines/);
});

test('a .env file with an empty value can still be saved', async t => {
  const s = await sandbox(t);
  ok(await s.cli(['add', 'app-env', '--secret-file', await s.file(`API_KEY=${secret}\nEMPTY=\n`)]));
  assert.equal((await s.row('app-env')).secrets.API_KEY, secret);
});

test('several commands saving at once all land, through the store\'s lock', async t => {
  const s = await sandbox(t), names = Array.from({ length: 6 }, (_, index) => 'parallel-' + index);
  const sources = await Promise.all(names.map(name => s.file(secret + name)));
  const answers = await Promise.all(names.map((name, index) => s.cli(['add', name, '--secret-file', sources[index]])));
  for (const answer of answers) ok(answer);
  assert.deepEqual((await s.rows()).map(row => row.id).sort(), names);
  for (const name of names) assert.equal((await s.row(name)).secrets.token, secret + name);
});

test('a recognized secret picks its own type, and --type overrides it', async t => {
  const s = await sandbox(t), github = 'ghp_' + 'fixture0000000000000000fixture';
  const added = never(ok(await s.cli(['add', 'github', '--secret-file', await s.file(github)])), github);
  assert.match(added.out, /Commands get: GH_TOKEN/); assert.match(added.out, /t3-vault http github GET user/);
  assert.match(added.out, /Calls go to: https:\/\/api\.github\.com\//, 'an address worked out from the value is never silent');
  const stored = await s.row('github');
  assert.equal(stored.type, 'git'); assert.equal(stored.fields.host, 'github.com'); assert.deepEqual(stored.env, { token: 'GH_TOKEN' });
  ok(await s.cli(['add', 'plain', '--type', 'token', '--secret-file', await s.file(github)]));
  assert.deepEqual([(await s.row('plain')).env, (await s.row('plain')).fields, (await s.row('plain')).secrets], [{}, {}, { token: github }], 'asking for another type keeps the value but none of the guess');
  const anthropic = 'sk-ant-' + 'fixture0000000000000000fixture';
  ok(await s.cli(['add', 'claude-key', '--type', 'token', '--secret-file', await s.file(anthropic), '--env', 'MY_KEY']));
  const agreed = await s.row('claude-key');
  assert.equal(agreed.fields.baseUrl, 'https://api.anthropic.com/v1/', 'a type that agrees keeps the guess');
  assert.deepEqual(agreed.env, { token: 'MY_KEY' }, 'and an explicit option beats it');
  ok(await s.cli(['add', 'as-login', '--type', 'login', '--username', 'me', '--secret-file', await s.file(github)]));
  assert.deepEqual((await s.row('as-login')).secrets, { password: github });
  ok(await s.cli(['add', 'aws', '--secret-file', await s.file('aws_access_key_id = AKIAFIXTURE000FIXT\naws_secret_access_key = fixtureSecretAccessKey0000\n')]));
  assert.equal((await s.row('aws')).type, 'aws');
  const unknown = await s.cli(['add', 'x', '--type', 'magic', '--secret-file', await s.file(secret)]);
  assert.equal(unknown.code, 1); assert.match(unknown.err, /no type called magic/);
  for (const [name, message] of [['Bad Name', /lowercase/], ['a_b', /lowercase/], ['new', /reserved/]]) assert.match((await s.cli(['add', name, '--secret-file', await s.file(secret)])).err, message, name);
});

test('a secret can come from stdin, and a file credential keeps its line breaks and lands as a real file', async t => {
  const s = await sandbox(t), content = 'first line of a fixture\nsecond line of a fixture\n';
  ok(await s.cli(['add', 'from-stdin', '--stdin'], { input: secret + '\n' }));
  assert.equal((await s.row('from-stdin')).secrets.token, secret);
  ok(await s.cli(['add', 'cert', '--type', 'file', '--filename', 'cert.pem', '--secret-file', await s.file(content)]));
  assert.equal((await s.row('cert')).secrets.content, content);
  const used = ok(await s.cli(['run', 'cert', '--', NODE, '-e', `const fs = require('node:fs'), file = process.env.CERT_FILE; process.stdout.write(JSON.stringify([require('node:path').basename(file), fs.readFileSync(file, 'utf8') === ${JSON.stringify(content)}, file]))`]));
  const [name, same, file] = JSON.parse(used.out);
  assert.deepEqual([name, same], ['cert.pem', true]);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  const large = 'x'.repeat(48 * 1024 + 1), tooBig = await s.cli(['add', 'too-big', '--stdin'], { input: large });
  assert.equal(tooBig.code, 1); assert.match(tooBig.err, /48 KiB/);
});

test('run carries exit codes, reports a missing command, and supports renames and several credentials', async t => {
  const s = await sandbox(t);
  ok(await s.cli(['add', 'one', '--secret-file', await s.file(secret + '-one')]));
  ok(await s.cli(['add', 'two', '--secret-file', await s.file(secret + '-two'), '--env', 'ONE_TOKEN']));
  assert.equal((await s.cli(['run', 'one', '--', NODE, '-e', 'process.exit(7)'])).code, 7);
  assert.equal((await s.cli(['run', 'one', '--', NODE, '-e', 'process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 5000)'])).code, 143);
  const missing = await s.cli(['run', 'one', '--', path.join(s.root, 'no-such-command')]);
  assert.equal(missing.code, 127); assert.match(missing.err, /Command not found/);
  const clash = await s.cli(['run', 'one', 'two', '--', NODE, '-e', '']);
  assert.equal(clash.code, 1); assert.match(clash.err, /both set ONE_TOKEN/);
  const renamed = ok(await s.cli(['run', 'one', 'two=SECOND', '--', NODE, '-e', `process.stdout.write(JSON.stringify([process.env.ONE_TOKEN === ${JSON.stringify(secret + '-one')}, process.env.SECOND === ${JSON.stringify(secret + '-two')}]))`]));
  assert.deepEqual(JSON.parse(renamed.out), [true, true]);
  for (const args of [['run'], ['run', 'one'], ['run', 'one', '--'], ['run', '--', 'true']]) assert.match((await s.cli(args)).err, /Use t3-vault run NAME/, args.join(' '));
  assert.match((await s.cli(['run', 'one=not-a-var', '--', 'true'])).err, /can't be used as a variable name/);
});

test('run gives a command binary output unchanged', async t => {
  const s = await sandbox(t);
  ok(await s.cli(['add', 'demo', '--secret-file', await s.file(secret)]));
  const { bytes } = ok(await s.cli(['run', 'demo', '--', NODE, '-e', 'process.stdout.write(Buffer.from(Array.from({ length: 256 }, (_, i) => i)))']));
  assert.ok(bytes.equals(Buffer.from(Array.from({ length: 256 }, (_, i) => i))));
});

test('--generate-key saves even when the host can\'t be reached, and prints the line to run on it', async t => {
  const s = await sandbox(t), port = await closedPort();
  const added = ok(await s.cli(['add', 'new-box', '--host', '127.0.0.1', '--port', String(port), '--user', 'deploy', '--generate-key', '--description', 'A fixture']));
  assert.doesNotMatch(added.out + added.err, /PRIVATE KEY/);
  assert.match(added.out, /^Saved new-box\.$/m); assert.match(added.out, /Couldn't reach 127\.0\.0\.1 yet \(unreachable\)/);
  const stored = await s.row('new-box');
  assert.equal(stored.fields.auth, 'key'); assert.match(stored.fields.publicKey, /^ssh-ed25519 \S+ t3-vault:new-box$/); assert.match(stored.secrets.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----/);
  const install = added.out.split('\n').find(line => line.includes('authorized_keys')).trim();
  assert.equal(install, `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${stored.fields.publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`);
  assert.deepEqual(stored.origin, { by: 'terminal' });
  assert.equal(await fs.readFile(path.join(s.directory, 'keys/new-box'), 'utf8'), stored.secrets.privateKey);
  assert.equal((await fs.stat(path.join(s.directory, 'keys/new-box'))).mode & 0o777, 0o600);
  // Plain ssh now reaches it, through the home this subprocess was given.
  const ssh = spawnSync('/usr/bin/ssh', ['-G', '-F', path.join(s.home, '.ssh/config'), 'new-box'], { encoding: 'utf8' });
  assert.equal(ssh.status, 0, ssh.stderr); assert.match(ssh.stdout, /^hostname 127\.0\.0\.1$/m); assert.match(ssh.stdout, new RegExp(`^port ${port}$`, 'm')); assert.match(ssh.stdout, /^user deploy$/m);
  assert.match(ssh.stdout, new RegExp('^identityfile ' + path.join(s.directory, 'keys/new-box').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'));
  const listed = ok(await s.cli(['list']));
  assert.match(listed.out, /deploy@127\.0\.0\.1:\d+, key \(not connected yet: run t3-vault test new-box\)/);
  assert.match(listed.out, /use: ssh new-box <command>/);
  const shown = ok(await s.cli(['show', 'new-box']));
  assert.match(shown.out, /public key: ssh-ed25519/); assert.doesNotMatch(shown.out, /PRIVATE KEY/);
  const tested = await s.cli(['test', 'new-box']);
  assert.equal(tested.code, 1); assert.match(tested.out, /new-box failed: The server couldn't be reached/);
  assert.doesNotMatch((await s.cli(['ssh', 'new-box', '--', 'true'])).err, /PRIVATE KEY/);
  assert.equal(JSON.stringify(JSON.parse(ok(await s.cli(['list', '--json'])).out)).includes('PRIVATE KEY'), false);
});

test('a private key file gets its own type and its public half, and the passphrase isn\'t kept', async t => {
  const s = await sandbox(t), keyFile = path.join(s.root, 'made-key'), passphrase = 'fixture-key-passphrase', port = await closedPort();
  assert.equal(spawnSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'fixture', '-f', keyFile]).status, 0);
  const wanted = (await fs.readFile(keyFile + '.pub', 'utf8')).split(' ').slice(0, 2).join(' ');
  const base = ['--host', '127.0.0.1', '--port', String(port), '--user', 'deploy', '--key-file', keyFile];
  const missing = await s.cli(['add', 'with-key', ...base]);
  assert.equal(missing.code, 1); assert.match(missing.err, /needs its passphrase/);
  assert.equal(await s.row('with-key'), undefined, 'a key that can\'t be opened leaves nothing behind');
  const phrase = await s.file(passphrase + '\n');
  const added = ok(await s.cli(['add', 'with-key', ...base, '--passphrase-file', phrase]));
  assert.equal(added.out.includes(passphrase), false);
  const stored = await s.row('with-key');
  assert.match(stored.fields.publicKey, new RegExp('^' + wanted.replace(/[+/]/g, '\\$&') + ' t3-vault:with-key$'));
  assert.equal(JSON.stringify(stored).includes(passphrase), false);
  assert.equal(spawnSync('/usr/bin/ssh-keygen', ['-y', '-P', '', '-f', path.join(s.directory, 'keys/with-key')], { encoding: 'utf8' }).status, 0, 'the saved key opens without one');
  const detected = ok(await s.cli(['add', 'detected-key', '--host', '127.0.0.1', '--port', String(port), '--user', 'deploy', '--secret-file', keyFile, '--passphrase-file', phrase]));
  assert.match(detected.out, /Couldn't reach/);
  assert.equal((await s.row('detected-key')).fields.auth, 'key');
  const flat = await s.file((await fs.readFile(keyFile, 'utf8')).replace(/\n/g, ''));
  ok(await s.cli(['add', 'flat-key', '--host', '127.0.0.1', '--port', String(port), '--user', 'deploy', '--secret-file', flat, '--passphrase-file', phrase]));
  assert.equal((await s.row('flat-key')).fields.publicKey.split(' ')[1], wanted.split(' ')[1], 'a key that lost its line breaks in a one-line box still works');
});

test('--user works like --username, and a password sign-in waits for its server to be confirmed', async t => {
  const s = await sandbox(t), password = await s.file(secret + '\n');
  ok(await s.cli(['add', 'box-one', '--host', '192.0.2.1', '--username', 'deploy', '--password-file', password]));
  const added = never(ok(await s.cli(['add', 'box-two', '--host', '192.0.2.1', '--user', 'deploy', '--password-file', password])));
  for (const name of ['box-one', 'box-two']) {
    const stored = await s.row(name);
    assert.deepEqual(stored.fields, { host: '192.0.2.1', port: 22, username: 'deploy', auth: 'password' });
    assert.deepEqual(stored.secrets, { password: secret });
  }
  assert.equal(await fs.readFile(password, 'utf8'), secret + '\n');
  assert.match(added.out, /can't be used until the server's identity is confirmed/); assert.match(added.out, /t3-vault trust box-two/);
  assert.match(ok(await s.cli(['list'])).out, /deploy@192\.0\.2\.1, password \(blocked: run t3-vault trust box-two\)/);
  const blocked = never(await s.cli(['ssh', 'box-two', '--', 'true']));
  assert.equal(blocked.code, 1); assert.match(blocked.err, /t3-vault trust box-two/);
  assert.match((await s.cli(['add', 'box-three', '--host', '192.0.2.1', '--password-file', password])).err, /valid username/);
  assert.match((await s.cli(['add', 'box-three', '--user', 'deploy', '--password-file', password])).err, /hostname or IP/);
  assert.match((await s.cli(['add', 'box-three', '--host', '-oProxyCommand=bad', '--user', 'deploy', '--password-file', password])).err, /hostname or IP/);
});

test('installing with a password checks the server first, so the password never goes to an unknown one', async t => {
  const s = await sandbox(t), port = await closedPort(), password = await s.card(secret);
  const unreachable = never(await s.cli(['add', 'box', '--host', '127.0.0.1', '--port', String(port), '--user', 'deploy', '--install-with-password-file', password]));
  assert.equal(unreachable.code, 1); assert.match(unreachable.err, /Couldn't reach 127\.0\.0\.1/);
  assert.equal(await s.row('box'), undefined);
  assert.equal(await fs.readFile(password, 'utf8'), secret, 'the card stays for the next try');
});

test('http calls the saved API, hides the token in what comes back, and reports failure', async t => {
  const s = await sandbox(t), seen = [];
  const base = await apiServer(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.url === '/echo') { res.end(JSON.stringify({ auth: req.headers.authorization })); return; }
    if (req.url === '/split') { res.write('start ' + secret.slice(0, 9)); setTimeout(() => res.end(secret.slice(9) + ' end'), 40); return; }
    if (req.url === '/denied') { res.writeHead(401); res.end('no ' + secret); return; }
    if (req.url === '/moved') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); return; }
    res.end('ok');
  });
  const added = never(ok(await s.cli(['add', 'demo-api', '--base-url', base, '--test-path', 'echo', '--secret-file', await s.file(secret)])));
  assert.match(added.out, /t3-vault http demo-api GET echo/);
  const echoed = never(ok(await s.cli(['http', 'demo-api', 'GET', 'echo'])));
  assert.deepEqual(JSON.parse(echoed.out), { auth: 'Bearer [redacted]' });
  assert.equal(seen.at(-1).auth, 'Bearer ' + secret, 'the server did get the real token');
  assert.equal(never(ok(await s.cli(['http', 'demo-api', 'GET', 'split']))).out, 'start [redacted] end');
  const denied = never(await s.cli(['http', 'demo-api', 'GET', 'denied']));
  assert.equal(denied.code, 1); assert.match(denied.err, /HTTP 401/); assert.equal(denied.out, 'no [redacted]');
  const moved = never(await s.cli(['http', 'demo-api', 'GET', 'moved']));
  assert.equal(moved.code, 1); assert.match(moved.err, /redirect/);
  ok(await s.cli(['http', 'demo-api', 'POST', 'things', '--stdin'], { input: '{"name":"fixture"}' }));
  assert.deepEqual([seen.at(-1).method, seen.at(-1).url, seen.at(-1).body], ['POST', '/things', '{"name":"fixture"}']);
  for (const [args, message] of [[['GET', 'x', '--stdin'], /cannot have a body/], [['POST', 'x', '--stdin'], /valid JSON/], [['GET', '/absolute'], /relative/], [['FETCH', 'x'], /Use GET/], [['GET', 'x', '--other'], /Use t3-vault http/]]) {
    const refused = await s.cli(['http', 'demo-api', ...args], { input: 'not json' });
    assert.equal(refused.code, 1, args.join(' ')); assert.match(refused.err, message, args.join(' '));
  }
  ok(await s.cli(['add', 'scoped-api', '--base-url', base + 'v1', '--secret-file', await s.file(secret)]));
  const outside = await s.cli(['http', 'scoped-api', 'GET', '../outside']);
  assert.equal(outside.code, 1); assert.match(outside.err, /inside the saved API/);
  const tested = never(ok(await s.cli(['test', 'demo-api'])));
  assert.match(tested.out, /demo-api works/);
  ok(await s.cli(['add', 'no-address', '--secret-file', await s.file(secret)]));
  assert.match((await s.cli(['http', 'no-address', 'GET', 'x'])).err, /no API address/);
  assert.match(ok(await s.cli(['test', 'no-address'])).out, /no test set up/);
});

test('a failed test says what went wrong and what to do', async t => {
  const s = await sandbox(t);
  const base = await apiServer(t, (_req, res) => { res.writeHead(401); res.end(secret); });
  ok(await s.cli(['add', 'demo-api', '--base-url', base, '--secret-file', await s.file(secret)]));
  const tested = never(await s.cli(['test', 'demo-api']));
  assert.equal(tested.code, 1); assert.match(tested.out, /demo-api failed: The service rejected the secret/); assert.match(tested.out, /t3-vault replace demo-api/); assert.match(tested.out, /HTTP 401/);
});

test('help, types and mistakes all point somewhere useful', async t => {
  const s = await sandbox(t);
  for (const args of [[], ['--help'], ['-h'], ['help']]) assert.match(ok(await s.cli(args)).out, /t3-vault run NAME\.\.\. -- COMMAND/);
  const types = ok(await s.cli(['types'])).out;
  for (const line of ['ssh: SSH server', 'token: API token', 'database: Database', 'git: Git host', 'custom: Custom', '--key-file FILE', '--base-url VALUE', '--var NAME=VALUE']) assert.ok(types.includes(line), line);
  const unknown = await s.cli(['nonsense']);
  assert.equal(unknown.code, 1); assert.match(unknown.err, /t3-vault --help/);
  for (const args of [['show'], ['ssh'], ['http'], ['add'], ['replace'], ['test'], ['trust'], ['use-key'], ['rm']]) { const answer = await s.cli(args); assert.equal(answer.code, 1, args[0]); assert.match(answer.err, /^Use t3-vault /, args[0]); }
  assert.match((await s.cli(['ssh', 'x'])).err, /Supply a command/);
  ok(await s.cli(['add', 'demo', '--secret-file', await s.file(secret)]));
  assert.match((await s.cli(['trust', 'demo'])).err, /isn't an SSH credential/);
  assert.match((await s.cli(['ssh', 'demo', '--', 'true'])).err, /Use t3-vault run instead/);
  assert.match((await s.cli(['use-key', 'demo'])).err, /isn't an SSH credential/);
  const unknownFlag = await s.cli(['add', 'other', '--nonsense', 'x', '--secret-file', await s.file(secret)]);
  assert.match(unknownFlag.err, /Unknown option --nonsense/);
  assert.match((await s.cli(['add', 'other', '--env', 'ANYTHING', '--type', 'aws', '--access-key-id', 'AKIAFIXTURE', '--secret-file', await s.file(secret)])).err, /fixed variable names/);
  assert.match((await s.cli(['add', 'other', '--env', 'PATH', '--secret-file', await s.file(secret)])).err, /name the system relies on/);
});

test('reads never change a store, and an unupgraded store says to open Setup', async t => {
  const s = await sandbox(t), file = path.join(s.directory, 'credentials.json');
  await fs.mkdir(s.directory, { recursive: true, mode: 0o700 });
  const legacy = JSON.stringify({ version: 2, profiles: [{ id: 'old-api', type: 'api', baseUrl: 'https://example.test/', secret, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', secretChangedAt: null, revision: '0123456789abcdef' }] });
  await fs.writeFile(file, legacy, { mode: 0o600 });
  for (const args of [['list'], ['show', 'old-api'], ['run', 'old-api', '--', NODE, '-e', '']]) {
    const answer = await s.cli(args);
    assert.equal(answer.code, 1, args[0]); assert.match(answer.err, /Open Setup once/, args[0]);
  }
  assert.equal(await fs.readFile(file, 'utf8'), legacy);
});
