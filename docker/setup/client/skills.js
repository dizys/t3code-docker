// One on-demand library. Polls cannot morph its owned subtree or rescan files.
const T3SkillsUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const S = T3SkillModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const mark = id => html`<span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(id))}</span>`;
  const create = ({ api, getStatus, render, readMarkdown, downloadMarkdown }) => {
    const inventories = {}, errors = {}, epochs = {}, loading = new Set(), changing = new Map(), collapsed = new Map();
    let installed = [], reach = null, rows = [], started = false, scan = null, query = '', agent = '', showAll = false, view = 'all', markup = null, highlighted = new Set();
    const filterKey = 't3-console-hide-bundled-skills';
    let hideBundled = false, checking = false, checkingSources = 0, hookData = null, hookRead = null, hookResponse = null;
    try { hideBundled = localStorage.getItem(filterKey) === 'true'; showAll = localStorage.getItem('t3-console-skill-columns') === 'all'; } catch { /* this session only */ }
    const columns = () => S.providers.filter(provider => showAll || installed.includes(provider.id));
    const roots = () => S.rootsFor(inventories, reach);
    const library = () => ({ rows, inventories, errors, roots: roots(), installed, agents: columns().map(provider => provider.id), home: reach?.home || getStatus()?.paths?.volume,
      install: options => importer.open(options), reviewHooks: pluginId => hooks.open(pluginId), reviewUpdate: reviewSource,
      checkOne: key => checkUpdates([key]), checking: key => checking && (!checkKeys || checkKeys.has(key)), hooksReady: Boolean(hookData), hookSummary: S.hooksSummary(hookData?.hooks) });
    let checkKeys = null;
    // Native hook inventory is deliberately outside /status polling. A sheet shares
    // this read, including an in-flight first read; mutations return fresh revisions.
    const loadHooks = (force = false) => {
      if (hookRead) return hookRead;
      if (hookResponse && !force) return Promise.resolve(hookResponse);
      hookRead = api('/context/skills/hooks').then(response => {
        hookResponse = response; hookData = response.ok ? response.data : null; paint(); return response;
      }).finally(() => { hookRead = null; });
      return hookRead;
    };
    const hooks = T3SkillHooks.create({ api, getInventory: loadHooks, getLibrary: () => library(),
      onChange: data => { hookData = data; hookResponse = { ok: true, data }; paint(); },
      onClose: () => { if (installed.includes('codex')) void loadHooks(true); } });
    const updater = T3SkillUpdate.create({ api, getLibrary: library, downloadMarkdown, refresh: () => loadAll(true), home: () => library().home, showInLibrary: key => {
      highlighted = new Set([key]); query = agent = ''; view = 'all'; paint();
      const field = document.getElementById('skill-search'); if (field) field.value = '';
      requestAnimationFrame(() => [...document.querySelectorAll('.tc-mx-row[data-highlight], .tc-prow[data-highlight]')].find(element => element.getClientRects().length)?.scrollIntoView({ block: 'center', behavior: 'auto' }));
    } });
    const inspector = T3SkillInspector.create({ api, getLibrary: library, getStatus, availability: (...args) => availability(...args), refresh: () => loadAll(true), readMarkdown, downloadMarkdown });
    const importer = T3SkillImport.create({ api, getLibrary: library, refresh: () => loadAll(true), showInLibrary: names => {
      highlighted = new Set(names); query = ''; agent = ''; view = 'all'; paint();
      const field = document.getElementById('skill-search'); if (field) field.value = '';
      requestAnimationFrame(() => [...document.querySelectorAll('.tc-mx-row[data-highlight], .tc-prow[data-highlight]')]
        .find(element => element.getClientRects().length)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
    } });
    const rebuild = () => {
      const current = Object.fromEntries(columns().filter(provider => inventories[provider.id]).map(provider => [provider.id, inventories[provider.id]]));
      rows = S.join(current, reach);
    };
    const paint = () => {
      markup = body(); render();
      const mount = document.getElementById('skill-library'); if (mount) Kit.patch(mount, markup);
      inspector.repaint(); importer.repaint?.();
    };
    const loadProvider = async (id, refresh = false) => {
      if (changing.has(id)) return;
      const epoch = (epochs[id] || 0) + 1; epochs[id] = epoch;
      loading.add(id); delete errors[id]; paint();
      const response = await api('/context/skills?provider=' + encodeURIComponent(id) + (refresh ? '&refresh=1' : ''));
      if (epochs[id] !== epoch) return;
      loading.delete(id);
      if (response.ok) { inventories[id] = response.data; delete errors[id]; }
      else errors[id] = response.error;
      rebuild(); paint();
    };
    const loadAll = (refresh = false) => {
      if (scan) return scan;
      installed = S.providers.filter(provider => getStatus()?.harnesses?.some(row => row.id === provider.id && row.installed)).map(provider => provider.id);
      started = true;
      const ids = showAll ? S.providers.map(provider => provider.id) : installed;
      scan = Promise.allSettled([
        ...ids.map(id => loadProvider(id, refresh)),
        api('/context/skills/reach' + (refresh ? '?refresh=1' : '')).then(response => { if (response.ok) reach = response.data; rebuild(); paint(); }),
      ]).finally(() => { scan = null; paint(); if (installed.includes('codex') && !hookResponse) void loadHooks(); Kit.announce('Scanned ' + M.plural(rows.length, 'skill') + ' across ' + M.plural(installed.length, 'agent')); });
      return scan;
    };
    const availability = (skill, provider, full = false) => {
      const row = skill.byProvider[provider], state = S.state(row), busy = changing.has(provider), pending = changing.get(provider) === row?.id;
      const label = S.nameOf(provider) + ' ' + (provider === 'claude' ? 'visibility' : provider === 'opencode' ? 'permission' : 'availability') + ' for ' + skill.name + ': ' + state.label;
      const key = 'skill-cell-' + provider + '-' + (row?.id || encodeURIComponent(skill.key)) + (full ? '-inspector' : '-table');
      if (errors[provider]) return html`<span class="tc-cell tc-cell--none" title="${errors[provider]}" aria-label="${S.nameOf(provider)} unavailable: ${errors[provider]}">—</span>`;
      if (!row) return html`<button class="tc-cell tc-cell--none" type="button" data-cmd="skills.copy" data-id="${skill.key}" data-provider="${provider}" aria-label="Copy ${skill.name} to ${S.nameOf(provider)}"><span class="tc-cell-dash" aria-hidden="true">—</span><span class="tc-cell-add">${icon('plus')}Add</span></button>`;
      if (pending) return html`<span class="tc-cell" role="status"><span class="tc-spinner" aria-hidden="true"></span><span class="tc-sr">Saving ${label}</span></span>`;
      if (state.kind === 'policy') return full ? html`<select class="tc-select tc-select--sm" data-key="${key}" data-skill-policy="${row.id}" data-skill-provider="${provider}" aria-label="${label}"${disabled(busy)}>${row.stateOptions.map(option => html`<option value="${option.value}"${option.value === row.state ? raw(' selected') : ''}>${option.label}</option>`)}</select>`
        : html`<button class="tc-cell" data-tone="${state.muted ? 'muted' : ''}" data-key="${key}" type="button" data-cmd="skills.policy" data-provider="${provider}" data-id="${row.id}" aria-label="${label}" aria-haspopup="menu"${disabled(busy)}>${state.label}${icon('chevron-down')}</button>`;
      if (state.kind === 'switch') return html`<span class="tc-cell tc-cell--switch"><button class="tc-switch tc-switch--sm" role="switch" type="button" data-key="${key}" aria-checked="${String(row.state === 'enabled')}" aria-label="${label}" data-cmd="skills.state" data-id="${row.id}" data-provider="${provider}"${disabled(busy)}></button><span class="tc-small tc-muted">${state.label}</span></span>`;
      if (state.kind === 'error') return html`<span class="tc-cell tc-warning" title="${state.reason}">${state.label}</span>`;
      if (state.kind === 'locked') return html`<span class="tc-cell tc-cell--locked" title="${state.reason || 'Managed through its source'}">${state.label}${icon('lock')}</span>`;
      const reason = 'In a folder ' + S.nameOf(provider) + ' reads. ' + S.nameOf(provider) + ' doesn’t report which skills it loads.';
      return html`<span class="tc-cell tc-cell--found" tabindex="0" title="${reason}" aria-describedby="${key}-explanation"><span>Found</span></span><span class="tc-sr" id="${key}-explanation">${reason}</span>`;
    };
    const setState = async (id, provider, value) => {
      const row = inventories[provider]?.skills.find(row => row.id === id);
      if (!row || changing.has(provider) || !row.canSetState && !row.canToggle) return;
      if (row.canSetState && (!row.stateOptions.some(option => option.value === value) || value === row.state)) return;
      const focusedKey = document.activeElement?.getAttribute('data-key');
      changing.set(provider, id); epochs[provider] = (epochs[provider] || 0) + 1; loading.delete(provider); paint();
      const enabled = row.canToggle ? row.state !== 'enabled' : undefined;
      const response = await api('/context/skills/state', { body: { provider, id, stateRevision: row.stateRevision, enabled, state: value } });
      changing.delete(provider);
      if (response.ok) { inventories[provider] = response.data.inventory; delete errors[provider]; rebuild(); paint(); Kit.toast('Saved ' + S.nameOf(provider) + ' setting'); Kit.announce('Saved ' + S.nameOf(provider) + '’s skill setting'); }
      else { Kit.toast('Couldn’t change ' + S.nameOf(provider) + '’s setting for ' + row.name, { tone: 'danger', detail: response.error }); await loadProvider(provider, true); }
      if (focusedKey && (document.activeElement === document.body || document.activeElement?.classList.contains('tc-skill-inspector'))) document.querySelector('[data-key="' + CSS.escape(focusedKey) + '"]')?.focus({ preventScroll: true });
    };
    const policyMenu = (id, provider, trigger) => {
      const row = inventories[provider]?.skills.find(row => row.id === id);
      if (!row?.canSetState || changing.has(provider)) return;
      const explanations = { on: 'Claude sees its name and description. You can run /' + row.name + '.', 'name-only': 'Claude sees its name without the description, which saves context.', 'user-invocable-only': 'Hidden from Claude. You can still run /' + row.name + '.', off: 'Hidden from Claude and from the / menu.', allow: 'The agent can use this skill.', ask: 'The agent asks before using this skill.', deny: 'The agent cannot use this skill.' };
      Kit.menu(trigger, { label: S.nameOf(provider) + ' skill setting', head: { title: S.nameOf(provider) + ' · ' + (provider === 'claude' ? 'visibility' : 'permission') },
        items: row.stateOptions.map(option => ({ label: option.label, description: explanations[option.value], radio: true, checked: option.value === row.state, run: () => setState(id, provider, option.value) })),
        footer: html`${row.statePath ? html`Saved in <code>${S.displayPath(row.statePath, library().home)}</code>. ` : ''}Applies to new sessions.${provider === 'opencode' && row.effectiveStateText ? html`<br>${row.effectiveStateText}` : ''}` });
    };
    const checkUpdates = async (keys = null) => {
      if (checking || scan || loading.size) return;
      const tracked = rows.filter(row => row.origin && !errors[row.provider] && (!keys || keys.includes(row.key))).map(row => ({ key: row.key, provider: row.provider, id: row.byProvider[row.provider].id, origin: row.origin,
        epoch: epochs[row.provider], inventory: inventories[row.provider] }));
      if (!tracked.length) return;
      checking = true; checkKeys = keys ? new Set(keys) : null; checkingSources = new Set(tracked.map(skill => skill.origin.source)).size; paint();
      try {
        for (const source of new Set(tracked.map(skill => skill.origin.source))) {
          const batch = tracked.filter(skill => skill.origin.source === source && epochs[skill.provider] === skill.epoch && inventories[skill.provider] === skill.inventory);
          if (!batch.length) continue;
          const response = await api('/context/skills/check-update', { body: { skills: batch.map(({ provider, id }) => ({ provider, id })) } });
          for (const skill of batch) {
            if (epochs[skill.provider] !== skill.epoch || inventories[skill.provider] !== skill.inventory) continue;
            const result = response.ok ? response.data.results?.find(row => row.provider === skill.provider && row.id === skill.id) : response;
            const update = result?.ok ? result.update : { ...skill.origin, checkedAt: Date.now(), status: 'error', error: result?.error || 'Could not check this installation. Refresh and try again.' };
            for (const data of Object.values(inventories)) for (const row of data.skills || []) {
              if ((row.resolvedPath || row.path) === skill.key && row.origin?.fingerprint === skill.origin.fingerprint && row.origin.source === skill.origin.source) row.update = update;
            }
            rebuild(); paint();
          }
        }
      } finally { checking = false; checkKeys = null; paint(); }
    };
    const updateBadge = (skill, phone = false) => skill.update?.status === 'available' ? html`<button class="tc-upd" type="button" data-key="update-${skill.key}" data-cmd="skills.update" data-id="${skill.key}" aria-label="Review the update for ${skill.name}" title="From ${skill.origin.source}. Review the changes before updating.">${icon('arrow-up')}Update available</button>`
      : skill.update?.status === 'error' ? html`<span class="tc-tagline tc-tagline--src" data-tone="warn" title="${skill.update.error}">${icon('triangle-alert')}${phone ? 'Check failed' : html`<code>${skill.origin.source}</code>`}<span class="tc-sr">Update check failed: ${skill.update.error}</span></span>` : '';
    function reviewSource(skill, queue) { if (skill?.origin) updater.open(skill.provider, skill.byProvider[skill.provider].id, { queue }); }
    const skillBadges = skill => html`${updateBadge(skill)}${skill.packageManaged ? html`<span class="tc-tagline">${icon('lock')}Package${skill.packageSource ? html` <code>${skill.packageSource}</code>` : ''}</span>` : !Object.values(skill.byProvider).some(row => row.canEdit) ? html`<span class="tc-tagline">${icon('lock')}Read-only</span>` : ''}${skill.metadataError ? html`<span class="tc-badge tc-badge--warn" title="${skill.metadataError}">Check metadata</span>` : ''}`;
    const readersLabel = root => {
      const readers = (root.readers || []).filter(id => installed.includes(id));
      const others = readers.filter(id => id !== root.owner);
      return root.owner && others.length ? 'Also read by ' + M.listOf(others.map(S.nameOf)) : 'Read by ' + M.listOf(readers.map(S.nameOf));
    };
    const actions = () => html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.add">${icon('plus')}New skill</button><button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="skills.import">${icon('download')}Install from source…</button>`;
    const agentMenu = trigger => Kit.menu(trigger, { label: 'Available to', items: [{ label: 'Any agent', radio: true, checked: !agent, run: () => { agent = ''; paint(); } }, ...columns().map(provider => ({ label: provider.name, radio: true, checked: agent === provider.id, run: () => { agent = provider.id; paint(); } }))] });
    const groupClosed = group => collapsed.has(group.key) ? collapsed.get(group.key) : !query && view !== 'attention' && ['system', 'admin'].includes(group.root.scope);
    const attentionNotice = skill => {
      const problem = Object.values(skill.byProvider).find(row => row.error || row.metadataError);
      return html`<div class="tc-notice tc-notice--warn tc-sk-skill-notice" role="status">${icon('triangle-alert')}<div class="tc-notice-body"><span class="tc-notice-title">${skill.name} may not load</span><span class="tc-notice-desc">${problem?.error || problem?.metadataError}</span></div>${Object.values(skill.byProvider).some(row => row.canEdit) ? html`<div class="tc-notice-actions"><button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.edit" data-id="${skill.key}">Fix in SKILL.md</button></div>` : ''}</div>`;
    };
    const pluginOf = group => group.rows.find(row => row.byProvider.codex?.pluginId)?.byProvider.codex.pluginId;
    const groupName = group => pluginOf(group) ? 'Codex plugin · ' + S.pluginName(pluginOf(group)) : group.label;
    const hookChip = group => {
      const plugin = S.hooksSummary(hookData?.hooks).plugins.find(plugin => plugin.id === pluginOf(group));
      if (!plugin?.hooks.length) return '';
      return html`<button class="${plugin.waiting.length ? 'tc-hookchip' : 'tc-btn tc-btn--ghost tc-btn--xs'}" type="button" data-cmd="skills.hooks" data-id="${plugin.id}" aria-label="Review ${S.pluginName(plugin.id)} plugin hooks">${icon(plugin.waiting.length ? 'shield-alert' : 'shield-check')}${plugin.waiting.length ? M.plural(plugin.waiting.length, 'hook') + ' to review' : M.plural(plugin.hooks.length, 'hook')}</button>`;
    };
    const table = filtered => html`<div class="tc-mx-scroll tc-sk-matrix" tabindex="0" aria-label="Skills by agent"><div class="tc-mx" role="table" aria-label="Skills and agent settings" style="--mx-agent-count:${columns().length};${!showAll && installed.length < S.providers.length && columns().length ? '--mx-cols:minmax(var(--mx-name-width), 1fr) ' + Array(Math.max(0, columns().length - 1)).fill('var(--mx-agent-width)').join(' ') + ' calc(var(--mx-agent-width) + 2.375rem);--mx-more-space:2.375rem' : ''}">
      <div class="tc-mx-head" role="row"><div class="tc-mx-head-label" role="columnheader">Skill</div>${columns().map((provider, index) => html`<div class="tc-mx-agent" role="columnheader"${!installed.includes(provider.id) ? raw(' data-uninstalled title="Adding, editing and importing skills still work."') : ''}><span class="tc-mx-agent-name">${mark(provider.id)}${provider.name}${errors[provider.id] ? html`<span class="tc-dot tc-dot--warn" title="${errors[provider.id]}" aria-label="Couldn’t read ${provider.name} skills"></span>` : ''}</span><span class="tc-mx-agent-kind">${loading.has(provider.id) ? 'Reading…' : installed.includes(provider.id) ? provider.control : 'Not detected'}</span>${!showAll && installed.length < S.providers.length && index === columns().length - 1 ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs tc-mx-more" type="button" data-cmd="skills.all-agents" aria-label="Show ${M.listOf(S.providers.filter(provider => !installed.includes(provider.id)).map(provider => provider.name))}, which aren’t detected here">+${S.providers.length - installed.length}</button>` : ''}</div>`)}</div>
      ${S.groups(filtered).map(group => html`<div role="rowgroup" data-key="skill-group-${group.key}"><div role="row"><div class="tc-mx-group" role="cell" aria-colspan="${columns().length + 1}"><button class="tc-mx-group-toggle" type="button" data-cmd="skills.group" data-id="${group.key}" aria-expanded="${String(!groupClosed(group))}">${icon(groupClosed(group) ? 'chevron-right' : 'chevron-down')}${groupName(group)}</button><code title="${group.root.path}">${S.displayPath(group.root.path, library().home)}</code><span>·</span><span>${group.rows.length}</span><span>·</span><span class="tc-mx-readers" title="${(group.root.readers || []).map(S.nameOf).join(', ')}">${readersLabel(group.root)}</span><span class="tc-spacer"></span>${hookChip(group)}${groupClosed(group) ? html`<span class="tc-mx-collapsed-names" title="${group.rows.map(row => row.name).join(', ')}">${group.rows.map(row => row.name).join(', ')}</span>` : !pluginOf(group) && installed.some(id => !(group.root.readers || []).includes(id)) ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="skills.copy-group" data-id="${group.key}">Copy to ${M.listOf(installed.filter(id => !(group.root.readers || []).includes(id)).map(S.nameOf))}…</button>` : ''}</div></div>
        ${groupClosed(group) ? '' : group.rows.map(skill => html`<div class="tc-mx-row" role="row" data-key="skill-${skill.key}"${(highlighted.has(skill.name) || highlighted.has(skill.key)) ? raw(' data-highlight') : ''}><div class="tc-mx-skill" role="cell"><div class="tc-mx-skill-copy"><div class="tc-mx-name"><button class="tc-skill-name" type="button" data-key="skill-name-${skill.key}" data-cmd="skills.view" data-id="${skill.key}">${skill.name}</button>${skillBadges(skill)}</div><p class="tc-mx-desc" title="${skill.description}">${skill.description}</p></div><div class="tc-mx-actions"><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-key="skill-menu-${skill.key}" data-cmd="skills.menu" data-id="${skill.key}" aria-label="Actions for ${skill.name}">${icon('ellipsis')}</button></div></div>${columns().map(provider => html`<div class="tc-cellwrap" role="cell" data-key="cell-${provider.id}">${availability(skill, provider.id)}</div>`)}</div>`)}</div>`)}
    </div></div>`;
    const phoneList = filtered => html`<div class="tc-sk-phone-list">${S.groups(filtered).map(group => html`<div class="tc-plist" data-key="phone-group-${group.key}"><div class="tc-plist-group"><button class="tc-mx-group-toggle" type="button" data-cmd="skills.group" data-id="${group.key}" aria-expanded="${String(!groupClosed(group))}">${groupName(group)}</button><span>· ${group.rows.length}</span><span class="tc-spacer"></span>${hookChip(group) || html`<span>Read by ${M.plural((group.root.readers || []).filter(id => installed.includes(id)).length, 'agent')}</span>`}</div>${groupClosed(group) ? '' : group.rows.map(skill => {
      const readers = installed.filter(id => !errors[id] && S.available(skill.byProvider[id]));
      const exceptions = installed.filter(id => skill.byProvider[id] && ['off', 'deny', 'disabled', 'ask', 'name-only', 'user-invocable-only'].includes(skill.byProvider[id].state)).map(id => S.state(skill.byProvider[id]).label + ' in ' + S.nameOf(id));
      return html`<div class="tc-prow tc-sk-phone-row" data-key="phone-skill-${skill.key}" data-cmd="skills.view" data-id="${skill.key}"${(highlighted.has(skill.name) || highlighted.has(skill.key)) ? raw(' data-highlight') : ''}><span class="tc-prow-name-line"><button class="tc-skill-name tc-prow-name" type="button" data-key="phone-skill-open-${skill.key}" data-cmd="skills.view" data-id="${skill.key}">${skill.name}</button>${updateBadge(skill, true)}</span><span class="tc-prow-desc">${skill.description}</span><span class="tc-prow-agents"><span class="tc-agent-stack" aria-hidden="true">${readers.map(mark)}</span><span>${M.plural(readers.length, 'agent')}${exceptions.length ? ' · ' + exceptions.join(', ') : ''}</span></span>${icon('chevron-right')}</div>`;
    })}</div>`)}</div>`;
    const inventoryNotices = () => {
      const failed = new Map();
      for (const id of installed) if (errors[id]) failed.set(errors[id], [...(failed.get(errors[id]) || []), id]);
      const notice = (title, description, tone = 'warn') => html`<div class="tc-notice tc-notice--${tone} tc-sk-provider-notice" role="status">${icon(tone === 'warn' ? 'triangle-alert' : 'info')}<div class="tc-notice-body"><span class="tc-notice-title">${title}</span><span class="tc-notice-desc">${description}</span></div></div>`;
      return html`${[...failed].map(([error, ids]) => notice(ids.length === 1 ? S.nameOf(ids[0]) + ' skills are unavailable' : ids.length + ' agents’ skills are unavailable',
        html`${ids.length > 1 ? html`${M.listOf(ids.map(S.nameOf))}<br>` : ''}${error}`))}
        ${columns().flatMap(provider => [
          ...[...(inventories[provider.id]?.nativeError ? [inventories[provider.id].nativeError] : []), ...(inventories[provider.id]?.warnings || [])].map(warning => notice(provider.name + ' skills need a look', warning)),
        ])}`;
    };
    const show = value => { view = value; if (value === 'all' && Kit.isPhone()) agent = ''; paint(); };
    const visibleRows = () => hideBundled ? rows.filter(row => row.scope !== 'system') : rows;
    const filteredRows = () => S.filter(agent && errors[agent] ? [] : visibleRows(), { query, agent, needsAttention: view === 'attention' });
    const hookNotice = () => {
      const summary = S.hooksSummary(hookData?.hooks), waiting = summary.waiting;
      if (!waiting.length) return '';
      const plugins = summary.plugins.filter(plugin => plugin.waiting.length);
      const events = [...new Set(waiting.map(hook => S.hookLabel(hook.eventName)))].map((text, index) => index ? text.toLowerCase() : text.replace(/^When /, '').toLowerCase());
      return html`<div class="tc-notice tc-notice--info tc-sk-hook-notice">${icon('shield-alert')}<div class="tc-notice-body"><span class="tc-notice-title">${waiting.length === 1 ? 'A Codex plugin hook is waiting for review' : waiting.length + ' Codex plugin hooks are waiting for review'}</span><span class="tc-notice-desc">${plugins.length === 1 ? plugins[0].name + ' runs commands when ' + M.listOf(events) : M.listOf(plugins.map(plugin => plugin.name)) + ' added commands that run automatically'}. Codex won’t run them until you trust them.</span></div><div class="tc-notice-actions"><button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.hooks">Review hooks</button></div></div>`;
    };
    const listHeader = (visible, problems) => {
      const summary = S.updateSummary(visible), inUpdates = view === 'updates';
      return html`<div class="tc-lh"><div class="tc-lh-filters" role="group" aria-label="Show"><button class="tc-lh-filter" type="button" data-key="skills-all" data-cmd="skills.show" data-id="all" aria-pressed="${String(view === 'all')}">All <span class="tc-tab-count">${visible.length}</span></button>${problems.length ? html`<button class="tc-lh-filter" type="button" data-cmd="skills.show" data-id="attention" aria-pressed="${String(view === 'attention')}"><span class="tc-dot tc-dot--warn"></span>Needs attention <span class="tc-tab-count">${problems.length}</span></button>` : ''}${summary.tracked.length ? html`<button class="tc-lh-filter" type="button" data-key="skills-updates" data-cmd="skills.show" data-id="updates" data-tone="accent" aria-pressed="${String(inUpdates)}">${summary.available.length ? html`<span class="tc-dot"></span>` : ''}Updates${summary.checkedAt ? html`<span class="tc-tab-count">${summary.available.length}</span>` : ''}</button>` : ''}</div><span class="tc-spacer"></span>
        ${summary.tracked.length ? html`<span class="tc-lh-status" role="status"${summary.checkedAt ? html` title="${M.absTime(summary.checkedAt)}. Results last until the setup service restarts."` : ''}>${checking ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking ${M.plural(checkingSources, 'repository', 'repositories')}…` : summary.checkedAt ? html`${icon('clock', 'tc-icon--sm')}Checked ${M.relTime(summary.checkedAt, Date.now())}` : M.plural(summary.tracked.length, 'skill') + ' came from a repository'}</span>${summary.checkedAt || !inUpdates ? html`<button class="tc-btn ${summary.checkedAt ? 'tc-btn--ghost ' : ''}tc-btn--xs" type="button" data-cmd="skills.check-updates"${disabled(checking || Boolean(scan) || loading.size > 0)}>${summary.checkedAt ? 'Check again' : 'Check for updates'}</button>` : ''}${inUpdates && summary.available.length ? html`<button class="tc-btn tc-btn--primary tc-btn--xs" type="button" data-cmd="skills.review-updates"${disabled(checking)}>Review ${M.plural(summary.available.length, 'update')}</button>` : ''}` : ''}
        ${!inUpdates ? html`<span class="tc-lh-sep"></span><div class="tc-lh-view"><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-key="skills-view-menu" data-cmd="skills.view-menu" aria-haspopup="menu">${icon('sliders-horizontal', 'tc-icon--sm')}View</button></div>` : ''}</div>`;
    };
    const updatesTable = filtered => {
      const tracked = filtered.filter(row => row.origin).sort(S.updateOrder), summary = S.updateSummary(rows);
      return html`<div class="tc-ut" role="table" aria-label="Skill updates">${!summary.checkedAt ? html`<div class="tc-empty tc-ut-empty"><span class="tc-empty-icon">${icon('git-branch')}</span><span class="tc-empty-title">Check ${M.plural(summary.tracked.length, 'skill')} for updates</span><span class="tc-empty-desc">These skills remember the repository they were installed from. Checking downloads each repository once and compares the files. Nothing changes until you review an update.</span><button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="skills.check-updates"${disabled(checking || Boolean(scan) || loading.size > 0)}>${checking ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking…` : html`${icon('refresh-cw')}Check for updates`}</button></div>` : !tracked.length ? html`<div class="tc-empty tc-ut-empty"><span class="tc-empty-title">No tracked skills match these filters</span><span class="tc-empty-desc">Try another search or clear the library filters.</span><button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.clear">Clear filters</button></div>` : html`<div class="tc-ut-head" role="row">${['Skill', 'Repository', 'Status', 'Read by', 'Actions'].map(label => html`<span role="columnheader"${label === 'Actions' ? raw(' class="tc-sr"') : ''}>${label}</span>`)}</div>${tracked.map(skill => {
        const update = skill.update, state = update?.status, readers = installed.filter(id => skill.byProvider[id]), checkingOne = checking && (!checkKeys || checkKeys.has(skill.key));
        return html`<div class="tc-ut-row" role="row" data-key="update-row-${skill.key}" data-tone="${state === 'error' ? 'warn' : ''}"><div class="tc-ut-skill" role="cell"><button class="tc-skill-name" type="button" data-cmd="skills.view" data-id="${skill.key}">${skill.name}</button><code title="${S.directory(skill.path)}">${S.displayPath(S.directory(skill.path), library().home)}</code></div><div class="tc-ut-src" role="cell"><code title="${skill.origin.source}">${skill.origin.source}</code>${update ? html`<small>${icon('git-branch', 'tc-icon--sm')}${update.ref || 'default branch'}</small>` : ''}</div><div class="tc-ut-status" role="cell" data-tone="${state === 'available' ? 'accent' : state === 'error' ? 'warn' : 'idle'}"><strong>${checkingOne ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking…` : state === 'available' ? html`<span class="tc-dot"></span>Update available` : state === 'error' ? html`${icon('triangle-alert')}Couldn’t check` : state === 'current' ? html`${icon('check')}Up to date` : 'Not checked yet'}</strong>${update?.checkedAt ? html`<small title="${M.absTime(update.checkedAt)}">${state === 'error' ? 'Tried' : 'Checked'} ${M.relTime(update.checkedAt, Date.now())}</small>` : ''}</div><div class="tc-ut-readers" role="cell" title="${M.listOf(readers.map(S.nameOf))}"><span class="tc-agent-stack" aria-hidden="true">${readers.map(mark)}</span>${readers.length}</div><div class="tc-ut-act" role="cell"><button class="tc-btn ${state === 'available' ? '' : 'tc-btn--ghost '}tc-btn--sm" type="button" data-cmd="${state === 'error' ? 'skills.check-one' : 'skills.update'}" data-id="${skill.key}" aria-label="${state === 'error' ? 'Retry update check for ' : state === 'available' ? 'Review the update for ' : 'Review source for '}${skill.name}"${disabled(checkingOne)}>${state === 'error' ? icon('refresh-cw') : ''}${state === 'available' ? 'Review update…' : state === 'error' ? 'Retry' : 'Review source'}</button></div>${state === 'error' ? html`<div class="tc-ut-err" role="cell" aria-colspan="5">${icon('triangle-alert')}<span>${update.error} Check the repository address and access, then retry.</span></div>` : ''}</div>`;
      })}`}</div><div class="tc-ut-note">${icon('info')}<span>Only skills installed from a repository can be checked. Copies and skills you wrote here aren’t tracked: reinstall one from its repository to track it. Local edits never count as an update.</span></div>`;
    };
    const phoneSummary = (visible, problems) => {
      const summary = S.updateSummary(visible), hooks = S.hooksSummary(hookData?.hooks), waiting = hooks.waiting.length;
      return html`<div class="tc-plist tc-pnotes tc-sk-phone-summary">${summary.available.length ? html`<button class="tc-pnote" type="button" data-icon="accent" data-cmd="skills.show" data-id="updates">${icon('arrow-up')}<span><strong>${M.plural(summary.available.length, 'skill update')}</strong><small>${M.listOf(summary.available.map(row => row.name))}</small></span>${icon('chevron-right')}</button>` : ''}${waiting ? html`<button class="tc-pnote" type="button" data-icon="warn" data-cmd="skills.hooks">${icon('shield-alert')}<span><strong>${M.plural(waiting, 'plugin hook')} to review</strong><small>${M.listOf(hooks.plugins.filter(plugin => plugin.waiting.length).map(plugin => plugin.name))} won’t run them until you do</small></span>${icon('chevron-right')}</button>` : ''}${problems.length ? html`<button class="tc-pnote" type="button" data-icon="warn" data-cmd="${problems.length === 1 ? 'skills.view' : 'skills.show'}" data-id="${problems.length === 1 ? problems[0].key : 'attention'}">${icon('triangle-alert')}<span><strong>${problems.length === 1 ? problems[0].name + ' may not load' : problems.length + ' skills need attention'}</strong><small>${problems.length === 1 ? Object.values(problems[0].byProvider).find(row => row.metadataError || row.error)?.metadataError || 'Open the skill to review the problem.' : 'Review skills that may not load.'}</small></span>${icon('chevron-right')}</button>` : ''}</div>`;
    };
    const body = () => {
      const visible = visibleRows(), bundled = rows.filter(row => row.scope === 'system'), filtered = filteredRows(), problems = visible.filter(row => row.attention);
      const failed = installed.some(id => errors[id]), scanning = Boolean(scan) || loading.size > 0;
      const scannedAt = Math.min(...Object.values(inventories).map(inventory => inventory.scannedAt || Date.now()));
      return html`<div class="tc-sk-toolbar"><label class="tc-sk-search">${icon('search')}<input class="tc-input" type="search" id="skill-search" data-key="skill-search" value="${query}" placeholder="Search ${rows.length || ''} skills" aria-label="Search skills"><kbd class="tc-kbd">/</kbd></label><button class="tc-btn tc-btn--ghost tc-btn--icon tc-sk-phone-view" type="button" data-key="skills-phone-view" data-cmd="skills.view-menu" aria-haspopup="menu" aria-label="View options">${icon('sliders-horizontal')}</button><div class="tc-sk-desktop-filters"><button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.filter" aria-haspopup="menu">Available to <span class="tc-btn-value">${agent ? S.nameOf(agent) : 'Any agent'}</span>${icon('chevron-down', 'tc-chev')}</button></div><span class="tc-spacer"></span><div class="tc-sk-desktop-actions">${actions()}</div></div>
        <div class="tc-chipbar tc-sk-agent-chips" aria-label="Filter skills"><button class="tc-chip-btn" type="button" data-cmd="skills.show" data-id="all" aria-pressed="${String(view === 'all' && !agent)}">All <span class="tc-tab-count">${visible.length}</span></button>${visible.some(row => row.origin) ? html`<button class="tc-chip-btn" type="button" data-cmd="skills.show" data-id="updates" aria-pressed="${String(view === 'updates')}">${S.updateSummary(visible).available.length ? html`<span class="tc-dot" data-accent></span>` : ''}Updates${S.updateSummary(visible).checkedAt ? html`<span class="tc-tab-count">${S.updateSummary(visible).available.length}</span>` : ''}</button>` : ''}${problems.length ? html`<button class="tc-chip-btn" type="button" data-cmd="skills.show" data-id="attention" aria-pressed="${String(view === 'attention')}"><span class="tc-dot tc-dot--warn"></span>Needs attention <span class="tc-tab-count">${problems.length}</span></button>` : ''}${columns().map(provider => html`<button class="tc-chip-btn" type="button" data-cmd="skills.agent" data-provider="${provider.id}" aria-pressed="${String(agent === provider.id)}">${mark(provider.id)}${provider.name}<span class="tc-tab-count">${visible.filter(row => !errors[provider.id] && S.available(row.byProvider[provider.id])).length}</span></button>`)}</div>
        ${phoneSummary(visible, problems)}<div class="tc-sk-notices">${problems.slice(0, 3).map(attentionNotice)}${problems.length > 3 ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-cmd="skills.show" data-id="attention">and ${problems.length - 3} more</button>` : ''}${inventoryNotices()}${hookNotice()}</div>
        <div class="tc-group tc-sk-card" data-view="${view}"${checking ? raw(' data-checking') : ''}>${listHeader(visible, problems)}${view === 'updates' ? updatesTable(filtered) : !rows.length && scanning ? html`<div class="tc-sk-skeleton" role="status" aria-label="Reading skill inventories">${[1, 2, 3, 4].map(i => html`<div class="tc-row"><span class="tc-skeleton"></span><span class="tc-hint">${i === 1 ? 'Reading skills across your agents…' : ''}</span></div>`)}</div>` : !filtered.length ? html`<div class="tc-empty tc-sk-empty"><span class="tc-empty-media"><span class="tc-empty-icon">${icon('sparkles')}</span></span><span class="tc-empty-title">${rows.length ? 'No skills match these filters' : failed ? 'Skills couldn’t be read' : 'No skills yet'}</span><span class="tc-empty-desc">${rows.length ? 'Try another search or clear the library filters.' : failed ? 'Some agent inventories are unavailable. Retry the scan to check for skills.' : 'Add one, or install some from a source.'}</span><div class="tc-sk-empty-actions">${rows.length ? html`<button class="tc-btn" type="button" data-cmd="skills.clear">Clear filters</button>` : failed ? html`<button class="tc-btn" type="button" data-cmd="skills.refresh">Retry scan</button>` : actions()}</div></div>` : html`${table(filtered)}${phoneList(filtered)}`}
        ${view !== 'updates' && hideBundled && bundled.length ? html`<div class="tc-mx-hidden">${icon('eye-off')}<span>${M.plural(bundled.length, 'bundled skill')} ${bundled.length === 1 ? 'is' : 'are'} hidden</span><span class="tc-mono" title="${bundled.map(row => row.name).join(', ')}">${bundled.map(row => row.name).join(', ')}</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="skills.bundled">Show</button></div>` : ''}
        <div class="tc-sk-library-foot"><span>${icon('info', 'tc-icon--sm')}Changes apply to new sessions. A project’s own settings can still turn a skill off.</span>${installed.includes('codex') ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-cmd="skills.hooks">${icon('shield-check')}Codex plugin hooks…</button>` : ''}<span class="tc-sk-scan-time" title="${Number.isFinite(scannedAt) ? M.absTime(scannedAt) : ''}">${scanning ? 'Scanning…' : Number.isFinite(scannedAt) ? 'Scanned ' + M.relTime(scannedAt, Date.now()) : ''}</span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="skills.refresh"${disabled(scanning)}>${icon('refresh-cw')}${scanning ? 'Scanning' : 'Rescan'}</button></div></div>
        <div class="tc-sk-phone-actions">${actions()}</div>`;
    };
    const chooseColumns = value => {
      if (showAll === value) return;
      showAll = value;
      try { localStorage.setItem('t3-console-skill-columns', value ? 'all' : 'installed'); } catch { /* this session only */ }
      rebuild(); paint();
      const scroll = document.querySelector('.tc-sk-matrix'); if (scroll) scroll.scrollLeft = 0;
      if (showAll) for (const provider of S.providers) if (!inventories[provider.id] && !loading.has(provider.id)) void loadProvider(provider.id);
    };
    const toggleBundled = () => { hideBundled = !hideBundled; try { localStorage.setItem(filterKey, String(hideBundled)); } catch { /* this session only */ } paint(); };
    const viewMenu = trigger => Kit.menu(trigger, { label: 'Skill view options', head: { title: 'Agent columns' }, items: [
      { label: 'Installed agents', description: 'The ' + M.plural(installed.length, 'agent') + ' on this server.', radio: true, checked: !showAll, run: () => chooseColumns(false) },
      { label: 'All agents', description: installed.length < S.providers.length ? 'Also ' + M.listOf(S.providers.filter(provider => !installed.includes(provider.id)).map(provider => provider.name)) + '. They aren’t detected here, but you can still add skills for them.' : 'Every supported agent is installed here.', radio: true, checked: showAll, run: () => chooseColumns(true) },
      ...(rows.some(row => row.scope === 'system') ? [{ sep: true }, { label: 'Show bundled skills', description: M.plural(rows.filter(row => row.scope === 'system').length, 'skill') + ' that ship with Codex. Codex manages them, so they can’t be edited here.', checkbox: true, checked: !hideBundled, run: toggleBundled }] : []),
    ], footer: 'Remembered in this browser.' });
    const menu = (key, trigger) => {
      const skill = rows.find(row => row.key === key); if (!skill) return;
      Kit.menu(trigger, { label: skill.name + ' actions', items: [
        { label: 'View', icon: 'file-text', run: () => inspector.open(key) },
        ...(skill.canEdit ? [{ label: 'Edit SKILL.md', icon: 'pencil', run: () => inspector.open(key, true) }] : []),
        ...(skill.origin ? [{ label: skill.update?.status === 'available' ? 'Review update…' : 'Review source…', icon: 'download', run: () => reviewSource(skill) }, { label: 'Check for updates', icon: 'refresh-cw', disabled: checking, run: () => checkUpdates([key]) }] : []),
        { label: 'Copy path', icon: 'copy', run: () => Kit.copy(skill.path, trigger, 'Skill path copied') },
        { label: 'Copy to…', icon: 'copy', run: () => importer.open({ source: S.directory(skill.path), names: [skill.name], step: 2 }) },
        ...(skill.canRemove ? [{ sep: true }, { label: 'Remove…', icon: 'trash-2', danger: true, run: () => inspector.open(key, false).then(() => document.querySelector('[data-inspect-remove]')?.click()) }] : []),
      ] });
    };
    return {
      content: () => html`<div class="tc-skills-library" id="skill-library" data-key="skill-library" data-keep>${markup || (markup = body())}</div>`, actions,
      activate: navigation => { if (!started || navigation && installed.join() !== S.providers.filter(provider => getStatus()?.harnesses?.some(row => row.id === provider.id && row.installed)).map(provider => provider.id).join()) return loadAll(); },
      checkUpdates, toggleBundled, show, viewMenu, allAgents: () => chooseColumns(true),
      update: key => reviewSource(rows.find(row => row.key === key)), checkOne: key => checkUpdates([key]),
      reviewUpdates: () => { const queue = filteredRows().filter(row => row.origin && row.update?.status === 'available').sort(S.updateOrder); if (queue.length) reviewSource(queue[0], queue.map(row => row.key)); },
      count: () => rows.length, refresh: () => { if (installed.includes('codex')) void loadHooks(true); return loadAll(true); }, setState, policyMenu, menu,
      beforeNavigate: () => hooks.close() && updater.close() && importer.closeForNavigation() ? inspector.close('route') : false,
      hooks: pluginId => hooks.open(pluginId),
      view: (id, editing = false) => inspector.open(id, editing), add: async () => {
        if (!started) await loadAll();
        if (!Object.values(inventories).some(inventory => inventory.canCreate)) await loadProvider('claude');
        if (!Object.values(inventories).some(inventory => inventory.canCreate)) { Kit.toast('Couldn’t find a writable skill folder', { tone: 'danger', detail: errors.claude || 'Check the agent home folder permissions and rescan.' }); return; }
        return inspector.open(null, true, true);
      }, install: async options => { if (!started) await loadAll(); return importer.open(options); },
      search: value => { query = value; paint(); }, filter: agentMenu,
      focusSearch: () => document.getElementById('skill-search')?.focus(),
      select: value => { agent = value; paint(); }, attention: () => show(view === 'attention' ? 'all' : 'attention'),
      clear: () => { query = agent = ''; hideBundled = false; view = 'all'; try { localStorage.setItem(filterKey, 'false'); } catch { /* this session only */ } paint(); const field = document.getElementById('skill-search'); if (field) field.value = ''; },
      group: key => { const group = S.groups(rows).find(group => group.key === key); if (group) collapsed.set(key, !groupClosed(group)); paint(); },
      columns: viewMenu,
      copy: (key, provider) => { const skill = rows.find(row => row.key === key); if (skill) importer.open({ source: S.directory(skill.path), names: [skill.name], agents: provider ? [provider] : undefined, step: 2 }); },
      copyGroup: key => { const group = S.groups(rows).find(group => group.key === key); if (group) importer.open({ source: group.root.path, agents: installed.filter(id => !(group.root.readers || []).includes(id)), step: 2 }); },
      paletteItems: () => [{ id: 'skills-install', label: 'Install skills from source…', desc: 'Preview and install skills into agent folders', icon: 'download', cmd: { cmd: 'skills.import' } }, { id: 'skills-new', label: 'New skill', desc: 'Write a local SKILL.md', icon: 'plus', cmd: { cmd: 'skills.add' } }, { id: 'skills-rescan', label: 'Rescan skills', desc: 'Refresh all agent inventories', icon: 'refresh-cw', cmd: { cmd: 'skills.refresh' } }, ...rows.map(row => ({ id: 'skill-' + row.key, quiet: true, label: row.name, desc: row.description, icon: 'file-text', cmd: { cmd: 'skills.view', id: row.key } }))],
    };
  };
  return { create, stateOf: row => ({ text: S.state(row).label, tone: row.error ? 'warn' : S.available(row) ? 'ok' : '' }) };
})();
