import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stripTypeScriptTypes } from './lib/strip-types.mjs';
import { files as claudeFiles, patchGatewayContext } from '../docker/runtime/patches/gateway-context.mjs';
import { files as opencodeFiles, patchOpenCodeSkills } from '../docker/runtime/patches/opencode-skills.mjs';
import { source as stableSource } from './fixtures/opencode-workspace-source.mjs';
import { normalizedSource } from './fixtures/opencode-workspace-normalized-source.mjs';
import { settledSource } from './fixtures/opencode-workspace-settled-source.mjs';
import { environmentSource } from './fixtures/opencode-workspace-environment-source.mjs';

const settingsFixture = readFileSync(new URL('./fixtures/claude-query-settings-nightly-4616.ts', import.meta.url), 'utf8');
const adapter = (settings) => `import * as DocumentText from "../../provider/DocumentText.ts";\n${settings}\n            canApplyClaudeSelectionLive(existing.selection, compiledSelection) &&\n            nextCondition`;
const claudeSource = {
  [claudeFiles[0]]: adapter(settingsFixture),
  [claudeFiles[1]]: '  customModelCapabilityOverrides: Schema.optionalKey(Schema.Boolean),',
  [claudeFiles[2]]: '          customModelCapabilityOverrides: true,',
};
const helper = readFileSync(new URL('../docker/runtime/patches/gateway-context.ts', import.meta.url), 'utf8');
const apply = new Function(stripTypeScriptTypes(helper.replaceAll('export ', '')) + '\nreturn applyClaudeGatewayContext;')();
function settingsFunction(source) {
  const start = source.indexOf('  const autoCompactWindow =');
  const end = source.indexOf('\n            canApplyClaudeSelectionLive', start);
  return new Function('applyClaudeGatewayContext', 'input', 'compiledSelection', 'querySettings', 'CLAUDE_CODE_MODEL_ALIASES',
    stripTypeScriptTypes(source.slice(start, end)) + '\nreturn effectiveQuerySettings;');
}
const upstreamSettings = settingsFunction(claudeSource[claudeFiles[0]]);
const patchedClaude = patchGatewayContext(claudeSource);
const patchedSettings = settingsFunction(patchedClaude[claudeFiles[0]]);
const aliases = new Set(['sonnet', 'opus', 'haiku']);
const evaluate = (fn, input = {}, sdkSettings, model = 'ordinary') => fn(apply, input, { apiModelId: model }, sdkSettings, aliases);
const gatewayEnvironment = { T3_GATEWAY_MODEL_LIMITS: JSON.stringify({ sonnet: { context: 1048576, output: 65536 } }) };

test('Nightly 4616 keeps upstream explicit-compaction, alias and tool-search precedence on gateway routes', () => {
  const input = { environment: gatewayEnvironment, settings: { autoCompactWindow: '150000' }, toolSearchOverride: 'true' };
  const sdkSettings = { env: { KEEP: 'yes', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000', ANTHROPIC_DEFAULT_SONNET_MODEL: 'old', ENABLE_TOOL_SEARCH: 'false' } };
  const before = structuredClone({ input, sdkSettings });
  const result = evaluate(patchedSettings, input, sdkSettings, 'sonnet');
  assert.equal(result.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '150000');
  assert.equal(result.autoCompactWindow, 150000);
  assert.equal(result.modelSettings.sonnet.autoCompactWindow, 150000);
  assert.equal(result.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sonnet');
  assert.equal(result.env.ENABLE_TOOL_SEARCH, 'true');
  assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576');
  assert.equal(result.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '65536');
  assert.equal(result.env.KEEP, 'yes');
  assert.deepEqual({ input, sdkSettings }, before);
});

test('Nightly 4616 leaves inherited compaction environment alone when no window was requested', () => {
  for (const settings of [undefined, { autoCompactWindow: '' }]) {
    const sdkSettings = { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '125000', ENABLE_TOOL_SEARCH: 'false' } };
    const result = evaluate(patchedSettings, { environment: gatewayEnvironment, settings }, sdkSettings, 'sonnet');
    assert.equal(result.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '125000');
    assert.equal(result.env.ENABLE_TOOL_SEARCH, 'false');
    assert.equal(result.autoCompactWindow, 200000);
    assert.equal(result.modelSettings.sonnet.autoCompactWindow, 1000000);
  }
});

test('Nightly 4616 matches exact upstream settings behavior without gateway metadata', () => {
  for (const model of ['ordinary', 'sonnet']) {
    for (const window of [undefined, '', '175000']) {
      for (const sdkSettings of [undefined, '/settings.json', { env: { KEEP: 'yes', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' } }]) {
        const input = { settings: { autoCompactWindow: window }, toolSearchOverride: 'false' };
        assert.deepEqual(evaluate(patchedSettings, input, sdkSettings, model), evaluate(upstreamSettings, input, sdkSettings, model));
      }
    }
  }
  assert.equal(evaluate(patchedSettings, { environment: gatewayEnvironment }, '/settings.json', 'sonnet'), '/settings.json');
});

test('Nightly 4616 rejects unknown, duplicate or ambiguous Claude compaction initializers', () => {
  const before = structuredClone(claudeSource);
  const oldSettings = readFileSync(new URL('./fixtures/claude-query-settings-nightly.ts', import.meta.url), 'utf8');
  for (const settings of [
    settingsFixture.replace('CLAUDE_CODE_AUTO_COMPACT_WINDOW:', 'UNREVIEWED_COMPACTION_WINDOW:'),
    settingsFixture.replace('autoCompactWindow === undefined) ||', 'autoCompactWindow == null) ||'),
    settingsFixture + settingsFixture,
    settingsFixture + oldSettings,
  ]) assert.throws(() => patchGatewayContext({ ...claudeSource, [claudeFiles[0]]: adapter(settings) }), /no longer matches/);
  assert.deepEqual(claudeSource, before);
  assert.throws(() => patchGatewayContext(patchedClaude), /no longer matches/);
});

const patchedOpenCode = patchOpenCodeSkills(environmentSource);
function workspaceLoader(Effect, resolveProviderProbeTimeoutMs) {
  const status = patchedOpenCode[opencodeFiles[1]];
  const start = status.indexOf('  function* '), end = status.indexOf('\n);', start);
  const fn = status.slice(start, end).trim().replace(/,$/, '');
  return new Function('Effect', 'resolveProviderProbeTimeoutMs', stripTypeScriptTypes(`const load = ${fn};`) + '\nreturn load;')(Effect, resolveProviderProbeTimeoutMs);
}

test('Nightly 4616 driver passes the exact provider environment to native workspace readiness', () => {
  const processEnv = { PROVIDER_MARKER: 'instance-local' }, calls = [];
  const scanned = { pipe(...steps) { assert.equal(steps.length, 2); return this; } };
  const read = { skills: 'skills', commands: 'commands' };
  const Effect = {
    repeat(options) {
      const plugin = (id, status = 'active') => ({ id, state: { status } });
      assert.equal(options.until({ data: [plugin('opencode.config.skill')] }), false);
      assert.equal(options.until({ data: [plugin('opencode.config.skill'), plugin('opencode.config.command', 'loading')] }), false);
      assert.equal(options.until({ data: [plugin('opencode.config.skill'), plugin('opencode.config.command')] }), true);
      return options;
    },
    asVoid: Symbol('void'), scoped: Symbol('scope'), map: (fn) => fn,
    all(value, options) { assert.deepEqual(value, read); assert.equal(options.concurrency, 'unbounded'); return read; },
    gen(fn) { return { pipe(scope) { assert.equal(scope, Effect.scoped); return fn(); } }; },
  };
  const client = {
    plugin: { list({ location }) { assert.deepEqual(location, { directory: '/resolved/project' }); return scanned; } },
    skill: { list() { return { pipe() { return 'skills'; } }; } },
    command: { list() { return { pipe() { return 'commands'; } }; } },
  };
  const driver = patchedOpenCode[opencodeFiles[0]].replace(/^import[^\n]*\n/gm, '');
  const list = new Function('openCode2Server', 'Effect', 'pathService', 'Schedule', 'processEnv', 'loadOpenCode2Workspace',
    stripTypeScriptTypes(driver) + '\nreturn listOpenCode2Workspace;')(
      { withConnection: (fn) => fn({ client }) }, Effect,
      { resolve: () => '/resolved/project' }, { spaced: () => 'poll' }, processEnv,
      function* (...args) { calls.push(args); return 'inventory'; },
    );
  assert.deepEqual(list('/project').next(), { value: 'inventory', done: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [read, scanned, processEnv]);
  assert.equal(calls[0][2], processEnv);
});

test('Nightly 4616 awaits native readiness with the resolved provider timeout before returning fresh inventory', () => {
  for (const environment of [undefined, { INSTANCE_PROBE_TIMEOUT: '45000' }]) {
    const duration = environment ? 45000 : 10000, events = [];
    const load = workspaceLoader({ timeout(value) { assert.equal(value, duration); return 'timeout'; } },
      (provider, fallback, received) => {
        assert.equal(provider, 'opencode'); assert.equal(fallback, 10000); assert.equal(received, environment);
        events.push('timeout-resolved'); return duration;
      });
    const read = { *[Symbol.iterator]() { events.push('read'); return yield 'read'; } };
    const scanned = { pipe(timeout) { assert.equal(timeout, 'timeout'); return { *[Symbol.iterator]() { events.push('ready'); yield 'ready'; } }; } };
    for (const first of [{ commands: [], skills: [] }, { commands: [{ name: 'help' }], skills: [] }]) {
      events.length = 0;
      const iterator = load(read, scanned, environment);
      assert.equal(iterator.next().value, 'read');
      assert.equal(iterator.next(first).value, 'ready');
      assert.equal(iterator.next().value, 'read');
      const fresh = { commands: [], skills: [{ id: 'local' }] };
      assert.deepEqual(iterator.next(fresh), { value: fresh, done: true });
      assert.deepEqual(events, ['read', 'timeout-resolved', 'ready', 'read']);
    }
  }
});

test('Nightly 4616 timeout cannot silently cache an inventory before native readiness', () => {
  const load = workspaceLoader({ timeout: () => 'timeout' }, () => 10000);
  const read = { *[Symbol.iterator]() { return yield 'read'; } };
  const scanned = { pipe() { return { *[Symbol.iterator]() { yield 'ready'; } }; } };
  const iterator = load(read, scanned, {});
  assert.equal(iterator.next().value, 'read');
  assert.equal(iterator.next({ commands: [{ name: 'help' }], skills: [] }).value, 'ready');
  assert.throws(() => iterator.throw(new Error('probe timeout')), /probe timeout/);
});

test('Nightly 4616 rejects provider-environment drift and mixed driver/loader versions', () => {
  const mutations = [
    [opencodeFiles[0], '            processEnv,', '            undefined,'],
    [opencodeFiles[0], '            processEnv,\n', ''],
    [opencodeFiles[0], '            processEnv,', '            processEnv,\n            extraArgument,'],
    [opencodeFiles[0], 'pathService.resolve(cwd)', 'cwd'],
    [opencodeFiles[1], 'environment?: NodeJS.ProcessEnv,', 'environment: NodeJS.ProcessEnv,'],
    [opencodeFiles[1], 'resolveProviderProbeTimeoutMs("opencode", 10_000, environment)', 'resolveProviderProbeTimeoutMs("opencode", 20_000, environment)'],
  ];
  for (const [file, before, after] of mutations) {
    assert(environmentSource[file].includes(before));
    const input = { ...environmentSource, [file]: environmentSource[file].replace(before, after) }, saved = structuredClone(input);
    assert.throws(() => patchOpenCodeSkills(input), /no longer matches/);
    assert.deepEqual(input, saved);
  }
  for (const file of opencodeFiles) {
    assert.throws(() => patchOpenCodeSkills({ ...environmentSource, [file]: environmentSource[file] + environmentSource[file] }), /no longer matches/);
    assert.throws(() => patchOpenCodeSkills({ ...environmentSource, [file]: settledSource[file] }), /no longer matches/);
  }
  assert.throws(() => patchOpenCodeSkills(patchedOpenCode), /no longer matches/);
});

test('Nightly 4616 repair retains all three previously supported OpenCode source shapes', () => {
  for (const input of [stableSource, normalizedSource, settledSource]) {
    const before = structuredClone(input), result = patchOpenCodeSkills(input);
    assert.deepEqual(input, before);
    assert.match(result[opencodeFiles[0]], /client\.plugin\.list\(\{ location \}\)/);
    assert.match(result[opencodeFiles[1]], /yield\* scanned\.pipe\(Effect\.timeout\("10 seconds"\)\)/);
    assert.doesNotMatch(result[opencodeFiles[1]], /wasLoaded|first\.commands|timeoutOption/);
  }
});
