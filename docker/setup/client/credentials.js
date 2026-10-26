// Saved secrets are write-only. Only the newly typed replacement lives in
// the dialog's input; it is never rendered, cached or copied into instructions.
const T3CredentialsUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const disabled = value => value ? raw(' disabled') : '';
  const create = ({ api, render }) => {
    let data = null, loading = false, error = null, started = false, epoch = 0, editor = null, notice = null;
    const busy = new Set(), results = new Map();
    const notify = (message, options) => { notice?.close(); notice = Kit.toast(message, options); };
    const paint = () => {
      render();
      const mount = document.getElementById('credential-list');
      if (mount) Kit.patch(mount, body());
    };
    const load = async () => {
      const version = ++epoch;
      started = true; loading = true; error = null; paint();
      const response = await api('/credentials');
      if (version !== epoch) return;
      if (response.ok && Array.isArray(response.data?.profiles)) data = response.data;
      else error = response.error || 'Could not load saved connections.';
      loading = false; paint();
    };
    const command = profile => profile.type === 'ssh' ? 't3-ssh ' + profile.id + ' -- uptime' : 't3-api ' + profile.id + ' GET ' + T3McpCommand.quote(profile.testPath || '');
    const body = () => html`
      <div class="tc-credential-toolbar"><span class="tc-small tc-muted">${data ? T3Model.plural(data.profiles.length, 'saved connection') : 'Saved connections'}</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-credential-action="reload"${disabled(loading)}>${icon('refresh-cw')}Reload</button><button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-credential-action="add"${disabled(!data || loading || error)}>${icon('plus')}Add connection</button></div>
      ${error ? html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">Could not load connections</strong><span class="tc-notice-desc">${error} Use Reload to try again.</span></div></div>` : ''}
      ${!data ? html`<div class="tc-group"><div class="tc-empty tc-empty--compact" role="status"><span class="tc-empty-title">${loading ? 'Loading connections…' : 'Connections unavailable'}</span></div></div>` : data.profiles.length ? html`<div class="tc-group tc-credential-list">${data.profiles.map(profile => html`
        <article class="tc-credential-row" data-key="credential-${profile.id}">
          <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(profile.type === 'ssh' ? 'terminal' : 'key-round')}</span>
          <div class="tc-credential-main"><strong>${profile.label}</strong><span class="tc-small tc-muted tc-credential-address">${profile.type === 'ssh' ? profile.username + '@' + profile.host + ':' + profile.port : profile.baseUrl}</span><div class="tc-copyfield tc-credential-usage"><code class="tc-copyfield-value tc-credential-command">${command(profile)}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-credential-action="copy" data-id="${profile.id}" aria-label="Copy skill command for ${profile.label}" title="Copy command for a skill">${icon('copy')}</button></div><span class="tc-small tc-muted">${profile.type === 'ssh' ? 'Password saved' : profile.authType === 'header' ? 'Header key saved' : profile.authType === 'query' ? 'Query key saved' : 'Bearer token saved'} · <span aria-label="Saved value is hidden">••••••••</span></span>${results.has(profile.id) ? html`<span class="tc-small ${results.get(profile.id).ok ? 'tc-ok' : 'tc-danger'}" role="status">${results.get(profile.id).message}</span>` : ''}</div>
          <div class="tc-credential-actions"><button class="tc-btn tc-btn--sm" type="button" data-credential-action="test" data-id="${profile.id}"${disabled(busy.has(profile.id) || loading || error)} aria-label="Test ${profile.label}">${busy.has(profile.id) ? html`<span class="tc-spinner" aria-hidden="true"></span>Testing…` : 'Test'}</button><button class="tc-btn tc-btn--sm" type="button" data-key="credential-edit-${profile.id}" data-credential-action="edit" data-id="${profile.id}"${disabled(busy.has(profile.id) || loading || error)}>Edit<span class="tc-sr"> ${profile.label}</span></button><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-credential-action="remove" data-id="${profile.id}"${disabled(busy.has(profile.id) || loading || error)} aria-label="Delete ${profile.label}">${icon('trash-2')}</button></div>
        </article>`)}</div>` : html`<div class="tc-group"><div class="tc-empty"><span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('key-round')}</span><strong class="tc-empty-title">Save a connection once</strong><p class="tc-empty-desc">Keep SSH passwords and API keys here. Your skills use the connection ID, so credentials stay out of instructions and chat.</p><button class="tc-btn tc-btn--primary" type="button" data-credential-action="add"${disabled(loading || error)}>${icon('plus')}Add connection</button></div></div>`}
      <p class="tc-hint tc-credential-note">${icon('lock-keyhole', 'tc-icon--sm')}Saved on this server. Values are hidden from the page and filtered from helper output. Any agent with shell access can use these connections.</p>`;

    const openEditor = profile => {
      if (editor || !data || error || loading) return;
      notice?.close(); notice = null;
      const view = { original: profile, revision: data.revision, draft: profile ? { ...profile } : { id: '', label: '', type: 'ssh', host: '', username: '', port: 22, baseUrl: '', authType: 'bearer', authName: 'X-API-Key', authPrefix: '', testPath: '' }, busy: false, error: null };
      editor = view;
      const field = (key, label, options = {}) => html`<div class="tc-form-field" data-key="credential-field-${key}${key === 'authName' ? '-' + view.draft.authType : ''}"><label class="tc-label" for="credential-${key}">${label}</label><input class="tc-input" id="credential-${key}" data-credential-field="${key}" value="${view.draft[key] || ''}" type="${options.type || 'text'}"${options.required === false ? '' : raw(' required')}${disabled(view.busy || options.locked)}${options.max ? html` maxlength="${options.max}"` : ''}${options.type === 'number' ? raw(' min="1" max="65535"') : ''} autocomplete="off" autocapitalize="off" spellcheck="false">${options.hint ? html`<p class="tc-hint">${options.hint}</p>` : ''}</div>`;
      const markup = () => html`<div class="tc-dialog-body">
        <h2 class="tc-dialog-title" id="credential-title">${profile ? 'Edit connection' : 'Add connection'}</h2><p class="tc-dialog-desc">${profile ? 'Leave the secret blank to keep its saved value.' : 'Save the login here, then use its connection ID in your skills.'}</p>
        <div class="tc-form">
          ${field('label', 'Name', { max: 120 })}
          ${field('id', 'Connection ID', { locked: Boolean(profile), max: 64, hint: 'Lowercase letters, numbers and hyphens. Used in helper commands.' })}
          <div class="tc-form-field" data-key="credential-field-type"><label class="tc-label" for="credential-type">Connection type</label><select class="tc-select" id="credential-type" data-credential-field="type"${disabled(view.busy || profile)}><option value="ssh"${view.draft.type === 'ssh' ? raw(' selected') : ''}>SSH password</option><option value="api"${view.draft.type === 'api' ? raw(' selected') : ''}>API key or token</option></select></div>
          ${view.draft.type === 'ssh' ? html`${field('host', 'Host', { max: 253 })}<div class="tc-credential-fields" data-key="credential-ssh-login">${field('username', 'Username', { max: 64 })}${field('port', 'Port', { type: 'number' })}</div>` : html`
            ${field('baseUrl', 'API base URL', { max: 2048, hint: 'Include the API version or base path, for example https://api.example.com/v1/.' })}
            <div class="tc-form-field" data-key="credential-field-authType"><label class="tc-label" for="credential-authType">Authentication</label><select class="tc-select" id="credential-authType" data-credential-field="authType"${disabled(view.busy)}>${[['bearer', 'Bearer token'], ['header', 'Custom header'], ['query', 'Query parameter']].map(([value, label]) => html`<option value="${value}"${(view.draft.authType || 'bearer') === value ? raw(' selected') : ''}>${label}</option>`)}</select></div>
            ${view.draft.authType === 'header' ? html`${field('authName', 'Header name', { max: 128, hint: 'For example X-API-Key, api-key or Authorization.' })}${field('authPrefix', 'Value prefix (optional)', { max: 128, required: false, hint: 'For example Token. Leave blank to send the key as the complete header value.' })}` : view.draft.authType === 'query' ? field('authName', 'Query parameter name', { max: 128, hint: 'For APIs that require a key in the URL. Prefer a header when supported.' }) : ''}
            ${field('testPath', 'Test path (optional)', { max: 2048, required: false, hint: 'A relative GET endpoint that requires authentication; blank uses the base URL.' })}`}
          <div class="tc-form-field" data-key="credential-field-secret"><label class="tc-label" for="credential-secret">${view.draft.type === 'ssh' ? 'SSH password' : 'API key or token'}</label><input class="tc-input" id="credential-secret" name="secret" type="password" maxlength="8192" autocomplete="new-password" spellcheck="false" autocapitalize="off"${profile ? '' : raw(' required')}${disabled(view.busy)} aria-describedby="credential-secret-note"><p class="tc-hint" id="credential-secret-note">${profile ? 'A value is saved. Enter a replacement only if you want to change it.' : 'This value will not appear in the saved connection details.'}</p></div>
        </div>${view.error ? html`<p class="tc-hint tc-danger" id="credential-error" role="alert" tabindex="-1">${view.error}</p>` : ''}
      </div><div class="tc-dialog-foot"><button class="tc-btn" type="button" data-credential-cancel${disabled(view.busy)}>Cancel</button><button class="tc-btn tc-btn--primary" type="submit"${disabled(view.busy)}>${view.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>Saving…` : 'Save connection'}</button></div>`;
      const close = () => { if (!view.busy) view.layer.close(); };
      view.layer = Kit.open({ kind: 'center', backdrop: 'ignore', focus: '#credential-label',
        panel: { tag: 'form', class: 'tc-dialog tc-credential-editor', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'credential-title', autocomplete: 'off' },
        render: markup, onEscape: close, onClose: () => { const input = view.layer.panel.querySelector('#credential-secret'); if (input) input.value = ''; if (editor === view) editor = null; },
      });
      view.layer.panel.addEventListener('input', event => {
        const key = event.target.dataset.credentialField;
        if (key && !view.busy) view.draft[key] = event.target.value;
      });
      view.layer.panel.addEventListener('change', event => {
        if (event.target.dataset.credentialField === 'type' && !view.busy) { view.draft.type = event.target.value; view.layer.render(); }
        if (event.target.dataset.credentialField === 'authType' && !view.busy) { view.draft.authType = event.target.value; view.draft.authName = event.target.value === 'query' ? 'api_key' : 'X-API-Key'; view.draft.authPrefix = ''; view.layer.render(); }
      });
      view.layer.panel.addEventListener('click', event => { if (event.target.closest('[data-credential-cancel]')) close(); });
      view.layer.panel.addEventListener('submit', async event => {
        event.preventDefault();
        if (view.busy || editor !== view) return;
        const secretInput = view.layer.panel.querySelector('#credential-secret');
        const payload = { ...view.draft, port: Number(view.draft.port), secret: secretInput.value || undefined };
        view.busy = true; view.error = null; view.layer.render();
        const response = await api(profile ? '/credentials/save' : '/credentials/create', { body: { profile: payload, revision: view.revision } });
        delete payload.secret;
        if (response.ok) {
          secretInput.value = ''; results.delete(view.draft.id);
          if (editor === view) { view.busy = false; view.layer.close('saved'); }
          notify('Connection saved'); await load();
        } else if (editor === view) {
          view.busy = false; view.error = response.error; view.layer.render();
          view.layer.panel.querySelector('#credential-error')?.focus();
        }
      });
    };
    document.addEventListener('click', async event => {
      const button = event.target.closest('[data-credential-action]');
      if (!button || button.disabled) return;
      const action = button.dataset.credentialAction, profile = data?.profiles.find(row => row.id === button.dataset.id);
      if (action === 'reload') { void load(); return; }
      if (action === 'add') { openEditor(); return; }
      if (action === 'copy' && profile) { void Kit.copy(command(profile), button, 'Skill command copied'); return; }
      if (!profile || busy.has(profile.id) || error) return;
      if (action === 'edit') { openEditor(profile); return; }
      const revision = data.revision;
      if (action === 'remove') {
        const yes = await Kit.confirm({ title: 'Delete ' + profile.label + '?', body: 'Removes the saved login. Skills using ' + profile.id + ' will need another connection.', confirm: 'Delete connection', tone: 'danger' });
        if (!yes || busy.has(profile.id)) return;
      }
      busy.add(profile.id); results.delete(profile.id); paint();
      const response = await api('/credentials/' + action, { body: { id: profile.id, revision } });
      busy.delete(profile.id);
      if (action === 'test') results.set(profile.id, { ok: response.ok, message: response.ok ? 'Connection succeeded' : response.error });
      else if (response.ok) notify('Connection deleted');
      else notify('Could not delete connection', { tone: 'danger', detail: response.error });
      await load();
    });
    return { content: () => html`<div id="credential-list" data-keep>${body()}</div>`, activate: (force = false) => { if (!loading && (force || !started)) void load(); } };
  };
  return { create };
})();
