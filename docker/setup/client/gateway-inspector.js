// One gateway in full: its agents, how it's reached, its limits, and each model with
// the agents that get it.
const T3GatewayInspector = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3GatewayModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const MODEL_ROWS = 120;

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
      const agentTile = agentId => html`<span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(agentId))}</span>`;

      const banner = gateway => {
        const state = S.gatewayState(gateway, Date.now(), M.relTime), check = gateway.check;
        return html`<div class="tc-cred-result"><div class="tc-cred-banner" data-tone="${state.tone === 'info' ? '' : state.tone}" role="status">${state.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>` : icon(state.tone === 'ok' ? 'circle-check' : state.tone ? 'circle-alert' : 'circle-dashed')}<div class="tc-cred-banner-text"><strong>${state.label}</strong>${[check?.ok === false ? check.hint : state.desc].filter(Boolean).map(line => html`<span>${line}</span>`)}</div>${view.busy === 'test' ? html`<span class="tc-spinner" aria-hidden="true"></span>` : html`${check?.code === 'unauthorized' ? action('replace-key', 'Replace key…') : ''}${action('test', check?.ok === false ? 'Test again' : 'Test')}`}</div></div>`;
      };

      // ---- agents ------------------------------------------------------------------
      const agentRow = (gateway, agent) => {
        const meta = S.agentOf(agent.id), state = S.agentState(agent), present = ctx.installed(agent.id), blocked = !agent.connected && (!agent.offered || !present), key = gateway.id + ':' + agent.id, pending = ctx.isBusy(key) || ctx.isBusy(gateway.id + ':apply');
        const note = !agent.connected ? !present ? 'Not installed' : !agent.offered ? 'This gateway has no ' + S.protocolShort(meta.protocol) : 'Not using this gateway' : agent.state === 'ready' ? S.models(agent.models) + ' · ' + S.protocolShort(meta.protocol) : state.label;
        return html`<div class="tc-gw-agent" data-key="gw-insp-agent-${agent.id}" data-off="${String(!agent.connected)}" data-tone="${agent.connected && state.tone !== 'ok' ? state.tone : ''}">
          ${agentTile(agent.id)}
          <span class="tc-row-main"><span class="tc-avail-name">${agent.connected ? agent.displayName : meta.name}</span><span class="tc-avail-note" title="${agent.detail || ''}">${note}</span></span>
          ${agent.connected && agent.id !== 'opencode' ? html`<div class="tc-seg" role="group" aria-label="Models for ${meta.name}">${[['compatible', 'Compatible'], ['all', 'All']].map(([scope, label]) => html`<button type="button" data-key="gw-scope-${agent.id}-${scope}" data-gw-inspect="scope" data-agent="${agent.id}" data-scope="${scope}" aria-pressed="${String((agent.scope || 'compatible') === scope)}"${disabled(pending)}>${label}</button>`)}</div>` : ''}
          ${pending ? html`<span class="tc-spinner" aria-hidden="true"></span>` : html`<button class="tc-switch" type="button" role="switch" data-key="gw-switch-${agent.id}" aria-checked="${String(agent.connected)}" aria-label="Use ${gateway.name} for ${meta.name}" data-gw-inspect="toggle" data-agent="${agent.id}"${disabled(blocked)}></button>`}
        </div>`;
      };
      const agents = gateway => html`<section class="tc-insp-section" data-key="gw-agents"><h3 class="tc-insp-label">Agents</h3><div class="tc-group tc-gw-agents">${gateway.agents.map(agent => agentRow(gateway, agent))}</div>${gateway.agents.some(agent => agent.connected && agent.id !== 'opencode') ? html`<p class="tc-hint">Compatible shows the models an agent is made for. All shows everything this gateway offers, for one that translates between formats.</p>` : ''}</section>`;

      // ---- connection --------------------------------------------------------------
      const protocols = gateway => Object.entries(gateway.check?.protocols || {}).map(([protocol, state]) => html`<li data-tone="${state === 'available' ? 'ok' : state === 'missing' ? 'muted' : 'warn'}">${icon(state === 'available' ? 'check' : state === 'missing' ? 'x' : 'triangle-alert')}<span>${S.protocolName(protocol)}</span></li>`);
      const keyLine = gateway => gateway.key.state === 'none' ? 'None' : gateway.key.state === 'missing'
        ? html`<span class="tc-warnline">${gateway.key.credentialId} is no longer in the Vault</span>`
        : html`<a class="tc-cred-link" href="#vault/${gateway.key.credentialId}" data-gw-inspect="vault" data-key="gw-insp-vault">${gateway.key.credentialId}</a>`;
      const connection = gateway => html`<section class="tc-insp-section" data-key="gw-connection"><h3 class="tc-insp-label">Connection</h3><dl class="tc-group tc-pathlist tc-gw-facts">
        <dt>Address</dt><dd><code>${gateway.url}</code></dd>
        ${S.presetOf(gateway.preset)?.id !== 'custom' ? html`<dt>Type</dt><dd>${S.presetOf(gateway.preset)?.name}</dd>` : ''}
        <dt>API key</dt><dd class="tc-gw-keyline"><span>${keyLine(gateway)}</span>${action('replace-key-row', 'Replace…', { ghost: true })}</dd>
        ${gateway.check?.ms ? html`<dt>Latency</dt><dd>${gateway.check.ms} ms</dd>` : ''}
        ${protocols(gateway).length ? html`<dt>Offers</dt><dd><ul class="tc-gw-routes">${protocols(gateway)}</ul></dd>` : ''}
      </dl></section>`;

      // ---- limits ------------------------------------------------------------------
      const account = entry => html`<li class="tc-gw-account" data-key="gw-account-${entry.id}">${agentTile(entry.driver === 'codex' ? 'codex' : 'claude')}<span class="tc-row-main"><span class="tc-avail-name" title="${entry.email || ''}">${entry.email || entry.id}</span><span class="tc-avail-note">${S.windowsLine(entry) || entry.plan || ''}</span></span></li>`;
      const limits = gateway => {
        const held = gateway.limits;
        if (!held?.supported) return '';
        const state = S.limitsState(held), off = held.state === 'off', busy = ctx.isBusy(gateway.id + ':limits');
        return html`<section class="tc-insp-section" data-key="gw-limits"><h3 class="tc-insp-label">Usage limits<span class="tc-spacer"></span>${held.checkedAt ? html`<span class="tc-hint">Read ${M.relTime(held.checkedAt, Date.now())}</span>` : ''}${!off && held.owned ? action('replace-limits', 'Replace key…', { ghost: true }) : ''}</h3>
          ${off ? html`<div class="tc-group tc-gw-limits-empty"><span class="tc-tile tc-tile--icon tc-tile--xs" aria-hidden="true">${icon('gauge')}</span><span class="tc-row-main"><span class="tc-avail-name">See what’s left on each account</span><span class="tc-avail-note">Shows this gateway’s Claude and Codex quota under Usage → Limits in T3 Code. Needs its management key.</span></span>${action('setup-limits', 'Set up…')}</div>`
            : html`<div class="tc-group tc-gw-limits">
              ${held.accounts.length ? html`<ul class="tc-gw-accounts">${held.accounts.map(account)}</ul>` : html`<p class="tc-gw-limits-note">${state.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>` : ''}${state.desc || state.label}</p>`}
              <div class="tc-card-foot">${held.owned ? html`<span>Shown in T3 Code under Usage → Limits.</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-key="gw-insp-remove-limits" data-gw-inspect="remove-limits"${disabled(busy)}>Stop showing</button>` : html`<span>Set up in T3 Code’s settings, so that’s where it changes.</span>`}</div>
            </div>`}
        </section>`;
      };

      // ---- models ------------------------------------------------------------------
      const modelRow = (gateway, entry) => {
        const users = gateway.agents.filter(agent => agent.connected && agent.modelIds?.includes(entry)), manual = gateway.models.manual.includes(entry);
        return html`<li data-key="gw-model-${entry}"><code title="${entry}">${entry}</code>${manual ? html`<span class="tc-badge">Added</span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-key="gw-unmanual-${entry}" data-gw-inspect="unmanual" data-id="${entry}" aria-label="Remove ${entry}">${icon('x')}</button>` : ''}<span class="tc-agent-stack" title="${users.length ? 'In the picker for ' + S.listOf(users.map(agent => S.agentOf(agent.id).name)) : 'Not in any agent’s picker'}">${users.map(agent => agentTile(agent.id))}</span></li>`;
      };
      const models = gateway => {
        const ids = [...gateway.models.ids, ...gateway.models.manual.filter(entry => !gateway.models.ids.includes(entry))], text = view.query.trim().toLowerCase();
        const matched = text ? ids.filter(entry => entry.toLowerCase().includes(text)) : ids, fresh = S.newModels(gateway), capped = matched.slice(0, MODEL_ROWS);
        return html`<section class="tc-insp-section" data-key="gw-models"><h3 class="tc-insp-label">Models<span class="tc-spacer"></span><span class="tc-hint">${gateway.models.at ? 'Read ' + M.relTime(gateway.models.at, Date.now()) : 'Added by hand'}</span>${action('refresh', view.busy === 'refresh' ? 'Refreshing…' : 'Refresh', { ghost: true, icon: 'refresh-cw', disabled: view.busy === 'refresh' })}</h3>
          ${fresh.added.length || fresh.removed.length || fresh.changed?.length ? html`<p class="tc-hint tc-gw-fresh" role="status">${icon('sparkles', 'tc-icon--sm')}<span>${[fresh.added.length ? S.plural(fresh.added.length, 'new model') : '', fresh.removed.length ? fresh.removed.length + ' fewer' : '', fresh.changed?.length ? S.plural(fresh.changed.length, 'updated model') : ''].filter(Boolean).join(' and ')} since this was read. Refresh to apply.</span></p>` : ''}
          ${ids.length > 8 ? html`<label class="tc-sk-search tc-gw-model-search" for="gw-model-search">${icon('search')}<input class="tc-input" id="gw-model-search" data-gw-inspect-field="query" data-key="gw-model-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search ${ids.length} models" aria-label="Search models"></label>` : ''}
          ${ids.length ? capped.length ? html`<div class="tc-gw-model-groups" data-key="gw-model-list">${S.modelGroups(capped).map(group => html`<div class="tc-group" data-key="gw-family-${group.name}"><div class="tc-gw-family"><span>${group.name}</span><span>${group.models.length}</span></div><ul class="tc-gw-models">${group.models.map(entry => modelRow(gateway, entry))}</ul></div>`)}</div>${matched.length > capped.length ? html`<p class="tc-hint">Showing ${capped.length} of ${matched.length}. Search to narrow them down.</p>` : ''}` : html`<p class="tc-hint">No models match.</p>` : html`<p class="tc-hint">This gateway doesn’t list its models. Add the ones you use.</p>`}
          ${gateway.agents.some(agent => agent.connected && ['opencode', 'pi', 'grok'].includes(agent.id)) ? html`<p class="tc-hint">OpenCode, Pi and Grok restart when their models or reasoning options change, which stops a turn running on them.</p>` : ''}
          <div class="tc-gw-manual"><input class="tc-input tc-input--mono" id="gw-manual" data-gw-inspect-field="manualDraft" data-key="gw-manual" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Add a model ID" aria-label="Add a model ID">${action('manual', 'Add', { disabled: view.busy === 'manual' })}</div>
        </section>`;
      };

      const render = () => {
        const gateway = row(); if (!gateway) return '';
        const added = gateway.createdAt ? 'added ' + M.relTime(gateway.createdAt, Date.now()) : '', type = S.presetOf(gateway.preset)?.id === 'custom' ? '' : S.presetOf(gateway.preset)?.name;
        return html`<div class="tc-insp-head">${ctx.tile(gateway)}<div class="tc-insp-title"><h2 id="gw-inspect-title" title="${gateway.name}">${gateway.name}</h2><span class="tc-insp-meta">${[type, added].filter(Boolean).join(' · ') || gateway.host}</span></div>
          <div class="tc-insp-actions">${action('edit', 'Edit', { icon: 'pencil' })}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-key="gw-insp-menu" data-gw-inspect="menu" aria-label="More for ${gateway.name}" aria-haspopup="menu">${icon('ellipsis')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-key="gw-insp-close" data-gw-inspect="close" aria-label="Close">${icon('x')}</button></div></div>
          <div class="tc-insp-body">${view.error ? html`<div class="tc-notice tc-notice--danger" role="alert" data-key="gw-insp-error">${icon('circle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">That didn’t finish</strong><span class="tc-notice-desc">${view.error}</span></div></div>` : ''}${banner(gateway)}${agents(gateway)}${connection(gateway)}${limits(gateway)}${models(gateway)}</div>`;
      };
      view.layer = Kit.open({ kind: 'sheet', returnTo: document.activeElement, render,
        panel: { class: 'tc-sheet tc-skill-inspector tc-mcp-inspector tc-gw-inspector' + (Kit.isPhone() ? ' tc-sheet--bottom' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gw-inspect-title' },
        // However it closed, the link is unused again: a navigation can close what the link opened.
        onClose: reason => { if (active === view) active = null; ctx.inspectorClosed(); if (reason !== 'route' && location.hash === '#gateways/' + id) history.replaceState(null, '', '#gateways'); } });
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
        if (name === 'replace-key' || name === 'replace-key-row') { close('edit'); return void ctx.replaceKey(id); }
        if (name === 'setup-limits' || name === 'replace-limits') { close('edit'); return void ctx.edit(id, { limits: true }); }
        if (name === 'remove-limits') return void ctx.removeLimits(id);
        // Toasts stay hidden behind this panel, so what goes wrong here is said here.
        if (name === 'toggle') return void withBusy('toggle', () => ctx.toggle(id, button.dataset.agent, button.getAttribute('aria-checked') !== 'true'));
        if (name === 'scope') { if (button.getAttribute('aria-pressed') !== 'true') void withBusy('scope', () => ctx.scope(id, button.dataset.agent, button.dataset.scope)); return; }
        if (name === 'menu') return Kit.menu(button, { label: 'More for ' + gateway.name, head: gateway.name, items: [
          { label: 'Copy address', icon: 'copy', run: () => Kit.copy(gateway.url, button, 'Address copied') },
          { sep: true }, { label: 'Remove…', icon: 'trash-2', danger: true, run: () => ctx.remove(id) },
        ] });
        if (name === 'refresh') { const response = await withBusy('refresh', () => ctx.change(id + ':apply', '/gateways/models', { id })); if (response) ctx.reportFailures(response); return; }
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
