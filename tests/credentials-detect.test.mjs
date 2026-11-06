// What a pasted value is taken for. Every value here is an obvious fixture, and
// the ones shaped like a real provider's token are assembled at run time so a
// secret scanner reading this file has nothing to match.
import assert from 'node:assert/strict';
import test from 'node:test';
import { detect } from '../docker/setup/credentials/detect.mjs';
import { normalize } from '../docker/setup/credentials/model.mjs';

const FILL = 'fixture0000000000000000fixture';
const keyLines = [['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '), 'Zml4dHVyZS1wcml2YXRlLWtleS1maXJzdC1saW5lLW9mLXRoZS1ib2R5LXRoYXQtaXMtbG9u', 'Zy1lbm91Z2gtdG8td3JhcA==', ['-----END', 'OPENSSH PRIVATE KEY-----'].join(' ')];
const accessKey = 'AKIA' + 'FIXTURE00000FIXT', secretKey = 'fixtureSecretAccessKey/0000+fixture=';

const tokens = [
  ['a classic GitHub token', 'ghp_' + FILL, 'git', 'github', 'GH_TOKEN', { host: 'github.com', username: 'x-access-token', baseUrl: 'https://api.github.com/', testPath: 'user', authType: 'bearer' }],
  ['a GitHub server token', 'ghs_' + FILL, 'git', 'github', 'GH_TOKEN', { host: 'github.com' }],
  ['a fine-grained GitHub token', 'github_pat_' + FILL, 'git', 'github', 'GH_TOKEN', { host: 'github.com' }],
  ['a GitLab token', 'glpat-' + FILL, 'git', 'gitlab', 'GITLAB_TOKEN', { host: 'gitlab.com', username: 'oauth2', baseUrl: 'https://gitlab.com/api/v4/', authType: 'header', authName: 'PRIVATE-TOKEN', testPath: 'user' }],
  ['an Anthropic key', 'sk-ant-' + FILL, 'token', 'anthropic', 'ANTHROPIC_API_KEY', { baseUrl: 'https://api.anthropic.com/v1/', authType: 'header', authName: 'x-api-key', testPath: 'models' }],
  ['an OpenAI project key', 'sk-proj-' + FILL, 'token', 'openai', 'OPENAI_API_KEY', { baseUrl: 'https://api.openai.com/v1/', authType: 'bearer', testPath: 'models' }],
  ['an OpenAI service account key', 'sk-svcacct-' + FILL, 'token', 'openai', 'OPENAI_API_KEY', { baseUrl: 'https://api.openai.com/v1/' }],
  ['an OpenAI admin key', 'sk-admin-' + FILL, 'token', 'openai', 'OPENAI_API_KEY', { baseUrl: 'https://api.openai.com/v1/' }],
  ['a Stripe live key', 'sk_' + 'live_' + FILL, 'token', 'stripe', 'STRIPE_API_KEY', { baseUrl: 'https://api.stripe.com/v1/', authType: 'bearer', testPath: 'balance' }],
  ['a Stripe restricted test key', 'rk_' + 'test_' + FILL, 'token', 'stripe', 'STRIPE_API_KEY', { baseUrl: 'https://api.stripe.com/v1/' }],
  ['a Slack bot token', 'xoxb-' + FILL, 'token', 'slack', 'SLACK_TOKEN', { baseUrl: 'https://slack.com/api/', testPath: 'auth.test' }],
  ['a Slack user token', 'xoxp-' + FILL, 'token', 'slack', 'SLACK_TOKEN', { baseUrl: 'https://slack.com/api/' }],
  ['an npm token', 'npm_' + FILL, 'registry', 'npm', 'NPM_TOKEN', { baseUrl: 'https://registry.npmjs.org/', testPath: '-/whoami' }],
];
for (const [name, value, type, id, env, fields] of tokens) test('detects ' + name, () => {
  for (const pasted of [value, '  ' + value + '\n']) {
    const found = detect(pasted);
    assert.equal(found.type, type); assert.equal(found.id, id); assert.equal(found.confident, true);
    assert.deepEqual(found.secrets, { token: value });
    assert.deepEqual(found.env, { token: env });
    for (const [key, expected] of Object.entries(fields)) assert.equal(found.fields[key], expected, key);
    assert.match(found.label, /^an? /);
  }
  // Whatever detection suggests has to be something the store accepts as it is.
  const { fields: suggested, secrets, env: names } = detect(value), saved = normalize({ id, type, fields: suggested, secrets, env: names });
  assert.equal(saved.secrets.token, value);
  assert.equal(saved.env.token, env);
});

test('a bare sk- key could belong to anyone, so it gets no address', () => {
  // OpenRouter, DeepSeek and most AI gateways use this prefix too. An address here
  // would send the key to OpenAI the first time someone presses Test.
  for (const value of ['sk-' + FILL, 'sk-or-v1-' + FILL, 'sk-gateway-' + FILL]) {
    const found = detect(value);
    assert.equal(found.confident, false, value); assert.equal(found.id, ''); assert.deepEqual(found.fields, {}); assert.deepEqual(found.env, {});
    assert.deepEqual(found.secrets, { token: value });
  }
});

test('a token too short to be a real one of its kind falls back to a plain token', () => {
  for (const value of ['ghp_short', 'sk-short', 'glpat-short', 'npm_short', 'xoxb-short']) {
    const result = detect(value);
    assert.equal(result.type, 'token'); assert.equal(result.confident, false); assert.equal(result.id, '');
    assert.deepEqual(result.secrets, { token: value });
  }
});

test('detects an OpenSSH private key with its line breaks, and with them removed', () => {
  const normal = keyLines.join('\n') + '\n';
  for (const [name, pasted] of [['as a file', normal], ['with Windows line ends', keyLines.join('\r\n')], ['with spaces for line breaks', keyLines.join(' ')], ['on one line', keyLines.join('')]]) {
    const result = detect(pasted);
    assert.equal(result.type, 'ssh', name); assert.equal(result.confident, true, name); assert.equal(result.id, '', name);
    assert.deepEqual(result.fields, { auth: 'key' }, name);
    assert.deepEqual(Object.keys(result.secrets), ['privateKey'], name);
    assert.equal(result.secrets.privateKey.split('\n')[0], keyLines[0], name);
    assert.equal(result.secrets.privateKey.split('\n').at(-2), keyLines.at(-1), name);
    assert.equal(result.secrets.privateKey.endsWith('\n'), true, name);
    assert.ok(result.secrets.privateKey.split('\n').every(line => line.length <= 70 || line.startsWith('-----')), name);
  }
  assert.equal(detect(keyLines.join('')).secrets.privateKey, detect(keyLines.join(' ')).secrets.privateKey);
});

test('detects a Google Cloud service account key and keeps the JSON exactly', () => {
  const key = JSON.stringify({ type: 'service_account', project_id: 'Fixture_Project.1', client_email: 'fixture@fixture-project.iam.gserviceaccount.com', private_key: 'fixture-private-key-text' }, null, 2);
  const result = detect(key + '\n');
  assert.equal(result.type, 'gcp'); assert.equal(result.confident, true); assert.equal(result.id, 'fixture-project-1');
  assert.deepEqual(result.fields, { project: 'Fixture_Project.1', clientEmail: 'fixture@fixture-project.iam.gserviceaccount.com' });
  assert.deepEqual(result.secrets, { serviceAccount: key });
  assert.equal(normalize({ id: result.id, type: result.type, fields: result.fields, secrets: result.secrets }).secrets.serviceAccount, key);
  assert.equal(detect(JSON.stringify({ type: 'service_account', private_key: 'fixture' })).id, 'google-cloud');
  for (const other of [{ type: 'authorized_user', private_key: 'fixture' }, { type: 'service_account' }]) assert.notEqual(detect(JSON.stringify(other, null, 2)).type, 'gcp');
});

test('detects a kubeconfig and leaves other YAML alone', () => {
  const config = 'apiVersion: v1\nkind: Config\nclusters:\n- name: fixture\n  cluster:\n    server: https://example.test\nusers:\n- name: fixture\n  user:\n    token: fixture-kube-token\n';
  const result = detect(config);
  assert.equal(result.type, 'kubernetes'); assert.equal(result.id, 'kubernetes'); assert.equal(result.confident, true);
  assert.deepEqual(result.secrets, { kubeconfig: config.trim() });
  for (const other of ['apiVersion: v1\nkind: Pod\nmetadata:\n  name: fixture\n', 'apiVersion: v1\nkind: Config\nusers: []\n']) assert.notEqual(detect(other).type, 'kubernetes', other);
});

test('detects database URLs and decodes percent-encoded parts', () => {
  const postgres = detect('postgres://app%20user:p%40ss%2Fw%3Ard%25@db.example.net:5433/my_db?sslmode=require');
  assert.equal(postgres.type, 'database'); assert.equal(postgres.confident, true); assert.equal(postgres.id, 'my-db-db'); assert.match(postgres.label, /PostgreSQL/);
  assert.deepEqual(postgres.fields, { engine: 'postgres', host: 'db.example.net', port: 5433, database: 'my_db', username: 'app user', options: 'sslmode=require' });
  assert.deepEqual(postgres.secrets, { password: 'p@ss/w:rd%' });
  const mysql = detect('mysql://root:fixture%21pass@127.0.0.1:3306/shop');
  assert.equal(mysql.fields.engine, 'mysql'); assert.equal(mysql.fields.host, '127.0.0.1'); assert.equal(mysql.id, 'shop-db'); assert.match(mysql.label, /MySQL/);
  assert.equal(mysql.fields.port, 3306, 'even when it is the default');
  assert.deepEqual(mysql.secrets, { password: 'fixture!pass' });
  for (const [url, engine] of [['postgresql://h/d', 'postgres'], ['mariadb://h/d', 'mysql'], ['mongodb://h/d', 'mongodb'], ['mongodb+srv://h/d', 'mongodb'], ['redis://h/0', 'redis'], ['rediss://h/0', 'redis']]) assert.equal(detect(url).fields.engine, engine, url);
  assert.equal(detect('redis://:fixture-pass@cache.example.net').id, 'redis', 'no database name means the engine names it');
  assert.deepEqual(detect('postgres://only-host.example.net/db').secrets, {}, 'no password means nothing secret');
  // A bad escape is kept as written rather than lost.
  assert.deepEqual(detect('postgres://u:100%pass@h/d').secrets, { password: '100%pass' });
  assert.notEqual(detect('https://example.com/path').type, 'database');
});

test('detects AWS credentials as a credentials block and as variables', () => {
  const asFile = detect(`[default]\naws_access_key_id = ${accessKey}\naws_secret_access_key = ${secretKey}\nregion = eu-west-1\n`);
  assert.equal(asFile.type, 'aws'); assert.equal(asFile.id, 'aws'); assert.equal(asFile.confident, true);
  assert.deepEqual(asFile.fields, { accessKeyId: accessKey, region: 'eu-west-1' });
  assert.deepEqual(asFile.secrets, { secretAccessKey: secretKey });
  const asVariables = detect(`export AWS_ACCESS_KEY_ID="${accessKey}"\nexport AWS_SECRET_ACCESS_KEY="${secretKey}"\nexport AWS_SESSION_TOKEN=fixtureSessionToken\nAWS_DEFAULT_REGION=us-east-1\n`);
  assert.deepEqual(asVariables.fields, { accessKeyId: accessKey, region: 'us-east-1' });
  assert.deepEqual(asVariables.secrets, { secretAccessKey: secretKey, sessionToken: 'fixtureSessionToken' });
  const bare = detect(accessKey);
  assert.equal(bare.type, 'aws'); assert.deepEqual(bare.fields, { accessKeyId: accessKey }); assert.deepEqual(bare.secrets, {}, 'an access key ID is not the secret half');
  assert.equal(normalize({ id: 'aws', type: 'aws', fields: asVariables.fields, secrets: asVariables.secrets }).secrets.sessionToken, 'fixtureSessionToken');
  assert.notEqual(detect(`aws_access_key_id = ${accessKey}\nnothing else here`).type, 'aws');
});

test('detects .env lines, treating every value as secret', () => {
  const result = detect('# a comment\nAPI_KEY=fixture-key\n\nexport REGION="eu-west-1"\nQUOTED=\'with space\'\nURL=https://example.com/?a=b\n');
  assert.equal(result.type, 'custom'); assert.equal(result.confident, true); assert.equal(result.id, '');
  assert.deepEqual(result.fields, {}, 'nothing is shown on the page until someone says it may be');
  assert.deepEqual(result.secrets, { API_KEY: 'fixture-key', REGION: 'eu-west-1', QUOTED: 'with space', URL: 'https://example.com/?a=b' });
  assert.deepEqual(detect('export ONLY_ONE=fixture').secrets, { ONLY_ONE: 'fixture' });
  assert.equal(detect('ONLY_ONE=fixture').type, 'token', 'one line without export is most likely a value that has an equals sign in it');
  assert.equal(detect('fixtureBase64Value==').type, 'token');
  assert.equal(detect('API_KEY=fixture\nnot a variable\n').type, 'file', 'one bad line means this isn\'t an env file');
});

test('anything else gets a low-confidence guess the person can correct', () => {
  const token = detect('fixture-opaque-value');
  assert.deepEqual([token.type, token.confident, token.id, token.label], ['token', false, '', 'a token']); assert.deepEqual(token.secrets, { token: 'fixture-opaque-value' });
  const words = detect('correct horse battery fixture');
  assert.deepEqual([words.type, words.confident, words.label], ['login', false, 'a password']); assert.deepEqual(words.secrets, { password: 'correct horse battery fixture' });
  const file = detect('first line of a fixture\nsecond line of a fixture\n');
  assert.deepEqual([file.type, file.confident, file.label], ['file', false, 'a file']); assert.deepEqual(file.secrets, { content: 'first line of a fixture\nsecond line of a fixture\n' });
  for (const result of [token, words, file]) { assert.deepEqual(result.env, {}); assert.deepEqual(result.fields, {}); }
});

test('nothing pasted is nothing detected', () => {
  for (const empty of ['', '   ', '\n\t\n', null, undefined]) assert.equal(detect(empty), null);
});

test('a non-string is read as text instead of throwing', () => {
  assert.equal(detect(1234567890).type, 'token');
  assert.equal(detect({}).type, 'login');
});
