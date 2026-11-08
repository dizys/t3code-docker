// Add/edit/share are reviewed plans: save the definition, then serialize the
// selected native writes with the revisions captured when the form was read.
const T3McpEditor = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3McpModel, M = T3Model, C = T3McpCommand;
  const disabled = value => value ? raw(' disabled') : '';
  const checked = value => value ? raw(' checked') : '';
  const equal = S.sameValue;
  const create = ctx => {
    let active = null, removeView = null, sequence = 0;
    const open = async (options = {}) => {
      if (!await close('replace') || removeView) return;
      const mode = options.mode || (options.name ? 'edit' : 'add'), initial = ctx.library();
      const view = { mode, name: options.name || '', source: options.provider || '', replace: Boolean(options.replace), loading: mode !== 'add', busy: false, error: null,
        snapshot: structuredClone(initial.data), agents: new Set(), consent: new Set(), versions: new Map(), server: null, original: null, baselineAgents: '',
        snippet: '', parse: null, parsing: false, parseError: null, parseVersion: 0, parseTimer: null, edits: 0, parseWaiting: false, railOpen: !Kit.isPhone(), saved: null, results: null,
        draft: { name: options.name || '', type: 'local', line: '', argv: [''], rows: false, url: '', local: [], remote: [] } };
      active = view;
      const pairs = () => view.draft.type === 'local' ? view.draft.local : view.draft.remote;
      const provider = id => view.snapshot.providers.find(p => p.provider === id);
      const managed = initial.managed;
      const newPair = (name = '', value = '', reveal = false) => ({ id: ++sequence, name, value, reveal });
      const loadServer = server => {
        view.draft = { name: server.name, type: server.type, line: C.line(server.command || []), argv: server.command || [''], rows: C.needsRows(server.command || []), url: server.url || '',
          local: Object.entries(server.env || {}).map(([key, value]) => newPair(key, value, mode === 'add')),
          remote: Object.entries(server.headers || {}).map(([key, value]) => newPair(key, value, mode === 'add')) };
      };
      const serialize = () => {
        const d = view.draft, entries = pairs().filter(row => row.name || row.value), names = entries.map(row => row.name);
        const name = d.name.trim();
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error('Use 1–64 lowercase letters, numbers and single hyphens.');
        if (names.length > 64) throw new Error('A server holds at most 64 entries.');
        const remote = d.type === 'remote', normalized = names.map(name => remote ? name.toLowerCase() : name);
        if (new Set(normalized).size !== names.length) throw new Error(remote ? 'Header names must be unique regardless of letter case.' : 'Variable names must be unique.');
        for (const pair of entries) {
          if (!(remote ? /^[A-Za-z0-9-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(pair.name) || pair.name.length > 128) throw new Error('Enter a valid ' + (remote ? 'header' : 'variable') + ' name for each value.');
          if (pair.value.length > 8192 || (remote ? /[\r\n\0]/ : /\0/).test(pair.value)) throw new Error('Use a valid value of at most 8192 characters for ' + pair.name + '.');
        }
        const values = Object.fromEntries(entries.map(row => [row.name, row.value]));
        if (remote) {
          let url; try { url = new URL(d.url.trim()); } catch { throw new Error('Enter a valid HTTP or HTTPS URL.'); }
          if (!['https:', 'http:'].includes(url.protocol) || d.url.length > 2048 || /[\r\n\0]/.test(d.url)) throw new Error('Enter a valid HTTP or HTTPS URL of at most 2048 characters.');
          if (url.username || url.password) throw new Error('Put remote credentials in Headers, not in the URL.');
          if (url.pathname.replace(/\/$/, '').endsWith('/sse')) throw new Error('SSE-only servers aren’t portable. Use the server’s Streamable HTTP address.');
          return { name, type: 'remote', url: d.url.trim(), headers: values };
        }
        const argv = d.rows ? d.argv : C.lex(d.line);
        if (!argv.length || !argv[0] || argv.length > 32 || argv.some(arg => arg.length > 1024 || arg.includes('\0'))) throw new Error('Enter an executable and at most 31 arguments, each up to 1024 characters.');
        return { name, type: 'local', command: argv, env: values };
      };
      const validation = () => { try { serialize(); return null; } catch (error) { return error.message; } };
      const formState = () => JSON.stringify({ ...view.draft, local: view.draft.local.map(({ name, value }) => ({ name, value })), remote: view.draft.remote.map(({ name, value }) => ({ name, value })) });
      const choices = () => [...view.agents].sort().join(',');
      const dirty = () => view.busy || Boolean(view.snippet) || view.original !== null && (view.source !== view.baselineSource || formState() !== view.original || choices() !== view.baselineAgents || view.consent.size > 0);
      const closeDraft = async reason => {
        if (view.busy || view.closing) { if (view.busy) Kit.announce('Wait for the server changes to finish saving.'); return false; }
        if (dirty() && !view.saved) {
          view.closing = true;
          const yes = await Kit.confirm({ title: 'Discard changes?', body: 'Your MCP server changes have not been saved.', confirm: 'Discard changes', tone: 'danger' });
          view.closing = false; if (!yes || active !== view) return false;
        }
        view.layer.close(reason); return true;
      };
      view.close = closeDraft;
      const beforeUnload = event => { if (view.busy || !view.saved && dirty()) { event.preventDefault(); event.returnValue = ''; } };
      const collision = id => provider(id)?.own?.some(row => row.name === view.draft.name.trim());
      const existingShared = () => mode === 'add' && view.snapshot.shared.servers.some(s => s.name === view.draft.name.trim());
      const versionDiffers = id => {
        const source = view.versions.get(view.source), other = view.versions.get(id);
        return id !== view.source && S.has(provider(id), view.name) && (!other?.server || !S.sameDefinition(source?.server, other.server) || other.extra?.length > 0);
      };
      const replacementNeeded = id => mode === 'share' ? versionDiffers(id) : mode === 'add' && collision(id);
      const consentNeeded = () => [...view.agents].filter(id => replacementNeeded(id));
      const changedFields = () => {
        if (!view.server || mode !== 'edit') return [];
        let server; try { server = serialize(); } catch { return ['Form']; }
        return [['type', 'Type'], ['command', 'Command'], ['url', 'URL'], ['env', 'Environment'], ['headers', 'Headers']].filter(([key]) => !equal(server[key], view.server[key])).map(([, label]) => label);
      };
      const canSubmit = () => !view.loading && !view.busy && !view.saved && !view.error?.blocking && !view.error?.stale && (mode === 'share' ? Boolean(view.versions.get(view.source)?.server)
        : !validation() && !existingShared() && (mode !== 'edit' || changedFields().length || choices() !== view.baselineAgents)) && consentNeeded().every(id => view.consent.has(id));
      const submitLabel = () => view.busy ? mode === 'share' ? 'Sharing' : mode === 'edit' ? 'Saving' : 'Adding'
        : mode === 'share' ? 'Share and use in ' + M.plural(view.agents.size, 'agent') : mode === 'edit' ? view.agents.size ? 'Save and update ' + M.plural(view.agents.size, 'agent') : 'Save' : view.agents.size ? 'Add to ' + M.plural(view.agents.size, 'agent') : 'Add server';
      const sync = () => {
        const panel = view.layer.panel;
        for (const input of panel.querySelectorAll('[data-mcp-field]')) {
          const key = input.dataset.mcpField; let value = view.draft[key];
          if (key === 'argv') value = view.draft.argv[Number(input.dataset.index)];
          if (key === 'pair-name' || key === 'pair-value') value = pairs().find(row => row.id === Number(input.dataset.pair))?.[key === 'pair-name' ? 'name' : 'value'];
          if (input.value !== String(value ?? '')) input.value = value ?? '';
        }
        for (const input of panel.querySelectorAll('[data-mcp-agent]')) input.checked = view.agents.has(input.dataset.mcpAgent);
        for (const input of panel.querySelectorAll('[data-mcp-consent]')) input.checked = view.consent.has(input.dataset.mcpConsent);
        for (const input of panel.querySelectorAll('[data-mcp-source]')) input.checked = input.dataset.mcpSource === view.source;
        const submit = panel.querySelector('[data-mcp-editor="save"]'); if (submit) submit.disabled = !canSubmit();
      };
      const paint = () => { if (active !== view || view.layer?.closed) return; view.layer.render(); sync(); };
      view.repaint = paint;
      const pickDefaults = () => {
        if (mode !== 'add') return;
        for (const p of managed) if (!provider(p.id)?.error) { if (collision(p.id)) view.agents.delete(p.id); }
      };
      const fillSnippet = index => {
        const server = view.parse?.servers?.[index]; if (!server) return;
        loadServer(server); view.edits++; pickDefaults(); view.parseWaiting = false; paint();
      };
      const parse = async () => {
        const version = ++view.parseVersion, edits = view.edits, snippet = view.snippet;
        if (!snippet.trim()) { view.parse = null; view.parseError = null; view.parsing = false; paint(); return; }
        view.parsing = true; view.parseError = null; view.parse = null; paint();
        const response = await ctx.api('/context/mcp/parse', { body: { text: snippet } });
        if (active !== view || view.busy || version !== view.parseVersion) return;
        view.parsing = false;
        if (!response.ok || !response.data.servers?.length) { view.parseError = response.error || response.data.errors?.join(' ') || 'No supported servers found in that snippet.'; paint(); return; }
        view.parse = response.data;
        if (view.edits !== edits) { view.parseWaiting = true; paint(); return; }
        fillSnippet(0);
      };
      const changedBadge = label => changedFields().includes(label) ? html`<span class="tc-changed">Changed</span>` : '';
      const argv = () => { try { return view.draft.rows ? view.draft.argv : C.lex(view.draft.line); } catch { return []; } };
      const snippetForm = () => html`<div class="tc-form-field"><label class="tc-label" for="mcp-snippet">Start from a snippet <span class="tc-muted">optional</span></label><textarea class="tc-input tc-paste" id="mcp-snippet" data-key="mcp-snippet" rows="4" placeholder="Paste a server snippet, command or URL" spellcheck="false"${disabled(view.busy)}>${view.snippet}</textarea><div class="tc-paste-meta"${view.parseError ? raw(' role="alert"') : ''}>${view.parsing ? html`<span class="tc-spinner"></span>Reading snippet…` : view.parseError ? html`<span class="tc-danger">${view.parseError}</span>` : view.parse ? html`${icon('circle-check')}Read as <strong>${formatName(view.parse.format)}</strong> · ${M.plural(view.parse.servers.length, 'server')} · ${view.parseWaiting ? 'ready to use' : 'filled in below'}${view.parseWaiting ? html`<button class="tc-btn tc-btn--link" type="button" data-mcp-editor="use-snippet">Use snippet</button>` : ''}` : ''}${view.snippet ? html`<span class="tc-spacer"></span><button class="tc-btn tc-btn--link" type="button" data-mcp-editor="clear-snippet"${disabled(view.busy)}>Clear</button>` : ''}</div>${view.parse?.servers.length > 1 ? html`<label class="tc-label" for="mcp-snippet-choice">Found ${view.parse.servers.length} servers</label><select class="tc-select" id="mcp-snippet-choice"${disabled(view.busy)}>${view.parse.servers.map((s, index) => html`<option value="${index}">${s.name}</option>`)}</select>` : ''}<p class="tc-hint">Also takes Codex TOML, OpenCode JSON, a <code>claude mcp add</code> command, a command line or a URL. Nothing you paste is run.</p>${view.parse?.notes?.map(note => html`<p class="tc-hint">${note}</p>`)}${view.parse?.errors?.length ? html`<p class="tc-warning">Some entries couldn’t be read: ${view.parse.errors.join(' ')}</p>` : ''}</div>`;
      const pairValue = (pair, index) => {
        const multiline = /[\r\n]/.test(pair.value), label = 'Value for ' + (pair.name || 'entry ' + (index + 1));
        const classes = 'tc-input tc-mcp-secret-input' + (C.placeholder(pair.value) ? ' tc-input--warn' : '');
        if (multiline && pair.reveal) return html`<textarea class="${classes}" wrap="off" data-mcp-field="pair-value" data-pair="${pair.id}" rows="2" aria-label="${label}" spellcheck="false" autocomplete="off"${disabled(view.busy)}>${pair.value}</textarea>`;
        // Password inputs strip line breaks. Keep multiline values in memory
        // until reveal rather than silently damaging them or relying on CSS masks.
        return html`<input class="${classes}" type="${pair.reveal ? 'text' : 'password'}"${multiline ? raw(' readonly placeholder="Reveal to edit multiline value"') : html` data-mcp-field="pair-value" value="${pair.value}"`} data-mcp-secret="${pair.id}" data-pair="${pair.id}" aria-label="${label}" spellcheck="false" autocomplete="off" autocapitalize="none"${disabled(view.busy)}>`;
      };
      const fields = () => html`<div class="tc-form">${mode === 'add' ? snippetForm() : ''}<div class="tc-form-row"><div class="tc-form-field"><label class="tc-label" for="mcp-name">Name</label><input class="tc-input tc-input--mono" id="mcp-name" data-key="mcp-name" data-mcp-field="name" value="${view.draft.name}" maxlength="64" spellcheck="false" autocapitalize="none"${mode === 'edit' ? raw(' readonly') : ''}${disabled(view.busy)}>${mode === 'add' && view.draft.name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(view.draft.name) ? html`<span class="tc-danger tc-hint" role="alert">Use lowercase letters, numbers and single hyphens.</span>` : ''}</div><div class="tc-form-field"><span class="tc-label" id="mcp-type-label">Type ${changedBadge('Type')}</span><div class="tc-seg" role="group" aria-labelledby="mcp-type-label"><button type="button" data-mcp-editor="type" data-type="local" aria-pressed="${String(view.draft.type === 'local')}"${disabled(view.busy)}>${icon('terminal')}Local command</button><button type="button" data-mcp-editor="type" data-type="remote" aria-pressed="${String(view.draft.type === 'remote')}"${disabled(view.busy)}>${icon('globe')}Remote URL</button></div></div></div>
        ${mode === 'edit' ? html`<p class="tc-hint">Names can’t change. To rename, add it under the new name and remove this one.</p>` : ''}
        ${existingShared() ? html`<div class="tc-notice tc-notice--danger" role="alert"><div>A shared server called ${view.draft.name} exists. <button class="tc-btn tc-btn--link" type="button" data-mcp-editor="edit-existing">Edit it instead.</button></div></div>` : ''}
        ${mode === 'add' ? managed.filter(p => collision(p.id)).map(p => html`<div class="tc-notice tc-notice--warn"><div>${p.name} already has its own ${view.draft.name}. Adding replaces it (backup kept). <button class="tc-btn tc-btn--link" type="button" data-mcp-editor="share-existing" data-provider="${p.id}">Share that one instead?</button></div></div>`) : ''}
        ${view.draft.type === 'local' ? html`<div class="tc-form-field"><label class="tc-label" for="mcp-command">Command ${changedBadge('Command')}</label>${view.draft.rows ? html`<div class="tc-mcp-arguments">${view.draft.argv.map((arg, index) => html`<div class="tc-mcp-argument" data-key="mcp-argument-${index}"><label class="tc-sr" for="mcp-arg-${index}">${index ? 'Argument ' + index : 'Executable'}</label><textarea class="tc-input tc-input--mono" id="mcp-arg-${index}" data-mcp-field="argv" data-index="${index}" rows="1"${disabled(view.busy)}>${arg}</textarea>${index ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-mcp-editor="remove-arg" data-index="${index}" aria-label="Remove argument ${index}"${disabled(view.busy)}>${icon('x')}</button>` : html`<span class="tc-hint">Executable</span>`}</div>`)}<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-mcp-editor="add-arg"${disabled(view.busy || view.draft.argv.length >= 32)}>${icon('plus')}Add argument</button></div>` : html`<input class="tc-input tc-input--mono" id="mcp-command" data-key="mcp-command" data-mcp-field="line" value="${view.draft.line}" placeholder="npx -y @example/server" spellcheck="false"${disabled(view.busy)}>`}<div class="tc-argv">${argv().map((arg, index) => html`<span class="tc-arg${!index ? ' tc-arg--exe' : ''}" title="${arg}">${arg || '""'}</span>`)}<button class="tc-btn tc-btn--link" type="button" data-mcp-editor="argv-mode"${disabled(view.busy)}>${view.draft.rows ? 'Edit command line' : 'Edit one per line'}</button></div>${changedFields().includes('Command') ? html`<p class="tc-hint">Was <code>${C.line(view.server.command || [])}</code></p>` : ''}</div>` : html`<div class="tc-form-field"><label class="tc-label" for="mcp-url">URL ${changedBadge('URL')}</label><input class="tc-input tc-input--mono" id="mcp-url" data-key="mcp-url" data-mcp-field="url" value="${view.draft.url}" placeholder="https://…/mcp" inputmode="url" spellcheck="false"${disabled(view.busy)}>${changedFields().includes('URL') ? html`<p class="tc-hint">Was <code>${view.server.url}</code> · Streamable HTTP</p>` : ''}</div>`}
        <div class="tc-form-field"><div class="tc-label"><label for="mcp-pairs">${view.draft.type === 'local' ? 'Environment' : 'Headers'}</label>${changedBadge(view.draft.type === 'local' ? 'Environment' : 'Headers')}<span class="tc-spacer"></span><span class="tc-hint">Values stay in this container. Lists show names only.</span></div><div class="tc-kvs" id="mcp-pairs">${pairs().map((pair, index) => html`<div class="tc-kv-row" data-key="mcp-pair-${pair.id}"><input class="tc-input" data-mcp-field="pair-name" data-pair="${pair.id}" value="${pair.name}" aria-label="${view.draft.type === 'local' ? 'Variable' : 'Header'} name ${index + 1}" placeholder="${view.draft.type === 'local' ? 'VARIABLE_NAME' : 'Header-Name'}" autocapitalize="none" spellcheck="false"${disabled(view.busy)}><span class="tc-secret">${pairValue(pair, index)}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-mcp-editor="reveal" data-pair="${pair.id}" aria-label="${pair.reveal ? 'Hide' : 'Reveal'} ${pair.name || 'value'}" aria-pressed="${String(pair.reveal)}"${disabled(view.busy)}>${icon(pair.reveal ? 'eye-off' : 'eye')}</button></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-mcp-editor="remove-pair" data-pair="${pair.id}" aria-label="Remove ${pair.name || 'entry ' + (index + 1)}"${disabled(view.busy)}>${icon('x')}</button></div>`)}<div class="tc-kv-foot"><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-mcp-editor="add-pair"${disabled(view.busy || pairs().length >= 64)}>${icon('plus')}Add ${view.draft.type === 'local' ? 'variable' : 'header'}</button></div></div>${pairs().filter(pair => C.placeholder(pair.value)).map(pair => html`<p class="tc-hint tc-warning">${pair.name || 'This value'} still holds the snippet’s placeholder. Paste your token in its place.</p>`)}</div>
        ${validation() && (view.draft.name || view.draft.line || view.draft.url) ? html`<p class="tc-hint tc-danger" id="mcp-form-error">${validation()}</p>` : ''}
        ${view.draft.type === 'remote' && mode === 'edit' ? html`<div class="tc-notice tc-notice--info">${icon('log-in')}<div class="tc-notice-body"><strong class="tc-notice-title">Sign-in isn’t stored here</strong><span class="tc-notice-desc">If ${view.name} asks you to sign in, each agent does it on its own. The commands are on the server’s page.</span></div></div>` : ''}${consents()}</div>`;
      const consents = () => consentNeeded().map(id => html`<label class="tc-import-consent"><input class="tc-checkbox" type="checkbox" data-mcp-consent="${id}"${checked(view.consent.has(id))}${disabled(view.busy)}><span><strong>Replace ${S.nameOf(id)}’s ${view.draft.name} entry</strong><span>${S.nameOf(id)} gets ${mode === 'share' ? S.nameOf(view.source) + '’s version' : 'the new shared version'}. A backup of <code>${ctx.pathLabel(provider(id)?.path)}</code> is kept beside it.</span></span></label>`);
      const shareBody = () => {
        const allVersions = [...view.versions], chosen = view.versions.get(view.source);
        const identical = allVersions.length > 1 && allVersions.every(([, v]) => v.server && S.sameDefinition(v.server, chosen?.server));
        const versions = identical ? allVersions.filter(([id]) => id === view.source) : allVersions;
        return html`<div class="tc-form"><div class="tc-form-field"><h3 class="tc-step-title">${versions.length > 1 ? 'Which version should every agent use?' : 'Share this server with your other agents'}</h3><p class="tc-hint">${versions.length > 1 ? M.listOf(versions.map(([id]) => S.nameOf(id))) + ' each have their own ' + view.name + ' entry.' : 'The source agent’s entry stays exactly as it is.'}</p></div>${versions.map(([id, version]) => html`<label class="tc-choice${versions.length === 1 ? ' tc-choice--summary' : ''}" data-checked="${String(view.source === id)}" data-key="mcp-version-${id}">${versions.length > 1 ? html`<input type="radio" name="mcp-source" data-mcp-source="${id}"${checked(view.source === id)}${disabled(view.busy || !version.server)}>` : ''}<span class="tc-choice-head">${ctx.mark(id)}${S.nameOf(id)}’s version<span class="tc-spacer"></span><code class="tc-hint">${ctx.pathLabel(version.path)}</code></span><span class="tc-choice-body">${version.error || !version.server ? html`<span class="tc-danger">${version.error || 'This entry’s format isn’t supported here.'}</span>` : html`${version.server.type === 'remote' ? html`<code>${version.server.url}</code>` : html`<span class="tc-argv">${version.server.command.map((arg, index) => html`<span class="tc-arg${index ? '' : ' tc-arg--exe'}">${arg || '""'}</span>`)}</span>`}${ctx.keyChips({ envKeys: Object.keys(version.server.env || {}), headerKeys: Object.keys(version.server.headers || {}) })}`}</span></label>`)}<p class="tc-hint">Values are copied as they are, secrets included. You can edit the shared server afterwards.${chosen?.extra?.length ? html` Options the shared format can’t hold are dropped: <code>${chosen.extra.join(', ')}</code>. The source agent keeps them until its copy is updated.` : ''}</p>${consents()}</div>`;
      };
      const railAgents = () => {
        if (mode === 'add') return managed;
        const rank = p => mode === 'share' ? p.id === view.source ? 0 : S.has(provider(p.id), view.name) ? 1 : 2
          : provider(p.id)?.linked?.includes(view.name) ? 0 : provider(p.id)?.diverged?.includes(view.name) ? 1 : 2;
        return [...managed].sort((a, b) => rank(a) - rank(b));
      };
      const railHint = () => {
        if (mode === 'edit') return 'Open sessions keep the old version until they end.';
        const differing = mode === 'share' ? managed.filter(p => versionDiffers(p.id)).map(p => p.name) : [];
        if (differing.length) return 'Uncheck ' + M.listOf(differing) + ' to keep ' + (differing.length === 1 ? 'its own version. It then shows Differs.' : 'their own versions. They then show Differs.');
        return 'Nothing starts here. Agents start the server in their next session.';
      };
      const rail = () => html`<details class="tc-wizard-rail-wrap"${view.railOpen || !Kit.isPhone() ? raw(' open data-open') : ''}><summary class="tc-wizard-rail-toggle"><span>${mode === 'edit' ? 'When you save' : 'Use in'} · ${M.plural(view.agents.size, 'agent')}</span>${icon('chevron-down')}</summary><aside class="tc-wizard-rail"><span class="tc-insp-label">${mode === 'edit' ? 'When you save' : 'Use in'}</span><div class="tc-agentpick">${railAgents().map(p => {
        const native = provider(p.id), state = S.state(view.snapshot, { name: view.draft.name.trim(), shared: true }, p.id), warn = mode === 'share' ? versionDiffers(p.id) : state.kind === 'differs' || collision(p.id);
        const label = mode === 'edit' ? (state.kind === 'differs' ? 'Replace in ' : state.kind === 'none' ? 'Add to ' : 'Update ') + p.name : p.name;
        const note = native?.error || (mode === 'edit' ? state.kind === 'differs' ? 'Its copy differs. Its own changes would be lost.' : state.kind === 'none' ? 'Not added yet' : 'Uses the shared version' + (state.kind === 'off' ? ' · stays Off' : '') : mode === 'share' ? p.id === view.source ? 'Already has this version' : versionDiffers(p.id) ? 'Its version is replaced' : S.has(native, view.name) ? 'Already has this version' : 'Added' : ctx.pathLabel(native?.path));
        return html`<label class="tc-agentpick-row" data-tone="${warn ? 'warn' : ''}" data-off="${String(!view.agents.has(p.id))}"><input class="tc-checkbox" type="checkbox" data-mcp-agent="${p.id}"${checked(view.agents.has(p.id))}${disabled(view.busy || native?.error || mode === 'share' && p.id === view.source)}>${ctx.mark(p.id)}<span class="tc-row-main"><span class="tc-avail-name">${label}</span><span class="tc-avail-note${mode === 'add' ? ' tc-mono' : ''}" title="${native?.path || note}">${note}</span></span></label>`;
      })}</div>${!managed.length ? html`<p class="tc-hint">No managed agents are installed. Save the server now, then add it after installing an agent.</p>` : ''}<p class="tc-hint">Each selected agent uses its native settings. Start a new session after saving.</p><div class="tc-plan-section"><div class="tc-plan-stat"><strong>${view.agents.size}</strong><span>${mode === 'edit' ? 'agents update' : mode === 'share' ? 'agents use ' + view.name : 'settings files change'}</span></div><p class="tc-hint">${mode === 'edit' ? 'Agents you leave unchecked keep their current copy and show Differs until you update them.' : mode === 'share' ? view.name + ' moves to Shared servers. ' + S.nameOf(view.source) + '’s entry stays exactly as it is.' : 'Only the ' + (view.draft.name || 'named') + ' entry is written. Other servers and settings in those files stay as they are, and a backup of each is kept.'}</p></div><p class="tc-hint tc-plan-bottom">${icon('info', 'tc-icon--sm')}${railHint()}</p></aside></details>`;
      const resultBody = () => html`<div class="tc-notice tc-notice--${view.results.some(r => !r.ok) ? 'warn' : 'info'}" role="status">${icon('info')}<div class="tc-notice-body"><strong>Shared server ${mode === 'share' ? 'shared' : 'saved'}</strong><span class="tc-notice-desc">${M.plural(view.results.filter(r => r.ok).length, 'agent')} updated. Other entries stay as they are.</span></div></div><div class="tc-group">${view.results.map(result => html`<div class="tc-avail-row">${ctx.mark(result.provider)}<div class="tc-row-main"><strong class="tc-avail-name">${S.nameOf(result.provider)}</strong><span class="tc-avail-note">${result.ok ? 'Saved' : result.error}</span></div>${icon(result.ok ? 'circle-check' : 'triangle-alert')}</div>`)}</div><p class="tc-hint">Review the current settings before retrying a failed agent. Changes that succeeded are already saved.</p><button class="tc-btn tc-btn--sm" type="button" data-mcp-editor="review-result">Review current settings</button>`;
      const title = () => mode === 'share' ? view.replace ? 'Use ' + S.nameOf(view.source) + '’s version of ' + view.name : 'Share ' + view.name : mode === 'edit' ? 'Edit ' + view.name : 'Add MCP server';
      view.layer = Kit.open({ kind: 'center', panel: { class: 'tc-wizard tc-mcp-editor', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mcp-editor-title' }, backdrop: 'ignore', onEscape: () => { void closeDraft('escape'); },
        focus: '[data-mcp-editor="close"]', onClose: () => { clearTimeout(view.parseTimer); view.parseVersion++; window.removeEventListener('beforeunload', beforeUnload); view.versions.clear(); view.server = null; view.parse = null; view.draft.local = []; view.draft.remote = []; if (active === view) active = null; },
        render: () => html`<div class="tc-wizard-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(view.draft.type === 'remote' ? 'globe' : 'plug')}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="mcp-editor-title">${title()}</h2><span class="tc-small tc-muted">${mode === 'share' ? view.replace ? 'Replace the shared definition, then update the agents you choose.' : 'Make it a shared server you manage for every agent from here.' : mode === 'edit' ? 'Shared server · used by ' + (M.listOf(S.used(view.snapshot, { name: view.name }, initial.installed).map(S.nameOf)) || 'no agents') : 'Define it once, then choose which agents use it.'}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-mcp-editor="close" aria-label="Close server editor"${disabled(view.busy)}>${icon('x')}</button></div><div class="tc-wizard-grid"><div class="tc-wizard-main">${view.error ? html`<div class="tc-notice tc-notice--danger" role="alert"><div class="tc-notice-body"><strong>Couldn’t complete this change</strong><span class="tc-notice-desc">${view.error.message || view.error}</span>${view.error.stale ? html`<button class="tc-btn tc-btn--sm" type="button" data-mcp-editor="reload">Reload current settings</button>` : ''}</div></div>` : ''}${view.loading ? html`<p role="status" class="tc-hint"><span class="tc-spinner"></span>Reading server settings…</p>` : view.saved ? resultBody() : view.error?.blocking ? html`<button class="tc-btn tc-btn--sm" type="button" data-mcp-editor="reload">Reload settings</button>` : mode === 'share' ? shareBody() : fields()}</div>${!view.saved && !view.loading && !view.error?.blocking ? rail() : ''}</div><div class="tc-wizard-foot"><span class="tc-hint tc-wizard-keyboard">${mode === 'edit' && changedFields().length ? M.plural(changedFields().length, 'unsaved change') + ' · ' + changedFields().join(', ') : '⌘ ↵ to ' + (mode === 'share' ? 'share' : mode === 'edit' ? 'save' : 'add')}</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost" type="button" data-mcp-editor="close"${disabled(view.busy)}>${view.saved ? 'Done' : 'Cancel'}</button>${!view.saved ? html`<button class="tc-btn tc-btn--primary" type="button" data-mcp-editor="save"${disabled(!canSubmit())}>${view.busy ? html`<span class="tc-spinner"></span>` : ''}${submitLabel()}</button>` : ''}</div>` });
      window.addEventListener('beforeunload', beforeUnload);
      const submit = async () => {
        if (!canSubmit()) return;
        view.busy = true; view.error = null; clearTimeout(view.parseTimer); view.parseVersion++; paint();
        let response;
        if (mode === 'share') response = await ctx.api('/context/mcp/adopt', { body: { provider: view.source, name: view.name, providerRevision: view.versions.get(view.source).providerRevision,
          sharedRevision: view.snapshot.shared.revision, replace: view.replace } });
        else {
          const server = serialize();
          response = await ctx.api('/context/mcp/' + (mode === 'add' ? 'create' : 'save'), { body: mode === 'add' ? { server } : { name: view.name, revision: view.snapshot.shared.revision, server } });
        }
        if (!response.ok) { view.busy = false; view.error = { message: response.error, blocking: false, stale: response.status === 409 }; paint(); return; }
        const name = view.draft.name.trim(), revision = response.data.revision;
        view.saved = { name, revision }; view.results = [];
        for (const id of view.agents) {
          if (mode === 'share' && id === view.source) { view.results.push({ provider: id, ok: true }); continue; }
          const result = await ctx.api('/context/mcp/link', { body: { provider: id, name, linked: true, sharedRevision: revision,
            providerRevision: mode === 'share' && view.versions.has(id) ? view.versions.get(id).providerRevision : provider(id)?.revision,
            ...(provider(id)?.disabled?.includes(name) ? { enabled: false } : {}) } });
          view.results.push({ provider: id, ok: result.ok, error: result.error });
        }
        await ctx.refresh(); view.busy = false;
        const failures = view.results.filter(r => !r.ok), success = view.results.length - failures.length;
        Kit.toast(failures.length ? 'Added to ' + success + ' of ' + view.results.length + ' agents' : mode === 'share' ? 'Shared ' + name + ' with ' + M.plural(success, 'agent') : mode === 'edit' ? 'Saved ' + name + (success ? ' and updated ' + M.plural(success, 'agent') : '') : 'Added ' + name + (success ? ' to ' + M.plural(success, 'agent') : ''), { tone: failures.length ? 'danger' : 'ok', detail: failures.map(r => S.nameOf(r.provider) + ': ' + r.error).join(' · ') });
        if (!failures.length) view.layer.close('saved'); else paint();
      };
      view.layer.panel.addEventListener('input', event => {
        if (view.busy) return;
        if (event.target.id === 'mcp-snippet') { view.snippet = event.target.value; clearTimeout(view.parseTimer); view.parseVersion++; view.parseTimer = setTimeout(parse, 300); return; }
        const key = event.target.dataset.mcpField; if (!key) return;
        if (key === 'argv') view.draft.argv[Number(event.target.dataset.index)] = event.target.value;
        else if (key === 'pair-name' || key === 'pair-value') pairs().find(p => p.id === Number(event.target.dataset.pair))[key === 'pair-name' ? 'name' : 'value'] = event.target.value;
        else view.draft[key] = event.target.value;
        if (key === 'name') { view.consent.clear(); pickDefaults(); }
        view.edits++; paint();
      });
      view.layer.panel.addEventListener('paste', event => {
        if (view.busy) return;
        if (event.target.dataset.mcpSecret) {
          const value = event.clipboardData.getData('text');
          if (view.draft.type === 'local' && /[\r\n]/.test(value)) {
            event.preventDefault(); const pair = pairs().find(p => p.id === Number(event.target.dataset.mcpSecret)); pair.value = value; pair.reveal = true; view.edits++; paint();
          }
          return;
        }
        if (event.target.dataset.mcpField !== 'pair-name') return;
        const text = event.clipboardData.getData('text');
        const namePattern = view.draft.type === 'local' ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z0-9-]+$/;
        if (!text.split(/\r?\n/).filter(Boolean).every(line => line.includes('=') && namePattern.test(line.slice(0, line.indexOf('='))))) return;
        const additions = text.split(/\r?\n/).filter(Boolean).map(line => { const at = line.indexOf('='); return newPair(line.slice(0, at), line.slice(at + 1), true); });
        if (pairs().length + additions.length - 1 > 64) return;
        event.preventDefault(); const at = pairs().findIndex(p => p.id === Number(event.target.dataset.pair)); pairs().splice(at, 1, ...additions); view.edits++; paint();
      });
      view.layer.panel.addEventListener('change', event => {
        if (view.busy) return;
        if (event.target.id === 'mcp-snippet-choice') { fillSnippet(Number(event.target.value)); return; }
        if (event.target.dataset.mcpAgent) { const id = event.target.dataset.mcpAgent; if (event.target.checked) view.agents.add(id); else view.agents.delete(id); view.consent.delete(id); }
        if (event.target.dataset.mcpConsent) { const id = event.target.dataset.mcpConsent; if (event.target.checked) view.consent.add(id); else view.consent.delete(id); }
        if (event.target.dataset.mcpSource) { view.source = event.target.dataset.mcpSource; if (managed.some(p => p.id === view.source)) view.agents.add(view.source); view.consent.clear(); }
        paint();
      });
      view.layer.panel.addEventListener('toggle', event => {
        if (!Kit.isPhone() || !event.target.matches('.tc-wizard-rail-wrap')) return;
        // The stylesheet shows the panel from data-open, so it has to follow the native toggle.
        view.railOpen = event.target.open; event.target.toggleAttribute('data-open', view.railOpen);
      }, true);
      view.layer.panel.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } });
      view.layer.panel.addEventListener('click', async event => {
        const button = event.target.closest('[data-mcp-editor]'); if (!button || button.disabled) return;
        const action = button.dataset.mcpEditor;
        if (action === 'close') { await closeDraft('close'); return; }
        if (view.busy) return;
        if (action === 'save') { await submit(); return; }
        if (action === 'reload') { if (await closeDraft('reload')) { await ctx.refresh(); await open(options); } return; }
        if (action === 'review-result') { const name = view.saved.name; view.layer.close('review'); await ctx.edit(name); return; }
        if (action === 'edit-existing') { const name = view.draft.name.trim(); if (await closeDraft('replace')) await ctx.edit(name); return; }
        if (action === 'share-existing') { const name = view.draft.name.trim(); if (await closeDraft('replace')) await ctx.share(name, button.dataset.provider); return; }
        if (action === 'clear-snippet') { clearTimeout(view.parseTimer); view.parseVersion++; view.snippet = ''; view.parse = null; view.parseError = null; view.parsing = false; const input = view.layer.panel.querySelector('#mcp-snippet'); if (input) input.value = ''; paint(); return; }
        if (action === 'use-snippet') { fillSnippet(0); return; }
        if (action === 'type') { view.draft.type = button.dataset.type; view.edits++; paint(); return; }
        if (action === 'argv-mode') {
          try { if (!view.draft.rows) view.draft.argv = C.lex(view.draft.line); else view.draft.line = C.line(view.draft.argv); view.draft.rows = !view.draft.rows; view.error = null; }
          catch (error) { view.error = error.message; }
          paint(); return;
        }
        if (action === 'add-arg') { view.draft.argv.push(''); view.edits++; paint(); view.layer.panel.querySelector('#mcp-arg-' + (view.draft.argv.length - 1))?.focus(); return; }
        if (action === 'remove-arg') { view.draft.argv.splice(Number(button.dataset.index), 1); view.edits++; paint(); return; }
        if (action === 'add-pair') { const pair = newPair(); pairs().push(pair); view.edits++; paint(); view.layer.panel.querySelector('[data-mcp-field="pair-name"][data-pair="' + pair.id + '"]')?.focus(); return; }
        if (action === 'remove-pair') { const index = pairs().findIndex(p => p.id === Number(button.dataset.pair)); pairs().splice(index, 1); view.edits++; paint(); return; }
        if (action === 'reveal') { const pair = pairs().find(p => p.id === Number(button.dataset.pair)); pair.reveal = !pair.reveal; paint(); }
      });
      for (const p of managed) if (!provider(p.id)?.error && (mode !== 'edit' || provider(p.id)?.linked.includes(view.name))) view.agents.add(p.id);
      if (mode === 'edit') {
        const response = await ctx.api('/context/mcp/read?name=' + encodeURIComponent(view.name));
        if (active !== view) return;
        if (!response.ok || response.data.revision !== view.snapshot.shared.revision) view.error = { message: response.error || 'Shared settings changed. Reload before editing.', blocking: true };
        else { view.server = response.data.server; loadServer(view.server); }
      } else if (mode === 'share') {
        const ids = view.snapshot.providers.filter(p => p.supported && S.has(p, view.name)).map(p => p.provider);
        for (const id of ids) view.versions.set(id, { path: provider(id)?.path });
        await Promise.allSettled(ids.map(async id => {
          const response = await ctx.api('/context/mcp/read?provider=' + id + '&name=' + encodeURIComponent(view.name));
          if (active !== view) return;
          view.versions.set(id, response.ok && response.data.providerRevision === provider(id)?.revision ? response.data : { error: response.error || 'Settings changed. Reload to choose the current version.', path: provider(id)?.path });
        }));
        if (active !== view) return;
        view.source = ids.includes(options.provider) ? options.provider : ids.find(id => view.versions.get(id)?.server) || '';
        if (managed.some(p => p.id === view.source)) view.agents.add(view.source);
        if (!view.versions.get(view.source)?.server) view.error = { message: view.versions.get(view.source)?.error || 'This entry’s format isn’t supported here.', blocking: true };
        view.draft.name = view.name;
      }
      if (active !== view) return;
      view.loading = false; if (view.snapshot.shared.error) view.error = { message: view.snapshot.shared.error, blocking: true }; pickDefaults(); view.original = formState(); view.baselineAgents = choices(); view.baselineSource = view.source; paint();
    };
    const close = reason => active ? active.close(reason) : removeView ? false : true;
    const remove = async (name, onSuccess) => {
      if (removeView || !await close('remove')) return;
      const view = { snapshot: structuredClone(ctx.library().data), busy: false, error: null, completed: [] };
      removeView = view;
      const agents = () => view.snapshot.providers.filter(p => p.supported && S.has(p, name));
      const blocked = () => view.snapshot.providers.filter(p => p.supported && p.error);
      const render = () => view.layer.render();
      const beforeUnload = event => { if (view.busy) { event.preventDefault(); event.returnValue = ''; } };
      window.addEventListener('beforeunload', beforeUnload);
      view.layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-mcp-remove', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'mcp-remove-title', 'aria-describedby': 'mcp-remove-desc' }, backdrop: 'ignore', focus: '[data-mcp-remove="cancel"]', onEscape: () => { if (!view.busy) view.layer.close('escape'); }, onClose: () => { window.removeEventListener('beforeunload', beforeUnload); if (removeView === view) removeView = null; },
        render: () => html`<div class="tc-dialog-body"><h2 class="tc-dialog-title" id="mcp-remove-title">Remove ${name}?</h2><p class="tc-dialog-desc" id="mcp-remove-desc">It’s taken out of every agent that has it, then the shared server is deleted.</p><ul class="tc-dialog-list">${agents().map(p => html`<li>${ctx.mark(p.provider)}<span><span>${S.nameOf(p.provider)}</span> <code>${ctx.pathLabel(p.path)}</code></span></li>`)}</ul>${agents().filter(p => p.diverged.includes(name)).map(p => html`<p class="tc-hint">${S.nameOf(p.provider)}’s copy differs from the shared server. It’s removed too.</p>`)}<p class="tc-dialog-desc">A backup of each settings file is kept beside it. Open sessions keep ${name} until they end.</p>${blocked().length ? html`<p class="tc-warning">${M.listOf(blocked().map(p => S.nameOf(p.provider)))} settings couldn’t be read. Resolve this before removing the shared server.</p>` : ''}${view.completed.length ? html`<p class="tc-hint">Already removed from ${M.listOf(view.completed.map(S.nameOf))}.</p>` : ''}${view.error ? html`<p class="tc-danger" role="alert">${view.error}</p>` : ''}</div><div class="tc-dialog-foot"><button class="tc-btn tc-btn--ghost" type="button" data-mcp-remove="cancel"${disabled(view.busy)}>Cancel</button><button class="tc-btn tc-btn--danger-solid" type="button" data-mcp-remove="confirm"${disabled(view.busy || blocked().length)}>${view.busy ? html`<span class="tc-spinner"></span>Removing` : agents().length ? 'Remove from ' + M.plural(agents().length, 'agent') : 'Remove'}</button></div>` });
      view.layer.panel.addEventListener('click', async event => {
        const button = event.target.closest('[data-mcp-remove]'); if (!button || button.disabled || view.busy) return;
        if (button.dataset.mcpRemove === 'cancel') { view.layer.close('cancel'); return; }
        view.busy = true; view.error = null; render();
        for (const p of agents()) {
          const result = await ctx.api('/context/mcp/link', { body: { provider: p.provider, name, linked: false, sharedRevision: view.snapshot.shared.revision, providerRevision: p.revision } });
          if (!result.ok) { view.error = S.nameOf(p.provider) + ': ' + result.error; break; }
          view.completed.push(p.provider);
        }
        if (!view.error) {
          const result = await ctx.api('/context/mcp/remove', { body: { name, revision: view.snapshot.shared.revision } });
          if (!result.ok) view.error = result.error;
        }
        await ctx.refresh(); view.busy = false;
        if (!view.error) { view.layer.close('removed'); onSuccess(); Kit.toast('Removed ' + name); return; }
        view.snapshot = structuredClone(ctx.library().data); render();
      });
    };
    return { open, close, remove, repaint: () => active?.repaint() };
  };
  const formatName = value => ({ 'claude-json': 'MCP JSON', 'muse-json': 'Muse Code JSON', 'codex-toml': 'Codex or Grok TOML', 'opencode-json': 'OpenCode JSON', 'claude-mcp-add': 'claude mcp add', url: 'URL', command: 'command line', json: 'JSON' }[value] || value);
  return { create };
})();
