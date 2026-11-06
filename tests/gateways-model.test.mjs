// Every sentence the Gateways page says, run the way the page runs it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runClassic } from '../docker/setup/page.mjs';
import { AGENTS, PRESETS, PROTOCOLS, UNSUPPORTED_AGENTS } from '../docker/setup/gateways/catalog.mjs';

const { T3GatewayModel: S } = runClassic(['client/gateway-model.js'], ['T3GatewayModel']);
S.setCatalog({ presets: PRESETS, agents: AGENTS, unsupported: UNSUPPORTED_AGENTS, protocols: PROTOCOLS });
// Objects from the page's sandbox aren't strictly equal to these, so compare their contents.
const plain = value => JSON.parse(JSON.stringify(value));
const relTime = () => '2 min ago';
const gateway = over => ({ agents: [], key: { state: 'saved' }, settling: false, check: { at: 1, ok: true, code: 'ok', listed: true, count: 14 }, models: { ids: ['a', 'b'] }, latest: null, ...over });

test('a healthy gateway says how many models it has and when that was read', () => {
  assert.deepEqual(plain(S.gatewayState(gateway(), 0, relTime)), { tone: 'ok', label: 'Connected', desc: '14 models · checked 2 min ago' });
  assert.equal(S.gatewayState(gateway({ check: { at: 1, ok: true, listed: false, count: 0 } }), 0, relTime).desc, 'Checked 2 min ago');
});

test('a gateway’s headline is whichever single thing matters most', () => {
  const failing = { at: 1, ok: false, code: 'unauthorized', message: 'The gateway turned this key down.' };
  assert.equal(S.gatewayState(gateway({ settling: true, check: failing }), 0, relTime).label, 'Connecting…');
  assert.equal(S.gatewayState(gateway({ check: failing }), 0, relTime).label, 'Key rejected');
  assert.equal(S.gatewayState(gateway({ key: { state: 'missing', credentialId: 'x' } }), 0, relTime).label, 'Key missing');
  assert.equal(S.gatewayState(gateway({ agents: [{ state: 'drift' }] }), 0, relTime).label, 'An agent needs a look');
  assert.equal(S.gatewayState(gateway({ agents: [{ state: 'drift' }, { state: 'error' }] }), 0, relTime).label, '2 agents need a look');
  assert.equal(S.gatewayState(gateway({ check: null }), 0, relTime).label, 'Not checked');
});

test('every agent state has a label, and each one that needs a person offers the action', () => {
  for (const state of ['ready', 'starting', 'off', 'warning', 'error', 'missing', 'paused', 'drift', 'key-stale', 'not-installed', 'unknown']) assert.ok(S.agentState({ state }).label, state);
  assert.deepEqual(['missing', 'paused', 'drift', 'key-stale', 'error'].map(state => S.agentState({ state }).action.name), ['apply', 'apply', 'apply', 'apply', 'apply']);
  assert.equal(S.agentState({ state: 'not-installed' }).action.name, 'install');
  assert.equal(S.agentState({ state: 'ready' }).action, undefined);
  assert.equal(S.needsAttention({ state: 'off' }), false);
  assert.equal(S.needsAttention({ state: 'warning' }), true);
});

test('an agent’s line names its protocol and models', () => {
  assert.equal(S.agentLine({ id: 'claude', connected: true, models: 4 }), 'Anthropic Messages · 4 models');
  assert.equal(S.agentLine({ id: 'codex', connected: false, models: 1 }), 'OpenAI Responses · 1 model');
  assert.equal(S.agentLine({ id: 'opencode', connected: false, models: 0 }), 'OpenAI Chat Completions');
});

test('models a check found are compared with what’s applied', () => {
  assert.deepEqual(plain(S.newModels(gateway({ latest: ['b', 'c'] }))), { added: ['c'], removed: ['a'] });
  assert.deepEqual(plain(S.newModels(gateway())), { added: [], removed: [] });
});

test('a test’s lines read in order, and only say what’s known', () => {
  const lines = S.checkLines({ ok: true, ms: 34, models: { listed: true, ids: ['a'] }, protocols: { messages: 'available', responses: 'missing', chat: 'unknown' } }, { keyed: true });
  assert.deepEqual(plain(lines.map(line => [line.tone, line.text])), [['ok', 'Reached in 34 ms'], ['ok', 'Key accepted'], ['ok', '1 model available'], ['ok', 'Anthropic Messages'], ['muted', 'No OpenAI Responses'], ['warn', 'Couldn’t confirm OpenAI Chat Completions']]);
  assert.equal(S.checkLines({ ok: true, ms: 1, models: { listed: false, ids: [] }, protocols: {} }, { keyed: false })[1].text, 'No key needed');
  assert.equal(S.checkLines({ ok: false }, {}).length, 0);
});

test('an agent is only blocked by what a test actually proved', () => {
  const [claude, codex] = AGENTS;
  assert.equal(S.availability(codex, { ok: true, protocols: { responses: 'missing' } }).usable, false);
  assert.match(S.availability(codex, { ok: true, protocols: { responses: 'missing' } }).reason, /OpenAI Responses API, which Codex needs/);
  assert.deepEqual(plain(S.availability(claude, { ok: true, protocols: { messages: 'unknown' }, offers: { claude: 3 } })), { usable: true, unconfirmed: true, offered: 3 });
  assert.equal(S.availability(claude, { ok: false, protocols: {}, offers: { claude: 0 } }).offered, null, 'a failed test doesn’t mean no models');
});

test('going past a failed test is offered when it might be temporary', () => {
  for (const code of ['refused', 'timeout', 'dns', 'tls', 'not-gateway', 'redirect']) assert.equal(S.canContinueAnyway({ ok: false, code }), true, code);
  for (const code of ['unauthorized', 'invalid']) assert.equal(S.canContinueAnyway({ ok: false, code }), false, code);
  assert.equal(S.canContinueAnyway({ ok: true }), false);
  assert.equal(S.canContinueAnyway(null), false);
});

test('a conflict says what it does, and where', () => {
  assert.equal(S.conflictSentence({ file: '~/.claude/settings.json', keys: ['ANTHROPIC_BASE_URL'], host: 'old:8080' }), '~/.claude/settings.json sends every Claude instance to old:8080, so a gateway here can’t take effect.');
  assert.match(S.conflictSentence({ file: 'f', keys: ['apiKeyHelper'], host: null }), /second key/);
  assert.match(S.conflictSentence({ file: 'f', keys: ['CLAUDE_CODE_USE_BEDROCK'], host: null }), /overrides every Claude instance/);
});

test('instance names match what T3 Code will show', () => {
  assert.deepEqual(plain(S.instanceNames(['claude', 'opencode'], 'Proxy')), ['Claude · Proxy', 'OpenCode · Proxy']);
});
