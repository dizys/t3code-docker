const T3ServicesUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit, M = T3ServiceModel;
  const disabled = value => value ? raw(' disabled') : '';
  const checked = value => value ? raw(' checked') : '';
  const selected = value => value ? raw(' selected') : '';
  const tabs = [['configured', 'Configured'], ['attention', 'Needs attention'], ['available', 'Available']];
  const accessTabs = [['devices', 'Devices'], ['connections', 'Connections'], ['ssh', 'SSH']];
  const accessTab = () => accessTabs.some(([id]) => location.hash.split('/')[1] === id) ? location.hash.split('/')[1] : 'devices';
  const catalogue = [
    { id: 'openssh', name: 'SSH', icon: 'terminal', description: 'Key-only access from your terminal or editor. Persistent host identity and local readiness checks.', domain: 'system' },
    { id: 'tailscale', name: 'Tailscale', icon: 'waypoints', description: 'A private userspace connector. Sign-in, network policy and inbound routes are separate steps.', domain: 'system' },
    { id: 'cloudflared', name: 'Cloudflare Tunnel', icon: 'cloud', description: 'A named connector for Cloudflare Access routes. Your native T3 HTTP tunnels keep their existing owner.', domain: 'system' },
    { id: 'http-preview', name: 'Python preview', icon: 'globe', description: 'Serve a folder with Python as your user. Uses an installed exact version or the image’s Python executable.', domain: 'user' },
  ];
  const create = ({ api, render, go, getStatus = () => ({}) }) => {
    let data = null, error = null, loading = false, epoch = 0, inFlight = null, timer = null, inspector = null, lastDeep = null;
    let filter = 'configured', query = '', pending = null, openEditorOnReady = false;
    const busy = new Set();
    const storageKey = 't3-service-submission:' + location.origin + BASE;
    try { pending = JSON.parse(sessionStorage.getItem(storageKey)); } catch { /* Storage disabled */ }
    const persist = value => { pending = value; try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch { /* The in-memory receipt still works. */ } };
    const rows = () => data?.services || [];
    const row = (domain, id) => rows().find(item => item.domain === domain && item.id === id);
    const operation = resource => data?.operations?.find(item => item.domain === resource.domain && item.id === resource.lastOperationId);
    const updateFor = resource => resource.domain === 'system' && resource.artifact ? data?.domains?.find(item => item.domain === 'system')?.catalogue?.find(item => item.id === resource.id && item.digest && item.digest !== resource.artifact.digest) : null;
    const active = () => ['services', 'access'].includes(location.hash.replace(/^#/, '').split('/')[0]);
    const paint = () => { render(); if (inspector && !inspector.layer.closed) inspector.layer.render(); };
    const refresh = async () => {
      if (inFlight) return inFlight;
      const version = ++epoch; loading = true;
      inFlight = api('/services').then(response => {
        if (version !== epoch) return;
        if (response.ok) {
          const next = response.data;
          for (const domain of next.domains || []) {
            if (!domain.error || !data) continue;
            next.services.push(...data.services.filter(item => item.domain === domain.domain).map(item => ({ ...item, observation: { ...item.observation, state: 'unavailable', reason: domain.error, lastKnown: true } })));
            next.operations.push(...data.operations.filter(item => item.domain === domain.domain));
            if (domain.domain === 'user') { next.connections = data.connections.map(item => ({ ...item, state: 'unavailable' })); next.routes = data.routes.map(item => ({ ...item, state: 'unknown', verificationStale: true })); }
          }
          data = next; error = null;
          if (pending && data.operations?.some(item => item.planId === pending.planId && item.domain === pending.domain)) persist(null);
        } else error = response.error;
      }).finally(() => {
        if (version !== epoch) return;
        loading = false; inFlight = null; paint(); schedule();
        const [page, id] = location.hash.replace(/^#/, '').split('/');
        if (page === 'services' && id && !['configured', 'attention', 'available', 'new'].includes(id) && lastDeep !== id) { const resource = rows().find(item => item.id === id); if (resource) { lastDeep = id; inspect(resource); } }
      });
      return inFlight;
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { if (active() && !document.hidden) void refresh(); else schedule(); }, data?.operations?.some(item => !M.terminal(item)) ? 1500 : 5000); };
    const badge = resource => { const state = error ? { label: 'Status unavailable', tone: 'warn' } : M.state(resource); return html`<span class="tc-badge${state.tone !== 'muted' ? ' tc-badge--' + state.tone : ''}">${state.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>` : ''}${state.label}</span>`; };
    const operationView = op => op ? html`<div class="tc-service-operation" data-key="svc-op-${op.id}" role="status"><div class="tc-service-inline">${!M.terminal(op) ? html`<span class="tc-spinner" aria-hidden="true"></span>` : icon(op.state === 'succeeded' ? 'check' : 'triangle-alert')}<strong>${M.operationLabel(op)}</strong></div><span class="tc-hint">${op.error || op.review?.effect || 'This operation continues if you close the console.'}</span>${op.recovery ? html`<p class="tc-hint">${op.recovery}</p>` : ''}<details><summary class="tc-hint">Operation details</summary><code class="tc-service-wrap">${op.id}</code><span class="tc-hint">${op.domain} · ${op.action} · ${op.phase}</span></details></div>` : '';
    const review = (plan, domain) => new Promise(resolve => {
      if (pending && pending.planId !== plan.id) { Kit.toast('Reconcile the saved submission before starting another operation.', { tone: 'warn' }); resolve(null); return; }
      let submitting = false, issue = null, uncertain = false, fallback = pending?.acknowledgeAccessImpact === true;
      const request = pending || { domain, planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: crypto.randomUUID() };
      const title = plan.review?.name || 'Service';
      const label = plan.review?.action === 'add' ? plan.review.config?.enabled ? 'Add and enable' : 'Add service' : plan.review?.action === 'install' ? plan.review.config?.enabled ? 'Install and enable' : 'Install service' : ({ stop: 'Stop for now', disable: 'Disable service', remove: 'Remove registration', uninstall: 'Uninstall service', restart: 'Restart service', enable: 'Enable service', update: 'Apply update', edit: 'Save configuration', 'sign-in': 'Start sign-in', 'sign-out': 'Sign out connector', 'route-save': 'Save route', 'route-remove': 'Remove route', 'connection-save': 'Save connection', 'connection-remove': 'Remove connection', 'client-observed': 'Record client test' })[plan.review?.action] || 'Apply changes';
      const close = () => { if (!submitting) layer.close('cancel'); };
      const renderReview = () => html`<div class="tc-service-dialog-head"><h2 class="tc-dialog-title" id="svc-review-title">Review ${title}</h2></div><div class="tc-dialog-body tc-service-form"><p>${plan.review?.effect}</p>${plan.review?.requiresFallback ? html`<div class="tc-notice tc-notice--warn"><div class="tc-notice-body"><strong class="tc-notice-title">Keep another working access path</strong><span class="tc-notice-desc">Existing sessions may end. The console cannot tell which network path this browser uses.</span></div></div><label class="tc-check"><input type="checkbox" data-service-fallback${checked(fallback)}${disabled(submitting)}>I have another way to reach Setup or this container.</label>` : ''}${issue ? html`<div class="tc-notice tc-notice--${uncertain ? 'warn' : 'danger'}" role="alert">${issue}</div>` : ''}${plan.review?.runAs ? html`<p class="tc-hint">Runs as ${plan.review.runAs}.</p>` : ''}${plan.review?.version ? html`<p class="tc-hint">Version ${plan.review.version} · selected for this image architecture</p>` : ''}${plan.review?.downloads?.length ? html`<div class="tc-group tc-service-review-downloads">${plan.review.downloads.map(item => html`<div class="tc-row tc-row--compact"><div class="tc-row-main"><strong>${item.name}</strong><span class="tc-hint">${Math.ceil(item.bytes / 1024)} KiB · SHA-256 checked during installation</span><code class="tc-service-wrap">${item.url}</code></div></div>`)}</div>` : ''}
        ${plan.review?.config?.mode ? html`<dl class="tc-service-facts"><dt>Command</dt><dd><code>${M.command({ config: plan.review.config })}</code></dd>${plan.review.config.mode === 'script' ? html`<dt>Shell script</dt><dd><pre class="tc-service-code">${plan.review.config.script}</pre></dd>` : ''}<dt>Directory</dt><dd><code>${plan.review.config.cwd}</code></dd><dt>Startup</dt><dd>${plan.review.config.enabled ? 'Enabled' : 'Disabled'}</dd><dt>On exit</dt><dd>${plan.review.config.restart}</dd><dt>Health</dt><dd>${plan.review.config.health.kind === 'process' ? 'Process only' : plan.review.config.health.kind + ' on 127.0.0.1:' + plan.review.config.health.port}</dd><dt>Pinned tools</dt><dd>${plan.review.config.tools.map(item => item.tool + '@' + item.version).join(', ') || 'None'}</dd><dt>Vault variables</dt><dd>${Object.entries(plan.review.config.secrets).map(([name, id]) => name + ' → ' + id).join(', ') || 'None'}</dd></dl>` : plan.review?.config?.keys ? html`<dl class="tc-service-facts"><dt>Listener</dt><dd><code>${plan.review.config.listen}:${plan.review.config.port}</code></dd><dt>Authentication</dt><dd>Public key only · ${plan.review.config.keys.length} authorized</dd><dt>Startup</dt><dd>${plan.review.config.enabled ? 'Enabled' : 'Disabled'}</dd></dl>` : plan.review?.config?.kind === 'route' ? html`<dl class="tc-service-facts"><dt>Client address</dt><dd><code>${plan.review.config.host}:${plan.review.config.port}</code></dd><dt>Local endpoint</dt><dd>${plan.review.config.endpoint.protocol.toUpperCase()} · 127.0.0.1:${plan.review.config.endpoint.port}</dd><dt>Network path</dt><dd>${({ 'host-mapping': 'Host port mapping', 'container-network': 'Container or sidecar network', tailnet: 'Tailnet TCP forwarding', cloudflare: 'Cloudflare Access SSH' })[plan.review.config.topology]}</dd><dt>Service</dt><dd>${plan.review.config.service}</dd><dt>Client evidence</dt><dd>${plan.review.config.verified ? 'Successful client test reported by you' : 'Test from your client after saving'}</dd></dl>` : plan.review?.config?.kind === 'connection' ? html`<dl class="tc-service-facts"><dt>Name</dt><dd>${plan.review.config.name}</dd><dt>Ownership</dt><dd>${plan.review.config.ownership === 'external' ? 'Managed outside this container' : 'Managed in Services'}</dd><dt>Provider</dt><dd>${plan.review.config.provider}</dd></dl>` : plan.review?.config?.hostname ? html`<dl class="tc-service-facts"><dt>Device name</dt><dd>${plan.review.config.hostname}</dd><dt>Startup</dt><dd>${plan.review.config.enabled ? 'Enabled' : 'Disabled'}</dd><dt>Networking</dt><dd>Userspace · inbound routes require explicit TCP forwarding</dd></dl>` : ''}<details class="tc-service-advanced"><summary>Configuration details</summary><pre class="tc-service-code">${JSON.stringify(plan.review?.config || {}, null, 2)}</pre></details><p class="tc-hint">${plan.review?.retains}</p>${plan.review?.network ? html`<p class="tc-hint">${plan.review.network}</p>` : ''}${plan.review?.routes?.length ? html`<div class="tc-notice tc-notice--warn">These routes use this service: ${plan.review.routes.join(', ')}. Existing sessions may end.</div>` : ''}</div><div class="tc-dialog-foot"><button class="tc-btn" type="button" data-service-review="cancel"${disabled(submitting)}>Back</button><button class="tc-btn tc-btn--primary" type="button" data-service-review="apply"${disabled(submitting || plan.review?.requiresFallback && !fallback)}>${submitting ? html`<span class="tc-spinner" aria-hidden="true"></span>Submitting…` : uncertain ? 'Check submission' : label}</button></div>`;
      const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-service-review', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'svc-review-title' }, render: renderReview, backdrop: 'ignore', onEscape: close, onClose: () => resolve(null) });
      layer.panel.addEventListener('change', event => { if (event.target.hasAttribute('data-service-fallback')) { fallback = event.target.checked; layer.render(); } });
      layer.panel.addEventListener('click', async event => {
        const action = event.target.closest('[data-service-review]')?.dataset.serviceReview;
        if (action === 'cancel') return close();
        if (action !== 'apply' || submitting || plan.review?.requiresFallback && !fallback) return;
        if (plan.review?.requiresFallback) request.acknowledgeAccessImpact = fallback;
        submitting = true; issue = null; layer.render(); persist(request);
        const response = await api('/services/apply', { body: request });
        submitting = false;
        if (!response.ok) {
          uncertain = response.status === 0 || response.status >= 500;
          if (!uncertain) persist(null);
          issue = uncertain ? 'The submission response was lost. Check this same submission to recover its operation; do not create another review.' : response.error;
          layer.render(); return;
        }
        persist(null); resolve(response.data); layer.close('applied');
        Kit.toast('Operation started', { detail: 'You can close this window. Progress stays in Services.' });
        await refresh();
      });
    });
    const editor = T3ServiceEditor.create({ api, review, go, workspace: () => getStatus()?.workspace?.path || getStatus()?.workspace || '/workspace' });
    const planAction = async (resource, action) => {
      const key = M.key(resource); if (busy.has(key)) return;
      busy.add(key); paint();
      try {
        const response = await api('/services/plan', { body: { domain: resource.domain, action, id: resource.id, expectedRevision: resource.revision } });
        if (!response.ok) { Kit.toast(response.error, { tone: 'danger' }); if (response.data?.code === 'conflict') await refresh(); return; }
        const operation = await review(response.data, resource.domain);
        if (operation && action === 'sign-in') authentication(resource);
      } finally { busy.delete(key); paint(); }
    };
    const authentication = resource => {
      let result = null, issue = null, reading = false;
      const read = async () => {
        if (reading || layer.closed) return;
        reading = true;
        const response = await api('/services/authentication', { body: { domain: 'system', id: resource.id } });
        reading = false;
        if (layer.closed) return;
        if (response.ok) { result = response.data; issue = null; } else issue = response.error;
        layer.render();
        if (result?.state === 'Running') void refresh();
      };
      const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-service-review', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'svc-auth-title' }, render: () => html`<div class="tc-service-dialog-head"><h2 class="tc-dialog-title" id="svc-auth-title">Sign in to Tailscale</h2></div><div class="tc-dialog-body tc-service-form">${issue ? html`<p class="tc-field-error" role="alert">${issue}</p>` : result?.state === 'Running' ? html`<p role="status">This connector is signed in. Add a route to forward a selected service over your tailnet.</p>` : result?.url ? html`<p>Authorize this device in Tailscale, then return here. Your tailnet access policy still applies.</p><a class="tc-btn tc-btn--primary" href="${result.url}" target="_blank" rel="noopener noreferrer">${icon('external-link')}Open Tailscale sign-in</a>` : html`<p role="status"><span class="tc-spinner" aria-hidden="true"></span>Waiting for the connector’s sign-in link…</p>`}<p class="tc-hint">This window reconnects to the existing sign-in. Closing it keeps the service operation running.</p></div><div class="tc-dialog-foot"><button class="tc-btn" type="button" data-service-auth="refresh">Check status</button><button class="tc-btn tc-btn--primary" type="button" data-service-auth="close">${result?.state === 'Running' ? 'Done' : 'Close'}</button></div>`, onClose: () => clearInterval(timer) });
      const timer = setInterval(() => { if (!document.hidden) void read(); }, 2000);
      layer.panel.addEventListener('click', event => { const action = event.target.closest('[data-service-auth]')?.dataset.serviceAuth; if (action === 'close') layer.close(); else if (action === 'refresh') void read(); });
      void read();
    };
    const menu = (resource, button) => Kit.menu(button, { label: 'Manage ' + resource.config.name, items: [
      { label: 'Inspect', icon: 'info', run: () => inspect(resource) },
      { label: 'Edit configuration', icon: 'pencil', run: () => editor.open(resource) },
      ...(updateFor(resource) ? [{ label: 'Update to ' + updateFor(resource).version + '…', icon: 'download', run: () => planAction(resource, 'update') }] : []),
      ...(resource.id === 'tailscale' && resource.enabled ? [{ label: 'Sign in…', icon: 'external-link', run: () => planAction(resource, 'sign-in') }, { label: 'Continue sign-in', icon: 'external-link', run: () => authentication(resource) }, { label: 'Sign out…', icon: 'log-out', run: () => planAction(resource, 'sign-out') }] : []),
      ...(resource.enabled && !resource.uninstalled ? [{ label: 'Restart', icon: 'rotate-cw', run: () => planAction(resource, 'restart') }, { label: 'Stop for now', icon: 'pause', run: () => planAction(resource, 'stop') }, { label: 'Disable at startup', icon: 'power', run: () => planAction(resource, 'disable') }] : [{ label: resource.uninstalled ? 'Install again…' : 'Enable', icon: 'power', run: () => resource.uninstalled ? editor.open(resource, resource.id) : planAction(resource, 'enable') }]),
      { label: resource.domain === 'user' ? 'Remove registration…' : 'Uninstall service…', icon: 'trash-2', danger: true, run: () => planAction(resource, resource.domain === 'user' ? 'remove' : 'uninstall') },
    ] });
    const rowMarkup = resource => html`<div class="tc-row tc-service-row" data-key="svc-${M.key(resource)}" aria-busy="${String(busy.has(M.key(resource)))}"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(resource.id === 'openssh' ? 'terminal' : resource.domain === 'user' ? 'terminal' : 'waypoints')}</span><div class="tc-row-main"><div class="tc-row-title"><button class="tc-service-name" type="button" data-service-action="inspect" data-domain="${resource.domain}" data-id="${resource.id}">${resource.config.name}</button>${resource.domain === 'user' ? html`<span class="tc-badge">Custom</span>` : ''}${badge(resource)}</div><span class="tc-status tc-service-wrap">${resource.observation?.reason || (resource.domain === 'user' ? M.command(resource) : resource.artifact ? resource.artifact.version : 'Payload not installed')}</span><span class="tc-hint">${resource.observation?.state === 'stopped' ? 'Resumes on the next container start.' : resource.domain === 'user' && resource.config.health.kind === 'process' ? 'No application health check configured.' : resource.observation?.health?.message || ''}</span></div><div class="tc-row-actions"><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-service-action="menu" data-domain="${resource.domain}" data-id="${resource.id}" data-key="svc-menu-${M.key(resource)}" aria-label="Manage ${resource.config.name}" aria-haspopup="menu"${disabled(busy.has(M.key(resource)))}>${icon('ellipsis')}</button></div></div>`;
    const blocked = domain => data?.domains?.find(item => item.domain === domain)?.error;
    const deployment = () => {
      const snippet = 'services:\n  t3code:\n    volumes:\n      - t3-services:/var/lib/t3code/services\nvolumes:\n  t3-services:\n';
      const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-service-review', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'svc-storage-title' }, render: () => html`<div class="tc-service-dialog-head"><h2 class="tc-dialog-title" id="svc-storage-title">Persistent service storage</h2></div><div class="tc-dialog-body"><p>${blocked('system') || 'System services need root-owned persistent storage and the root entrypoint.'}</p><p class="tc-hint">Merge this volume into your existing Compose definition, preserving its current home, workspace, ports and settings. Recreate through your deployment manager, then return here. Copying this does not apply it.</p><pre class="tc-service-code">${snippet}</pre><p class="tc-hint">Custom services use your existing T3 data home and remain available in supported rootless deployments.</p></div><div class="tc-dialog-foot"><button class="tc-btn" data-service-deployment="close" type="button">Close</button><button class="tc-btn tc-btn--primary" data-service-deployment="copy" type="button">${icon('copy')}Copy volume example</button></div>` });
      layer.panel.addEventListener('click', event => { const button = event.target.closest('[data-service-deployment]'); if (!button) return; if (button.dataset.serviceDeployment === 'copy') Kit.copy(snippet, button, 'Volume example copied'); else layer.close(); });
    };
    const available = () => html`<div class="tc-service-catalogue">${catalogue.filter(item => item.domain === 'user' || !row('system', item.id)?.artifact).map(item => html`<div class="tc-card" data-key="svc-catalogue-${item.id}"><div class="tc-card-body"><div class="tc-service-inline"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(item.icon)}</span><h3>${item.name}</h3></div><p class="tc-hint">${item.description}</p>${item.domain === 'system' && blocked('system') ? html`<p class="tc-hint">Deployment change needed before installation.</p>` : ''}</div><div class="tc-card-foot"><span class="tc-hint">${item.domain === 'user' ? 'User account' : 'On-demand payload'}</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--sm" type="button" data-service-action="configure" data-id="${item.id}">${item.domain === 'system' && blocked('system') ? 'Review requirement' : 'Configure…'}</button></div></div>`)}</div>`;
    const recover = () => pending ? html`<div class="tc-notice tc-notice--warn" role="status"><div class="tc-notice-body"><strong class="tc-notice-title">A submission needs reconciliation</strong><span class="tc-notice-desc">Recover its saved operation before creating another review.</span></div><button class="tc-btn tc-btn--sm" type="button" data-service-action="recover">Check submission</button></div>` : '';
    const content = () => {
      if (!data && !error) return html`<div class="tc-empty" role="status"><span class="tc-spinner" aria-hidden="true"></span><span>Reading services…</span></div>`;
      const shown = rows().filter(item => M.matches(item, query) && (filter !== 'attention' || M.attention(item) || ['failed', 'rolled-back'].includes(operation(item)?.state)));
      const paths = getStatus()?.paths;
      const persistence = paths && ['none', 'anonymous'].includes(paths.stateKind || paths.volumeKind);
      return html`${recover()}${persistence ? html`<div class="tc-notice tc-notice--warn"><div class="tc-notice-body"><strong class="tc-notice-title">Keep your service registrations when recreating</strong><span class="tc-notice-desc">Your T3 data is ${paths.stateKind === 'none' || paths.volumeKind === 'none' ? 'inside the container' : 'on an anonymous volume'}. Mount or reattach persistent storage before recreating. Installed tools and application data need persistent home or workspace storage too.</span></div><a class="tc-btn tc-btn--sm" href="#server">Review storage</a></div>` : ''}${error ? html`<div class="tc-notice tc-notice--warn" role="alert"><div class="tc-notice-body"><strong class="tc-notice-title">Current service status is unavailable</strong><span class="tc-notice-desc">${error} Last-known values below may be stale.</span></div><button class="tc-btn tc-btn--sm" type="button" data-service-action="refresh">Retry</button></div>` : ''}
        ${['user', 'system'].filter(blocked).map(domain => html`<div class="tc-notice tc-notice--warn" role="alert"><div class="tc-notice-body"><strong class="tc-notice-title">${domain === 'user' ? 'Custom service' : 'System service'} management is unavailable</strong><span class="tc-notice-desc">${blocked(domain)} Last-known rows may be stale; existing services may still be running.</span></div><button class="tc-btn tc-btn--sm" type="button" data-service-action="refresh">Retry</button></div>`)}
        <div class="tc-service-toolbar"><div class="tc-tabs" role="tablist" aria-label="Services">${tabs.map(([id, label]) => html`<button class="tc-tab-button" type="button" role="tab" aria-selected="${String(filter === id)}" aria-controls="service-results" tabindex="${filter === id ? 0 : -1}" data-service-action="filter" data-value="${id}">${label}${id === 'attention' && rows().filter(M.attention).length ? html`<span class="tc-tab-count">${rows().filter(M.attention).length}</span>` : ''}</button>`)}</div><button class="tc-btn tc-btn--primary" type="button" data-service-action="add">${icon('plus')}Add service</button></div>
        ${editor.hasDraft() ? html`<div class="tc-notice tc-notice--info"><div class="tc-notice-body"><span class="tc-notice-desc">Your custom service draft is kept in this console.</span></div><button class="tc-btn tc-btn--sm" type="button" data-service-action="resume">Resume draft</button></div>` : ''}
        <div id="service-results" role="tabpanel">${filter === 'available' ? available() : html`${rows().length ? html`<label class="tc-sk-search tc-service-search">${icon('search')}<input id="service-search" class="tc-input" data-key="service-search" type="search" value="${query}" placeholder="Search services" aria-label="Search services"></label>` : ''}${shown.length ? html`<div class="tc-group"><div class="tc-list">${shown.map(rowMarkup)}</div></div>` : html`<div class="tc-group"><div class="tc-empty"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('server-cog')}</span><strong class="tc-empty-title">${filter === 'attention' ? 'Nothing needs attention' : query ? 'No services match' : 'No services configured'}</strong><span class="tc-empty-desc">${filter === 'attention' ? 'Check Configured for current service details.' : query ? 'Try another name, command or tool.' : 'Add an optional service, or manage a foreground command you already use.'}</span>${!query && filter === 'configured' ? html`<button class="tc-btn" type="button" data-service-action="add">${icon('plus')}Add service</button>` : ''}</div></div>`}`}</div>
        ${data?.operations?.length ? html`<section class="tc-section"><h2 class="tc-section-title">Recent operations</h2><div class="tc-group">${data.operations.slice(0, 4).map(operationView)}</div></section>` : ''}`;
    };
    const inspect = resource => {
      if (inspector?.domain === resource.domain && inspector?.id === resource.id) return;
      inspector?.layer.close('replaced');
      const view = { domain: resource.domain, id: resource.id, logs: null, logsError: null, paused: false, search: '', reading: false, layer: null };
      inspector = view;
      const current = () => row(view.domain, view.id) || resource;
      const readLogs = async () => {
        if (view.reading || view.paused || inspector !== view) return;
        view.reading = true;
        const response = await api('/services/logs', { body: { domain: view.domain, id: view.id } });
        view.reading = false;
        if (inspector !== view) return;
        if (response.ok) { view.logs = response.data; view.logsError = null; } else view.logsError = response.error;
        view.layer.render();
      };
      const renderInspector = () => {
        const item = current(), state = M.state(item), routes = (data?.routes || []).filter(route => route.service === item.id && route.serviceDomain === item.domain);
        return html`<div class="tc-insp-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(item.id === 'openssh' ? 'terminal' : 'server-cog')}</span><div class="tc-insp-title"><h2 id="svc-inspector-title">${item.config.name}</h2><span class="tc-insp-meta">${item.domain === 'user' ? 'Custom · user account' : 'Managed system service'}</span></div><div class="tc-insp-actions"><button class="tc-btn tc-btn--sm" type="button" data-service-inspect="edit">${icon('pencil')}Edit</button><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-service-inspect="menu" aria-label="Manage ${item.config.name}" aria-haspopup="menu">${icon('ellipsis')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-service-inspect="close" aria-label="Close">${icon('x')}</button></div></div>
          <div class="tc-insp-body"><section class="tc-insp-section"><h3 class="tc-insp-label">Status ${badge(item)}</h3><p class="tc-hint">${item.observation?.reason || item.observation?.health?.message || state.label}${item.observation?.at ? ' · read ' + T3Model.relTime(item.observation.at, Date.now()) : ''}</p>${operationView(operation(item))}<div class="tc-service-inline"><button class="tc-btn tc-btn--sm" type="button" data-service-inspect="${item.uninstalled ? 'install' : item.enabled ? 'restart' : 'enable'}">${item.uninstalled ? 'Install again…' : item.enabled ? 'Restart' : 'Enable'}</button>${item.enabled ? html`<button class="tc-btn tc-btn--sm" type="button" data-service-inspect="stop">Stop for now</button>` : ''}</div></section>
          ${item.domain === 'user' ? html`<section class="tc-insp-section"><h3 class="tc-insp-label">Command</h3><pre class="tc-service-code">${M.command(item)}</pre><dl class="tc-service-facts"><dt>Directory</dt><dd><code>${item.config.cwd}</code></dd><dt>Startup</dt><dd>${item.enabled ? 'Enabled' : 'Disabled'}</dd><dt>Restart policy</dt><dd>${item.config.restart}</dd><dt>Tools</dt><dd>${item.config.tools?.length ? item.config.tools.map(tool => tool.tool + '@' + tool.version).join(', ') : 'No mise dependencies declared'}</dd><dt>Vault references</dt><dd>${Object.entries(item.config.secrets || {}).map(([name, id]) => name + ' → ' + id).join(', ') || 'None'}</dd></dl><p class="tc-hint">This process shares your account permissions and container resources. A pinned tool version is not an application-data snapshot.</p></section>` : html`<section class="tc-insp-section"><h3 class="tc-insp-label">Installation</h3><dl class="tc-service-facts"><dt>Version</dt><dd>${item.artifact?.version || 'Not installed'}</dd><dt>Architecture</dt><dd>${item.artifact?.arch || 'Unavailable'}</dd>${item.id === 'openssh' ? html`<dt>Listener</dt><dd><code>${item.config.listen}:${item.config.port}</code></dd><dt>Host fingerprint</dt><dd><code>${item.details?.hostFingerprint || 'Not generated yet'}</code></dd><dt>Incoming keys</dt><dd>${item.details?.keys?.map(key => key.fingerprint).join('\n') || 'Not checked yet'}</dd>` : ''}</dl></section>`}
          <section class="tc-insp-section"><h3 class="tc-insp-label">Routes<span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-service-inspect="route">${icon('plus')}Add route</button></h3>${routes.length ? routes.map(routeCard) : html`<p class="tc-hint">No route configured. Declared ports do not publish this service. Use an existing network or explicitly configure a connector.</p>`}</section>
          <section class="tc-insp-section"><h3 class="tc-insp-label">Logs<span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-service-inspect="logs">Refresh</button><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" aria-pressed="${String(view.paused)}" data-service-inspect="pause">${view.paused ? 'Resume' : 'Pause'}</button></h3><label class="tc-sk-search"><input class="tc-input" data-service-log-search data-key="service-log-search" value="${view.search}" type="search" placeholder="Search logs" aria-label="Search logs"></label>${view.logsError ? html`<p class="tc-field-error" role="alert">${view.logsError}</p>` : ''}<div class="tc-service-logs" tabindex="0" aria-label="Bounded service logs">${view.logs ? view.logs.entries.filter(entry => entry.text.toLowerCase().includes(view.search.toLowerCase())).map(entry => html`<div class="tc-service-log-line" data-key="${entry.runId}-${entry.stream}-${entry.sequence}"><span class="tc-hint">${entry.stream}</span><code>${entry.text}</code></div>`) : html`<p class="tc-hint">Reading logs…</p>`}</div><p class="tc-hint">${view.logs?.gap ? 'Showing the newest entries; older entries were omitted. ' : ''}Bounded history, separate output streams. Applications can print their own secrets.</p></section></div>`;
      };
      view.layer = Kit.open({ kind: 'sheet', panel: { class: 'tc-sheet tc-skill-inspector tc-service-inspector' + (Kit.isPhone() ? ' tc-sheet--bottom' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'svc-inspector-title' }, render: renderInspector, onClose: () => { if (inspector === view) inspector = null; lastDeep = null; clearInterval(logTimer); } });
      view.layer.panel.addEventListener('click', event => {
        const button = event.target.closest('[data-service-inspect]'); if (!button) return;
        const action = button.dataset.serviceInspect, item = current();
        if (action === 'close') view.layer.close();
        else if (action === 'edit' || action === 'install') { view.layer.close('edit'); void editor.open(item); }
        else if (action === 'menu') menu(item, button);
        else if (action === 'logs') void readLogs();
        else if (action === 'pause') { view.paused = !view.paused; view.layer.render(); if (!view.paused) void readLogs(); }
        else if (action === 'route') void networkEditor('route', item);
        else void planAction(item, action);
      });
      view.layer.panel.addEventListener('input', event => { if (event.target.hasAttribute('data-service-log-search')) { view.search = event.target.value; view.layer.render(); } });
      const logTimer = setInterval(() => { if (!document.hidden) void readLogs(); }, 5000); void readLogs();
    };
    const routeCard = route => html`<div class="tc-service-route" data-key="svc-route-${route.id}"><div class="tc-service-inline"><strong>${route.name}</strong><span class="tc-badge">${({ 'client-reported': 'Client test reported', 'client-test-needed': 'Client test needed', blocked: 'Blocked', 'service-not-ready': 'Service not ready' })[route.state] || 'Not checked'}</span></div><code class="tc-service-wrap">${route.host}:${route.port}</code>${route.client ? html`<div class="tc-service-copy"><pre class="tc-service-code">${route.client.command}</pre><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-service-action="copy-ssh" data-id="${route.id}" aria-label="Copy SSH command">${icon('copy')}</button></div><p class="tc-hint">Host fingerprint: <code>${route.client.fingerprint || 'Unavailable; check SSH before connecting'}</code></p><p class="tc-hint">${route.client.note}</p><button class="tc-btn tc-btn--sm" type="button" data-service-action="copy-config" data-id="${route.id}">${icon('copy')}Copy editor configuration</button>` : ''}<div class="tc-service-inline"><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-service-action="route-observed" data-id="${route.id}">Report client test</button><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-service-action="route-remove" data-id="${route.id}">Remove route…</button></div>${route.state === 'unknown' ? html`<p class="tc-hint">Current route status is unavailable. These are last-known instructions; reconnect before relying on them.</p>` : route.verificationStale ? html`<p class="tc-hint">Configuration changed since the last reported test. Test again from your client.</p>` : ''}</div>`;
    const networkEditor = async (kind, resource = null) => {
      let issue = null, preparing = false;
      const form = kind === 'connection' ? { name: '', provider: 'existing-network', notes: '' } : { name: resource.config.name + ' route', serviceDomain: resource.domain, serviceId: resource.id, connection: data?.connections?.[0]?.id || '', endpoint: resource.config.endpoints?.[0]?.port || '', host: '', port: resource.config.endpoints?.[0]?.port || 2222, topology: 'host-mapping' };
      const field = (id, label, value, type = 'text') => html`<label class="tc-field"><span class="tc-label">${label}</span><input class="tc-input" data-service-network="${id}" value="${value}" type="${type}" autocomplete="off" spellcheck="false"></label>`;
      const renderNetwork = () => html`<div class="tc-service-dialog-head"><h2 class="tc-dialog-title" id="svc-network-title">${kind === 'connection' ? 'Add a connection' : 'Add a route'}</h2></div><div class="tc-dialog-body tc-service-form">${issue ? html`<div class="tc-notice tc-notice--danger" role="alert">${issue}</div>` : ''}${field('name', 'Name', form.name)}${kind === 'connection' ? html`<label class="tc-field"><span class="tc-label">Connection owner</span><select class="tc-select" data-service-network="provider">${[['existing-network', 'Existing LAN, VPN or network'], ['host-tailscale', 'Tailscale on the host'], ['sidecar-cloudflare', 'Cloudflare on the host or a sidecar'], ['tailscale', 'Tailscale managed in Services'], ['cloudflared', 'Cloudflare managed in Services']].map(([id, label]) => html`<option value="${id}"${selected(form.provider === id)}>${label}</option>`)}</select></label><p class="tc-hint">Existing host and sidecar processes keep their current owner. Adding this registration does not install, sign in or start them.</p>` : html`<label class="tc-field"><span class="tc-label">Connection</span><select class="tc-select" data-service-network="connection"><option value="">Choose a configured connection</option>${(data.connections || []).map(item => html`<option value="${item.id}"${selected(form.connection === item.id)}>${item.name}</option>`)}</select></label>${!data.connections?.length ? html`<p class="tc-hint">Add a connection from Access → Connections first. Existing networks are fully supported.</p>` : ''}<label class="tc-field"><span class="tc-label">Service endpoint</span><select class="tc-select" data-service-network="endpoint">${resource.config.endpoints.map(item => html`<option value="${item.port}"${selected(Number(form.endpoint) === item.port)}>${item.protocol} · ${item.port}</option>`)}</select></label>${field('host', 'Hostname your client reaches', form.host)}${field('port', 'Client port', form.port, 'number')}<label class="tc-field"><span class="tc-label">Topology</span><select class="tc-select" data-service-network="topology">${[['host-mapping', 'Host port mapping'], ['container-network', 'Container or sidecar network'], ['tailnet', 'Tailnet TCP route'], ['cloudflare', 'Cloudflare Access SSH']].map(([id, label]) => html`<option value="${id}"${selected(form.topology === id)}>${label}</option>`)}</select></label><p class="tc-hint">This saves the client route. Configure the matching host mapping, tailnet Serve forwarding or Cloudflare SSH origin and Access policy with its owner. T3 Connect and HTTP quick tunnels do not carry raw SSH.</p>`}</div><div class="tc-dialog-foot"><button class="tc-btn" type="button" data-service-network-action="cancel"${disabled(preparing)}>Cancel</button><button class="tc-btn tc-btn--primary" type="button" data-service-network-action="review"${disabled(preparing)}>${preparing ? 'Checking…' : 'Review changes'}</button></div>`;
      const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-service-review', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'svc-network-title' }, render: renderNetwork, backdrop: 'ignore' });
      layer.panel.addEventListener('input', event => { const name = event.target.dataset.serviceNetwork; if (name) form[name] = ['port', 'endpoint'].includes(name) ? Number(event.target.value) : event.target.value; });
      layer.panel.addEventListener('click', async event => {
        const action = event.target.closest('[data-service-network-action]')?.dataset.serviceNetworkAction;
        if (preparing) return; if (action === 'cancel') return layer.close(); if (action !== 'review') return;
        preparing = true; issue = null; layer.render();
        const response = await api('/services/plan', { body: { domain: 'user', action: kind + '-save', expectedRevision: 0, configuration: form } });
        preparing = false;
        if (!response.ok) { issue = response.error; layer.render(); return; }
        layer.render(); if (await review(response.data, 'user')) layer.close('applied');
      });
    };
    const sshContent = () => {
      const ssh = row('system', 'openssh');
      if (!data) return html`<div class="tc-empty" role="status"><span class="tc-spinner" aria-hidden="true"></span><span>Reading SSH setup…</span></div>`;
      return html`${recover()}${blocked('system') ? html`<div class="tc-notice tc-notice--warn"><div class="tc-notice-body"><strong class="tc-notice-title">SSH needs a deployment change</strong><span class="tc-notice-desc">${blocked('system')}</span></div><button class="tc-btn tc-btn--sm" type="button" data-service-action="deployment">Review requirement</button></div>` : ''}${ssh ? html`<div class="tc-group">${rowMarkup(ssh)}</div>${operationView(operation(ssh))}<section class="tc-section"><div class="tc-section-head"><h2 class="tc-section-title">Client routes</h2><button class="tc-btn tc-btn--sm" type="button" data-service-action="route-add" data-domain="system" data-id="openssh">${icon('plus')}Add route</button></div>${(data.routes || []).filter(route => route.service === 'openssh' && route.serviceDomain === 'system').map(routeCard)}<p class="tc-hint">Local readiness checks the SSH listener. Test from your client to establish the complete network path.</p></section>` : html`<div class="tc-group"><div class="tc-empty"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('terminal')}</span><strong class="tc-empty-title">Connect from your terminal or editor</strong><span class="tc-empty-desc">Install SSH when you need it. Use your own public key and choose how this server is reached.</span><button class="tc-btn tc-btn--primary" type="button" data-service-action="configure" data-id="openssh">Set up SSH</button></div></div>`}`;
    };
    const connectionsContent = () => html`<section class="tc-section"><div class="tc-section-head"><h2 class="tc-section-title">Service connections</h2><button class="tc-btn tc-btn--sm" type="button" data-service-action="connection-add">${icon('plus')}Add connection</button></div><p class="tc-hint">Use an existing host, sidecar or network, or install a managed connector in Services. T3 Connect above serves the T3 app.</p>${data?.connections?.length ? html`<div class="tc-group">${data.connections.map(item => html`<div class="tc-row" data-key="svc-connection-${item.id}"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('waypoints')}</span><div class="tc-row-main"><strong>${item.name}</strong><span class="tc-status">${item.ownership === 'external' ? 'Managed outside this container' : 'Managed in Services'} · ${item.state}</span></div><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-service-action="connection-remove" data-id="${item.id}">Remove…</button></div>`)}</div>` : html`<div class="tc-group"><div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">No service connections registered.</span></div></div>`}<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-service-action="available">Browse optional connectors</button></section>`;
    document.addEventListener('click', async event => {
      const button = event.target.closest('[data-service-action]'); if (!button || button.disabled) return;
      const action = button.dataset.serviceAction, id = button.dataset.id, domain = button.dataset.domain, resource = row(domain, id);
      if (action === 'add') return Kit.menu(button, { label: 'Add service', items: [{ label: 'Custom service…', icon: 'terminal', run: () => editor.open() }, { label: 'From catalogue', icon: 'layout-dashboard', run: () => { filter = 'available'; paint(); } }] });
      if (action === 'resume') return editor.resume();
      if (action === 'configure') return ['openssh', 'tailscale', 'cloudflared'].includes(id) && blocked('system') ? deployment() : editor.open(row('system', id), id);
      if (action === 'deployment') return deployment();
      if (action === 'inspect' && resource) return inspect(resource);
      if (action === 'menu' && resource) return menu(resource, button);
      if (action === 'filter') { filter = button.dataset.value; paint(); return; }
      if (action === 'refresh') return refresh();
      if (action === 'available') { filter = 'available'; go('services'); return; }
      if (action === 'access-tab') { go(button.dataset.value === 'devices' ? 'access' : 'access/' + button.dataset.value); return; }
      if (action === 'connection-add') return networkEditor('connection');
      if (action === 'route-add' && resource) return networkEditor('route', resource);
      if (['copy-ssh', 'copy-config'].includes(action)) { const route = data.routes.find(item => item.id === id); if (route?.client) Kit.copy(action === 'copy-ssh' ? route.client.command : route.client.config, button, 'Client configuration copied'); return; }
      if (action === 'recover' && pending) {
        button.disabled = true;
        const response = await api('/services/apply', { body: pending });
        if (response.ok) { persist(null); await refresh(); } else { Kit.toast(response.error, { tone: 'danger' }); button.disabled = false; }
        return;
      }
      if (['connection-remove', 'route-remove', 'route-observed'].includes(action)) {
        const item = (action.startsWith('connection') ? data.connections : data.routes).find(entry => entry.id === id); if (!item) return;
        if (action === 'route-observed' && !await Kit.confirm({ title: 'Report a successful client test?', body: 'Only continue after connecting from your own client and checking the host fingerprint. This is recorded as your report, not an automated external reachability check.', confirm: 'Report success' })) return;
        const response = await api('/services/plan', { body: { domain: 'user', action: action === 'route-observed' ? 'client-observed' : action, id, expectedRevision: item.revision, ...(action === 'route-observed' ? { configuration: { reported: true } } : {}) } });
        if (response.ok) await review(response.data, 'user'); else Kit.toast(response.error, { tone: 'danger' });
      }
    });
    document.addEventListener('input', event => { if (event.target.id === 'service-search') { query = event.target.value; paint(); } });
    document.addEventListener('keydown', event => {
      if (event.target.getAttribute('role') !== 'tab' || !event.target.hasAttribute('data-service-action') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const nodes = [...event.target.closest('[role=tablist]').querySelectorAll('[role=tab]')], at = nodes.indexOf(event.target), index = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + nodes.length) % nodes.length;
      event.preventDefault(); nodes[index].click(); nodes[index].focus();
    });
    return { content, sshContent, connectionsContent, accessTab,
      accessTabs: () => html`<div class="tc-tabs" role="tablist" aria-label="Access">${accessTabs.map(([id, label]) => html`<button class="tc-tab-button" type="button" role="tab" aria-controls="access-tabpanel" aria-selected="${String(accessTab() === id)}" tabindex="${accessTab() === id ? 0 : -1}" data-service-action="access-tab" data-value="${id}">${label}</button>`)}</div>`,
      activate: (entered = false) => {
        // Navigation owns the editor entry. Background status reads may refresh
        // this page while its editor, draft or review is still open.
        if (entered) openEditorOnReady = location.hash.split('/')[1] === 'new';
        if (!getStatus()) return;
        if (!data && !loading || !inFlight) void refresh();
        const part = location.hash.split('/')[1];
        if (tabs.some(([id]) => id === part)) filter = part;
        if (openEditorOnReady) { openEditorOnReady = false; void editor.open(); }
        schedule();
      },
      beforeNavigate: () => editor.beforeNavigate(), focusSearch: () => document.getElementById('service-search')?.focus(), count: () => rows().length,
      paletteItems: () => [{ id: 'service-new', title: 'Add a custom service', route: 'services/new', meta: 'Services · foreground user command', terms: ['mise daemon service'], icon: 'server-cog' }] };
  };
  return { create, accessTab };
})();
