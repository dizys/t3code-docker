// One gateway in full: how it's reached, its key, and the models it offers.
const T3GatewayInspector = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3GatewayModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const MODEL_ROWS = 50;

  const create = ctx => {
    let active = null;
    const close = reason => { active?.layer.close(reason); };
    const repaint = () => {
      if (!active || active.layer.closed) return;
      if (!ctx.gateway(active.id)) return close('removed');
      active.layer.panel.classList.toggle('tc-sheet--bottom', Kit.isPhone());
      active.layer.render(); sync();
    };
    const sync = () => {
      for (const input of active?.layer.panel.querySelectorAll('[data-gw-inspect-field]') || []) {
        const value = active[input.dataset.gwInspectField] ?? '';
        if (input.value !== value) input.value = value;
      }
    };
    const open = id => {
      if (active?.id === id) return repaint();
      close('replaced');
      const view = { id, query: '', manualDraft: '', error: null, busy: null };
      active = view;
      const row = () => ctx.gateway(id);
      const action = (name, label, options = {}) => html`<button class="tc-btn ${options.primary ? 'tc-btn--primary' : options.ghost ? 'tc-btn--ghost' : ''} tc-btn--sm" type="button" data-key="gw-insp-${name}" data-gw-inspect="${name}"${disabled(options.disabled)}>${options.icon ? icon(options.icon) : ''}${label}</button>`;

      const banner = gateway => {
        const state = S.gatewayState(gateway, Date.now(), M.relTime), check = gateway.check;
        return html`<div class="tc-cred-result"><div class="tc-cred-banner" data-tone="${state.tone === 'info' ? '' : state.tone}" role="status">${state.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>` : icon(state.tone === 'ok' ? 'circle-check' : state.tone ? 'circle-alert' : 'info')}<div><strong>${state.label}</strong>${state.desc ? html`<span>${state.desc}</span>` : ''}${check?.hint && !check.ok ? html`<span>${check.hint}</span>` : ''}</div>${action('test', 'Test', { disabled: view.busy })}</div></div>`;
      };
      const protocols = gateway => Object.entries(gateway.check?.protocols || {}).map(([id, state]) => html`<li data-tone="${state === 'available' ? 'ok' : state === 'missing' ? 'muted' : 'warn'}">${icon(state === 'available' ? 'check' : state === 'missing' ? 'x' : 'triangle-alert')}${S.protocolName(id)}</li>`);
      const connection = gateway => html`<section class="tc-insp-section"><h3 class="tc-insp-label">Connection</h3><dl class="tc-group tc-pathlist tc-gw-facts"><dt>Address</dt><dd><code>${gateway.url}</code></dd>${S.presetOf(gateway.preset)?.id !== 'custom' ? html`<dt>Type</dt><dd>${S.presetOf(gateway.preset)?.name}</dd>` : ''}<dt>Key</dt><dd>${gateway.key.state === 'none' ? 'None' : html`<a class="tc-cred-link" href="#vault/${gateway.key.credentialId}" data-gw-inspect="vault">${gateway.key.credentialId}</a>`}${gateway.key.state === 'missing' ? ' (missing)' : ''}</dd>${gateway.check?.protocols ? html`<dt>Offers</dt><dd><ul class="tc-gw-checks">${protocols(gateway)}</ul></dd>` : ''}</dl>${gateway.insecure ? html`<p class="tc-hint tc-hint--warn">${icon('triangle-alert', 'tc-icon--sm')} This address is plain http on a public host, so the key travels unencrypted.</p>` : ''}</section>`;
      const scopeRow = (gateway, agent) => {
        const meta = S.agentOf(agent.id);
        if (agent.id === 'opencode') return '';
        return html`<div class="tc-gw-scope" data-key="gw-scope-${agent.id}"><span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(agent.id))}</span><span class="tc-gw-scope-name">${meta.name}</span><span class="tc-small tc-muted">${S.models(agent.models)}</span><span class="tc-spacer"></span><div class="tc-seg" role="group" aria-label="Models for ${meta.name}"><button type="button" aria-pressed="${String(agent.scope !== 'all')}" data-gw-inspect="scope" data-agent="${agent.id}" data-scope="compatible"${disabled(view.busy)}>Compatible</button><button type="button" aria-pressed="${String(agent.scope === 'all')}" data-gw-inspect="scope" data-agent="${agent.id}" data-scope="all"${disabled(view.busy)}>All</button></div></div>`;
      };
      const models = gateway => {
        const ids = [...gateway.models.ids, ...gateway.models.manual.filter(entry => !gateway.models.ids.includes(entry))], query = view.query.trim().toLowerCase();
        const shown = (query ? ids.filter(entry => entry.toLowerCase().includes(query)) : ids), fresh = S.newModels(gateway);
        const connected = gateway.agents.filter(agent => agent.connected);
        return html`<section class="tc-insp-section" data-key="gw-models"><h3 class="tc-insp-label">Models<span class="tc-spacer"></span><span class="tc-hint">${gateway.models.at ? 'Read ' + M.relTime(gateway.models.at, Date.now()) : 'Added by hand'}</span>${action('refresh', 'Refresh', { ghost: true, icon: 'refresh-cw', disabled: view.busy })}</h3>
          ${fresh.added.length || fresh.removed.length ? html`<div class="tc-gw-fresh tc-gw-fresh--panel" role="status">${icon('sparkles', 'tc-icon--sm')}<span>${[fresh.added.length ? S.plural(fresh.added.length, 'new model') + ': ' + fresh.added.slice(0, 3).join(', ') + (fresh.added.length > 3 ? '…' : '') : '', fresh.removed.length ? fresh.removed.length + ' no longer offered' : ''].filter(Boolean).join(' · ')}</span></div>` : ''}
          ${connected.length ? html`<div class="tc-group tc-gw-scopes">${connected.map(agent => scopeRow(gateway, agent))}</div>` : ''}
          ${ids.length > 8 ? html`<label class="tc-sk-search tc-gw-model-search" for="gw-model-search">${icon('search')}<input class="tc-input" id="gw-model-search" data-gw-inspect-field="query" data-key="gw-model-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search ${ids.length} models" aria-label="Search models"></label>` : ''}
          ${ids.length ? html`<ul class="tc-group tc-gw-models" data-key="gw-model-list">${shown.slice(0, MODEL_ROWS).map(entry => html`<li data-key="gw-model-${entry}"><code title="${entry}">${entry}</code>${gateway.models.manual.includes(entry) ? html`<span class="tc-badge">Added</span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-gw-inspect="unmanual" data-id="${entry}" aria-label="Remove ${entry}"${disabled(view.busy)}>${icon('x')}</button>` : ''}</li>`)}${shown.length > MODEL_ROWS ? html`<li class="tc-gw-models-more">${shown.length - MODEL_ROWS} more. Search to narrow this down.</li>` : ''}${!shown.length ? html`<li class="tc-gw-models-more">No models match.</li>` : ''}</ul>` : html`<p class="tc-hint">This gateway doesn’t list its models. Add the IDs you want to use.</p>`}
          ${connected.some(agent => agent.id === 'opencode') ? html`<p class="tc-hint">OpenCode restarts when its models change, which stops a turn running on it.</p>` : ''}
          <div class="tc-gw-manual"><input class="tc-input tc-gw-mono" id="gw-manual" data-gw-inspect-field="manualDraft" data-key="gw-manual" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Add a model ID" aria-label="Add a model ID">${action('manual', 'Add', { disabled: view.busy })}</div>
          ${view.error ? html`<p class="tc-hint tc-hint--err" role="alert">${view.error}</p>` : ''}
        </section>`;
      };
      const render = () => {
        const gateway = row(); if (!gateway) return '';
        return html`<div class="tc-insp-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('waypoints')}</span><div class="tc-insp-title"><h2 id="gw-inspect-title" title="${gateway.name}">${gateway.name}</h2><span class="tc-insp-meta">${gateway.host}</span></div>${action('edit', 'Edit', { icon: 'pencil', disabled: view.busy })}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-key="gw-insp-menu" data-gw-inspect="menu" aria-haspopup="menu" aria-label="More for ${gateway.name}"${disabled(view.busy)}>${icon('ellipsis')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-gw-inspect="close" aria-label="Close gateway details" data-initial-focus>${icon('x')}</button></div>
          <div class="tc-insp-body">${banner(gateway)}${connection(gateway)}${models(gateway)}</div>`;
      };
      view.layer = Kit.open({ kind: 'sheet', returnTo: document.activeElement, render,
        panel: { class: 'tc-sheet tc-skill-inspector tc-mcp-inspector tc-gw-inspector' + (Kit.isPhone() ? ' tc-sheet--bottom' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gw-inspect-title' },
        onClose: reason => { if (active === view) active = null; if (reason !== 'route' && location.hash === '#gateways/' + id) { history.replaceState(null, '', '#gateways'); ctx.inspectorClosed(); } } });
      const panel = view.layer.panel;
      const withBusy = async (name, work) => {
        view.busy = name; view.error = null; repaint();
        const response = await work().catch(() => null);
        view.busy = null;
        if (response && !response.ok) view.error = response.error;
        repaint();
        return response;
      };
      const saveManual = list => withBusy('manual', () => ctx.change(id + ':apply', '/gateways/save', { id, gateway: { manual: list } }));
      panel.addEventListener('input', event => {
        const name = event.target.dataset.gwInspectField;
        if (!name) return;
        view[name] = event.target.value;
        if (name === 'query') repaint();
      });
      panel.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target.id === 'gw-manual') { event.preventDefault(); panel.querySelector('[data-gw-inspect="manual"]')?.click(); }
      });
      panel.addEventListener('click', async event => {
        const button = event.target.closest('[data-gw-inspect]');
        if (!button || button.disabled) return;
        const gateway = row(), name = button.dataset.gwInspect;
        if (name === 'close') return close('close');
        if (!gateway) return;
        if (name === 'vault') return close('route');
        if (name === 'test') return void withBusy('test', () => ctx.testSaved(id).then(() => null));
        if (name === 'edit') { close('edit'); return void ctx.edit(id); }
        if (name === 'menu') return Kit.menu(button, { label: 'More for ' + gateway.name, head: gateway.name, items: [
          { label: 'Copy address', icon: 'copy', run: () => Kit.copy(gateway.url, button, 'Address copied') },
          { sep: true }, { label: 'Remove…', icon: 'trash-2', danger: true, run: () => ctx.remove(id) },
        ] });
        if (name === 'refresh') { const response = await withBusy('refresh', () => ctx.change(id + ':apply', '/gateways/models', { id })); if (response) ctx.reportFailures(response); return; }
        if (name === 'scope') { const response = await withBusy('scope', () => ctx.change(id + ':' + button.dataset.agent, '/gateways/agent', { id, agent: button.dataset.agent, connected: true, scope: button.dataset.scope })); if (response) ctx.reportFailures(response); return; }
        if (name === 'manual') {
          const entry = view.manualDraft.trim();
          if (!entry) return;
          if (gateway.models.manual.includes(entry) || gateway.models.ids.includes(entry)) { view.error = entry + ' is already listed.'; return repaint(); }
          const response = await saveManual([...gateway.models.manual, entry]);
          if (response?.ok) { view.manualDraft = ''; repaint(); }
          return;
        }
        if (name === 'unmanual') return void saveManual(gateway.models.manual.filter(entry => entry !== button.dataset.id));
      });
      sync();
    };
    return { open, close, repaint };
  };
  return { create };
})();
