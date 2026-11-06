// Adding or changing a gateway. A key typed here stays in this form until it is
// saved, and a saved key never comes back: the server only ever says which Vault
// credential holds it.
//
//   connect  where it is and how to sign in, tested before moving on
//   agents   which agents use it, and exactly what that will change
//   done     the agents starting up, followed live
const T3GatewayEditor = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3GatewayModel;
  const disabled = value => value ? raw(' disabled') : '';
  const STEPS = [['connect', 'Connect'], ['agents', 'Agents']];

  const create = ctx => {
    let active = null;
    const close = reason => active ? active.close(reason) : Promise.resolve(true);

    const open = async (gateway, { replaceKey = false } = {}) => {
      if (!await close('replaced')) return;
      const editing = Boolean(gateway), preset = S.presetOf(gateway?.preset) || S.presets()[0];
      const view = {
        step: 'connect', editing, id: gateway?.id || null, busy: null, result: null, error: null, errors: {},
        preset: preset.id,
        url: gateway?.url ?? preset.url, urlTouched: false,
        name: gateway?.name ?? '', nameTouched: editing,
        // A key deleted from the Vault can't be shown as saved: ask for a new one.
        key: '', keySource: editing && gateway.key.state === 'saved' ? 'saved' : 'type', credentialId: gateway?.key?.credentialId ?? null,
        replacing: replaceKey, closing: false,
        agents: new Set(), agentsTouched: false,
        createdId: null, results: null,
      };
      if (replaceKey) view.keySource = 'type';
      active = view;
      const original = JSON.stringify([view.url, view.name]);

      const presetNow = () => S.presetOf(view.preset);
      const suggested = () => {
        if (presetNow()?.id !== 'custom') return presetNow()?.name || '';
        try { return new URL(/^[a-z]+:\/\//i.test(view.url) ? view.url : 'http://' + view.url).hostname.split('.').slice(-2, -1)[0] || ''; } catch { return ''; }
      };
      const nameNow = () => view.name.trim() || suggested();
      const dirty = () => view.step !== 'done' && (Boolean(view.key) || JSON.stringify([view.url, view.name]) !== original && (editing || view.urlTouched || view.nameTouched));
      // Nothing typed leaves the saved key in place, on the server's side.
      const keyNow = () => view.keySource === 'vault' ? { credentialId: view.credentialId } : view.keySource === 'type' && view.key.trim() ? { key: view.key.trim() } : {};
      const keyed = () => view.keySource !== 'type' || Boolean(view.key.trim()) || gateway?.key.state === 'saved';

      const paint = () => { if (active !== view || view.layer?.closed) return; view.layer.render(); sync(); };
      view.repaint = paint;
      const sync = () => {
        for (const input of view.layer.panel.querySelectorAll('[data-gw-field]')) {
          const value = view[input.dataset.gwField] ?? '';
          if (input.value !== String(value)) input.value = value;
        }
        const name = view.layer.panel.querySelector('#gw-name');
        if (name) name.placeholder = suggested() || 'My gateway';
      };
      view.close = async reason => {
        if (view.busy) { Kit.announce('Wait for this to finish.'); return false; }
        if (dirty()) {
          view.closing = true;
          const yes = await Kit.confirm({ title: 'Discard this gateway?', body: 'What you’ve entered hasn’t been saved.', confirm: 'Discard', tone: 'danger' });
          view.closing = false;
          if (!yes || active !== view) return false;
        }
        view.layer.close(reason);
        return true;
      };
      const beforeUnload = event => { if (view.busy || dirty()) { event.preventDefault(); event.returnValue = ''; } };
      window.addEventListener('beforeunload', beforeUnload);

      // ---- connect ---------------------------------------------------------------
      const resultChanged = () => { view.result = null; view.errors = {}; view.error = null; };
      const pickPreset = id => {
        if (view.preset === id) return;
        const previous = S.presetOf(view.preset), next = S.presetOf(id);
        view.preset = id;
        // Only replace an address that came from the last preset.
        if (!view.urlTouched || view.url === (previous?.url ?? '')) { view.url = next.url; view.urlTouched = false; }
        resultChanged(); paint();
        view.layer.panel.querySelector('#gw-url')?.focus({ preventScroll: true });
      };
      const runTest = async () => {
        if (view.busy) return null;
        view.busy = 'test'; view.result = null; view.errors = {}; view.error = null; paint();
        const response = await ctx.api('/gateways/test', { body: { url: view.url, ...keyNow(), ...(view.id ? { id: view.id } : {}) } });
        view.busy = null;
        if (active !== view) return null;
        if (!response.ok) {
          const field = response.data?.field;
          if (field) view.errors[field] = response.error; else view.error = response.error;
          paint();
          view.layer.panel.querySelector(field === 'key' ? '#gw-key' : '#gw-url')?.focus({ preventScroll: true });
          return null;
        }
        const result = response.data.result;
        view.result = result;
        if (result.url) view.url = result.url;
        if (result.ok && !editing && !view.agentsTouched) preselect(result);
        paint();
        // On a phone the answer lands below the fold, and a button that seems to do nothing gets pressed again.
        view.layer.panel.querySelector('[data-key="gw-outcome"]')?.scrollIntoView({ block: 'nearest', behavior: Kit.REDUCED.matches ? 'auto' : 'smooth' });
        return result;
      };
      const preselect = result => {
        view.agents = new Set(S.agents().filter(agent => ctx.installed(agent.id) && S.availability(agent, result).usable).map(agent => agent.id));
      };
      const advance = async () => {
        // A new name needs no test: only the address and key decide whether it connects.
        if (editing && !connectionChanged()) return saveEdit();
        const result = view.result ?? await runTest();
        if (!result?.ok) return;
        if (editing) return saveEdit();
        view.step = 'agents'; paint();
        view.layer.panel.querySelector('.tc-gw-pick .tc-switch:not(:disabled)')?.focus({ preventScroll: true });
      };
      const saveEdit = async () => {
        if (view.busy) return;
        view.busy = 'save'; view.error = null; paint();
        const response = await ctx.api('/gateways/save', { body: { id: view.id, revision: ctx.revision(), gateway: { url: view.url, name: nameNow() }, ...keyNow() } });
        view.busy = null;
        if (active !== view) return;
        if (!response.ok) { view.error = response.error; paint(); if (response.data?.code === 'conflict') await ctx.reload(); return; }
        ctx.accepted(response.data); ctx.reportFailures(response);
        view.key = '';
        view.layer.close('saved');
        Kit.toast('Saved ' + nameNow());
      };
      const connectionChanged = () => view.url.trim() !== gateway.url || Boolean(view.key.trim()) || keySourceChanged();
      const keySourceChanged = () => editing && (view.keySource === 'vault' && view.credentialId !== gateway.key.credentialId);
      const changedAtAll = () => connectionChanged() || view.name.trim() !== gateway.name;
      const restarts = () => editing && connectionChanged() && gateway.agents.some(agent => agent.connected);
      const useSuggestion = url => { view.url = url; view.urlTouched = true; resultChanged(); paint(); void runTest(); };
      const pickSavedKey = button => {
        const keys = ctx.keys();
        Kit.menu(button, { label: 'Saved keys', head: 'Saved in the Vault', items: [
          ...keys.map(entry => ({ label: entry.id, icon: 'key-round', run: () => { view.keySource = 'vault'; view.credentialId = entry.id; view.key = ''; resultChanged(); paint(); } })),
        ] });
      };

      const field = (id, label, input, hint, error) => html`<div class="tc-form-field" data-key="gw-field-${id}"><label class="tc-label" for="gw-${id}">${label}</label>${input}${error ? html`<p class="tc-hint tc-hint--err" role="alert">${error}</p>` : hint ? html`<p class="tc-hint">${hint}</p>` : ''}</div>`;
      const presetPicker = () => html`<div class="tc-gw-presets" role="radiogroup" aria-label="Gateway type" data-key="gw-presets">${S.presets().map(preset => html`<button class="tc-gw-preset" type="button" role="radio" aria-checked="${String(view.preset === preset.id)}" data-key="gw-preset-${preset.id}" data-gw-editor="preset" data-id="${preset.id}"><b>${preset.name}</b><small>${preset.blurb}</small></button>`)}</div>`;
      const addressField = () => field('url', 'Address',
        html`<input class="tc-input tc-gw-mono" id="gw-url" data-gw-field="url" data-key="gw-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="http://gateway:8317"${view.errors.url ? raw(' aria-invalid="true"') : ''}>`,
        view.result?.notes?.[0] || 'Agents reach it from inside this container.', view.errors.url);
      const keyField = () => {
        const saved = view.keySource === 'saved' || view.keySource === 'vault';
        const hint = presetNow()?.keyHint;
        const keys = ctx.keys();
        const head = html`<div class="tc-gw-label-row"><label class="tc-label" for="gw-key">API key</label>${keys.length && !saved ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-key="gw-saved-keys" data-gw-editor="saved-keys" aria-haspopup="menu">${icon('key-round')}Use a saved key</button>` : ''}</div>`;
        if (saved) return html`<div class="tc-form-field" data-key="gw-field-key">${head}<div class="tc-gw-saved"><span>${icon('lock')}Saved in the Vault as <code>${view.credentialId}</code></span><span class="tc-spacer"></span><button class="tc-btn tc-btn--xs" type="button" data-key="gw-key-replace" data-gw-editor="replace-key">Replace</button></div>${view.errors.key ? html`<p class="tc-hint tc-hint--err" role="alert">${view.errors.key}</p>` : ''}</div>`;
        return html`<div class="tc-form-field" data-key="gw-field-key">${head}<input class="tc-input tc-gw-mono" id="gw-key" data-gw-field="key" data-key="gw-key" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off" placeholder="${view.preset === 'custom' ? 'Optional' : ''}"${view.errors.key ? raw(' aria-invalid="true"') : ''}>${view.errors.key ? html`<p class="tc-hint tc-hint--err" role="alert">${view.errors.key}</p>` : html`<p class="tc-hint">${gateway?.key.state === 'missing' ? gateway.key.credentialId + ' is no longer in the Vault. Enter a key to replace it.' : hint + ' It’s saved in the Vault.'}</p>`}</div>`;
      };
      const nameField = () => field('name', 'Name',
        html`<input class="tc-input" id="gw-name" data-gw-field="name" data-key="gw-name" type="text" autocomplete="off" maxlength="40" spellcheck="false"${view.errors.name ? raw(' aria-invalid="true"') : ''}>`,
        html`Shown in T3 Code as <b>Claude · ${nameNow() || 'Name'}</b>`, view.errors.name);
      const outcome = () => {
        const result = view.result;
        if (view.busy === 'test') return html`<div class="tc-gw-outcome" data-tone="info" role="status" data-key="gw-outcome"><span class="tc-spinner" aria-hidden="true"></span><div class="tc-gw-outcome-body"><strong>Testing from this container…</strong></div></div>`;
        if (!result) return '';
        if (!result.ok) return html`<div class="tc-gw-outcome" data-tone="danger" role="alert" data-key="gw-outcome">${icon('circle-alert')}<div class="tc-gw-outcome-body"><strong>${result.message}</strong>${result.hint ? html`<span>${result.hint}</span>` : ''}</div>${result.fix ? html`<button class="tc-btn tc-btn--sm" type="button" data-key="gw-fix" data-gw-editor="fix" data-url="${result.fix.url}">${result.fix.label}</button>` : ''}</div>`;
        return html`<div class="tc-gw-outcome" data-tone="ok" role="status" data-key="gw-outcome">${icon('circle-check')}<div class="tc-gw-outcome-body"><strong>Connected</strong>${result.insecure ? html`<span class="tc-hint--warn">This is plain http on a public address, so the key travels unencrypted.</span>` : ''}<ul class="tc-gw-checks">${S.checkLines(result, { keyed: keyed() }).map(line => html`<li data-tone="${line.tone}">${icon(line.tone === 'ok' ? 'check' : line.tone === 'warn' ? 'triangle-alert' : 'x')}${line.text}</li>`)}</ul></div></div>`;
      };
      const connect = () => html`<div class="tc-gw-form">${editing ? '' : presetPicker()}${addressField()}${keyField()}${nameField()}${outcome()}</div>`;

      // ---- agents ----------------------------------------------------------------
      const toggleAgent = id => { view.agentsTouched = true; if (view.agents.has(id)) view.agents.delete(id); else view.agents.add(id); paint(); };
      const pickRow = agent => {
        const fit = S.availability(agent, view.result), present = ctx.installed(agent.id), usable = fit.usable && present, on = usable && view.agents.has(agent.id);
        const line = !present ? 'Not installed. Add it on the Agents page first.' : !fit.usable ? fit.reason
          : S.protocolName(agent.protocol) + (fit.offered === null ? '' : ' · ' + S.models(fit.offered)) + (fit.unconfirmed ? ' · not confirmed' : '');
        return html`<div class="tc-gw-agent" data-key="gw-pick-${agent.id}" data-off="${String(!usable)}"><span class="tc-tile tc-tile--mark" aria-hidden="true">${raw(T3C.agentMark(agent.id))}</span><div class="tc-gw-agent-main"><span class="tc-gw-agent-name" id="gw-pick-name-${agent.id}">${agent.name}</span><span class="tc-gw-agent-line">${line}</span></div><label class="tc-switch-hit" for="gw-pick-switch-${agent.id}"><button class="tc-switch" id="gw-pick-switch-${agent.id}" type="button" role="switch" aria-labelledby="gw-pick-name-${agent.id}" aria-checked="${String(on)}" data-key="gw-pick-switch-${agent.id}" data-gw-editor="agent" data-id="${agent.id}"${disabled(!usable)}></button></label></div>`;
      };
      const selection = () => S.agents().filter(agent => view.agents.has(agent.id) && ctx.installed(agent.id) && S.availability(agent, view.result).usable).map(agent => agent.id);
      const keyName = () => view.keySource === 'vault' ? view.credentialId : view.key.trim() ? 'a new credential' : null;
      const conflict = () => ctx.conflicts().find(entry => entry.agent === 'claude' && view.agents.has('claude'));
      const plan = () => {
        const names = S.instanceNames(selection(), nameNow()), key = keyName(), others = names.length - 1;
        return html`<ul class="tc-gw-plan" data-key="gw-plan">
          ${names.length ? html`<li>${icon('plus')}<span>Adds <b>${names[0]}</b>${others ? ' and ' + others + ' more' : ''} to T3 Code’s model picker</span></li>` : ''}
          <li>${icon('shield-check')}<span>Your direct sign-ins, threads, skills and MCP servers stay as they are</span></li>
          ${key ? html`<li>${icon('key-round')}<span>${view.keySource === 'vault' ? html`Uses <code>${key}</code> from the Vault` : 'Saves the key in the Vault'}</span></li>` : ''}
        </ul>`;
      };
      const conflictBlock = () => {
        const found = conflict();
        return found ? html`<div class="tc-notice tc-notice--warn" role="status" data-key="gw-editor-conflict">${icon('triangle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">Claude Code’s settings file would override this</strong><span class="tc-notice-desc">${S.conflictSentence(found)}</span></div><button class="tc-btn tc-btn--sm" type="button" data-key="gw-editor-conflict-fix" data-gw-editor="fix-conflict" data-id="${found.id}">Remove…</button></div>` : '';
      };
      const pick = () => html`<div class="tc-gw-form"><div><h3 class="tc-step-title">Which agents should use ${nameNow()}?</h3><p class="tc-hint">Each one gets its own entry beside your direct sign-in, so you choose per thread.</p></div><div class="tc-group tc-gw-pick" data-key="gw-pick">${S.agents().map(pickRow)}</div>${conflictBlock()}${plan()}</div>`;
      const connectNow = async () => {
        if (view.busy) return;
        view.busy = 'connect'; view.error = null; paint();
        const response = await ctx.api('/gateways/create', { body: { revision: ctx.revision(), gateway: { name: nameNow(), preset: view.preset, url: view.url, agents: selection() }, ...keyNow() } });
        view.busy = null;
        if (active !== view) return;
        if (!response.ok) { view.error = response.error; paint(); if (response.data?.code === 'conflict') await ctx.reload(); return; }
        view.key = '';
        view.createdId = response.data.id; view.results = response.data.results; view.step = 'done';
        ctx.accepted(response.data);
        paint();
        view.layer.panel.querySelector('[data-gw-editor="finish"]')?.focus({ preventScroll: true });
      };

      // ---- done ------------------------------------------------------------------
      const doneRow = row => {
        const state = S.agentState(row), failure = view.results?.find(result => result.agent === row.id && !result.ok);
        const shown = failure ? { tone: 'danger', label: 'Not connected' } : state;
        return html`<div class="tc-gw-agent" data-key="gw-done-${row.id}"><span class="tc-tile tc-tile--mark" aria-hidden="true">${raw(T3C.agentMark(row.id))}</span><div class="tc-gw-agent-main"><span class="tc-gw-agent-name">${row.displayName}</span><span class="tc-gw-agent-line">${failure ? failure.error : S.agentLine(row)}</span></div><span class="tc-gw-state" data-tone="${shown.tone}">${shown.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>` : html`<span class="tc-dot tc-dot--${shown.tone || 'idle'}" aria-hidden="true"></span>`}<span>${shown.label}</span></span></div>`;
      };
      const done = () => {
        const gateway = ctx.gateway(view.createdId), rows = gateway?.agents.filter(row => row.connected) || [], starting = rows.some(row => row.state === 'starting') || gateway?.settling;
        return html`<div class="tc-gw-form"><div class="tc-gw-done-head">${icon('circle-check')}<div><h3 class="tc-step-title">${gateway?.name || nameNow()} is connected</h3><p class="tc-hint">${rows.length ? html`Choose <b>${rows[0].displayName}</b> in the model picker of any new thread.` : 'Turn agents on from its card whenever you’re ready.'}</p></div></div>${rows.length ? html`<div class="tc-group tc-gw-pick" data-key="gw-done" aria-busy="${String(Boolean(starting))}">${rows.map(doneRow)}</div>` : ''}</div>`;
      };

      // ---- frame -----------------------------------------------------------------
      const steps = () => html`<ol class="tc-steps">${STEPS.map(([id, label], index) => { const order = STEPS.findIndex(([step]) => step === view.step), state = view.step === 'done' || index < order ? 'done' : index === order ? 'active' : 'todo'; return html`<li class="tc-step" data-state="${state}"${state === 'active' ? raw(' aria-current="step"') : ''}><span class="tc-step-mark">${state === 'done' ? icon('check') : index + 1}</span>${label}</li>`; })}</ol>`;
      const head = () => html`<div class="tc-wizard-head"><span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('waypoints')}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="gw-editor-title">${editing ? 'Edit ' + (gateway?.name || 'gateway') : 'Add a gateway'}</h2></div>${editing ? '' : steps()}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm${editing ? ' tc-gw-close' : ''}" type="button" data-gw-editor="close" aria-label="Close">${icon('x')}</button></div>`;
      const failed = () => view.result && !view.result.ok;
      const foot = () => {
        if (view.step === 'done') return html`<div class="tc-wizard-foot"><span class="tc-spacer"></span><button class="tc-btn tc-btn--primary" type="button" data-key="gw-finish" data-gw-editor="finish">Done</button></div>`;
        if (view.step === 'agents') return html`<div class="tc-wizard-foot"><button class="tc-btn" type="button" data-key="gw-back" data-gw-editor="back"${disabled(view.busy)}>Back</button><span class="tc-spacer"></span><button class="tc-btn tc-btn--primary" type="submit" data-key="gw-connect"${disabled(view.busy)}>${view.busy === 'connect' ? html`<span class="tc-spinner" aria-hidden="true"></span>Connecting…` : selection().length ? 'Connect ' + S.plural(selection().length, 'agent') : 'Save without agents'}</button></div>`;
        const label = view.busy === 'test' ? 'Testing…' : view.busy === 'save' ? 'Saving…' : failed() ? 'Test again' : view.result?.ok ? (editing ? 'Save' : 'Continue')
          : editing ? (connectionChanged() ? 'Test and save' : 'Save') : 'Test and continue';
        return html`<div class="tc-wizard-foot"><button class="tc-btn" type="button" data-key="gw-cancel" data-gw-editor="close"${disabled(view.busy)}>Cancel</button>${restarts() ? html`<span class="tc-hint tc-gw-foot-note">${icon('info', 'tc-icon--sm')}Saving restarts its agents. Turns running on them stop.</span>` : ''}<span class="tc-spacer"></span>${S.canContinueAnyway(view.result) ? html`<button class="tc-btn tc-btn--ghost" type="button" data-key="gw-anyway" data-gw-editor="anyway"${disabled(view.busy)}>${editing ? 'Save anyway' : 'Continue anyway'}</button>` : ''}<button class="tc-btn tc-btn--primary" type="submit" data-key="gw-next"${disabled(view.busy || (editing && !changedAtAll()))}>${view.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>` : ''}${label}</button></div>`;
      };
      const bodyMarkup = () => view.step === 'connect' ? connect() : view.step === 'agents' ? pick() : done();
      view.layer = Kit.open({
        kind: 'center', backdrop: 'ignore', focus: replaceKey ? '#gw-key' : editing ? '#gw-url' : '[data-gw-editor="preset"][aria-checked="true"]',
        panel: { tag: 'form', class: 'tc-wizard tc-gw-editor', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gw-editor-title', autocomplete: 'off', novalidate: true },
        onEscape: () => void view.close('escape'),
        onClose: () => { view.key = ''; window.removeEventListener('beforeunload', beforeUnload); if (active === view) active = null; },
        render: () => html`${head()}<div class="tc-wizard-grid tc-gw-grid"><div class="tc-wizard-main" data-key="gw-editor-main">${bodyMarkup()}${view.error ? html`<p class="tc-hint tc-hint--err" role="alert">${view.error}</p>` : ''}</div></div>${foot()}`,
      });
      const panel = view.layer.panel;
      panel.addEventListener('input', event => {
        const name = event.target.dataset.gwField;
        if (!name) return;
        view[name] = event.target.value;
        if (name === 'url') { view.urlTouched = true; if (view.result) resultChanged(); paint(); }
        if (name === 'key') { if (view.result) resultChanged(); if (view.errors.key) delete view.errors.key; paint(); }
        if (name === 'name') { view.nameTouched = true; paint(); }
      });
      panel.addEventListener('submit', event => {
        event.preventDefault();
        if (view.busy) return;
        if (view.step === 'connect') void advance();
        else if (view.step === 'agents') void connectNow();
      });
      panel.addEventListener('click', event => {
        const button = event.target.closest('[data-gw-editor]');
        if (!button || button.disabled) return;
        const name = button.dataset.gwEditor;
        if (name === 'close') return void view.close('close');
        if (name === 'finish') return view.layer.close('done');
        if (name === 'preset') return pickPreset(button.dataset.id);
        if (name === 'fix') return useSuggestion(button.dataset.url);
        if (name === 'saved-keys') return pickSavedKey(button);
        if (name === 'replace-key') { view.keySource = 'type'; view.replacing = true; resultChanged(); paint(); panel.querySelector('#gw-key')?.focus({ preventScroll: true }); return; }
        if (name === 'anyway') { if (editing) return void saveEdit(); view.agents = view.agentsTouched ? view.agents : new Set(S.agents().filter(agent => ctx.installed(agent.id)).map(agent => agent.id)); view.step = 'agents'; return paint(); }
        if (name === 'back') { view.step = 'connect'; return paint(); }
        if (name === 'agent') return toggleAgent(button.dataset.id);
        if (name === 'fix-conflict') return void ctx.fixConflict?.(button.dataset.id);
      });
      sync();
    };

    return { open, close, repaint: () => active?.repaint(), isOpen: () => Boolean(active), beforeNavigate: async () => active ? active.close('route') : true };
  };
  return { create };
})();
