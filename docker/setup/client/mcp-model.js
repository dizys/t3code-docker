// Pure MCP view model. Shared definitions and native copies remain separate;
// On means configured for a new session, never a live connection claim.
const T3McpModel = (() => {
  'use strict';
  const providers = [
    { id: 'claude', name: 'Claude Code', control: 'Add or remove', managed: true },
    { id: 'codex', name: 'Codex', control: 'On or off', managed: true, canDisable: true },
    { id: 'opencode', name: 'OpenCode', control: 'On or off', managed: true, canDisable: true },
    { id: 'cursor', name: 'Cursor', control: 'Add or remove', managed: true },
    { id: 'grok', name: 'Grok Build', control: 'On or off', managed: true, canDisable: true },
    { id: 'muse', name: 'Muse Code', control: 'On or off', managed: true, canDisable: true },
    { id: 'antigravity', name: 'Antigravity', control: 'On or off', managed: true, canDisable: true },
    { id: 'pi', name: 'Pi', control: 'On or off', managed: true, canDisable: true },
  ];
  const columns = (installed, all = false) => providers.filter(provider => all || installed.includes(provider.id));
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
  const sameValue = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
  const definition = server => {
    if (!server) return server;
    const { enabled, ...rest } = server;
    return rest;
  };
  const sameDefinition = (a, b) => sameValue(definition(a), definition(b));
  const nameOf = id => providers.find(p => p.id === id)?.name || id;
  const has = (provider, name) => ['linked', 'diverged'].some(key => provider?.[key]?.includes(name)) || provider?.own?.some(row => row.name === name);
  const state = (data, row, id) => {
    const provider = data?.providers?.find(p => p.provider === id);
    if (!provider?.supported) return { kind: 'unsupported', label: '—', reason: provider?.error || 'Not managed here.' };
    if (provider.error) return { kind: 'error', label: '—', reason: provider.error };
    if (!row.shared && provider.own?.some(entry => entry.name === row.name)) return { kind: 'own', label: 'Own entry' };
    if (provider.diverged?.includes(row.name)) return { kind: 'differs', label: 'Differs' };
    if (provider.linked?.includes(row.name)) return provider.disabled?.includes(row.name) ? { kind: 'off', label: 'Off' } : { kind: 'on', label: 'On' };
    return { kind: 'none', label: '—' };
  };
  const rows = data => [
    ...(data?.shared?.servers || []).map(server => ({ ...server, shared: true, key: 'shared:' + server.name })),
    ...(data?.ownGroups || []).map(group => ({ ...data.providers.flatMap(p => p.own || []).find(row => row.name === group.name), ...group, shared: false, key: 'own:' + group.name,
      recognized: group.providers.some(id => data.providers.find(p => p.provider === id)?.own?.find(row => row.name === group.name)?.recognized) })),
  ];
  const attention = (data, installed) => (data?.providers || []).filter(p => p.supported && (!installed || installed.includes(p.provider))).flatMap(p => [
    ...(p.error ? [{ kind: 'error', provider: p.provider, error: p.error }] : []),
    ...(p.diverged || []).map(name => ({ kind: 'differs', provider: p.provider, name })),
  ]);
  const filter = (data, options = {}) => rows(data).filter(row => {
    const search = [row.name, ...(row.command || []), row.url || '', ...(row.providers || []).flatMap(id => {
      const own = data.providers.find(p => p.provider === id)?.own?.find(s => s.name === row.name); return [...(own?.command || []), own?.url || ''];
    })].join(' ').toLowerCase();
    return (!options.query || search.includes(options.query.trim().toLowerCase()))
      && (!options.agent || has(data.providers.find(p => p.provider === options.agent), row.name))
      && (!options.attention || attention(data, options.installed).some(item => item.name === row.name || item.kind === 'error'));
  });
  const used = (data, row, installed) => providers.filter(p => p.managed && (!installed || installed.includes(p.id)) && has(data?.providers?.find(a => a.provider === p.id), row.name)).map(p => p.id);
  const fieldLabel = field => ({ type: 'Type', command: 'Command', args: 'Arguments', url: 'URL', env: 'Variable', header: 'Header', format: 'Format' }[field] || field);
  const describeDiff = diff => {
    if (!diff) return 'Its copy no longer matches the shared server. Review the differences before replacing it.';
    const fields = (diff.fields || []).map(f => f.key ? f.key + (f.field === 'header' ? ' header' : ' variable') : f.field === 'url' ? 'URL' : fieldLabel(f.field).toLowerCase());
    if (diff.extraOptions?.length) fields.push('agent-specific options');
    return fields.length ? 'Its copy has a different ' + (fields.length < 2 ? fields.join('') : fields.slice(0, -1).join(', ') + ' and ' + fields.at(-1)) + ', so it no longer matches the shared server.' : 'Its copy no longer matches the shared server.';
  };
  return { providers, columns, nameOf, state, rows, attention, filter, used, has, fieldLabel, describeDiff, sameValue, sameDefinition };
})();
