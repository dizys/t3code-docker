// What a gateway is, as data: the wire protocols, the presets the Add sheet
// offers, and the agents that can use one. The page draws from this over the
// API, so a new preset needs no client change.
//
// An agent is listed here only when a gateway can be scoped to one T3 instance
// without writing to a file that every instance of that agent reads. Anything
// else would send the person's direct sign-in through the gateway as well.

/** The variable an instance carries the key in. The key itself is never in a launch argument or a config value. */
export const GATEWAY_KEY_ENV = 'T3_GATEWAY_KEY';

/** Names an instance on its agent processes, so they can be found later. Not a secret. */
export const GATEWAY_INSTANCE_ENV = 'T3_GATEWAY_INSTANCE';

/** Agents need some token even when a local gateway takes none. */
export const NO_KEY = 'no-key-needed';

export const PROTOCOLS = Object.freeze({
  messages: Object.freeze({ id: 'messages', name: 'Anthropic Messages', short: 'Messages API', path: '/v1/messages' }),
  responses: Object.freeze({ id: 'responses', name: 'OpenAI Responses', short: 'Responses API', path: '/v1/responses' }),
  chat: Object.freeze({ id: 'chat', name: 'OpenAI Chat Completions', short: 'Chat API', path: '/v1/chat/completions' }),
});

export const PRESETS = Object.freeze([
  Object.freeze({ id: 'cliproxyapi', name: 'CLIProxyAPI', blurb: 'Self-hosted', url: 'http://host.docker.internal:8317', keyHint: 'A value from access.api-keys in its config.', docs: 'https://help.router-for.me/', mark: 'cliproxyapi', hub: true }),
  Object.freeze({ id: 'litellm', name: 'LiteLLM', blurb: 'Self-hosted', url: 'http://host.docker.internal:4000', keyHint: 'A virtual key, or the master key.', docs: 'https://docs.litellm.ai/docs/simple_proxy', mark: 'litellm' }),
  Object.freeze({ id: 'openrouter', name: 'OpenRouter', blurb: 'Hosted', url: 'https://openrouter.ai/api', keyHint: 'Starts with sk-or-.', docs: 'https://openrouter.ai/settings/keys', mark: 'openrouter' }),
  Object.freeze({ id: 'custom', name: 'Other', blurb: 'Any API', url: '', keyHint: 'Leave this empty if your gateway doesn’t ask for one.', docs: null }),
]);
export const presetOf = id => PRESETS.find(preset => preset.id === id) ?? null;

export const AGENTS = Object.freeze([
  Object.freeze({ id: 'claude', driver: 'claudeAgent', name: 'Claude Code', short: 'Claude', protocol: 'messages' }),
  Object.freeze({ id: 'codex', driver: 'codex', name: 'Codex', short: 'Codex', protocol: 'responses' }),
  Object.freeze({ id: 'opencode', driver: 'opencode', name: 'OpenCode', short: 'OpenCode', protocol: 'chat' }),
]);
export const agentOf = id => AGENTS.find(agent => agent.id === id) ?? null;

/** Agents that can't be scoped to one instance, and the sentence that says why. */
export const UNSUPPORTED_AGENTS = Object.freeze([
  Object.freeze({ id: 'pi', name: 'Pi', reason: 'Pi reads endpoints from its own models.json, which every Pi instance shares.' }),
  Object.freeze({ id: 'grok', name: 'Grok Build', reason: 'Grok Build reads endpoints from its global config, which every Grok instance shares.' }),
  Object.freeze({ id: 'cursor', name: 'Cursor', reason: 'Cursor only talks to its own service.' }),
  Object.freeze({ id: 'muse', name: 'Muse Code', reason: 'Muse Code has no custom endpoint setting.' }),
  Object.freeze({ id: 'antigravity', name: 'Antigravity', reason: 'Antigravity has no custom endpoint setting.' }),
]);

/** Colours for a gateway's instances in T3 Code's model picker. Picked once, then kept. */
export const ACCENTS = Object.freeze(['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6']);
