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
//
// Adapters own a declared set of fields, and nothing else. An instance someone
// adjusted in T3 Code keeps what they added, and a comparison only looks at
// what is owned here: writing an instance restarts it, which stops its threads,
// so it is never written without a reason.
import path from 'node:path';
import { AGENTS, GATEWAY_INSTANCE_ENV, GATEWAY_KEY_ENV, NO_KEY } from './catalog.mjs';
import { canChat, cleanModelIds, newestIn } from './models.mjs';

const plain = (name, value) => ({ name, value, sensitive: false });
const secret = name => ({ name, value: '', sensitive: true, secret: true });
const unique = values => [...new Set(values)];
/** Provider ids live in TOML keys and model slugs. */
const providerId = gateway => 't3gw_' + gateway.id.replaceAll('-', '_');

const CLAUDE_ALIAS_NAME = /^ANTHROPIC_DEFAULT_(?:OPUS|SONNET|HAIKU|FABLE)_MODEL$/;
const CLAUDE_ALIASES = Object.freeze({ opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL' });

const SPECS = Object.freeze({
  claude: Object.freeze({
    configKeys: ['binaryPath', 'homePath', 'customModels'],
    compatible: id => /claude/i.test(id),
    environment: (gateway, models) => [
      plain('ANTHROPIC_BASE_URL', gateway.url),
      secret('ANTHROPIC_AUTH_TOKEN'),
      // Explicitly empty, so a key in the container's environment can't win.
      plain('ANTHROPIC_API_KEY', ''),
      // Subagents and background work ask for aliases, not exact ids. Point each
      // at what this gateway serves, or they fail on a model it doesn't have.
      ...Object.entries(CLAUDE_ALIASES).flatMap(([family, name]) => {
        const id = newestIn(models, family);
        return id ? [plain(name, id)] : [];
      }),
    ],
    config: (gateway, models, base) => ({
      binaryPath: base.binaryPath,
      homePath: base.homePath,
      // Claude Code's own model discovery stays off: only newer T3 releases show
      // what it finds, and it would list CLIProxyAPI's `claude-` renamings of models
      // this list already has. T3 drops any it already lists.
      customModels: models,
    }),
  }),
  codex: Object.freeze({
    configKeys: ['binaryPath', 'homePath', 'shadowHomePath', 'launchArgs', 'customModels'],
    compatible: id => /(?:^|\/)(?:gpt|chatgpt|codex|o\d)/i.test(id),
    environment: () => [secret(GATEWAY_KEY_ENV)],
    config: (gateway, models, base) => {
      const id = providerId(gateway), key = name => `model_providers.${id}.${name}`;
      // Single-quoted for T3's tokenizer, double-quoted inside so Codex reads TOML strings.
      const overrides = [['model_provider', id], [key('name'), gateway.id], [key('base_url'), `${gateway.url}/v1`], [key('env_key'), GATEWAY_KEY_ENV], [key('wire_api'), 'responses']];
      // Codex needs the key; the shells it opens don't. Without this it also lands
      // in ~/.codex/shell_snapshots, on disk, where rotating it can't reach.
      const keepFromShells = `-c 'shell_environment_policy.exclude=["${GATEWAY_KEY_ENV}"]'`;
      return {
        binaryPath: base.binaryPath,
        homePath: base.homePath,
        shadowHomePath: base.shadowHomePath,
        launchArgs: [base.launchArgs, ...overrides.map(([name, value]) => `-c '${name}="${value}"'`), keepFromShells].filter(Boolean).join(' '),
        customModels: models,
      };
    },
  }),
  opencode: Object.freeze({
    configKeys: ['binaryPath'],
    compatible: () => true,
    environment: (gateway, models, files) => [plain('OPENCODE_CONFIG', files.config)],
    config: (gateway, models, base) => ({ binaryPath: base.binaryPath }),
    // The key has its own file, so the config can be rewritten without knowing it.
    file: (gateway, models, files) => {
      const id = providerId(gateway).replaceAll('_', '-');
      return JSON.stringify({
        // Braces would be expanded by OpenCode: see models.mjs.
        provider: { [id]: { name: gateway.name.replace(/[{}]/g, ''), npm: '@ai-sdk/openai-compatible',
          options: { baseURL: `${gateway.url}/v1`, apiKey: `{file:${files.key}}` },
          models: Object.fromEntries(models.map(model => [model, { name: model }])) } },
        enabled_providers: [id],
      }, null, 2);
    },
  }),
});

export const instanceIdFor = (gatewayId, agent) => `${agent.driver}_gw_${gatewayId}`;

/** Where an agent's files live, for an agent that takes settings from files. */
export const filesFor = (agent, gateway, dir) => SPECS[agent.id].file ? { config: path.join(dir, `${gateway.id}.json`), key: path.join(dir, `${gateway.id}.key`) } : null;

/** The text of an agent's config file, or null if it has none. */
export const fileText = (agent, gateway, dir) => {
  const files = filesFor(agent, gateway, dir);
  return files ? SPECS[agent.id].file(gateway, modelsFor(agent, gateway), files) : null;
};

/** What this gateway offers this agent, given how wide the person asked it to look. */
export function modelsFor(agent, gateway) {
  const spec = SPECS[agent.id], discovered = gateway.models?.ids ?? [], manual = gateway.models?.manual ?? [];
  const wide = gateway.agents?.[agent.id]?.scope === 'all';
  return cleanModelIds([...discovered.filter(id => wide || canChat(id) && spec.compatible(id)), ...manual]);
}

/** The parts of an agent's default instance a gateway instance runs with, so both use the same install and home. */
export function inheritedFrom(agent, instances) {
  const config = instances?.[agent.driver]?.config ?? {};
  const pick = key => typeof config[key] === 'string' && config[key].trim() ? config[key] : undefined;
  return { binaryPath: pick('binaryPath'), homePath: pick('homePath'), shadowHomePath: pick('shadowHomePath'), launchArgs: pick('launchArgs') };
}

const defined = value => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

/** The instance a gateway asks for. Secret rows are placeholders until `mergeInstance`. */
export function desiredInstance(agent, gateway, { instances = {}, enabled = true, dir = '' } = {}) {
  const spec = SPECS[agent.id], models = modelsFor(agent, gateway);
  return {
    driver: agent.driver,
    displayName: `${agent.short} · ${gateway.name}`,
    accentColor: gateway.accent,
    enabled,
    environment: [...spec.environment(gateway, models, filesFor(agent, gateway, dir)), plain(GATEWAY_INSTANCE_ENV, instanceIdFor(gateway.id, agent))],
    config: defined(spec.config(gateway, models, inheritedFrom(agent, instances))),
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
  const served = new Set(discovered.map(id => id.toLowerCase()));
  return provider.models.filter(model => !model.isCustom && !served.has(String(model.slug).toLowerCase())).map(model => model.slug);
}

export { AGENTS };
