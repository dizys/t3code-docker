// One gateway, as each agent needs it. Everything an agent takes is scoped to
// its own T3 instance, so a direct sign-in on the same machine is untouched and
// the agent's home (skills, MCP servers, instructions) stays shared:
//
//   Claude Code  environment only. settings.json would reach every instance.
//   Codex        `-c` overrides plus a key variable. These beat config.toml, and
//                a custom provider ignores the stored sign-in.
//   OpenCode     OPENCODE_CONFIG, a layer over the person's own config, naming
//                files of ours. T3's session restarts a dead helper with the
//                environment it opened with, so anything held there would stay
//                old. A path doesn't change, and the files can.
//                `enabled_providers` narrows its catalog to the gateway.
//   Pi           a launch-only provider extension, leaving its home untouched.
//   Grok Build   a private home with copied behavior and linked user resources,
//                but no shared credentials, caches or sessions.
//
// Adapters own a declared set of fields, and nothing else. An instance someone
// adjusted in T3 Code keeps what they added, and a comparison only looks at
// what is owned here: writing an instance restarts it, which stops its threads,
// so it is never written without a reason.
import path from 'node:path';
import { AGENTS, GATEWAY_INSTANCE_ENV, GATEWAY_KEY_ENV, NO_KEY } from './catalog.mjs';
import { canChat, cleanModelIds, cleanModelLimits, cleanReasoning, newestIn } from './models.mjs';
import { stringify as toml } from '../vendor/toml-patch.mjs';
import { codexTemplate, nativeCodexModel } from './codex.mjs';

const plain = (name, value) => ({ name, value, sensitive: false });
const secret = name => ({ name, value: '', sensitive: true, secret: true });
const unique = values => [...new Set(values)];
const limitsFor = (gateway, model) => cleanModelLimits(gateway.models?.capabilities?.[model]?.limits);
/** Provider ids live in TOML keys and model slugs. */
const providerId = gateway => 't3gw_' + gateway.id.replaceAll('-', '_');

const CLAUDE_ALIAS_NAME = /^ANTHROPIC_DEFAULT_(?:OPUS|SONNET|HAIKU|FABLE)_MODEL$/;
const CLAUDE_ALIASES = Object.freeze({ opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL' });

// OpenCode's two config majors take the same facts in different words, and a
// file carrying both is refused outright by v1, so the file is written for the
// installed major and rewritten when it changes. Either way a model only gets
// the reasoning controls its gateway advertised: v1 earns a `low/medium/high`
// variant set from `reasoning: true` alone, and v2 invents the same trio for a
// model saying nothing, so unknown models have to say "none" out loud.
// A budget or a toggle alone offers no level to choose, so nothing is invented
// for them: the model keeps the gateway's own default.
const LEGACY_EFFORTS = Object.freeze(['low', 'medium', 'high']);
const openCodeEntry = (major, model, reasoning) => {
  const efforts = reasoning?.supported === true ? reasoning.effort ?? [] : [];
  if (major >= 2) return { name: model, capabilities: { reasoning: efforts.length ? { supported: true, effort: efforts } : { supported: false } } };
  if (!efforts.length) return { name: model, reasoning: false, variants: Object.fromEntries(LEGACY_EFFORTS.map(level => [level, { disabled: true }])) };
  return { name: model, reasoning: true, variants: Object.fromEntries([...new Set([...efforts, ...LEGACY_EFFORTS])].map(level => [level, efforts.includes(level) ? { reasoningEffort: level } : { disabled: true }])) };
};
// v2 also reads the v1 spelling, badly: it ignores reasoning and disabled
// variants and shows the trio it invented. So the v2 spelling exists for v2
// only, and the default is v1, still the catalogue's default install.
const openCodeConfig = (gateway, models, files, { major = 1 } = {}) => {
  const id = providerId(gateway).replaceAll('_', '-'), name = gateway.name.replace(/[{}]/g, '');
  const entries = Object.fromEntries(models.map(model => {
    const limits = limitsFor(gateway, model);
    return [model, { ...openCodeEntry(major, model, cleanReasoning(gateway.models?.capabilities?.[model])),
      ...(limits ? { limit: { context: limits.context, ...(limits.input ? { input: limits.input } : {}), ...(limits.output ? { output: limits.output } : {}) } } : {}) }];
  }));
  // Braces would be expanded by OpenCode: see models.mjs.
  return JSON.stringify({
    ...(major >= 2
      ? { providers: { [id]: { name, package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `${gateway.url}/v1`, apiKey: `{file:${files.key}}` }, models: entries } } }
      : { provider: { [id]: { name, npm: '@ai-sdk/openai-compatible', options: { baseURL: `${gateway.url}/v1`, apiKey: `{file:${files.key}}` }, models: entries } } }),
    enabled_providers: [id],
  }, null, 2);
};

const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Claude's native effort control cannot represent none/minimal/ultra. Codex's
// turn schema takes the advertised string unchanged. Neither gets guessed levels
// or a fabricated default; an empty list explicitly suppresses bundled controls.
const t3Models = (agent, gateway, models, supported) => !supported ? models : models.map(slug => {
  const reasoning = cleanReasoning(gateway.models?.capabilities?.[slug]);
  const efforts = (reasoning?.supported ? reasoning.effort ?? [] : [])
    .filter(level => agent !== 'claude' || ['low', 'medium', 'high', 'xhigh', 'max'].includes(level));
  return { slug, capabilities: { optionDescriptors: efforts.length ? [{
    id: agent === 'claude' ? 'effort' : 'reasoningEffort', label: 'Reasoning', type: 'select',
    options: efforts.map(id => ({ id, label: id })),
  }] : [] } };
});

const piConfig = (gateway, models) => {
  const config = { baseUrl: `${gateway.url}/v1`, api: 'openai-completions', models: models.map(id => {
    const reasoning = cleanReasoning(gateway.models?.capabilities?.[id]);
    const efforts = reasoning?.supported ? reasoning.effort ?? [] : [];
    const thinkingLevelMap = Object.fromEntries(PI_LEVELS.map(level => {
      const effort = level === 'off' ? 'none' : level;
      return [level, efforts.includes(effort) ? effort : null];
    }));
    const limits = limitsFor(gateway, id), contextWindow = limits?.input ?? limits?.context ?? 128000;
    return { id, name: id, reasoning: Object.values(thinkingLevelMap).some(Boolean), thinkingLevelMap,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Operational fallback limits, not discovered capability claims. Pi needs
      // these to register any custom model. No name-based reasoning defaults.
      contextWindow, maxTokens: limits?.output ?? Math.max(1, Math.min(8192, Math.floor(contextWindow / 4))),
      compat: { supportsStore: false, supportsDeveloperRole: false } };
  }) };
  // A launch-only extension leaves Pi's agent directory and mutable state alone.
  // Gateway data is a JSON literal, never executable source supplied by a server.
  return `export default function (pi) {\n  pi.registerProvider(${JSON.stringify(providerId(gateway))}, { ...${JSON.stringify(config, null, 2)}, apiKey: "$${GATEWAY_KEY_ENV}" });\n}\n`;
};

// Codex does not fetch /models for a custom provider. A startup catalog supplies
// per-model windows, including after a model switch, without a global override.
// Keep native metadata for known models. Foreign models use the installed
// default's coding prompt and tool settings, with no invented reasoning levels.
// Gateway prompts and tool declarations never enter the catalog.
const hasCodexCatalog = (gateway, models) => models.some(model => limitsFor(gateway, model));
const codexCatalog = (gateway, models, files, { nativeModels } = {}) => {
  if (!hasCodexCatalog(gateway, models)) return null;
  const template = codexTemplate(nativeModels);
  const overrides = models.flatMap(slug => {
    const limits = limitsFor(gateway, slug);
    if (!limits) return [];
    const native = nativeCodexModel(nativeModels, slug);
    const base = native ?? {
      slug, display_name: slug, description: 'Gateway model', priority: 99,
      supported_reasoning_levels: [], shell_type: template.shell_type,
      visibility: 'list', supported_in_api: true, support_verbosity: false,
      truncation_policy: template.truncation_policy, experimental_supported_tools: template.experimental_supported_tools,
      base_instructions: template.base_instructions, model_messages: template.model_messages,
    };
    return [{ ...base, slug, context_window: limits.input ?? limits.context, max_context_window: limits.input ?? limits.context,
      // Drop an unrelated native threshold. An absent route threshold lets
      // Codex derive its usual headroom from the discovered window.
      auto_compact_token_limit: limits.autoCompact ?? null }];
  });
  // Codex resolves metadata by prefix. An unknown sibling must not accidentally
  // inherit another route's newly enlarged window. Use its normal synthetic
  // 272K fallback in this case, with the same installed coding template.
  for (const slug of models) if (!limitsFor(gateway, slug) && nativeCodexModel(overrides, slug)) {
    const native = nativeCodexModel(nativeModels, slug);
    overrides.push(native ? { ...native, slug } : {
      slug, display_name: slug, priority: 99, supported_reasoning_levels: [],
      shell_type: template.shell_type, visibility: 'list', supported_in_api: true, support_verbosity: false,
      truncation_policy: template.truncation_policy, experimental_supported_tools: template.experimental_supported_tools,
      base_instructions: template.base_instructions, model_messages: template.model_messages,
      context_window: 272000, max_context_window: 272000,
    });
  }
  const replaced = new Set(overrides.map(row => row.slug));
  return JSON.stringify({ models: [...nativeModels.filter(row => !replaced.has(row.slug)), ...overrides] }, null, 2);
};

const grokConfig = (gateway, models, files, { baseConfig = {} } = {}) => toml({
  ...baseConfig,
  endpoints: { xai_api_base_url: `${gateway.url.replaceAll('$', '%24')}/v1` },
  // Grok's auxiliary defaults otherwise request built-in models even when they
  // are absent from the picker. Keep titles and helpers on a configured route.
  models: { allowed_models: models, ...(models.length ? { default: models[0], session_summary: models[0],
    image_description: models[0], web_search: models[0], prompt_suggestion: models[0] } : {}) },
  model: Object.fromEntries(models.map(id => {
    const reasoning = cleanReasoning(gateway.models?.capabilities?.[id]);
    // Grok's enum cannot deserialize ultra, even if a gateway advertises it.
    const efforts = reasoning?.supported ? (reasoning.effort ?? []).filter(level => level !== 'ultra') : [];
    return [id, { model: id, name: id, base_url: `${gateway.url.replaceAll('$', '%24')}/v1`,
      api_base_url: `${gateway.url.replaceAll('$', '%24')}/v1`, env_key: 'XAI_API_KEY', api_backend: 'responses',
      supports_backend_search: false, supports_reasoning_effort: efforts.length > 0,
      reasoning_efforts: efforts.map(value => ({ value, label: value })) }];
  })),
  features: { ...baseConfig.features, remote_fetch: false, managed_config: false, telemetry: false, feedback: false },
  shell_environment_policy: { ...baseConfig.shell_environment_policy,
    exclude: unique([...(baseConfig.shell_environment_policy?.exclude ?? []), 'XAI_API_KEY']) },
}, { inlineTableStart: 3 });

const SPECS = Object.freeze({
  claude: Object.freeze({
    configKeys: ['binaryPath', 'homePath', 'customModels'],
    compatible: id => /claude/i.test(id),
    environment: (gateway, models, files, instances, options) => [
      plain('ANTHROPIC_BASE_URL', gateway.url),
      secret('ANTHROPIC_AUTH_TOKEN'),
      // Explicitly empty, so a key in the container's environment can't win.
      plain('ANTHROPIC_API_KEY', ''),
      plain('T3_GATEWAY_MODEL_LIMITS', options.gatewayModelLimits ? JSON.stringify(Object.fromEntries(models.flatMap(model => {
        const limits = limitsFor(gateway, model);
        return limits ? [[model, limits]] : [];
      }))) : ''),
      // Subagents and background work ask for aliases, not exact ids. Point each
      // at what this gateway serves, or they fail on a model it doesn't have.
      ...Object.entries(CLAUDE_ALIASES).flatMap(([family, name]) => {
        const id = newestIn(models, family);
        return id ? [plain(name, id)] : [];
      }),
    ],
    config: (gateway, models, base, files, capabilities) => ({
      binaryPath: base.binaryPath,
      homePath: base.homePath,
      // Claude Code's own model discovery stays off: only newer T3 releases show
      // what it finds, and it would list CLIProxyAPI's `claude-` renamings of models
      // this list already has. T3 drops any it already lists.
      customModels: t3Models('claude', gateway, models, capabilities),
    }),
  }),
  codex: Object.freeze({
    configKeys: ['binaryPath', 'homePath', 'shadowHomePath', 'launchArgs', 'customModels'],
    compatible: id => /(?:^|\/)(?:gpt|chatgpt|codex|o\d)/i.test(id),
    environment: () => [secret(GATEWAY_KEY_ENV)],
    config: (gateway, models, base, files, capabilities) => {
      const id = providerId(gateway), key = name => `model_providers.${id}.${name}`;
      // Single-quoted for T3's tokenizer, double-quoted inside so Codex reads TOML strings.
      const overrides = [['model_provider', id], [key('name'), gateway.id], [key('base_url'), `${gateway.url}/v1`], [key('env_key'), GATEWAY_KEY_ENV], [key('wire_api'), 'responses']];
      if (hasCodexCatalog(gateway, models)) overrides.push(['model_catalog_json', files.config]);
      // Codex needs the key; the shells it opens don't. Without this it also lands
      // in ~/.codex/shell_snapshots, on disk, where rotating it can't reach.
      const keepFromShells = `-c 'shell_environment_policy.exclude=["${GATEWAY_KEY_ENV}"]'`;
      return {
        binaryPath: base.binaryPath,
        homePath: base.homePath,
        shadowHomePath: base.shadowHomePath,
        launchArgs: [base.launchArgs, ...overrides.map(([name, value]) => `-c '${name}="${value}"'`), keepFromShells].filter(Boolean).join(' '),
        customModels: t3Models('codex', gateway, models, capabilities),
      };
    },
    file: codexCatalog,
  }),
  opencode: Object.freeze({
    configKeys: ['binaryPath'],
    compatible: () => true,
    environment: (gateway, models, files) => [plain('OPENCODE_CONFIG', files.config)],
    config: (gateway, models, base) => ({ binaryPath: base.binaryPath }),
    // The key has its own file, so the config can be rewritten without knowing it.
    file: openCodeConfig,
  }),
  pi: Object.freeze({
    configKeys: ['binaryPath', 'launchArgs', 'customModels'],
    compatible: () => true,
    environment: (gateway, models, files, instances) => [secret(GATEWAY_KEY_ENV),
      ...(instances?.pi?.environment ?? []).filter(row => row.name === 'PI_CODING_AGENT_DIR' && !row.sensitive && typeof row.value === 'string' && row.value)
        .map(row => plain(row.name, row.value))],
    config: (gateway, models, base, files) => ({ binaryPath: base.binaryPath,
      launchArgs: [base.launchArgs, `--extension ${JSON.stringify(files.config)}`].filter(Boolean).join(' '),
      customModels: models.map(id => `${providerId(gateway)}/${id}`) }),
    file: piConfig,
  }),
  grok: Object.freeze({
    configKeys: ['binaryPath', 'customModels'],
    compatible: id => /(?:^|\/)grok/i.test(id),
    environment: (gateway, models, files) => [secret('XAI_API_KEY'), plain('GROK_HOME', path.dirname(files.config)),
      // Never let inherited environment overlays or a direct key defeat the
      // private model configuration or authenticate auxiliary service calls.
      plain('GROK_CONFIG', ''), plain('GROK_CONFIG_PATH', ''),
      plain('GROK_MODELS_BASE_URL', ''), plain('GROK_MODELS_LIST_URL', ''), plain('GROK_XAI_API_BASE_URL', `${gateway.url}/v1`),
      plain('GROK_AUTH_PROVIDER_COMMAND', ''), plain('GROK_DEPLOYMENT_KEY', ''), plain('GROK_DISABLE_AUTOUPDATER', '1'),
      ...['GROK_SESSION_SUMMARY_MODEL', 'GROK_IMAGE_DESCRIPTION_MODEL', 'GROK_WEB_SEARCH_MODEL', 'GROK_PROMPT_SUGGESTIONS_MODEL']
        .map(name => plain(name, models[0] ?? ''))],
    config: (gateway, models, base) => ({ binaryPath: base.binaryPath, customModels: models }),
    file: grokConfig,
  }),
});

export const instanceIdFor = (gatewayId, agent) => `${agent.driver}_gw_${gatewayId}`;

/** Where an agent's files live, for an agent that takes settings from files. */
export const filesFor = (agent, gateway, dir) => agent.id === 'pi' ? { config: path.join(dir, `${gateway.id}.pi.mjs`) }
  : agent.id === 'grok' ? { config: path.join(dir, `${gateway.id}.grok`, 'config.toml') }
    : agent.id === 'codex' ? { config: path.join(dir, `${gateway.id}.codex-models.json`) }
      : SPECS[agent.id].file ? { config: path.join(dir, `${gateway.id}.json`), key: path.join(dir, `${gateway.id}.key`) } : null;

/** The text of an agent's config file, or null if it has none. Options carry the installed major for an agent whose file spelling changed between majors. */
export const fileText = (agent, gateway, dir, options) => {
  const files = filesFor(agent, gateway, dir);
  return files ? SPECS[agent.id].file(gateway, modelsFor(agent, gateway), files, options) : null;
};

/** What this gateway offers this agent, given how wide the person asked it to look. */
export function modelsFor(agent, gateway) {
  const spec = SPECS[agent.id], discovered = gateway.models?.ids ?? [], manual = gateway.models?.manual ?? [];
  const wide = gateway.agents?.[agent.id]?.scope === 'all';
  // Grok expands environment references in every TOML string value. A model id
  // must never turn into a credential when its generated config is loaded.
  return cleanModelIds([...discovered.filter(id => wide || canChat(id) && spec.compatible(id)), ...manual])
    .filter(id => agent.id !== 'grok' || !id.includes('$'));
}

/** The parts of an agent's default instance a gateway instance runs with, so both use the same install and home. */
export function inheritedFrom(agent, instances) {
  const config = instances?.[agent.driver]?.config ?? {};
  const pick = key => typeof config[key] === 'string' && config[key].trim() ? config[key] : undefined;
  return { binaryPath: pick('binaryPath'), homePath: pick('homePath'), shadowHomePath: pick('shadowHomePath'), launchArgs: pick('launchArgs') };
}

const defined = value => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

/** The instance a gateway asks for. Secret rows are placeholders until `mergeInstance`. */
export function desiredInstance(agent, gateway, { instances = {}, enabled = true, dir = '', customModelCapabilityOverrides = false, gatewayModelLimits = false } = {}) {
  const spec = SPECS[agent.id], models = modelsFor(agent, gateway);
  return {
    driver: agent.driver,
    displayName: `${agent.short} · ${gateway.name}`,
    accentColor: gateway.accent,
    enabled,
    environment: [...spec.environment(gateway, models, filesFor(agent, gateway, dir), instances, { gatewayModelLimits: gatewayModelLimits === true }), plain(GATEWAY_INSTANCE_ENV, instanceIdFor(gateway.id, agent))],
    config: defined(spec.config(gateway, models, inheritedFrom(agent, instances), filesFor(agent, gateway, dir), customModelCapabilityOverrides === true)),
  };
}

/**
 * The instance to write: `actual` with the owned fields of `desired` laid over
 * it. Without a new `key` the saved secret stays, which T3 reads as "unchanged".
 */
export function mergeInstance(agent, desired, actual, { key } = {}) {
  const spec = SPECS[agent.id], owned = new Set(desired.environment.map(row => row.name));
  const previous = actual?.environment ?? [];
  const environment = desired.environment.map(({ secret: isSecret, ...row }) => {
    if (!isSecret) return row;
    if (key !== undefined) return { ...row, value: key || NO_KEY };
    const saved = previous.find(entry => entry.name === row.name);
    if (!saved) throw Object.assign(new Error('This gateway’s key is needed to connect a new agent.'), { code: 'key-needed' });
    return saved;
  });
  const theirs = previous.filter(row => !owned.has(row.name) && !CLAUDE_ALIAS_NAME.test(row.name));
  const config = { ...actual?.config };
  for (const name of spec.configKeys) { if (name in desired.config) config[name] = desired.config[name]; else delete config[name]; }
  return { ...actual, ...desired, environment: [...environment, ...theirs], config };
}

const sameList = (a = [], b = []) => JSON.stringify(a) === JSON.stringify(b);

/** What differs between an instance and what the gateway wants, in owned fields only. */
export function differences(agent, desired, actual) {
  if (!actual) return ['missing'];
  const spec = SPECS[agent.id], found = [];
  if (actual.displayName !== desired.displayName) found.push('name');
  if (actual.accentColor !== desired.accentColor) found.push('accent');
  if ((actual.enabled !== false) !== desired.enabled) found.push('enabled');
  const rows = actual.environment ?? [];
  for (const row of desired.environment) {
    const current = rows.find(entry => entry.name === row.name);
    if (!current || (row.secret ? !current.sensitive : (current.value !== row.value || current.sensitive === true))) found.push(row.name);
  }
  const wanted = new Set(desired.environment.map(row => row.name));
  for (const row of rows) if (CLAUDE_ALIAS_NAME.test(row.name) && !wanted.has(row.name)) found.push(row.name);
  for (const name of spec.configKeys) {
    const left = actual.config?.[name] ?? (name === 'customModels' ? [] : undefined), right = desired.config[name] ?? (name === 'customModels' ? [] : undefined);
    if (Array.isArray(right) ? !sameList(left, right) : (left ?? '') !== (right ?? '')) found.push(name);
  }
  return unique(found);
}

/** What a running process won't pick up by itself. Model lists and names reach T3 without one. */
export const reachesProcess = name => !['name', 'accent', 'customModels', 'missing'].includes(name) && !CLAUDE_ALIAS_NAME.test(name);

/** The built-in models T3 lists for an instance that this gateway doesn't serve. */
export function modelsToHide(agent, gateway, provider) {
  const discovered = gateway.models?.ids ?? [];
  if (agent.id === 'opencode' || !discovered.length || !provider?.models?.length) return [];
  if (agent.id === 'pi') {
    const served = new Set(modelsFor(agent, gateway).map(id => `${providerId(gateway)}/${id}`));
    return provider.models.filter(model => !model.isCustom && !served.has(model.slug)).map(model => model.slug);
  }
  const served = new Set(discovered.map(id => id.toLowerCase()));
  return provider.models.filter(model => !model.isCustom && !served.has(String(model.slug).toLowerCase())).map(model => model.slug);
}

export { AGENTS };
