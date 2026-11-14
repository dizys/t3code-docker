// runWith with real child processes: what a command gets and what comes back.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { runWith, canTest, apiRequest } from '../docker/setup/credentials/run.mjs';
import { maskValues, outputFilter, byteFilter, redactText, REDACTED } from '../docker/setup/credentials/redact.mjs';
import { normalize } from '../docker/setup/credentials/model.mjs';

const token = 'fixture-run-token-value-123';
const sink = () => { const chunks = []; return { write: chunk => { chunks.push(Buffer.from(chunk)); }, get bytes() { return Buffer.concat(chunks); }, get text() { return Buffer.concat(chunks).toString(); } }; };
const credential = (id = 'project-api', value = token, extra = {}) => normalize({ id, type: 'token', secrets: { token: value }, ...extra });
const script = source => [process.execPath, '-e', source];
const run = async (credentials, command, options = {}) => {
  const stdout = sink(), stderr = sink();
  const code = await runWith(credentials.map(entry => entry.credential ? entry : { credential: entry }), command, { stdout, stderr, stdin: 'ignore', env: { PATH: process.env.PATH }, ...options });
  return { code, out: stdout.text, err: stderr.text, bytes: stdout.bytes };
};

test('the variable reaches the child, alongside the environment it was given', async () => {
  const { code, out, err } = await run([credential()], script(`process.stdout.write(JSON.stringify({ same: process.env.PROJECT_API_TOKEN === ${JSON.stringify(token)}, kept: process.env.KEPT }))`), { env: { PATH: process.env.PATH, KEPT: 'yes' } });
  assert.equal(code, 0, err); assert.deepEqual(JSON.parse(out), { same: true, kept: 'yes' });
});

test('AWS credentials clear inherited modern and legacy session tokens', async () => {
  const aws = (secrets) => normalize({ id: 'aws', type: 'aws', fields: { accessKeyId: 'AKIAFIXTURE' }, secrets });
  // Secret values are masked in output, so the child only reports booleans.
  const show = `process.stdout.write(JSON.stringify({ hasKey: 'AWS_SECRET_ACCESS_KEY' in process.env, hasToken: 'AWS_SESSION_TOKEN' in process.env, hasLegacyToken: 'AWS_SECURITY_TOKEN' in process.env, tokenIsSaved: process.env.AWS_SESSION_TOKEN === 'fixture-session' }))`;
  const inherited = { PATH: process.env.PATH, AWS_SESSION_TOKEN: 'stale-parent-token', AWS_SECURITY_TOKEN: 'stale-parent-legacy' };
  const without = await run([aws({ secretAccessKey: 'fixture-secret-key' })], script(show), { env: inherited });
  assert.equal(without.code, 0, without.err);
  assert.deepEqual(JSON.parse(without.out), { hasKey: true, hasToken: false, hasLegacyToken: false, tokenIsSaved: false }, 'a permanent key must not inherit either stale token alias');
  const within = await run([aws({ secretAccessKey: 'fixture-secret-key', sessionToken: 'fixture-session' })], script(show), { env: inherited });
  assert.deepEqual(JSON.parse(within.out), { hasKey: true, hasToken: true, hasLegacyToken: false, tokenIsSaved: true }, 'an inherited legacy token must not shadow the saved session token');
  assert.equal(inherited.AWS_SESSION_TOKEN, 'stale-parent-token', 'the caller environment stays intact');
  assert.equal(inherited.AWS_SECURITY_TOKEN, 'stale-parent-legacy', 'the caller legacy token stays intact');
});

test('explicit custom AWS tokens are preserved in either credential order', async () => {
  const aws = normalize({ id: 'aws', type: 'aws', fields: { accessKeyId: 'AKIAFIXTURE' }, secrets: { secretAccessKey: 'fixture-key' } });
  for (const name of ['AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN']) {
    const custom = normalize({ id: 'session', type: 'custom', secrets: { [name]: 'explicit-session' } });
    for (const entries of [[aws, custom], [custom, aws]]) {
      const result = await run(entries, script(`process.stdout.write(String(process.env[${JSON.stringify(name)}] === 'explicit-session'))`), { env: { [name]: 'stale-parent' } });
      assert.equal(result.code, 0, result.err);
      assert.equal(result.out, 'true');
    }
  }
});

test('the parent\'s secrets never pass through its own environment', async () => {
  await run([credential()], script(''));
  assert.equal(process.env.PROJECT_API_TOKEN, undefined);
});

test('values are hidden on stdout and stderr, however the output is split into chunks', async () => {
  const half = token.length >> 1, first = token.slice(0, half), last = token.slice(half);
  const source = `const one = ${JSON.stringify(first)}, two = ${JSON.stringify(last)}, wait = () => new Promise(r => setTimeout(r, 40));
    (async () => {
      for (const stream of [process.stdout, process.stderr]) { stream.write('before ' + one); await wait(); stream.write(two + ' after\\n'); await wait(); stream.write('whole ' + one + two + ' end\\n'); }
    })();`;
  const { code, out, err } = await run([credential()], script(source));
  assert.equal(code, 0);
  for (const stream of [out, err]) { assert.equal(stream, 'before [redacted] after\nwhole [redacted] end\n'); assert.equal(stream.includes(token), false); }
  // Byte by byte is the worst case for a boundary.
  const stepped = await run([credential()], script(`(async () => { for (const c of ${JSON.stringify('x' + token + 'y')}) { process.stdout.write(c); await new Promise(r => setImmediate(r)); } })()`));
  assert.equal(stepped.out, 'x[redacted]y');
});

test('the forms a value commonly takes in output are hidden too', async () => {
  const value = 'fixture "quoted" & spaced/value+', forms = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), new URLSearchParams([['', value]]).toString().slice(1), Buffer.from(value).toString('base64')];
  const { out } = await run([credential('tricky', value)], script(`process.stdout.write(${JSON.stringify(forms.join(' | '))})`));
  assert.equal(out, forms.map(() => REDACTED).join(' | '));
});

test('a database password is hidden inside the URL as well as by itself', async () => {
  const password = 'p@ss/w:rd#fixture', database = normalize({ id: 'app-db', type: 'database', fields: { engine: 'postgres', host: 'db.example.test', username: 'app', database: 'main' }, secrets: { password } });
  const { out } = await run([database], script(`process.stdout.write(process.env.DATABASE_URL + ' ' + process.env.PGPASSWORD)`));
  assert.equal(out, 'postgres://app:[redacted]@db.example.test/main [redacted]');
});

test('text that only starts like a secret comes through when the command ends', async () => {
  const { out } = await run([credential()], script(`process.stdout.write('prefix ' + ${JSON.stringify(token.slice(0, 10))})`));
  assert.equal(out, 'prefix ' + token.slice(0, 10));
});

test('binary output passes through byte-identical', async () => {
  const every = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const expected = Buffer.concat(Array.from({ length: 1024 }, () => every));
  assert.ok(expected.includes(0xff) && expected.includes(0x00));
  const source = `const every = Buffer.from(Array.from({ length: 256 }, (_, i) => i)); process.stdout.write(Buffer.concat(Array.from({ length: 1024 }, () => every)));`;
  for (const masked of [[credential()], [normalize({ id: 'plain', type: 'custom', fields: { NOT_SECRET: 'x' } })]]) {
    const { code, bytes } = await run(masked, script(source));
    assert.equal(code, 0);
    assert.equal(bytes.length, expected.length);
    assert.ok(bytes.equals(expected), 'every byte came back the same');
  }
});

test('a value is hidden in the middle of binary output without disturbing the bytes around it', async () => {
  const source = `process.stdout.write(Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.from(${JSON.stringify(token)}), Buffer.from([0x80, 0x00, 0xff])]))`;
  const { bytes } = await run([credential()], script(source));
  assert.ok(bytes.equals(Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.from(REDACTED), Buffer.from([0x80, 0x00, 0xff])])));
});

test('a value with non-ASCII characters is hidden even when a chunk splits a character', async () => {
  const value = 'pässwörd-fixture-✓-value', encoded = Buffer.from(value), middle = encoded.indexOf(0xc3) + 1;
  const source = `const all = Buffer.from(${JSON.stringify(value)}); (async () => { process.stdout.write(all.subarray(0, ${middle})); await new Promise(r => setTimeout(r, 40)); process.stdout.write(all.subarray(${middle})); })()`;
  const { out } = await run([credential('accents', value)], script(source));
  assert.equal(out, REDACTED);
});

test('exit codes are carried', async () => {
  for (const code of [0, 1, 7, 255]) assert.equal((await run([credential()], script(`process.exit(${code})`))).code, code);
});

test('a command ended by a signal reports 128 plus the signal, as a shell would', async () => {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGKILL', 137], ['SIGINT', 130]]) {
    assert.equal((await run([credential()], script(`process.kill(process.pid, '${signal}'); setTimeout(() => {}, 5000);`))).code, code, signal);
  }
});

test('a missing command is status 127, one that can\'t start is 126, and neither leaves a temporary file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-vault-run-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missing = path.join(root, 'no-such-command');
  await assert.rejects(run([credential()], [missing]), error => error.status === 127 && error.code === 'command-not-found' && error.message.includes(missing));
  const notRunnable = path.join(root, 'not-executable'); await fs.writeFile(notRunnable, 'x', { mode: 0o600 });
  await assert.rejects(run([credential()], [notRunnable]), { status: 126, code: 'command-failed' });
  let file;
  await assert.rejects(run([normalize({ id: 'cert', type: 'file', secrets: { content: 'fixture file text' } })], [missing], { spawnProcess: (command, args, options) => { file = options.env.CERT_FILE; return spawn(command, args, options); } }), { status: 127 });
  assert.equal(await fs.readFile(path.dirname(file) + '/credential', 'utf8').catch(error => error.code), 'ENOENT');
  await assert.rejects(fs.stat(path.dirname(path.dirname(file))), { code: 'ENOENT' });
});

test('premature command output failure cannot become a successful exit', async () => {
  await assert.rejects(runWith([], ['fixture-command'], {
    stdout: sink(), stderr: sink(), stdin: 'ignore', env: {},
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new Readable({read() {this.destroy(Object.assign(new Error('fixture-private-detail'), {code: 'ERR_STREAM_PREMATURE_CLOSE'}));}});
      child.stderr = Readable.from([]); child.kill = () => true;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  }), error => error.status === 502 && error.code === 'command-failed' && !error.message.includes('fixture-private-detail'));
});

test('a truncated HTTP body stays a failure and never exposes credential values', async () => {
  const stdout = sink(), stderr = sink();
  const saved = credential('http', token, {fields: {baseUrl: 'https://fixture.invalid/'}});
  await assert.rejects(apiRequest(saved, 'GET', 'data', {
    stdout, stderr,
    fetchRequest: async () => new Response(new ReadableStream({start(controller) {
      controller.enqueue(Buffer.from('body ' + token));
      setTimeout(() => controller.error(Object.assign(new Error('private ' + token), {code: 'ERR_STREAM_PREMATURE_CLOSE'})), 0);
    }}), {status: 200}),
  }), error => error.status === 502 && !error.message.includes(token));
  assert.equal(stdout.text.includes(token), false);
  assert.equal(stderr.text.includes(token), false);
});

test('temporary files exist only during the command, at mode 600 in a 700 folder', async () => {
  const content = 'fixture certificate text\nwith two lines\n';
  const source = `const fs = require('node:fs'), path = require('node:path'), file = process.env.CERT_FILE, folder = path.dirname(file), mode = target => fs.statSync(target).mode & 0o777;
    process.stdout.write(JSON.stringify({ file, mode: mode(file), folder: mode(folder), parent: mode(path.dirname(folder)), same: fs.readFileSync(file, 'utf8') === ${JSON.stringify(content)}, owner: fs.statSync(file).uid === process.getuid() }));`;
  const { code, out, err } = await run([normalize({ id: 'cert', type: 'file', fields: { filename: 'cert.pem' }, secrets: { content } })], script(source));
  assert.equal(code, 0, err);
  const seen = JSON.parse(out);
  assert.equal(path.basename(seen.file), 'cert.pem');
  assert.deepEqual([seen.mode, seen.folder, seen.parent, seen.same, seen.owner], [0o600, 0o700, 0o700, true, true]);
  await assert.rejects(fs.stat(seen.file), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.dirname(path.dirname(seen.file))), { code: 'ENOENT' });
});

test('temporary files go even when the command fails or is killed', async () => {
  for (const ending of ['process.exit(3)', `process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 5000);`]) {
    const { out } = await run([normalize({ id: 'cert', type: 'file', secrets: { content: 'fixture' } })], script(`require('node:fs').writeSync(1, process.env.CERT_FILE); ${ending}`));
    await assert.rejects(fs.stat(out), { code: 'ENOENT' });
  }
});

test('file contents are hidden, including a long line printed by itself', async () => {
  const line = 'Zml4dHVyZS1wcml2YXRlLWtleS1ib2R5LWxpbmU', content = `short\n${line}\nalso short\n`;
  const { out } = await run([normalize({ id: 'cert', type: 'file', secrets: { content } })], script(`const text = require('node:fs').readFileSync(process.env.CERT_FILE, 'utf8'); process.stdout.write(text + '---\\n' + ${JSON.stringify(line)});`));
  assert.equal(out.includes(line), false);
  assert.equal(out, REDACTED + '---\n' + REDACTED);
});

test('each credential with a file gets its own, even with the same name', async () => {
  const one = normalize({ id: 'one', type: 'file', fields: { filename: 'same' }, secrets: { content: 'fixture first' } });
  const two = normalize({ id: 'two', type: 'file', fields: { filename: 'same' }, secrets: { content: 'fixture second' } });
  const { code, out } = await run([one, two], script(`const fs = require('node:fs'); process.stdout.write(JSON.stringify([process.env.ONE_FILE !== process.env.TWO_FILE, fs.readFileSync(process.env.ONE_FILE, 'utf8') === 'fixture first', fs.readFileSync(process.env.TWO_FILE, 'utf8') === 'fixture second']));`));
  assert.equal(code, 0); assert.deepEqual(JSON.parse(out), [true, true, true]);
});

test('two credentials claiming one variable is an error, before anything starts', async () => {
  let started = false;
  const shared = id => credential(id, token + id, { env: { token: 'SHARED_TOKEN' } });
  await assert.rejects(run([shared('one'), shared('two')], ['/bin/true'], { spawnProcess() { started = true; } }), error => {
    assert.equal(error.status, 400);
    assert.match(error.message, /one and two both set SHARED_TOKEN/);
    assert.match(error.message, /two=OTHER_NAME/, 'it says how to fix it');
    return true;
  });
  assert.equal(started, false);
  // A file variable counts too.
  const file = id => normalize({ id, type: 'file', env: { content: 'SHARED_FILE' }, secrets: { content: 'fixture' } });
  await assert.rejects(run([file('one'), file('two')], ['/bin/true']), /both set SHARED_FILE/);
  await assert.rejects(run([shared('one'), normalize({ id: 'two', type: 'file', env: { content: 'SHARED_TOKEN' }, secrets: { content: 'fixture' } })], ['/bin/true']), /both set SHARED_TOKEN/);
});

test('NAME=VAR gives the main secret another name, which also settles a clash', async () => {
  const source = `process.stdout.write(JSON.stringify([process.env.RENAMED === ${JSON.stringify(token)}, process.env.PROJECT_API_TOKEN === undefined]))`;
  assert.deepEqual(JSON.parse((await run([{ credential: credential(), rename: 'RENAMED' }], script(source))).out), [true, true]);
  const shared = (id, value) => credential(id, value, { env: { token: 'SHARED_TOKEN' } });
  const { code, out } = await run([shared('one', token + '-one'), { credential: shared('two', token + '-two'), rename: 'OTHER_TOKEN' }], script(`process.stdout.write(JSON.stringify([process.env.SHARED_TOKEN.endsWith('-one'), process.env.OTHER_TOKEN.endsWith('-two')]))`));
  assert.equal(code, 0); assert.deepEqual(JSON.parse(out), [true, true]);
  const file = normalize({ id: 'cert', type: 'file', secrets: { content: 'fixture' } });
  assert.equal((await run([{ credential: file, rename: 'MY_CERT' }], script(`process.stdout.write(String(require('node:fs').existsSync(process.env.MY_CERT)))`))).out, 'true');
});

test('every credential\'s values are hidden, not only the first one\'s', async () => {
  const { out } = await run([credential('one', 'fixture-first-value'), credential('two', 'fixture-second-value')], script(`process.stdout.write(process.env.ONE_TOKEN + ' ' + process.env.TWO_TOKEN)`));
  assert.equal(out, '[redacted] [redacted]');
});

test('signals reach the command, and the handlers don\'t outlive it', async () => {
  const signals = new EventEmitter();
  const source = `process.on('SIGTERM', () => { process.stdout.write('stopping'); process.exit(9); }); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
  const stdout = { write: chunk => { if (String(chunk).includes('ready')) signals.emit('SIGTERM'); } };
  const code = await runWith([{ credential: credential() }], script(source), { stdout, stderr: sink(), stdin: 'ignore', env: { PATH: process.env.PATH }, signals });
  assert.equal(code, 9);
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(name), 0, name);
});

test('only SSH credentials and ones with an address have a test', () => {
  assert.equal(canTest({ type: 'ssh', fields: {} }), true);
  assert.equal(canTest({ type: 'token', fields: { baseUrl: 'https://example.test/' } }), true);
  assert.equal(canTest({ type: 'token', fields: {} }), false);
  assert.equal(canTest({ type: 'custom' }), false);
});

// ---- the masks themselves -----------------------------------------------------
test('values shorter than the minimum aren\'t masked, since they would hide ordinary text', () => {
  assert.deepEqual(maskValues('abc'), []);
  assert.deepEqual(maskValues(['', 'a', 'ab', 'abc']), []);
  assert.ok(maskValues('abcd').includes('abcd'));
  assert.equal(redactText('the cat sat', 'cat'), 'the cat sat');
  assert.equal(redactText('the cats sat', 'cats'), 'the [redacted] sat');
  assert.deepEqual(maskValues([undefined, null, 42, {}]), []);
  assert.deepEqual(maskValues(undefined), []);
  assert.ok(maskValues('   abcd   ').includes('abcd'), 'the trimmed form counts');
  assert.deepEqual(maskValues('   a   ').filter(value => value.trim().length < 4 && value.length < 4), [], 'and nothing short slips in from it');
});

test('a multi-line secret hides each long line, leaves short ones, and tries the longest form first', () => {
  const longOne = 'x'.repeat(16), tooShort = 'y'.repeat(15), secret = `${longOne}\n${tooShort}\r\n${'z'.repeat(40)}\n`;
  const values = maskValues(secret);
  assert.ok(values.includes(longOne)); assert.ok(values.includes('z'.repeat(40))); assert.equal(values.includes(tooShort), false);
  assert.deepEqual(values, [...values].sort((a, b) => b.length - a.length));
  assert.equal(redactText(`a ${longOne} b ${tooShort} c`, secret), `a [redacted] b ${tooShort} c`);
  assert.equal(redactText(secret, secret), REDACTED, 'the whole value wins over its lines');
  assert.equal(redactText('a ' + 'x'.repeat(16) + ' b', 'single line, so no lines of its own\nxxxxxxxxxxxxxxx'), 'a ' + 'x'.repeat(16) + ' b');
  assert.equal(maskValues('one line without a break here').length <= 6, true);
});

test('text and byte filters hold back only what could still become a secret', () => {
  const written = [], text = outputFilter('fixture-secret', value => written.push(value));
  text.write('hello '); assert.deepEqual(written, ['hello '], 'ordinary output and prompts come straight through');
  text.write('fixture'); assert.deepEqual(written, ['hello '], 'this might still become the secret');
  text.write('-other'); assert.deepEqual(written, ['hello ', 'fixture-other']);
  text.write(' fixture-'); text.end(); assert.equal(written.join(''), 'hello fixture-other fixture-');
  const out = sink(), bytes = byteFilter('fixture-secret', out.write);
  bytes.write(Buffer.from('a fixture-sec')); bytes.write(Buffer.from('ret b')); bytes.end();
  assert.equal(out.text, 'a [redacted] b');
  const none = sink(), open = byteFilter([], none.write);
  open.write(Buffer.from([0xff, 0x00])); open.end();
  assert.ok(none.bytes.equals(Buffer.from([0xff, 0x00])));
});
