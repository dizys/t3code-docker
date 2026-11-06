// What the Gateways page says, with no DOM, so every sentence can be tested.
// The catalog comes from the server: presets, agents and protocols are its data.
const T3GatewayModel = (() => {
  'use strict';
  let catalog = { presets: [], agents: [], unsupported: [], protocols: {} };
  const setCatalog = value => { if (value) catalog = value; };
  const presets = () => catalog.presets;
  const agents = () => catalog.agents;
  const unsupported = () => catalog.unsupported;
  const presetOf = id => catalog.presets.find(preset => preset.id === id) || null;
  const agentOf = id => catalog.agents.find(agent => agent.id === id) || null;
  const protocolName = id => catalog.protocols[id]?.name || id;

  const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');
  const models = count => plural(count, 'model');

  // Each state an agent can be in, what it's called, and the one thing to do about it.
  const AGENT_STATES = Object.freeze({
    ready: { tone: 'ok', label: 'Ready' },
    starting: { tone: 'info', label: 'Starting…', busy: true },
    off: { tone: '', label: 'Off' },
    warning: { tone: 'warn', label: 'Needs a look' },
    error: { tone: 'danger', label: 'Not working', action: { name: 'apply', label: 'Try again' } },
    missing: { tone: 'warn', label: 'Removed in T3 Code', action: { name: 'apply', label: 'Reconnect' } },
    paused: { tone: 'warn', label: 'Turned off in T3 Code', action: { name: 'apply', label: 'Turn on' } },
    drift: { tone: 'warn', label: 'Changed in T3 Code', action: { name: 'apply', label: 'Restore' } },
    'key-stale': { tone: 'warn', label: 'Key changed in the Vault', action: { name: 'apply', label: 'Update' } },
    'not-installed': { tone: 'warn', label: 'Not installed', action: { name: 'install', label: 'Install…' } },
    unknown: { tone: '', label: 'Unknown' },
  });
  const agentState = row => {
    const state = AGENT_STATES[row.state] || AGENT_STATES.unknown;
    return { ...state, desc: row.detail || '' };
  };
  const needsAttention = row => Boolean(AGENT_STATES[row.state]?.action) || row.state === 'warning';

  /** The line under an agent's name. */
  const agentLine = row => {
    const agent = agentOf(row.id);
    return [agent ? protocolName(agent.protocol) : '', row.connected || row.models ? models(row.models) : ''].filter(Boolean).join(' · ');
  };

  const PROBLEMS = Object.freeze({ unauthorized: 'Key rejected', dns: 'Can’t find it', refused: 'Not answering', timeout: 'Not answering', unreachable: 'Can’t reach it', tls: 'Certificate not trusted', redirect: 'Redirects elsewhere', 'not-gateway': 'Not a gateway', invalid: 'Bad address' });
  const problemLabel = code => PROBLEMS[code] || 'Can’t reach it';

  /** A gateway's headline: whichever single thing matters most. */
  const gatewayState = (gateway, now, relTime) => {
    const check = gateway.check, attention = gateway.agents.filter(needsAttention);
    if (gateway.settling) return { tone: 'info', label: 'Connecting…', desc: 'Agents are starting', busy: true };
    if (check && !check.ok) return { tone: 'danger', label: problemLabel(check.code), desc: check.message || '' };
    if (gateway.key?.state === 'missing') return { tone: 'warn', label: 'Key missing', desc: gateway.key.credentialId + ' is no longer in the Vault' };
    if (attention.length) return { tone: 'warn', label: attention.length === 1 ? 'An agent needs a look' : plural(attention.length, 'agent') + ' need a look', desc: lastChecked(check, now, relTime) };
    if (!check) return { tone: '', label: 'Not checked', desc: '' };
    return { tone: 'ok', label: 'Connected', desc: lastChecked(check, now, relTime) };
  };
  const lastChecked = (check, now, relTime) => {
    if (!check) return '';
    const seen = 'checked ' + relTime(check.at, now);
    return check.listed ? models(check.count) + ' · ' + seen : seen.charAt(0).toUpperCase() + seen.slice(1);
  };

  /** Models a health check found that aren't applied yet. */
  const newModels = gateway => {
    if (!gateway.latest) return { added: [], removed: [] };
    const held = new Set(gateway.models.ids), latest = new Set(gateway.latest);
    return { added: gateway.latest.filter(id => !held.has(id)), removed: gateway.models.ids.filter(id => !latest.has(id)) };
  };

  /** The check's outcome, one line each, in the order someone reads them. */
  const checkLines = (result, { keyed }) => {
    if (!result?.ok) return [];
    const routes = Object.entries(result.protocols || {});
    return [
      { id: 'reach', tone: 'ok', text: 'Reached in ' + (result.ms ?? 0) + ' ms' },
      { id: 'key', tone: 'ok', text: keyed ? 'Key accepted' : 'No key needed' },
      result.models.listed
        ? { id: 'models', tone: result.models.ids.length ? 'ok' : 'warn', text: result.models.ids.length ? models(result.models.ids.length) + ' available' : 'No models listed yet' }
        : { id: 'models', tone: 'warn', text: 'Doesn’t list its models. You can add them by hand.' },
      ...routes.filter(([, state]) => state === 'available').map(([id]) => ({ id, tone: 'ok', text: protocolName(id) })),
      ...routes.filter(([, state]) => state === 'missing').map(([id]) => ({ id, tone: 'muted', text: 'No ' + protocolName(id) })),
      ...routes.filter(([, state]) => state === 'unknown').map(([id]) => ({ id, tone: 'warn', text: 'Couldn’t confirm ' + protocolName(id) })),
    ];
  };

  /** Whether an agent can use what a check found, and the sentence if not. */
  const availability = (agent, result) => {
    const state = result?.protocols?.[agent.protocol];
    if (state === 'missing') return { usable: false, reason: 'This gateway has no ' + protocolName(agent.protocol) + ' API, which ' + agent.name + ' needs.' };
    // A test that failed says nothing about models, which isn't the same as none.
    return { usable: true, unconfirmed: state === 'unknown', offered: result?.ok ? result.offers?.[agent.id] ?? null : null };
  };

  /** A failed test's button: some failures are worth going past, and some aren't. */
  const canContinueAnyway = result => Boolean(result && !result.ok && !['invalid', 'unauthorized'].includes(result.code));

  const CONFLICT_SENTENCES = Object.freeze({
    ANTHROPIC_BASE_URL: 'sends every Claude instance to',
    ANTHROPIC_AUTH_TOKEN: 'sets a token for every Claude instance',
    ANTHROPIC_API_KEY: 'sets a key for every Claude instance',
    apiKeyHelper: 'sends a second key with every request',
  });
  const conflictSentence = conflict => {
    const name = conflict.keys.includes('ANTHROPIC_BASE_URL') ? 'ANTHROPIC_BASE_URL' : conflict.keys[0];
    const what = CONFLICT_SENTENCES[name] || 'overrides every Claude instance';
    return conflict.file + ' ' + what + (name === 'ANTHROPIC_BASE_URL' && conflict.host ? ' ' + conflict.host : '') + ', so a gateway here can’t take effect.';
  };

  /** The names a new gateway's agents will have in T3 Code's model picker. */
  const instanceNames = (ids, name) => ids.map(id => (agentOf(id)?.short || id) + ' · ' + name);

  return { setCatalog, presets, agents, unsupported, presetOf, agentOf, protocolName, models, plural, agentState, agentLine, needsAttention, gatewayState, newModels, checkLines, availability, canContinueAnyway, conflictSentence, problemLabel, instanceNames };
})();
