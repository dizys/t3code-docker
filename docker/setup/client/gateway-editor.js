// Adding or changing a gateway, on one sheet with the same shape as Add MCP server:
// what it is on the left, what will change on the right, updating as it's filled in.
//
// A key typed here stays in this form until it is saved, and a saved key never comes
// back: the server only says which Vault credential holds it. The address and key are
// tested as soon as both are in. A management key is different. The gateway locks this
// server out after five failures, so it's only ever sent when someone presses a button,
// and a key it refused isn't sent again until it changes.
const T3GatewayEditor = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3GatewayModel;
  const disabled = value => value ? raw(' disabled') : '';
  const checked = value => value ? raw(' checked') : '';

  const create = ctx => {
    let active = null;
    const close = reason => active ? active.close(reason) : Promise.resolve(true);

    const open = async (gateway, { replaceKey = false, preset: chosen = null, limits = false } = {}) => {
      if (!await close('replaced')) return;
      const editing = Boolean(gateway), preset = S.presetOf(gateway?.preset) || S.presetOf(chosen) || S.presets()[0];
      const view = {
        editing, id: gateway?.id || null, busy: null, testing: null, result: null, tested: '', error: null, errors: {},
        preset: preset.id, presetTouched: Boolean(chosen),
        url: gateway?.url ?? preset.url, urlTouched: false,
        name: gateway?.name ?? '', nameTouched: editing,
        // A key deleted from the Vault can't be shown as saved: ask for a new one.
        key: '', keySource: editing && gateway.key.state === 'saved' ? 'saved' : 'type', credentialId: gateway?.key?.credentialId ?? null,
        replacing: replaceKey, closing: false, railOpen: !Kit.isPhone(),
        agents: new Set(editing ? [] : S.agents().filter(agent => ctx.installed(agent.id)).map(agent => agent.id)), agentsTouched: false,
        // Fixed at opening: a window that reloaded mustn't save what it read before that.
        revision: ctx.revision(), stale: false,
        managementKey: '', limitsOpen: limits, refusedKeys: new Set(), replacingLimits: limits, allowPrivate: false,
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
      const dirty = () => Boolean(view.key) || Boolean(view.managementKey) || JSON.stringify([view.url, view.name]) !== original && (editing || view.urlTouched || view.nameTouched);
      // Nothing typed leaves the saved key in place, on the server's side.
      const keyNow = () => view.keySource === 'vault' ? { credentialId: view.credentialId } : view.keySource === 'type' && view.key.trim() ? { key: view.key.trim() } : {};
      const keyed = () => view.keySource !== 'type' || Boolean(view.key.trim()) || gateway?.key.state === 'saved';
      const signature = () => JSON.stringify([view.url.trim(), keyNow(), view.allowPrivate]);
      const untested = () => !view.result || view.tested !== signature();

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
          const yes = await Kit.confirm({ title: editing ? 'Discard your changes?' : 'Discard this gateway?', body: 'What you’ve entered hasn’t been saved.', confirm: 'Discard', tone: 'danger' });
          view.closing = false;
          if (!yes || active !== view) return false;
        }
        view.layer.close(reason);
        return true;
      };
      const beforeUnload = event => { if (view.busy || dirty()) { event.preventDefault(); event.returnValue = ''; } };
      window.addEventListener('beforeunload', beforeUnload);

      // ---- testing ---------------------------------------------------------------
      const pickPreset = id => {
        if (view.preset === id) return;
        const previous = S.presetOf(view.preset), next = S.presetOf(id);
        view.preset = id; view.presetTouched = true;
        // Only replace an address that came from the last preset.
        if (!view.urlTouched || view.url === (previous?.url ?? '')) { view.url = next.url; view.urlTouched = false; view.allowPrivate = false; }
        view.result = null; view.tested = ''; view.errors = {}; view.error = null; paint();
        view.layer.panel.querySelector('#gw-url')?.focus({ preventScroll: true });
      };
      const runTest = () => {
        if (view.testing) return view.testing;
        const asked = signature();
        view.busy = 'test'; view.result = null; view.errors = {}; view.error = null; paint();
        view.testing = ctx.api('/gateways/test', { body: { url: view.url, ...keyNow(), ...(view.allowPrivate ? { allowPrivateHost: true } : {}), ...(view.id ? { id: view.id } : {}) } }).then(response => {
          view.busy = null; view.testing = null;
          if (active !== view) return null;
          // Someone kept typing: this answer is about an address that's gone, and must not put it back.
          if (signature() !== asked) { paint(); testWhenReady(); return view.testing; }
          if (!response.ok) {
            const field = response.data?.field;
            if (field) view.errors[field] = response.error; else view.error = response.error;
            paint();
            return null;
          }
          const result = response.data.result;
          view.result = result;
          if (result.url) view.url = result.url;
          view.tested = signature();
          // A gateway that says what it is beats the card someone left selected.
          if (result.product && S.presetOf(result.product) && result.product !== view.preset && (view.preset === 'custom' || !view.presetTouched)) view.preset = result.product;
          if (!editing && result.ok && !view.agentsTouched) view.agents = new Set(S.agents().filter(agent => ctx.installed(agent.id) && S.availability(agent, result).usable).map(agent => agent.id));
          paint();
          // On a phone the answer lands below the fold, and a button that seems to do nothing gets pressed again.
          if (Kit.isPhone()) view.layer.panel.querySelector('[data-key="gw-check"]')?.scrollIntoView({ block: 'nearest', behavior: Kit.REDUCED.matches ? 'auto' : 'smooth' });
          return result;
        });
        return view.testing;
      };
      /** Test once there's enough to test. An address alone would only report that it needs a key. */
      const testWhenReady = () => {
        if (view.busy || !view.url.trim() || !untested()) return;
        if (!keyed() && presetNow()?.id !== 'custom') return;
        void runTest();
      };

      const connectionChanged = () => view.url.trim() !== gateway.url || Boolean(view.key.trim()) || (view.keySource === 'vault' && view.credentialId !== gateway.key.credentialId);
      const restarts = () => editing && connectionChanged() ? gateway.agents.filter(agent => agent.connected) : [];
      const failed = () => Boolean(view.result && !view.result.ok);
      const limitsAllowed = () => Boolean(presetNow()?.hub) && ctx.hubs();
      const limitsNow = () => limitsAllowed() && view.managementKey.trim() ? { managementKey: view.managementKey.trim() } : {};
      const refusedAgain = () => view.refusedKeys.has(view.managementKey.trim());
      // A hub at the address that this gateway didn't set up belongs to someone's T3 settings.
      const foreignHub = () => !gateway?.limits?.owned && ctx.hubAt(view.url.trim());
      const refuseLimits = response => {
        // Only a wrong key is held against it. "Locked out" and "turned off" aren't about the key.
        if (response.data?.limits?.code === 'rejected') view.refusedKeys.add(view.managementKey.trim());
        view.errors.managementKey = response.error;
        view.errors.managementHint = response.data?.hint || '';
        view.limitsOpen = true;
        paint();
        const input = view.layer.panel.querySelector('#gw-management-key');
        input?.focus({ preventScroll: true });
        input?.closest('.tc-form-field')?.scrollIntoView({ block: 'nearest', behavior: Kit.REDUCED.matches ? 'auto' : 'smooth' });
      };
      const selection = () => S.agents().filter(agent => view.agents.has(agent.id) && ctx.installed(agent.id) && S.availability(agent, view.result).usable).map(agent => agent.id);
      const canSubmit = () => !view.busy && !view.stale && !refusedAgain() && view.url.trim() && (editing || selection().length);

      const finish = response => {
        ctx.accepted(response.data); ctx.reportFailures(response);
        view.key = ''; view.managementKey = '';
        view.layer.close('saved');
      };
      const handleFailure = async response => {
        if (response.data?.field === 'managementKey') return refuseLimits(response);
        if (response.data?.code === 'private-host') {
          view.errors.url = response.error;
          view.result = { ok: false, code: 'private-host', confirmHost: response.data.confirmHost, message: response.error };
          view.tested = '';
        }
        view.error = response.error;
        if (response.data?.code === 'conflict') { view.stale = editing; await ctx.reload(); if (!editing) view.revision = ctx.revision(); }
        paint();
      };
      const save = async ({ anyway = false } = {}) => {
        if (!canSubmit()) return;
        const nameOnly = editing && !connectionChanged();
        if (!nameOnly && !anyway) {
          let result = view.testing ? await view.testing : untested() ? await runTest() : view.result;
          // Waiting on a test of something since changed: the changed version decides.
          if (!result && active === view && !view.error && !Object.keys(view.errors).length && untested()) result = await runTest();
          if (!result?.ok) return;
        }
        // Anything could have changed while that test ran.
        if (active !== view || !canSubmit()) return;
        view.busy = 'save'; view.error = null; paint();
        const response = editing
          ? await ctx.api('/gateways/save', { body: { id: view.id, revision: view.revision, gateway: { url: view.url, name: nameNow(), preset: view.preset }, ...keyNow(), ...limitsNow(), ...(view.allowPrivate ? { allowPrivateHost: true } : {}) } })
          : await ctx.api('/gateways/create', { body: { revision: view.revision, gateway: { name: nameNow(), preset: view.preset, url: view.url, agents: selection() }, ...keyNow(), ...limitsNow(), ...(view.allowPrivate ? { allowPrivateHost: true } : {}) } });
        view.busy = null;
        if (active !== view) return;
        if (!response.ok) return handleFailure(response);
        const name = nameNow(), first = S.instanceNames(selection(), name)[0], results = response.data.results || [], allFailed = results.length > 0 && results.every(result => !result.ok);
        finish(response);
        if (allFailed) return;
        Kit.toast(editing ? 'Saved ' + name : 'Added ' + name, editing ? {} : { detail: first ? 'Choose ' + first + ' in T3 Code’s model picker.' : undefined });
        if (response.data.limitsStopped) Kit.toast('Limits stopped for ' + name, { detail: 'Its management key was checked at the old address. Set it up again to bring them back.' });
      };
      const useSuggestion = url => { view.url = url; view.urlTouched = true; view.allowPrivate = false; view.result = null; paint(); void runTest(); };
      const pickSavedKey = button => Kit.menu(button, { label: 'Saved keys', head: 'Saved in the Vault', items: ctx.keys().map(entry => ({ label: entry.id, icon: 'key-round', run: () => { view.keySource = 'vault'; view.credentialId = entry.id; view.key = ''; view.result = null; paint(); testWhenReady(); } })) });

      // ---- the form --------------------------------------------------------------
      const field = (id, label, input, hint, error) => html`<div class="tc-form-field" data-key="gw-field-${id}"><label class="tc-label" for="gw-${id}">${label}</label>${input}${error ? html`<p class="tc-hint tc-hint--err" role="alert">${error}</p>` : hint ? html`<p class="tc-hint">${hint}</p>` : ''}</div>`;
      const presetTile = entry => entry.mark ? html`<span class="tc-tile tc-tile--mark" aria-hidden="true">${raw(T3C.agentMark(entry.mark))}</span>` : html`<span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('waypoints')}</span>`;
      const presetPicker = () => html`<div class="tc-gw-presets" role="radiogroup" aria-label="Gateway type" data-key="gw-presets">${S.presets().map(entry => html`<button class="tc-gw-preset" type="button" role="radio" aria-checked="${String(view.preset === entry.id)}" data-key="gw-preset-${entry.id}" data-gw-editor="preset" data-id="${entry.id}"${disabled(view.busy)}>${presetTile(entry)}<span class="tc-gw-preset-text"><strong>${entry.name}</strong><small>${entry.blurb}</small></span></button>`)}</div>`;
      const addressField = () => field('url', 'Address',
        html`<input class="tc-input tc-input--mono" id="gw-url" data-gw-field="url" data-key="gw-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="http://gateway:8317"${view.errors.url ? raw(' aria-invalid="true"') : ''}${disabled(view.busy === 'save')}>`,
        view.result?.notes?.[0] || 'Agents reach it from inside this container.', view.errors.url);
      const keyField = () => {
        const saved = view.keySource === 'saved' || view.keySource === 'vault', keys = ctx.keys();
        const head = html`<div class="tc-label"><label for="gw-key">API key</label>${keys.length && !saved ? html`<button class="tc-btn tc-btn--link tc-btn--xs" type="button" data-key="gw-saved-keys" data-gw-editor="saved-keys" aria-haspopup="menu">Use a saved key</button>` : ''}</div>`;
        if (saved) return html`<div class="tc-form-field" data-key="gw-field-key">${head}<div class="tc-gw-held">${icon('lock')}<span>Saved in the Vault as <code>${view.credentialId}</code></span><span class="tc-spacer"></span><button class="tc-btn tc-btn--xs" type="button" data-key="gw-replace-key" data-gw-editor="replace-key"${disabled(view.busy)}>Replace</button></div></div>`;
        return html`<div class="tc-form-field" data-key="gw-field-key">${head}<input class="tc-input tc-input--mono" id="gw-key" data-gw-field="key" data-key="gw-key" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off" placeholder="${view.replacing ? 'The new key' : presetNow()?.id === 'custom' ? 'Optional' : ''}"${view.errors.key ? raw(' aria-invalid="true"') : ''}${disabled(view.busy === 'save')}>${view.errors.key ? html`<p class="tc-hint tc-hint--err" role="alert">${view.errors.key}</p>` : html`<p class="tc-hint">${presetNow()?.keyHint} It’s saved in the Vault.</p>`}</div>`;
      };
      const nameField = () => field('name', 'Name',
        html`<input class="tc-input" id="gw-name" data-gw-field="name" data-key="gw-name" type="text" autocomplete="off" maxlength="40" spellcheck="false"${view.errors.name ? raw(' aria-invalid="true"') : ''}${disabled(view.busy === 'save')}>`,
        html`Shown in T3 Code as <b>Claude · ${nameNow() || 'Name'}</b>`, view.errors.name);
      const check = () => {
        if (view.busy === 'test') return html`<div class="tc-gw-check" data-key="gw-check" role="status"><span class="tc-spinner" aria-hidden="true"></span><span class="tc-gw-check-text"><strong>Testing from this container…</strong></span></div>`;
        const result = view.result;
        if (!result) {
          // Nothing changed yet, so the last health check still speaks for this address.
          const held = editing && !connectionChanged() ? gateway.check : null;
          if (held?.ok) return html`<div class="tc-gw-check" data-tone="ok" data-key="gw-check">${icon('circle-check')}<span class="tc-gw-check-text"><strong>Connected</strong><span>${[held.listed ? S.models(held.count) : '', 'tested ' + T3Model.relTime(held.at, Date.now())].filter(Boolean).join(' · ')}</span></span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-key="gw-test" data-gw-editor="test">Test again</button></div>`;
          return html`<div class="tc-gw-check" data-key="gw-check">${icon('circle-dashed')}<span class="tc-gw-check-text"><strong>Not tested yet</strong><span>From this container, and it can’t spend tokens.</span></span><button class="tc-btn tc-btn--xs" type="button" data-key="gw-test" data-gw-editor="test"${disabled(!view.url.trim())}>Test</button></div>`;
        }
        if (result.code === 'private-host') return html`<div class="tc-gw-check" data-tone="danger" data-key="gw-check" role="alert">${icon('circle-alert')}<span class="tc-gw-check-text"><strong>Confirm “${result.confirmHost || result.host || view.url.trim()}” before any key is sent</strong>${result.hint ? html`<span>${result.hint}</span>` : ''}</span><button class="tc-btn tc-btn--xs" type="button" data-key="gw-test" data-gw-editor="test">Test again</button></div>`;
        if (!result.ok) return html`<div class="tc-gw-check" data-tone="danger" data-key="gw-check" role="alert">${icon('circle-alert')}<span class="tc-gw-check-text"><strong>${result.message}</strong>${result.hint ? html`<span>${result.hint}</span>` : ''}</span>${result.fix?.url ? html`<button class="tc-btn tc-btn--xs" type="button" data-key="gw-fix" data-gw-editor="fix" data-url="${result.fix.url}">${result.fix.label}</button>` : html`<button class="tc-btn tc-btn--xs" type="button" data-key="gw-test" data-gw-editor="test">Test again</button>`}</div>`;
        const product = result.product && S.presetOf(result.product) ? S.presetOf(result.product).name : null;
        const facts = [result.ms + ' ms', result.models.listed ? S.models(result.models.ids.length) : 'No model list', product].filter(Boolean);
        return html`<div class="tc-gw-check" data-tone="ok" data-key="gw-check" role="status">${icon('circle-check')}<span class="tc-gw-check-text"><strong>Connected</strong><span>${facts.join(' · ')}</span>${result.insecure ? html`<span class="tc-warnline">This is plain http on a public address, so the key isn’t protected in transit.</span>` : ''}</span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-key="gw-test" data-gw-editor="test">Test again</button></div>`;
      };
      const limitsField = () => {
        if (!limitsAllowed()) return '';
        const held = editing ? gateway.limits : null, set = held && held.state !== 'off', moved = editing && held?.owned && view.url.trim() !== gateway.url;
        if (foreignHub()) return html`<div class="tc-form-field" data-key="gw-field-limits"><div class="tc-label"><span>Limits</span></div><div class="tc-gw-held">${icon('gauge')}<span>Already set up for this address</span></div></div>`;
        if (set && !view.replacingLimits && !moved) {
          const state = S.limitsState(held);
          return html`<div class="tc-form-field" data-key="gw-field-limits"><div class="tc-label"><span>Limits</span></div><div class="tc-gw-held">${icon('gauge')}<span>Showing in T3 Code · ${state.label}</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--xs" type="button" data-key="gw-replace-limits" data-gw-editor="replace-limits"${disabled(view.busy)}>Replace key</button></div></div>`;
        }
        const error = view.errors.managementKey || (refusedAgain() ? 'The gateway already turned this key down.' : '');
        return html`<details class="tc-gw-optional" data-key="gw-field-limits"${view.limitsOpen || moved ? raw(' open') : ''}><summary>${icon('chevron-right', 'tc-gw-optional-chev')}<span>Show account limits in T3 Code</span><span class="tc-muted">optional</span></summary><div class="tc-form-field"><label class="tc-label" for="gw-management-key">Management key</label><input class="tc-input tc-input--mono" id="gw-management-key" data-gw-field="managementKey" data-key="gw-management-key" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off"${error ? raw(' aria-invalid="true"') : ''}${disabled(view.busy === 'save')}>${error ? html`<p class="tc-hint tc-hint--err" role="alert">${error}${view.errors.managementHint ? ' ' + view.errors.managementHint : ''}</p>` : html`<p class="tc-hint">${moved ? 'The key was checked at the old address, so Limits stop unless you enter it again.' : 'The key you chose for its management API. T3 Code keeps it in its own secret store, so agents can’t ask for it by name.'}</p>`}</div></details>`;
      };
      const conflict = () => ctx.conflicts().find(entry => entry.agent === 'claude' && (editing ? gateway.agents.some(agent => agent.id === 'claude' && agent.connected) : view.agents.has('claude')));
      const conflictBlock = () => {
        const found = conflict();
        return found && !found.active ? html`<div class="tc-notice tc-notice--warn" role="status" data-key="gw-editor-conflict">${icon('triangle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">Claude Code’s settings file would override this</strong><span class="tc-notice-desc">${S.conflictSentence(found)}</span></div><button class="tc-btn tc-btn--sm" type="button" data-key="gw-editor-fix" data-gw-editor="fix-conflict" data-id="${found.id}">Review…</button></div>` : '';
      };
      const privateField = () => {
        const needs = view.result?.code === 'private-host' || /Private host/.test(view.errors.url || '');
        if (!needs && !view.allowPrivate) return '';
        let host = view.result?.confirmHost;
        if (!host) { try { host = new URL(/^[a-z]+:\/\//i.test(view.url) ? view.url : 'http://' + view.url).host; } catch { host = view.url; } }
        return html`<div class="tc-form-field" data-key="gw-field-private"><label class="tc-gw-private"><input class="tc-checkbox" type="checkbox" data-gw-private${view.allowPrivate ? raw(' checked') : ''}${disabled(view.busy === 'save')}>I trust ${host} with these credentials</label><p class="tc-hint">Local names, loopback and metadata addresses need confirmation before a key is sent.</p></div>`;
      };
      const main = () => html`${view.error ? html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">That didn’t finish</strong><span class="tc-notice-desc">${view.error}</span></div>${view.stale ? html`<button class="tc-btn tc-btn--sm" type="button" data-key="gw-reopen" data-gw-editor="reopen">Reopen</button>` : ''}</div>` : ''}${conflictBlock()}<div class="tc-form">${editing ? '' : presetPicker()}${addressField()}${privateField()}${keyField()}${check()}${nameField()}${limitsField()}</div>`;

      // ---- the rail --------------------------------------------------------------
      const pickRow = agent => {
        const fit = S.availability(agent, view.result), present = ctx.installed(agent.id), usable = fit.usable && present, on = usable && view.agents.has(agent.id);
        const note = !present ? 'Not installed' : !fit.usable ? 'This gateway has no ' + S.protocolShort(agent.protocol) : [fit.offered === null ? '' : S.models(fit.offered), S.protocolShort(agent.protocol)].filter(Boolean).join(' · ');
        return html`<label class="tc-agentpick-row" data-key="gw-pick-${agent.id}" data-off="${String(!on)}"${fit.unconfirmed ? raw(' title="The gateway didn’t confirm this route."') : ''}><input class="tc-checkbox" type="checkbox" data-gw-agent="${agent.id}"${checked(on)}${disabled(view.busy === 'save' || !usable)}><span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(agent.id))}</span><span class="tc-row-main"><span class="tc-avail-name">${agent.name}</span><span class="tc-avail-note">${note}</span></span></label>`;
      };
      const editRow = row => {
        const agent = S.agentOf(row.id), restarting = restarts().some(entry => entry.id === row.id);
        return html`<div class="tc-agentpick-row tc-gw-editrow" data-key="gw-pick-${row.id}" data-off="${String(!row.connected)}"><span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(row.id))}</span><span class="tc-row-main"><span class="tc-avail-name">${agent.name}</span><span class="tc-avail-note">${!row.connected ? 'Not using this gateway' : restarting ? 'Restarts' : 'Stays as it is'}</span></span></div>`;
      };
      const stat = () => {
        if (editing) {
          const count = restarts().length;
          return html`<div class="tc-plan-section" data-key="gw-plan"><div class="tc-plan-stat"><strong>${count}</strong><span>${count === 1 ? 'agent restarts' : 'agents restart'}</span></div><p class="tc-hint">${count ? 'Turns running on ' + (count === 1 ? 'it' : 'them') + ' stop. Threads continue on the next message.' : view.name.trim() !== gateway.name ? 'A new name only changes what T3 Code’s picker shows.' : 'Nothing has changed yet.'}</p></div>`;
        }
        const names = S.instanceNames(selection(), nameNow() || 'Name');
        return html`<div class="tc-plan-section" data-key="gw-plan"><div class="tc-plan-stat"><strong>${names.length}</strong><span>${names.length === 1 ? 'entry in T3 Code’s picker' : 'entries in T3 Code’s picker'}</span></div><p class="tc-hint">${names.length ? S.listOf(names) + '.' : 'Choose an agent above.'}</p></div>`;
      };
      const rail = () => {
        const count = editing ? restarts().length : selection().length, label = editing ? 'When you save' : 'Use in';
        return html`<details class="tc-wizard-rail-wrap"${view.railOpen || !Kit.isPhone() ? raw(' open data-open') : ''}><summary class="tc-wizard-rail-toggle"><span>${label}${editing ? '' : ' · ' + S.plural(count, 'agent')}</span>${icon('chevron-down')}</summary><aside class="tc-wizard-rail"><span class="tc-insp-label">${label}</span><div class="tc-agentpick">${editing ? gateway.agents.map(editRow) : S.agents().map(pickRow)}</div>${stat()}<div class="tc-plan-bottom"><p class="tc-hint tc-gw-assure">${icon('shield-check')}<span>Your direct sign-ins, threads, skills and MCP servers stay as they are.</span></p></div></aside></details>`;
      };

      // ---- the frame -------------------------------------------------------------
      const submitLabel = () => {
        if (view.busy === 'save') return editing ? 'Saving…' : 'Adding…';
        if (view.busy === 'test') return 'Testing…';
        if (editing) return restarts().length ? 'Save and restart ' + S.plural(restarts().length, 'agent') : 'Save';
        return selection().length ? 'Add to ' + S.plural(selection().length, 'agent') : 'Add gateway';
      };
      const head = () => html`<div class="tc-wizard-head">${presetTile(presetNow() || {})}<div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="gw-editor-title">${editing ? 'Edit ' + gateway.name : 'Add a gateway'}</h2><span class="tc-small tc-muted">${editing ? [presetNow()?.id === 'custom' ? '' : presetNow()?.name, 'added ' + T3Model.relTime(gateway.createdAt, Date.now())].filter(Boolean).join(' · ') : 'Connect once. Each agent gets its own entry in T3 Code.'}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-key="gw-close" data-gw-editor="close" aria-label="Close"${disabled(view.busy === 'save')}>${icon('x')}</button></div>`;
      const foot = () => html`<div class="tc-wizard-foot"><span class="tc-hint tc-gw-foot-hint"><kbd class="tc-kbd">${T3C.copyKeys?.startsWith('⌘') ? '⌘' : 'Ctrl'}</kbd><kbd class="tc-kbd">↵</kbd> to ${editing ? 'save' : 'add'}</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost" type="button" data-key="gw-cancel" data-gw-editor="close"${disabled(view.busy === 'save')}>Cancel</button>${failed() && S.canContinueAnyway(view.result) ? html`<button class="tc-btn" type="button" data-key="gw-anyway" data-gw-editor="anyway"${disabled(view.busy || (!editing && !selection().length))}>${editing ? 'Save anyway' : 'Add anyway'}</button>` : ''}<button class="tc-btn tc-btn--primary" type="submit" data-key="gw-submit"${disabled(!canSubmit() || failed())}>${view.busy === 'save' ? html`<span class="tc-spinner" aria-hidden="true"></span>` : ''}${submitLabel()}</button></div>`;

      view.layer = Kit.open({
        kind: 'center', backdrop: 'ignore', focus: replaceKey ? '#gw-key' : limits ? '#gw-management-key' : editing ? '#gw-url' : '#gw-url',
        panel: { tag: 'form', class: 'tc-wizard tc-mcp-editor tc-gw-editor', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gw-editor-title', autocomplete: 'off', novalidate: true },
        onEscape: () => void view.close('escape'),
        onClose: () => { view.key = ''; view.managementKey = ''; window.removeEventListener('beforeunload', beforeUnload); if (active === view) active = null; },
        render: () => html`${head()}<div class="tc-wizard-grid"><div class="tc-wizard-main" data-key="gw-editor-main">${main()}</div>${rail()}</div>${foot()}`,
      });
      const panel = view.layer.panel;
      panel.addEventListener('input', event => {
        const name = event.target.dataset.gwField;
        if (!name) return;
        view[name] = event.target.value;
        if (name === 'url') { view.urlTouched = true; view.allowPrivate = false; }
        if (name === 'name') view.nameTouched = true;
        if (name === 'managementKey') { delete view.errors.managementKey; delete view.errors.managementHint; }
        if ((name === 'url' || name === 'key') && view.result && untested()) { view.result = null; view.errors = {}; view.error = null; }
        if (name === 'key' && view.errors.key) delete view.errors.key;
        paint();
      });
      // Leaving a field is the moment it's finished. Never the management key: see above.
      panel.addEventListener('change', event => {
        if (event.target.id === 'gw-url' || event.target.id === 'gw-key') testWhenReady();
        if (event.target.matches('[data-gw-private]')) {
          view.allowPrivate = event.target.checked;
          view.result = null; view.tested = ''; view.errors = {};
          paint(); testWhenReady(); return;
        }
        if (event.target.dataset.gwAgent) {
          view.agentsTouched = true;
          if (event.target.checked) view.agents.add(event.target.dataset.gwAgent); else view.agents.delete(event.target.dataset.gwAgent);
          paint();
        }
      });
      panel.addEventListener('toggle', event => {
        if (event.target.matches('.tc-gw-optional')) view.limitsOpen = event.target.open;
        if (event.target.matches('.tc-wizard-rail-wrap') && Kit.isPhone()) { view.railOpen = event.target.open; event.target.toggleAttribute('data-open', view.railOpen); }
      }, true);
      panel.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void save(); } });
      panel.addEventListener('submit', event => { event.preventDefault(); void save(); });
      panel.addEventListener('click', event => {
        const button = event.target.closest('[data-gw-editor]');
        if (!button || button.disabled) return;
        const name = button.dataset.gwEditor;
        if (name === 'close') return void view.close('close');
        if (name === 'preset') return pickPreset(button.dataset.id);
        if (name === 'test') return void runTest();
        if (name === 'fix') return useSuggestion(button.dataset.url);
        if (name === 'anyway') return void save({ anyway: true });
        if (name === 'saved-keys') return pickSavedKey(button);
        if (name === 'replace-key') { view.keySource = 'type'; view.replacing = true; view.result = null; paint(); panel.querySelector('#gw-key')?.focus({ preventScroll: true }); return; }
        if (name === 'replace-limits') { view.replacingLimits = true; view.limitsOpen = true; paint(); panel.querySelector('#gw-management-key')?.focus({ preventScroll: true }); return; }
        if (name === 'fix-conflict') return void ctx.fixConflict?.(button.dataset.id);
        if (name === 'reopen') { view.key = ''; view.managementKey = ''; view.url = gateway.url; view.name = gateway.name; view.layer.close('reopen'); return void ctx.edit(view.id); }
      });
      sync();
    };

    return { open, close, repaint: () => active?.repaint(), isOpen: () => Boolean(active), beforeNavigate: async () => active ? active.close('route') : true };
  };
  return { create };
})();
