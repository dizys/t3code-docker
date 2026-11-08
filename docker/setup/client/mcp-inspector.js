// One read-only inspector; credentials stay in memory until explicitly revealed.
const T3McpInspector = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3McpModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const valueText = value => value === undefined ? 'Not set' : Array.isArray(value) ? T3McpCommand.line(value) : String(value);
  const changed = (value, other) => {
    const text = valueText(value), peer = valueText(other);
    let first = 0, last = 0;
    while (first < text.length && first < peer.length && text[first] === peer[first]) first++;
    while (last < text.length - first && last < peer.length - first && text[text.length - last - 1] === peer[peer.length - last - 1]) last++;
    return html`${text.slice(0, first)}<mark>${text.slice(first, text.length - last)}</mark>${last ? text.slice(-last) : ''}`;
  };
  const create = ctx => {
    let active = null;
    const repaint = () => { if (active && !active.layer.closed) { active.layer.panel.classList.toggle('tc-sheet--bottom', Kit.isPhone()); active.layer.render();
      for (const select of active.layer.panel.querySelectorAll('[data-mcp-policy]')) { const id = select.dataset.mcpPolicy; if (!ctx.library().changing.has(id)) select.value = S.state(ctx.library().data, { name: active.name, shared: true }, id).kind; }
    } };
    const close = reason => { if (!active) return true; active.layer.close(reason); return true; };
    const open = async (name, focusProvider) => {
      close('replaced');
      const view = { name, server: null, revision: null, loading: true, error: null, differences: new Map(), revealed: new Set(), expanded: new Set(focusProvider ? [focusProvider] : []), generation: 0 };
      active = view;
      const current = () => ctx.library();
      const native = id => current().data?.providers?.find(p => p.provider === id);
      const sharedRow = () => ({ name, shared: true });
      const busy = id => current().changing.has(id);
      const validDiff = id => { const d = view.differences.get(id); return d && d.sharedRevision === view.revision && d.sharedRevision === current().data?.shared?.revision && d.providerRevision === native(id)?.revision; };
      const request = async () => {
        const generation = ++view.generation; view.loading = !view.server; view.refreshing = Boolean(view.server); view.error = null; repaint();
        const response = await ctx.api('/context/mcp/read?name=' + encodeURIComponent(name));
        if (active !== view || generation !== view.generation) return;
        view.loading = false; view.refreshing = false;
        if (!response.ok) { view.server = null; view.error = response.error; repaint(); return; }
        view.server = response.data.server; view.revision = response.data.revision; view.differences.clear(); repaint();
        await Promise.allSettled(current().managed.filter(p => native(p.id)?.diverged?.includes(name)).map(async p => {
          const diff = await ctx.api('/context/mcp/diff?provider=' + p.id + '&name=' + encodeURIComponent(name));
          if (active !== view || generation !== view.generation) return;
          view.differences.set(p.id, diff.ok ? diff.data : { error: diff.error }); repaint();
        }));
      };
      const diffBox = p => {
        const diff = view.differences.get(p.id);
        if (!diff) return html`<div class="tc-diff"><p class="tc-mcp-diff-loading" role="status"><span class="tc-spinner"></span>Reading differences…</p></div>`;
        if (diff.error || !validDiff(p.id)) return html`<div class="tc-diff"><div class="tc-mcp-diff-loading"><span>${diff.error || 'Settings changed while you were reviewing. Reload to see the current differences.'}</span><button class="tc-btn tc-btn--sm" type="button" data-mcp-inspect="reload">Reload</button></div></div>`;
        return html`<div class="tc-diff">${diff.fields.map(field => html`<div class="tc-diff-row"><span class="tc-diff-label">${S.fieldLabel(field.field)}</span>${field.secret ? html`<div><code>${field.key}</code><p class="tc-hint">Values differ. Secret values aren’t shown side by side.</p></div>` : html`<div class="tc-diff-vals"><span class="tc-diff-who">Shared</span><code>${changed(field.shared, field.agent)}</code><span class="tc-diff-who">${p.name}</span><code>${changed(field.agent, field.shared)}</code></div>`}</div>`)}${diff.extraOptions?.length ? html`<div class="tc-diff-row"><span class="tc-diff-label">Native options</span><span>Only in ${p.name}: <code>${diff.extraOptions.join(', ')}</code>. Updating removes these options.</span></div>` : ''}<div class="tc-diff-foot"><span class="tc-hint" title="A private backup is kept beside ${native(p.id)?.path}">Backup kept</span><button class="tc-btn tc-btn--sm" type="button" data-mcp-inspect="adopt" data-provider="${p.id}"${disabled(busy(p.id) || !diff.adoptable)}>Make this the shared one…</button><button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-mcp-inspect="update" data-provider="${p.id}"${disabled(busy(p.id))}>${busy(p.id) ? html`<span class="tc-spinner"></span>Updating` : 'Update to shared'}</button></div></div>`;
      };
      const agentRows = () => html`<section class="tc-insp-section"><div class="tc-insp-label">Used by<span class="tc-spacer"></span><span class="tc-hint">${S.used(current().data, sharedRow(), current().installed).length} of ${current().managed.length} agents</span></div><div class="tc-group tc-avail">${current().managed.map(p => {
        const state = S.state(current().data, sharedRow(), p.id), differs = state.kind === 'differs', added = ['on', 'off', 'differs'].includes(state.kind);
        const expanded = !Kit.isPhone() || view.expanded.has(p.id), pending = current().changing.get(p.id) === name;
        return html`<div class="tc-avail-row${differs && expanded ? ' tc-avail-row--open' : ''}" data-key="mcp-inspect-${p.id}" data-reach="${added ? 'yes' : 'none'}">${ctx.mark(p.id)}<div class="tc-row-main"><span class="tc-avail-name">${p.name}${differs ? html` <span class="tc-badge tc-badge--warn">Differs</span>` : ''}</span><span class="tc-avail-note">${state.reason || (differs ? 'Its copy doesn’t match the shared server' : added ? 'Matches the shared server' : 'Not added')}</span></div>
          ${pending ? html`<span class="tc-spinner" role="status" aria-label="Saving ${p.name}"></span>` : state.kind === 'error' ? '' : differs ? html`<span class="tc-mcp-inspect-actions">${Kit.isPhone() ? html`<button class="tc-btn tc-btn--sm" type="button" data-mcp-inspect="review" data-provider="${p.id}" aria-expanded="${String(expanded)}">${expanded ? 'Hide differences' : 'Review'}</button>` : ''}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-mcp-inspect="remove" data-provider="${p.id}" aria-label="Remove ${name} from ${p.name}"${disabled(busy(p.id))}>${icon('trash-2')}</button></span>` : added && p.canDisable ? html`<select class="tc-select tc-select--sm" data-key="mcp-inspect-policy-${p.id}" data-mcp-policy="${p.id}" aria-label="${name} in ${p.name}"${disabled(busy(p.id))}><option value="on"${state.kind === 'on' ? raw(' selected') : ''}>On</option><option value="off"${state.kind === 'off' ? raw(' selected') : ''}>Off</option><option value="remove">Remove from ${p.name}</option></select>` : added ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-mcp-inspect="remove" data-provider="${p.id}" aria-label="Remove ${name} from ${p.name}"${disabled(busy(p.id))}>${icon('trash-2')}</button>` : html`<span class="tc-mcp-inspect-actions"><button class="tc-btn tc-btn--sm" type="button" data-mcp-inspect="add" data-provider="${p.id}"${disabled(busy(p.id) || current().data?.shared?.error)}>${icon('plus')}Add to ${p.name}</button>${ctx.undos.get(p.id)?.name === name ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-mcp-inspect="undo" data-provider="${p.id}">Undo</button>` : ''}</span>`}
          ${differs && expanded ? diffBox(p) : ''}</div>`;
      })}</div><p class="tc-hint">Each agent reads its own copy when a session starts.</p></section>`;
      const connection = () => {
        const server = view.server, remote = server.type === 'remote', pairs = Object.entries(remote ? server.headers || {} : server.env || {});
        return html`<section class="tc-insp-section"><h3 class="tc-insp-label">Connection</h3><dl class="tc-group tc-pathlist tc-mcp-connection"><dt>Transport</dt><dd>${remote ? 'Streamable HTTP' : 'Command'}</dd><dt>${remote ? 'URL' : 'Command'}</dt><dd>${remote ? html`<code>${server.url}</code>` : html`<span class="tc-argv">${server.command.map((part, index) => html`<span class="tc-arg${index === 0 ? ' tc-arg--exe' : ''}" title="${part}">${part || '""'}</span>`)}</span>`}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-mcp-inspect="copy" aria-label="Copy ${remote ? 'URL' : 'command'}">${icon('copy')}</button></dd>${pairs.map(([key, value], index) => html`<dt>${remote ? 'Header' : 'Variable'}</dt><dd data-key="mcp-secret-${index}"><code>${key}</code><span class="tc-mcp-secret-value${view.revealed.has(key) ? '' : ' tc-secret-val'}">${view.revealed.has(key) ? value : '••••••••••••'}</span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-mcp-inspect="reveal" data-index="${index}" aria-label="${view.revealed.has(key) ? 'Hide' : 'Reveal'} ${key}" aria-pressed="${String(view.revealed.has(key))}">${icon(view.revealed.has(key) ? 'eye-off' : 'eye')}</button></dd>`)}</dl></section>`;
      };
      const signIn = () => view.server.type !== 'remote' ? '' : html`<section class="tc-insp-section"><div class="tc-insp-label">Sign-in<span class="tc-spacer"></span><span class="tc-hint">Not shared between agents</span></div><ul class="tc-group tc-signin">${current().managed.filter(p => S.has(native(p.id), name) && signInCommand(p.id, name)).map(p => html`<li>${ctx.mark(p.id)}<code>${signInCommand(p.id, name)}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-mcp-inspect="signin" data-provider="${p.id}" aria-label="Copy ${p.name} sign-in command">${icon('copy')}</button></li>`)}</ul><p class="tc-hint">Only needed when ${name} asks to sign in. Run it in a T3 Code terminal. Grok, Pi and Antigravity also offer sign-in in their native MCP menu.</p></section>`;
      view.layer = Kit.open({ kind: 'sheet', returnTo: document.activeElement, panel: { class: 'tc-sheet tc-skill-inspector tc-mcp-inspector' + (Kit.isPhone() ? ' tc-sheet--bottom' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mcp-inspect-title' },
        focus: '[data-mcp-inspect="close"]', backdrop: 'ignore', onEscape: () => close('escape'), onClose: () => { view.revealed.clear(); view.differences.clear(); view.server = null; if (active === view) active = null; },
        render: () => html`<div class="tc-insp-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(view.server?.type === 'remote' ? 'globe' : 'terminal')}</span><div class="tc-insp-title"><h2 id="mcp-inspect-title">${name}</h2><span class="tc-insp-meta">${view.refreshing ? html`<span class="tc-spinner" aria-label="Refreshing server"></span>` : ''}Shared server${view.server ? ' · ' + (view.server.type === 'remote' ? 'Remote' : 'Local') + ' · ' + M.plural(Object.keys(view.server.headers || view.server.env || {}).length, view.server.type === 'remote' ? 'header' : 'variable') : ''}</span></div><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-mcp-inspect="menu" aria-label="Server actions" data-mcp-menu-head>${icon('ellipsis')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-mcp-inspect="close" aria-label="Close server inspector">${icon('x')}</button></div><div class="tc-insp-body" aria-busy="${String(view.loading)}">${view.error ? html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><strong>Couldn’t read ${name}</strong><p>${view.error}</p></div><button class="tc-btn tc-btn--sm" type="button" data-mcp-inspect="reload">Try again</button></div>` : view.loading ? html`<p class="tc-hint" role="status"><span class="tc-spinner"></span>Reading server…</p>` : view.server ? html`${[...ctx.mutationErrors.values()].filter(e => e.name === name).map(error => html`<div class="tc-notice tc-notice--danger" role="alert"><div class="tc-notice-body"><strong>${error.title}</strong><span class="tc-notice-desc">${error.error}</span></div></div>`)}${agentRows()}${connection()}${signIn()}<section class="tc-insp-section"><h3 class="tc-insp-label">Where it’s saved</h3><code class="tc-mcp-path">${ctx.pathLabel(current().data?.shared?.path || '~/.t3/setup/mcp/servers.json')}</code><p class="tc-hint">Backups: Beside each agent’s settings file when it changes. They hold secret values.</p></section>` : ''}</div><div class="tc-sheet-foot tc-insp-foot"><button class="tc-btn tc-btn--icon tc-mcp-phone-menu" type="button" data-mcp-inspect="menu" aria-label="Server actions">${icon('ellipsis')}</button><button class="tc-btn tc-btn--danger tc-mcp-inspector-remove" type="button" data-mcp-inspect="delete"${disabled(!view.server || view.loading || current().changing.size)}>Remove…</button><span class="tc-spacer"></span><button class="tc-btn tc-btn--sm" type="button" data-mcp-inspect="edit"${disabled(!view.server || view.loading || current().changing.size)}>${icon('pencil')}Edit server…</button></div>` });
      view.layer.panel.addEventListener('click', async event => {
        const button = event.target.closest('[data-mcp-inspect]'); if (!button || button.disabled) return;
        const action = button.dataset.mcpInspect, id = button.dataset.provider;
        if (action === 'close') { close('close'); return; }
        if (action === 'reload') { await ctx.refresh(); if (active === view) await request(); return; }
        if (action === 'review') { if (view.expanded.has(id)) view.expanded.delete(id); else view.expanded.add(id); repaint(); return; }
        if (action === 'reveal') { const key = Object.keys(view.server.headers || view.server.env || {})[Number(button.dataset.index)]; if (view.revealed.has(key)) view.revealed.delete(key); else view.revealed.add(key); repaint(); return; }
        if (action === 'undo') { const undo = ctx.undos.get(id); if (undo?.name === name) await undo.run(); if (active === view) await request(); return; }
        if (action === 'copy') { Kit.copy(view.server.type === 'remote' ? view.server.url : T3McpCommand.line(view.server.command), button); return; }
        if (action === 'signin') { Kit.copy(signInCommand(id, name), button, 'Sign-in command copied'); return; }
        if (action === 'edit') { await ctx.edit(name); return; }
        if (action === 'delete') { await ctx.remove(name); return; }
        if (action === 'adopt') { await ctx.share(name, id, true); return; }
        if (action === 'menu') { Kit.menu(button, { label: name + ' actions', items: [
          { label: view.server?.type === 'remote' ? 'Copy URL' : 'Copy command', icon: 'copy', disabled: !view.server, run: () => Kit.copy(view.server.type === 'remote' ? view.server.url : T3McpCommand.line(view.server.command), button) },
          { sep: true }, { label: 'Remove…', icon: 'trash-2', danger: true, disabled: !view.server, run: () => ctx.remove(name) },
        ] }); return; }
        const diff = view.differences.get(id);
        await ctx.change(id, name, action !== 'remove', action === 'update' ? { reviewed: true, sharedRevision: diff.sharedRevision, providerRevision: diff.providerRevision } : {});
        if (active === view) await request();
      });
      view.layer.panel.addEventListener('change', async event => {
        const id = event.target.dataset.mcpPolicy; if (!id) return;
        const value = event.target.value;
        await ctx.change(id, name, value !== 'remove', value === 'remove' ? {} : { enabled: value === 'on' });
        if (active === view) { await request(); const select = view.layer.panel.querySelector('[data-mcp-policy="' + id + '"]'); if (select) select.value = S.state(current().data, sharedRow(), id).kind; }
      });
      await request();
    };
    return { open, close, repaint, restoreFocus: provider => {
      if (!active || document.activeElement !== document.body && document.activeElement !== active.layer.panel) return;
      const panel = active.layer.panel;
      (panel.querySelector('[data-mcp-policy="' + CSS.escape(provider) + '"]') || panel.querySelector('[data-mcp-inspect="add"][data-provider="' + CSS.escape(provider) + '"]') || panel.querySelector('[data-mcp-inspect="close"]'))?.focus({ preventScroll: true });
    } };
  };
  const signInCommand = (id, name) => ({ claude: 'claude mcp login ', codex: 'codex mcp login ', opencode: 'opencode mcp auth ', cursor: 'cursor-agent mcp login ', muse: 'muse mcp login ', pi: 'pi mcp login ' }[id] || '') + (['claude', 'codex', 'opencode', 'cursor', 'muse', 'pi'].includes(id) ? name : '');
  return { create, changed, signInCommand };
})();
