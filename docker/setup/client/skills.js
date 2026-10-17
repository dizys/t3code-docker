// On-demand inventory and explicit local file management. Polling never scans skills.
const T3SkillsUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const providers = [['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['cursor', 'Cursor'], ['grok', 'Grok Build'], ['muse', 'Muse Code']];
  const stateOf = (skill) => skill.error ? { text: 'Unavailable', tone: 'warn' }
    : skill.stateAuthority === 'user-policy' ? { text: skill.stateLabel, tone: skill.state === 'off' || skill.state === 'deny' ? '' : 'ok' }
    : skill.native && skill.state === 'enabled' ? { text: 'Enabled', tone: 'ok' }
      : skill.native && skill.state === 'disabled' ? { text: 'Disabled', tone: '' }
        : { text: 'Unverified', tone: '' };
  const create = ({ api, getStatus, render, readMarkdown, downloadMarkdown }) => {
    let provider = null, inventory = null, loading = false, error = null, generation = 0, viewer = null, changing = null;
    const chooseDefault = () => {
      const installed = (getStatus()?.harnesses || []).filter((row) => row.installed).map((row) => row.id);
      return providers.find(([id]) => installed.includes(id))?.[0] || 'claude';
    };
    const load = async (refresh = false) => {
      if (loading) return;
      provider ||= chooseDefault();
      const selected = provider, current = ++generation;
      loading = true; error = null; render();
      const response = await api('/context/skills?provider=' + encodeURIComponent(selected) + (refresh ? '&refresh=1' : ''));
      if (current !== generation) return;
      loading = false;
      if (response.ok) inventory = response.data;
      else error = response.error;
      render();
    };
    const coverageSummary = () => !inventory || loading ? 'Global skills'
      : (inventory.skills?.length || 0) + (inventory.skills?.length === 1 ? ' skill' : ' skills') + ' · ' + (inventory.coverage === 'policy' ? 'User policy checked' : inventory.coverage === 'native' ? 'Provider checked' : 'Files only');
    const content = () => html`<div class="tc-group tc-skills"${inventory ? raw(' data-provider="' + inventory.provider + '"') : ''}>
      <div class="tc-skill-toolbar"><label class="tc-label" for="skill-provider">Provider</label><select class="tc-select" id="skill-provider">${providers.map(([id, name]) => html`<option value="${id}"${(provider || chooseDefault()) === id ? raw(' selected') : ''}>${name}</option>`)}</select><span class="tc-spacer"></span><span class="tc-hint tc-skill-count">${coverageSummary()}</span></div>
      <div aria-live="polite" aria-busy="${String(loading)}">
        ${loading ? html`<p class="tc-skill-message tc-muted"><span class="tc-spinner" aria-hidden="true"></span>Reading skills…</p>` : ''}
        ${error ? html`<p class="tc-skill-message tc-danger" role="alert">Could not read skills: ${error}</p>` : ''}
        ${!loading && !error && inventory ? html`
          <p class="tc-skill-message tc-hint">${inventory.coverage === 'policy' ? 'Availability reflects this provider’s user policy.' : inventory.coverage === 'native' ? 'Availability checked by Codex in this environment.' : 'Files found on disk. This provider does not expose a verified availability check here.'}</p>
          ${inventory.nativeError ? html`<p class="tc-skill-message tc-warning" role="status">${icon('triangle-alert')}<span>Native checks unavailable: ${inventory.nativeError}</span></p>` : ''}
          ${(inventory.warnings || []).map((warning) => html`<p class="tc-skill-message tc-warning" role="status">${icon('triangle-alert')}<span>${warning}</span></p>`)}
          <div class="tc-list">${(inventory.skills || []).map((skill) => {
            const status = stateOf(skill);
            const initials = skill.name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || 'SK';
            return html`<div class="tc-row tc-skill-row" data-key="skill-${skill.id}"><span class="tc-tile" style="--_tile: var(--id-toolchain)" aria-hidden="true">${initials}</span><div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">${skill.name}</span><span class="tc-badge${status.tone ? ' tc-badge--' + status.tone : ''}">${status.text}</span></div>
              ${skill.description ? html`<p class="tc-small tc-muted tc-skill-description">${skill.description}</p>` : ''}
              <span class="tc-hint">${skill.source}${skill.metadataError ? ' · Metadata needs attention' : ''}${skill.effectiveStateText ? ' · ' + skill.effectiveStateText : ''}</span></div>
              <div class="tc-row-actions">${skill.canSetState ? html`<label class="tc-skill-policy"><span class="tc-hint">${provider === 'claude' ? 'Visibility' : 'Permission'}</span><select class="tc-select" data-skill-policy="${skill.id}" aria-label="${provider === 'claude' ? 'Visibility' : 'Permission'} for ${skill.name}"${changing ? raw(' disabled') : ''}>${skill.stateOptions.map((option) => html`<option value="${option.value}"${option.value === skill.state ? raw(' selected') : ''}>${option.label}</option>`)}</select></label>` : ''}${skill.canToggle ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.state" data-id="${skill.id}" aria-label="${skill.state === 'enabled' ? 'Disable' : 'Enable'} ${skill.name} for Codex"${changing ? raw(' disabled') : ''}>${changing?.id === skill.id && changing.provider === provider ? 'Saving…' : skill.state === 'enabled' ? 'Disable' : 'Enable'}</button>` : ''}${skill.canEdit ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.edit" data-id="${skill.id}" aria-label="Edit ${skill.name}">${icon('pencil')}Edit</button>` : ''}<button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.view" data-id="${skill.id}" aria-label="View ${skill.name}">${icon('book-open')}View</button></div></div>`;
          })}</div>
          ${!inventory.skills?.length ? html`<div class="tc-empty tc-empty--compact tc-skill-empty"><span class="tc-empty-media" aria-hidden="true"><span class="tc-empty-icon">${icon('book-open')}</span></span><span class="tc-empty-title">${inventory.warnings?.length ? 'No skills could be shown' : 'No skills found'}</span><span class="tc-empty-desc">${inventory.warnings?.length ? 'Review the scan messages above.' : 'Nothing in the checked global folders for ' + (providers.find(([id]) => id === provider)?.[1] || 'this provider') + '. Add a skill here, or refresh after installing one elsewhere.'}</span>${!inventory.warnings?.length && inventory.canCreate ? html`<button class="tc-btn tc-btn--primary tc-btn--sm tc-skill-empty-action" type="button" data-cmd="skills.add">${icon('plus')}Add skill</button>` : ''}</div>` : ''}
          ${inventory.roots?.length ? html`<details class="tc-skill-locations" data-key="skill-locations"><summary>Checked ${inventory.roots.length} global ${inventory.roots.length === 1 ? 'folder' : 'folders'}</summary>${inventory.roots.map((root) => html`<code>${root.path}</code>`)}</details>` : ''}
        ` : ''}
      </div>
      <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>${inventory?.skills?.length && inventory.coverage === 'policy' ? 'User policies apply to every installation with the same ' + (provider === 'claude' ? 'name' : 'native skill ID') + '. Project or managed settings can further restrict use; start a new conversation after changing a policy.' : inventory?.skills?.length && provider === 'codex' && inventory.coverage === 'native' ? 'Availability applies to Codex only. Start a new conversation after changing it; existing conversations may keep loaded instructions.' : 'Refresh after changing skills outside the console. Project/session settings and custom provider environments can change locations or availability.'}</span></div>
    </div>`;
    const actions = () => html`${inventory?.canCreate ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.add">${icon('plus')}Add skill</button>` : ''}<button class="tc-btn tc-btn--sm tc-btn--ghost" type="button" data-cmd="skills.refresh"${loading || changing ? raw(' disabled') : ''}>${icon('refresh-cw')}Refresh skills</button>`;
    const setState = async (id, state) => {
      const row = inventory?.skills?.find((skill) => skill.id === id);
      if ((!row?.canToggle && !row?.canSetState) || loading || changing) return;
      const selected = provider, enabled = selected === 'codex' ? row.state !== 'enabled' : undefined;
      if (row.canSetState && (!row.stateOptions.some((option) => option.value === state) || state === row.state)) return;
      changing = { provider: selected, id }; render();
      const response = await api('/context/skills/state', { body: { provider: selected, id, stateRevision: row.stateRevision, enabled, state } });
      changing = null;
      if (response.ok) Kit.toast(selected === 'codex' ? enabled ? 'Enabled skill for Codex' : 'Disabled skill for Codex' : 'Saved native skill policy');
      else Kit.toast('Could not change skill policy', { tone: 'danger', detail: response.error });
      if (provider !== selected) { render(); return; }
      // Supersede any inventory fetched while the settings write was in flight.
      generation++; loading = false;
      if (response.ok) { inventory = response.data.inventory; error = null; render(); }
      else { inventory = null; await load(true); }
    };
    const open = async (id, editing = false, creating = false) => {
      const row = creating ? { name: 'Add skill', source: 'Provider', canEdit: true } : inventory?.skills?.find((skill) => skill.id === id);
      if (!row || (editing && !creating && !row.canEdit)) return;
      if (viewer?.saving) return;
      viewer?.layer.close('replace');
      const template = (slug) => '---\nname: ' + JSON.stringify(slug || 'my-skill') + '\ndescription: Describe when to use this skill.\n---\n\nWrite the skill instructions here.\n';
      const current = { provider, row, loading: !creating, data: null, error: null, layer: null, editing, creating, saving: false, slug: '', target: inventory?.creationTargets?.[0]?.id || 'provider', draft: creating ? template('') : '', original: '', generated: true };
      const formatBytes = (bytes) => bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
      const isDirty = () => creating || current.draft !== current.original;
      const editorMeta = () => formatBytes(new TextEncoder().encode(current.draft).length) + ' · ' + (creating ? 'New skill' : isDirty() ? 'Unsaved changes' : 'Saved');
      const fileName = () => (creating ? current.slug : row.name).replace(/[^a-z0-9-]/gi, '-').slice(0, 64) || 'skill';
      const download = () => downloadMarkdown(fileName() + '.md', current.draft);
      const disabled = (condition) => condition ? raw(' disabled') : '';
      viewer = current;
      current.layer = Kit.open({ kind: 'center', panel: { class: 'tc-sheet tc-context-sheet tc-skill-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-view-title' }, focus: '[data-skill-close]',
        backdrop: 'ignore', onEscape: () => { if (!current.saving) current.layer.close('escape'); },
        onClose: () => { if (viewer === current) viewer = null; },
        render: () => html`<div class="tc-sheet-head"><span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('book-open')}</span><div class="tc-sheet-head-text"><h3 class="tc-sheet-title" id="skill-view-title">${row.name}</h3><span class="tc-small tc-muted">${providers.find(([key]) => key === current.provider)?.[1]} · ${row.source}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-skill-close aria-label="Close"${disabled(current.saving)}>${icon('x')}</button></div>
          <div class="tc-sheet-body">
            ${creating ? html`${inventory?.creationTargets?.length > 1 ? html`<label class="tc-label" for="skill-target">Location</label><select class="tc-select" id="skill-target"${disabled(current.saving)}>${inventory.creationTargets.map((target) => html`<option value="${target.id}"${current.target === target.id ? raw(' selected') : ''}>${target.name}</option>`)}</select><p class="tc-hint">Shared skills can be used by multiple providers. Editing or removing them affects every provider using the same files.</p>` : ''}<label class="tc-label" for="skill-slug">Folder name</label><input class="tc-input" id="skill-slug" data-key="skill-slug" value="${current.slug}" placeholder="my-skill" maxlength="64" autocapitalize="none" spellcheck="false"${disabled(current.saving)}><p class="tc-hint">Use lowercase letters, numbers and hyphens. The frontmatter name must match.</p>` : html`<div class="tc-skill-meta"><span class="tc-hint">Location</span><code>${current.data?.path || row.path}</code>${(current.data?.resolvedPath || row.resolvedPath) && (current.data?.resolvedPath || row.resolvedPath) !== row.path ? html`<span class="tc-hint">Linked target</span><code>${current.data?.resolvedPath || row.resolvedPath}</code>` : ''}</div>
            <p class="tc-hint">${stateOf(row).text}${row.invocation === 'manual' ? ' · Manual invocation requested by the skill' : row.invocation === 'model-only' ? ' · User invocation disabled in frontmatter' : ''}. ${row.stateAuthority === 'user-policy' ? 'Native user policy checked by the managed provider. ' + row.effectiveStateText + '. Session rules can differ.' : row.native ? 'Listed by Codex in the managed setup environment.' : 'File found on disk; provider availability is unverified.'}</p>`}
            ${!creating && row.stateReadOnlyReason ? html`<p class="tc-hint">${row.stateReadOnlyReason}</p>` : ''}
            ${row.metadataError ? html`<p class="tc-hint tc-warning">${row.metadataError}</p>` : ''}
            ${current.error ? html`<p class="tc-danger" role="alert">${current.error}</p>` : ''}
            <div class="tc-editor-toolbar"><label class="tc-label" for="skill-content">Markdown${current.data && !current.editing ? ' · ' + formatBytes(current.data.bytes) : ''}</label><div class="tc-editor-tools">${current.editing ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-skill-upload title="Replace this draft from a Markdown file"${disabled(current.loading || current.saving || (!creating && !current.data))}>${icon('upload')}Upload</button>` : ''}<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-skill-download title="Download, including unsaved edits"${disabled(current.loading || current.saving || (!current.data && !creating))}>${icon('download')}Download</button><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-skill-copy${disabled(current.loading || current.saving || (!current.data && !creating))}>${icon('copy')}Copy</button></div>${current.editing ? html`<input id="skill-file" type="file" accept=".md,text/markdown" hidden>` : ''}</div>
            ${current.loading ? html`<p class="tc-muted" role="status">Reading Markdown…</p>` : current.data || creating ? html`
              <textarea id="skill-content" data-key="skill-content" class="tc-input tc-input--area tc-editor-area"${current.editing ? raw(' aria-describedby="skill-editor-meta"') : raw(' readonly')}${disabled(current.saving)} spellcheck="false" rows="14">${current.draft}</textarea>
              ${current.editing ? html`<div class="tc-editor-meta"><span id="skill-editor-meta" data-key="skill-editor-meta">${editorMeta()}</span><span>${creating ? 'Creates the skill in the selected location.' : 'Saving updates this file wherever it is used. Supporting files and symlinks stay in place.'}<span class="tc-desk-only"> Ctrl/⌘ S to save.</span></span></div>` : (current.data?.readOnlyReason || current.data?.removalError) ? html`<p class="tc-hint">${current.data.readOnlyReason || current.data.removalError}</p>` : ''}
            ` : ''}
          </div><div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-skill-close${disabled(current.saving)}>Close</button>
          ${current.editing ? html`<button class="tc-btn tc-btn--primary" type="button" data-skill-save${disabled(current.loading || current.saving || (!creating && !current.data) || !isDirty() || (creating && !current.slug))}>${current.saving ? 'Saving…' : creating ? 'Add skill' : 'Save'}</button>` : html`${current.data?.canRemove ? html`<button class="tc-btn tc-btn--danger" type="button" data-skill-remove${disabled(current.saving)}>Remove…</button>` : ''}${current.data?.canEdit ? html`<button class="tc-btn tc-btn--primary" type="button" data-skill-edit>Edit Markdown</button>` : ''}`}</div>`,
      });
      const syncEditor = () => {
        const meta = current.layer.panel.querySelector('#skill-editor-meta');
        if (meta) meta.textContent = editorMeta();
        const save = current.layer.panel.querySelector('[data-skill-save]');
        if (save) save.disabled = current.loading || current.saving || (!creating && !current.data) || !isDirty() || (creating && !current.slug);
      };
      current.layer.panel.addEventListener('input', (event) => {
        if (event.target.id === 'skill-content') { current.draft = event.target.value; current.generated = false; syncEditor(); }
        if (event.target.id === 'skill-slug') {
          current.slug = event.target.value;
          if (current.generated) { current.draft = template(current.slug); current.layer.panel.querySelector('#skill-content').value = current.draft; }
          syncEditor();
        }
      });
      current.layer.panel.addEventListener('keydown', (event) => {
        if (event.target.id === 'skill-content' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          current.layer.panel.querySelector('[data-skill-save]')?.click();
        }
      });
      current.layer.panel.addEventListener('change', async (event) => {
        if (event.target.id === 'skill-target') { current.target = event.target.value; return; }
        if (event.target.id !== 'skill-file' || !event.target.files?.[0]) return;
        const file = event.target.files[0]; event.target.value = ''; current.loading = true; current.error = null; current.layer.render();
        try { const text = await readMarkdown(file); if (viewer !== current) return; current.draft = text; current.generated = false; }
        catch (error) { if (viewer !== current) return; current.error = error.message; }
        current.loading = false; current.layer.render();
      });
      current.layer.panel.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        if (button.hasAttribute('data-skill-close')) current.layer.close('close');
        else if (button.hasAttribute('data-skill-copy')) Kit.copy(current.draft, button, 'Skill Markdown copied');
        else if (button.hasAttribute('data-skill-download')) download();
        else if (button.hasAttribute('data-skill-upload')) current.layer.panel.querySelector('#skill-file').click();
        else if (button.hasAttribute('data-skill-edit')) { current.editing = true; current.layer.render(); current.layer.panel.querySelector('#skill-content').focus(); }
        else if (button.hasAttribute('data-skill-save') || button.hasAttribute('data-skill-remove')) {
          const removing = button.hasAttribute('data-skill-remove');
          if (current.saving || current.loading) return;
          if (removing) {
            const yes = await Kit.confirm({ title: 'Remove ' + row.name + '?', body: current.data.removalKind === 'directory' ? 'Removes this local skill folder and its supporting files. Other providers using this folder will lose it too.' : current.data.removalLinkedTarget ? 'Removes this installation entry. Linked target files are kept.' : 'Removes this skill Markdown file. Other files in the folder stay in place.', consequences: [{ icon: 'trash-2', text: current.data.removalPath }], confirm: 'Remove skill', tone: 'danger' });
            if (!yes || viewer !== current || current.saving) return;
          }
          current.saving = true; current.error = null; current.layer.render();
          const response = await api('/context/skills/' + (removing ? 'remove' : creating ? 'create' : 'save'), { body: { provider: current.provider, id, slug: current.slug, target: current.target, content: current.draft, revision: current.data?.revision, removalRevision: current.data?.removalRevision } });
          current.saving = false;
          if (!response.ok) {
            if (viewer === current) { current.error = response.error; current.layer.render(); }
            else Kit.toast('Skill change failed', { tone: 'danger', detail: response.error, action: { label: 'Download draft', run: download } });
            return;
          }
          if (viewer === current) current.layer.close('saved');
          Kit.toast(removing ? 'Removed local skill installation' : 'Saved skill');
          await load(true);
        }
      });
      if (creating) return;
      const response = await api('/context/skills/read?provider=' + encodeURIComponent(current.provider) + '&id=' + encodeURIComponent(id));
      if (viewer !== current) return;
      current.loading = false;
      if (response.ok) { current.data = response.data; current.draft = response.data.content; current.original = response.data.content; current.editing = editing && Boolean(response.data.canEdit); }
      else current.error = response.error;
      current.layer.render();
    };
    return { content, actions, setState, view: (id, editing = false) => open(id, editing), add: () => { if (inventory?.canCreate) return open(null, true, true); },
      activate: () => { if (!inventory && !loading && !error) load(); },
      refresh: () => load(true),
      select: (id) => {
        if (!providers.some(([key]) => key === id) || id === provider) return;
        viewer?.layer.close('provider');
        provider = id; inventory = null; loading = false; error = null; generation++;
        load();
      },
    };
  };
  return { create, stateOf };
})();
