// On-demand credentials library. Polling never replaces focused inputs or a
// draft, and an item stays pending until its saved truth has been read back.
const T3CredentialsUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3CredentialModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const create = ({ api, getStatus = () => null, render, onChange = async () => {} }) => {
    let data = null, error = null, query = '', attentionOnly = false, started = false, loading = false, inFlight = null, epoch = 0, lastDeep = null;
    const busy = new Map(), errors = new Map();
    const rows = () => [...(data?.credentials || [])].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    const row = id => data?.credentials.find(row => row.id === id);
    const usageWarnings = () => data?.usageWarnings || [];
    const attention = () => rows().filter(profile => S.needsAttention(profile, getStatus()?.credentials?.attention));
    const testing = () => [...busy.values()].filter(value => value.kind === 'test').length;
    const paint = () => { render(); const mount = document.getElementById('credential-list'); if (mount) Kit.patch(mount, body()); inspector.repaint(); };
    const load = (force = false) => {
      if (inFlight && !force) return inFlight;
      const version = ++epoch; started = true; loading = true; error = null; paint();
      const work = api('/credentials').then(response => {
        if (version !== epoch) return false;
        if (response.ok && Array.isArray(response.data?.credentials)) { data = response.data; return true; }
        error = response.error || 'Saved credentials could not be read. Restore the credential file before making changes.'; data = null; return false;
      }).finally(() => { if (version === epoch) { loading = false; inFlight = null; paint(); } });
      inFlight = work; return work;
    };
    const request = async (id, kind, route, input, { refresh = true } = {}) => {
      if (busy.has(id)) return null;
      const focused = document.activeElement?.getAttribute('data-key');
      busy.set(id, { kind }); errors.delete(id); paint();
      let response;
      try {
        response = await api(route, { body: input });
        if (!response.ok) errors.set(id, response.error || 'This action did not finish. Try again.');
        if (refresh) await Promise.all([load(true), onChange()]);
        return response;
      } finally {
        busy.delete(id); paint();
        if (focused && document.activeElement === document.body) document.querySelector('[data-key="' + CSS.escape(focused) + '"]')?.focus({ preventScroll: true });
      }
    };
    const inspect = id => { if (row(id)) inspector.open(id); };
    const edit = async (id, replace = false) => {
      if (id && busy.has(id) || error) return;
      const profile = id ? row(id) : null; if (id && !profile) return;
      inspector.close('edit'); await editor.open(profile, { replace });
    };
    const ctx = { api, busy, errors, rows, row, usageWarnings, loadError: () => error, refresh: () => load(true), request,
      saved: async credential => {
        if (data) data.credentials = [...data.credentials.filter(row => row.id !== credential.id), { ...credential, usedIn: row(credential.id)?.usedIn || [] }];
        errors.delete(credential.id); const [loaded] = await Promise.all([load(true), onChange()]); return loaded;
      },
      deleted: id => {
        if (inspector.id() === id) inspector.close('removed');
        if (location.hash === '#credentials/' + id) history.replaceState(null, '', '#credentials');
        paint();
        requestAnimationFrame(() => {
          const next = document.querySelector('#credential-list [data-cred-action="inspect"], #credential-list [data-cred-action="add"], #credential-list [data-cred-action="retry"]');
          next?.focus({ preventScroll: true });
        });
      },
      inspectorClosed: (id, reason) => { if (!['route', 'replaced'].includes(reason) && location.hash === '#credentials/' + id) { history.replaceState(null, '', '#credentials'); lastDeep = null; } },
      action: (action, id, button) => { void actionFor(action, id, button); }, menu: (button, profile, details) => menu(button, profile, details), review: id => dialogs.review(id),
    };
    const inspector = T3CredentialInspector.create(ctx), editor = T3CredentialEditor.create(ctx), dialogs = T3CredentialDialogs.create(ctx);
    const actionFor = async (action, id, button) => {
      if (action === 'add') { if (!data && !await load()) return; return edit(); }
      if (action === 'retry') return load(true).then(loaded => { if (loaded) return activate(); });
      if (action === 'clear') { query = ''; attentionOnly = false; paint(); const input = document.getElementById('credential-search'); if (input) input.value = ''; return; }
      if (action === 'attention') { attentionOnly = !attentionOnly; paint(); return; }
      const profile = row(id); if (!profile) return;
      if (action === 'inspect') return inspect(id);
      if (action === 'menu') return menu(button, profile);
      if (action === 'copy-name') return Kit.copy(profile.id, button, 'Credential name copied');
      if (action === 'copy-command') return Kit.copy(S.commands(profile)[0], button, 'Command copied');
      if (busy.has(id) || error) return;
      if (action === 'edit' || action === 'replace') return edit(id, action === 'replace');
      if (action === 'review') { if (profile.test?.code === 'host-key-changed' || !profile.hostKey && inspector.id() === id) return dialogs.review(id); return inspect(id); }
      if (action === 'delete') return dialogs.remove(id);
      if (action === 'forget') return dialogs.forget(id);
      if (action === 'test') {
        if (testing() >= 3) return Kit.announce('Three tests are already running. Wait for one to finish.');
        const response = await request(id, 'test', '/credentials/test', { id });
        if (response?.ok && response.data.result) Kit.announce(response.data.result.ok ? id + ' connected.' : id + ': ' + M.credentialProblem(response.data.result.code));
      }
    };
    const menu = (button, profile, details = false) => Kit.menu(button, { label: 'More for ' + profile.id, head: profile.id, items: [
      { label: 'Test', icon: 'refresh-cw', disabled: busy.has(profile.id) || testing() >= 3, run: () => actionFor('test', profile.id, button) },
      { label: 'Edit…', icon: 'pencil', disabled: busy.has(profile.id), run: () => edit(profile.id) },
      { label: 'Copy name', icon: 'copy', run: () => actionFor('copy-name', profile.id, button) },
      { label: 'Copy command', icon: 'terminal', run: () => actionFor('copy-command', profile.id, button) },
      ...(details && profile.type === 'ssh' && profile.hostKey ? [{ label: 'Forget host key…', icon: 'shield-alert', disabled: busy.has(profile.id), run: () => dialogs.forget(profile.id) }] : []),
      { sep: true }, { label: 'Delete…', icon: 'trash-2', danger: true, disabled: busy.has(profile.id), run: () => dialogs.remove(profile.id) },
    ] });
    const footer = () => html`<div class="tc-card-foot tc-cred-storage">${icon('lock', 'tc-icon--sm')}<span>${Kit.isPhone() ? 'Saved in plain text on this server. Chats and skills only need the name.' : 'Saved in plain text on this server’s volume. Anything running here can read them; chats and skills only need the name.'}</span></div>`;
    const nameBadge = profile => html`<span class="tc-badge">${profile.type === 'ssh' ? 'SSH' : 'API'}</span>`;
    const rowState = profile => S.state(profile, { busy: busy.get(profile.id)?.kind === 'test' });
    const dot = tone => html`<span class="tc-dot${['ok', 'warn', 'danger'].includes(tone) ? ' tc-dot--' + tone : ''}" aria-hidden="true"></span>`;
    const primary = profile => {
      const state = rowState(profile), action = state.action.startsWith('Review') ? 'review' : state.action.startsWith('Replace') ? 'replace' : state.action.startsWith('Edit') ? 'edit' : 'test';
      return html`<button class="tc-btn tc-btn--sm" type="button" data-key="cred-primary-${profile.id}" data-cred-action="${action}" data-id="${profile.id}" aria-label="${state.action.replace('…', '')} ${profile.id}"${disabled(busy.has(profile.id) || action === 'test' && testing() >= 3)}>${busy.get(profile.id)?.kind === 'test' ? html`<span class="tc-spinner" aria-hidden="true"></span>Testing…` : state.action}</button>`;
    };
    const item = profile => {
      const state = rowState(profile), pending = busy.has(profile.id);
      if (Kit.isPhone()) return html`<button class="tc-prow tc-cred-prow" type="button" data-key="cred-name-${profile.id}" data-cred-action="inspect" data-id="${profile.id}" aria-label="${profile.id}: ${state.label}" aria-busy="${String(pending)}"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(profile.type === 'ssh' ? 'terminal' : 'globe')}</span><span class="tc-prow-name">${profile.id}${nameBadge(profile)}</span><span class="tc-mcp-detail">${S.target(profile)}</span><span class="tc-cred-state-line" data-tone="${state.tone}">${pending ? html`<span class="tc-spinner" aria-hidden="true"></span>` : dot(state.tone)}<span>${state.label}${state.sub && state.at ? html` <small>· ${state.sub}</small>` : ''}</span></span>${icon('chevron-right')}</button>`;
      return html`<div class="tc-row tc-cred-row" data-key="cred-row-${profile.id}" data-tone="${state.code === 'host-key-changed' ? 'warn' : ''}" aria-busy="${String(pending)}"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(profile.type === 'ssh' ? 'terminal' : 'globe')}</span><div class="tc-row-main tc-cred-main"><div class="tc-cred-name"><button type="button" data-cred-action="inspect" data-id="${profile.id}" data-key="cred-name-${profile.id}">${profile.id}</button>${nameBadge(profile)}</div><span class="tc-mcp-detail" title="${S.target(profile)}">${icon(profile.type === 'ssh' ? 'server' : 'globe')}<code>${S.target(profile)}</code></span><div class="tc-cred-meta"><span class="tc-keys"><span class="tc-key" title="${S.kind(profile)}">${icon('key-round')}${S.kind(profile)}</span></span>${!usageWarnings().length || profile.usedIn?.length ? html`<span class="tc-cred-used">${icon('book-open')}<span>${profile.usedIn?.length ? html`Used in <b>${profile.usedIn.map(item => item.name).join(', ')}</b>` : 'Not in a skill yet'}</span></span>` : ''}</div>${errors.get(profile.id) ? html`<span class="tc-hint tc-danger" role="alert">${errors.get(profile.id)}</span>` : ''}</div><div class="tc-cred-state" title="${state.at ? M.absTime(state.at) : state.sub}" role="status"><span class="tc-cred-state-line" data-tone="${state.tone}">${pending ? html`<span class="tc-spinner" aria-hidden="true"></span>` : dot(state.tone)}<span>${busy.get(profile.id)?.kind === 'scan' ? 'Reading host key…' : busy.get(profile.id)?.kind === 'trust' ? 'Trusting host key…' : state.label}</span></span>${state.sub ? html`<span class="tc-cred-state-sub">${state.sub}</span>` : ''}</div><div class="tc-row-actions">${primary(profile)}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-key="cred-menu-${profile.id}" data-cred-action="menu" data-id="${profile.id}" aria-label="More for ${profile.id}" aria-haspopup="menu" aria-expanded="${String(Kit.menuOpenFor('cred-menu-' + profile.id))}"${disabled(pending)}>${icon('ellipsis')}</button></div></div>`;
    };
    const toolbar = () => html`<div class="tc-sk-toolbar tc-cred-toolbar"><label class="tc-sk-search" for="credential-search">${icon('search')}<input class="tc-input" id="credential-search" data-key="credential-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search ${data.credentials.length} credentials" aria-label="Search credentials" value="${query}"><kbd class="tc-kbd">/</kbd></label>${attention().length || attentionOnly ? html`<button class="tc-btn tc-btn--sm tc-sk-attention" type="button" data-key="cred-attention" data-cred-action="attention" aria-pressed="${String(attentionOnly)}">${dot('warn')}Needs attention ${attention().length}</button>` : ''}<span class="tc-spacer"></span><button class="tc-btn tc-btn--primary tc-btn--sm tc-cred-add" type="button" data-key="cred-add" data-cred-action="add" aria-label="Add credential">${icon('plus')}<span>Add credential…</span></button></div>`;
    const empty = () => html`<div class="tc-group"><div class="tc-empty"><div class="tc-empty-media" aria-hidden="true"><span class="tc-empty-icon">${icon('key-round')}</span></div><strong class="tc-empty-title">Keep secrets out of chats and skills</strong><p class="tc-empty-desc">Save an SSH or API login here once. Agents use it by name, and never need the secret itself.</p><button class="tc-btn tc-btn--primary" type="button" data-cred-action="add" data-key="cred-add-empty">${icon('plus')}Add credential…</button></div><div class="tc-cred-how"><div><span class="tc-cred-how-num"><span>1</span>Save a login once</span><p>An SSH password or an API key, with where it goes. It stays on this server.</p></div><div><span class="tc-cred-how-num"><span>2</span>Use its name in a skill</span><p>Skills and chats only ever carry the name.</p><code>t3-ssh build-server -- uptime</code></div><div><span class="tc-cred-how-num"><span>3</span>The helper signs in</span><p><code>t3-ssh</code> and <code>t3-api</code> add the secret, and hide it if the output repeats it.</p></div></div>${footer()}</div>`;
    const body = () => {
      if (error) return html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">Couldn’t read credentials</strong><span class="tc-notice-desc">${error}</span></div><button class="tc-btn tc-btn--sm" type="button" data-cred-action="retry"${disabled(loading)}>Try again</button></div>`;
      if (!data) return html`<div class="tc-group" role="status" aria-label="Loading credentials">${[1, 2, 3].map(index => html`<div class="tc-skel-row tc-cred-skel" data-key="cred-skeleton-${index}" aria-hidden="true"><span class="tc-skel tc-skel--tile"></span><span class="tc-skel tc-cred-skeleton-line"></span></div>`)}</div>`;
      if (!data.credentials.length) return empty();
      const filtered = rows().filter(profile => S.matches(profile, query) && (!attentionOnly || attention().some(row => row.id === profile.id)));
      return html`${toolbar()}${usageWarnings().length ? html`<p class="tc-hint tc-cred-usage-warning" role="status">${icon('info', 'tc-icon--sm')}Some skills couldn’t be read. Usage may be incomplete.</p>` : ''}<div class="tc-group"><div class="tc-list tc-cred-list">${filtered.length ? filtered.map(item) : html`<div class="tc-empty tc-empty--compact"><strong class="tc-empty-title">${attentionOnly ? 'No matching credentials need attention' : 'No credentials match this search'}</strong><button class="tc-btn tc-btn--sm" type="button" data-cred-action="clear">Clear filters</button></div>`}</div>${footer()}</div>`;
    };
    document.addEventListener('click', event => { const button = event.target.closest('[data-cred-action]'); if (!button || button.disabled) return; void actionFor(button.dataset.credAction, button.dataset.id, button); });
    document.addEventListener('input', event => { if (event.target.id !== 'credential-search') return; query = event.target.value; paint(); });
    window.addEventListener('focus', () => { if (started && location.hash.replace(/^#\/?/, '').split('/')[0] === 'credentials' && !editor.isOpen()) void load(); });
    const resize = new ResizeObserver(() => { if (started) { paint(); editor.repaint(); } });
    resize.observe(document.documentElement);
    const activate = async (force = false) => {
        const id = location.hash.replace(/^#\/?/, '').split('/')[1];
        const loaded = force || !started ? await load() : Boolean(data); if (!loaded) return; paint();
        if (S.validName(id) && !editor.isOpen() && lastDeep !== id) {
          lastDeep = id;
          if (row(id)) { inspect(id); if (row(id).test?.code === 'host-key-changed') void dialogs.review(id); }
          else Kit.toast('Credential not found', { detail: 'It may have been deleted in another window.' });
        } else if (!id) lastDeep = null;
      };
    return {
      content: () => html`<div id="credential-list" class="tc-credentials-library" data-keep>${body()}</div>`,
      activate,
      paletteItems: () => rows().filter(profile => !getStatus()?.credentials?.attention?.some(item => item.id === profile.id)).map(profile => ({ id: 'credential:' + profile.id, group: 'Credentials', label: profile.id, icon: 'key-round', cmd: { cmd: 'goto', route: 'credentials/' + profile.id }, keywords: 'credential ' + profile.type + ' ' + S.target(profile) + ' ' + S.kind(profile), meta: { text: rowState(profile).label } })),
      focusSearch: () => { document.getElementById('credential-search')?.focus(); },
      beforeNavigate: async () => { if (!dialogs.beforeNavigate()) { Kit.announce('Wait for the host-key check to finish.'); return false; } return editor.beforeNavigate(); },
    };
  };
  return { create };
})();
