// The Gateways page, built like MCP servers: one row per gateway, one column per
// agent. It's read on demand, never morphed by the status poll, so cells and open
// sheets keep their place. A change only shows as done once the server has answered
// with what T3 Code now holds.
const T3GatewaysUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3GatewayModel, M = T3Model;
  const POLL_MS = 1500;
  const READING_POLLS = 20;
  const STALE_CHECK_MS = 5 * 60 * 1000;
  const disabled = value => value ? raw(' disabled') : '';
  const hashParts = () => location.hash.replace(/^#\/?/, '').split('/');

  const create = ({ api, getStatus = () => null, render, onChange = async () => {}, go }) => {
    let data = null, error = null, started = false, loading = false, inFlight = null, epoch = 0, pollTimer = null, lastDeep = null, readingPolls = 0, checkingAll = false, changes = Promise.resolve();
    let query = '', agentFilter = '', attentionOnly = false;
    const busy = new Set(), checking = new Set();
    const gateways = () => data?.gateways || [];
    const gateway = id => gateways().find(entry => entry.id === id) || null;
    const installed = id => Boolean(getStatus()?.harnesses?.some(row => row.id === id && row.installed));
    const attention = () => S.attention(gateways());
    const flagged = row => attention().some(item => item.id === row.id);
    const shown = () => gateways().filter(row => S.matches(row, query) && (!agentFilter || row.agents.some(agent => agent.id === agentFilter && agent.connected)) && (!attentionOnly || flagged(row)));
    const paint = () => {
      render();
      const mount = document.getElementById('gateway-list');
      if (mount) Kit.patch(mount, body());
      inspector.repaint(); editor.repaint();
    };
    const accept = next => { S.setCatalog(next.catalog); data = next; schedule(); };
    /** A read already on its way knows less than this answer does. */
    const supersede = () => { epoch++; inFlight = null; loading = false; };
    const load = (force = false) => {
      if (inFlight && !force) return inFlight;
      const version = ++epoch;
      started = true; loading = true; error = null;
      if (!data) paint();
      const work = api('/gateways').then(response => {
        if (version !== epoch) return false;
        if (response.ok) { accept(response.data); return true; }
        error = response.error || 'Gateways could not be read.';
        data = null;
        return false;
      }).finally(() => { if (version === epoch) { loading = false; inFlight = null; paint(); } });
      inFlight = work;
      return work;
    };
    // Agents take seconds to start, and T3 a little longer to read a new hub. Rows follow along.
    const starting = () => gateways().some(entry => entry.settling || entry.agents.some(agent => agent.state === 'starting'));
    const reading = () => gateways().some(entry => entry.limits?.state === 'reading');
    const schedule = () => {
      clearTimeout(pollTimer); pollTimer = null;
      readingPolls = reading() ? readingPolls + 1 : 0;
      if (!starting() && !(reading() && readingPolls <= READING_POLLS)) return;
      pollTimer = setTimeout(() => { if (hashParts()[0] === 'gateways') void load(true); else schedule(); }, POLL_MS);
    };
    const pageActive = () => hashParts()[0] === 'gateways';
    const refreshStale = async () => {
      for (const entry of gateways()) {
        if (entry.check?.at && Date.now() - entry.check.at < STALE_CHECK_MS) continue;
        if (checking.has(entry.id)) continue;
        checking.add(entry.id);
        await api('/gateways/test', { body: { id: entry.id } }).catch(() => {});
        checking.delete(entry.id);
        if (pageActive()) await load(true);
      }
    };

    /** Run a change, and show nothing as finished until its answer is in. */
    const change = async (key, route, input) => {
      if (busy.has(key)) return null;
      const focused = document.activeElement?.getAttribute('data-key');
      busy.add(key); paint();
      let response;
      // One at a time, each from the last one's revision. Two quick presses aren't two windows.
      const turn = changes.catch(() => {}).then(() => api(route, { body: { revision: data?.revision, ...input } }));
      changes = turn;
      try {
        response = await turn;
        supersede();
        if (response.ok) { readingPolls = 0; accept(response.data); await onChange(); }
        else {
          Kit.toast(response.error || 'That didn’t finish. Try again.', { tone: 'danger', detail: response.data?.hint });
          if (response.data?.code === 'conflict') await load(true);
        }
        return response;
      } finally {
        busy.delete(key); paint();
        if (focused && document.activeElement === document.body) document.querySelector('[data-key="' + CSS.escape(focused) + '"]')?.focus({ preventScroll: true });
      }
    };
    const failures = response => (response?.data?.results || []).filter(result => !result.ok);
    const reportFailures = response => {
      for (const failure of failures(response)) Kit.toast((S.agentOf(failure.agent)?.name || failure.agent) + ' couldn’t be updated', { tone: 'danger', detail: failure.error });
      if (response?.data?.limitsError) Kit.toast('Limits couldn’t be set up', { tone: 'danger', detail: response.data.limitsError });
    };

    const ctx = {
      api, change, gateway, gateways, installed, reportFailures,
      keys: () => data?.keys || [],
      conflicts: () => data?.conflicts || [],
      revision: () => data?.revision,
      hubs: () => Boolean(data?.t3?.hubs),
      hubAt: url => Boolean(data?.t3?.hubUrls?.includes(url)),
      accepted: next => { supersede(); readingPolls = 0; accept(next); void onChange(); },
      reload: () => load(true),
      testSaved: id => test(id),
      edit: (id, options) => editor.open(gateway(id), options),
      remove: id => remove(id),
      fixConflict: id => fixConflict(id),
      replaceKey: id => editor.open(gateway(id), { replaceKey: true }),
      toggle: (id, agentId, on) => toggle(id, agentId, on),
      scope: (id, agentId, scope) => setScope(id, agentId, scope),
      removeLimits: id => removeLimits(id),
      isBusy: key => busy.has(key),
      tile: row => tile(row),
      // The address stops naming it, so the same link works again.
      inspectorClosed: () => { lastDeep = null; },
    };
    const inspector = T3GatewayInspector.create(ctx), editor = T3GatewayEditor.create(ctx);

    const test = async id => {
      if (busy.has(id + ':test')) return;
      busy.add(id + ':test'); paint();
      const response = await api('/gateways/test', { body: { id } }).catch(() => null);
      busy.delete(id + ':test');
      await load(true);
      const result = response?.data?.result;
      if (response && !response.ok) Kit.toast(response.error, { tone: 'danger' });
      else if (result) Kit.announce(result.ok ? gateway(id)?.name + ' answered.' : result.message);
    };
    const checkAll = async () => {
      if (checkingAll) return;
      checkingAll = true; paint();
      await Promise.all(gateways().map(entry => api('/gateways/test', { body: { id: entry.id } }).catch(() => null)));
      checkingAll = false;
      await load(true);
    };
    const remove = async id => {
      const row = gateway(id); if (!row) return;
      const connected = row.agents.filter(agent => agent.connected).map(agent => agent.displayName);
      const yes = await Kit.confirm({
        title: 'Remove ' + row.name + '?',
        body: connected.length ? 'Its agents leave T3 Code’s model picker. Any turn running on them stops. Your direct sign-ins aren’t affected.' : 'Your direct sign-ins aren’t affected.',
        consequences: [
          ...(connected.length ? [{ icon: 'x', text: 'Removes ' + M.listOf(connected) }] : []),
          ...(row.limits?.owned ? [{ icon: 'gauge', text: 'Its accounts leave Usage → Limits, and T3 Code forgets the management key' }] : []),
          { icon: 'shield-check', text: 'Threads that used it stay readable and can continue on another agent' },
          ...(row.key.state === 'saved' ? [{ icon: 'key-round', text: 'Its key stays in the Vault as ' + row.key.credentialId }] : []),
        ],
        confirm: 'Remove gateway', tone: 'danger',
      });
      if (!yes) return;
      const response = await change(id + ':remove', '/gateways/remove', { id });
      if (!response?.ok) return;
      inspector.close('removed');
      Kit.toast('Removed ' + row.name);
      if (response.data.limitsError) Kit.toast('T3 Code still has this gateway’s limits', { tone: 'danger', detail: 'Remove the hub under Settings → Providers → Usage providers.' });
    };
    const toggle = async (id, agentId, on) => {
      const key = id + ':' + agentId, row = gateway(id)?.agents.find(agent => agent.id === agentId);
      // Stopping is immediate, and a turn can't be brought back.
      if (!on && row && !await Kit.confirm({ title: 'Turn off ' + row.displayName + '?', body: 'It leaves T3 Code’s model picker, and any turn running on it stops. Its threads stay readable, and you can turn it back on here.', confirm: 'Turn off' })) return;
      const response = await change(key, '/gateways/agent', { id, agent: agentId, connected: on });
      if (response) reportFailures(response);
      return response;
    };
    const setScope = async (id, agentId, scope) => {
      const response = await change(id + ':' + agentId, '/gateways/agent', { id, agent: agentId, connected: true, scope });
      if (response) reportFailures(response);
      return response;
    };
    const apply = async (id, agentId) => {
      const agent = gateway(id)?.agents.find(row => row.id === agentId) || gateway(id)?.agents.find(row => row.state === 'key-stale');
      // Both replace what a running process holds, so a turn on it would stop.
      if (agent && ['key-stale', 'drift'].includes(agent.state) && !await Kit.confirm({ title: S.agentState(agent).action.label + ' ' + (agentId ? agent.displayName : gateway(id).name) + '?', body: 'Agents using it restart, and any turn running on them stops. Your threads continue on the next message.', confirm: S.agentState(agent).action.label })) return;
      const response = await change(id + ':apply', '/gateways/apply', { id });
      if (response) reportFailures(response);
    };
    const applyModels = async id => {
      const response = await change(id + ':apply', '/gateways/models', { id });
      if (response) reportFailures(response);
    };
    const removeLimits = async id => {
      const row = gateway(id); if (!row) return;
      const yes = await Kit.confirm({ title: 'Stop showing ' + row.name + '’s limits?', body: 'Its accounts leave Usage → Limits, and T3 Code forgets the management key. The gateway and its agents keep working.', confirm: 'Stop showing limits', tone: 'danger' });
      if (yes) await change(id + ':limits', '/gateways/limits', { id, remove: true });
    };
    const fixConflict = async id => {
      const conflict = ctx.conflicts().find(entry => entry.id === id); if (!conflict) return;
      const yes = await Kit.confirm({ title: 'Clean up Claude’s settings?', body: 'Removes these from ' + conflict.file + '. Every other setting stays.', consequences: conflict.keys.map(key => ({ icon: 'x', text: key })), confirm: 'Remove them', tone: 'danger' });
      if (yes) await change('conflict', '/gateways/conflict', { id });
    };

    const rowMenu = (id, button) => {
      const row = gateway(id); if (!row) return;
      Kit.menu(button, { label: 'More for ' + row.name, head: row.name, items: [
        { label: 'Details', icon: 'info', run: () => inspector.open(id) },
        { label: 'Edit…', icon: 'pencil', run: () => editor.open(row) },
        ...(row.limits?.supported && row.limits.state === 'off' ? [{ label: 'Set up limits…', icon: 'gauge', run: () => editor.open(row, { limits: true }) }] : []),
        { label: 'Copy address', icon: 'copy', run: () => Kit.copy(row.url, button, 'Address copied') },
        { sep: true }, { label: 'Remove…', icon: 'trash-2', danger: true, disabled: busy.has(id + ':remove'), run: () => remove(id) },
      ] });
    };
    const cellMenu = (id, agentId, trigger) => {
      const row = gateway(id), agent = row?.agents.find(entry => entry.id === agentId), meta = S.agentOf(agentId); if (!agent) return;
      const state = S.agentState(agent), widest = [...row.models.ids, ...row.models.manual.filter(entry => !row.models.ids.includes(entry))].length;
      Kit.menu(trigger, { label: agent.displayName, head: { title: agent.displayName },
        status: state.tone && state.tone !== 'ok' ? html`<div class="tc-menu-status">${icon('triangle-alert')}<span>${agent.detail || state.label}</span></div>` : null,
        items: [
          ...(state.action ? [{ label: state.action.label, icon: 'refresh-cw', run: () => actions[state.action.name]?.(id, { dataset: { agent: agentId } }) }, { sep: true }] : []),
          { label: 'On', radio: true, checked: agent.connected, description: 'In T3 Code’s model picker.', run: () => !agent.connected && toggle(id, agentId, true) },
          { label: 'Off', radio: true, checked: !agent.connected, description: 'Leaves the picker. A turn running on it stops.', run: () => agent.connected && toggle(id, agentId, false) },
          ...(agentId === 'opencode' ? [] : [{ sep: true },
            { label: 'Compatible models', radio: true, checked: agent.scope !== 'all', description: 'The models ' + meta.name + ' is made for.', run: () => agent.scope === 'all' && setScope(id, agentId, 'compatible') },
            { label: 'All models', radio: true, checked: agent.scope === 'all', description: S.models(widest) + ', for a gateway that translates formats.', run: () => agent.scope !== 'all' && setScope(id, agentId, 'all') }]),
        ],
        footer: html`Shown in T3 Code as <code>${agent.displayName}</code>.` });
    };
    const othersMenu = trigger => Kit.menu(trigger, { label: 'Agents that can’t use a gateway', head: { title: 'Can’t use a gateway from here' },
      items: S.unsupported().map(entry => ({ label: entry.name, description: entry.reason, disabled: true, run: () => {} })),
      footer: html`<a class="tc-cred-link" href="${T3Routes.docUrl('gateways.md', getStatus()?.image?.version)}#which-agents" target="_blank" rel="noopener">Why these agents?</a>` });
    const usedByMenu = trigger => Kit.menu(trigger, { label: 'Used by', items: [
      { label: 'Any agent', radio: true, checked: !agentFilter, run: () => { agentFilter = ''; paint(); } },
      ...S.agents().map(agent => ({ label: agent.name, radio: true, checked: agentFilter === agent.id, run: () => { agentFilter = agent.id; paint(); } })),
    ] });

    const actions = {
      add: id => editor.open(null, { preset: id }), inspect: id => inspector.open(id), test, 'check-all': checkAll, 'fix-conflict': fixConflict, retry: () => load(true), 'apply-models': applyModels,
      apply: (id, button) => apply(id, button?.dataset?.agent),
      install: () => go('agents'), menu: rowMenu, others: (id, button) => othersMenu(button), 'used-by': (id, button) => usedByMenu(button),
      cell: (id, button) => cellMenu(id, button.dataset.agent, button),
      connect: (id, button) => toggle(id, button.dataset.agent, true),
      'attention-only': () => { attentionOnly = !attentionOnly; paint(); },
      'clear-filters': () => { query = ''; agentFilter = ''; attentionOnly = false; paint(); const field = document.getElementById('gateway-search'); if (field) field.value = ''; },
    };

    // ---- drawing -------------------------------------------------------------
    const dot = tone => html`<span class="tc-dot${tone ? ' tc-dot--' + tone : ' tc-dot--idle'}" aria-hidden="true"></span>`;
    const stateLabel = state => html`<span class="tc-gw-state" data-tone="${state.tone}">${state.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>` : dot(state.tone)}<span>${state.label}</span></span>`;
    const tile = row => {
      const mark = S.presetOf(row.preset)?.mark;
      return mark ? html`<span class="tc-tile tc-tile--mark" aria-hidden="true">${raw(T3C.agentMark(mark))}</span>` : html`<span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('waypoints')}</span>`;
    };
    const agentMark = id => html`<span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(id))}</span>`;
    /** The type beside a name, unless the name already says it. */
    const presetName = row => { const name = S.presetOf(row.preset)?.id === 'custom' ? '' : S.presetOf(row.preset)?.name || ''; return name === row.name ? '' : name; };

    const keyChip = row => {
      const key = row.key;
      if (key.state === 'none') return html`<span class="tc-key" title="This gateway doesn’t use a key">${icon('lock-open')}No key</span>`;
      if (key.state === 'missing') return html`<button class="tc-key tc-gw-chip" type="button" data-tone="warn" data-key="gw-key-${row.id}" data-gw-action="replace-key" data-id="${row.id}" title="${key.credentialId} is no longer in the Vault">${icon('key-round')}Key missing</button>`;
      return html`<a class="tc-key tc-gw-chip" href="#vault/${key.credentialId}" data-key="gw-vault-${row.id}" title="Saved in the Vault as ${key.credentialId}">${icon('key-round')}${key.credentialId}</a>`;
    };
    const limitsChip = row => {
      const limits = row.limits;
      if (!limits || limits.state === 'off') return '';
      const state = S.limitsState(limits);
      return html`<button class="tc-key tc-gw-chip" type="button" data-tone="${state.tone === 'warn' ? 'warn' : ''}" data-key="gw-limits-${row.id}" data-gw-action="inspect" data-id="${row.id}" title="Usage → Limits in T3 Code: ${state.desc || state.label}">${icon('gauge')}${state.label}</button>`;
    };
    const cell = (row, agent) => {
      const key = 'gw-cell-' + row.id + '-' + agent.id, meta = S.agentOf(agent.id), name = row.name + ' for ' + meta.name;
      if (busy.has(row.id + ':' + agent.id) || busy.has(row.id + ':apply')) return html`<span class="tc-cell" role="status"><span class="tc-spinner" aria-hidden="true"></span><span class="tc-sr">Updating ${name}</span></span>`;
      if (!agent.connected) {
        if (!installed(agent.id)) return html`<span class="tc-cell tc-cell--unsupported" title="${meta.name} isn’t installed. Add it on the Agents page."><span>Not installed</span></span>`;
        if (!agent.offered) return html`<span class="tc-cell tc-cell--unsupported" title="This gateway has no ${S.protocolName(meta.protocol)} API, which ${meta.name} needs."><span>No route</span></span>`;
        return html`<button class="tc-cell tc-cell--none" type="button" data-key="${key}" data-gw-action="connect" data-id="${row.id}" data-agent="${agent.id}" aria-label="Use ${name}"${disabled(!data.t3.available)}><span class="tc-cell-dash">—</span><span class="tc-cell-add">${icon('plus')}Add</span></button>`;
      }
      const state = S.cellState(agent);
      if (state.busy) return html`<span class="tc-cell" role="status" data-tone="muted"><span class="tc-spinner" aria-hidden="true"></span><span>${state.label}</span></span>`;
      return html`<button class="tc-cell" type="button" data-tone="${state.tone}" data-key="${key}" data-gw-action="cell" data-id="${row.id}" data-agent="${agent.id}" aria-label="${name}: ${state.label.toLowerCase()}" aria-haspopup="menu"${disabled(!data.t3.available)}>${state.tone && state.tone !== 'muted' ? html`<span class="tc-dot tc-dot--${state.tone}"></span>` : ''}<span>${state.label}</span>${icon('chevron-down')}</button>`;
    };
    const tableRow = row => {
      const state = S.gatewayState(row, Date.now(), M.relTime), preset = presetName(row), testing = busy.has(row.id + ':test') || checking.has(row.id), issue = flagged(row);
      // The row's button is whatever would fix it, and Test when nothing needs fixing.
      const fix = attention().find(item => item.id === row.id && !['test', 'inspect'].includes(item.action.name));
      return html`<div class="tc-mx-row tc-gw-row" role="row" data-key="gw-${row.id}" data-tone="${issue ? 'warn' : ''}">
        <div class="tc-mx-skill" role="cell">${tile(row)}<div class="tc-mx-skill-copy">
          <div class="tc-mx-name"><button class="tc-skill-name" type="button" data-key="gw-name-${row.id}" data-gw-action="inspect" data-id="${row.id}" title="${row.name}">${row.name}</button>${preset ? html`<span class="tc-badge">${preset}</span>` : ''}</div>
          <div class="tc-mcp-detail" title="${row.url}">${icon('globe')}<span>${row.host}</span></div>
          <span class="tc-keys">${keyChip(row)}${limitsChip(row)}</span>
        </div></div>
        <div class="tc-gw-status" role="cell">${stateLabel(state)}${state.brief || state.desc ? html`<small title="${state.desc}">${state.brief || state.desc}</small>` : ''}</div>
        ${row.agents.map(agent => html`<div class="tc-cellwrap" role="cell" data-key="gw-${row.id}-${agent.id}">${cell(row, agent)}</div>`)}
        <div class="tc-gw-actions" role="cell">
          ${fix ? html`<button class="tc-btn tc-btn--sm" type="button" data-key="gw-fix-${row.id}" data-gw-action="${fix.action.name}" data-id="${row.id}"${fix.agent ? html` data-agent="${fix.agent}"` : ''}>${fix.action.label}</button>` : html`<button class="tc-btn tc-btn--sm" type="button" data-key="gw-test-${row.id}" data-gw-action="test" data-id="${row.id}" aria-label="Test ${row.name}"${disabled(testing)}>${testing ? html`<span class="tc-spinner" aria-hidden="true"></span>` : 'Test'}</button>`}
          <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-key="gw-menu-${row.id}" data-gw-action="menu" data-id="${row.id}" aria-label="More for ${row.name}" aria-haspopup="menu" aria-expanded="false">${icon('ellipsis')}</button>
        </div>
      </div>`;
    };
    const lastChecked = () => { const times = gateways().map(entry => entry.check?.at).filter(Boolean); return times.length ? Math.max(...times) : null; };
    const footer = () => {
      const at = lastChecked();
      return html`<div class="tc-sk-library-foot"><span>${icon('info', 'tc-icon--sm')}Choose a gateway’s entry in T3 Code’s model picker to use it for a thread.</span><span class="tc-sk-scan-time" title="${at ? M.absTime(new Date(at).toISOString()) : ''}">${at ? 'Tested ' + M.relTime(at, Date.now()) : ''}</span>${gateways().length > 1 ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-key="gw-check-all" data-gw-action="check-all"${disabled(checkingAll)}>${checkingAll ? html`<span class="tc-spinner"></span>Testing` : html`${icon('refresh-cw')}Test all`}</button>` : ''}</div>`;
    };
    const table = rows => html`<div class="tc-group tc-sk-table tc-mcp-table tc-gw-table"><div class="tc-mx-scroll" tabindex="0" aria-label="Gateways by agent"><div class="tc-mx tc-gw-mx" role="table" aria-label="Gateways and the agents using them" style="--mx-agent-count:${S.agents().length}">
      <div class="tc-mx-head" role="row"><div class="tc-mx-head-label" role="columnheader"><span>Gateway</span><button class="tc-btn tc-btn--ghost tc-btn--xs tc-mx-columns" type="button" data-key="gw-others" data-gw-action="others" aria-haspopup="menu" aria-label="Agents that can’t use a gateway">${S.unsupported().length} other agents${icon('chevron-down', 'tc-chev')}</button></div><div class="tc-gw-status-head" role="columnheader">Status</div>${S.agents().map(agent => html`<div class="tc-mx-agent" role="columnheader" data-key="gw-head-${agent.id}"${!installed(agent.id) ? raw(' data-uninstalled') : ''}><span class="tc-mx-agent-name">${agentMark(agent.id)}${agent.name}</span><span class="tc-mx-agent-kind">${S.protocolShort(agent.protocol)}</span></div>`)}<div role="columnheader"><span class="tc-sr">Actions</span></div></div>
      <div role="rowgroup">${rows.map(tableRow)}</div>
    </div></div>${footer()}</div>`;
    const phoneRow = row => {
      const state = S.gatewayState(row, Date.now(), M.relTime), used = row.agents.filter(agent => agent.connected), preset = presetName(row);
      return html`<button class="tc-prow" type="button" data-key="gw-phone-${row.id}" data-gw-action="inspect" data-id="${row.id}"><span class="tc-prow-name tc-prow-name-line">${row.name}${preset ? html`<span class="tc-badge">${preset}</span>` : ''}</span><span class="tc-prow-detail">${row.host}</span><span class="tc-prow-agents">${used.length ? html`<span class="tc-agent-stack" aria-hidden="true">${used.map(agent => agentMark(agent.id))}</span>` : ''}<span class="tc-gw-state" data-tone="${state.tone}">${state.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>` : dot(state.tone)}<span>${state.label}</span></span></span>${icon('chevron-right')}</button>`;
    };
    const phone = rows => html`<div class="tc-sk-phone-list"><div class="tc-group tc-plist">${rows.map(phoneRow)}</div></div>`;
    const toolbar = () => {
      const all = gateways(), issues = attention().length + ctx.conflicts().filter(conflict => conflict.active).length, connected = all.reduce((total, row) => total + row.agents.filter(agent => agent.connected).length, 0);
      return html`<div class="tc-sk-toolbar">${all.length > 1 ? html`<label class="tc-sk-search">${icon('search')}<input class="tc-input" id="gateway-search" data-key="gateway-search" value="${query}" type="search" placeholder="Search ${all.length} gateways" aria-label="Search gateways"><kbd class="tc-kbd">/</kbd></label><div class="tc-sk-desktop-filters"><button class="tc-btn tc-btn--sm" type="button" data-key="gw-used-by" data-gw-action="used-by" aria-haspopup="menu">Used by: <span class="tc-btn-value">${agentFilter ? S.agentOf(agentFilter)?.name : 'Any agent'}</span>${icon('chevron-down', 'tc-chev')}</button>${issues ? html`<button class="tc-btn tc-btn--sm" type="button" data-key="gw-attention" data-gw-action="attention-only" aria-pressed="${String(attentionOnly)}"><span class="tc-dot tc-dot--warn"></span>Needs attention ${issues}</button>` : ''}</div>` : html`<span class="tc-gw-summary">1 gateway · ${S.plural(connected, 'agent')}</span>`}<span class="tc-spacer"></span><div class="tc-sk-desktop-actions"><button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-key="gw-add" data-gw-action="add"${disabled(!data.t3.available)}>${icon('plus')}Add gateway…</button></div></div>`;
    };
    const notice = item => html`<div class="tc-notice tc-notice--${item.tone} tc-mcp-attention" role="status" data-key="gw-notice-${item.key}">${icon(item.tone === 'danger' ? 'circle-alert' : 'triangle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">${item.title}</strong>${item.desc ? html`<span class="tc-notice-desc">${item.desc}</span>` : ''}</div><button class="tc-btn tc-btn--sm" type="button" data-gw-action="${item.action.name}" data-id="${item.id}"${item.agent ? html` data-agent="${item.agent}"` : ''}>${item.action.label}</button></div>`;
    const conflictNotice = conflict => html`<div class="tc-notice tc-notice--warn" role="status" data-key="gw-conflict-${conflict.id}">${icon('triangle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">Claude Code’s settings file overrides gateways</strong><span class="tc-notice-desc">${S.conflictSentence(conflict)}</span></div><button class="tc-btn tc-btn--sm" type="button" data-key="gw-fix-conflict" data-gw-action="fix-conflict" data-id="${conflict.id}">Review…</button></div>`;
    const t3Notice = () => data.t3.available ? '' : html`<div class="tc-notice tc-notice--warn" role="status" data-key="gw-t3">${icon('triangle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">T3 Code isn’t answering</strong><span class="tc-notice-desc">${data.t3.code === 'unsupported' ? data.t3.error : 'Gateways can be read, but they can’t be changed until it’s back.'}</span></div></div>`;
    const freshNotice = row => {
      const fresh = S.newModels(row); if (!fresh.added.length && !fresh.removed.length) return '';
      return html`<div class="tc-notice tc-notice--info" role="status" data-key="gw-fresh-${row.id}">${icon('sparkles')}<div class="tc-notice-body"><strong class="tc-notice-title">${row.name} has ${[fresh.added.length ? S.plural(fresh.added.length, 'new model') : '', fresh.removed.length ? fresh.removed.length + ' fewer' : ''].filter(Boolean).join(' and ')}</strong><span class="tc-notice-desc">${fresh.added.slice(0, 3).join(', ')}${fresh.added.length > 3 ? ' and ' + (fresh.added.length - 3) + ' more' : ''}${fresh.added.length ? '. ' : ''}Applying can restart agents using it.</span></div><button class="tc-btn tc-btn--sm" type="button" data-gw-action="apply-models" data-id="${row.id}"${disabled(busy.has(row.id + ':apply'))}>Apply</button></div>`;
    };
    const presetCard = preset => html`<button class="tc-gw-preset" type="button" data-key="gw-start-${preset.id}" data-gw-action="add" data-id="${preset.id}"${disabled(!data.t3.available)}>${preset.mark ? html`<span class="tc-tile tc-tile--mark" aria-hidden="true">${raw(T3C.agentMark(preset.mark))}</span>` : html`<span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('waypoints')}</span>`}<span class="tc-gw-preset-text"><strong>${preset.name}</strong><small>${preset.blurb}</small></span></button>`;
    const empty = () => html`<div class="tc-group tc-gw-empty"><div class="tc-empty"><div class="tc-empty-media" aria-hidden="true"><span class="tc-empty-icon">${icon('waypoints')}</span></div><strong class="tc-empty-title">Connect your first gateway</strong><p class="tc-empty-desc">Enter it once, and each agent gets a new choice in T3 Code’s model picker.</p></div><div class="tc-gw-presets" data-key="gw-start">${S.presets().map(presetCard)}</div><div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Works with Claude Code, Codex and OpenCode. ${S.listOf(S.unsupported().map(entry => entry.name))} can’t use one from here.</span></div></div>`;
    const skeleton = () => html`<div class="tc-group" role="status" aria-label="Loading gateways">${[1, 2].map(index => html`<div class="tc-skel-row" data-key="gw-skeleton-${index}" aria-hidden="true"><span class="tc-skel tc-skel--tile"></span><span class="tc-skel tc-gw-skeleton-line"></span></div>`)}</div>`;
    const phoneAttention = issues => issues.length ? html`<button class="tc-sk-phone-notice tc-mcp-phone-attention" type="button" data-gw-action="inspect" data-id="${issues[0].id}">${icon('triangle-alert')}<span><strong>${issues[0].title}</strong><span>${issues[0].desc}${issues.length > 1 ? ' · ' + (issues.length - 1) + ' more need attention' : ''}</span></span>${icon('chevron-right')}</button>` : '';
    const body = () => {
      if (error) return html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">Couldn’t read gateways</strong><span class="tc-notice-desc">${error}</span></div><button class="tc-btn tc-btn--sm" type="button" data-key="gw-retry" data-gw-action="retry">Try again</button></div>`;
      if (!data) return skeleton();
      const conflicts = ctx.conflicts().filter(conflict => conflict.active), rows = shown(), all = gateways(), issues = attention();
      if (!all.length) return html`${t3Notice()}${empty()}`;
      // Only what can't be shown on a row gets a banner. The rest is on its row, with the fix beside it.
      const urgent = issues.filter(item => item.tone === 'danger');
      return html`${toolbar()}${t3Notice()}${phoneAttention(issues)}<div class="tc-sk-notices">${conflicts.map(conflictNotice)}${urgent.slice(0, 3).map(notice)}${urgent.length > 3 ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-gw-action="attention-only">and ${urgent.length - 3} more</button>` : ''}${all.map(freshNotice)}</div>
        ${rows.length ? html`${table(rows)}${phone(rows)}<div class="tc-mcp-mobile-footer">${footer()}</div>` : html`<div class="tc-empty tc-sk-empty"><strong class="tc-empty-title">No gateways match</strong><span class="tc-empty-desc">Try another search or filter.</span><button class="tc-btn tc-btn--sm" type="button" data-gw-action="clear-filters">Clear filters</button></div>`}
        <div class="tc-sk-phone-actions"><button class="tc-btn tc-btn--primary tc-btn--block" type="button" data-gw-action="add"${disabled(!data.t3.available)}>${icon('plus')}Add gateway</button></div>`;
    };

    document.addEventListener('click', event => {
      const button = event.target.closest('[data-gw-action]');
      if (!button || button.disabled) return;
      const name = button.dataset.gwAction, id = button.dataset.id;
      if (name === 'replace-key') { void ctx.replaceKey(id); return; }
      void actions[name]?.(id, button);
    });
    document.addEventListener('input', event => { if (event.target.id === 'gateway-search') { query = event.target.value; paint(); } });
    window.addEventListener('focus', () => { if (started && pageActive() && !editor.isOpen()) void load(); });
    Kit.COMPACT.addEventListener('change', () => { if (started) { paint(); } });

    const activate = async (force = false) => {
      const loaded = force || !started ? await load() : Boolean(data);
      if (!loaded) return;
      const [, id] = hashParts();
      if (id === 'new') {
        history.replaceState(null, '', '#gateways');
        if (!editor.isOpen()) await editor.open(null);
      } else if (id && id !== lastDeep) {
        lastDeep = id;
        if (gateway(id)) inspector.open(id);
        else Kit.toast('Gateway not found', { tone: 'info', detail: 'It may have been removed in another window.' });
      } else if (!id) lastDeep = null;
      if (force) void refreshStale();
    };

    return {
      content: () => html`<div id="gateway-list" class="tc-skills-library tc-mcp-library tc-gateways" data-key="gateway-list" data-keep>${body()}</div>`,
      phoneHead: () => html`<header class="tc-instructions-phone-head"><a class="tc-btn tc-btn--ghost" href="#more">${icon('chevron-right', 'tc-back-icon')}Setup</a><h1>Gateways</h1>${document.documentElement.hasAttribute('data-embed') ? '' : html`<span></span>`}</header>`,
      activate,
      add: () => editor.open(null),
      focusSearch: () => document.getElementById('gateway-search')?.focus(),
      paletteItems: () => gateways().map(row => ({ id: 'gateway:' + row.id, group: 'Gateways', label: row.name, icon: 'waypoints', cmd: { cmd: 'goto', route: 'gateways/' + row.id }, keywords: 'gateway ' + row.host + ' ' + (S.presetOf(row.preset)?.name || '') })),
      beforeNavigate: () => editor.beforeNavigate(),
    };
  };
  return { create };
})();
