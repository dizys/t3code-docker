// Drafts own their input subtree. Only newly typed secrets live here; neither
// saved values nor server responses are copied into the form or a preview. The
// exception is the paste box: what you just pasted comes back sorted into fields.
const T3CredentialEditor = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3CredentialModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const checked = value => value ? raw(' checked') : '';
  const MAX_FILE = 48 * 1024;
  const SIGN_INS = [
    ['generate', 'Generate a key', 'Made on this server. You add one line to the remote server.', 'Recommended'],
    ['once', 'Use my password once', 'Installs a new key with your password, then forgets the password.'],
    ['existing', 'Use an existing key', 'Paste or upload a private key.'],
    ['password', 'Keep using a password', 'For servers that don’t allow keys.'],
  ];
  const domId = path => 'cred-' + path.replace(/\./g, '-');

  const create = ctx => {
    let active = null;
    const close = reason => active ? active.close(reason) : Promise.resolve(true);
    const open = async (profile, { replace = false, type = null, name = '' } = {}) => {
      if (!await close('replaced')) return;
      const view = { original: profile || null, draft: profile ? S.draftOf(profile) : S.defaults(type || 'token'), revision: profile?.revision, create: !profile, step: profile || type ? 'form' : 'start',
        secrets: {}, replacing: new Set(), signin: 'generate', generated: null, passphrase: '', needsPassphrase: false, pasteText: '', detected: null, detecting: false, fileError: null, dragging: false,
        touched: new Set(), busy: null, error: null, conflict: null, taken: false, result: null, scanned: null, trusted: false, revealed: new Set(), railOpen: false, generation: 0, closing: false };
      // A name from a link may be taken already, and Save can't explain that by itself.
      if (name) { view.draft.id = name; view.touched.add('id'); }
      if (profile && replace) { const primary = S.primarySecret(profile.type, profile.fields); if (primary) view.replacing.add(primary.key); }
      active = view;
      const isSsh = () => view.draft.type === 'ssh';
      const creatingSsh = () => view.create && isSsh();
      const setSignIn = choice => {
        view.signin = choice;
        view.draft.fields.auth = choice === 'once' || choice === 'password' ? 'password' : 'key';
        view.secrets = {}; view.needsPassphrase = false; view.passphrase = ''; view.result = null; view.scanned = null; view.trusted = false; view.touched.delete('secrets.privateKey'); view.touched.delete('secrets.password');
        if (choice === 'generate') void ensureKey();
      };
      const ensureKey = async () => {
        if (view.generated || view.generating) return;
        view.generating = true; paint();
        const response = await ctx.api('/credentials/generate-key', { body: {} });
        view.generating = false;
        if (active !== view) return;
        if (response.ok) view.generated = response.data; else view.error = response.error || 'A new key couldn’t be generated. Try again.';
        paint();
      };
      // A name from a link was never typed, so closing that form has nothing to discard.
      const baseline = () => JSON.stringify(S.payload(view.original ? S.draftOf(view.original) : { ...S.defaults(view.draft.type), id: name }));
      const dirty = () => {
        if (view.step === 'start') return Boolean(view.pasteText);
        return Boolean(Object.values(view.secrets).some(Boolean) || view.trusted || view.detected || view.draft.vars?.some(row => row.value) || JSON.stringify(S.payload(view.draft)) !== baseline());
      };
      const savedSecrets = () => view.original?.secretNames?.filter(key => !view.replacing.has(key)) || [];
      const errors = () => {
        const found = S.validate(view.draft, { editing: !view.create, names: ctx.rows().filter(row => row.id !== view.recreateId).map(row => row.id), secrets: view.secrets, savedSecrets: savedSecrets(), needSecret: !(creatingSsh() && view.signin === 'generate') });
        return { ...found, ...(view.taken ? { id: view.draft.id + ' is taken.' } : {}) };
      };
      const valid = () => view.step === 'form' && !Object.keys(errors()).length && !(creatingSsh() && view.signin === 'generate' && !view.generated);
      const canSave = () => !view.busy && valid() && (!view.original || dirty()) && !view.conflict;
      const valueAt = path => {
        if (path === 'id' || path === 'description') return view.draft[path];
        if (path === 'passphrase') return view.passphrase;
        if (path === 'paste') return view.pasteText;
        const [group, key, part] = path.split('.');
        if (group === 'fields') return view.draft.fields[key];
        if (group === 'env') return view.draft.env?.[key];
        if (group === 'secrets') return view.secrets[key];
        if (group === 'vars') return view.draft.vars[Number(key)]?.[part];
        return undefined;
      };
      const sync = () => {
        for (const input of view.layer.panel.querySelectorAll('[data-cred-field]')) {
          const value = valueAt(input.dataset.credField);
          if (input.value !== String(value ?? '')) input.value = value ?? '';
        }
        const trust = view.layer.panel.querySelector('[data-cred-editor="trust"]'); if (trust) trust.checked = view.trusted;
        view.layer.panel.querySelector('.tc-wizard-rail-wrap')?.toggleAttribute('data-open', !Kit.isPhone() || view.railOpen);
      };
      const paint = () => { if (active !== view || view.layer?.closed) return; view.layer.panel.classList.toggle('tc-cred-editor--start', view.step === 'start'); view.layer.render(); sync(); };
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

      // ---- the paste box ---------------------------------------------------------
      const suggestName = id => {
        if (!id) return '';
        const taken = ctx.rows().map(row => row.id);
        if (!taken.includes(id)) return id;
        for (let n = 2; n < 100; n++) if (!taken.includes(id + '-' + n)) return id + '-' + n;
        return '';
      };
      const applyDetected = found => {
        const draft = S.defaults(found.type);
        draft.id = suggestName(found.id); draft.fields = S.withDefaults(found.type, { ...draft.fields, ...found.fields }); draft.env = { ...found.env };
        if (S.typeOf(found.type)?.dynamic) draft.vars = [...Object.entries(found.secrets).map(([key, value]) => ({ name: key, value, secret: true })), ...Object.entries(found.fields).map(([key, value]) => ({ name: key, value, secret: false }))];
        view.draft = draft; view.secrets = S.typeOf(found.type)?.dynamic ? {} : { ...found.secrets };
        view.detected = { label: found.label, confident: found.confident }; view.pasteText = ''; view.step = 'form'; view.result = null;
        if (found.type === 'ssh') { view.signin = 'existing'; view.draft.fields.auth = 'key'; }
        paint();
        requestAnimationFrame(() => view.layer.panel.querySelector(draft.id ? '.tc-wizard-main input:not([value=""])' : '#cred-id')?.focus({ preventScroll: true }));
      };
      const detectNow = async text => {
        const generation = ++view.generation;
        view.detecting = true; paint();
        const response = await ctx.api('/credentials/detect', { body: { text } });
        if (active !== view || generation !== view.generation) return;
        view.detecting = false;
        if (response.ok && response.data.detected) applyDetected(response.data.detected);
        else if (!response.ok) { view.error = response.error || 'That couldn’t be read. Pick a type instead.'; paint(); }
        else paint();
      };
      const readFile = async (file, target) => {
        view.fileError = null;
        if (file.size > MAX_FILE) { view.fileError = file.name + ' is larger than the 48 KiB limit.'; paint(); return; }
        let text;
        try { text = await file.text(); } catch { view.fileError = file.name + ' couldn’t be read.'; paint(); return; }
        if (text.includes('\0')) { view.fileError = file.name + ' isn’t a text file.'; paint(); return; }
        if (target === 'paste') return void detectNow(text);
        view.secrets[target] = text; view.result = null; view.touched.delete('secrets.' + target); paint();
      };

      // ---- inputs ---------------------------------------------------------------
      const hint = (key, fallback) => {
        const error = view.touched.has(key) && errors()[key];
        return html`${fallback ? html`<p class="tc-hint" id="${domId(key)}-hint">${fallback}</p>` : ''}${error ? html`<p class="tc-hint tc-danger" id="${domId(key)}-error" role="alert">${error}</p>` : ''}`;
      };
      const input = (path, label, options = {}) => {
        const invalid = view.touched.has(path) && Boolean(errors()[path]);
        return html`<div class="tc-form-field" data-key="cred-field-${path}"><label class="tc-label" data-key="cred-label-${path}" for="${domId(path)}">${label}${options.optional ? html` <small class="tc-cred-optional">optional</small>` : ''}</label><input class="tc-input${options.plain ? '' : ' tc-input--mono'}" id="${domId(path)}" data-cred-field="${path}" data-key="cred-input-${path}" type="${options.type || 'text'}" value="${options.type === 'password' ? '' : valueAt(path) ?? ''}"${options.max ? raw(' maxlength="' + options.max + '"') : ''}${options.placeholder ? html` placeholder="${options.placeholder}"` : ''} autocomplete="off" autocapitalize="none" spellcheck="false" aria-invalid="${String(invalid)}"${disabled(view.busy)}>${hint(path, options.hint)}</div>`;
      };
      const fieldInput = entry => {
        const path = 'fields.' + entry.key;
        if (entry.kind === 'select') return html`<div class="tc-form-field tc-cred-auth" data-key="cred-field-${path}"><span class="tc-label" id="${domId(path)}-label">${entry.label}</span><div class="tc-seg" role="group" aria-labelledby="${domId(path)}-label">${entry.options.map(([value, title]) => html`<button type="button" data-cred-editor="select" data-field="${entry.key}" data-value="${value}" aria-pressed="${String(view.draft.fields[entry.key] === value)}"${disabled(view.busy)}>${title}</button>`)}</div></div>`;
        return input(path, entry.label, { optional: entry.optional, type: entry.kind === 'number' ? 'number' : 'text', max: entry.kind === 'number' ? null : entry.max, placeholder: entry.placeholder, hint: entry.hint });
      };
      const fileButton = target => html`<label class="tc-btn tc-btn--ghost tc-btn--xs tc-cred-file">${icon('upload')}Choose file…<input class="tc-sr" type="file" data-cred-file="${target}" tabindex="-1"${disabled(view.busy)}></label>`;
      const savedLine = (entry, path) => html`<div class="tc-cred-secret">${icon('circle-check')}<span>Saved <small>${view.original.secretChangedAt ? '· changed ' + S.day(view.original.secretChangedAt) : '· from before the upgrade'}</small></span><button class="tc-btn tc-btn--ghost tc-btn--xs" id="${domId(path)}-replace" type="button" data-cred-editor="replace" data-secret="${entry.key}"${disabled(view.busy)}>Replace…</button></div>`;
      const secretInput = (entry, options = {}) => {
        const path = 'secrets.' + entry.key, label = options.label || entry.label, showing = view.revealed.has(entry.key), invalid = view.touched.has(path) && Boolean(errors()[path]);
        const isSaved = view.original?.secretNames?.includes(entry.key);
        if (isSaved && !view.replacing.has(entry.key)) return html`<div class="tc-form-field" data-key="cred-field-${path}"><span class="tc-label">${label}</span>${savedLine(entry, path)}</div>`;
        const help = options.hint || (isSaved ? 'Leaving this empty keeps the saved ' + entry.label.toLowerCase() + '.' : 'Not shown again after you save.');
        const keep = isSaved ? html`<button class="tc-btn tc-btn--link tc-cred-keep" type="button" data-cred-editor="keep-saved" data-secret="${entry.key}"${disabled(view.busy)}>Keep saved</button>` : '';
        const reveal = html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs tc-reveal" type="button" data-cred-editor="reveal" data-secret="${entry.key}" aria-label="${showing ? 'Hide' : 'Show'} newly typed ${entry.label.toLowerCase()}" aria-pressed="${String(showing)}"${disabled(view.busy)}>${icon(showing ? 'eye-off' : 'eye')}</button>`;
        if (entry.multiline) return html`<div class="tc-form-field" data-key="cred-field-${path}"><div class="tc-cred-labelrow"><label class="tc-label" for="${domId(path)}">${label}</label><span class="tc-spacer"></span>${fileButton(entry.key)}${reveal}</div><textarea class="tc-input tc-input--mono tc-cred-textarea${showing ? '' : ' tc-cred-masked'}" id="${domId(path)}" data-cred-field="${path}" data-key="cred-input-${path}" data-cred-drop="${entry.key}" rows="5" spellcheck="false" autocomplete="off" autocapitalize="none" placeholder="${entry.placeholder || ''}" aria-invalid="${String(invalid)}"${disabled(view.busy)}></textarea>${view.fileError ? html`<p class="tc-hint tc-danger" role="alert">${view.fileError}</p>` : ''}${hint(path, help)}${keep}</div>`;
        return html`<div class="tc-form-field" data-key="cred-field-${path}"><label class="tc-label" for="${domId(path)}">${label}${entry.optional ? html` <small class="tc-cred-optional">optional</small>` : ''}</label><div class="tc-input-wrap tc-cred-reveal" data-key="cred-wrap-${path}"><input class="tc-input" id="${domId(path)}" data-key="cred-input-${path}" data-cred-field="${path}" type="${showing ? 'text' : 'password'}" maxlength="8192" autocomplete="new-password" autocapitalize="none" spellcheck="false" aria-invalid="${String(invalid)}"${disabled(view.busy)}>${reveal}</div>${hint(path, help)}${keep}</div>`;
      };
      const envInput = entry => input('env.' + entry.key, 'Environment variable', { max: 128, placeholder: S.resolveEnvName(entry.env, view.draft.id), hint: 'Commands get the ' + entry.label.toLowerCase() + ' under this name.' });
      const nameField = () => view.create
        ? input('id', 'Name', { max: 64, hint: Kit.isPhone() ? 'Skills use it, so it can’t change later.' : 'Lowercase letters, numbers and hyphens. Skills use it, so it can’t change later.' })
        : html`<div class="tc-form-field" data-key="cred-field-id"><span class="tc-label">Name</span><div class="tc-cred-locked">${icon('lock')}<span>${view.draft.id}</span><span>Can’t change</span></div><p class="tc-hint">${ctx.usageWarnings()?.length ? 'Some skills couldn’t be read.' : 'Mentioned in ' + S.usageCount(view.original) + '.'}</p></div>`;
      const descriptionField = () => input('description', 'Description', { optional: true, plain: true, max: 200, hint: 'Agents see this in t3-vault list, so say when to use it.' });

      // ---- SSH ------------------------------------------------------------------
      const signInOptions = () => html`<div class="tc-form-field" data-key="cred-signin"><span class="tc-label" id="cred-signin-label">How should agents sign in?</span><div class="tc-cred-options" role="radiogroup" aria-labelledby="cred-signin-label">${SIGN_INS.map(([value, title, desc, tag]) => html`<label class="tc-cred-option" data-on="${String(view.signin === value)}" data-key="cred-signin-${value}"><input class="tc-sr" type="radio" name="cred-signin" data-cred-editor="signin" value="${value}"${checked(view.signin === value)}${disabled(view.busy)}><span class="tc-cred-radio" aria-hidden="true"></span><span><b>${title}</b>${tag ? html`<em>${tag}</em>` : ''}<small>${desc}</small></span></label>`)}</div></div>`;
      const sshSecret = () => {
        const spec = S.typeOf('ssh'), keyEntry = spec.secrets.find(entry => entry.key === 'privateKey'), passwordEntry = spec.secrets.find(entry => entry.key === 'password');
        if (view.create) {
          if (view.signin === 'generate') return '';
          if (view.signin === 'once') return secretInput(passwordEntry, { label: 'Server password', hint: 'Used once to add the key. It isn’t saved.' });
          if (view.signin === 'password') return secretInput(passwordEntry);
          return html`${secretInput(keyEntry, { hint: 'Line breaks don’t matter. Its passphrase isn’t kept.' })}${view.needsPassphrase ? input('passphrase', 'Passphrase', { type: 'password', plain: true, hint: 'Opens the key once, then the key is saved without it.' }) : ''}`;
        }
        return view.draft.fields.auth === 'key' ? html`${secretInput(keyEntry)}${view.needsPassphrase ? input('passphrase', 'Passphrase', { type: 'password', plain: true }) : ''}` : secretInput(passwordEntry);
      };
      const sshFields = () => html`<div class="tc-cred-pair" data-key="cred-ssh-target">${fieldInput(S.typeOf('ssh').fields[0])}${fieldInput(S.typeOf('ssh').fields[1])}</div>${fieldInput(S.typeOf('ssh').fields[2])}${view.create ? signInOptions() : ''}${sshSecret()}${Kit.isPhone() && creatingSsh() && view.signin === 'generate' ? keyPanel() : ''}`;

      // ---- everything else ---------------------------------------------------------
      const varsEditor = () => html`<div class="tc-form-field" data-key="cred-vars"><span class="tc-label">Variables</span><div class="tc-cred-vars">${view.draft.vars.map((row, index) => html`<div class="tc-cred-var" data-key="cred-var-${index}"><input class="tc-input tc-input--mono" data-cred-field="vars.${index}.name" data-key="cred-var-name-${index}" aria-label="Variable ${index + 1} name" placeholder="NAME" value="${row.name}" autocomplete="off" spellcheck="false"${disabled(view.busy)}><input class="tc-input tc-input--mono" data-cred-field="vars.${index}.value" data-key="cred-var-value-${index}" aria-label="Variable ${index + 1} value" type="${row.secret ? 'password' : 'text'}" placeholder="${row.saved ? 'Saved. Leave empty to keep it.' : 'Value'}" value="${row.secret ? '' : row.value}" autocomplete="new-password" spellcheck="false"${disabled(view.busy)}><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-cred-editor="var-secret" data-index="${index}" aria-pressed="${String(row.secret)}" aria-label="${row.secret ? 'Secret' : 'Not secret'}" title="${row.secret ? 'Secret: hidden and write-only' : 'Not secret: shown on this page'}"${disabled(view.busy)}>${icon(row.secret ? 'lock' : 'eye')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-cred-editor="var-remove" data-index="${index}" aria-label="Remove variable ${index + 1}"${disabled(view.busy)}>${icon('x')}</button></div>`)}</div><button class="tc-btn tc-btn--ghost tc-btn--xs tc-cred-var-add" type="button" data-cred-editor="var-add"${disabled(view.busy)}>${icon('plus')}Add variable</button>${view.touched.has('vars') && errors().vars ? html`<p class="tc-hint tc-danger" role="alert">${errors().vars}</p>` : html`<p class="tc-hint">Commands get each one under its own name.</p>`}</div>`;
      const typedFields = () => {
        const spec = S.typeOf(view.draft.type), visible = spec.fields.filter(entry => entry.kind !== 'derived' && S.applies(entry, view.draft.fields));
        const plain = visible.filter(entry => !entry.needs && entry.key !== 'baseUrl'), api = visible.filter(entry => entry.key === 'baseUrl' || entry.needs);
        const secrets = html`${spec.secrets.filter(entry => S.applies(entry, view.draft.fields)).map(entry => secretInput(entry))}${[...spec.fields, ...spec.secrets].filter(entry => entry.editableEnv).map(envInput)}`;
        // A token is the point of a token, while logins and databases read best in the order people say them.
        return html`${spec.secretFirst ? secrets : ''}${plain.map(fieldInput)}${spec.secretFirst ? '' : secrets}${api.filter(entry => entry.key !== 'testPath').map(fieldInput)}`;
      };
      const form = () => {
        const spec = S.typeOf(view.draft.type);
        return html`<div class="tc-form">${view.detected ? html`<div class="tc-cred-detect" data-sure="${String(view.detected.confident)}" data-key="cred-detected" role="status">${icon(view.detected.confident ? 'sparkles' : 'info')}<span>${view.detected.confident ? 'Looks like ' + view.detected.label : 'Saving this as ' + S.typeLabel(view.draft.type).toLowerCase()}</span><button class="tc-btn tc-btn--link" type="button" data-cred-editor="change-type"${disabled(view.busy)}>Change type</button></div>` : ''}${nameField()}${isSsh() ? sshFields() : spec.dynamic ? varsEditor() : typedFields()}${descriptionField()}</div>`;
      };

      // ---- the first step ------------------------------------------------------------
      const start = () => html`<div class="tc-cred-start"><div class="tc-cred-drop" data-dragging="${String(view.dragging)}" data-cred-drop="paste" data-key="cred-drop"><textarea class="tc-cred-paste tc-cred-masked" id="cred-paste" data-cred-field="paste" data-key="cred-paste" rows="3" spellcheck="false" autocomplete="off" autocapitalize="none" aria-label="Paste a key, token, connection URL or config file" placeholder="Paste a key, token, connection URL or config file"${disabled(view.detecting)}></textarea><div class="tc-cred-drop-foot">${view.detecting ? html`<span class="tc-hint" role="status"><span class="tc-spinner" aria-hidden="true"></span>Reading it…</span>` : html`<span class="tc-hint">Or drop a file here. It stays masked as you paste.</span>`}<span class="tc-spacer"></span>${fileButton('paste')}</div></div>${view.fileError ? html`<p class="tc-hint tc-danger" role="alert">${view.fileError}</p>` : ''}<h3 class="tc-insp-label">Or pick a type</h3><div class="tc-cred-types">${S.typeList().map(type => html`<button class="tc-cred-typecard" type="button" data-cred-editor="pick-type" data-value="${type.id}" data-key="cred-type-${type.id}">${icon(type.icon)}<span>${type.label}</span></button>`)}</div></div>`;

      // ---- the side panel --------------------------------------------------------------
      const commandList = () => html`<ul class="tc-group tc-cred-cmds">${S.commands(view.draft, { aliases: ctx.sshAliases() }).map((command, index) => html`<li><code title="${command}">${command}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-cred-editor="copy" data-index="${index}" aria-label="Copy command">${icon('copy')}</button></li>`)}</ul>`;
      const keyPanel = () => html`<section class="tc-cred-rail-block" data-key="cred-key-panel"><h3 class="tc-insp-label">Add this line on the server</h3>${view.generated ? html`<div class="tc-cred-install"><code>${S.installLine(view.generated.publicKey)}</code><button class="tc-btn tc-btn--xs" type="button" data-cred-editor="copy-install">${icon('copy')}Copy</button></div><p class="tc-hint">Run it on the server as ${view.draft.fields.username || 'the user agents sign in as'}, or save now and do it later.</p>` : html`<p class="tc-hint" role="status"><span class="tc-spinner" aria-hidden="true"></span>Generating a key…</p>`}</section>`;
      const identity = () => {
        const key = view.scanned?.presented; if (!key) return '';
        const changed = view.scanned.state === 'changed';
        const firstUse = !changed && view.draft.fields.auth === 'key' && view.signin !== 'once';
        const check = Kit.isPhone() ? html`<details class="tc-cred-compare" data-key="cred-compare"${view.compareOpen ? raw(' open') : ''}><summary>Compare with the server’s key</summary><code>${S.keyCommand(key.type)}</code></details>` : html`<span>Compare it with the server’s own:</span><code>${S.keyCommand(key.type)}</code>`;
        return html`<div class="tc-cred-hostkey tc-cred-hostkey--first"><strong>${changed ? 'Different host key from ' : firstUse ? 'Server’s identity: ' : 'First connection to '}${view.draft.fields.host}</strong><span class="tc-cred-fp">${S.keyType(key.type)} ${key.fingerprint}</span>${firstUse ? html`<span>Pinned on first use. A different key later blocks it.</span>` : html`${check}<label class="tc-cred-check"><input class="tc-checkbox" type="checkbox" data-cred-editor="trust"${checked(view.trusted)}${disabled(view.busy)}>Trust this host key</label>`}</div>`;
      };
      const result = () => {
        const shown = { ...view.draft, hostKey: view.scanned && view.trusted ? view.scanned.presented : view.original?.hostKey || (view.result ? {} : null), test: view.result };
        const state = view.result ? S.state(shown) : null;
        return html`<div class="tc-cred-test" data-key="cred-draft-result" aria-busy="${String(view.busy === 'test')}">${view.busy === 'test' ? html`<p class="tc-hint" role="status"><span class="tc-spinner" aria-hidden="true"></span>Testing…</p>` : ''}${identity()}${state && !['host-key-untrusted', 'host-key-changed'].includes(state.code) ? html`<div class="tc-cred-test-line" data-tone="${state.tone}" role="status">${icon(state.icon || 'info')}<span>${view.result.ok && isSsh() ? 'Signed in as ' + view.draft.fields.username : state.label}</span><small>${view.result.ms >= 1000 ? (view.result.ms / 1000).toFixed(1) + ' s' : view.result.ms + ' ms'}</small></div>${!view.result.ok ? html`<p class="tc-hint" role="status">${state.desc}</p>` : ''}` : !view.scanned && view.busy !== 'test' ? html`<p class="tc-hint">Nothing is saved by a test.</p>` : ''}${view.result?.code === 'host-key-changed' && !view.trusted ? html`<p class="tc-hint tc-warning" role="alert">The host key differs. Compare the fingerprint before trusting it.</p>` : ''}</div>`;
      };
      const testButton = (phone = false) => html`<button class="tc-btn ${phone ? '' : 'tc-btn--xs'}" type="button" data-cred-editor="test"${disabled(view.busy || !valid())}>${view.busy === 'test' ? html`<span class="tc-spinner" aria-hidden="true"></span>Testing…` : html`${phone ? '' : icon('refresh-cw')}${view.result ? 'Test again' : 'Test'}`}</button>`;
      const testSection = () => !S.canTest(view.draft) ? (S.typeOf(view.draft.type)?.fields.some(entry => entry.key === 'baseUrl') ? html`<section class="tc-cred-rail-block" data-key="cred-test-section"><h3 class="tc-insp-label">Test before saving</h3><p class="tc-hint">Add an API address to test this here.</p></section>` : '') : html`<section class="tc-cred-rail-block" data-key="cred-test-section"><h3 class="${Kit.isPhone() ? 'tc-sr' : 'tc-insp-label'}">Test before saving<span class="tc-spacer"></span>${Kit.isPhone() ? '' : testButton()}</h3>${view.draft.fields.baseUrl ? fieldInput(S.typeOf(view.draft.type).fields.find(entry => entry.key === 'testPath')) : ''}${result()}</section>`;
      const givesSection = () => {
        const gives = S.givesPreview(view.draft); if (isSsh() || !gives.length) return '';
        return html`<section class="tc-cred-rail-block"><h3 class="tc-insp-label">Commands get</h3><p class="tc-cred-gives">${gives.map((item, index) => html`${index ? ', ' : ''}<code>${item.name}</code>`)}</p>${gives.some(item => item.file) ? html`<p class="tc-hint">Holds the path of a temporary file that only lasts for that command.</p>` : ''}</section>`;
      };
      const rail = () => html`<details class="tc-wizard-rail-wrap" data-key="cred-rail"${!Kit.isPhone() || view.railOpen ? raw(' open data-open') : ''}><summary class="tc-wizard-rail-toggle">Agents run <code>${S.commands(view.draft, { aliases: ctx.sshAliases() })[0]}</code>${icon('chevron-down')}</summary><aside class="tc-wizard-rail">${!Kit.isPhone() && creatingSsh() && view.signin === 'generate' ? keyPanel() : ''}<section class="tc-cred-rail-block"><h3 class="tc-insp-label">Agents run</h3>${commandList()}<p class="tc-hint">${S.usesPlainSsh(view.draft, ctx.sshAliases()) ? 'Plain ssh, scp and git work with this name.' : 'The value never appears in the command, and is hidden if the output repeats it.'}</p></section>${givesSection()}${view.draft.fields.baseUrl ? html`<section class="tc-cred-rail-block"><h3 class="tc-insp-label">Every request sends</h3>${T3CredentialInspector.requestPreview(view.draft, true)}</section>` : ''}${!Kit.isPhone() ? testSection() : ''}${view.original ? html`<section class="tc-cred-rail-block"><h3 class="tc-insp-label">When you save</h3>${view.original.usedIn?.length ? html`<div class="tc-group">${view.original.usedIn.map(item => html`<div class="tc-cred-skill"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('book-open')}</span><div><strong>${item.name}</strong><small>Next run uses the new details</small></div></div>`)}</div>` : html`<p class="tc-hint">${ctx.usageWarnings()?.length ? 'Some skills couldn’t be read.' : 'Not in a skill yet.'}</p>`}${view.original.hostKey ? html`<div class="tc-cred-hostkey"><strong>Trusted host key</strong><span class="tc-cred-fp">${S.keyType(view.original.hostKey.type)} ${view.original.hostKey.fingerprint}</span><span>Changing the host or port forgets it.</span></div>` : ''}</section>` : ''}</aside></details>`;
      const conflict = () => !view.conflict ? '' : html`<div class="tc-notice tc-notice--warn tc-cred-conflict" role="alert" tabindex="-1" id="cred-conflict">${icon('triangle-alert')}<div class="tc-notice-body"><strong class="tc-notice-title">${view.conflict.code === 'gone' ? 'Deleted in another window' : 'Changed in another window at ' + new Date(view.conflict.current.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</strong>${view.conflict.current ? html`${S.changes(view.original, view.conflict.current).map(field => html`<p class="tc-cred-diffline">${S.fieldLabel(field, view.draft.type)}: <del>${String(view.original.fields?.[field] ?? '') || 'None'}</del> → <ins>${String(view.conflict.current.fields?.[field] ?? '') || 'None'}</ins></p>`)}${view.original.secretChangedAt !== view.conflict.current.secretChangedAt ? html`<p>Its ${S.secretKind(view.original)} was replaced.</p>` : ''}<span class="tc-notice-desc">Saving here would put your details back.</span><div class="tc-cred-conflict-actions"><button class="tc-btn tc-btn--sm" type="button" data-cred-editor="theirs">Use theirs</button><button class="tc-btn tc-btn--sm" type="button" data-cred-editor="mine">Keep mine</button></div>` : html`<span class="tc-notice-desc">The saved credential was deleted. Your draft is still here.</span><div class="tc-cred-conflict-actions"><button class="tc-btn tc-btn--sm" type="button" data-cred-editor="new">Save as new</button><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-cred-editor="close">Close</button></div>`}</div></div>`;

      // ---- talking to the server ----------------------------------------------------------
      const trustField = () => view.trusted && view.scanned ? { trust: { fingerprint: view.scanned.presented.fingerprint } } : {};
      const testBody = () => {
        const draft = S.payload(view.draft, view.secrets);
        return { draft, ...(!view.create ? { id: view.draft.id } : {}), ...trustField(), ...(creatingSsh() && view.signin === 'generate' ? { generatedKeyId: view.generated?.keyId } : {}), ...(view.passphrase ? { passphrase: view.passphrase } : {}) };
      };
      const saveBody = () => {
        const credential = S.payload(view.draft, view.secrets), body = { credential, ...(!view.create ? { revision: view.revision } : {}), ...trustField(), ...(view.passphrase ? { passphrase: view.passphrase } : {}) };
        if (creatingSsh() && view.signin === 'generate') body.generatedKeyId = view.generated.keyId;
        if (creatingSsh() && view.signin === 'once') {
          credential.fields.auth = 'key'; body.generate = true; body.install = { password: view.secrets.password }; delete credential.secrets.password;
        }
        return body;
      };
      const keyProblem = response => {
        if (response.data?.field !== 'passphrase') return false;
        view.needsPassphrase = true; view.error = response.error; paint();
        view.layer.panel.querySelector('#cred-passphrase')?.focus();
        return true;
      };
      const submit = async () => {
        if (view.busy || active !== view || view.conflict || view.step !== 'form') return;
        if (!valid()) { Object.keys(errors()).forEach(key => view.touched.add(key)); paint(); view.layer.panel.querySelector('[aria-invalid="true"]')?.focus(); return; }
        if (view.original && !dirty()) return;
        // A password must not leave before someone has looked at who's receiving it.
        if (creatingSsh() && view.signin === 'once' && !view.trusted) {
          await test();
          if (active === view && view.scanned && !view.trusted) { view.error = 'Check the server’s identity first, then save.'; paint(); view.layer.panel.querySelector('[data-cred-editor="trust"]')?.focus(); }
          return;
        }
        view.busy = 'save'; view.error = null; paint();
        const body = saveBody();
        const response = await ctx.api(view.create ? '/credentials/create' : '/credentials/save', { body });
        if (body.install) body.install.password = '';
        if (active !== view) return;
        if (!response.ok) {
          view.busy = null;
          if (['changed', 'gone'].includes(response.data?.code)) view.conflict = response.data;
          else if (response.data?.code === 'taken') { view.taken = true; view.touched.add('id'); }
          else if (keyProblem(response)) return;
          else view.error = response.error || 'Couldn’t save this credential. Your draft is still here.';
          paint(); (view.layer.panel.querySelector('#cred-conflict, #cred-editor-error') || view.layer.panel.querySelector('[aria-invalid="true"]'))?.focus({ preventScroll: true }); return;
        }
        const id = view.draft.id, failedTrust = response.data.trust?.ok === false && view.draft.fields.auth === 'password', waitingForKey = creatingSsh() && view.signin === 'generate' && !view.result?.ok;
        const refreshed = await ctx.saved(response.data.credential);
        if (active !== view) return;
        view.busy = null; view.layer.close('saved');
        Kit.toast(id + ' saved', !refreshed ? { tone: 'warn', detail: 'Saved, but the list could not be refreshed. Try again on the Vault page.' } : failedTrust ? { tone: 'warn', detail: 'Its host key could not be trusted. Review it before agents connect.', action: { label: 'Review', run: () => ctx.review(id) } } : waitingForKey ? { detail: 'Add its key to the server, then test it.' } : undefined);
        if (waitingForKey && refreshed) ctx.inspect(id);
      };
      const test = async () => {
        if (view.busy || !valid()) return;
        view.busy = 'test'; view.error = null; const generation = ++view.generation; paint();
        const response = await ctx.api('/credentials/test', { body: testBody() });
        if (active !== view || generation !== view.generation) return;
        view.busy = null;
        if (!response.ok && keyProblem(response)) return;
        if (!response.ok || !response.data.result) view.error = response.error || 'The test could not finish. Your draft is still here.';
        else {
          view.result = response.data.result;
          if (view.result.hostKey) { view.scanned = view.result.hostKey; if (view.result.code !== 'ok') view.trusted = false; }
          else if (view.result.code === 'host-key-changed' && view.result.detail?.presented) { view.scanned = { state: 'changed', presented: view.result.detail.presented, trusted: view.result.detail.trusted }; view.trusted = false; }
          Kit.announce(view.result.ok ? 'Connection succeeded. This draft is not saved yet.' : S.state({ ...view.draft, hostKey: view.original?.hostKey, test: view.result }).label);
        }
        paint();
        // The side panel can be taller than the dialog too, so this isn't only for phones.
        (view.layer.panel.querySelector(view.error ? '#cred-editor-error' : '.tc-cred-test-line') || view.layer.panel.querySelector('.tc-cred-hostkey--first'))?.scrollIntoView({ block: 'nearest' });
      };

      const head = () => {
        const sub = view.step === 'start' ? 'Save it once. Agents use it by name.' : view.create ? S.typeLabel(view.draft.type) : S.typeLabel(view.draft.type) + ' · ' + (view.original.usedIn?.length ? 'used in ' + M.listOf(view.original.usedIn.map(item => item.name)) : ctx.usageWarnings()?.length ? 'usage partly checked' : 'not in a skill yet');
        const back = view.create && view.step === 'form' && !view.detected ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cred-editor="change-type" aria-label="Choose another type"${disabled(view.busy)}>${icon('arrow-left')}</button>` : '';
        return html`<div class="tc-wizard-head">${back}<span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(view.step === 'start' ? 'key-round' : S.iconFor(view.draft.type))}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="cred-editor-title">${view.create ? 'Add credential' : 'Edit ' + view.draft.id}</h2><span class="tc-small tc-muted">${sub}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cred-editor="close" aria-label="Close credential editor"${disabled(view.busy)}>${icon('x')}</button></div>`;
      };
      const foot = () => view.step === 'start' ? html`<div class="tc-wizard-foot"><span class="tc-hint tc-wizard-keyboard">${icon('lock', 'tc-icon--sm')}Saved on this server, in plain text.</span><span class="tc-spacer"></span><button class="tc-btn" type="button" data-cred-editor="close">Cancel</button></div>` : html`<div class="tc-wizard-foot"><span class="tc-hint tc-wizard-keyboard">${icon('lock', 'tc-icon--sm')}Saved on this server, in plain text.</span>${Kit.isPhone() ? html`${S.canTest(view.draft) ? testButton(true) : ''}<span class="tc-spacer"></span>` : html`<span class="tc-spacer"></span><button class="tc-btn" type="button" data-cred-editor="close"${disabled(view.busy)}>Cancel</button>`}<button class="tc-btn tc-btn--primary" type="submit" data-cred-editor="save"${disabled(!canSave())}>${view.busy === 'save' ? html`<span class="tc-spinner" aria-hidden="true"></span>Saving…` : view.create ? 'Save credential' : 'Save changes'}</button></div>`;

      view.layer = Kit.open({ kind: 'center', backdrop: 'ignore', panel: { tag: 'form', class: 'tc-wizard tc-cred-editor', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cred-editor-title', autocomplete: 'off', novalidate: true }, focus: view.step === 'start' ? '#cred-paste' : replace ? '.tc-wizard-main [data-cred-field^="secrets."]' : profile ? '.tc-wizard-main [data-cred-field^="fields."]' : view.draft.id ? '.tc-wizard-main [data-cred-field^="secrets."], .tc-wizard-main [data-cred-field^="fields."]' : '#cred-id', onEscape: () => { void view.close('escape'); }, onClose: () => {
        view.generation++; view.secrets = {}; view.pasteText = ''; view.passphrase = ''; view.draft.vars = []; view.revealed.clear();
        for (const input of view.layer.panel.querySelectorAll('[data-cred-field^="secrets."], [data-cred-field="paste"]')) input.value = '';
        window.removeEventListener('beforeunload', beforeUnload); if (active === view) active = null;
      }, render: () => html`${head()}${view.step === 'start' ? html`<div class="tc-wizard-grid tc-cred-startgrid"><div class="tc-wizard-main">${start()}</div></div>` : html`<div class="tc-wizard-grid"><div class="tc-wizard-main">${conflict()}${form()}${Kit.isPhone() ? testSection() : ''}</div>${rail()}</div>`}${view.error ? html`<div class="tc-cred-editor-error tc-hint tc-danger" role="alert" tabindex="-1" id="cred-editor-error">${view.error}</div>` : ''}${foot()}` });
      sync(); view.layer.panel.classList.toggle('tc-cred-editor--start', view.step === 'start');
      if (creatingSsh()) { setSignIn('generate'); paint(); }

      view.layer.panel.addEventListener('submit', event => { event.preventDefault(); void submit(); });
      let detectTimer = null;
      view.layer.panel.addEventListener('input', event => {
        const key = event.target.dataset.credField; if (!key || view.busy) return;
        if (key === 'paste') {
          view.pasteText = event.target.value; clearTimeout(detectTimer);
          // A paste arrives whole, so read it right away. Typing waits for a pause.
          if (view.pasteText.trim()) detectTimer = setTimeout(() => void detectNow(view.pasteText), event.inputType === 'insertFromPaste' ? 0 : 800);
          return;
        }
        if (key === 'id') { view.draft.id = event.target.value.toLowerCase().replace(/\s/g, '-'); view.taken = false; event.target.value = view.draft.id; }
        else if (key === 'description') view.draft.description = event.target.value;
        else if (key === 'passphrase') view.passphrase = event.target.value;
        else {
          const [group, field, part] = key.split('.');
          if (group === 'fields') view.draft.fields[field] = event.target.value;
          else if (group === 'env') view.draft.env[field] = event.target.value;
          else if (group === 'secrets') view.secrets[field] = event.target.value;
          else if (group === 'vars') view.draft.vars[Number(field)][part] = event.target.value;
          if (group === 'fields' && ['host', 'port'].includes(field)) { view.scanned = null; view.trusted = false; }
        }
        view.generation++; view.result = null; view.error = null;
        paint();
      });
      // A field's error moves everything below it. Showing it mid-press would make the
      // click miss what it was aimed at, so it waits for the press to finish.
      let pressing = false, waiting = false;
      const released = () => { pressing = false; if (waiting) { waiting = false; setTimeout(paint); } };
      view.layer.panel.addEventListener('pointerdown', () => { pressing = true; window.addEventListener('pointerup', released, { once: true, capture: true }); window.addEventListener('pointercancel', released, { once: true, capture: true }); }, true);
      view.layer.panel.addEventListener('focusout', event => {
        const key = event.target.dataset.credField; if (!key || key === 'paste' || view.busy) return;
        view.touched.add(key.startsWith('vars.') ? 'vars' : key);
        if (pressing) waiting = true; else setTimeout(paint);
      });
      // That paint can land before a <details> reports its toggle, so its state is noted on the click.
      view.layer.panel.addEventListener('click', event => {
        const fold = event.target.closest('summary')?.parentElement; if (!fold) return;
        if (fold.matches('.tc-cred-compare')) view.compareOpen = !fold.open;
        else if (fold.matches('.tc-wizard-rail-wrap') && Kit.isPhone()) view.railOpen = !fold.open;
      });
      view.layer.panel.addEventListener('toggle', event => {
        if (event.target.matches('.tc-cred-compare')) { view.compareOpen = event.target.open; return; }
        if (!event.target.matches('.tc-wizard-rail-wrap') || !Kit.isPhone()) return;
        view.railOpen = event.target.open; event.target.toggleAttribute('data-open', view.railOpen);
      }, true);
      for (const name of ['dragover', 'dragleave', 'drop']) view.layer.panel.addEventListener(name, event => {
        const zone = event.target.closest('[data-cred-drop]'); if (!zone) return;
        event.preventDefault();
        if (name === 'dragover') { if (!view.dragging) { view.dragging = true; paint(); } return; }
        view.dragging = false; paint();
        if (name === 'drop' && event.dataTransfer.files[0]) void readFile(event.dataTransfer.files[0], zone.dataset.credDrop);
      });
      view.layer.panel.addEventListener('click', async event => {
        const button = event.target.closest('[data-cred-editor]'); if (!button || button.disabled || button.tagName === 'INPUT') return;
        const action = button.dataset.credEditor, secret = button.dataset.secret;
        if (action === 'close') return void view.close('close');
        if (view.busy) return;
        if (action === 'copy') return void Kit.copy(S.commands(view.draft, { aliases: ctx.sshAliases() })[Number(button.dataset.index)], button, 'Command copied');
        if (action === 'copy-install') return void Kit.copy(S.installLine(view.generated.publicKey), button, 'Command copied');
        if (action === 'test') return void test();
        if (action === 'pick-type') {
          // A name and description survive a change of type. Secrets and fields don't.
          view.generation++; view.draft = { ...S.defaults(button.dataset.value), id: view.draft.id, description: view.draft.description }; view.secrets = {}; view.detected = null; view.step = 'form'; view.result = null; view.touched.clear();
          paint();
          if (isSsh()) setSignIn('generate');
          view.layer.panel.querySelector('#cred-id')?.focus();
          return;
        }
        if (action === 'change-type') { view.generation++; view.step = 'start'; view.detected = null; view.secrets = {}; view.result = null; view.scanned = null; view.trusted = false; view.error = null; view.touched.clear(); paint(); view.layer.panel.querySelector('#cred-paste')?.focus(); return; }
        if (action === 'replace') { view.replacing.add(secret); paint(); view.layer.panel.querySelector('#' + domId('secrets.' + secret))?.focus(); return; }
        if (action === 'keep-saved') { delete view.secrets[secret]; view.replacing.delete(secret); view.revealed.delete(secret); view.touched.delete('secrets.' + secret); view.result = null; paint(); view.layer.panel.querySelector('#' + domId('secrets.' + secret) + '-replace')?.focus(); return; }
        if (action === 'reveal') { if (view.revealed.has(secret)) view.revealed.delete(secret); else view.revealed.add(secret); paint(); return; }
        if (action === 'select') {
          view.draft.fields[button.dataset.field] = button.dataset.value; view.result = null;
          if (button.dataset.field === 'authType') { view.draft.fields.authName = button.dataset.value === 'query' ? 'api_key' : button.dataset.value === 'header' ? 'X-API-Key' : ''; view.draft.fields.authPrefix = ''; view.touched.delete('fields.authName'); }
          paint(); return;
        }
        if (action === 'var-add') { view.draft.vars.push({ name: '', value: '', secret: true }); paint(); view.layer.panel.querySelector('[data-cred-field="vars.' + (view.draft.vars.length - 1) + '.name"]')?.focus(); return; }
        if (action === 'var-remove') { view.draft.vars.splice(Number(button.dataset.index), 1); view.result = null; paint(); return; }
        if (action === 'var-secret') { const row = view.draft.vars[Number(button.dataset.index)]; row.secret = !row.secret; row.saved = false; paint(); return; }
        if (action === 'theirs') {
          const current = view.conflict.current, keep = view.original.secretChangedAt === current.secretChangedAt;
          if (!keep) { view.secrets = {}; view.replacing.clear(); }
          view.revealed.clear(); view.original = current; view.draft = S.draftOf(current); view.revision = current.revision; view.conflict = null; view.scanned = null; view.trusted = false; view.result = null; view.touched.clear(); paint(); return;
        }
        if (action === 'mine') { view.revision = view.conflict.current.revision; view.conflict = null; return void submit(); }
        if (action === 'new') { view.recreateId = view.draft.id; view.create = true; view.original = null; view.conflict = null; view.revision = undefined; paint(); if (valid()) void submit(); else view.layer.panel.querySelector('[data-cred-field^="secrets."]')?.focus(); }
      });
      view.layer.panel.addEventListener('change', event => {
        if (event.target.dataset.credFile) { const file = event.target.files[0]; const target = event.target.dataset.credFile; event.target.value = ''; if (file) void readFile(file, target); return; }
        if (event.target.dataset.credEditor === 'signin' && !view.busy) { setSignIn(event.target.value); paint(); return; }
        if (event.target.dataset.credEditor !== 'trust' || view.busy) return;
        view.trusted = event.target.checked; view.result = null; paint(); if (view.trusted) void test();
      });
      view.layer.panel.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } });
    };
    return { open, close, repaint: () => active?.repaint(), beforeNavigate: () => close('route'), isOpen: () => Boolean(active) };
  };
  return { create };
})();
