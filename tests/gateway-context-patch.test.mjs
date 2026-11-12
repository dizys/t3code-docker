import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from './lib/strip-types.mjs';
import test from 'node:test';
import { assets, creates, files, patchGatewayContext } from '../docker/runtime/patches/gateway-context.mjs';
import { patches } from '../docker/runtime/patches/index.mjs';

const js = stripTypeScriptTypes(readFileSync(assets[0], 'utf8').replaceAll('export ', ''));
const { applyClaudeGatewayContext: apply, claudeGatewayContextKey: key } = new Function(`${js}\nreturn { applyClaudeGatewayContext, claudeGatewayContextKey };`)();
const environment = { T3_GATEWAY_MODEL_LIMITS: JSON.stringify({
  'gemini-large': { context: 1048576, output: 65536 },
  'gemini-small': { context: 128000, output: 8192 },
  'same-window': { context: 128000, output: 8192 },
}) };

test('Claude gets a selected route window without changing ids, shared settings, or compaction enablement', () => {
  const settings = { env: { KEEP: 'yes', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000' }, modelSettings: { other: { autoCompactWindow: 150000 } } };
  const before = structuredClone(settings);
  const result = apply(environment, 'gemini-large', settings);
  assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576');
  assert.equal(result.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '65536');
  assert.equal(result.env.KEEP, 'yes');
  assert.equal(result.env.DISABLE_COMPACT, undefined);
  assert.equal(result.modelSettings['gemini-large'].autoCompactWindow, 1000000);
  assert.equal(result.modelSettings['gemini-small'].autoCompactWindow, 128000, 'smaller native helpers must not use the parent window');
  assert.equal(result.modelSettings.other.autoCompactWindow, 150000);
  assert.equal(result.autoCompactWindow, 200000, 'unknown native helpers retain a conservative window');
  assert.deepEqual(settings, before);
  assert.equal(apply(environment, 'unknown', settings), settings);
  assert.equal(apply(environment, 'gemini-large', '/settings.json'), '/settings.json');
  assert.equal(apply(undefined, 'gemini-large', settings), settings);
});

test('Claude preserves earlier manual compaction and caps unrepresentable output limits', () => {
  const settings = { autoCompactWindow: 150000, modelSettings: { 'gemini-small': { autoCompactWindow: 100000, keep: true } } };
  const result = apply(environment, 'gemini-large', settings);
  assert.equal(result.modelSettings['gemini-large'].autoCompactWindow, 150000);
  assert.deepEqual(result.modelSettings['gemini-small'], { autoCompactWindow: 100000, keep: true });
  const env = { T3_GATEWAY_MODEL_LIMITS: JSON.stringify({ huge: { context: 2000000, output: 1000000 } }) };
  assert.equal(apply(env, 'huge').env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '128000');
});

test('a live Claude model switch is allowed only when process-scoped limits stay the same', () => {
  assert.notEqual(key(environment, 'gemini-large'), key(environment, 'gemini-small'));
  assert.notEqual(key(environment, 'gemini-large'), key(environment, 'unknown'));
  assert.equal(key(environment, 'gemini-small'), key(environment, 'same-window'));
  assert.equal(key({}, 'one'), key({}, 'two'));
});

test('malformed, inherited, and unreasonable gateway metadata cannot change Claude settings', () => {
  const settings = { keep: true };
  for (const raw of ['no', 'null', '[]', '{"x":{"context":"1048576"}}', '{"x":{"context":0}}', '{"x":{"context":10000001}}', ' '.repeat(256001)]) {
    assert.equal(apply({ T3_GATEWAY_MODEL_LIMITS: raw }, 'x', settings), settings);
  }
  for (const id of ['__proto__', 'constructor', 'toString']) assert.equal(apply(environment, id, settings), settings);
  const env = { T3_GATEWAY_MODEL_LIMITS: '{"x":{"context":200000,"output":200000,"input":300000}}' };
  assert.equal(apply(env, 'x').env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '200000');
  assert.equal(apply(env, 'x').env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
});

// Exact query construction and live-switch guards retained in upstream v0.1.9.
const source = {
  [files[0]]: `import * as DocumentText from "../../provider/DocumentText.ts";
  // A settings file path cannot take extra keys, so it goes through unchanged.
  const effectiveQuerySettings =
    input.toolSearchOverride === undefined || typeof compactQuerySettings === "string"
      ? compactQuerySettings
      : ({
          ...compactQuerySettings,
          env: { ...compactQuerySettings?.env, ENABLE_TOOL_SEARCH: input.toolSearchOverride },
        } as ClaudeSdkSettings);
            canApplyClaudeSelectionLive(existing.selection, compiledSelection) &&
            nextCondition`,
  [files[1]]: '  customModelCapabilityOverrides: Schema.optionalKey(Schema.Boolean),',
  [files[2]]: '          customModelCapabilityOverrides: true,',
};
test('the runtime contract includes the helper, initial settings, and switch guard and rejects upstream drift', () => {
  const result = patchGatewayContext(source);
  assert.match(result[files[0]], /input\.environment, compiledSelection\.apiModelId, compactQuerySettings/);
  assert.match(result[files[0]], /claudeGatewayContextKey\(adapterOptions\.environment, existing\.selection\.apiModelId\)/);
  assert.match(result[files[1]], /gatewayModelLimits: Schema.optionalKey\(Schema.Boolean\)/);
  assert.match(result[files[2]], /gatewayModelLimits: true/);
  assert.equal(result[creates[0]], readFileSync(assets[0], 'utf8'));
  assert.ok(patches.some(patch => patch.name === 'gateway-context' && patch.assets.includes(assets[0])));
  for (const file of files) assert.throws(() => patchGatewayContext({ ...source, [file]: '' }), /no longer matches/);
});

const nightlySettings = readFileSync(new URL('./fixtures/claude-query-settings-nightly.ts', import.meta.url), 'utf8');
const nightlySource = { ...source, [files[0]]: `import * as DocumentText from "../../provider/DocumentText.ts";\n${nightlySettings}\n            canApplyClaudeSelectionLive(existing.selection, compiledSelection) &&\n            nextCondition` };
const patchedNightly = patchGatewayContext(nightlySource)[files[0]];
const queryBlock = patchedNightly.slice(patchedNightly.indexOf('  const compactQuerySettings ='), patchedNightly.indexOf('\n            canApplyClaudeSelectionLive'));
const querySettings = new Function('applyClaudeGatewayContext', 'input', 'compiledSelection', 'querySettings', 'CLAUDE_CODE_MODEL_ALIASES', stripTypeScriptTypes(queryBlock) + '\nreturn effectiveQuerySettings;');
const makeSettings = ({ model = 'sonnet', environment, sdkSettings, settings, toolSearchOverride } = {}) => querySettings(apply, { environment, settings, toolSearchOverride }, { apiModelId: model }, sdkSettings, new Set(['sonnet', 'opus', 'haiku']));

test('current Nightly retains alias pinning and tool-search precedence together with gateway limits', () => {
  const environment = { T3_GATEWAY_MODEL_LIMITS: JSON.stringify({ sonnet: { context: 1048576, output: 65536 } }) };
  const sdkSettings = { env: { KEEP: 'yes', ANTHROPIC_DEFAULT_SONNET_MODEL: 'old', ENABLE_TOOL_SEARCH: 'false' } }, before = structuredClone(sdkSettings);
  const result = makeSettings({ environment, sdkSettings, toolSearchOverride: 'true' });
  assert.equal(result.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sonnet');
  assert.equal(result.env.ENABLE_TOOL_SEARCH, 'true');
  assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576');
  assert.equal(result.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '65536');
  assert.equal(result.env.KEEP, 'yes'); assert.deepEqual(sdkSettings, before);
  const noToolOverride = makeSettings({ environment, sdkSettings });
  assert.equal(noToolOverride.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sonnet');
  assert.equal(noToolOverride.env.ENABLE_TOOL_SEARCH, 'false');
});

test('current Nightly preserves native settings paths, manual compaction and routes without metadata', () => {
  assert.equal(makeSettings({ model: 'gemini-large', environment, sdkSettings: '/settings.json', toolSearchOverride: 'true' }), '/settings.json');
  const aliasEnvironment = { T3_GATEWAY_MODEL_LIMITS: JSON.stringify({ sonnet: { context: 1048576, output: 65536 } }) };
  assert.equal(makeSettings({ environment: aliasEnvironment, sdkSettings: '/settings.json', toolSearchOverride: 'true' }), '/settings.json');
  assert.equal(makeSettings({ model: 'ordinary', sdkSettings: undefined }), undefined);
  const settings = { env: { KEEP: 'yes' } };
  assert.equal(makeSettings({ model: 'ordinary', sdkSettings: settings }), settings);
  const alias = makeSettings({ sdkSettings: settings });
  assert.equal(alias.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sonnet'); assert.equal(alias.env.KEEP, 'yes');
  const compact = makeSettings({ model: 'gemini-large', environment, settings: { autoCompactWindow: '150000' } });
  assert.equal(compact.autoCompactWindow, 150000); assert.equal(compact.modelSettings['gemini-large'].autoCompactWindow, 150000);
});

test('unknown, duplicate and ambiguous Nightly settings layouts still fail the source guard', () => {
  for (const value of [
    nightlySource[files[0]].replace('...aliasOverrideEnv,', '...unreviewedAliasSettings,'),
    nightlySource[files[0]].replace(nightlySettings, nightlySettings + nightlySettings),
    nightlySource[files[0]] + '\n' + source[files[0]].slice(source[files[0]].indexOf('  // A settings file path')),
    nightlySource[files[0]] + nightlySettings + '\n' + source[files[0]].slice(source[files[0]].indexOf('  // A settings file path')),
  ]) assert.throws(() => patchGatewayContext({ ...nightlySource, [files[0]]: value }), /no longer matches/);
});
