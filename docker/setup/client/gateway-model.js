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
  const protocolShort = id => catalog.protocols[id]?.short || protocolName(id);

  const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');
  const models = count => plural(count, 'model');
  const listOf = names => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];

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

  // The same states in a table cell, where only a word or two fits.
  const CELLS = Object.freeze({
    starting: { label: 'Starting…', busy: true },
    warning: { label: 'Needs a look', tone: 'warn' },
    error: { label: 'Not working', tone: 'danger' },
    missing: { label: 'Removed', tone: 'warn' },
    paused: { label: 'Turned off', tone: 'warn' },
    drift: { label: 'Changed', tone: 'warn' },
    'key-stale': { label: 'Old key', tone: 'warn' },
    'not-installed': { label: 'Not installed', tone: 'warn' },
    unknown: { label: 'Unknown', tone: 'muted' },
  });
  const cellState = row => row.state === 'ready' ? { label: models(row.models), tone: '' } : CELLS[row.state] || CELLS.unknown;

  /** Each thing someone should look at across their gateways, with the one action that fixes it. */
  const attention = gateways => gateways.flatMap(gateway => {
    if (gateway.settling) return [];
    const items = [], at = suffix => gateway.id + ':' + suffix, name = gateway.name;
    const rejected = gateway.check?.code === 'unauthorized';
    if (gateway.check && !gateway.check.ok) items.push({ key: at('check'), id: gateway.id, tone: 'danger', title: rejected ? name + ' turned its key down' : name + ' isn’t answering',
      desc: [gateway.check.message, gateway.check.hint].filter(Boolean).join(' '), action: rejected ? { name: 'replace-key', label: 'Replace key…' } : { name: 'test', label: 'Test again' } });
    if (gateway.key?.state === 'missing') items.push({ key: at('key'), id: gateway.id, tone: 'warn', title: name + '’s key left the Vault',
      desc: gateway.key.credentialId + ' is gone. Agents keep working on their copy until you replace it.', action: { name: 'replace-key', label: 'Replace…' } });
    const stale = gateway.agents.filter(row => row.state === 'key-stale');
    if (stale.length) items.push({ key: at('stale'), id: gateway.id, tone: 'warn', title: name + '’s key changed in the Vault',
      desc: listOf(stale.map(row => agentOf(row.id)?.name || row.id)) + (stale.length === 1 ? ' still uses the old copy.' : ' still use the old copy.') + ' Updating restarts ' + (stale.length === 1 ? 'it.' : 'them.'), action: { name: 'apply', label: 'Update…' } });
    for (const row of gateway.agents.filter(entry => needsAttention(entry) && entry.state !== 'key-stale')) {
      const state = agentState(row);
      items.push({ key: at(row.id), id: gateway.id, agent: row.id, tone: 'warn', title: row.displayName + ': ' + state.label.toLowerCase(),
        desc: row.detail || AGENT_ADVICE[row.state] || '', action: state.action ? { name: state.action.name, label: state.action.label + (state.action.label.endsWith('…') ? '' : '…') } : { name: 'inspect', label: 'Review…' } });
    }
    if (gateway.limits?.state === 'error') items.push({ key: at('limits'), id: gateway.id, tone: 'warn', title: 'T3 Code can’t read ' + name + '’s limits', desc: gateway.limits.detail || '', action: { name: 'inspect', label: 'Review…' } });
    return items;
  });
  const AGENT_ADVICE = Object.freeze({
    missing: 'It’s no longer in T3 Code. Reconnect to add it back.',
    paused: 'It was turned off in T3 Code’s settings.',
    drift: 'Its settings were changed in T3 Code. Restoring puts this gateway’s back and restarts it.',
    'not-installed': 'Install it on the Agents page to use this gateway with it.',
  });

  /** Words someone might search a gateway by. */
  const matches = (gateway, query) => {
    const text = query.trim().toLowerCase();
    return !text || [gateway.name, gateway.host, gateway.url, presetOf(gateway.preset)?.name, ...gateway.models.ids].some(value => String(value || '').toLowerCase().includes(text));
  };

  /** A gateway's Limits, as the page words them. */
  const limitsState = limits => {
    const count = limits?.accounts?.length || 0;
    if (limits?.state === 'on') return { tone: count ? 'ok' : '', label: count ? plural(count, 'account') : 'No accounts', desc: count ? accountsLine(limits.accounts) : 'This gateway has no enabled accounts for Limits to show.' };
    if (limits?.state === 'partial') return { tone: 'warn', label: limits.accounts.filter(account => !account.unavailable && account.windows.length).length + ' of ' + count + ' reporting', desc: 'Some accounts could not report quota. Open this gateway for details.' };
    if (limits?.state === 'unavailable') return { tone: 'warn', label: 'Quota unavailable', desc: plural(count, 'account') + ' connected, but no quota is available. Open this gateway for details.' };
    if (limits?.state === 'reading') return { tone: 'info', label: 'Reading accounts…', busy: true, desc: 'T3 Code is reading this gateway for the first time.' };
    if (limits?.state === 'error') return { tone: 'warn', label: 'Can’t read accounts', desc: limits.detail || '' };
    if (limits?.state === 'unknown') return { tone: '', label: 'Limits unknown', desc: 'T3 Code isn’t answering.' };
    if (limits?.state === 'paused') return { tone: '', label: 'Paused in T3 Code', desc: 'Turned off in T3 Code’s settings.' };
    return { tone: '', label: 'Not set up', desc: '' };
  };
  /** What's left on an account, the way Usage → Limits says it. */
  const quotaLeft = window => window.left > 0 && window.left < 1 ? '<1% left' : Math.round(window.left) + '% left';
  const windowsLine = account => (account.windows || []).map(window => window.label + ' ' + quotaLeft(window)).join(' · ');
  const quotaProvider = driver => ({ claudeAgent: 'Claude', codex: 'Codex', antigravity: 'Antigravity', muse: 'Muse Code', 'opencode-go': 'OpenCode Go' })[driver] || String(driver || 'Gateway').replace(/[-_]/g, ' ');
  const accountsLine = accounts => [...new Set(accounts.map(account => account.driver))]
    .map(driver => accounts.filter(account => account.driver === driver).length + ' ' + quotaProvider(driver)).join(' · ');
  const resetLine = (window, now = Date.now()) => {
    const at = Date.parse(window.resetsAt);
    if (!Number.isFinite(at)) return 'Reset time unavailable';
    if (at <= now) return 'Reset due; refresh Limits';
    const minutes = Math.ceil((at - now) / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    return 'Resets in ' + (days ? days + 'd ' + hours % 24 + 'h' : hours ? hours + 'h ' + minutes % 60 + 'm' : minutes + 'm');
  };

  const FAMILIES = Object.freeze([['Anthropic', /claude/i], ['OpenAI', /(?:^|\/)(?:chatgpt|codex|dall-e|gpt|o\d|omni|text-embedding|tts|whisper)/i], ['Google', /gemini|imagen|veo/i], ['Meta', /llama|muse/i], ['xAI', /grok/i], ['DeepSeek', /deepseek/i], ['Mistral', /codestral|mistral/i], ['Qwen', /qwen/i]]);
  /** Model ids under the company that makes them, in the order someone looks for them. */
  const modelGroups = ids => {
    const groups = new Map();
    for (const id of ids) {
      const name = FAMILIES.find(([, pattern]) => pattern.test(id))?.[0] || 'Other';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(id);
    }
    const order = [...FAMILIES.map(([name]) => name), 'Other'];
    return [...groups].sort(([left], [right]) => order.indexOf(left) - order.indexOf(right)).map(([name, models]) => ({ name, models }));
  };

  /** The line under an agent's name. */
  const agentLine = row => {
    const agent = agentOf(row.id);
    return [agent ? protocolName(agent.protocol) : '', row.connected || row.models ? models(row.models) : ''].filter(Boolean).join(' · ');
  };

  const PROBLEMS = Object.freeze({ unauthorized: 'Key rejected', dns: 'Can’t find it', refused: 'Not answering', timeout: 'Not answering', unreachable: 'Can’t reach it', tls: 'Certificate not trusted', redirect: 'Redirects elsewhere', 'not-gateway': 'Not a gateway', invalid: 'Bad address' });
  const problemLabel = code => PROBLEMS[code] || 'Can’t reach it';

  /** What's wrong, in the same words as the cells, rather than "needs a look". */
  const troubleLabel = rows => {
    const label = row => (CELLS[row.state] || CELLS.unknown).label;
    if (rows.length === 1) return (agentOf(rows[0].id)?.short || rows[0].id) + ': ' + label(rows[0]).toLowerCase();
    return rows.every(row => row.state === rows[0].state) ? label(rows[0]) + ' · ' + rows.length + ' agents' : rows.length + ' agents need a look';
  };

  /** A gateway's headline: whichever single thing matters most. */
  const gatewayState = (gateway, now, relTime) => {
    const check = gateway.check, attention = gateway.agents.filter(needsAttention);
    if (gateway.settling) return { tone: 'info', label: 'Connecting…', desc: 'Agents are starting', busy: true };
    if (check && !check.ok) return { tone: 'danger', label: problemLabel(check.code), desc: check.message || '' };
    if (gateway.key?.state === 'missing') return { tone: 'warn', label: 'Key missing', desc: gateway.key.credentialId + ' is no longer in the Vault' };
    if (attention.length) return { tone: 'warn', label: troubleLabel(attention), desc: lastChecked(check, now, relTime), brief: briefly(check, now, relTime) };
    if (!check) return { tone: '', label: 'Not checked', desc: '' };
    return { tone: 'ok', label: 'Connected', desc: lastChecked(check, now, relTime), brief: briefly(check, now, relTime) };
  };
  const lastChecked = (check, now, relTime) => {
    if (!check) return '';
    const seen = 'checked ' + relTime(check.at, now);
    return check.listed ? models(check.count) + ' · ' + seen : seen.charAt(0).toUpperCase() + seen.slice(1);
  };

  /** The same in a table column, which has no room for "checked". */
  const briefly = (check, now, relTime) => check ? [check.listed ? models(check.count) : '', relTime(check.at, now)].filter(Boolean).join(' · ') : '';

  /** What a health check found that isn't applied yet. `changed` carries models whose advertised reasoning controls moved while the ids held still. */
  const newModels = gateway => {
    if (!gateway.latest) return { added: [], removed: [], changed: [] };
    const held = new Set(gateway.models.ids), latest = new Set(gateway.latest);
    const fact = value => JSON.stringify(value ?? null);
    return { added: gateway.latest.filter(id => !held.has(id)), removed: gateway.models.ids.filter(id => !latest.has(id)),
      changed: gateway.latest.filter(id => held.has(id) && fact(gateway.latestCapabilities?.[id]) !== fact(gateway.models.capabilities?.[id])) };
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

  return { setCatalog, presets, agents, unsupported, presetOf, agentOf, protocolName, protocolShort, models, plural, listOf, agentState, agentLine, needsAttention, cellState, attention, matches, limitsState, accountsLine, windowsLine, quotaProvider, quotaLeft, resetLine, modelGroups, gatewayState, newModels, checkLines, availability, canContinueAnyway, conflictSentence, problemLabel, instanceNames };
})();
