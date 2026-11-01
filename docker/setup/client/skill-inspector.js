// On-demand text/file inspector. Drafts and async reads belong to one layer.
const T3SkillInspector = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const S = T3SkillModel;
  const disabled = value => value ? raw(' disabled') : '';
  const bytes = value => T3Model.formatBytes(value || 0);
  const code = (text, label = 'SKILL.md contents') => {
    const doc = T3CodeText.documentOf(String(text), 'markdown');
    return html`<pre class="tc-code" tabindex="0" aria-label="${label}">${doc.lines.map((line, index) => html`<span><code>${T3CodeText.tokens(line || '\n', doc.modes[index]).map(token => token.tone ? html`<span class="${token.tone}">${token.text}</span>` : token.text)}${line.slice(4000)}</code></span>`)}</pre>`;
  };
  const create = ({ api, getLibrary, getStatus, availability, refresh, readMarkdown, downloadMarkdown }) => {
    let active = null;
    const repaint = () => { if (active && !active.layer.closed) active.layer.render(); };
    const open = async (key, editing = false, creating = false) => {
      if (active && !await active.close('replaced')) return;
      const library = getLibrary(), skill = creating ? null : library.rows.find(row => row.key === key);
      if (!creating && !skill) return;
      const targets = S.providers.flatMap(provider => (library.inventories[provider.id]?.creationTargets || []).map(target => ({ ...target, provider: provider.id, value: provider.id + ':' + target.id })));
      if (creating && !targets.length) return;
      const initial = '---\nname: my-skill\ndescription: Describe when to use this skill.\n---\n\nWrite the skill instructions here.\n';
      const view = { key, skill, data: null, creating, editing: editing || creating, draft: creating ? initial : '', original: creating ? initial : '', slug: '',
        target: targets.find(target => library.installed.includes(target.provider))?.value || targets[0]?.value,
        generated: true, loading: !creating, saving: false, linking: false, linkError: null, error: null, layer: null };
      active = view;
      const editor = T3CodeEditor.create({ id: 'skill-content', label: 'SKILL.md contents', describedBy: 'skill-editor-meta' });
      const row = () => getLibrary().rows.find(row => row.key === key) || skill;
      const detail = () => view.data || row();
      const dirty = () => view.draft !== view.original || (creating && Boolean(view.slug));
      const beforeUnload = event => { if (view.saving || view.editing && dirty()) { event.preventDefault(); event.returnValue = ''; } };
      const filename = () => ((creating ? view.slug : skill.name) || 'skill').replace(/[^a-z0-9-]/gi, '-').slice(0, 64) + '.md';
      const download = () => downloadMarkdown(filename(), view.draft);
      view.close = async reason => {
        if (view.saving) return false;
        if (view.editing && dirty()) {
          const yes = await Kit.confirm({ title: 'Discard this skill draft?', body: 'Your unsaved changes will be lost. You can keep editing and download a copy first.', confirm: 'Discard draft', tone: 'danger' });
          if (!yes || active !== view) return false;
        }
        view.layer.close(reason); return true;
      };
      const renderLocations = () => {
        const file = detail(), status = getStatus(), target = file.resolvedPath || file.path;
        const stateVolume = status?.paths?.stateKind === 'durable' && S.contains(status.paths.state, target);
        const homeVolume = status?.paths?.volumeKind === 'durable' && S.contains(status.paths.volume, target);
        const folder = S.directory(file.path);
        return html`<section class="tc-insp-section"><div class="tc-insp-label">Where it lives</div><dl class="tc-group tc-pathlist">
          <dt>Folder</dt><dd><code>${S.displayPath(folder, library.home)}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-inspect-copy-path aria-label="Copy skill folder path">${icon('copy')}</button></dd>
          ${file.resolvedPath && file.resolvedPath !== file.path ? html`<dt>Linked to</dt><dd><code>${S.displayPath(S.directory(file.resolvedPath), library.home)}</code></dd>` : ''}
          ${stateVolume || homeVolume ? html`<dt>Kept on</dt><dd>${icon('hard-drive', 'tc-icon--sm')}<span>${stateVolume ? 'State volume' : 'Home volume'}, survives a recreate</span></dd>` : ''}
        </dl></section>`;
      };
      const updateStatus = current => current.update?.status === 'available' ? 'Update available' : current.update?.status === 'current' ? 'Up to date' : current.update?.status === 'error' ? 'Couldn’t check' : 'Not checked yet';
      const sourceCheck = (location = 'section') => html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-key="inspector-source-check-${location}" data-inspect-check-source${disabled(view.loading || view.saving || getLibrary().checking(row().key))}>${getLibrary().checking(row().key) ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking…` : html`${icon('refresh-cw')}${row().update ? 'Check again' : 'Check for updates'}`}</button>`;
      const renderBanner = () => {
        if (view.editing) return '';
        const current = row();
        return current?.update?.status === 'available' ? html`<div class="tc-insp-banner">${icon('arrow-up')}<div><strong>Update available</strong><span>A newer version is on <code>${current.origin.source}</code>. Review what changes before you update.</span></div><button class="tc-btn tc-btn--sm" type="button" data-inspect-review-source${disabled(view.loading || view.saving)}>Review update…</button></div>`
          : current?.update?.status === 'error' ? html`<div class="tc-notice tc-notice--warn">${icon('triangle-alert')}<div class="tc-notice-body"><span class="tc-notice-title">Couldn’t check for updates</span><span class="tc-notice-desc">${current.update.error}</span></div><div class="tc-notice-actions">${sourceCheck('banner')}</div></div>` : '';
      };
      const renderOrigin = () => {
        const current = row();
        if (view.editing) return '';
        if (!current?.origin) {
          if (!current?.canEdit) return '';
          return html`<section class="tc-insp-section"><div class="tc-insp-label">Source<span class="tc-spacer"></span><span class="tc-hint">Optional</span></div><div class="tc-group"><div class="tc-src-link"><p class="tc-hint">Link a repository so this skill can be checked and auto-updated. Nothing changes until you review an update.</p><label class="tc-label" for="skill-link-source">Repository, skill link or owner/repo</label><div class="tc-source-input">${icon('link')}<input class="tc-input tc-mono" id="skill-link-source" data-key="skill-link-source" placeholder="owner/repo or https://…" maxlength="2048" autocapitalize="none" spellcheck="false"${disabled(view.loading || view.saving || view.linking)}><button class="tc-btn tc-btn--sm" type="button" data-inspect-link-source${disabled(view.loading || view.saving || view.linking)}>${view.linking ? 'Linking…' : 'Link source'}</button></div>${view.linkError ? html`<p class="tc-hint tc-hint--err" role="alert">${view.linkError}</p>` : ''}</div></div></section>`;
        }
        return html`<section class="tc-insp-section"><div class="tc-insp-label">Source<span class="tc-spacer"></span><span class="tc-hint">${current.origin.manual ? 'Linked by you' : 'Tracked for updates'}</span></div><div class="tc-group"><dl class="tc-pathlist"><dt>Repository</dt><dd>${icon('git-branch', 'tc-icon--sm')}<code>${current.origin.source}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-inspect-copy-source aria-label="Copy repository address">${icon('copy')}</button></dd>${current.update ? html`<dt>Branch</dt><dd><code>${current.update.ref || 'Default branch'}</code></dd>` : ''}<dt>Skill</dt><dd><code>${current.origin.name}</code><span class="tc-hint">in that repository</span></dd></dl><div class="tc-src-status"><span class="tc-dot${current.update?.status === 'error' ? ' tc-dot--warn' : ''}"${current.update?.status === 'available' ? raw(' data-accent') : ''}></span><strong>${updateStatus(current)}</strong>${current.update?.checkedAt ? html`<span class="tc-hint" title="${T3Model.absTime(current.update.checkedAt)}">· checked ${T3Model.relTime(current.update.checkedAt, Date.now())}</span>` : ''}<span class="tc-spacer"></span>${sourceCheck()}</div><div class="tc-src-auto"><label class="tc-src-auto-row"><input class="tc-checkbox" type="checkbox" data-inspect-auto-update${current.origin.autoUpdate ? raw(' checked') : ''}${disabled(view.loading || view.saving)}><span><strong>Auto-update this skill</strong><small>When the Updates page enables Skills auto-update and the server is idle, install new versions without asking. Manual review still works. Turn off to stay manual.</small></span></label><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-inspect-unlink-source${disabled(view.loading || view.saving)}>Unlink source</button></div></div><p class="tc-hint">Updates replace this folder for every agent that reads it. Local edits stay until then. Unlinking keeps the files and stops checks.</p></section>`;
      };
      const renderUsage = () => {
        const current = row();
        if (!current || view.editing) return '';
        const installedAgents = getLibrary().installed;
        const readers = installedAgents.filter(id => !getLibrary().errors[id] && S.available(current.byProvider[id]));
        const restricted = installedAgents.filter(id => current.byProvider[id] && ['off', 'deny', 'disabled', 'ask', 'name-only', 'user-invocable-only'].includes(current.byProvider[id].state));
        const policies = readers.map(id => S.nameOf(id) + ': ' + S.state(current.byProvider[id]).label).join(', ') || 'No agent can use this skill yet';
        const files = view.data?.files?.length ?? current.fileCount ?? null;
        return html`<section class="tc-insp-section"><div class="tc-insp-label">Access & usage</div><div class="tc-group"><dl class="tc-pathlist"><dt>Agents</dt><dd><span class="tc-agent-stack" aria-hidden="true">${readers.map(id => html`<span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(id))}</span>`)}</span><span>${T3Model.plural(readers.length, 'agent')} can use${restricted.length ? ' · ' + restricted.map(id => S.state(current.byProvider[id]).label + ' in ' + S.nameOf(id)).join(', ') : ''}</span></dd><dt>Policies</dt><dd><span class="tc-hint">${policies}</span></dd>${files !== null ? html`<dt>Files</dt><dd>${T3Model.plural(files, 'file')}${view.data ? html`<span class="tc-hint">· ${bytes(view.data.bytes)}</span>` : ''}</dd>` : ''}${current.origin ? html`<dt>Auto</dt><dd>${current.origin.autoUpdate ? 'On for this skill' : 'Manual only'}<span class="tc-hint">· server Skills auto-update controls installs</span></dd>` : ''}</dl></div><p class="tc-hint">Models inherit the agent’s skill: when an agent can use it, its models can too. Turn an agent off to hide it from all its models. Usage here is availability, not a call count — agents don’t report runs.</p></section>`;
      };
      const renderPlugin = () => {
        const id = row()?.byProvider.codex?.pluginId;
        if (!id || view.editing) return '';
        const summary = getLibrary().hookSummary.plugins.find(plugin => plugin.id === id);
        const trusted = summary?.hooks.filter(hook => hook.trustStatus === 'trusted').length || 0;
        return html`<section class="tc-insp-section"><div class="tc-insp-label">Plugin</div><div class="tc-group"><dl class="tc-pathlist"><dt>Plugin</dt><dd><span>${S.pluginName(id)}</span><code>${id}</code></dd><dt>Hooks</dt><dd><span class="${summary?.waiting.length ? 'tc-warning' : ''}">${summary?.waiting.length ? summary.waiting.length + ' waiting for review' : trusted ? trusted + ' trusted' : summary?.hooks.length ? T3Model.plural(summary.hooks.length, 'hook') : getLibrary().hooksReady ? 'None' : 'Not read yet'}</span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-inspect-hooks>Review hooks…</button></dd></dl></div><p class="tc-hint">Hook trust is separate from skill availability.</p></section>`;
      };
      const renderFiles = () => html`<section class="tc-insp-section"><div class="tc-insp-label">Files<span class="tc-spacer"></span><span class="tc-hint">${view.data?.files ? T3Model.plural(view.data.files.length, 'file') : ''}</span></div>
        ${view.loading ? html`<p class="tc-hint">Reading file details…</p>` : view.data?.files ? html`<div class="tc-group"><ul class="tc-files">${view.data.files.map(file => html`<li data-depth="${Math.min(4, file.name.split('/').length - 1)}" title="${file.name}">${icon(file.linked ? 'link' : file.executable ? 'terminal' : 'file-text')}<span class="tc-file-name">${file.name}</span><span class="tc-files-size">${bytes(file.bytes)}</span></li>`)}</ul><div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Scripts are never run here.</span></div></div>` : html`<p class="tc-hint">${view.data?.filesError || (view.data?.removalFiles ? T3Model.plural(view.data.removalFiles, 'file') : 'File details are unavailable.')}</p>`}
      </section>`;
      const renderAvailability = () => {
        const current = row(), installed = getLibrary().installed;
        return html`<section class="tc-insp-section"><div class="tc-insp-label">Available to<span class="tc-spacer"></span><span class="tc-hint">${installed.filter(id => !getLibrary().errors[id] && S.available(current.byProvider[id])).length} of ${installed.length} agents</span></div>
          <div class="tc-group tc-avail">${S.providers.filter(provider => installed.includes(provider.id)).sort((a, b) => Number(Boolean(current.byProvider[b.id])) - Number(Boolean(current.byProvider[a.id]))).map(provider => {
            const found = current.byProvider[provider.id], unavailable = getLibrary().errors[provider.id];
            return html`<div class="tc-avail-row" data-reach="${unavailable ? 'unknown' : found ? 'found' : 'none'}"><span class="tc-tile tc-tile--mark" aria-hidden="true">${raw(T3C.agentMark(provider.id))}</span><div class="tc-row-main"><span class="tc-avail-name">${provider.name}</span>${unavailable ? html`<span class="tc-avail-note">Couldn’t check this agent’s skills</span>` : !found ? html`<span class="tc-avail-note">Not in a folder ${provider.name} reads</span>` : found.effectiveStateText ? html`<span class="tc-avail-note">${found.effectiveStateText}</span>` : ''}</div>
              ${unavailable ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-inspect-rescan${disabled(view.loading || view.saving)}>Rescan</button>` : found ? availability(current, provider.id, true) : html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-inspect-copy-to="${provider.id}"${disabled(view.loading || view.saving)}>Copy to ${provider.name}</button>`}</div>`;
          })}</div><p class="tc-hint">Each setting is the agent’s own and applies to new sessions.</p></section>`;
      };
      const renderEditor = () => html`<section class="tc-insp-section"><div class="tc-editor-toolbar"><label class="tc-insp-label" for="skill-content">SKILL.md</label><div class="tc-editor-tools">
        ${view.editing ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-inspect-upload${disabled(view.loading || view.saving)}>Upload</button><input id="skill-file" type="file" accept=".md,text/markdown" hidden>` : ''}
        <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-inspect-copy aria-label="Copy SKILL.md"${disabled(view.loading || !view.data && !creating)}>${icon('copy')}</button>
        <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-inspect-download aria-label="Download SKILL.md"${disabled(view.loading || !view.data && !creating)}>${icon('download')}</button></div></div>
        ${view.loading ? html`<p class="tc-hint" role="status">Reading SKILL.md…</p>` : view.data || creating ? html`${editor.markup()}<div class="tc-editor-meta" id="skill-editor-meta"><span data-editor-bytes>${bytes(new TextEncoder().encode(view.draft).length)}</span><span data-editor-dirty>${view.editing && dirty() ? 'Unsaved changes' : view.editing ? 'Saved' : 'Read-only'}</span></div>` : ''}</section>`;
      const footer = () => {
        const file = detail();
        if (!creating && !view.data) return html`<span class="tc-hint">${view.loading ? 'Reading skill details…' : 'Rescan to load the current installation.'}</span><span class="tc-spacer"></span><button class="tc-btn" type="button" data-inspect-rescan${disabled(view.loading)}>Rescan library</button>`;
        if (view.editing) return html`<button class="tc-btn tc-btn--ghost" type="button" data-inspect-cancel${disabled(view.saving)}>Cancel</button><span class="tc-spacer"></span><button class="tc-btn tc-btn--primary" type="button" data-inspect-save${disabled(view.loading || view.saving || !creating && !file?.canEdit || creating && !view.slug.trim())}>${view.saving ? 'Saving' : creating ? 'Create skill' : 'Save changes'}</button>`;
        if (file?.readOnlyReason) return html`<span class="tc-hint">${icon('lock', 'tc-icon--sm')}${file.readOnlyReason}</span>`;
        const current = row(), tracked = Boolean(current?.origin), available = current?.update?.status === 'available';
        if (Kit.isPhone()) return html`<button class="tc-btn tc-btn--icon" type="button" data-inspect-menu aria-label="Skill actions"${disabled(view.loading)}>${icon('ellipsis')}</button><span class="tc-spacer"></span>${tracked && !available ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-inspect-review-source${disabled(view.loading)}>Review source…</button>` : ''}${file?.canEdit ? html`<button class="tc-btn${available ? '' : ' tc-btn--primary'}" type="button" data-inspect-edit${disabled(view.loading)}>${!Kit.isPhone() ? icon('pencil') : ''}Edit SKILL.md</button>` : ''}${available ? html`<button class="tc-btn tc-btn--primary" type="button" data-inspect-review-source${disabled(view.loading)}>${!Kit.isPhone() ? icon('arrow-up') : ''}Review update…</button>` : ''}`;
        return html`${file?.canRemove ? html`<button class="tc-btn tc-btn--danger" type="button" data-inspect-remove${disabled(view.loading || view.saving)}>Remove…</button>` : ''}<span class="tc-spacer"></span>${tracked ? !available ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-inspect-review-source${disabled(view.loading)}>Review source…</button>` : '' : html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-inspect-reinstall${disabled(view.loading || view.saving)}>Reinstall from source…</button>`}${file?.canEdit ? html`<button class="tc-btn${available ? '' : ' tc-btn--primary'}" type="button" data-inspect-edit${disabled(view.loading || view.saving)}>${!Kit.isPhone() ? icon('pencil') : ''}Edit SKILL.md</button>` : ''}${available ? html`<button class="tc-btn tc-btn--primary" type="button" data-inspect-review-source${disabled(view.loading)}>${!Kit.isPhone() ? icon('arrow-up') : ''}Review update…</button>` : ''}`;
      };
      view.layer = Kit.open({ kind: 'sheet', returnTo: document.activeElement,
        panel: { class: 'tc-sheet tc-skill-inspector' + (Kit.isPhone() ? ' tc-sheet--bottom' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-view-title' },
        focus: '[data-inspect-close]', backdrop: 'ignore', onEscape: () => { if (!editor.escape()) void view.close('escape'); },
        onRender: layer => editor.sync(layer.panel, { value: view.draft, disabled: view.loading || view.saving, readOnly: !view.editing }),
        onClose: () => { editor.destroy(); window.removeEventListener('beforeunload', beforeUnload); if (active === view) active = null; },
        render: () => html`<div class="tc-insp-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('file-text')}</span><div class="tc-insp-title"><h2 id="skill-view-title">${creating ? 'New skill' : skill.name}</h2><div class="tc-insp-meta">${creating ? 'Write instructions for your agents' : html`${skill.groupLabel}<span>·</span>${detail()?.canEdit ? 'Editable' : 'Read-only'}${view.data?.files ? html`<span>·</span>${T3Model.plural(view.data.files.length, 'file')}` : ''}${view.data ? html`<span>·</span>${bytes(view.data.bytes)}` : ''}`}</div></div><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-inspect-close aria-label="Close skill inspector"${disabled(view.saving)}>${icon('x')}</button></div>
          <div class="tc-insp-body" aria-busy="${String(view.loading || view.saving)}">
            ${view.error ? html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div><strong>${view.data || creating ? 'Couldn’t complete this change' : 'Couldn’t read this skill'}</strong><p>${view.error}</p></div></div>` : ''}
            ${creating ? html`<section class="tc-insp-section"><label class="tc-label" for="skill-target">Location</label><select class="tc-select" id="skill-target"${disabled(view.saving)}>${targets.map(target => html`<option value="${target.value}"${target.value === view.target ? raw(' selected') : ''}>${S.nameOf(target.provider)} · ${target.name}</option>`)}</select><p class="tc-hint">Other agents may read this folder too. Shared file changes affect everyone using it.</p><label class="tc-label" for="skill-slug">Folder name</label><input class="tc-input tc-mono" id="skill-slug" data-key="skill-slug" value="${view.slug}" placeholder="my-skill" maxlength="64" spellcheck="false" autocapitalize="none"${disabled(view.saving)}><p class="tc-hint">Lowercase letters, numbers and hyphens. The frontmatter name must match.</p></section>` : html`${renderBanner()}<p class="tc-insp-desc">${skill.description}</p>${renderOrigin()}${renderAvailability()}${renderUsage()}${renderLocations()}${renderFiles()}`}
            ${!creating ? renderPlugin() : ''}${renderEditor()}
          </div><div class="tc-sheet-foot tc-insp-foot">${footer()}</div>` });
      window.addEventListener('beforeunload', beforeUnload);
      const syncEditor = () => {
        editor.sync(view.layer.panel, { value: view.draft, disabled: view.loading || view.saving, readOnly: !view.editing });
        const save = view.layer.panel.querySelector('[data-inspect-save]');
        if (save) save.disabled = view.loading || view.saving || (creating && !view.slug.trim());
        const size = view.layer.panel.querySelector('[data-editor-bytes]'); if (size) size.textContent = bytes(new TextEncoder().encode(view.draft).length);
        const changed = view.layer.panel.querySelector('[data-editor-dirty]'); if (changed) changed.textContent = dirty() ? 'Unsaved changes' : 'Saved';
      };
      view.layer.panel.addEventListener('input', event => {
        if (event.target.id === 'skill-content') { view.draft = event.target.value; view.generated = false; }
        if (event.target.id === 'skill-slug') {
          view.slug = event.target.value;
          if (view.generated) { view.draft = initial.replace('name: my-skill', 'name: ' + JSON.stringify(view.slug || 'my-skill')); const field = view.layer.panel.querySelector('#skill-content'); if (field) field.value = view.draft; }
        }
        syncEditor();
      });
      view.layer.panel.addEventListener('change', async event => {
        if (event.target.id === 'skill-target') view.target = event.target.value;
        if (event.target.hasAttribute?.('data-inspect-auto-update')) {
          const current = row();
          if (!current?.origin || view.saving || view.loading) { event.target.checked = Boolean(current?.origin?.autoUpdate); return; }
          view.saving = true; repaint();
          const response = await api('/context/skills/auto', { body: { provider: current.provider, id: current.byProvider[current.provider].id, autoUpdate: event.target.checked } });
          view.saving = false;
          if (!response.ok) { view.error = response.error; repaint(); return; }
          Kit.toast(event.target.checked ? 'Auto-update on for ' + current.name : 'Auto-update off for ' + current.name + ' — manual checks still work');
          await refresh();
          return;
        }
        if (event.target.id !== 'skill-file' || !event.target.files?.[0]) return;
        const file = event.target.files[0]; event.target.value = '';
        view.loading = true; view.error = null; repaint();
        try { const text = await readMarkdown(file); if (active !== view) return; view.draft = text; view.generated = false; }
        catch (error) { if (active !== view) return; view.error = error.message; }
        view.loading = false; repaint();
        const field = view.layer.panel.querySelector('#skill-content'); if (field) field.value = view.draft;
      });
      view.layer.panel.addEventListener('keydown', event => {
        if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && view.editing) { event.preventDefault(); view.layer.panel.querySelector('[data-inspect-save]')?.click(); }
      });
      const act = async (action, button) => {
        if (action === 'data-inspect-hooks' && !view.saving && !view.loading) { getLibrary().reviewHooks(row()?.byProvider?.codex?.pluginId); return; }
        if (action === 'data-inspect-check-source') { if (!view.loading && !view.saving) await getLibrary().checkOne(row().key); return; }
        if (action === 'data-inspect-copy-source') { Kit.copy(row().origin.source, button, 'Repository address copied'); return; }
        if (action === 'data-inspect-rescan') { if (await view.close('refresh')) await refresh(); return; }
        if (action === 'data-inspect-link-source') {
          const field = view.layer.panel.querySelector('#skill-link-source');
          const source = field?.value?.trim() || '';
          if (!source) { view.linkError = 'Enter a repository, skill link or owner/repo.'; repaint(); field?.focus(); return; }
          view.linking = true; view.linkError = null; repaint();
          const current = row();
          const response = await api('/context/skills/link', { body: { provider: current.provider, id: current.byProvider[current.provider].id, source, autoUpdate: true } });
          view.linking = false;
          if (!response.ok) { view.linkError = response.error; repaint(); return; }
          Kit.toast('Linked ' + current.name + ' to its source');
          await refresh();
          return;
        }
        if (action === 'data-inspect-unlink-source') {
          const current = row();
          const yes = await Kit.confirm({ title: 'Unlink source for ' + current.name + '?', body: 'Keeps the files. Stops update checks and auto-updates for this skill. You can link it again later.', confirm: 'Unlink source', tone: 'danger' });
          if (!yes || active !== view) return;
          view.saving = true; repaint();
          const response = await api('/context/skills/unlink', { body: { provider: current.provider, id: current.byProvider[current.provider].id } });
          view.saving = false;
          if (!response.ok) { view.error = response.error; repaint(); return; }
          Kit.toast('Unlinked source');
          await refresh();
          return;
        }
        if (action === 'data-inspect-menu') {
          Kit.menu(button, { label: 'Skill actions', items: [
            { label: 'Copy path', icon: 'copy', run: () => act('data-inspect-copy-path') },
            { label: 'Download SKILL.md', icon: 'download', run: download },
            { label: row()?.origin ? row().update?.status === 'available' ? 'Review update…' : 'Review source…' : 'Reinstall from source…', icon: 'download', run: () => act(row()?.origin ? 'data-inspect-review-source' : 'data-inspect-reinstall') },
            ...(detail()?.canRemove ? [{ sep: true }, { label: 'Remove…', icon: 'trash-2', danger: true, run: () => act('data-inspect-remove') }] : []),
          ] }); return;
        }
        if ((action === 'data-inspect-close') || (action === 'data-inspect-cancel')) { await view.close('close'); return; }
        if ((action === 'data-inspect-copy')) { Kit.copy(view.draft, button, 'Skill Markdown copied'); return; }
        if ((action === 'data-inspect-download')) { download(); return; }
        if ((action === 'data-inspect-copy-path')) { Kit.copy(S.directory(detail().path), button, 'Skill folder path copied'); return; }
        if ((action === 'data-inspect-upload')) { view.layer.panel.querySelector('#skill-file').click(); return; }
        if ((action === 'data-inspect-edit')) { view.editing = true; repaint(); view.layer.panel.querySelector('#skill-content')?.focus(); return; }
        if (action === 'data-inspect-review-source') {
          const current = row();
          if (await view.close('review-source')) getLibrary().reviewUpdate(current);
          return;
        }
        if ((action === 'data-inspect-copy-to') || (action === 'data-inspect-reinstall')) {
          const agent = action === 'data-inspect-copy-to' ? button.getAttribute('data-inspect-copy-to') : null;
          if (!await view.close('copy')) return;
          getLibrary().install({ source: agent ? S.directory(detail().path) : detail().packageSource || '', names: agent ? [skill.name] : undefined, agents: agent ? [agent] : undefined, step: agent ? 2 : 1 }); return;
        }
        const remove = (action === 'data-inspect-remove');
        if (!remove && !(action === 'data-inspect-save') || view.saving || view.loading) return;
        if (remove) {
          const yes = await Kit.confirm({ title: 'Remove ' + skill.name + '?', body: view.data.removalKind === 'directory' ? 'Removes this local skill folder and its supporting files. Other agents using this folder lose it too.' : view.data.removalLinkedTarget ? 'Removes this installation entry. Linked target files are kept.' : 'Removes this Markdown file. Other files stay in place.', consequences: [{ icon: 'trash-2', text: view.data.removalPath }], confirm: 'Remove skill', tone: 'danger' });
          if (!yes || active !== view) return;
        }
        view.saving = true; view.error = null; repaint();
        const [provider, target] = creating ? view.target.split(':') : [skill.provider];
        const response = await api('/context/skills/' + (remove ? 'remove' : creating ? 'create' : 'save'), { body: { provider, id: creating ? undefined : skill.byProvider[provider].id, target, slug: view.slug, content: view.draft, revision: view.data?.revision, removalRevision: view.data?.removalRevision } });
        view.saving = false;
        if (!response.ok) { view.error = response.error; repaint(); return; }
        view.editing = false; view.layer.close('saved');
        Kit.toast(remove ? 'Removed local skill installation' : creating ? 'Created skill' : 'Saved SKILL.md');
        await refresh();
      };
      view.layer.panel.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const action = Array.from(button.attributes).find(attribute => attribute.name.startsWith('data-inspect-'))?.name;
        if (action) void act(action, button);
      });
      if (creating) return;
      const response = await api('/context/skills/read?provider=' + encodeURIComponent(skill.provider) + '&id=' + encodeURIComponent(skill.byProvider[skill.provider].id));
      if (active !== view || view.layer.closed) return;
      view.loading = false;
      if (response.ok) { view.data = response.data; view.draft = view.original = response.data.content; view.editing = editing && Boolean(response.data.canEdit); }
      else { view.error = response.error; view.editing = false; }
      repaint();
      if (view.editing) view.layer.panel.querySelector('#skill-content')?.focus();
    };
    return { open, repaint, close: reason => active ? active.close(reason) : true };
  };
  return { create, code };
})();
