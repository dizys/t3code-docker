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
  assert.deepEqual(plain(S.gatewayState(gateway(), 0, relTime)), { tone: 'ok', label: 'Connected', desc: '14 models · checked 2 min ago', brief: '14 models · 2 min ago' });
  assert.equal(S.gatewayState(gateway({ check: { at: 1, ok: true, listed: false, count: 0 } }), 0, relTime).desc, 'Checked 2 min ago');
});

test('a gateway’s headline is whichever single thing matters most', () => {
  const failing = { at: 1, ok: false, code: 'unauthorized', message: 'The gateway turned this key down.' };
  assert.equal(S.gatewayState(gateway({ settling: true, check: failing }), 0, relTime).label, 'Connecting…');
  assert.equal(S.gatewayState(gateway({ check: failing }), 0, relTime).label, 'Key rejected');
  assert.equal(S.gatewayState(gateway({ key: { state: 'missing', credentialId: 'x' } }), 0, relTime).label, 'Key missing');
  assert.equal(S.gatewayState(gateway({ agents: [{ id: 'claude', state: 'drift' }] }), 0, relTime).label, 'Claude: changed');
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
  assert.deepEqual(plain(S.newModels(gateway({ latest: ['b', 'c'] }))), { added: ['c'], removed: ['a'], changed: [] });
  assert.deepEqual(plain(S.newModels(gateway())), { added: [], removed: [], changed: [] });
});

test('a capability-only change is reported as changed, not added or removed', () => {
  const over = { models: { ids: ['a', 'b'], capabilities: { a: { supported: true, effort: ['low'] } } },
    latest: ['a', 'b'], latestCapabilities: { a: { supported: true, effort: ['low', 'high'] } } };
  assert.deepEqual(plain(S.newModels(gateway(over))), { added: [], removed: [], changed: ['a'] });
});

test('context-only changes are pending even when the model IDs and reasoning stay the same', () => {
  const over = { models: { ids: ['a'], capabilities: { a: { limits: { context: 200000 } } } },
    latest: ['a'], latestCapabilities: { a: { limits: { context: 1048576 } } } };
  assert.deepEqual(plain(S.newModels(gateway(over))), { added: [], removed: [], changed: ['a'] });
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

test('a table cell says the state in a word or two', () => {
  assert.equal(S.cellState({ state: 'ready', models: 19 }).label, '19 models');
  assert.equal(S.cellState({ state: 'key-stale' }).label, 'Old key');
  assert.equal(S.cellState({ state: 'error' }).tone, 'danger');
  assert.equal(S.cellState({ state: 'starting' }).busy, true);
  assert.equal(S.cellState({ state: 'anything else' }).label, 'Unknown');
});

test('models land under the company that makes them, in a steady order', () => {
  const groups = plain(S.modelGroups(['muse-spark-1.3', 'gpt-6-sol', 'mystery-1', 'gemini-3-flash', 'claude-opus-5-5', 'codex-auto-review']));
  assert.deepEqual(groups.map(group => group.name), ['Anthropic', 'OpenAI', 'Google', 'Meta', 'Other']);
  assert.deepEqual(groups[1].models, ['gpt-6-sol', 'codex-auto-review']);
});

test('limits read as a count, or as what to do', () => {
  const account = driver => ({ driver });
  assert.equal(S.limitsState({ state: 'on', accounts: [account('claudeAgent'), account('codex'), account('codex')] }).label, '3 accounts');
  assert.equal(S.limitsState({ state: 'on', accounts: [account('claudeAgent'), account('codex'), account('codex')] }).desc, '1 Claude · 2 Codex');
  assert.match(S.limitsState({ state: 'on', accounts: [] }).desc, /no enabled accounts/);
  assert.equal(S.limitsState({ state: 'reading', accounts: [] }).busy, true);
  assert.equal(S.limitsState({ state: 'error', accounts: [], detail: 'Refused' }).desc, 'Refused');
  assert.equal(S.limitsState({ state: 'unknown', accounts: [] }).label, 'Limits unknown');
});

test('quota summaries distinguish missing data from exhausted quota across every provider', () => {
  const available = { driver: 'antigravity', windows: [{ left: 0 }] }, missing = { driver: 'opencode-go', windows: [], unavailable: { reason: 'probeFailed' } };
  assert.equal(S.limitsState({ state: 'partial', accounts: [available, missing] }).label, '1 of 2 reporting');
  assert.equal(S.limitsState({ state: 'unavailable', accounts: [missing] }).label, 'Quota unavailable');
  assert.equal(S.accountsLine([{ driver: 'claudeAgent' }, { driver: 'codex' }, available, { driver: 'muse' }, missing]), '1 Claude · 1 Codex · 1 Antigravity · 1 Muse Code · 1 OpenCode Go');
  assert.equal(S.resetLine({ resetsAt: '2026-11-08T05:00:00Z' }, Date.parse('2026-11-08T03:30:00Z')), 'Resets in 1h 30m');
  assert.equal(S.resetLine({ resetsAt: '2026-11-08T05:00:00Z' }, Date.parse('2026-11-08T06:00:00Z')), 'Reset due; refresh Limits');
  assert.equal(S.resetLine({ resetsAt: null }), 'Reset time unavailable');
  assert.equal(S.quotaLeft({ left: 0 }), '0% left');
  assert.equal(S.quotaLeft({ left: 0.2 }), '<1% left');
  assert.equal(S.quotaLeft({ left: 74.6 }), '75% left');
});

test('search finds a gateway by what someone remembers about it', () => {
  const row = { name: 'Team', host: 'llm.example.net', url: 'https://llm.example.net', preset: 'nope', models: { ids: ['gemini-3-flash'] } };
  for (const query of ['', 'team', 'LLM.EX', 'gemini']) assert.equal(S.matches(row, query), true, query);
  assert.equal(S.matches(row, 'absent'), false);
});

test('a gateway’s trouble is named, in the cells’ words', () => {
  const agents = states => states.map((state, index) => ({ id: ['claude', 'codex', 'opencode'][index], state }));
  assert.equal(S.gatewayState(gateway({ agents: agents(['key-stale']) }), 0, relTime).label, 'Claude: old key');
  assert.equal(S.gatewayState(gateway({ agents: agents(['key-stale', 'key-stale']) }), 0, relTime).label, 'Old key · 2 agents');
  assert.equal(S.gatewayState(gateway({ agents: agents(['key-stale', 'drift']) }), 0, relTime).label, '2 agents need a look');
});

test('a rejected key offers a new key, not another test', () => {
  const rejected = plain(S.attention([gateway({ check: { at: 1, ok: false, code: 'unauthorized', message: 'No.' } })]));
  assert.equal(rejected[0].action.name, 'replace-key');
  const down = plain(S.attention([gateway({ check: { at: 1, ok: false, code: 'refused', message: 'No.' } })]));
  assert.equal(down[0].action.name, 'test');
});

test('what’s left on an account reads like Usage → Limits', () => {
  assert.equal(S.windowsLine({ windows: [{ label: 'Session', left: 75 }, { label: 'Weekly', left: 60 }] }), 'Session 75% left · Weekly 60% left');
  assert.equal(S.windowsLine({}), '');
});
