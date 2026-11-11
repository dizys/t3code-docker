import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse as parseToml } from '../docker/setup/vendor/toml-patch.mjs';
import { desiredInstance, differences, fileText, filesFor, instanceIdFor, mergeInstance, modelsFor, modelsToHide } from '../docker/setup/gateways/adapters.mjs';
import { GATEWAY_KEY_ENV, NO_KEY, agentOf } from '../docker/setup/gateways/catalog.mjs';
import { cleanCapabilities, cleanModelIds, cleanModelLimits, harnessMajor, newestIn, parseModelCapabilities, parseModelList } from '../docker/setup/gateways/models.mjs';
import { nativeModels } from './fixtures/codex-models.mjs';
import { readCodexModels } from '../docker/setup/gateways/codex.mjs';

const [claude, codex, opencode] = ['claude', 'codex', 'opencode'].map(agentOf);
const [pi, grok] = ['pi', 'grok'].map(agentOf);
const gateway = (over = {}) => ({ id: 'my-proxy', name: 'My Proxy', url: 'http://gateway:8317', accent: '#6366f1',
  models: { ids: ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'gemini-2.5-pro', 'gpt-5.6-sol', 'gpt-6-astra'], manual: [] },
  agents: { claude: { on: true }, codex: { on: true }, opencode: { on: true } }, ...over });
const env = (instance, name) => instance.environment.find(row => row.name === name);
// `data:` imports resolve differently across runtimes; a temp file imports
// the generated extension the same way everywhere.
const importExtension = async (t, source) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3-gw-pi-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'extension.mjs');
  await fs.writeFile(file, source);
  return import(pathToFileURL(file).href);
};

test('token limits are parsed without raising the default to an opt-in maximum or accepting impossible output', () => {
  const caps = parseModelCapabilities({ models: [
    { slug: 'argon', context_window: 1048576, max_tokens: 1048576 },
    { slug: 'codex', context_window: 500000, max_context_window: 872000, max_tokens: 128000, auto_compact_token_limit: 440000 },
    { id: 'router', context_length: 1000000, top_provider: { max_completion_tokens: 65536 } },
    { id: 'oc', limit: { context: 200000, input: 180000, output: 8192 } },
    { id: 'gemini', input_token_limit: 1048576, output_token_limit: 65536 },
    { id: 'unknown', max_context_window: 1000000 },
  ] });
  assert.deepEqual(caps.argon, { limits: { context: 1048576 } });
  assert.deepEqual(caps.codex.limits, { context: 500000, output: 128000, autoCompact: 440000 });
  assert.deepEqual(caps.router.limits, { context: 1000000, output: 65536 });
  assert.deepEqual(caps.oc.limits, { context: 200000, input: 180000, output: 8192 });
  assert.deepEqual(caps.gemini.limits, { context: 1048576, input: 1048576, output: 65536 });
  assert.equal(caps.unknown, undefined);
  for (const context of [0, -1, 1.5, Infinity, '1000000', 10000001]) assert.equal(cleanModelLimits({ context }), null);
  assert.deepEqual(cleanCapabilities(['argon'], { argon: caps.argon, unknown: caps.codex }), { argon: caps.argon });
  assert.deepEqual(cleanModelLimits({ context: 128000, input: 200000, output: 128000, autoCompact: 128000 }), { context: 128000 });
  assert.deepEqual(cleanModelLimits({ context: 200000, input: 128000, output: 150000 }), { context: 200000, input: 128000 });
});

test('OpenCode, Pi and Codex receive per-model limits while unknown routes retain CLI fallbacks', async t => {
  const gw = gateway({ models: { ids: ['gemini-large', 'small', 'unknown'], capabilities: {
    'gemini-large': { limits: { context: 1048576, output: 65536 } },
    small: { limits: { context: 200000, input: 128000, output: 8192 } },
  } }, agents: { codex: { scope: 'all' } } });
  for (const major of [1, 2]) {
    const config = JSON.parse(fileText(opencode, gw, '/d', { major }));
    const entries = (config.providers ?? config.provider)['t3gw-my-proxy'].models;
    assert.deepEqual(entries['gemini-large'].limit, { context: 1048576, output: 65536 });
    assert.deepEqual(entries.small.limit, { context: 200000, input: 128000, output: 8192 });
    assert.equal(entries.unknown.limit, undefined);
  }
  const extension = await importExtension(t, fileText(pi, gw, '/d'));
  let models;
  extension.default({ registerProvider: (id, config) => { models = config.models; } });
  assert.equal(models.find(row => row.id === 'gemini-large').contextWindow, 1048576);
  assert.equal(models.find(row => row.id === 'gemini-large').maxTokens, 65536);
  assert.equal(models.find(row => row.id === 'small').contextWindow, 128000);
  assert.equal(models.find(row => row.id === 'unknown').contextWindow, 128000);
  const catalog = JSON.parse(fileText(codex, gw, '/d', { nativeModels }));
  assert.deepEqual(catalog.models.filter(row => row.slug !== 'gpt-6-astra').map(row => [row.slug, row.context_window]), [['gemini-large', 1048576], ['small', 128000]]);
  assert.match(desiredInstance(codex, gw, { dir: '/d' }).config.launchArgs, /model_catalog_json="\/d\/my-proxy.codex-models.json"/);
  assert.doesNotMatch(JSON.stringify(catalog), /T3_GATEWAY_KEY/);
  assert.equal(catalog.models.find(row => row.slug === 'gemini-large').base_instructions, nativeModels[0].base_instructions);
});

test('context-only OpenCode limits preserve the native unknown-output fallback in v1', () => {
  const gw = gateway({ models: { ids: ['context-only', 'invalid-output', 'unknown'], capabilities: {
    'context-only': { limits: { context: 1048576 } },
    'invalid-output': { limits: { context: 1048576, output: 1048576 } },
  } } });
  for (const major of [1, 2]) {
    const config = JSON.parse(fileText(opencode, gw, '/d', { major }));
    const entries = (config.providers ?? config.provider)['t3gw-my-proxy'].models;
    for (const slug of ['context-only', 'invalid-output']) {
      assert.equal(entries[slug].limit.context, 1048576);
      assert.equal(entries[slug].limit.output, major === 1 ? 0 : undefined);
    }
    assert.equal(entries.unknown.limit, undefined);
  }
});

test('Codex preserves installed model instructions and tools and prevents prefix leaks into unknown routes', () => {
  const gw = gateway({ models: { ids: ['gpt-6-astra', 'foreign', 'foreign-unknown', 'namespace/foreign-unknown', 'unknown'], capabilities: {
    'gpt-6-astra': { limits: { context: 500000 }, base_instructions: 'Untrusted gateway prompt' },
    foreign: { limits: { context: 1048576 } },
  } }, agents: { codex: { scope: 'all' } } });
  const original = structuredClone(nativeModels);
  const catalog = JSON.parse(fileText(codex, gw, '/d', { nativeModels }));
  const known = catalog.models.find(row => row.slug === 'gpt-6-astra');
  assert.deepEqual(known, { ...nativeModels[0], context_window: 500000, max_context_window: 500000, auto_compact_token_limit: null });
  const foreign = catalog.models.find(row => row.slug === 'foreign');
  assert.deepEqual(foreign.model_messages, nativeModels[0].model_messages);
  assert.deepEqual(foreign.supported_reasoning_levels, []);
  assert.equal(foreign.default_reasoning_level, undefined);
  assert.equal(catalog.models.find(row => row.slug === 'foreign-unknown').context_window, 272000);
  assert.equal(catalog.models.find(row => row.slug === 'namespace/foreign-unknown').context_window, 272000);
  assert.equal(catalog.models.find(row => row.slug === 'unknown'), undefined);
  assert.deepEqual(nativeModels, original);
  assert.throws(() => fileText(codex, gw, '/d'), /installed model catalog/);
});

test('Codex reads only the bundled catalog and rejects failed or invalid exports without echoing output', async () => {
  const options = { executable: '/native/codex', home: '/home', env: { KEEP: 'yes' } };
  const read = (error, stdout) => readCodexModels({ ...options, execFileImpl: (executable, args, settings, callback) => {
    assert.equal(executable, options.executable);
    assert.deepEqual(args, ['debug', 'models', '--bundled']);
    assert.equal(settings.cwd, options.home);
    assert.equal(settings.env, options.env);
    assert.equal(settings.timeout, 10000);
    callback(error, stdout);
  } });
  assert.deepEqual(await read(null, JSON.stringify({ models: nativeModels })), nativeModels);
  for (const stdout of ['sensitive native output', '{}', '{"models":[]}', '{"models":[{"slug":"bad"}]}']) {
    await assert.rejects(read(null, stdout), error => /invalid bundled/.test(error.message) && !error.message.includes(stdout));
  }
  await assert.rejects(read(new Error('sensitive command error'), ''), /Update Codex/);
});

test('Claude route limits require the complete runtime contract and are cleared on downgrade', () => {
  const gw = gateway({ models: { ids: ['gemini-large', 'unknown'], capabilities: { 'gemini-large': { limits: { context: 1048576 } } } }, agents: { claude: { scope: 'all' } } });
  for (const gatewayModelLimits of [undefined, false, 'true', 1]) assert.equal(env(desiredInstance(claude, gw, { gatewayModelLimits }), 'T3_GATEWAY_MODEL_LIMITS').value, '');
  const instance = desiredInstance(claude, gw, { gatewayModelLimits: true });
  assert.deepEqual(JSON.parse(env(instance, 'T3_GATEWAY_MODEL_LIMITS').value), { 'gemini-large': { context: 1048576 } });
  assert.deepEqual(differences(claude, desiredInstance(claude, gw), instance), ['T3_GATEWAY_MODEL_LIMITS']);
});

test('Claude and Codex use exact advertised controls only with negotiated runtime support', () => {
  const gw = gateway({ models: { ids: ['claude-known', 'gpt-known', 'unknown', 'disabled'], capabilities: {
    'claude-known': { supported: true, effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    'gpt-known': { supported: true, effort: ['none', 'minimal', 'low', 'ultra'] },
    disabled: { supported: false, effort: ['high'] },
  } }, agents: { claude: { scope: 'all' }, codex: { scope: 'all' } } });
  for (const agent of [claude, codex]) {
    for (const flag of [undefined, false, 'true', 1]) assert.ok(desiredInstance(agent, gw, { customModelCapabilityOverrides: flag }).config.customModels.every(id => typeof id === 'string'));
    const instance = desiredInstance(agent, gw, { customModelCapabilityOverrides: true });
    const entries = instance.config.customModels;
    const known = entries.find(entry => entry.slug === (agent === claude ? 'claude-known' : 'gpt-known'));
    const [descriptor] = known.capabilities.optionDescriptors;
    assert.equal(descriptor.id, agent === claude ? 'effort' : 'reasoningEffort');
    assert.deepEqual(descriptor.options.map(option => option.id), agent === claude ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['none', 'minimal', 'low', 'ultra']);
    assert.ok(descriptor.options.every(option => !('isDefault' in option)));
    assert.equal(descriptor.currentValue, undefined);
    for (const slug of ['unknown', 'disabled']) assert.deepEqual(entries.find(entry => entry.slug === slug).capabilities, { optionDescriptors: [] });
    const old = desiredInstance(agent, gw);
    assert.deepEqual(differences(agent, instance, old), ['customModels']);
  }
});

test('Pi uses a launch-only extension and provider-qualified custom model ids', async t => {
  const gw = gateway(), instance = desiredInstance(pi, gw, { dir: '/private files', instances: { pi: { config: { binaryPath: '/pi', launchArgs: '--approve' } } } });
  assert.equal(instance.config.binaryPath, '/pi');
  assert.match(instance.config.launchArgs, /^--approve --extension /);
  assert.equal(env(instance, 'PI_CODING_AGENT_DIR'), undefined);
  assert.ok(env(instance, GATEWAY_KEY_ENV).secret);
  assert.ok(instance.config.customModels.every(id => id.startsWith('t3gw_my_proxy/')));
  const source = fileText(pi, gw, '/private files');
  const module = await importExtension(t, source);
  let registered;
  module.default({ registerProvider: (id, config) => { registered = { id, config }; } });
  assert.equal(registered.id, 't3gw_my_proxy');
  assert.equal(registered.config.baseUrl, `${gw.url}/v1`);
  assert.ok(registered.config.models.every(model => !model.reasoning && Object.values(model.thinkingLevelMap).every(value => value === null)));
});

test('Pi exposes only representable advertised efforts and hides direct provider models', async t => {
  const gw = gateway({ models: { ids: ['unknown', 'reasoner'], capabilities: { reasoner: { supported: true, effort: ['none', 'low', 'max', 'ultra'] } } } });
  const module = await importExtension(t, fileText(pi, gw, '/files'));
  let models;
  module.default({ registerProvider: (id, config) => { models = config.models; } });
  assert.deepEqual(models.find(model => model.id === 'reasoner').thinkingLevelMap,
    { off: 'none', minimal: null, low: 'low', medium: null, high: null, xhigh: null, max: 'max' });
  assert.deepEqual(modelsToHide(pi, gw, { models: [{ slug: 'openai/gpt-direct' }, { slug: 't3gw_my_proxy/reasoner' }] }), ['openai/gpt-direct']);
});

test('Pi inherits an explicitly configured resource home without copying credentials', () => {
  const instance = desiredInstance(pi, gateway(), { dir: '/files', instances: { pi: {
    environment: [{ name: 'PI_CODING_AGENT_DIR', value: '/my/pi', sensitive: false }, { name: 'OPENAI_API_KEY', value: 'sk-direct', sensitive: true }],
  } } });
  assert.equal(env(instance, 'PI_CODING_AGENT_DIR').value, '/my/pi');
  assert.equal(env(instance, 'OPENAI_API_KEY'), undefined);
});

test('Grok cannot expand a gateway model into an environment secret or deserialize ultra', () => {
  const gw = gateway({ url: 'http://proxy/$XAI_API_KEY', models: { ids: ['grok-$XAI_API_KEY', 'grok-ok'], manual: ['$HOME'],
    capabilities: { 'grok-ok': { supported: true, effort: ['high', 'ultra'] } } } });
  assert.deepEqual(modelsFor(grok, gw), ['grok-ok']);
  const config = parseToml(fileText(grok, gw, '/files'));
  assert.equal(config.model['grok-ok'].base_url, 'http://proxy/%24XAI_API_KEY/v1');
  assert.equal(config.model['grok-ok'].api_base_url, config.model['grok-ok'].base_url);
  assert.deepEqual(config.model['grok-ok'].reasoning_efforts.map(row => row.value), ['high']);
});

test('Grok uses a private home with Responses models and explicit effort menus', () => {
  const gw = gateway({ models: { ids: ['grok-model', 'gpt-other'], capabilities: { 'grok-model': { supported: true, effort: ['low', 'high'] } } } });
  assert.deepEqual(modelsFor(grok, gw), ['grok-model']);
  const instance = desiredInstance(grok, gw, { dir: '/files', instances: { grok: { config: { binaryPath: '/grok' } } } });
  assert.equal(instance.config.binaryPath, '/grok');
  assert.equal(instance.config.launchArgs, undefined);
  assert.equal(env(instance, 'GROK_HOME').value, '/files/my-proxy.grok');
  assert.ok(env(instance, 'XAI_API_KEY').secret);
  const config = parseToml(fileText(grok, gw, '/files'));
  assert.equal(config.model['grok-model'].base_url, `${gw.url}/v1`);
  assert.equal(config.model['grok-model'].api_backend, 'responses');
  assert.deepEqual(config.model['grok-model'].reasoning_efforts.map(row => row.value), ['low', 'high']);
  assert.deepEqual(config.shell_environment_policy.exclude, ['XAI_API_KEY']);
  const unknown = parseToml(fileText(grok, gateway(), '/files'));
  assert.ok(Object.values(unknown.model).every(model => model.supports_reasoning_effort === false && model.reasoning_efforts.length === 0));
});
// T3's own tokenizer: single quotes are literal, and that's what launchArgs is read with.
const tokens = text => [...text.matchAll(/'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2]);
// What T3 hands back: secrets stripped, flagged as redacted.
const asStored = instance => ({ ...instance, environment: instance.environment.map(row => row.sensitive ? { name: row.name, value: '', sensitive: true, valueRedacted: true } : row) });

test('models that can\'t chat stay out unless asked for', () => {
  const ids = ['gpt-6-sol', 'gpt-image-2', 'gpt-image-2.5-flare', 'gemini-3.1-flash-image', 'text-embedding-3-large', 'whisper-1', 'tts-1-hd', 'dall-e-3', 'imagen-4', 'claude-opus-5-5', 'muse-spark-1.3', 'embed-v4', 'gemini-3-flash'];
  const listed = extra => gateway({ models: { ids, manual: [] }, ...extra });
  assert.deepEqual(modelsFor(codex, listed()), ['gpt-6-sol']);
  assert.deepEqual(modelsFor(claude, listed()), ['claude-opus-5-5']);
  assert.deepEqual(modelsFor(opencode, listed()), ['claude-opus-5-5', 'gemini-3-flash', 'gpt-6-sol', 'muse-spark-1.3']);
  assert.equal(modelsFor(codex, listed({ agents: { codex: { on: true, scope: 'all' } } })).length, ids.length);
  assert.deepEqual(modelsFor(codex, gateway({ models: { ids: [], manual: ['gpt-image-2'] } })), ['gpt-image-2']);
});

test('each agent gets its own instance id, and the id fits T3’s slug', () => {
  for (const agent of [claude, codex, opencode]) assert.match(instanceIdFor('a'.repeat(32), agent), /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
  assert.equal(instanceIdFor('my-proxy', claude), 'claudeAgent_gw_my-proxy');
});

test('Claude Code is configured by environment alone, with the gateway path left to it', () => {
  const instance = mergeInstance(claude, desiredInstance(claude, gateway()), undefined, { key: 'sk-secret' });
  assert.equal(env(instance, 'ANTHROPIC_BASE_URL').value, 'http://gateway:8317');
  assert.deepEqual(env(instance, 'ANTHROPIC_AUTH_TOKEN'), { name: 'ANTHROPIC_AUTH_TOKEN', value: 'sk-secret', sensitive: true });
  assert.equal(env(instance, 'ANTHROPIC_API_KEY').value, '', 'an empty value shuts out a key from the container environment');
  // It would bring CLIProxyAPI's renamed models into T3 Code's picker as duplicates.
  assert.equal(env(instance, 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'), undefined);
  assert.equal(instance.config.homePath, undefined, 'the home is shared, so skills and MCP servers carry over');
});

test('Claude’s aliases point at what the gateway serves, so background work finds a model', () => {
  const instance = desiredInstance(claude, gateway());
  assert.equal(env(instance, 'ANTHROPIC_DEFAULT_OPUS_MODEL').value, 'claude-opus-4-8');
  assert.equal(env(instance, 'ANTHROPIC_DEFAULT_HAIKU_MODEL').value, 'claude-haiku-4-5');
  assert.equal(env(instance, 'ANTHROPIC_DEFAULT_SONNET_MODEL').value, 'claude-sonnet-4-5', 'a date is a build, not a newer version');
  assert.equal(env(instance, 'ANTHROPIC_DEFAULT_FABLE_MODEL'), undefined);
});

test('Claude’s models all go in custom models, the same on every T3 release', () => {
  assert.deepEqual(desiredInstance(claude, gateway()).config.customModels, ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']);
  const openrouter = gateway({ models: { ids: ['anthropic/claude-sonnet-4.5', 'claude-opus-4-8', 'openai/gpt-5'], manual: [] } });
  assert.deepEqual(desiredInstance(claude, openrouter).config.customModels, ['anthropic/claude-sonnet-4.5', 'claude-opus-4-8']);
  const all = gateway({ agents: { claude: { on: true, scope: 'all' } } });
  assert.equal(desiredInstance(claude, all).config.customModels.length, 7);
});

test('Codex overrides are launch arguments, and the key is only a variable name', () => {
  const instance = mergeInstance(codex, desiredInstance(codex, gateway()), undefined, { key: 'sk-secret' });
  assert.deepEqual(tokens(instance.config.launchArgs).filter(word => word !== '-c'), [
    'model_provider="t3gw_my_proxy"',
    'model_providers.t3gw_my_proxy.name="my-proxy"',
    'model_providers.t3gw_my_proxy.base_url="http://gateway:8317/v1"',
    `model_providers.t3gw_my_proxy.env_key="${GATEWAY_KEY_ENV}"`,
    'model_providers.t3gw_my_proxy.wire_api="responses"',
    `shell_environment_policy.exclude=["${GATEWAY_KEY_ENV}"]`,
  ]);
  assert.equal(env(instance, GATEWAY_KEY_ENV).value, 'sk-secret');
  assert.doesNotMatch(instance.config.launchArgs, /sk-secret/);
});

test('a name with a quote can’t break out of Codex’s launch arguments', () => {
  const instance = desiredInstance(codex, gateway({ name: 'Bob\'s "proxy"' }));
  assert.doesNotMatch(instance.config.launchArgs, /Bob/);
  assert.equal(instance.displayName, 'Codex · Bob\'s "proxy"');
});

test('Codex inherits the install, home and flags of the default instance', () => {
  const instances = { codex: { config: { binaryPath: '/opt/codex', homePath: '~/.codex', launchArgs: '--strict-config' } } };
  const { config } = desiredInstance(codex, gateway(), { instances });
  assert.equal(config.binaryPath, '/opt/codex');
  assert.equal(config.homePath, '~/.codex');
  assert.match(config.launchArgs, /^--strict-config -c /);
});

test('Codex only offers models it can run unless asked for all of them', () => {
  assert.deepEqual(modelsFor(codex, gateway()), ['gpt-5.6-sol', 'gpt-6-astra']);
  assert.equal(modelsFor(codex, gateway({ agents: { codex: { on: true, scope: 'all' } } })).length, 7);
  assert.deepEqual(modelsFor(codex, gateway({ models: { ids: ['gpt-6-astra'], manual: ['my-model'] } })), ['gpt-6-astra', 'my-model']);
});

test('OpenCode is given a path, so a process restarted with old settings still reads current files', () => {
  const instance = desiredInstance(opencode, gateway(), { dir: '/state/agents' });
  assert.deepEqual(instance.environment.map(row => row.name), ['OPENCODE_CONFIG', 'T3_GATEWAY_INSTANCE']);
  assert.equal(env(instance, 'OPENCODE_CONFIG').value, '/state/agents/my-proxy.json');
});

test('OpenCode’s config is narrowed to the gateway and only points at the key', () => {
  const config = JSON.parse(fileText(opencode, gateway(), '/state/agents')), provider = config.provider['t3gw-my-proxy'];
  assert.deepEqual(config.enabled_providers, ['t3gw-my-proxy']);
  assert.equal(provider.options.baseURL, 'http://gateway:8317/v1');
  assert.equal(provider.options.apiKey, '{file:/state/agents/my-proxy.key}');
  assert.equal(Object.keys(provider.models).length, 7);
});

test('OpenCode v1 names no reasoning controls for unknown models', () => {
  const config = JSON.parse(fileText(opencode, gateway(), '/state/agents')), provider = config.provider['t3gw-my-proxy'];
  for (const entry of Object.values(provider.models)) {
    assert.equal(entry.reasoning, false);
    assert.deepEqual(Object.entries(entry.variants).filter(([, v]) => !v.disabled), [], 'no enabled variants');
  }
});

test('OpenCode v1 emits exactly the advertised effort variants', () => {
  const caps = { 'gpt-6-astra': { supported: true, effort: ['low', 'xhigh'] } };
  const config = JSON.parse(fileText(opencode, gateway({ models: { ids: gateway().models.ids, manual: [], capabilities: caps } }), '/state/agents')), provider = config.provider['t3gw-my-proxy'];
  const entry = provider.models['gpt-6-astra'];
  assert.equal(entry.reasoning, true);
  const enabled = Object.entries(entry.variants).filter(([, v]) => !v.disabled).map(([level]) => level).sort();
  assert.deepEqual(enabled, ['low', 'xhigh']);
  assert.equal(entry.variants.low.reasoningEffort, 'low');
  assert.equal(entry.variants.xhigh.reasoningEffort, 'xhigh');
  // The legacy trio v1 invents from reasoning:true must be explicitly disabled.
  assert.deepEqual(entry.variants.medium, { disabled: true });
  assert.deepEqual(entry.variants.high, { disabled: true });
});

test('OpenCode v2 uses providers key with no controls for unknown models', () => {
  const config = JSON.parse(fileText(opencode, gateway(), '/state/agents', { major: 2 }));
  assert.equal(config.provider, undefined, 'v1 provider key must not appear');
  const provider = config.providers['t3gw-my-proxy'];
  assert.equal(provider.package, '@opencode/ai/providers/openai-compatible');
  assert.equal(provider.settings.baseURL, 'http://gateway:8317/v1');
  assert.equal(provider.settings.apiKey, '{file:/state/agents/my-proxy.key}');
  assert.deepEqual(config.enabled_providers, ['t3gw-my-proxy']);
  for (const entry of Object.values(provider.models)) assert.deepEqual(entry.capabilities.reasoning, { supported: false });
});

test('OpenCode v2 emits exactly the advertised effort list', () => {
  const caps = { 'gpt-6-astra': { supported: true, effort: ['low', 'high'] } };
  const config = JSON.parse(fileText(opencode, gateway({ models: { ids: gateway().models.ids, manual: [], capabilities: caps } }), '/state/agents', { major: 2 })), provider = config.providers['t3gw-my-proxy'];
  assert.deepEqual(provider.models['gpt-6-astra'].capabilities.reasoning, { supported: true, effort: ['low', 'high'] });
  assert.deepEqual(provider.models['gemini-2.5-pro'].capabilities.reasoning, { supported: false });
});

test('only agents that need files have them', () => {
  assert.equal(filesFor(claude, gateway(), '/d'), null);
  assert.equal(fileText(codex, gateway(), '/d'), null);
  assert.deepEqual(filesFor(opencode, gateway(), '/d'), { config: '/d/my-proxy.json', key: '/d/my-proxy.key' });
});

test('a gateway without a key still gives agents the token they insist on', () => {
  const instance = mergeInstance(claude, desiredInstance(claude, gateway()), undefined, { key: '' });
  assert.equal(env(instance, 'ANTHROPIC_AUTH_TOKEN').value, NO_KEY);
});

test('every instance names itself on its processes, without saying anything secret', () => {
  for (const agent of [claude, codex, opencode]) assert.deepEqual(env(desiredInstance(agent, gateway()), 'T3_GATEWAY_INSTANCE'), { name: 'T3_GATEWAY_INSTANCE', value: instanceIdFor('my-proxy', agent), sensitive: false });
});

test('merging keeps what someone added in T3 Code and the saved secret', () => {
  const stored = asStored(mergeInstance(claude, desiredInstance(claude, gateway()), undefined, { key: 'sk-secret' }));
  stored.environment.push({ name: 'CLAUDE_CODE_ENABLE_TODO_TOOLS', value: '1', sensitive: false });
  stored.config.autoCompactWindow = '500000';
  const merged = mergeInstance(claude, desiredInstance(claude, gateway()), stored);
  assert.deepEqual(env(merged, 'ANTHROPIC_AUTH_TOKEN'), { name: 'ANTHROPIC_AUTH_TOKEN', value: '', sensitive: true, valueRedacted: true }, 'T3 reads this as "keep the saved secret"');
  assert.equal(env(merged, 'CLAUDE_CODE_ENABLE_TODO_TOOLS').value, '1');
  assert.equal(merged.config.autoCompactWindow, '500000');
});

test('connecting a new agent without a key is refused rather than left blank', () => {
  assert.throws(() => mergeInstance(claude, desiredInstance(claude, gateway()), undefined), { code: 'key-needed' });
});

test('an unchanged instance has no differences, so it is never rewritten', () => {
  for (const agent of [claude, codex, opencode]) {
    const desired = desiredInstance(agent, gateway()), stored = asStored(mergeInstance(agent, desired, undefined, { key: 'sk-secret' }));
    assert.deepEqual(differences(agent, desired, stored), [], agent.id);
  }
});

test('additions in T3 Code aren’t differences; changes to owned fields are', () => {
  const desired = desiredInstance(claude, gateway()), stored = asStored(mergeInstance(claude, desired, undefined, { key: 'x' }));
  assert.deepEqual(differences(claude, desired, { ...stored, environment: [...stored.environment, { name: 'MY_VAR', value: '1', sensitive: false }] }), []);
  assert.deepEqual(differences(claude, desired, { ...stored, enabled: false }), ['enabled']);
  const moved = stored.environment.map(row => row.name === 'ANTHROPIC_BASE_URL' ? { ...row, value: 'http://other' } : row);
  assert.deepEqual(differences(claude, desired, { ...stored, environment: moved }), ['ANTHROPIC_BASE_URL']);
  assert.deepEqual(differences(claude, desired, undefined), ['missing']);
  assert.deepEqual(differences(claude, desired, { ...stored, displayName: 'Mine' }), ['name']);
});

test('an alias for a model the gateway stopped serving is dropped', () => {
  const before = asStored(mergeInstance(claude, desiredInstance(claude, gateway()), undefined, { key: 'x' }));
  const narrower = desiredInstance(claude, gateway({ models: { ids: ['claude-sonnet-4-5'], manual: [] } }));
  assert.ok(differences(claude, narrower, before).includes('ANTHROPIC_DEFAULT_OPUS_MODEL'));
  assert.equal(env(mergeInstance(claude, narrower, before), 'ANTHROPIC_DEFAULT_OPUS_MODEL'), undefined);
});

test('T3’s built-in models are hidden when the gateway doesn’t serve them', () => {
  const provider = { models: [{ slug: 'claude-opus-5-5' }, { slug: 'CLAUDE-OPUS-4-8' }, { slug: 'mine', isCustom: true }] };
  assert.deepEqual(modelsToHide(claude, gateway(), provider), ['claude-opus-5-5']);
  assert.deepEqual(modelsToHide(claude, gateway({ models: { ids: [], manual: ['x'] } }), provider), [], 'with no list, nothing can be called unserved');
  assert.deepEqual(modelsToHide(opencode, gateway(), provider), [], 'OpenCode’s catalog is already exact');
  assert.deepEqual(modelsToHide(claude, gateway(), undefined), []);
});

test('braces can never reach a model list', () => {
  assert.deepEqual(cleanModelIds(['{file:/etc/passwd}', 'a{b', 'a}b', 'ok-model', 'org/model:free', 'a~b|c']), ['a~b|c', 'ok-model', 'org/model:free']);
});

test('model lists are read from each shape gateways use, in one stable order', () => {
  assert.deepEqual(parseModelList({ data: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(parseModelList({ models: [{ name: 'a' }, { slug: 'b' }] }), ['a', 'b']);
  assert.deepEqual(parseModelList(['a']), ['a']);
  assert.equal(parseModelList({ error: 'nope' }), null);
  assert.deepEqual(cleanModelIds(['model-10', 'model-9', 'model-9', 'has space', '', 7]), ['model-9', 'model-10']);
});

test('the newest model in a family reads version numbers, not dates', () => {
  assert.equal(newestIn(['claude-sonnet-4-5-20250929', 'claude-sonnet-5-5', 'claude-sonnet-4-8'], 'sonnet'), 'claude-sonnet-5-5');
  assert.equal(newestIn(['claude-3-5-sonnet-20241022', 'claude-sonnet-4-5'], 'sonnet'), 'claude-sonnet-4-5');
  assert.equal(newestIn(['gpt-6'], 'sonnet'), null);
  assert.equal(newestIn(['xsonnetx'], 'sonnet'), null);
});

test('reasoning facts are read from each shape gateways use, and only known levels survive', () => {
  // OpenRouter's shape, cleaned and put in allowlist order.
  assert.deepEqual(parseModelCapabilities({ data: [{ id: 'a', reasoning: { supported_efforts: ['high', 'low', 'bogus', '{file:/etc/passwd}', 'LOW'] } }] }),
    { a: { supported: true, effort: ['low', 'high'] } });
  assert.deepEqual(parseModelCapabilities({ data: [{ id: 'a', capabilities: { reasoning: { supported: true, effort: ['xhigh', 'none'], budget: { min: 1024, max: 65536 }, toggle: true } } }] }),
    { a: { supported: true, toggle: true, effort: ['none', 'xhigh'], budget: { min: 1024, max: 65536 } } });
  assert.deepEqual(parseModelCapabilities({ data: [
    { id: 'a', reasoning: false }, { id: 'b', reasoning: true },
    { id: 'c', supported_parameters: ['reasoning'] }, { id: 'd', supported_parameters: ['reasoning_effort'] },
  ] }), { a: { supported: false }, b: { supported: true }, c: { supported: true }, d: { supported: true } });
  // A budget with min >= max keeps only the max; an out-of-range budget is dropped.
  assert.deepEqual(parseModelCapabilities({ data: [{ id: 'a', capabilities: { reasoning: { supported: true, budget: { min: 10, max: 5 } } } }] }),
    { a: { supported: true, budget: { max: 5 } } });
  assert.deepEqual(parseModelCapabilities({ data: [{ id: 'b', capabilities: { reasoning: { supported: true, budget: { min: 0, max: 999999999 } } } }] }),
    { b: { supported: true } });
  assert.deepEqual(parseModelCapabilities(null), null);
  assert.deepEqual(parseModelCapabilities({}), null);
  assert.deepEqual(parseModelCapabilities({ data: [{ id: 'a' }] }), {});
});

test('stored capabilities are kept only for listed ids and cleaned as if just read', () => {
  assert.deepEqual(cleanCapabilities(['a', 'b', 'missing'], { a: { supported: true, effort: ['ultra', 'bad'] }, b: { supported: false, effort: ['low'] }, extra: { supported: true } }),
    { a: { supported: true, effort: ['ultra'] }, b: { supported: false } });
});

test('the OpenCode major comes from the harness version rows, in priority order', () => {
  assert.equal(harnessMajor({ version: '2.2.6' }), 2);
  assert.equal(harnessMajor({ installedVersion: 'v1.14.19' }), 1);
  assert.equal(harnessMajor({ recordedVersion: '3.0.0' }), 3);
  assert.equal(harnessMajor({ recordedVersion: '2' }), null);
  assert.equal(harnessMajor({ version: 'unknown' }), null);
  assert.equal(harnessMajor({ version: '' }), null);
  assert.equal(harnessMajor({}), null);
  assert.equal(harnessMajor(null), null);
});
