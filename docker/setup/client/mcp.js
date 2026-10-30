// On-demand MCP library. Status polls cannot morph its owned subtree, focused
// cells, menus or drafts. Every mutation refreshes native truth before unlock.
const T3McpUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3McpModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const mark = id => html`<span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(id))}</span>`;
  const create = ({ api, getStatus, render }) => {
    let data = null, query = '', agent = '', needsAttention = false, showAll = false, error = null, started = false, scanning = false, epoch = 0, scan = null, markup = null;
    const mutationErrors = new Map(), undos = new Map();
    const changing = new Map(), collapsed = new Set(), differences = new Map();
    const installed = () => S.providers.filter(p => getStatus()?.harnesses?.some(h => h.id === p.id && h.installed)).map(p => p.id);
    const managed = () => S.providers.filter(p => p.managed && installed().includes(p.id));
    const columns = () => S.columns(installed(), showAll);
    const columnNote = provider => !provider.managed && provider.id !== 'grok' ? provider.control : installed().includes(provider.id) ? provider.control : 'Not installed';
    const rows = () => S.rows(data);
    const library = () => ({ data, installed: installed(), managed: managed(), changing, home: getStatus()?.paths?.volume });
    const pathLabel = value => T3SkillModel.displayPath(value || '', library().home);
    const detail = row => row.shared || row.identical ? row.type === 'remote' ? row.url : T3McpCommand.line(row.command || [])
      : (row.providers?.length === 2 ? 'Two' : row.providers?.length) + ' different versions, in ' + M.listOf((row.providers || []).map(S.nameOf));
    const keyChips = row => html`<span class="tc-keys">${[...(row.envKeys || []), ...(row.headerKeys || [])].map(key => html`<span class="tc-key" title="${key}">${icon('key-round')}${key}</span>`)}</span>`;
    const paint = () => {
      markup = body(); render();
      const mount = document.getElementById('mcp-library'); if (mount) Kit.patch(mount, markup);
      inspector.repaint();
    };
    const load = (force = false) => {
      if (scan && !force) return scan;
      const version = ++epoch; started = true; scanning = true; error = null; paint();
      const request = api('/context/mcp' + (force ? '?refresh=1' : '')).then(response => {
        if (version !== epoch) return false;
        const usableInventory = response.status === 200 && Array.isArray(response.data?.shared?.servers) && Array.isArray(response.data?.providers);
        if (!response.ok && !usableInventory) { error = response.error; return false; }
        data = response.data; differences.clear();
        for (const [id, undo] of undos) if (undo.sharedRevision !== data.shared.revision || undo.providerRevision !== data.providers.find(p => p.provider === id)?.revision) undos.delete(id);
        if (getStatus()?.context) getStatus().context.mcp = data;
        // At most three detail reads; no credentials or values enter the list.
        const attention = S.attention(data, installed()).filter(item => item.kind === 'differs').slice(0, 3);
        for (const item of attention) void api('/context/mcp/diff?provider=' + item.provider + '&name=' + encodeURIComponent(item.name)).then(result => {
          if (version !== epoch || !result.ok || result.data.sharedRevision !== data.shared.revision || result.data.providerRevision !== data.providers.find(p => p.provider === item.provider)?.revision) return;
          differences.set(item.provider + ':' + item.name, { fields: result.data.fields.map(({ field, key }) => ({ field, key })), extraOptions: result.data.extraOptions });
          paint();
        });
        return true;
      }).finally(() => { if (version === epoch) { scanning = false; scan = null; paint(); } });
      scan = request; return request;
    };
    const change = async (provider, name, linked, options = {}) => {
      const current = data?.providers?.find(p => p.provider === provider);
      if (!current?.revision || changing.has(provider) || data.shared.error) return false;
      const diverged = current.diverged?.includes(name), wasOff = current.disabled?.includes(name);
      const sharedRevision = options.sharedRevision || data.shared.revision, providerRevision = options.providerRevision || current.revision;
      if (diverged && !options.reviewed) {
        const yes = await Kit.confirm({ title: linked ? 'Update ' + name + ' in ' + S.nameOf(provider) + '?' : 'Remove ' + name + ' from ' + S.nameOf(provider) + '?',
          body: linked ? 'Replaces the complete native entry, including agent-specific options. A private backup is kept beside the settings file.' : 'This agent’s copy differs from the shared server. Its own changes are removed too. A private backup is kept beside the settings file.',
          confirm: linked ? 'Update to shared' : 'Remove', tone: linked ? 'primary' : 'danger' });
        if (!yes || changing.has(provider)) return false;
      }
      const focusedKey = document.activeElement?.getAttribute('data-key');
      const fromInspector = Boolean(document.activeElement?.closest('.tc-mcp-inspector'));
      const restoreFocus = () => {
        if (document.activeElement !== document.body && !document.activeElement?.matches('.tc-mcp-inspector')) return;
        if (focusedKey) document.querySelector('[data-key="' + CSS.escape(focusedKey) + '"]')?.focus({ preventScroll: true });
        if (fromInspector) inspector.restoreFocus(provider);
      };
      mutationErrors.delete(provider); undos.delete(provider); changing.set(provider, name); paint();
      let response;
      try {
        response = await api('/context/mcp/link', { body: { provider, name, linked, sharedRevision, providerRevision,
          ...(options.enabled !== undefined ? { enabled: options.enabled } : {}) } });
        await load(true);
      } finally { changing.delete(provider); paint(); restoreFocus(); }
      if (!response?.ok) {
        const title = response?.status === 409 || response?.data?.code === 'conflict' ? 'Settings changed elsewhere. Showing the current state.' : 'Couldn’t change ' + name + ' in ' + S.nameOf(provider);
        mutationErrors.set(provider, { name, title, error: response?.error }); paint();
        Kit.toast(title, { tone: 'danger', detail: response?.error });
        return false;
      }
      const text = linked ? options.enabled === false ? 'Turned off ' + name + ' in ' + S.nameOf(provider) : options.enabled === true ? 'Turned on ' + name + ' in ' + S.nameOf(provider) : 'Added ' + name + ' to ' + S.nameOf(provider) : 'Removed ' + name + ' from ' + S.nameOf(provider);
      // Undo only a matched copy. It is revision checked against the post-write
      // snapshot and preserves Off; it never replaces a newly changed copy.
      const undoSharedRevision = data.shared.revision, undoProviderRevision = data.providers.find(p => p.provider === provider).revision;
      const undo = !linked && !diverged ? { label: 'Undo', run: () => change(provider, name, true, { enabled: wasOff ? false : undefined,
        sharedRevision: undoSharedRevision, providerRevision: undoProviderRevision }) } : null;
      if (undo) undos.set(provider, { name, run: undo.run, sharedRevision: undoSharedRevision, providerRevision: undoProviderRevision });
      paint(); Kit.toast(text, { action: undo }); Kit.announce(text); return true;
    };
    const context = { api, library, mutationErrors, undos, refresh: () => load(true), change,
      edit: name => edit(name), share: (name, provider, replace = false) => share(name, provider, replace), remove: name => remove(name), mark, keyChips, pathLabel };
    const inspector = T3McpInspector.create(context), editor = T3McpEditor.create(context);
    const prepare = async () => { if (!data && !await load()) return false; return true; };
    const edit = async name => { if (changing.size) return; if (!await prepare() || !await inspector.close('edit')) return; await editor.open({ name }); };
    const share = async (name, provider, replace = false) => { if (changing.size) return; if (!await prepare() || !await inspector.close('share')) return; await editor.open({ name, provider, mode: 'share', replace }); };
    const remove = async name => { if (!await prepare()) return; await editor.remove(name, () => inspector.close('removed')); };
    const cell = (row, provider) => {
      const state = S.state(data, row, provider.id), busy = changing.has(provider.id), pending = changing.get(provider.id) === row.name;
      const label = row.name + ' in ' + provider.name + ': ' + state.label.toLowerCase();
      const key = 'mcp-cell-' + row.key + ':' + provider.id;
      if (provider.managed && !installed().includes(provider.id)) return html`<span class="tc-cell tc-cell--unsupported" title="${provider.name} isn’t installed. Its saved settings stay unchanged." aria-label="${label}. Agent not installed; saved settings are read-only.">${state.label}</span>`;
      if (pending) return html`<span class="tc-cell" role="status"><span class="tc-spinner" aria-hidden="true"></span><span class="tc-sr">Saving ${row.name} in ${provider.name}</span></span>`;
      if (['via', 'own', 'error', 'unsupported'].includes(state.kind)) return html`<span class="tc-cell tc-cell--${state.kind}" title="${state.kind === 'via' ? 'Grok Build may import ' + S.nameOf(state.source || 'claude') + '’s servers. It isn’t managed here and doesn’t report what it loads.' : state.reason || ''}"><span>${state.label}</span></span>`;
      if (state.kind === 'none') return html`<button class="tc-cell tc-cell--none" type="button" data-key="${key}" data-cmd="${row.shared ? 'mcp.link' : 'mcp.share'}" data-provider="${provider.id}" data-id="${row.name}" aria-label="${row.shared ? 'Add' : 'Share'} ${row.name} ${row.shared ? 'to' : 'with'} ${provider.name}"${disabled(busy || !row.shared && !row.recognized || data.shared.error)}><span class="tc-cell-dash">—</span><span class="tc-cell-add">${icon('plus')}Add</span></button>`;
      return html`<button class="tc-cell" data-tone="${state.kind === 'differs' ? 'warn' : state.kind === 'off' ? 'muted' : ''}" type="button" data-key="${key}" data-cmd="mcp.cell" data-provider="${provider.id}" data-id="${row.name}" aria-label="${label}" aria-haspopup="menu"${disabled(busy || data.shared.error)}>${state.kind === 'differs' ? html`<span class="tc-dot tc-dot--warn"></span>` : ''}${state.label}${icon('chevron-down')}</button>`;
    };
    const groupLabel = shared => shared ? 'Shared servers' : 'Only in an agent’s settings';
    const footer = () => html`<div class="tc-sk-library-foot"><span>${icon('info', 'tc-icon--sm')}Agents load servers when a session starts. Remote servers that need sign-in sign in from each agent.</span><span class="tc-sk-scan-time" title="${M.absTime(data?.scannedAt)}">${data?.scannedAt ? 'Read ' + M.relTime(data.scannedAt, Date.now()) : ''}</span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="mcp.refresh"${disabled(scanning || changing.size)}>${scanning ? html`<span class="tc-spinner"></span>Scanning` : html`${icon('refresh-cw')}Rescan`}</button></div>`;
    const table = filtered => html`<div class="tc-group tc-sk-table tc-mcp-table"><div class="tc-mx-scroll" tabindex="0" aria-label="MCP servers by agent"><div class="tc-mx" role="table" aria-label="MCP servers and agent settings" data-no-agents="${String(!columns().length)}" style="--mx-agent-count:${columns().length}">
      <div class="tc-mx-head" role="row"><div class="tc-mx-head-label" role="columnheader"><span>Server</span>${installed().length < S.providers.length ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs tc-mx-columns" type="button" data-key="mcp-columns" data-cmd="mcp.columns" aria-haspopup="menu" aria-label="Agent columns: ${showAll ? 'all agents' : 'installed agents'}">${showAll ? 'All agents' : 'Installed agents'}${icon('chevron-down', 'tc-chev')}</button>` : ''}</div>${columns().map(provider => html`<div class="tc-mx-agent" role="columnheader" data-key="mcp-head-${provider.id}"${!installed().includes(provider.id) ? raw(' data-uninstalled') : ''}><span class="tc-mx-agent-name">${mark(provider.id)}${provider.name}${data.providers.find(p => p.provider === provider.id)?.supported && data.providers.find(p => p.provider === provider.id)?.error ? html`<span class="tc-dot tc-dot--warn" aria-label="Settings unreadable"></span>` : ''}</span><span class="tc-mx-agent-kind">${columnNote(provider)}</span></div>`)}</div>
      ${[true, false].map(shared => { const group = filtered.filter(row => row.shared === shared); if (!group.length) return ''; return html`<div role="rowgroup" data-key="mcp-group-${shared}"><div role="row"><div class="tc-mx-group" role="cell" aria-colspan="${columns().length + 1}"><button class="tc-mx-group-toggle" type="button" data-cmd="mcp.group" data-id="${String(shared)}" aria-expanded="${String(!collapsed.has(shared))}">${icon(collapsed.has(shared) ? 'chevron-right' : 'chevron-down')}${groupLabel(shared)}</button>${shared ? html`<code title="${data.shared.path || ''}">${pathLabel(data.shared.path || '~/.t3/setup/mcp/servers.json')}</code>` : ''}<span>${group.length}</span><span>·</span><span class="tc-mx-readers">${shared ? 'Defined once, added to each agent you choose' : 'Not shared. Share one to manage it for every agent from here.'}</span></div></div>
      ${collapsed.has(shared) ? '' : group.map(row => html`<div class="tc-mx-row" role="row" data-key="mcp-${row.key}"><div class="tc-mx-skill" role="cell"><div class="tc-mx-skill-copy"><div class="tc-mx-name"><button class="tc-skill-name" type="button" data-key="mcp-name-${row.key}" data-cmd="${shared ? 'mcp.view' : 'mcp.share'}" data-id="${row.name}"${disabled(!shared && (!row.recognized || data.shared.error))}>${row.name}</button>${row.type ? html`<span class="tc-badge">${row.type === 'remote' ? 'Remote' : 'Local'}</span>` : ''}${!shared ? html`<button class="tc-btn tc-btn--xs" type="button" data-cmd="mcp.share" data-id="${row.name}" title="${row.recognized ? 'Manage this server for your other agents' : 'This entry’s format isn’t supported here.'}"${disabled(!row.recognized || data.shared.error)}>Share…</button>` : ''}</div><div class="tc-mcp-detail${!row.shared && !row.identical ? ' tc-mcp-detail--prose' : ''}" title="${detail(row)}">${row.shared || row.identical ? icon(row.type === 'remote' ? 'globe' : 'terminal') : ''}<span>${detail(row) || 'Unsupported native entry'}</span></div>${row.shared || row.identical ? keyChips(row) : ''}</div></div>${columns().map(provider => html`<div class="tc-cellwrap" role="cell" data-key="mcp-${row.key}-${provider.id}">${cell(row, provider)}</div>`)}</div>`)}</div>`; })}
      </div></div>${footer()}</div>`;
    const phone = filtered => html`<div class="tc-sk-phone-list">${[true, false].map(shared => { const group = filtered.filter(row => row.shared === shared); if (!group.length) return ''; return html`<div class="tc-group tc-plist"><div class="tc-plist-group">${groupLabel(shared)}<span>· ${group.length}</span></div>${group.map(row => {
        const used = S.used(data, row, installed()), differs = used.filter(id => S.state(data, row, id).kind === 'differs'), off = used.filter(id => S.state(data, row, id).kind === 'off');
        return html`<button class="tc-prow" type="button" data-key="mcp-phone-${row.key}" data-cmd="${shared ? 'mcp.view' : 'mcp.share'}" data-id="${row.name}"${disabled(!shared && (!row.recognized || data.shared.error))}><span class="tc-prow-name tc-prow-name-line">${row.name}${row.type ? html`<span class="tc-badge">${row.type === 'remote' ? 'Remote' : 'Local'}</span>` : ''}</span>${shared || row.identical ? html`<span class="tc-prow-detail">${detail(row)}</span>` : ''}<span class="tc-prow-agents">${shared ? html`<span class="tc-agent-stack" aria-hidden="true">${used.map(mark)}</span><span>${off.length && !differs.length ? 'Off in ' + M.listOf(off.map(S.nameOf)) : M.plural(used.length, 'agent')}${differs.length ? html` · <span class="tc-warnline">Differs in ${M.listOf(differs.map(S.nameOf))}</span>` : ''}</span>` : M.listOf((row.providers || []).map(S.nameOf)) + (row.recognized ? ' · tap to share' : ' · unsupported format')}</span>${icon('chevron-right')}</button>`;
      })}</div>`; })}</div>`;
    const body = () => {
      const all = rows(), filtered = S.filter(data, { query, agent, attention: needsAttention, installed: installed() }), attention = S.attention(data, installed());
      return html`<div class="tc-sk-toolbar"><label class="tc-sk-search">${icon('search')}<input class="tc-input" id="mcp-search" data-key="mcp-search" value="${query}" type="search" placeholder="Search ${all.length} servers" aria-label="Search MCP servers"><kbd class="tc-kbd">/</kbd></label><div class="tc-sk-desktop-filters"><button class="tc-btn tc-btn--sm" type="button" data-cmd="mcp.agent" aria-haspopup="menu">Used by: <span class="tc-btn-value">${agent ? S.nameOf(agent) : 'Any agent'}</span>${icon('chevron-down', 'tc-chev')}</button>${attention.length ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="mcp.attention" aria-pressed="${String(needsAttention)}"><span class="tc-dot tc-dot--warn"></span>Needs attention ${attention.length}</button>` : ''}</div><span class="tc-spacer"></span><div class="tc-sk-desktop-actions"><button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="mcp.add"${disabled(data?.shared?.error || changing.size)}>${icon('plus')}Add server…</button></div></div>
      <div class="tc-sk-agent-chips" aria-label="Filter by agent"><button class="tc-chip-btn" type="button" data-cmd="mcp.filter" aria-pressed="${String(!agent)}">All <span>${all.length}</span></button>${managed().map(p => html`<button class="tc-chip-btn" type="button" data-cmd="mcp.filter" data-provider="${p.id}" aria-pressed="${String(agent === p.id)}">${mark(p.id)}${p.name}<span>${all.filter(row => S.has(data?.providers?.find(a => a.provider === p.id), row.name)).length}</span></button>`)}</div>
      ${error ? html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">Couldn’t read MCP servers</strong><span class="tc-notice-desc">${error}${data ? ' · Showing the last successful read.' : ''}</span></div><button class="tc-btn tc-btn--sm" type="button" data-cmd="mcp.refresh"${disabled(scanning)}>Try again</button></div>` : ''}
      ${data?.shared?.error ? html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">Shared servers unavailable</strong><span class="tc-notice-desc">${data.shared.error}${data.shared.path ? html` <code>${pathLabel(data.shared.path)}</code>` : ''}</span></div></div>` : ''}
      ${attention.length ? html`<button class="tc-sk-phone-notice tc-mcp-phone-attention" type="button" data-cmd="${attention[0].kind === 'differs' ? 'mcp.view' : 'mcp.refresh'}" data-id="${attention[0].name || ''}" data-provider="${attention[0].provider}"${disabled(scanning)}>${icon('triangle-alert')}<span><strong>${attention[0].kind === 'differs' ? attention[0].name + ' differs in ' + S.nameOf(attention[0].provider) : 'Couldn’t read ' + S.nameOf(attention[0].provider) + '’s settings'}</strong><span>${attention[0].kind === 'differs' ? 'Review it to update or keep that copy.' : 'Rescan to try again.'}${attention.length > 1 ? ' · ' + (attention.length - 1) + ' more need attention' : ''}</span></span>${scanning ? html`<span class="tc-spinner"></span>` : icon('chevron-right')}</button>` : ''}
      <div class="tc-sk-notices">${attention.slice(0, 3).map(item => html`<div class="tc-notice tc-notice--warn tc-mcp-attention" role="status">${icon('triangle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">${item.kind === 'differs' ? item.name + ' differs in ' + S.nameOf(item.provider) : 'Couldn’t read ' + S.nameOf(item.provider) + '’s settings'}</strong><span class="tc-notice-desc">${item.error || S.describeDiff(differences.get(item.provider + ':' + item.name))}</span></div>${item.kind === 'differs' ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="mcp.view" data-id="${item.name}" data-provider="${item.provider}">Review…</button>` : ''}</div>`)}${attention.length > 3 ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-cmd="mcp.attention">and ${attention.length - 3} more</button>` : ''}</div>
      ${!data && scanning ? html`<div class="tc-mcp-loading" role="status"><span class="tc-spinner"></span>Reading MCP servers…</div>` : data && all.length ? html`${!data.shared.servers.length ? html`<p class="tc-hint">Your agents already have ${M.plural(all.length, 'server')}. Share them to manage them here.</p>` : ''}${filtered.length ? html`${table(filtered)}${phone(filtered)}` : html`<div class="tc-empty tc-sk-empty"><strong class="tc-empty-title">No servers match</strong><span class="tc-empty-desc">Try another search or agent filter.</span><button class="tc-btn tc-btn--sm" type="button" data-cmd="mcp.filter">Clear filters</button></div>`}` : data && !data.shared.error ? html`<div class="tc-group tc-empty tc-sk-empty"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('plug')}</span><strong class="tc-empty-title">No MCP servers yet</strong><span class="tc-empty-desc">Add one, or paste a snippet from a server’s README.</span><button class="tc-btn tc-btn--primary" type="button" data-cmd="mcp.add">${icon('plus')}Add server…</button></div>` : ''}
      ${data && all.length && filtered.length ? html`<div class="tc-mcp-mobile-footer">${footer()}</div>` : footer()}
      <div class="tc-sk-phone-actions"><button class="tc-btn tc-btn--primary tc-btn--block" type="button" data-cmd="mcp.add"${disabled(data?.shared?.error || changing.size)}>${icon('plus')}Add server</button></div>`;
    };
    const cellMenu = (name, provider, trigger) => {
      const row = rows().find(row => row.name === name && row.shared), p = S.providers.find(p => p.id === provider), native = data?.providers?.find(p => p.provider === provider);
      if (!row || !p || changing.has(provider)) return;
      const state = S.state(data, row, provider), footer = html`Saved in <code>${pathLabel(native?.path)}</code>. Applies to new sessions.`;
      const remove = { label: 'Remove from ' + p.name, icon: 'trash-2', danger: true, run: () => change(provider, name, false) };
      let items = [remove];
      if (state.kind === 'differs') items = [
        { label: 'Update to the shared version', icon: 'refresh-cw', description: 'Replaces ' + p.name + '’s copy. A backup is kept.', run: () => change(provider, name, true) },
        { label: 'Show what differs', icon: 'columns-2', run: () => inspector.open(name, provider) },
        { label: 'Make this the shared version…', icon: 'share-2', run: () => share(name, provider, true) }, { sep: true }, remove,
      ];
      else if (p.canDisable) items = [
        { label: 'On', radio: true, checked: state.kind === 'on', description: p.name + ' starts it in new sessions.', run: () => state.kind !== 'on' && change(provider, name, true, { enabled: true }) },
        { label: 'Off', radio: true, checked: state.kind === 'off', description: 'Kept in ' + pathLabel(native?.path) + ' but not started.', run: () => state.kind !== 'off' && change(provider, name, true, { enabled: false }) }, { sep: true }, remove,
      ];
      Kit.menu(trigger, { label: p.name + ' · ' + name, head: { title: p.name + ' · ' + name },
        status: state.kind === 'differs' ? html`<div class="tc-menu-status">${icon('triangle-alert')}<span>${S.describeDiff(differences.get(provider + ':' + name))}</span></div>` : null, items, footer });
    };
    Kit.COMPACT.addEventListener('change', () => { paint(); editor.repaint(); });
    document.addEventListener('input', event => { if (event.target.id === 'mcp-search') { query = event.target.value; paint(); } });
    return {
      content: () => html`<div id="mcp-library" class="tc-skills-library tc-mcp-library" data-key="mcp-library" data-keep>${markup || body()}</div>`,
      phoneHead: () => html`<header class="tc-instructions-phone-head"><a class="tc-btn tc-btn--ghost" href="#more">${icon('chevron-right', 'tc-back-icon')}Setup</a><h1>MCP servers</h1>${document.documentElement.hasAttribute('data-embed') ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-cmd="embed.close" aria-label="Close setup">${icon('x')}</button>` : html`<a class="tc-btn tc-btn--ghost tc-btn--icon" href="#more" aria-label="Close MCP servers">${icon('x')}</a>`}</header>`,
      activate: (force = false) => {
        if (!started || force && !scanning && !changing.size) { void load(force); return; }
        for (const label of document.querySelectorAll('#mcp-library .tc-sk-scan-time')) label.textContent = data?.scannedAt ? 'Read ' + M.relTime(data.scannedAt, Date.now()) : '';
      },
      refresh: async () => { if (changing.size) return; const ok = await load(true); if (ok) Kit.announce('MCP servers scanned'); },
      add: async () => { if (changing.size) return; if (await prepare() && await inspector.close('add')) await editor.open({}); }, view: async (name, provider) => { if (await prepare() && await editor.close('inspect')) await inspector.open(name, provider); }, share,
      toggle: (provider, name) => change(provider, name, true), apply: (provider, name) => change(provider, name, true), cellMenu,
      beforeNavigate: async () => await editor.close('route') && await inspector.close('route'),
      focusSearch: () => document.getElementById('mcp-search')?.focus(),
      filterAgent: id => { agent = id; if (!id) { query = ''; needsAttention = false; } paint(); const field = document.getElementById('mcp-search'); if (field) field.value = query; },
      attention: () => { needsAttention = !needsAttention; paint(); }, group: id => { const key = id === 'true'; if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); paint(); },
      agentMenu: trigger => Kit.menu(trigger, { label: 'Used by', items: [{ label: 'Any agent', radio: true, checked: !agent, run: () => { agent = ''; paint(); } }, ...managed().map(p => ({ label: p.name, radio: true, checked: agent === p.id, run: () => { agent = p.id; paint(); } }))] }),
      columnsMenu: trigger => {
        const choose = value => {
          if (showAll === value) return;
          showAll = value; paint();
          const scroll = document.querySelector('.tc-mcp-table .tc-mx-scroll'); if (scroll) scroll.scrollLeft = 0;
          Kit.announce('Showing ' + (showAll ? 'all agents' : 'installed agents') + ' in the MCP table.');
        };
        Kit.menu(trigger, { label: 'Agent columns', items: [
          { label: 'Installed agents', description: M.plural(installed().length, 'agent') + ' installed on this server.', radio: true, checked: !showAll, run: () => choose(false) },
          { label: 'All agents', description: 'Also show ' + M.listOf(S.providers.filter(provider => !installed().includes(provider.id)).map(provider => provider.name)) + '.', radio: true, checked: showAll, run: () => choose(true) },
        ], footer: 'Grok Build imports only. Muse Code and Antigravity aren’t managed here yet.' });
      },
    };
  };
  return { create };
})();
