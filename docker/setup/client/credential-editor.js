// Drafts own their input subtree. Only a newly typed secret lives here; neither
// saved values nor server responses are copied into the form or a preview.
const T3CredentialEditor = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3CredentialModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const checked = value => value ? raw(' checked') : '';
  const create = ctx => {
    let active = null;
    const close = reason => active ? active.close(reason) : Promise.resolve(true);
    const open = async (profile, { replace = false } = {}) => {
      if (!await close('replaced')) return;
      const view = { original: profile || null, draft: S.draftOf(profile), revision: profile?.revision, create: !profile, secret: '', replacing: !profile || replace,
        touched: new Set(), busy: null, error: null, conflict: null, taken: false, result: null, scanned: null, trusted: false, revealed: false, railOpen: false, generation: 0, closing: false };
      active = view;
      const baseline = () => JSON.stringify(S.payload(view.original ? S.draftOf(view.original) : S.defaults('ssh')));
      const dirty = () => Boolean(view.secret || view.trusted || JSON.stringify(S.payload(view.draft)) !== baseline());
      const errors = () => ({ ...S.validate(view.draft, { editing: !view.create, names: ctx.rows().filter(row => row.id !== view.recreateId).map(row => row.id), secret: view.secret, hasSecret: !view.create && view.original?.hasSecret }), ...(view.taken ? { id: view.draft.id + ' is taken.' } : {}) });
      const valid = () => !Object.keys(errors()).length;
      const canSave = () => !view.busy && valid() && (!view.original || dirty()) && !view.conflict;
      const sync = () => {
        for (const input of view.layer.panel.querySelectorAll('[data-cred-field]')) {
          const key = input.dataset.credField, value = key === 'secret' ? view.secret : view.draft[key];
          if (input.value !== String(value ?? '')) input.value = value ?? '';
        }
        const trust = view.layer.panel.querySelector('[data-cred-editor="trust"]'); if (trust) trust.checked = view.trusted;
        view.layer.panel.querySelector('.tc-wizard-rail-wrap')?.toggleAttribute('data-open', !Kit.isPhone() || view.railOpen);
      };
      const paint = () => { if (active !== view || view.layer?.closed) return; view.layer.render(); sync(); };
      view.repaint = paint;
      view.close = async reason => {
        if (view.busy || view.closing) { Kit.announce('Wait for this credential check or save to finish.'); return false; }
        if (dirty()) {
          view.closing = true;
          const yes = await Kit.confirm({ title: 'Discard changes?', body: 'Your credential changes have not been saved.', confirm: 'Discard changes', tone: 'danger' });
          view.closing = false; if (!yes || active !== view) return false;
        }
        view.layer.close(reason); return true;
      };
      const beforeUnload = event => { if (view.busy || dirty()) { event.preventDefault(); event.returnValue = ''; } };
      window.addEventListener('beforeunload', beforeUnload);
      const hint = (key, fallback) => {
        const error = view.touched.has(key) && errors()[key];
        return html`${fallback ? html`<p class="tc-hint${key === 'secret' && !view.original && Kit.isPhone() ? ' tc-sr' : ''}" id="cred-${key}-hint">${fallback}</p>` : ''}${error ? html`<p class="tc-hint tc-danger" id="cred-${key}-error" role="alert">${error}</p>` : ''}`;
      };
      const input = (key, label, options = {}) => {
        const invalid = view.touched.has(key) && Boolean(errors()[key]);
        return html`<div class="tc-form-field" data-key="cred-field-${key}"><label class="tc-label" data-key="cred-label-${key}" for="cred-${key}">${label}</label><input class="tc-input tc-input--mono" id="cred-${key}" data-cred-field="${key}" data-key="cred-input-${key}" type="${options.type || 'text'}" value="${view.draft[key] ?? ''}" ${options.max ? html`maxlength="${options.max}"` : ''} ${options.placeholder ? html`placeholder="${options.placeholder}"` : ''}${options.type === 'number' ? raw(' min="1" max="65535" step="1" inputmode="numeric"') : ''} autocomplete="off" autocapitalize="none" spellcheck="false" aria-invalid="${String(invalid)}" aria-describedby="${[options.hint ? 'cred-' + key + '-hint' : '', invalid ? 'cred-' + key + '-error' : ''].filter(Boolean).join(' ')}"${disabled(view.busy)}>${hint(key, options.hint)}</div>`;
      };
      const secret = () => html`<div class="tc-form-field" data-key="cred-field-secret">${view.replacing ? html`<label class="tc-label" for="cred-secret">${view.draft.type === 'ssh' ? 'Password' : 'API key'}</label>` : html`<span class="tc-label">${view.draft.type === 'ssh' ? 'Password' : 'API key'}</span>`}${!view.replacing && view.original ? html`<div class="tc-cred-secret">${icon('circle-check')}<span>Saved <small>${view.original.secretChangedAt ? '· changed ' + S.day(view.original.secretChangedAt) : '· from before the upgrade'}</small></span><button class="tc-btn tc-btn--ghost tc-btn--xs" id="cred-replace" type="button" data-cred-editor="replace"${disabled(view.busy)}>Replace…</button></div>` : html`<div class="tc-input-wrap tc-cred-reveal" data-key="cred-secret-input-wrap"><input class="tc-input" id="cred-secret" data-key="cred-secret-input" data-cred-field="secret" type="${view.revealed ? 'text' : 'password'}" maxlength="8192" autocomplete="new-password" autocapitalize="none" spellcheck="false" aria-invalid="${String(view.touched.has('secret') && Boolean(errors().secret))}" aria-describedby="cred-secret-hint${view.touched.has('secret') && errors().secret ? ' cred-secret-error' : ''}"${disabled(view.busy)}><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs tc-reveal" type="button" data-cred-editor="reveal" aria-label="${view.revealed ? 'Hide' : 'Show'} newly typed ${S.secretKind(view.draft)}" aria-pressed="${String(view.revealed)}"${disabled(view.busy)}>${icon(view.revealed ? 'eye-off' : 'eye')}</button></div>`}${hint('secret', view.original ? 'Leaving the replacement empty keeps the saved ' + S.secretKind(view.draft) + '.' : view.draft.type === 'ssh' ? 'Not shown again after you save. Key-based sign-in isn’t supported yet.' : 'Not shown again after you save. Agents use the credential’s name.')}${view.original && view.replacing ? html`<button class="tc-btn tc-btn--link tc-cred-keep" type="button" data-cred-editor="keep-saved"${disabled(view.busy)}>Keep saved</button>` : ''}</div>`;
      const segment = (key, label, choices) => html`<div class="tc-form-field tc-cred-${key === 'type' ? 'type' : 'auth'}" data-key="cred-field-${key}"><span class="tc-label" id="cred-${key}-label">${label}</span><div class="tc-seg" role="group" aria-labelledby="cred-${key}-label">${choices.map(([value, title, mark]) => html`<button type="button" data-cred-editor="${key}" data-value="${value}" aria-pressed="${String(view.draft[key] === value)}"${disabled(view.busy)}>${mark ? icon(mark) : ''}${title}</button>`)}</div></div>`;
      const fields = () => html`<div class="tc-form">${view.create ? segment('type', 'Type', [['ssh', 'SSH server', 'terminal'], ['api', 'HTTP API', 'globe']]) : ''}${view.create ? input('id', 'Name', { max: 64, hint: Kit.isPhone() ? 'Skills use it, so it can’t change later.' : 'Lowercase letters, numbers and hyphens. Skills use it, so it can’t change later.' }) : html`<div class="tc-form-field" data-key="cred-field-id"><span class="tc-label">Name</span><div class="tc-cred-locked">${icon('lock')}<span>${view.draft.id}</span><span>Can’t change</span></div><p class="tc-hint">${ctx.usageWarnings()?.length ? 'Some skills couldn’t be read.' : 'Mentioned in ' + S.usageCount(view.original) + '.'}</p></div>`}
        ${view.draft.type === 'ssh' ? html`<div class="tc-cred-pair" data-key="cred-ssh-target">${input('host', 'Host', { max: 253, placeholder: '192.0.2.10' })}${input('port', 'Port', { type: 'number' })}</div>${input('username', 'Username', { max: 64, placeholder: 'deploy' })}` : html`${input('baseUrl', 'Base URL', { max: 2048, placeholder: 'https://api.example.com/v1/', hint: 'Include the version or base path. Requests can’t leave it.' })}${segment('authType', 'Authentication', [['bearer', 'Bearer token'], ['header', 'Header'], ['query', 'Query parameter']])}${view.draft.authType === 'header' ? html`<div class="tc-cred-pair tc-cred-pair--even" data-key="cred-header">${input('authName', 'Header name', { max: 128, placeholder: 'X-API-Key' })}${input('authPrefix', 'Value prefix (optional)', { max: 128, placeholder: 'None' })}</div>` : view.draft.authType === 'query' ? input('authName', 'Parameter name', { max: 128, placeholder: 'api_key', hint: 'Prefer a header when the service supports one: query keys can appear in its logs.' }) : ''}`}${secret()}</div>`;
      const result = () => {
        const profile = { ...view.draft, hostKey: view.scanned && view.trusted ? view.scanned.presented : view.original?.hostKey || (view.result ? {} : null), test: view.result };
        const state = view.result ? S.state(profile) : null, key = view.scanned?.presented;
        return html`<div class="tc-cred-test" data-key="cred-draft-result" aria-busy="${String(view.busy === 'test')}">${view.busy === 'test' ? html`<p class="tc-hint" role="status"><span class="tc-spinner" aria-hidden="true"></span>Testing…</p>` : ''}${key ? html`<div class="tc-cred-hostkey tc-cred-hostkey--first"><strong>${view.scanned.state === 'changed' ? 'Different host key from ' : 'First connection to '}${view.draft.host}</strong><span class="tc-cred-fp">${S.keyType(key.type)} ${key.fingerprint}</span>${Kit.isPhone() ? html`<details class="tc-cred-compare" data-key="cred-compare"${view.compareOpen ? raw(' open') : ''}><summary>Compare with the server’s key</summary><code>${S.keyCommand(key.type)}</code></details>` : html`<span>Compare it with the server’s own:</span><code>${S.keyCommand(key.type)}</code>`}<label class="tc-cred-check"><input class="tc-checkbox" type="checkbox" data-cred-editor="trust"${checked(view.trusted)}${disabled(view.busy)}>Trust this host key</label></div>` : ''}${state && !['host-key-untrusted', 'host-key-changed'].includes(state.code) ? html`<div class="tc-cred-test-line" data-tone="${state.tone}" role="status">${icon(state.icon || 'info')}<span>${view.result.ok && view.draft.type === 'ssh' ? 'Signed in as ' + view.draft.username : state.label}</span><small>${view.result.ms >= 1000 ? (view.result.ms / 1000).toFixed(1) + ' s' : view.result.ms + ' ms'}</small></div>${!view.result.ok ? html`<p class="tc-hint" role="status">${state.desc}</p>` : ''}` : !key && view.busy !== 'test' ? html`<p class="tc-hint">Test the login before saving it. Nothing is saved by a draft test.</p>` : ''}${view.result?.code === 'host-key-changed' && !view.trusted ? html`<p class="tc-hint tc-warning" role="alert">The host key differs. Compare the fingerprint before trusting it.</p>` : ''}</div>`;
      };
      const testButton = (phone = false) => html`<button class="tc-btn ${phone ? '' : 'tc-btn--xs'}" type="button" data-cred-editor="test"${disabled(view.busy || !valid())}>${view.busy === 'test' ? html`<span class="tc-spinner" aria-hidden="true"></span>Testing…` : html`${phone ? '' : icon('refresh-cw')}${view.result ? 'Test again' : 'Test'}`}</button>`;
      const testSection = () => html`<section class="tc-cred-rail-block" data-key="cred-test-section"><h3 class="${Kit.isPhone() ? 'tc-sr' : 'tc-insp-label'}">Test before saving<span class="tc-spacer"></span>${Kit.isPhone() ? '' : testButton()}</h3>${view.draft.type === 'api' ? html`${input('testPath', 'GET test path (optional)', { max: 2048, placeholder: 'account', hint: 'Pick an endpoint that needs the key: a public one answers without it. Blank tests the base URL.' })}` : ''}${result()}</section>`;
      const rail = () => html`<details class="tc-wizard-rail-wrap" data-key="cred-rail"${!Kit.isPhone() || view.railOpen ? raw(' open data-open') : ''}><summary class="tc-wizard-rail-toggle">Agents run <code>${(view.draft.type === 'ssh' ? 't3-ssh ' : 't3-api ') + (view.draft.id || 'name')}</code>${icon('chevron-down')}</summary><aside class="tc-wizard-rail"><section class="tc-cred-rail-block"><h3 class="tc-insp-label">Agents run</h3><ul class="tc-group tc-cred-cmds"><li><code>${S.commands(view.draft, true)[0]}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-cred-editor="copy" aria-label="Copy draft command">${icon('copy')}</button></li></ul><p class="tc-hint">${view.draft.type === 'ssh' ? 'The password never appears in the command. The helper filters it from output.' : 'The helper adds the key. Paths stay under the base URL; redirects are never followed.'}</p></section>${view.draft.type === 'api' ? html`<section class="tc-cred-rail-block"><h3 class="tc-insp-label">Every request sends</h3>${T3CredentialInspector.requestPreview(view.draft, true)}</section>` : ''}${!Kit.isPhone() ? testSection() : ''}${view.original ? html`<section class="tc-cred-rail-block"><h3 class="tc-insp-label">When you save</h3>${view.original.usedIn?.length ? html`<div class="tc-group">${view.original.usedIn.map(item => html`<div class="tc-cred-skill"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('book-open')}</span><div><strong>${item.name}</strong><small>Next run uses the new details</small></div></div>`)}</div>` : html`<p class="tc-hint">${ctx.usageWarnings()?.length ? 'Some skills couldn’t be read.' : 'Not in a skill yet.'}</p>`}${view.original.hostKey ? html`<div class="tc-cred-hostkey"><strong>Trusted host key</strong><span class="tc-cred-fp">${S.keyType(view.original.hostKey.type)} ${view.original.hostKey.fingerprint}</span><span>Changing the host or port forgets it; the next test asks you to trust the new one.</span></div>` : ''}</section>` : ''}</aside></details>`;
      const conflict = () => !view.conflict ? '' : html`<div class="tc-notice tc-notice--warn tc-cred-conflict" role="alert" tabindex="-1" id="cred-conflict">${icon('triangle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">${view.conflict.code === 'gone' ? 'Deleted in another window' : 'Changed in another window at ' + new Date(view.conflict.current.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</strong>${view.conflict.current ? html`${S.changes(view.original, view.conflict.current).map(field => html`<p class="tc-cred-diffline">${S.fieldLabel(field)}: <del>${String(view.original[field] ?? '') || 'None'}</del> → <ins>${String(view.conflict.current[field] ?? '') || 'None'}</ins></p>`)}${view.original.secretChangedAt !== view.conflict.current.secretChangedAt ? html`<p>Its ${S.secretKind(view.original)} was replaced.</p>` : ''}<span class="tc-notice-desc">Saving here would put your details back.</span><div class="tc-cred-conflict-actions"><button class="tc-btn tc-btn--sm" type="button" data-cred-editor="theirs">Use theirs</button><button class="tc-btn tc-btn--sm" type="button" data-cred-editor="mine">Keep mine</button></div>` : html`<span class="tc-notice-desc">The saved login was deleted. Your draft is still here.</span><div class="tc-cred-conflict-actions"><button class="tc-btn tc-btn--sm" type="button" data-cred-editor="new">Save as new</button><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-cred-editor="close">Close</button></div>`}</div></div>`;
      const submit = async () => {
        if (view.busy || active !== view || view.conflict) return;
        if (!valid()) { Object.keys(errors()).forEach(key => view.touched.add(key)); paint(); view.layer.panel.querySelector('[aria-invalid="true"]')?.focus(); return; }
        if (view.original && !dirty()) return;
        view.busy = 'save'; view.error = null; paint();
        const credential = { ...S.payload(view.draft), ...(view.secret ? { secret: view.secret } : {}) };
        const response = await ctx.api(view.create ? '/credentials/create' : '/credentials/save', { body: { credential, ...(!view.create ? { revision: view.revision } : {}), ...(view.trusted && view.scanned ? { trust: { fingerprint: view.scanned.presented.fingerprint } } : {}) } });
        delete credential.secret;
        if (active !== view) return;
        if (!response.ok) {
          view.busy = null;
          if (['changed', 'gone'].includes(response.data?.code)) view.conflict = response.data;
          else if (response.data?.code === 'taken') { view.taken = true; view.touched.add('id'); }
          else view.error = response.error || 'Couldn’t save this credential. Your draft is still here.';
          paint(); (view.layer.panel.querySelector('#cred-conflict, #cred-editor-error') || view.layer.panel.querySelector('[aria-invalid="true"]'))?.focus({ preventScroll: true }); return;
        }
        const id = view.draft.id, failedTrust = response.data.trust?.ok === false;
        const refreshed = await ctx.saved(response.data.credential);
        if (active !== view) return;
        view.busy = null; view.layer.close('saved');
        Kit.toast(id + ' saved', !refreshed ? { tone: 'warn', detail: 'Saved, but the list could not be refreshed. Try again on the Credentials page.' } : failedTrust ? { tone: 'warn', detail: 'Its host key could not be trusted. Review it before agents connect.', action: { label: 'Review', run: () => ctx.review(id) } } : undefined);
      };
      const test = async () => {
        if (view.busy || !valid()) return;
        view.busy = 'test'; view.error = null; const generation = ++view.generation; paint();
        const draft = { ...S.payload(view.draft), ...(view.secret ? { secret: view.secret } : {}) };
        const response = await ctx.api('/credentials/test', { body: { draft, ...(!view.create ? { id: view.draft.id } : {}), ...(view.trusted && view.scanned ? { trust: { fingerprint: view.scanned.presented.fingerprint } } : {}) } });
        delete draft.secret;
        if (active !== view || generation !== view.generation) return;
        view.busy = null;
        if (!response.ok || !response.data.result) view.error = response.error || 'The test could not finish. Your draft is still here.';
        else {
          view.result = response.data.result;
          if (view.result.hostKey) { view.scanned = view.result.hostKey; view.trusted = false; }
          else if (view.result.code === 'host-key-changed' && view.result.detail?.presented) { view.scanned = { state: 'changed', presented: view.result.detail.presented, trusted: view.result.detail.trusted }; view.trusted = false; }
          Kit.announce(view.result.ok ? 'Connection succeeded. This draft is not saved yet.' : S.state({ ...view.draft, hostKey: view.original?.hostKey, test: view.result }).label);
        }
        paint();
        if (Kit.isPhone()) (view.layer.panel.querySelector(view.error ? '#cred-editor-error' : '.tc-cred-test-line') || view.layer.panel.querySelector('.tc-cred-hostkey--first'))?.scrollIntoView({ block: 'nearest' });
      };
      view.layer = Kit.open({ kind: 'center', backdrop: 'ignore', panel: { tag: 'form', class: 'tc-wizard tc-cred-editor', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cred-editor-title', autocomplete: 'off', novalidate: true }, focus: replace ? '#cred-secret' : profile ? '#cred-host, #cred-baseUrl' : '#cred-id', onEscape: () => { void view.close('escape'); }, onClose: () => {
        view.generation++; view.secret = ''; view.revealed = false;
        const secret = view.layer.panel.querySelector('#cred-secret'); if (secret) { secret.value = ''; secret.type = 'password'; }
        window.removeEventListener('beforeunload', beforeUnload); if (active === view) active = null;
      }, render: () => html`<div class="tc-wizard-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(view.create ? 'key-round' : view.draft.type === 'ssh' ? 'terminal' : 'globe')}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="cred-editor-title">${view.create ? 'Add credential' : 'Edit ' + view.draft.id}</h2><span class="tc-small tc-muted">${view.create ? 'Save a login once. Agents use it by name.' : (view.draft.type === 'ssh' ? 'SSH server' : 'HTTP API') + ' · ' + (view.original.usedIn?.length ? 'used in ' + M.listOf(view.original.usedIn.map(item => item.name)) : ctx.usageWarnings()?.length ? 'usage partly checked' : 'not in a skill yet')}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cred-editor="close" aria-label="Close credential editor"${disabled(view.busy)}>${icon('x')}</button></div><div class="tc-wizard-grid"><div class="tc-wizard-main">${conflict()}${fields()}${Kit.isPhone() ? testSection() : ''}</div>${rail()}</div>${view.error ? html`<div class="tc-cred-editor-error tc-hint tc-danger" role="alert" tabindex="-1" id="cred-editor-error">${view.error}</div>` : ''}<div class="tc-wizard-foot"><span class="tc-hint tc-wizard-keyboard">${icon('lock', 'tc-icon--sm')}Saved on this server, in plain text.</span>${Kit.isPhone() ? html`${testButton(true)}<span class="tc-spacer"></span>` : html`<span class="tc-spacer"></span><button class="tc-btn" type="button" data-cred-editor="close"${disabled(view.busy)}>Cancel</button>`}<button class="tc-btn tc-btn--primary" type="submit" data-cred-editor="save"${disabled(!canSave())}>${view.busy === 'save' ? html`<span class="tc-spinner" aria-hidden="true"></span>Saving…` : view.create ? 'Save credential' : 'Save changes'}</button></div>` });
      sync();
      view.layer.panel.addEventListener('submit', event => { event.preventDefault(); void submit(); });
      view.layer.panel.addEventListener('input', event => {
        const key = event.target.dataset.credField; if (!key || view.busy) return;
        if (key === 'secret') view.secret = event.target.value;
        else { view.draft[key] = key === 'id' ? event.target.value.toLowerCase().replace(/\s/g, '-') : event.target.value; if (key === 'id') { view.taken = false; event.target.value = view.draft.id; } }
        view.generation++; view.result = null; view.error = null;
        if (['host', 'port'].includes(key)) { view.scanned = null; view.trusted = false; }
        paint();
      });
      view.layer.panel.addEventListener('focusout', event => {
        const key = event.target.dataset.credField; if (!key || view.busy) return;
        view.touched.add(key); paint();
      });
      view.layer.panel.addEventListener('toggle', event => {
        if (event.target.matches('.tc-cred-compare')) { view.compareOpen = event.target.open; return; }
        if (!event.target.matches('.tc-wizard-rail-wrap') || !Kit.isPhone()) return;
        view.railOpen = event.target.open; event.target.toggleAttribute('data-open', view.railOpen);
      }, true);
      view.layer.panel.addEventListener('click', async event => {
        const button = event.target.closest('[data-cred-editor]'); if (!button || button.disabled || button.tagName === 'INPUT') return;
        const action = button.dataset.credEditor;
        if (action === 'close') return void view.close('close');
        if (view.busy) return;
        if (action === 'copy') return void Kit.copy(S.commands(view.draft, true)[0], button, 'Draft command copied');
        if (action === 'test') return void test();
        if (action === 'replace') { view.replacing = true; paint(); view.layer.panel.querySelector('#cred-secret')?.focus(); return; }
        if (action === 'keep-saved') { view.secret = ''; view.replacing = false; view.revealed = false; view.touched.delete('secret'); view.result = null; paint(); view.layer.panel.querySelector('#cred-replace')?.focus(); return; }
        if (action === 'reveal') { view.revealed = !view.revealed; paint(); return; }
        if (action === 'type') { const id = view.draft.id; view.draft = { ...S.defaults(button.dataset.value), id }; view.secret = ''; view.scanned = null; view.trusted = false; view.result = null; view.touched.clear(); view.revealed = false; paint(); return; }
        if (action === 'authType') { view.draft.authType = button.dataset.value; view.draft.authName = button.dataset.value === 'query' ? 'api_key' : 'X-API-Key'; view.draft.authPrefix = ''; view.result = null; view.touched.delete('authName'); paint(); return; }
        if (action === 'theirs') {
          const current = view.conflict.current, keep = view.original.secretChangedAt === current.secretChangedAt;
          view.secret = keep ? view.secret : ''; view.replacing = Boolean(view.secret); view.revealed = false; view.original = current; view.draft = S.draftOf(current); view.revision = current.revision; view.conflict = null; view.scanned = null; view.trusted = false; view.result = null; view.touched.clear(); paint(); return;
        }
        if (action === 'mine') { view.revision = view.conflict.current.revision; view.conflict = null; return void submit(); }
        if (action === 'new') { view.recreateId = view.draft.id; view.create = true; view.original = null; view.conflict = null; view.revision = undefined; view.replacing = true; paint(); if (valid()) void submit(); else view.layer.panel.querySelector('#cred-secret')?.focus(); }
      });
      view.layer.panel.addEventListener('change', event => {
        if (event.target.dataset.credEditor !== 'trust' || view.busy) return;
        view.trusted = event.target.checked; view.result = null; paint(); if (view.trusted) void test();
      });
      view.layer.panel.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } });
    };
    return { open, close, repaint: () => active?.repaint(), beforeNavigate: () => close('route'), isOpen: () => Boolean(active) };
  };
  return { create };
})();
