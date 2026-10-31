import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const ctx = vm.createContext({ URL });
for (const file of ['routes', 'model', 'mcp-command', 'credential-model']) vm.runInContext(readFileSync(new URL('../docker/setup/client/' + file + '.js', import.meta.url), 'utf8'), ctx);
const S = vm.runInContext('T3CredentialModel', ctx), plain = value => JSON.parse(JSON.stringify(value));
const api = { id: 'project-api', type: 'api', baseUrl: 'https://api.example.test/v1', authType: 'header', authName: 'X-Key', authPrefix: 'Token', testPath: 'account' };
test('drafts only copy public editable fields and previews always mask the authentication value', () => {
  const draft = S.draftOf({ ...api, secret: 'never-copy-me', test: { detail: { secret: 'never-copy-me' } }, revision: 'never-copy-me' });
  assert.equal(JSON.stringify(draft).includes('never-copy-me'), false);
  assert.equal(S.request(draft, true), 'GET /v1/account\nHost: api.example.test\nX-Key: Token ••••••••\naccept: application/json');
  assert.match(S.request({ ...draft, authType: 'query', authName: 'api key' }), /api\+key=••••••••/);
  assert.equal(S.commands(draft)[0], 't3-api project-api GET account');
  assert.match(S.snippet(draft), /Don’t read or print credential files/);
});
test('draft validation mirrors saved path and authentication restrictions with field errors', () => {
  const valid = { ...S.draftOf(api), baseUrl: api.baseUrl };
  assert.deepEqual(plain(S.validate(valid, { secret: 'fixture' })), {});
  for (const [field, value] of [['id', 'Bad ID'], ['baseUrl', 'https://user:pass@example.com/v1/'], ['authName', 'Host'], ['authPrefix', 'Token\r\n'], ['testPath', '../escape'], ['testPath', '%2e%2e/escape']]) {
    assert.ok(S.validate({ ...valid, [field]: value }, { secret: 'fixture' })[field], field);
  }
  assert.match(S.validate(valid, { secret: 'fixture', names: ['project-api'] }).id, /taken/);
  assert.equal(S.validate(valid, { hasSecret: true, editing: true }).secret, undefined);
  assert.ok(S.validate(valid).secret);
});
test('result precedence, attention filtering and metadata searches agree with the server', () => {
  const profile = { ...api, hasSecret: true, test: { ok: false, code: 'timeout' } };
  assert.equal(Boolean(S.needsAttention(profile, [])), false);
  assert.equal(Boolean(S.needsAttention(profile, [{ id: profile.id }])), true);
  assert.equal(S.state({ id: 'server', type: 'ssh', hostKey: null, test: { code: 'ok' } }).code, 'host-key-untrusted');
  assert.equal(S.state(profile).action, 'Test');
  assert.equal(S.matches(profile, 'x-key'), true); assert.equal(S.matches(profile, 'api.example'), true); assert.equal(S.matches(profile, 'secret'), false);
  assert.deepEqual(plain(S.changes(api, { ...api, authName: 'X-Other', secretChangedAt: 'changed' })), ['authName']);
});
