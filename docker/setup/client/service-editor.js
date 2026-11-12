const T3ServiceEditor = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const disabled = value => value ? raw(' disabled') : '';
  const selected = value => value ? raw(' selected') : '';
  const checked = value => value ? raw(' checked') : '';
  const create = ctx => {
    let active = null, kept = null;
    const close = () => active ? active.requestClose() : Promise.resolve(true);
    const open = async (resource = null, catalogue = null) => {
      if (!await close()) return;
      const system = resource?.domain === 'system' || ['openssh', 'tailscale', 'cloudflared'].includes(catalogue);
      const id = resource?.id || (system ? catalogue : null), config = resource?.config;
      const view = kept && !resource && !system ? kept : {
        domain: system ? 'system' : 'user', id, revision: resource?.revision || 0, editing: Boolean(resource) && !resource.uninstalled, step: 0,
        name: config?.name || (catalogue === 'http-preview' ? 'Python preview' : ''), mode: config?.mode || 'executable',
        executable: config?.executable || '', shell: config?.shell || '/bin/bash', script: config?.script || '', args: [...(config?.argv || [])],
        cwd: config?.cwd || ctx.workspace(), tools: (config?.tools || []).map(item => item.tool + '@' + item.version),
        restart: config?.restart || 'on-failure', enabled: resource && !resource.uninstalled ? resource.enabled : true, health: config?.health?.kind || 'process', port: config?.health?.port || 8080,
        healthPath: config?.health?.path || '/', variables: [...Object.entries(config?.env || {}).map(([name, value]) => ({ name, value, source: 'value' })), ...Object.entries(config?.secrets || {}).map(([name, value]) => ({ name, value, source: 'vault' }))],
        endpoints: (config?.endpoints || []).map(item => ({ ...item })), vault: [], vaultError: null, shutdownMs: config?.shutdownMs || 10000,
        listen: config?.listen || '127.0.0.1', sshPort: config?.port || 2222, keys: (config?.keys || []).join('\n'), hostname: config?.hostname || 't3code', token: '',
        networkMode: config?.networkMode || 'userspace', requirements: ctx.tailscaleRequirements?.() || null, checkingNetwork: false, networkError: null,
        inventory: [], inventoryError: null, inventoryLoading: !system, error: null, field: null, busy: false,
      };
      kept = null; active = view;
      const remember = () => { const { layer, requestClose, repaint, ...data } = view; kept = { ...data, busy: false, error: null, field: null }; };
      const paint = () => {
        if (active !== view || view.layer.closed) return;
        const advancedOpen = view.layer.panel.querySelector('[data-key="svc-advanced"]')?.open;
        const deploymentOpen = view.layer.panel.querySelector('[data-key="svc-network-deployment"]')?.open;
        view.layer.render();
        if (advancedOpen !== undefined) view.layer.panel.querySelector('[data-key="svc-advanced"]').open = advancedOpen;
        const deployment = view.layer.panel.querySelector('[data-key="svc-network-deployment"]');
        if (deployment && deploymentOpen !== undefined) deployment.open = deploymentOpen;
        // Kit preserves live input properties across background paints. This
        // editor owns its controlled values, including explicit secret removal.
        for (const field of view.layer.panel.querySelectorAll('[data-service-field]')) {
          const value = view[field.dataset.serviceField];
          if (field.type === 'checkbox') field.checked = Boolean(value);
          else if (field.value !== String(value ?? '')) field.value = String(value ?? '');
        }
        for (const field of view.layer.panel.querySelectorAll('[data-service-tool]')) field.value = view.tools[Number(field.dataset.serviceTool)] || '';
        for (const field of view.layer.panel.querySelectorAll('[data-service-arg]')) field.value = view.args[Number(field.dataset.serviceArg)] ?? '';
        for (const field of view.layer.panel.querySelectorAll('[data-service-variable]')) field.value = view.variables[Number(field.dataset.index)][field.dataset.serviceVariable];
        for (const field of view.layer.panel.querySelectorAll('[data-service-endpoint]')) field.value = view.endpoints[Number(field.dataset.index)][field.dataset.serviceEndpoint];
        for (const field of view.layer.panel.querySelectorAll('input,textarea,select,button')) field.disabled = view.busy || field.hasAttribute('data-service-tool') && view.inventoryLoading || field.dataset.serviceEdit === 'next' && id === 'tailscale' && view.networkMode === 'kernel' && (!view.requirements?.ready || view.checkingNetwork) || field.dataset.serviceEdit === 'check-network' && view.checkingNetwork;
      };
      view.repaint = paint;
      const build = () => {
        if (system) {
          if (id === 'openssh') return { enabled: view.enabled, listen: view.listen, port: Number(view.sshPort), keys: view.keys.split(/\r?\n/).filter(line => line.trim()) };
          if (id === 'tailscale') return { enabled: view.enabled, hostname: view.hostname, networkMode: view.networkMode };
          return { enabled: view.enabled, ...(view.token ? { token: view.token } : {}) };
        }
        const env = Object.create(null), secrets = Object.create(null), names = new Set();
        for (const variable of view.variables) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(variable.name)) throw { field: 'variables', message: 'Give each variable a name using letters, numbers and underscores.' };
          if (names.has(variable.name)) throw { field: 'variables', message: 'Each variable can appear once. Remove or rename the duplicate.' };
          if (variable.source === 'vault' && !variable.value) throw { field: 'variables', message: 'Choose a saved Token credential for each Vault variable.' };
          names.add(variable.name); (variable.source === 'vault' ? secrets : env)[variable.name] = variable.value;
        }
        const endpoints = view.endpoints.map(item => ({ port: Number(item.port), protocol: item.protocol }));
        const tools = view.tools.filter(Boolean).map(spec => { const at = spec.lastIndexOf('@'); return { tool: spec.slice(0, at), version: spec.slice(at + 1) }; });
        if (view.health !== 'process' && !endpoints.some(item => item.port === Number(view.port))) endpoints.push({ port: Number(view.port), protocol: view.health === 'http' ? 'http' : 'tcp' });
        return { name: view.name, mode: view.mode, executable: view.mode === 'script' ? view.shell : view.executable, ...(view.mode === 'script' ? { shell: view.shell, script: view.script } : {}),
          argv: view.args, cwd: view.cwd, tools, env, secrets, endpoints, enabled: view.enabled, restart: view.restart, shutdownMs: Number(view.shutdownMs),
          health: { kind: view.health, ...(view.health !== 'process' ? { port: Number(view.port), path: view.healthPath } : {}), intervalMs: 15000, graceMs: 10000 } };
      };
      const field = (name, label, control, help) => html`<div class="tc-field" data-key="svc-field-${name}"><label class="tc-label" for="svc-${name}">${label}</label>${control}${help ? html`<span class="tc-hint">${help}</span>` : ''}${view.field === name ? html`<span id="svc-${name}-error" class="tc-field-error" role="alert">${view.error}</span>` : ''}</div>`;
      const input = (name, value, type = 'text') => html`<input class="tc-input" id="svc-${name}" data-service-field="${name}" data-key="svc-${name}" type="${type}" value="${value}" autocomplete="off" spellcheck="false"${view.field === name ? raw(' aria-invalid="true" aria-describedby="svc-' + name + '-error"') : ''}>`;
      const area = (name, value, rows = 4) => html`<textarea class="tc-input tc-input--mono" id="svc-${name}" data-service-field="${name}" data-key="svc-${name}" rows="${rows}" spellcheck="false"${view.field === name ? raw(' aria-invalid="true" aria-describedby="svc-' + name + '-error"') : ''}>${value}</textarea>`;
      const checkNetwork = async () => {
        if (view.checkingNetwork) return;
        view.checkingNetwork = true; view.networkError = null; paint();
        try {
          const response = await ctx.api('/services/requirements', { body: { domain: 'system' } });
          if (active !== view) return;
          view.requirements = response.ok ? response.data?.tailscale || null : null;
          if (!view.requirements) view.networkError = 'Deployment requirements could not be read. Check the Services connection and try again.';
        } catch { view.networkError = 'Deployment requirements could not be read. Check the Services connection and try again.'; }
        finally { view.checkingNetwork = false; if (active === view) paint(); }
      };
      const networkRequirements = () => html`<section class="tc-service-network-requirements" aria-labelledby="svc-network-requirements-title">
        <div class="tc-service-inline"><strong id="svc-network-requirements-title">${view.checkingNetwork ? 'Checking deployment…' : view.requirements?.ready ? 'Deployment ready' : view.networkError ? 'Requirements unavailable' : 'Deployment change needed'}</strong>${view.checkingNetwork ? html`<span class="tc-spinner" aria-hidden="true"></span>` : ''}</div>
        ${view.networkError ? html`<p class="tc-field-error" role="alert">${view.networkError}</p>` : html`<p class="tc-hint">${view.requirements?.message || 'Check whether this deployment provides the optional networking permissions.'}</p>`}
        ${view.requirements?.checks?.length ? html`<ul class="tc-service-checks">${view.requirements.checks.map(check => html`<li>${icon(check.ok ? 'check' : 'circle-alert')}<span>${check.label}${check.detail ? html`<span class="tc-hint tc-service-check-detail">${check.detail}</span>` : ''}</span><span class="tc-hint">${check.ok ? 'Ready' : 'Required'}</span></li>`)}</ul>` : ''}
        ${!view.requirements?.ready && view.requirements?.compose ? html`<details data-key="svc-network-deployment"><summary>Deployment settings</summary><p class="tc-hint">Merge these settings into your existing service, keeping its volumes, ports and other settings. Recreate through your deployment manager, then check again. Use a private container network; host networking is unsupported.</p><pre class="tc-service-code">${view.requirements.compose}</pre><button class="tc-btn tc-btn--sm" type="button" data-service-edit="copy-network">${icon('copy')}Copy deployment settings</button></details>` : ''}
        <button class="tc-btn tc-btn--sm" type="button" data-service-edit="check-network"${disabled(view.checkingNetwork)}>${icon('refresh-cw')}${view.checkingNetwork ? 'Checking…' : 'Check again'}</button>
      </section>`;
      const tailscaleForm = () => html`<p class="tc-hint">Choose how this optional service connects your container. Installation and sign-in remain separate steps.</p>
        ${field('hostname', 'Tailnet device name', input('hostname', view.hostname))}
        ${field('networkMode', 'Networking', html`<select class="tc-select" id="svc-networkMode" data-service-field="networkMode" aria-describedby="svc-networkMode-help${view.field === 'networkMode' ? ' svc-networkMode-error' : ''}"${view.field === 'networkMode' ? raw(' aria-invalid="true"') : ''}><option value="userspace"${selected(view.networkMode === 'userspace')}>Published routes only</option><option value="kernel"${selected(view.networkMode === 'kernel')}>Full container networking</option></select>`)}
        <p class="tc-hint" id="svc-networkMode-help">${view.networkMode === 'kernel' ? 'Every program can reach tailnet IPs and MagicDNS names using its normal network connection. Incoming access still uses explicitly published Services routes.' : 'Share selected services through Tailscale TCP routes. Programs inside the container keep using deployment networking. No extra networking permissions are needed.'}</p>
        ${view.networkMode === 'kernel' ? html`${networkRequirements()}<p class="tc-hint">Services manages tailnet routes and split DNS, and restores deployment DNS when disconnected. Public and Docker names keep their original resolvers. Exit nodes and subnet routing remain separate.</p>` : ''}
        <label class="tc-check"><input type="checkbox" data-service-field="enabled"${checked(view.enabled)}>Enable Tailscale after saving</label>`;
      const toolPicker = (spec, index) => html`<div class="tc-service-token" data-key="svc-tool-${index}"><select class="tc-select" data-service-tool="${index}" aria-label="Exact installed tool ${index + 1}"${disabled(view.inventoryLoading)}><option value="">Choose an installed version</option>${view.inventory.map(item => html`<option value="${item.tool + '@' + item.version}"${selected(spec === item.tool + '@' + item.version)}>${item.tool}@${item.version}</option>`)}${spec && !view.inventory.some(item => item.tool + '@' + item.version === spec) ? html`<option value="${spec}" selected>${spec} · unavailable</option>` : ''}</select><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-service-edit="remove-tool" data-index="${index}" aria-label="Remove tool ${index + 1}">${icon('x')}</button></div>`;
      const variableRow = (variable, index) => html`<div class="tc-service-variable" data-key="svc-variable-${index}"><input class="tc-input tc-input--mono" data-service-variable="name" data-index="${index}" aria-label="Variable ${index + 1} name" value="${variable.name}" placeholder="VARIABLE_NAME" spellcheck="false" autocomplete="off"><select class="tc-select" data-service-variable="source" data-index="${index}" aria-label="Variable ${index + 1} value source"><option value="value"${selected(variable.source === 'value')}>Value</option><option value="vault"${selected(variable.source === 'vault')}>Vault token</option></select>${variable.source === 'vault' ? html`<select class="tc-select tc-service-variable-value" data-service-variable="value" data-index="${index}" aria-label="Variable ${index + 1} Vault credential"><option value="">Choose a saved token</option>${view.vault.map(item => html`<option value="${item.id}"${selected(variable.value === item.id)}>${item.label || item.id}</option>`)}${variable.value && !view.vault.some(item => item.id === variable.value) ? html`<option value="${variable.value}" selected>${variable.value} · unavailable</option>` : ''}</select>` : html`<input class="tc-input tc-service-variable-value" data-service-variable="value" data-index="${index}" aria-label="Variable ${index + 1} value" value="${variable.value}" autocomplete="off" spellcheck="false">`}<button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-service-edit="remove-variable" data-index="${index}" aria-label="Remove variable ${index + 1}">${icon('x')}</button></div>`;
      const endpointRow = (endpoint, index) => html`<div class="tc-service-token" data-key="svc-endpoint-${index}"><input class="tc-input" type="number" min="1024" max="65535" data-service-endpoint="port" data-index="${index}" aria-label="Endpoint ${index + 1} port" value="${endpoint.port}"><select class="tc-select" data-service-endpoint="protocol" data-index="${index}" aria-label="Endpoint ${index + 1} protocol">${['tcp', 'http', 'ssh'].map(protocol => html`<option value="${protocol}"${selected(endpoint.protocol === protocol)}>${protocol.toUpperCase()}</option>`)}</select><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-service-edit="remove-endpoint" data-index="${index}" aria-label="Remove endpoint ${index + 1}">${icon('x')}</button></div>`;
      const command = () => html`${field('name', 'Service name', input('name', view.name))}${field('mode', 'Launch mode', html`<select class="tc-select" id="svc-mode" data-service-field="mode">${[['executable', 'Executable'], ['mise', 'Installed mise tool'], ['script', 'Shell script']].map(([value, label]) => html`<option value="${value}"${selected(view.mode === value)}>${label}</option>`)}</select>`, 'Use a foreground command. This runs with your account permissions.')}
        ${view.mode === 'mise' || view.tools.length ? field('tools', 'Pinned tool versions', html`${view.tools.map(toolPicker)}${view.inventoryLoading ? html`<span class="tc-hint" role="status">Reading installed tools…</span>` : view.inventoryError ? html`<span class="tc-field-error" role="alert">${view.inventoryError}</span><button class="tc-btn tc-btn--sm" type="button" data-service-edit="reload-tools">Retry</button>` : !view.inventory.length ? html`<p class="tc-hint">No installed versions found. Add a tool first, or choose an executable.</p>` : ''}<div class="tc-service-inline"><button class="tc-btn tc-btn--sm" type="button" data-service-edit="add-tool">${icon('plus')}Add runtime</button><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-service-edit="toolchains">Open Toolchains</button></div>`, 'Exact installed versions stay pinned when your interactive defaults change.') : ''}
        ${view.mode === 'script' ? html`${field('shell', 'Shell executable', input('shell', view.shell))}${field('script', 'Shell script', area('script', view.script, 8), 'Pipes, expansion and redirects run as shell code in this mode.')}` : html`${field('executable', view.mode === 'mise' ? 'Executable name' : 'Executable path', input('executable', view.executable), view.mode === 'mise' ? 'A binary provided by the selected installation, such as python.' : 'An absolute path to an executable you can access.')}${field('argv', 'Arguments', html`${view.args.map((arg, index) => html`<div class="tc-service-token" data-key="svc-arg-row-${index}"><input class="tc-input tc-input--mono" data-service-arg="${index}" data-key="svc-arg-${index}" aria-label="Argument ${index + 1}" value="${arg}" spellcheck="false"><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-service-edit="remove-arg" data-index="${index}" aria-label="Remove argument ${index + 1}">${icon('x')}</button></div>`)}<button class="tc-btn tc-btn--sm" type="button" data-service-edit="add-arg">${icon('plus')}Add argument</button>`, 'One literal argument per field. Empty fields are empty arguments. Quotes and shell characters are passed literally.')}`}
        ${field('cwd', 'Working directory', input('cwd', view.cwd))}`;
      const behavior = () => html`<label class="tc-check"><input type="checkbox" data-service-field="enabled"${checked(view.enabled)}>Enable after ${view.editing ? 'saving' : 'adding'}</label><p class="tc-hint">Starts now and on future container starts. Stop for now pauses only this container run.</p>
        ${field('restart', 'When the process exits', html`<select class="tc-select" id="svc-restart" data-service-field="restart">${[['on-failure', 'Restart after failure'], ['never', 'Leave stopped'], ['always', 'Restart after every exit']].map(([value, label]) => html`<option value="${value}"${selected(view.restart === value)}>${label}</option>`)}</select>`, 'Restarts back off and allow at most five retries within five minutes.')}
        ${field('health', 'Health check', html`<select class="tc-select" id="svc-health" data-service-field="health">${[['process', 'Process only'], ['http', 'Local HTTP endpoint'], ['tcp', 'Local TCP endpoint']].map(([value, label]) => html`<option value="${value}"${selected(view.health === value)}>${label}</option>`)}</select>`, 'Process only means Running. It does not establish application readiness.')}
        ${view.health !== 'process' ? field('port', 'Local health port', input('port', view.port, 'number')) : ''}${view.health === 'http' ? field('healthPath', 'HTTP path', input('healthPath', view.healthPath), 'Checks 127.0.0.1 only, with a timeout and no redirects.') : ''}
        <details class="tc-service-advanced" data-key="svc-advanced"><summary>Environment and advanced settings</summary>${field('variables', 'Environment variables', html`<div id="svc-variables" tabindex="-1">${view.variables.map(variableRow)}</div><button class="tc-btn tc-btn--sm" type="button" data-service-edit="add-variable">${icon('plus')}Add variable</button>${view.vaultError ? html`<span class="tc-field-error">${view.vaultError}</span>` : ''}`, 'Use Vault token references for secrets. Saved secret values stay in Vault.')}${field('endpoints', 'Declared endpoints', html`<div id="svc-endpoints" tabindex="-1">${view.endpoints.map(endpointRow)}</div><button class="tc-btn tc-btn--sm" type="button" data-service-edit="add-endpoint">${icon('plus')}Add endpoint</button>`, 'Declaring a port never publishes it. Local health ports are added automatically.')}${field('shutdownMs', 'Graceful shutdown time (milliseconds)', input('shutdownMs', view.shutdownMs, 'number'), 'From 100 to 30000 ms. Known log values are redacted; application output can still contain secrets.')}</details>`;
      const systemForm = () => id === 'openssh' ? html`<p class="tc-hint">Connect as <code>t3</code> from your terminal or editor using your own public key. The server is downloaded only when you apply this review.</p>
        ${field('sshPort', 'Container SSH port', input('sshPort', view.sshPort, 'number'))}${field('listen', 'Listen on', html`<select class="tc-select" id="svc-listen" data-service-field="listen"><option value="127.0.0.1"${selected(view.listen === '127.0.0.1')}>Container loopback</option><option value="0.0.0.0"${selected(view.listen === '0.0.0.0')}>Container interfaces</option></select>`, 'Host port mappings and Compose sidecars need Container interfaces. A connector in this container can reach loopback.')}
        ${field('keys', 'Authorized public keys', area('keys', view.keys, 6), 'Paste public keys only, one per line. Your private keys stay on your devices. Root and password login stay disabled.')}
        <p class="tc-hint">After installation, add a route using your existing network or a configured connector. Local readiness does not prove your client can reach the server.</p>
        <label class="tc-check"><input type="checkbox" data-service-field="enabled"${checked(view.enabled)}>Enable SSH after saving</label>`
        : id === 'tailscale' ? tailscaleForm()
        : html`<p class="tc-hint">Use a named Cloudflare Tunnel connector token. Configure its hostname, SSH origin and Access policy in Cloudflare. T3’s existing HTTP quick tunnels keep their own lifecycle.</p>${field('token', resource ? 'Replace connector token (optional)' : 'Connector token', input('token', view.token, 'password'), resource ? 'Leave blank to keep the saved token.' : 'This is saved in protected system service storage and never returned to the browser.')}<label class="tc-check"><input type="checkbox" data-service-field="enabled"${checked(view.enabled)}>Enable connector</label>`;
      const render = () => html`<div class="tc-sheet-head"><div class="tc-sheet-head-text"><h2 id="svc-editor-title" class="tc-sheet-title">${view.editing ? 'Edit ' + (config.name || id) : system ? 'Set up ' + ({ openssh: 'SSH', tailscale: 'Tailscale', cloudflared: 'Cloudflare Tunnel' })[id] : 'Add a custom service'}</h2><span class="tc-small tc-muted">${system ? 'Optional installation · protected storage' : ['1. Command', '2. Behavior', '3. Review'][view.step]}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-service-edit="close" aria-label="Close">${icon('x')}</button></div>
        <div class="tc-sheet-body tc-service-form">${view.error && !view.field ? html`<div class="tc-notice tc-notice--danger" role="alert">${view.error}</div>` : ''}${system ? systemForm() : view.step === 0 ? command() : behavior()}</div>
        <div class="tc-sheet-foot"><span class="tc-hint">${id === 'tailscale' && view.networkMode === 'kernel' ? 'Affects networking for all programs.' : system ? 'T3 keeps running.' : 'Runs as your user account.'}</span><span class="tc-spacer"></span>${!system && view.step > 0 ? html`<button class="tc-btn" type="button" data-service-edit="back"${disabled(view.busy)}>Back</button>` : ''}<button class="tc-btn tc-btn--primary" type="button" data-service-edit="next"${disabled(view.busy || id === 'tailscale' && view.networkMode === 'kernel' && !view.requirements?.ready)}>${view.busy ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking…` : system || view.step > 0 ? 'Review changes' : 'Continue'}</button></div>`;
      view.layer = Kit.open({ kind: 'sheet', panel: { class: 'tc-sheet tc-service-editor' + (Kit.isPhone() ? ' tc-sheet--bottom' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'svc-editor-title' }, render, backdrop: 'ignore', onEscape: () => void view.requestClose(), onClose: () => { if (active === view) active = null; } });
      // Compare serializable fields only; the layer contains DOM cycles.
      const formSignature = () => JSON.stringify({ name: view.name, mode: view.mode, executable: view.executable, shell: view.shell, script: view.script, args: view.args, cwd: view.cwd, tools: view.tools, restart: view.restart, enabled: view.enabled, health: view.health, port: view.port, healthPath: view.healthPath, variables: view.variables, endpoints: view.endpoints, shutdownMs: view.shutdownMs, listen: view.listen, sshPort: view.sshPort, keys: view.keys, hostname: view.hostname, token: view.token, networkMode: view.networkMode });
      view.original ??= formSignature();
      view.requestClose = async () => { if (view.busy) return false; if (formSignature() !== view.original && !await Kit.confirm({ title: 'Discard service changes?', body: 'Your changes have not been applied.', confirm: 'Discard', tone: 'danger' })) return false; view.layer.close('close'); return true; };
      const unload = event => { if (view.busy || formSignature() !== view.original) { event.preventDefault(); event.returnValue = ''; } };
      window.addEventListener('beforeunload', unload);
      const previousClose = view.layer.onClose;
      view.layer.onClose = reason => { window.removeEventListener('beforeunload', unload); previousClose?.(reason); };
      const inventory = async () => {
        view.inventoryLoading = true; paint(); const response = await ctx.api('/services/inventory', { body: { domain: 'user' } });
        if (active !== view) return;
        view.inventoryLoading = false; view.inventoryError = response.ok ? null : response.error; view.inventory = response.data?.tools || [];
        if (catalogue === 'http-preview' && !view.editing && !view.nameChanged) {
          const python = view.inventory.find(item => item.tool === 'python');
          if (python) { view.mode = 'mise'; view.tools = ['python@' + python.version]; view.executable = 'python'; }
          else { view.mode = 'executable'; view.executable = '/usr/bin/python3'; }
          view.args = ['-m', 'http.server', '8080', '--bind', '127.0.0.1']; view.health = 'http'; view.port = 8080;
          view.original = formSignature();
        }
        paint();
      };
      view.layer.panel.addEventListener('input', event => {
        const name = event.target.dataset.serviceField;
        if (name) view.nameChanged = true;
        if (name) { view[name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value; view.error = null; view.field = null; }
        if (event.target.hasAttribute('data-service-arg')) view.args[Number(event.target.dataset.serviceArg)] = event.target.value;
        if (event.target.hasAttribute('data-service-variable')) view.variables[Number(event.target.dataset.index)][event.target.dataset.serviceVariable] = event.target.value;
        if (event.target.hasAttribute('data-service-endpoint')) view.endpoints[Number(event.target.dataset.index)][event.target.dataset.serviceEndpoint] = event.target.value;
      });
      view.layer.panel.addEventListener('change', event => {
        if (event.target.hasAttribute('data-service-tool')) view.tools[Number(event.target.dataset.serviceTool)] = event.target.value;
        if (event.target.dataset.serviceVariable === 'source') { view.variables[Number(event.target.dataset.index)].value = ''; paint(); }
        if (['mode', 'health', 'networkMode'].includes(event.target.dataset.serviceField)) { if (view.mode === 'mise' && !view.tools.length) view.tools.push(''); paint(); if (view.networkMode === 'kernel' && !view.requirements) void checkNetwork(); }
      });
      view.layer.panel.addEventListener('click', async event => {
        const button = event.target.closest('[data-service-edit]'); if (!button || button.disabled) return;
        const action = button.dataset.serviceEdit, index = Number(button.dataset.index);
        if (action === 'close') return view.requestClose();
        if (action === 'back') { view.step--; paint(); return; }
        if (action === 'add-arg') { view.args.push(''); paint(); view.layer.panel.querySelector('[data-service-arg="' + (view.args.length - 1) + '"]')?.focus(); return; }
        if (action === 'remove-arg') { view.args.splice(index, 1); paint(); return; }
        if (action === 'add-tool') { view.tools.push(''); paint(); return; }
        if (action === 'remove-tool') { view.tools.splice(index, 1); paint(); return; }
        if (action === 'add-variable') { view.variables.push({ name: '', source: 'value', value: '' }); paint(); view.layer.panel.querySelector('[data-service-variable="name"][data-index="' + (view.variables.length - 1) + '"]')?.focus(); return; }
        if (action === 'remove-variable') { view.variables.splice(index, 1); paint(); return; }
        if (action === 'add-endpoint') { view.endpoints.push({ port: 8080, protocol: 'http' }); paint(); return; }
        if (action === 'remove-endpoint') { view.endpoints.splice(index, 1); paint(); return; }
        if (action === 'reload-tools') return inventory();
        if (action === 'check-network') return checkNetwork();
        if (action === 'copy-network') return Kit.copy(view.requirements?.compose || '', button, 'Deployment settings copied');
        if (action === 'toolchains') { remember(); view.layer.close('suspended'); ctx.go('toolchains'); return; }
        if (action !== 'next' || view.busy) return;
        if (!system && view.step === 0) { view.step = 1; paint(); view.layer.panel.querySelector('input,select')?.focus(); return; }
        view.busy = true; view.error = null; view.field = null; paint();
        try {
          const configuration = build();
          const response = await ctx.api('/services/plan', { body: { domain: view.domain, action: view.editing ? 'edit' : system ? 'install' : 'add', ...(view.id ? { id: view.id } : {}), expectedRevision: view.revision, configuration } });
          view.busy = false;
          if (!response.ok) {
            view.error = response.error; view.field = response.data?.field;
            view.field = ({ 'working directory': 'cwd', 'health port': 'port', env: 'variables', secrets: 'variables' })[view.field] || view.field;
            if (!['name', 'mode', 'executable', 'argv', 'script', 'shell', 'tools', 'cwd', 'variables', 'endpoints', 'shutdownMs', 'restart', 'health', 'port', 'keys', 'listen', 'hostname', 'token', 'networkMode'].includes(view.field)) view.field = null;
            if (view.field === 'keys' && /PRIVATE KEY/.test(view.keys)) view.keys = '';
            if (view.field === 'working directory') view.field = 'cwd';
            if (view.field === 'port' && system) view.field = 'sshPort';
            if (!system && ['name', 'executable', 'argv', 'script', 'tools', 'cwd'].includes(view.field)) view.step = 0;
            paint(); const field = view.layer.panel.querySelector('#svc-' + CSS.escape(view.field || '')); if (field?.closest('details')) field.closest('details').open = true; field?.focus(); return;
          }
          paint();
          const result = await ctx.review(response.data, view.domain);
          if (result) { view.token = ''; view.layer.close('applied'); }
        } catch (error) { view.busy = false; view.error = error.message || 'Review could not be prepared.'; view.field = error.field || null; paint(); const field = view.layer.panel.querySelector('#svc-' + CSS.escape(view.field || '')); if (field?.closest('details')) field.closest('details').open = true; field?.focus(); }
      });
      if (id === 'tailscale' && view.networkMode === 'kernel' && !view.requirements) void checkNetwork();
      if (!system) { void inventory(); void ctx.api('/credentials').then(response => { if (active !== view) return; view.vault = response.data?.credentials?.filter(item => item.type === 'token') || []; view.vaultError = response.ok ? null : 'Vault references could not be read. Reopen this editor to retry.'; paint(); }); }
    };
    return { open, close, isOpen: () => Boolean(active), hasDraft: () => Boolean(kept), resume: () => open(), beforeNavigate: close };
  };
  return { create };
})();
