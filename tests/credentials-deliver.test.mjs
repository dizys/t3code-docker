import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { delivery, deliveredNames, secretValues } from '../docker/setup/credentials/deliver.mjs';
import { detect } from '../docker/setup/credentials/detect.mjs';
import { normalize } from '../docker/setup/credentials/model.mjs';

const token = 'fixture-token-value-123';
const given = (input, options) => delivery(normalize(input), { base: {}, ...options });

test('a token reaches commands under its own name, a saved override, or a one-off rename', () => {
  const base = { id: 'cloudflare-token', type: 'token', secrets: { token } };
  assert.deepEqual(given(base), { env: { CLOUDFLARE_TOKEN: token }, files: [], masks: [token] }, 'not CLOUDFLARE_TOKEN_TOKEN');
  assert.deepEqual(given({ ...base, id: 'stripe' }).env, { STRIPE_TOKEN: token });
  assert.deepEqual(given({ ...base, env: { token: 'CLOUDFLARE_API_TOKEN' } }).env, { CLOUDFLARE_API_TOKEN: token });
  assert.deepEqual(given({ ...base, env: { token: 'CLOUDFLARE_API_TOKEN' } }, { rename: 'ONE_OFF' }).env, { ONE_OFF: token }, 'a rename beats the saved name');
  assert.deepEqual(deliveredNames(normalize({ ...base, env: { token: 'CLOUDFLARE_API_TOKEN' } })), ['CLOUDFLARE_API_TOKEN']);
  // The address is only for t3-vault http and Setup's test, so commands don't get it.
  assert.deepEqual(given({ ...base, fields: { baseUrl: 'https://api.example.test/', authType: 'header', authName: 'X-Key' } }).env, { CLOUDFLARE_TOKEN: token });
});

test('a login gives a username, a password and, when saved, an address', () => {
  const input = { id: 'prod-admin', type: 'login', fields: { username: 'fixture-admin' }, secrets: { password: 'fixture-password' } };
  assert.deepEqual(given(input).env, { PROD_ADMIN_USERNAME: 'fixture-admin', PROD_ADMIN_PASSWORD: 'fixture-password' });
  assert.deepEqual(given({ ...input, fields: { ...input.fields, url: 'https://example.test' } }).env.PROD_ADMIN_URL, 'https://example.test');
  assert.deepEqual(given({ ...input, env: { username: 'ADMIN_USER', password: 'ADMIN_PASS' } }).env, { ADMIN_USER: 'fixture-admin', ADMIN_PASS: 'fixture-password' });
  assert.deepEqual(given(input, { rename: 'ONLY_THE_PASSWORD' }).env, { PROD_ADMIN_USERNAME: 'fixture-admin', ONLY_THE_PASSWORD: 'fixture-password' });
  assert.deepEqual(given(input).masks, ['fixture-password'], 'a username is not secret');
});

test('a database URL has everything percent-encoded, and detection reads it back exactly', () => {
  const password = 'p@ss/w:rd#1 x%', input = { id: 'app-db', type: 'database', fields: { engine: 'postgres', host: 'db.example.net', port: 5433, database: 'my db', username: 'app user', options: 'sslmode=require' }, secrets: { password } };
  const { env, files, masks } = given(input);
  assert.equal(env.DATABASE_URL, 'postgres://app%20user:p%40ss%2Fw%3Ard%231%20x%25@db.example.net:5433/my%20db?sslmode=require');
  assert.deepEqual(env, { DATABASE_URL: env.DATABASE_URL, PGHOST: 'db.example.net', PGPORT: '5433', PGUSER: 'app user', PGPASSWORD: password, PGDATABASE: 'my db' });
  assert.deepEqual(files, []); assert.deepEqual(masks, [password]);
  const parsed = new URL(env.DATABASE_URL);
  assert.equal(decodeURIComponent(parsed.password), password); assert.equal(parsed.hostname, 'db.example.net');
  const back = detect(env.DATABASE_URL);
  assert.equal(back.type, 'database'); assert.deepEqual(back.secrets, { password }); assert.deepEqual(back.fields, input.fields);
  assert.deepEqual(deliveredNames(normalize(input)), ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']);
});

test('a rediss address stays encrypted through detection and delivery', () => {
  const found = detect('rediss://:fixture-pass@cache.example.test:6380/0'), { env } = given({ id: 'cache', type: found.type, fields: found.fields, secrets: found.secrets });
  assert.match(env.DATABASE_URL, /^rediss:/);
});

test('a mongodb+srv address stays a DNS seed list through detection and delivery', () => {
  const found = detect('mongodb+srv://fixture:fixture-pass@cluster.example.test/app'), { env } = given({ id: 'app', type: found.type, fields: found.fields, secrets: found.secrets });
  assert.match(env.DATABASE_URL, /^mongodb\+srv:/);
});

test('each database engine gets the variables its own tools read', () => {
  const engine = (name, fields = {}) => given({ id: 'db', type: 'database', fields: { engine: name, host: 'db.example.net', ...fields }, secrets: { password: 'fixture-pass' } }).env;
  assert.deepEqual(engine('postgres'), { DATABASE_URL: 'postgres://:fixture-pass@db.example.net/', PGHOST: 'db.example.net', PGPORT: '5432', PGPASSWORD: 'fixture-pass' });
  assert.deepEqual(engine('mysql', { database: 'shop', username: 'root' }), { DATABASE_URL: 'mysql://root:fixture-pass@db.example.net/shop', MYSQL_HOST: 'db.example.net', MYSQL_TCP_PORT: '3306', MYSQL_PWD: 'fixture-pass' });
  assert.deepEqual(engine('redis', { port: 6380 }), { DATABASE_URL: 'redis://:fixture-pass@db.example.net:6380/', REDISCLI_AUTH: 'fixture-pass' });
  assert.deepEqual(engine('mongodb'), { DATABASE_URL: 'mongodb://:fixture-pass@db.example.net/' });
  assert.equal(engine('postgres', { host: '2001:db8::1', port: 5432 }).DATABASE_URL, 'postgres://:fixture-pass@[2001:db8::1]:5432/', 'an IPv6 host needs brackets');
});

test('AWS gives the standard variables, with the region under both names', () => {
  const input = { id: 'aws', type: 'aws', fields: { accessKeyId: 'AKIAFIXTURE', region: 'eu-west-1' }, secrets: { secretAccessKey: 'fixture-secret-key', sessionToken: 'fixture-session' } };
  assert.deepEqual(given(input), { env: { AWS_ACCESS_KEY_ID: 'AKIAFIXTURE', AWS_REGION: 'eu-west-1', AWS_SECRET_ACCESS_KEY: 'fixture-secret-key', AWS_SESSION_TOKEN: 'fixture-session', AWS_DEFAULT_REGION: 'eu-west-1' }, files: [], masks: ['fixture-secret-key', 'fixture-session'] });
  assert.deepEqual(given({ id: 'aws', type: 'aws', fields: { accessKeyId: 'AKIAFIXTURE' }, secrets: { secretAccessKey: 'fixture-secret-key' } }).env, { AWS_ACCESS_KEY_ID: 'AKIAFIXTURE', AWS_SECRET_ACCESS_KEY: 'fixture-secret-key' }, 'nothing is invented for what was not saved');
  assert.deepEqual(deliveredNames(normalize(input)).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_DEFAULT_REGION', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);
});

test('a Google Cloud key is delivered as a file, never as a variable', () => {
  const json = JSON.stringify({ type: 'service_account', private_key: 'fixture-private-key' });
  const { env, files, masks } = given({ id: 'gcp', type: 'gcp', fields: { project: 'fixture-project', clientEmail: 'fixture@example.test' }, secrets: { serviceAccount: json } });
  assert.deepEqual(env, { GOOGLE_CLOUD_PROJECT: 'fixture-project' });
  assert.deepEqual(files, [{ env: 'GOOGLE_APPLICATION_CREDENTIALS', name: 'service-account.json', content: json }]);
  assert.deepEqual(masks, [json]);
  assert.deepEqual(deliveredNames(normalize({ id: 'gcp', type: 'gcp', fields: { project: 'fixture-project' }, secrets: { serviceAccount: json } })), ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS']);
});

test('a kubeconfig is delivered as a file', () => {
  const config = 'apiVersion: v1\nkind: Config\nclusters: []\n', input = { id: 'kube', type: 'kubernetes', fields: {}, secrets: { kubeconfig: config }, env: {} };
  const { env, files } = delivery(input);
  assert.deepEqual(env, {});
  assert.deepEqual(files, [{ env: 'KUBECONFIG', name: 'kubeconfig', content: config }]);
  assert.deepEqual(deliveredNames(input), ['KUBECONFIG']);
});

test('the file type names its file and its variable', () => {
  const content = 'fixture certificate text\nsecond line\n', input = { id: 'tls-cert', type: 'file', fields: { filename: 'cert.pem' }, secrets: { content } };
  assert.deepEqual(given(input), { env: {}, files: [{ env: 'TLS_CERT_FILE', name: 'cert.pem', content }], masks: [content] });
  assert.equal(given({ id: 'tls-cert', type: 'file', secrets: { content } }).files[0].name, 'credential');
  assert.equal(given({ ...input, env: { content: 'CERT_PATH' } }).files[0].env, 'CERT_PATH');
  assert.equal(given(input, { rename: 'ONE_OFF' }).files[0].env, 'ONE_OFF');
  assert.deepEqual(deliveredNames(normalize(input)), ['TLS_CERT_FILE']);
});

test('custom gives each variable under its own name and hides only the secret ones', () => {
  const input = { id: 'mixed', type: 'custom', fields: { REGION: 'eu-west-1' }, secrets: { API_KEY: 'fixture-key', OTHER: 'fixture-other' } };
  assert.deepEqual(given(input), { env: { REGION: 'eu-west-1', API_KEY: 'fixture-key', OTHER: 'fixture-other' }, files: [], masks: ['fixture-key', 'fixture-other'] });
  assert.deepEqual(deliveredNames(normalize(input)), ['REGION', 'API_KEY', 'OTHER']);
});

test('a registry gives its token and optional username', () => {
  const input = { id: 'npm', type: 'registry', fields: { username: 'fixture-user' }, secrets: { token }, env: { token: 'NPM_TOKEN' } };
  assert.deepEqual(given(input).env, { NPM_USERNAME: 'fixture-user', NPM_TOKEN: token });
});

test('an SSH password goes through askpass, and an SSH key through nothing a command can see', () => {
  const password = { id: 'box', type: 'ssh', fields: { host: 'example.test', username: 'deploy', auth: 'password' }, secrets: { password: 'fixture-pass' } };
  const askpass = '/synthetic/askpass.sh';
  assert.deepEqual(given(password, { askpass }), { env: { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 't3-vault' }, files: [{ env: 'T3_CREDENTIAL_PASSWORD_FILE', name: 'ssh-password', content: 'fixture-pass' }], masks: ['fixture-pass'] });
  assert.equal(given(password, { askpass, base: { DISPLAY: ':1' } }).env.DISPLAY, ':1', 'a real display is left alone');
  assert.deepEqual(deliveredNames(normalize(password)), [], 'the plumbing isn\'t something to tell an agent about');
  const key = { id: 'box', type: 'ssh', fields: { host: 'example.test', username: 'deploy', auth: 'key' }, secrets: { privateKey: 'fixture-key-text\n' } };
  assert.deepEqual(given(key, { askpass }), { env: {}, files: [], masks: ['fixture-key-text\n'] });
  assert.deepEqual(deliveredNames(normalize(key)), []);
});

test('deliveredNames needs no real secrets, so it can\'t leak any', () => {
  const credential = normalize({ id: 'app-db', type: 'database', fields: { engine: 'postgres', host: 'x.test' }, secrets: { password: 'fixture-pass' } });
  assert.equal(JSON.stringify(deliveredNames(credential)).includes('fixture-pass'), false);
  assert.deepEqual(secretValues(credential), ['fixture-pass']);
  assert.deepEqual(secretValues({ secrets: { a: '', b: undefined, c: 'kept' } }), ['kept']);
  assert.deepEqual(secretValues({}), []);
  assert.deepEqual(deliveredNames({ id: 'x', type: 'token', fields: {} }), [], 'a public row with no secrets also works');
});

// ---- git, for real ----------------------------------------------------------
async function gitHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-vault-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { cwd: root, env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } };
}
const git = ({ cwd, env }, extra, args, input) => spawnSync('git', args, { cwd, env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 10000 });
const fill = (context, extra, host = 'github.com') => git(context, extra, ['credential', 'fill'], `protocol=https\nhost=${host}\n\n`);
const answers = text => Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const github = { id: 'github', type: 'git', fields: { host: 'github.com', username: 'fixture-user' }, secrets: { token } };

test('git asks the delivered helper and gets the saved username and token', async t => {
  const context = await gitHome(t), { env } = given(github);
  const answer = fill(context, env);
  assert.equal(answer.status, 0, answer.stderr);
  assert.deepEqual(answers(answer.stdout), { protocol: 'https', host: 'github.com', username: 'fixture-user', password: token });
  assert.equal(env.GH_TOKEN, undefined); assert.equal(env.GIT_TOKEN, token);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0', 'git never stops to ask a person');
  assert.equal(Object.entries(env).filter(([name]) => name.startsWith('GIT_CONFIG_')).some(([, value]) => value.includes(token)), false, 'the token is never in config, which ps could show');
  assert.deepEqual(deliveredNames(normalize(github)), ['GIT_TOKEN'], 'git\'s plumbing is hidden from the list');
});

test('with no username saved, git gets the one every host accepts for a token', async t => {
  const context = await gitHome(t), { env } = given({ ...github, fields: { host: 'github.com' } });
  assert.equal(answers(fill(context, env).stdout).username, 'x-access-token');
});

test('the token goes only to the saved host', async t => {
  const context = await gitHome(t), { env } = given(github);
  const answer = fill(context, env, 'gitlab.com');
  assert.notEqual(answer.status, 0);
  assert.equal((answer.stdout + answer.stderr).includes(token), false);
  assert.match(answer.stderr, /terminal prompts disabled|could not read/i);
  const plain = git(context, env, ['credential', 'fill'], 'protocol=http\nhost=github.com\n\n');
  assert.notEqual(plain.status, 0, 'and only over HTTPS');
  assert.equal((plain.stdout + plain.stderr).includes(token), false);
});

test('an existing GIT_CONFIG_COUNT is added to, so the caller\'s settings keep working', async t => {
  const context = await gitHome(t);
  const base = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Fixture Person' };
  const { env } = given(github, { base });
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(Object.hasOwn(env, 'GIT_CONFIG_KEY_0'), false, 'the caller\'s own entry is left where it is');
  const merged = { ...base, ...env };
  assert.equal(git(context, merged, ['config', '--get', 'user.name']).stdout.trim(), 'Fixture Person');
  assert.equal(answers(fill(context, merged).stdout).password, token);
  // A nonsense count is treated as none rather than producing a broken config.
  assert.equal(given(github, { base: { GIT_CONFIG_COUNT: 'lots' } }).env.GIT_CONFIG_COUNT, '2');
});

test('a credential helper someone already has doesn\'t get asked for this host', async t => {
  const context = await gitHome(t), marker = path.join(context.cwd, 'asked');
  const base = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: `!f() { echo called >> "${marker}"; echo username=wrong; echo password=wrong; }; f` };
  const { env } = given(github, { base });
  const answer = answers(fill(context, { ...base, ...env }).stdout);
  assert.deepEqual([answer.username, answer.password], ['fixture-user', token]);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(answers(fill(context, { ...base, ...env }, 'example.test').stdout).password, 'wrong', 'other hosts still use it');
});

test('two git credentials can be used together, each answering for its own host', async t => {
  const context = await gitHome(t);
  const first = { ...github, id: 'github-one' }, second = { ...github, id: 'gitlab-two', fields: { host: 'gitlab.com', username: 'oauth2' }, secrets: { token: 'fixture-second-git-token' } };
  const firstEnv = delivery(first, { base: {} }).env, secondEnv = delivery(second, { base: firstEnv }).env;
  const env = { ...firstEnv, ...secondEnv };
  assert.equal(answers(fill(context, env).stdout).password, first.secrets.token);
  assert.equal(answers(fill(context, env, 'gitlab.com').stdout).password, second.secrets.token);
  assert.equal(answers(fill(context, env, 'gitlab.com').stdout).username, 'oauth2');
});
