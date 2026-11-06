import assert from 'node:assert/strict';
import test from 'node:test';
import { desiredInstance, differences, fileText, filesFor, instanceIdFor, mergeInstance, modelsFor, modelsToHide } from '../docker/setup/gateways/adapters.mjs';
import { GATEWAY_KEY_ENV, NO_KEY, agentOf } from '../docker/setup/gateways/catalog.mjs';
import { cleanModelIds, newestIn, parseModelList } from '../docker/setup/gateways/models.mjs';

const [claude, codex, opencode] = ['claude', 'codex', 'opencode'].map(agentOf);
const gateway = (over = {}) => ({ id: 'my-proxy', name: 'My Proxy', url: 'http://gateway:8317', accent: '#6366f1',
  models: { ids: ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'gemini-2.5-pro', 'gpt-5.6-sol', 'gpt-6-astra'], manual: [] },
  agents: { claude: { on: true }, codex: { on: true }, opencode: { on: true } }, ...over });
const env = (instance, name) => instance.environment.find(row => row.name === name);
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
