// The Gateways page. It's read on demand, never morphed by the status poll, so
// switches and open sheets keep their place. A change is only shown as done once
// the server has answered with what T3 Code now holds.
const T3GatewaysUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3GatewayModel, M = T3Model;
  const POLL_MS = 1500;
  const STALE_CHECK_MS = 5 * 60 * 1000;
  const disabled = value => value ? raw(' disabled') : '';
  const hashParts = () => location.hash.replace(/^#\/?/, '').split('/');

  const create = ({ api, getStatus = () => null, render, onChange = async () => {}, go }) => {
    let data = null, error = null, started = false, loading = false, inFlight = null, epoch = 0, pollTimer = null, lastDeep = null;
    const busy = new Set(), checking = new Set();
    const gateways = () => data?.gateways || [];
    const gateway = id => gateways().find(entry => entry.id === id) || null;
    const installed = id => Boolean(getStatus()?.harnesses?.some(row => row.id === id && row.installed));
    const paint = () => {
      render();
      const mount = document.getElementById('gateway-list');
      if (mount) Kit.patch(mount, body());
      inspector.repaint(); editor.repaint();
    };
    const accept = next => { S.setCatalog(next.catalog); data = next; schedule(); };
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
    // Agents take a few seconds to start, and the rows should follow along.
    const settling = () => gateways().some(entry => entry.settling || entry.agents.some(agent => agent.state === 'starting'));
    const schedule = () => {
      clearTimeout(pollTimer); pollTimer = null;
      if (!settling()) return;
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
      // A read already on its way knows less than this change will.
      epoch++;
      busy.add(key); paint();
      let response;
      try {
        response = await api(route, { body: { revision: data?.revision, ...input } });
        if (response.ok) { accept(response.data); await onChange(); }
        else {
          Kit.toast(response.error || 'That didn’t finish. Try again.', { tone: 'danger' });
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
    };

    const ctx = {
      api, change, gateway, gateways, installed, reportFailures,
      keys: () => data?.keys || [],
      conflicts: () => data?.conflicts || [],
      revision: () => data?.revision,
      accepted: next => { accept(next); void onChange(); },
      reload: () => load(true),
      testSaved: id => test(id),
      edit: id => editor.open(gateway(id)),
      remove: id => remove(id),
      fixConflict: id => fixConflict(id),
      replaceKey: id => editor.open(gateway(id), { replaceKey: true }),
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
    const remove = async id => {
      const row = gateway(id); if (!row) return;
      const connected = row.agents.filter(agent => agent.connected).map(agent => agent.displayName);
      const yes = await Kit.confirm({
        title: 'Remove ' + row.name + '?',
        body: connected.length ? 'Its agents leave T3 Code’s model picker. Any turn running on them stops. Your direct sign-ins aren’t affected.' : 'Your direct sign-ins aren’t affected.',
        consequences: [
          ...(connected.length ? [{ icon: 'x', text: 'Removes ' + M.listOf(connected) }] : []),
          { icon: 'shield-check', text: 'Threads that used it stay readable and can continue on another agent' },
          ...(row.key.state === 'saved' ? [{ icon: 'key-round', text: 'Its key stays in the Vault as ' + row.key.credentialId }] : []),
        ],
        confirm: 'Remove gateway', tone: 'danger',
      });
      if (!yes) return;
      const response = await change(id + ':remove', '/gateways/remove', { id });
      if (response?.ok) { inspector.close('removed'); Kit.toast('Removed ' + row.name); }
    };
    const toggle = async (id, agentId, on) => {
      const key = id + ':' + agentId, row = gateway(id)?.agents.find(agent => agent.id === agentId);
      // Stopping is immediate, and a turn can't be brought back.
      if (!on && row && !await Kit.confirm({ title: 'Turn off ' + row.displayName + '?', body: 'It leaves T3 Code’s model picker, and any turn running on it stops. Its threads stay readable, and you can turn it back on here.', confirm: 'Turn off' })) return;
      const response = await change(key, '/gateways/agent', { id, agent: agentId, connected: on });
      if (response) reportFailures(response);
    };
    const apply = async (id, button) => {
      const agent = gateway(id)?.agents.find(row => row.id === button?.dataset.agent);
      // Both replace what a running process holds, so a turn on it would stop.
      if (agent && ['key-stale', 'drift'].includes(agent.state) && !await Kit.confirm({ title: S.agentState(agent).action.label + ' ' + agent.displayName + '?', body: 'It restarts, and any turn running on it stops. Your threads continue on the next message.', confirm: S.agentState(agent).action.label })) return;
      const response = await change(id + ':apply', '/gateways/apply', { id });
      if (response) reportFailures(response);
    };
    const fixConflict = async id => {
      const conflict = ctx.conflicts().find(entry => entry.id === id); if (!conflict) return;
      const yes = await Kit.confirm({ title: 'Clean up Claude’s settings?', body: 'Removes these from ' + conflict.file + '. Every other setting stays.', consequences: conflict.keys.map(key => ({ icon: 'x', text: key })), confirm: 'Remove them', tone: 'danger' });
      if (yes) await change('conflict', '/gateways/conflict', { id });
    };

    const actions = {
      add: () => editor.open(null), inspect: id => inspector.open(id), test, apply, 'fix-conflict': fixConflict, retry: () => load(true),
      install: () => go('agents'),
      menu: (id, button) => {
        const row = gateway(id); if (!row) return;
        Kit.menu(button, { label: 'More for ' + row.name, head: row.name, items: [
          { label: 'Details', icon: 'info', run: () => inspector.open(id) },
          { label: 'Edit…', icon: 'pencil', run: () => editor.open(row) },
          { label: 'Copy address', icon: 'copy', run: () => Kit.copy(row.url, button, 'Address copied') },
          { sep: true }, { label: 'Remove…', icon: 'trash-2', danger: true, disabled: busy.has(id + ':remove'), run: () => remove(id) },
        ] });
      },
    };

    // ---- drawing -------------------------------------------------------------
    const dot = tone => html`<span class="tc-dot${tone ? ' tc-dot--' + tone : ' tc-dot--idle'}" aria-hidden="true"></span>`;
    const stateLabel = state => html`<span class="tc-gw-state" data-tone="${state.tone}">${state.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>` : dot(state.tone)}<span>${state.label}</span></span>`;
    /** The type beside a name, unless the name already says it. */
    const presetName = row => { const name = S.presetOf(row.preset)?.id === 'custom' ? '' : S.presetOf(row.preset)?.name || ''; return name === row.name ? '' : name; };

    const agentRow = (row, agent) => {
      const key = row.id + ':' + agent.id, state = S.agentState(agent), pending = busy.has(key) || busy.has(row.id + ':apply');
      const meta = S.agentOf(agent.id), blocked = !agent.connected && !agent.offered;
      const action = state.action && !pending ? html`<button class="tc-btn tc-btn--xs" type="button" data-key="gw-fix-${key}" data-gw-action="${state.action.name}" data-id="${row.id}" data-agent="${agent.id}">${state.action.label}</button>` : '';
      return html`<div class="tc-gw-agent" data-key="gw-agent-${key}" data-state="${agent.state}" aria-busy="${String(pending)}">
        <span class="tc-tile tc-tile--mark" aria-hidden="true">${raw(T3C.agentMark(agent.id))}</span>
        <div class="tc-gw-agent-main">
          <span class="tc-gw-agent-name">${meta?.name || agent.id}</span>
          <span class="tc-gw-agent-line" title="${agent.connected ? 'Shown in T3 Code as ' + agent.displayName : ''}">${blocked ? 'This gateway has no ' + S.protocolName(meta?.protocol) + ' API' : S.agentLine(agent)}</span>
          ${state.desc ? html`<span class="tc-gw-agent-detail" title="${state.desc}">${state.desc}</span>` : ''}
        </div>
        <div class="tc-gw-agent-state">${pending ? html`<span class="tc-gw-state" data-tone="info"><span class="tc-spinner" aria-hidden="true"></span><span>Updating…</span></span>` : stateLabel(state)}${action}</div>
        <label class="tc-switch-hit" for="gw-switch-${key}"><button class="tc-switch" id="gw-switch-${key}" type="button" role="switch" data-key="gw-switch-${key}" aria-checked="${String(agent.connected)}" aria-label="Use ${row.name} for ${meta?.name || agent.id}" data-gw-toggle="${agent.id}" data-id="${row.id}"${disabled(pending || blocked || !data.t3.available)}></button></label>
      </div>`;
    };
    const card = row => {
      const state = S.gatewayState(row, Date.now(), M.relTime), fresh = S.newModels(row), preset = presetName(row);
      const testing = busy.has(row.id + ':test');
      return html`<section class="tc-group tc-gw-card" data-key="gw-card-${row.id}" aria-label="${row.name}">
        <header class="tc-gw-head">
          <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('waypoints')}</span>
          <div class="tc-gw-title">
            <div class="tc-gw-name"><button type="button" data-key="gw-name-${row.id}" data-gw-action="inspect" data-id="${row.id}" title="${row.name}">${row.name}</button>${preset ? html`<span class="tc-badge">${preset}</span>` : ''}</div>
            <code class="tc-gw-host" title="${row.url}">${row.host}</code>
          </div>
          <div class="tc-gw-health"><strong>${stateLabel(state)}</strong>${state.desc ? html`<small title="${state.desc}">${state.desc}</small>` : ''}</div>
          <div class="tc-gw-head-actions">
            <button class="tc-btn tc-btn--sm" type="button" data-key="gw-test-${row.id}" data-gw-action="test" data-id="${row.id}" aria-label="Test ${row.name}"${disabled(testing)}>${testing ? html`<span class="tc-spinner" aria-hidden="true"></span>Testing…` : 'Test'}</button>
            <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-key="gw-menu-${row.id}" data-gw-action="menu" data-id="${row.id}" aria-label="More for ${row.name}" aria-haspopup="menu" aria-expanded="false">${icon('ellipsis')}</button>
          </div>
        </header>
        ${fresh.added.length || fresh.removed.length ? html`<div class="tc-gw-fresh" role="status">${icon('sparkles', 'tc-icon--sm')}<span>${[fresh.added.length ? S.plural(fresh.added.length, 'new model') : '', fresh.removed.length ? fresh.removed.length + ' no longer offered' : ''].filter(Boolean).join(' · ')}</span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-key="gw-fresh-${row.id}" data-gw-action="inspect" data-id="${row.id}">Review…</button></div>` : ''}
        <div class="tc-gw-agents">${row.agents.map(agent => agentRow(row, agent))}</div>
        ${keyFoot(row)}
      </section>`;
    };
    const keyFoot = row => {
      const key = row.key;
      if (key.state === 'missing') return html`<div class="tc-card-foot tc-gw-foot" data-tone="warn">${icon('key-round', 'tc-icon--sm')}<span><code>${key.credentialId}</code> is no longer in the Vault. Agents keep working on their copy.</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--xs" type="button" data-gw-action="replace-key" data-id="${row.id}" data-key="gw-rekey-${row.id}">Replace key…</button></div>`;
      if (key.state === 'none') return html`<div class="tc-card-foot tc-gw-foot">${icon('lock', 'tc-icon--sm')}<span>This gateway doesn’t use a key.</span></div>`;
      return html`<div class="tc-card-foot tc-gw-foot">${icon('lock', 'tc-icon--sm')}<span>Key saved in the Vault as <a class="tc-cred-link" href="#vault/${key.credentialId}" data-key="gw-vault-${row.id}">${key.credentialId}</a></span></div>`;
    };
    const conflictNotice = conflict => html`<div class="tc-notice tc-notice--warn" role="status" data-key="gw-conflict-${conflict.id}">${icon('triangle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">Claude Code’s settings file overrides gateways</strong><span class="tc-notice-desc">${S.conflictSentence(conflict)}</span></div><button class="tc-btn tc-btn--sm" type="button" data-key="gw-conflict-fix" data-gw-action="fix-conflict" data-id="${conflict.id}"${disabled(busy.has('conflict'))}>Review…</button></div>`;
    const t3Notice = () => data.t3.available ? '' : html`<div class="tc-notice tc-notice--warn" role="status" data-key="gw-t3">${icon('triangle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">T3 Code isn’t answering</strong><span class="tc-notice-desc">${data.t3.code === 'unsupported' ? data.t3.error : 'Gateways can be read, but they can’t be changed until it’s back.'}</span></div></div>`;
    const empty = () => html`<div class="tc-group"><div class="tc-empty tc-gw-empty"><div class="tc-empty-media" aria-hidden="true"><span class="tc-empty-icon">${icon('waypoints')}</span></div><strong class="tc-empty-title">Route agents through your own gateway</strong><p class="tc-empty-desc">Connect CLIProxyAPI, LiteLLM, OpenRouter or any compatible API once. Each agent gets a new choice in T3 Code’s model picker, and your direct sign-ins stay as they are.</p><button class="tc-btn tc-btn--primary tc-empty-cta" type="button" data-key="gw-add-empty" data-gw-action="add"${disabled(!data.t3.available)}>${icon('plus')}Add gateway…</button></div></div>`;
    const skeleton = () => html`<div class="tc-group" role="status" aria-label="Loading gateways">${[1, 2, 3].map(index => html`<div class="tc-skel-row" data-key="gw-skeleton-${index}" aria-hidden="true"><span class="tc-skel tc-skel--tile"></span><span class="tc-skel tc-gw-skeleton-line"></span></div>`)}</div>`;
    const unsupportedLine = () => {
      const names = S.unsupported().map(entry => entry.name);
      return names.length ? html`<p class="tc-hint tc-gw-unsupported">${icon('info', 'tc-icon--sm')}<span>${M.listOf(names)} can’t use a gateway from here. <a class="tc-cred-link" href="${T3Routes.docUrl('gateways.md', getStatus()?.image?.version)}#which-agents" target="_blank" rel="noopener">Why?</a></span></p>` : '';
    };
    const body = () => {
      if (error) return html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">Couldn’t read gateways</strong><span class="tc-notice-desc">${error}</span></div><button class="tc-btn tc-btn--sm" type="button" data-gw-action="retry"${disabled(loading)}>Try again</button></div>`;
      if (!data) return skeleton();
      const conflicts = ctx.conflicts().filter(conflict => conflict.active);
      return html`${t3Notice()}${conflicts.map(conflictNotice)}${gateways().length ? html`<div class="tc-gw-cards">${gateways().map(card)}</div>${unsupportedLine()}` : empty()}`;
    };

    document.addEventListener('click', event => {
      const toggleButton = event.target.closest('[data-gw-toggle]');
      if (toggleButton && !toggleButton.disabled) { void toggle(toggleButton.dataset.id, toggleButton.dataset.gwToggle, toggleButton.getAttribute('aria-checked') !== 'true'); return; }
      const button = event.target.closest('[data-gw-action]');
      if (!button || button.disabled) return;
      const name = button.dataset.gwAction, id = button.dataset.id;
      if (name === 'replace-key') { void ctx.replaceKey(id); return; }
      void actions[name]?.(id, button);
    });
    window.addEventListener('focus', () => { if (started && pageActive() && !editor.isOpen()) void load(); });

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
      content: () => html`<div id="gateway-list" class="tc-gateways" data-keep>${body()}</div>`,
      headActions: () => data?.gateways?.length ? html`<button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-key="gw-add" data-gw-action="add"${disabled(!data.t3.available)}>${icon('plus')}Add gateway…</button>` : '',
      activate,
      add: () => editor.open(null),
      paletteItems: () => gateways().map(row => ({ id: 'gateway:' + row.id, group: 'Gateways', label: row.name, icon: 'waypoints', cmd: { cmd: 'goto', route: 'gateways/' + row.id }, keywords: 'gateway ' + row.host + ' ' + (S.presetOf(row.preset)?.name || '') })),
      beforeNavigate: () => editor.beforeNavigate(),
    };
  };
  return { create };
})();
