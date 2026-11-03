import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { publicTypes, envNames, resolveEnvName } from '../docker/setup/credentials/types.mjs';
import { normalize } from '../docker/setup/credentials/model.mjs';
const ctx = vm.createContext({ URL });
for (const file of ['routes', 'model', 'mcp-command', 'credential-model']) vm.runInContext(readFileSync(new URL('../docker/setup/client/' + file + '.js', import.meta.url), 'utf8'), ctx);
const S = vm.runInContext('T3CredentialModel', ctx), plain = value => JSON.parse(JSON.stringify(value));
// Templates reach the page over HTTP, so they have to survive JSON.
S.setTypes(plain(publicTypes()));
const api = { id: 'project-api', type: 'token', fields: { baseUrl: 'https://api.example.test/v1', authType: 'header', authName: 'X-Key', authPrefix: 'Token', testPath: 'account' } };
const setField = (draft, key, value) => ({ ...draft, fields: { ...draft.fields, [key]: value } });

test('drafts only copy public editable fields and previews always mask the authentication value', () => {
  const draft = S.draftOf({ ...api, secret: 'never-copy-me', secrets: { token: 'never-copy-me' }, test: { detail: { secret: 'never-copy-me' } }, revision: 'never-copy-me' });
  assert.equal(JSON.stringify(draft).includes('never-copy-me'), false);
  assert.equal(S.request(draft, true), 'GET /v1/account\nHost: api.example.test\nX-Key: Token ••••••••\naccept: application/json');
  assert.match(S.request(setField(setField(draft, 'authType', 'query'), 'authName', 'api key')), /api\+key=••••••••/);
  assert.deepEqual(plain(S.commands(draft)), ['t3-vault run project-api -- <command>', 't3-vault http project-api GET account']);
  assert.match(S.snippet(draft), /Don’t read or print credential files/);
  assert.equal(S.snippet(draft).includes('never-copy-me'), false);
});

test('commands and snippets follow what the server can actually do for each credential', () => {
  const box = { id: 'build-server', type: 'ssh', fields: { host: 'example.net', username: 'deploy', auth: 'key' } };
  assert.deepEqual(plain(S.commands(box)), ['ssh build-server uptime', 'scp app.tar build-server:/srv/']);
  assert.equal(S.commands(box, { aliases: false })[0], 't3-vault ssh build-server -- uptime');
  assert.match(S.snippet(box), /ssh build-server '<command>'/);
  assert.match(S.snippet(box, { aliases: false }), /t3-vault ssh build-server -- '<command>'/);
  assert.deepEqual(plain(S.commands({ id: 'plain', type: 'token', fields: {} })), ['t3-vault run plain -- <command>']);
  assert.match(S.snippet({ id: 'plain', type: 'token', delivers: ['PLAIN_TOKEN'], fields: {} }), /The command gets PLAIN_TOKEN/);
  assert.match(S.snippet({ ...api, fields: { ...api.fields, baseUrl: 'https://api.example.test/v1/' } }), /t3-vault http project-api POST <path> --stdin/);
});

test('draft validation mirrors saved path and authentication restrictions with field errors', () => {
  const valid = S.draftOf(api), secrets = { token: 'fixture' };
  assert.deepEqual(plain(S.validate(valid, { secrets })), {});
  assert.ok(S.validate({ ...valid, id: 'Bad ID' }, { secrets }).id);
  assert.match(S.validate({ ...valid, id: 'new' }, { secrets }).id, /reserved/);
  for (const [field, value] of [['baseUrl', 'https://user:pass@example.com/v1/'], ['authName', 'Host'], ['authPrefix', 'Token\r\n'], ['testPath', '../escape'], ['testPath', '%2e%2e/escape']]) {
    assert.ok(S.validate(setField(valid, field, value), { secrets })['fields.' + field], field);
  }
  assert.match(S.validate(valid, { secrets, names: ['project-api'] }).id, /taken/);
  assert.equal(S.validate(valid, { savedSecrets: ['token'], editing: true })['secrets.token'], undefined);
  assert.ok(S.validate(valid)['secrets.token']);
  assert.equal(S.validate(valid, { needSecret: false })['secrets.token'], undefined);
  assert.ok(S.validate({ ...valid, type: 'nothing-like-this' }).type);
});

test('the page and the server agree about what a credential may hold', () => {
  const server = input => { try { normalize(input); return true; } catch { return false; } };
  const page = (input, secrets) => Object.keys(S.validate({ ...S.draftOf(input), id: input.id }, { secrets })).length === 0;
  const cases = [
    [{ id: 'fine', type: 'token', fields: {} }, { token: 'fixture-value' }, true],
    [{ id: 'bad-env', type: 'token', fields: {}, env: { token: 'PATH' } }, { token: 'fixture-value' }, false],
    [{ id: 'box', type: 'ssh', fields: { host: '2001:db8::1', username: 'deploy', auth: 'password' } }, { password: 'fixture-value' }, true],
    [{ id: 'box', type: 'ssh', fields: { host: '-oProxyCommand=bad', username: 'deploy', auth: 'password' } }, { password: 'fixture-value' }, false],
    [{ id: 'box', type: 'ssh', fields: { host: 'example.net', username: 'user;bad', auth: 'password' } }, { password: 'fixture-value' }, false],
    [{ id: 'box', type: 'ssh', fields: { host: 'example.net', port: 70000, username: 'deploy', auth: 'password' } }, { password: 'fixture-value' }, false],
    [{ id: 'cloud', type: 'aws', fields: { accessKeyId: 'lowercase' } }, { secretAccessKey: 'fixture-value' }, false],
    [{ id: 'cloud', type: 'aws', fields: { accessKeyId: 'AKIAFIXTURE' } }, { secretAccessKey: 'fixture-value' }, true],
    [{ id: 'file', type: 'file', fields: { filename: '../escape' } }, { content: 'fixture-value' }, false],
    [{ id: 'long', type: 'token', fields: {} }, { token: 'x'.repeat(8193) }, false],
    [{ id: 'long', type: 'file', fields: {} }, { content: 'x'.repeat(48 * 1024 + 1) }, false],
  ];
  for (const [input, secrets, expected] of cases) {
    assert.equal(server({ ...input, secrets }), expected, 'server: ' + JSON.stringify(input));
    assert.equal(page(input, secrets), expected, 'page: ' + JSON.stringify(input));
  }
});

test('variables are named the same way on the page and on the server', () => {
  for (const type of publicTypes()) for (const entry of [...type.fields, ...type.secrets]) {
    if (!entry.env) continue;
    for (const id of ['cloudflare-token', 'prod', 'token', 'db-password']) {
      assert.equal(S.resolveEnvName(entry.env, id), resolveEnvName(entry.env, id));
      assert.equal(S.envFor({ id, env: {} }, entry), envNames({ id, type: type.id })[entry.key], type.id + ' ' + entry.key);
    }
  }
  assert.equal(resolveEnvName('{NAME}_TOKEN', 'cloudflare-token'), 'CLOUDFLARE_TOKEN');
  assert.equal(resolveEnvName('{NAME}_TOKEN', 'token'), 'TOKEN');
  assert.equal(resolveEnvName('{NAME}_TOKEN', 'stripe'), 'STRIPE_TOKEN');
  assert.equal(S.envFor({ id: 'stripe', env: { token: 'STRIPE_API_KEY' } }, { key: 'token', env: '{NAME}_TOKEN' }), 'STRIPE_API_KEY');
});

test('drafts and payloads hold only what each type needs, and a saved secret is never asked for again', () => {
  assert.deepEqual(plain(S.typeList()).map(type => type.id), ['ssh', 'token', 'login', 'database', 'aws', 'gcp', 'kubernetes', 'git', 'registry', 'file', 'custom']);
  assert.equal(S.typeLabel('nothing-like-this'), 'Credential'); assert.equal(S.badge('ssh'), 'SSH'); assert.equal(S.iconFor('nothing-like-this'), 'key-round');
  assert.equal(S.primarySecret('ssh', { auth: 'key' }).key, 'privateKey'); assert.equal(S.primarySecret('ssh', { auth: 'password' }).key, 'password');
  assert.equal(S.primarySecret('custom'), null);
  assert.deepEqual(plain(S.defaults('ssh').fields), { port: 22, auth: 'key' });
  const box = S.draftOf({ id: 'box', type: 'ssh', fields: { host: 'example.net', port: 22, username: 'deploy', auth: 'key', publicKey: 'ssh-ed25519 AAAA' } });
  const sent = plain(S.payload(box, { privateKey: '', password: 'ignored-empty-is-dropped' }));
  assert.equal(sent.fields.publicKey, undefined, 'a derived field is the server\'s to fill in');
  assert.equal(sent.fields.port, 22);
  assert.equal(sent.secrets.privateKey, undefined, 'an empty box keeps what is saved');
  const custom = S.draftOf({ id: 'mixed', type: 'custom', fields: { REGION: 'eu' }, secretNames: ['API_KEY'] });
  assert.deepEqual(plain(custom.vars), [{ name: 'REGION', value: 'eu', secret: false }, { name: 'API_KEY', value: '', secret: true, saved: true }]);
  assert.deepEqual(plain(S.validate(custom)), {});
  assert.deepEqual(plain(S.payload(custom)), { id: 'mixed', type: 'custom', description: '', fields: { REGION: 'eu' }, secretNames: ['API_KEY'], secrets: {} });
  assert.match(S.validate({ ...custom, vars: [] }).vars, /at least one/);
  assert.match(S.validate({ ...custom, vars: [{ name: 'PATH', value: 'x', secret: true }] }).vars, /letters, numbers/);
  assert.match(S.validate({ ...custom, vars: [{ name: 'SAME', value: 'x' }, { name: 'SAME', value: 'y' }] }).vars, /twice/);
  assert.match(S.validate({ ...custom, vars: [{ name: 'EMPTY', value: '', secret: true }] }).vars, /Enter a value/);
  assert.deepEqual(plain(S.givesPreview(S.draftOf({ id: 'app-db', type: 'database', fields: { engine: 'postgres', host: 'x' } }))), [{ name: 'DATABASE_URL' }, { name: 'PGPASSWORD' }]);
  assert.deepEqual(plain(S.givesPreview({ ...S.defaults('kubernetes'), id: 'kube' })), [{ name: 'KUBECONFIG', file: true }]);
  assert.deepEqual(plain(S.givesPreview({ ...S.defaults('custom'), vars: [{ name: 'ONE' }, { name: '' }] })), [{ name: 'ONE' }]);
});

test('result precedence, attention filtering and metadata searches agree with the server', () => {
  const profile = { ...api, hasSecret: true, test: { ok: false, code: 'timeout' } };
  assert.equal(Boolean(S.needsAttention(profile, [])), false);
  assert.equal(Boolean(S.needsAttention(profile, [{ id: profile.id }])), true);
  assert.equal(S.state({ id: 'server', type: 'ssh', fields: { auth: 'password' }, hostKey: null, test: { code: 'ok' } }).code, 'host-key-untrusted');
  assert.equal(S.state(profile).action, 'Test');
  assert.equal(S.matches(profile, 'x-key'), true); assert.equal(S.matches(profile, 'api.example'), true); assert.equal(S.matches(profile, 'secret'), false);
  assert.deepEqual(plain(S.changes(api, { ...api, fields: { ...api.fields, authName: 'X-Other' }, secretChangedAt: 'changed' })), ['authName']);
  assert.deepEqual(plain(S.changes({ fields: { auth: 'key', publicKey: 'a' } }, { fields: { auth: 'key', publicKey: 'b' } })), [], 'a derived key is not an edit');
});

test('a key sign-in that hasn\'t connected is not a problem, a password that hasn\'t been confirmed is', () => {
  const key = { id: 'key-box', type: 'ssh', fields: { auth: 'key', host: 'example.net' }, hostKey: null };
  assert.equal(S.state(key).code, 'not-connected'); assert.equal(Boolean(S.needsAttention(key, [])), false);
  const password = { id: 'old-box', type: 'ssh', fields: { auth: 'password', host: 'example.net' }, hostKey: null };
  assert.equal(S.state(password).code, 'host-key-untrusted'); assert.equal(Boolean(S.needsAttention(password, [])), true);
  assert.equal(Boolean(S.needsAttention({ ...key, hostKey: { fingerprint: 'x' }, test: { ok: false, code: 'host-key-changed' } }, [])), true);
  assert.equal(S.state({ id: 'plain', type: 'token', fields: {} }).code, 'no-test');
  assert.equal(S.state({ id: 'api', type: 'token', fields: { baseUrl: 'https://example.net/' } }).code, 'untested');
  assert.equal(S.state({ id: 'api', type: 'token', fields: { baseUrl: 'https://example.net/' } }, { busy: true }).code, 'testing');
  assert.equal(S.canTest({ type: 'ssh' }), true); assert.equal(S.canTest({ type: 'token', fields: {} }), false); assert.equal(S.canTest({ type: 'git', fields: { baseUrl: 'https://x/' } }), true);
});

test('each credential describes its target without revealing anything it shouldn\'t', () => {
  const rows = [
    [{ type: 'ssh', fields: { host: 'example.net', port: 22, username: 'deploy' } }, 'deploy@example.net'],
    [{ type: 'ssh', fields: { host: 'example.net', port: 2222, username: 'deploy' } }, 'deploy@example.net:2222'],
    [{ type: 'database', fields: { host: 'db.example.net', username: 'app', database: 'main' } }, 'app@db.example.net/main'],
    [{ type: 'aws', fields: { accessKeyId: 'AKIAFIXTUREFIXTURE', region: 'us-east-1' } }, 'AKIA…TURE · us-east-1'],
    [{ type: 'gcp', fields: { clientEmail: 'fixture@example.iam.gserviceaccount.com' } }, 'fixture@example.iam.gserviceaccount.com'],
    [{ type: 'token', env: { token: 'API_TOKEN' }, fields: { baseUrl: 'https://api.example.net/v1/' } }, 'API_TOKEN · api.example.net'],
    [{ type: 'git', env: { token: 'GH_TOKEN' }, fields: { host: 'github.com' } }, 'GH_TOKEN · github.com'],
    [{ type: 'custom', delivers: ['A', 'B', 'C', 'D', 'E', 'F'], fields: {} }, 'A, B, C, D and 2 more'],
    [{ type: 'kubernetes', delivers: ['KUBECONFIG'], fields: {} }, 'KUBECONFIG'],
  ];
  for (const [credential, text] of rows) assert.equal(S.target(credential), text);
  assert.equal(S.delivery({ type: 'kubernetes', delivers: ['KUBECONFIG'] }), 'Given to each command as a temporary file');
  assert.equal(S.delivery({ type: 'token', delivers: ['API_TOKEN'] }), 'API_TOKEN');
  assert.equal(S.kind({ type: 'ssh', fields: { auth: 'key' } }), 'Key'); assert.equal(S.kind({ type: 'ssh', fields: { auth: 'password' } }), 'Password');
  assert.equal(S.kind({ type: 'token', fields: {} }), null);
  assert.equal(S.kind({ type: 'token', fields: { baseUrl: 'x', authType: 'query', authName: 'key' } }), '?key');
  assert.equal(S.secretKind({ type: 'ssh', fields: { auth: 'key' } }), 'private key');
  assert.equal(S.originText({ origin: { by: 'agent' } }), 'Added by an agent'); assert.equal(S.originText({ origin: { by: 'terminal' } }), 'Added from a terminal'); assert.equal(S.originText({ origin: { by: 'setup' } }), null);
  assert.equal(S.threadUrl({ threadId: 'thread/1' }, 'env one'), '/env%20one/thread%2F1');
  assert.equal(S.threadUrl({ threadId: 'thread' }, null), null); assert.equal(S.threadUrl({}, 'env'), null);
  assert.equal(S.installLine('ssh-ed25519 AAAA'), "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAAA' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys");
});
