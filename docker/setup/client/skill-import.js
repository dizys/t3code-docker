// Three-step snapshot installer. Destination requests are serialized and versioned;
// changing a choice immediately invalidates consent and the previous plan.
const T3SkillImport = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const S = T3SkillModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const checked = value => value ? raw(' checked') : '';
  const mark = id => html`<span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(id))}</span>`;
  const create = ({ api, getLibrary, refresh, showInLibrary }) => {
    let active = null;
    const open = (options = {}) => {
      if (active) return;
      const library = getLibrary();
      const view = { source: options.source || '', preview: null, skills: new Set(), agents: new Set(options.agents || library.installed), mode: options.mode === 'each' ? 'each' : 'fewest',
        railOpen: !Kit.isPhone(), step: 1, query: '', catalogQuery: '', expanded: new Set(), plan: null, result: null, replace: false, error: null, reading: false,
        planning: false, installing: false, retryInstall: false, expired: false, generation: 0, planTimer: null, expiryTimer: null, planRequest: null, sourceRequest: null, closed: false, layer: null, metadata: '' };
      active = view;
      const selectedSkills = () => (view.preview?.skills || []).filter(skill => view.skills.has(skill.name));
      const agentIds = () => [...new Set([...(getLibrary().agents || getLibrary().installed), ...view.agents])];
      const planner = () => S.placement([...view.agents], [...new Set([...getLibrary().installed, ...view.agents])], getLibrary().roots, view.mode);
      const placements = () => view.plan?.destinations || [];
      const replacements = () => placements().filter(entry => entry.action === 'replace');
      const copies = () => placements().length;
      const results = () => view.result?.results || [];
      const successful = () => results().filter(entry => entry.status === 'installed');
      const fileList = files => html`<ul class="tc-files">${(files || []).map(file => html`<li data-depth="${Math.min(4, file.name.split('/').length - 1)}">${icon(file.executable ? 'terminal' : 'file-text')}<span class="tc-file-name" title="${file.name}">${file.name}</span><span class="tc-files-size">${M.formatBytes(file.bytes)}</span></li>`)}</ul>`;
      const canInstall = () => !view.reading && !view.planning && !view.installing && !view.expired && view.plan?.canInstall && copies() > 0
        && view.skills.size > 0 && view.agents.size > 0 && !planner().uncovered.length && (!replacements().length || view.replace);
      const discard = async id => { if (id) await api('/context/skills/discard', { body: { previewId: id } }); };
      const sync = () => {
        for (const field of view.layer.panel.querySelectorAll('[data-import-skill]')) field.checked = view.skills.has(field.getAttribute('data-import-skill'));
        for (const field of view.layer.panel.querySelectorAll('[data-import-agent]')) field.checked = view.agents.has(field.getAttribute('data-import-agent'));
        const all = view.layer.panel.querySelector('[data-import-all]');
        if (all) {
          const shown = filteredSkills(), count = shown.filter(skill => view.skills.has(skill.name)).length;
          all.checked = shown.length > 0 && count === shown.length; all.indeterminate = count > 0 && count < shown.length;
          all.setAttribute('aria-checked', all.indeterminate ? 'mixed' : String(all.checked));
        }
        const consent = view.layer.panel.querySelector('[data-import-replace]'); if (consent) consent.checked = view.replace;
      };
      const render = (step = false) => {
        if (view.closed) return;
        view.layer.render(); sync();
        if (step) {
          // Desktop scrolls the main column; phones scroll the entire grid.
          for (const scroller of view.layer.panel.querySelectorAll('.tc-wizard-main, .tc-wizard-grid')) scroller.scrollTop = 0;
          view.layer.panel.querySelector(view.error ? '#skill-import-error' : '#skill-import-step-title')?.focus({ preventScroll: true });
        }
        else if (!view.layer.panel.contains(document.activeElement) || document.activeElement.matches(':disabled')) view.layer.panel.focus({ preventScroll: true });
      };
      const invalidatePlan = (schedule = true) => {
        view.generation++; view.plan = null; view.replace = false; view.retryInstall = false;
        clearTimeout(view.planTimer);
        if (schedule && view.step === 2 && view.preview?.previewId && view.agents.size && view.skills.size && !view.expired) {
          view.planning = true;
          view.planTimer = setTimeout(() => { void plan(); }, 250);
        } else view.planning = false;
      };
      const plan = async () => {
        if (view.closed || view.step !== 2 || view.expired) return;
        // The backend holds one plan slot per snapshot. A stale request must
        // finish before the next request can replace that slot.
        if (view.planRequest) { const generation = view.generation; await view.planRequest; if (!view.closed && view.step === 2 && generation === view.generation) return plan(); return; }
        const generation = view.generation, placement = planner();
        if (!view.skills.size || !view.agents.size || placement.uncovered.length) { view.planning = false; render(); return; }
        view.planning = true; render();
        const request = api('/context/skills/plan', { body: { previewId: view.preview.previewId, skills: [...view.skills], providers: placement.providers } });
        view.planRequest = request;
        const response = await request; view.planRequest = null;
        if (view.closed) { await discard(view.preview?.previewId); return; }
        if (generation !== view.generation || view.step !== 2) return;
        view.planning = false;
        if (response.ok) { view.plan = response.data; view.error = null; }
        else { view.error = response.error; view.plan = null; if (/expired/i.test(response.error)) view.expired = true; }
        render();
      };
      const preview = async (source, initial = false) => {
        if (view.reading || view.installing || view.closed || !source.trim()) return;
        const previous = view.preview?.previewId;
        view.source = source.trim(); view.reading = true; view.error = null; view.result = null; view.step = 1; view.preview = null;
        view.skills.clear(); view.expanded.clear(); view.query = view.catalogQuery = ''; view.expired = false;
        clearTimeout(view.expiryTimer); invalidatePlan(false); render();
        const input = view.layer.panel.querySelector('#skill-source'); if (input) input.value = view.source;
        // Source reads and plan disposal can overlap with dismissal, but never
        // with publication. Discard again after any late request settles.
        if (view.planRequest) await view.planRequest;
        await discard(previous);
        if (view.closed) return;
        const request = api('/context/skills/source', { body: { source: view.source } }); view.sourceRequest = request;
        const response = await request; view.sourceRequest = null;
        if (view.closed) { await discard(response.data?.previewId); return; }
        view.reading = false;
        if (!response.ok) view.error = response.error;
        else {
          view.preview = response.data;
          const skills = response.data.skills || [];
          view.skills = new Set(initial && options.names ? skills.filter(skill => options.names.includes(skill.name)).map(skill => skill.name) : skills.length === 1 ? [skills[0].name] : []);
          if (response.data.previewId) {
            // Use the server's interval so a phone with a skewed wall clock
            // does not expire a fresh preview. The API remains authoritative.
            const delay = Math.max(0, Math.min(600000, response.data.expiresAt && response.data.createdAt
              ? response.data.expiresAt - response.data.createdAt : (response.data.expiresAt || Date.now() + 600000) - Date.now()));
            view.expiryTimer = setTimeout(() => { if (view.installing || view.step === 3) return; view.expired = true; invalidatePlan(false); render(); }, delay);
          }
          if (initial && options.step === 2 && view.skills.size) { view.step = 2; invalidatePlan(); }
        }
        render(true);
      };
      const filteredSkills = () => (view.preview?.skills || []).filter(skill => (skill.name + ' ' + skill.description).toLocaleLowerCase().includes(view.query.toLocaleLowerCase()));
      const installedName = name => [...(getLibrary().rows || []), ...(getLibrary().physicalRows || [])].some(row => row.name === name && row.root?.owner && getLibrary().installed.includes(row.root.owner));
      const sourceSummary = () => {
        const info = view.preview?.sourceInfo;
        return html`<div class="tc-source-found">${icon('check')}<strong>${info?.type === 'git' ? /github\.com/.test(info.source) ? 'GitHub' : /gitlab\.com/.test(info.source) ? 'GitLab' : 'Git repository' : info?.type === 'local' ? 'Container folder' : 'Source'}</strong><code>${info?.source || view.source}</code>${info?.commit ? html`<span>·</span><code title="${info.commit}">${info.ref || 'HEAD'} @ ${info.commit.slice(0, 7)}</code>` : ''}<span>· ${M.plural(view.preview?.skills?.length || 0, 'skill')}</span></div>`;
      };
      const skillPicker = () => html`<div class="tc-source"><label class="tc-label" for="skill-source">Repository, skill link or folder</label><div class="tc-source-input">${icon('link')}<input class="tc-input" id="skill-source" data-key="skill-source" value="${view.source}" placeholder="owner/repo or https://…" maxlength="2048" autocapitalize="none" spellcheck="false"${disabled(view.reading)}><button class="tc-btn tc-btn--sm" type="button" data-import-read${disabled(view.reading || !view.source.trim())}>${view.reading ? 'Reading' : view.preview ? 'Read again' : 'Read'}</button></div>
        ${view.preview ? sourceSummary() : ''}<p class="tc-hint">Also takes GitLab, SSH, skills.sh links, npx skills add commands or a folder in the container.</p></div>
        ${(view.preview?.warnings || []).map(warning => html`<p class="tc-hint tc-warning">${warning}</p>`)}
        ${view.preview?.links?.length ? html`<section class="tc-insp-section"><label class="tc-label" for="skill-catalog-search">Choose a skill or repository</label><input class="tc-input" id="skill-catalog-search" data-key="skill-catalog-search" type="search" value="${view.catalogQuery}" placeholder="Search these links"><div class="tc-import-catalog">${view.preview.links.map((link, index) => ({ ...link, index })).filter(link => link.label.toLowerCase().includes(view.catalogQuery.toLowerCase())).map(link => html`<button class="tc-btn tc-btn--ghost" type="button" data-import-link="${link.index}">${link.label}${icon('arrow-right')}</button>`)}</div></section>` : ''}
        ${view.preview?.skills?.length ? html`<div class="tc-picklist"><div class="tc-picklist-head"><label class="tc-import-check-all"><input class="tc-checkbox" type="checkbox" data-import-all aria-label="Select all visible skills"></label><span class="tc-hint" id="skill-picker-title">${view.skills.size} of ${view.preview.skills.length} selected</span><span class="tc-spacer"></span><input class="tc-input" id="skill-import-filter" data-key="skill-import-filter" value="${view.query}" type="search" aria-label="Filter source skills" placeholder="Filter skills"></div><div class="tc-picklist-body">
          ${filteredSkills().map(skill => html`<div class="tc-pick" data-key="source-skill-${skill.name}"${view.expanded.has(skill.name) ? raw(' data-open') : ''}><input class="tc-checkbox" id="import-pick-${skill.name}" type="checkbox" data-import-skill="${skill.name}"${checked(view.skills.has(skill.name))}><div><label class="tc-pick-name" for="import-pick-${skill.name}">${skill.name}${installedName(skill.name) ? html`<span class="tc-tagline">${view.skills.has(skill.name) ? 'Update' : 'Installed'}</span>` : ''}</label><p class="tc-pick-desc" title="${skill.description}">${skill.description}</p></div><button class="tc-btn tc-btn--ghost tc-btn--xs tc-pick-side" type="button" data-import-files="${skill.name}" aria-expanded="${String(view.expanded.has(skill.name))}" aria-label="Review files for ${skill.name}">${M.plural(skill.files.length, 'file')} · ${M.formatBytes(skill.bytes)}${icon('chevron-down')}</button>${view.expanded.has(skill.name) ? html`<div class="tc-pick-files">${fileList(skill.files)}<div class="tc-pick-files-foot">${icon('info')}<span>Scripts are copied as files. Nothing here runs them.</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-import-markdown="${skill.name}">View SKILL.md</button></div></div>` : ''}</div>`)}
          ${!filteredSkills().length ? html`<p class="tc-hint tc-import-empty">No skills match this filter.</p>` : ''}
        </div></div>` : !view.preview && !view.reading ? html`<div class="tc-import-intro"><span class="tc-tile tc-tile--icon tc-tile--lg">${icon('download')}</span><h3>Bring a workflow to your agents</h3><p class="tc-hint">Read a source to review its skills and files before choosing where to install them.</p><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-import-example>Try vercel-labs/skills</button></div>` : ''}`;
      const destinationGroups = entries => {
        const groups = new Map();
        for (const entry of entries) {
          const key = entry.directory ? S.directory(entry.directory) : 'blocked:' + entry.provider;
          if (!groups.has(key)) groups.set(key, { key, provider: entry.provider, entries: [] });
          groups.get(key).entries.push(entry);
        }
        return [...groups.values()];
      };
      const agentRow = (provider, destination) => {
        const id = provider.id, selected = view.agents.has(id), duplicate = planner().duplicates.includes(id);
        const own = id === destination || planner().destinations.find(folder => folder.provider === destination)?.also.includes(id);
        return html`<label class="tc-route-row"${!selected ? raw(' data-off') : ''}><input class="tc-checkbox" type="checkbox" data-import-agent="${id}"${checked(selected)}${disabled(view.installing || view.retryInstall)}>${mark(id)}<span class="tc-row-main"><span class="tc-avail-name">${provider.name}</span><span class="tc-avail-note">${!getLibrary().installed.includes(id) ? 'Not detected. ' : ''}${own ? 'Its own folder' : destination ? 'Reads ' + S.nameOf(destination) + '’s folder for compatibility' : 'Choose this agent to include it'}${duplicate ? '. Finds ' + planner().counts[id] + ' identical copies.' : ''}</span></span></label>`;
      };
      const agentPicker = () => {
        const placement = planner(), groups = view.plan ? destinationGroups(placements()) : placement.destinations.map(destination => ({ key: destination.root?.path || destination.provider, provider: destination.provider, entries: [] }));
        return html`<div class="tc-import-step-head"><div><h3 class="tc-step-title">Which agents get these skills?</h3><p class="tc-hint">Each copy goes where its agents already look.</p></div><div class="tc-seg" role="group" aria-label="Skill placement"><button type="button" data-import-mode="fewest"${disabled(view.installing || view.retryInstall)} aria-pressed="${String(view.mode === 'fewest')}">Fewest copies</button><button type="button" data-import-mode="each"${disabled(view.installing || view.retryInstall)} aria-pressed="${String(view.mode === 'each')}">A copy per agent</button></div></div>
          <div class="tc-group tc-route-list">${groups.map(group => html`<div class="tc-route-group">${icon('folder')}<code>${S.displayPath(group.key.startsWith('blocked:') ? S.nameOf(group.provider) : group.key, library.home)}</code><span>·</span><span>${S.nameOf(group.provider)} folder</span><span class="tc-spacer"></span><span>${group.entries.some(entry => entry.action === 'blocked') ? 'Blocked' : group.entries.length ? M.plural(group.entries.filter(entry => entry.action === 'add').length, 'new', 'new') + (group.entries.some(entry => entry.action === 'replace') ? ' · ' + group.entries.filter(entry => entry.action === 'replace').length + ' replaces yours' : '') : view.planning ? 'Checking…' : ''}</span></div>${S.providers.filter(provider => view.agents.has(provider.id) && placement.assignments[provider.id] === group.provider).map(provider => agentRow(provider, group.provider))}${group.entries.filter(entry => entry.action === 'blocked').map(entry => html`<p class="tc-danger tc-import-blocked" role="alert">${entry.name}: ${entry.error}</p>`)}`)}
            ${S.providers.filter(provider => agentIds().includes(provider.id) && (!view.agents.has(provider.id) || placement.uncovered.includes(provider.id))).map(provider => agentRow(provider, null))}
            ${placement.uncovered.length ? html`<div class="tc-import-blocked" role="alert"><p class="tc-danger">No writable placement covers ${M.listOf(placement.uncovered.map(S.nameOf))}.</p><p class="tc-hint">Try a copy per agent to review its folder, or check its folder permissions.</p></div>` : ''}
            ${!agentIds().length ? html`<p class="tc-hint tc-import-empty">Show other agents in the library to manage their folders before installing them.</p>` : !view.agents.size ? html`<p class="tc-hint tc-import-empty">Choose at least one agent above.</p>` : ''}
          </div>
          ${replacements().length ? html`<label class="tc-import-consent"><input class="tc-checkbox" type="checkbox" data-import-replace${checked(view.replace)}${disabled(view.installing || view.retryInstall)}><span><strong>${replacements().length === 1 ? 'Replace ' + replacements()[0].name + ' in ' + S.nameOf(replacements()[0].provider) + '’s folder' : 'Replace ' + replacements().length + ' existing skills'}</strong>${replacements().length > 1 ? html`<span class="tc-hint">${replacements().map(entry => entry.name + ' · ' + S.nameOf(entry.provider)).join(', ')}</span>` : ''}<span class="tc-hint">The folder becomes the source’s copy. Local edits and files the source no longer has are removed. Its visibility and permission settings stay.</span></span></label>` : ''}
          ${view.error && !view.expired && !view.retryInstall ? html`<button class="tc-btn tc-btn--sm" type="button" data-import-retry-plan${disabled(view.planning)}>Review destinations again</button>` : ''}`;
      };
      const resultPage = () => html`<div class="tc-result-hero" data-state="${successful().length === results().length ? 'ok' : 'partial'}"><span class="tc-result-mark">${icon(successful().length === results().length ? 'check' : 'triangle-alert')}</span><div><h3>${successful().length === results().length ? M.plural(successful().length, 'copy', 'copies') + ' installed' : successful().length + ' of ' + results().length + ' copies installed'}</h3><p class="tc-hint">${successful().length === results().length ? 'Your agents can find them in their usual folders.' : M.listOf(results().filter(entry => entry.status === 'failed').map(entry => entry.name + ' for ' + S.nameOf(entry.provider))) + ' wasn’t written.'}</p></div></div>
        <div class="tc-group tc-destinations">${destinationGroups(results()).map(group => html`<div class="tc-dest-head">${icon('folder')}<code>${S.displayPath(group.key, library.home)}</code></div>${group.entries.map(entry => html`<div class="tc-dest-row" data-state="${entry.status === 'installed' ? 'ok' : 'failed'}">${icon(entry.status === 'installed' ? 'circle-check' : 'circle-alert')}<strong class="tc-dest-name">${entry.name}</strong>${entry.status === 'installed' ? html`<span class="tc-hint">${entry.action === 'replace' ? 'Replaced · settings kept' : 'Added'}</span>` : ''}${entry.status === 'failed' ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-import-review-again="${entry.provider}" data-import-name="${entry.name}">Review again</button><span class="tc-dest-note">${entry.error}</span>` : ''}${entry.warning ? html`<span class="tc-dest-note">${entry.warning}</span>` : ''}</div>`)}`)}</div>
        <div class="tc-notice tc-notice--info">${icon('info')}<div class="tc-notice-body"><span class="tc-notice-desc">Start a new session to use them. Sessions that are already open keep the skills they loaded.</span></div></div>`;
      const planRail = () => {
        const placement = planner();
        const notInstalled = S.providers.filter(provider => !getLibrary().installed.includes(provider.id));
        const agentSummary = html`<div class="tc-plan-section"><div class="tc-plan-stat"><strong>${view.agents.size}</strong><span>of ${agentIds().length} agents</span></div><div class="tc-agent-stack">${S.providers.filter(provider => view.agents.has(provider.id)).map(provider => mark(provider.id))}</div>${notInstalled.length ? html`<p class="tc-plan-note">${M.listOf(notInstalled.map(provider => provider.name))} ${notInstalled.length === 1 ? 'isn’t' : 'aren’t'} installed.</p>` : ''}</div>`;
        let summary;
        if (view.step === 1) {
          summary = html`<div class="tc-plan-section"><div class="tc-plan-stat"><strong>${view.skills.size}</strong><span>skills</span></div><ul class="tc-plan-list">${selectedSkills().map(skill => html`<li>${skill.name}<span class="tc-plan-end">${installedName(skill.name) ? 'Replaces yours' : 'New'}</span></li>`)}</ul></div><div class="tc-plan-section"><span class="tc-plan-label">Agents</span><p class="tc-plan-note">Next, choose agents. Every installed agent starts selected.</p></div>`;
        } else if (view.step === 2) {
          const folders = view.plan ? destinationGroups(placements()) : placement.destinations.map(destination => ({ key: destination.root?.path || S.nameOf(destination.provider), entries: selectedSkills() }));
          summary = html`${agentSummary}<div class="tc-plan-section"><div class="tc-plan-stat"><strong>${view.plan ? copies() : selectedSkills().length * placement.providers.length}</strong><span>copies in ${folders.length} folders</span></div><ul class="tc-plan-list">${folders.map(group => html`<li><code>${S.displayPath(group.key, library.home)}</code><span class="tc-plan-end">${group.entries.length}</span></li>`)}</ul></div>
            ${replacements().length ? html`<p class="tc-plan-note">${replacements().length} replaces your copy · ${view.replace ? 'Confirmed' : 'Needs confirmation'}</p>` : ''}
            ${placement.duplicates.map(id => html`<p class="tc-plan-note">${S.nameOf(id)} finds ${placement.counts[id]} copies · Identical</p>`)}
            ${placement.also.length ? html`<p class="tc-plan-note">Also available to ${M.listOf(placement.also.map(S.nameOf))} through these folders.</p>` : ''}`;
        } else {
          summary = html`<div class="tc-plan-section"><div class="tc-plan-stat"><strong>${successful().length}</strong><span>installed</span></div><p class="tc-plan-note">${results().length - successful().length} not written</p></div><div class="tc-plan-section"><span class="tc-plan-label">Agents can find</span><ul class="tc-plan-list">${S.providers.filter(provider => view.agents.has(provider.id)).map(provider => {
            const count = new Set(successful().filter(entry => (getLibrary().roots.find(root => (root.owners || [root.owner]).includes(entry.provider))?.readers || [entry.provider]).includes(provider.id)).map(entry => entry.name)).size;
            return html`<li>${mark(provider.id)}${provider.name}<span class="tc-plan-end">${M.plural(count, 'skill')}</span></li>`;
          })}</ul></div>`;
        }
        return html`<div class="tc-plan-source"><span class="tc-plan-label">Source</span><code>${view.preview?.sourceInfo?.source || view.source || 'Choose a source'}</code>${view.step === 2 ? html`<span class="tc-hint">${selectedSkills().map(skill => skill.name).join(', ') || 'No skills selected'}</span>` : ''}${view.preview?.previewId && view.step !== 3 ? html`<span class="tc-hint" title="${M.absTime(view.preview.expiresAt)}">${view.expired ? 'Snapshot expired' : view.preview.sourceInfo?.commit ? 'Snapshot of ' + view.preview.sourceInfo.commit.slice(0, 7) + ', held for 10 minutes' : 'Snapshot held for 10 minutes'}</span>` : ''}</div>
          ${summary}<p class="tc-plan-note tc-plan-bottom">${view.step === 1 ? 'What installs is exactly this snapshot. The source isn’t fetched again.' : view.step === 2 ? 'New skills start with each agent’s default setting. Agents load them in new sessions.' : 'Reinstall from source when you want to update these skills later.'}</p>`;
      };
      const beforeUnload = event => { if (view.installing || view.retryInstall) { event.preventDefault(); event.returnValue = ''; } };
      const close = () => { if (!view.installing) view.layer.close('close'); };
      view.layer = Kit.open({ kind: 'center', panel: { class: 'tc-wizard tc-skill-import' + (Kit.isPhone() ? ' tc-sheet--bottom' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-import-title' },
        focus: '#skill-source', backdrop: 'ignore', onEscape: close,
        onClose: () => { window.removeEventListener('beforeunload', beforeUnload); view.closed = true; if (active === view) active = null; clearTimeout(view.planTimer); clearTimeout(view.expiryTimer); void discard(view.preview?.previewId); },
        render: () => html`<div class="tc-wizard-head"><span class="tc-tile tc-tile--icon tc-tile--lg">${icon('download')}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="skill-import-title">Install from source</h2><span class="tc-small tc-muted">Copies skills into your agents’ folders. Nothing in them runs here.</span></div><ol class="tc-steps" aria-label="Installation steps">${['Skills', 'Agents', 'Install'].flatMap((label, index) => [index ? html`<li class="tc-step-line"${view.step > index ? raw(' data-done') : ''} aria-hidden="true"></li>` : '', html`<li class="tc-step" data-state="${view.step === index + 1 ? 'active' : view.step > index + 1 ? 'done' : 'pending'}"${view.step === index + 1 ? raw(' aria-current="step"') : ''}><span class="tc-step-mark">${view.step > index + 1 ? icon('check') : index + 1}</span><span>${label}</span></li>`])}</ol><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-import-close aria-label="Close installation"${disabled(view.installing)}>${icon('x')}</button></div>
          <div class="tc-wizard-grid"><div class="tc-wizard-main" aria-busy="${String(view.reading || view.planning || view.installing)}"><h3 id="skill-import-step-title" class="tc-sr" tabindex="-1">${view.step === 1 ? 'Choose skills' : view.step === 2 ? 'Choose agents and folders' : 'Installation results'}</h3>
            ${view.error ? html`<div class="tc-notice tc-notice--danger" role="alert" id="skill-import-error" tabindex="-1"><div class="tc-notice-body"><span class="tc-notice-title">Couldn’t finish this step</span><span class="tc-notice-desc">${view.error}${view.retryInstall ? html`<br>The outcome is unconfirmed. Retry this same plan to recover its result safely; it won’t install a second copy.` : ''}</span></div></div>` : ''}
            ${view.expired ? html`<div class="tc-notice tc-notice--warn" role="status"><div class="tc-notice-body"><span class="tc-notice-title">This snapshot expired</span><span class="tc-notice-desc">Read the source again to review current files before installing.</span></div><button class="tc-btn tc-btn--sm" type="button" data-import-reread>Read source again</button></div>` : ''}
            ${view.step === 1 ? skillPicker() : view.step === 2 ? agentPicker() : resultPage()}
            ${view.reading || view.planning || view.installing ? html`<p class="tc-hint tc-import-progress" role="status"><span class="tc-spinner" aria-hidden="true"></span>${view.installing ? 'Installing the reviewed snapshot…' : view.planning ? 'Checking destinations…' : 'Reading source… You can close while this finishes.'}</p>` : ''}
          </div><div class="tc-wizard-rail-wrap"${view.railOpen ? raw(' data-open') : ''}><button class="tc-wizard-rail-toggle" type="button" data-import-rail aria-controls="skill-import-plan" aria-expanded="${String(view.railOpen)}">Install plan · ${view.step === 3 ? successful().length + ' installed' : view.skills.size + ' skills'}${icon('chevron-down')}</button><aside class="tc-wizard-rail" id="skill-import-plan" aria-label="Install plan">${planRail()}</aside></div></div>
          <div class="tc-wizard-foot">${view.step !== 3 ? html`<span class="tc-hint tc-wizard-keyboard"><kbd class="tc-kbd">${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd><kbd class="tc-kbd">↵</kbd>${view.step === 2 ? 'to install' : 'to continue'}</span><span class="tc-spacer"></span>` : ''}${view.step === 3 ? html`<button class="tc-btn tc-btn--ghost" type="button" data-import-show>Show in library</button><span class="tc-spacer"></span><button class="tc-btn tc-btn--primary" type="button" data-import-close>Done</button>` : html`${view.step === 2 ? html`<button class="tc-btn" type="button" data-import-back${disabled(view.installing || view.retryInstall)}>Back</button>` : html`<button class="tc-btn tc-btn--ghost" type="button" data-import-close>Close</button>`}<button class="tc-btn tc-btn--primary" type="button" data-import-next${disabled(view.step === 1 ? view.reading || !view.preview?.previewId || !view.skills.size || view.expired : !canInstall())}>${view.installing ? 'Installing' : view.retryInstall ? 'Retry installation' : view.step === 1 ? html`Choose agents ${icon('arrow-right')}` : 'Install ' + M.plural(copies(), 'copy', 'copies')}</button>`}</div>` });
      window.addEventListener('beforeunload', beforeUnload);
      view.layer.panel.addEventListener('input', event => {
        if (event.target.id === 'skill-source') {
          view.source = event.target.value;
          if (view.preview) { const id = view.preview.previewId; view.preview = null; view.skills.clear(); invalidatePlan(false); clearTimeout(view.expiryTimer); void discard(id); }
          render();
        } else if (event.target.id === 'skill-import-filter') { view.query = event.target.value; render(); }
        else if (event.target.id === 'skill-catalog-search') { view.catalogQuery = event.target.value; render(); }
      });
      view.layer.panel.addEventListener('paste', event => { if (event.target.id === 'skill-source') setTimeout(() => { if (!view.closed) void preview(event.target.value); }, 0); });
      view.layer.panel.addEventListener('change', event => {
        if (view.installing || view.retryInstall) return;
        if (event.target.hasAttribute('data-import-skill')) { const name = event.target.getAttribute('data-import-skill'); event.target.checked ? view.skills.add(name) : view.skills.delete(name); invalidatePlan(false); }
        if (event.target.hasAttribute('data-import-all')) { const select = event.target.checked; for (const skill of filteredSkills()) select ? view.skills.add(skill.name) : view.skills.delete(skill.name); invalidatePlan(false); }
        if (event.target.hasAttribute('data-import-agent')) { const id = event.target.getAttribute('data-import-agent'); event.target.checked ? view.agents.add(id) : view.agents.delete(id); invalidatePlan(); }
        if (event.target.hasAttribute('data-import-replace')) view.replace = event.target.checked;
        render();
      });
      const advance = async () => {
        if (view.step === 1) { if (!view.preview?.previewId || !view.skills.size || view.reading || view.expired) return; view.step = 2; view.error = null; invalidatePlan(); render(true); return; }
        if (view.step !== 2 || !canInstall()) return;
        view.installing = true; view.error = null; render();
        const response = await api('/context/skills/install', { body: { previewId: view.preview.previewId, planId: view.plan.planId, replace: view.replace } });
        view.installing = false;
        if (response.ok) { view.retryInstall = false; clearTimeout(view.expiryTimer); view.result = response.data; view.step = 3; Kit.announce(successful().length + ' of ' + results().length + ' skill copies installed'); }
        else {
          view.error = response.error;
          // The server caches a plan's result. A lost response must retry that
          // same plan, not replan an operation that may already have committed.
          view.retryInstall = !response.status || response.status >= 500;
          if (!view.retryInstall) invalidatePlan(false);
          if (/expired/i.test(response.error)) { view.expired = true; invalidatePlan(false); }
        }
        if (view.closed) { Kit.toast(response.ok ? 'Skill installation finished' : 'Skill installation failed', { tone: response.ok ? undefined : 'danger', detail: response.error }); }
        else render(true);
        if (response.ok) await refresh();
      };
      view.layer.panel.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        if (event.target.id === 'skill-source' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void preview(view.source); }
        else if (event.metaKey || event.ctrlKey) { event.preventDefault(); void advance(); }
      });
      view.layer.panel.addEventListener('click', async event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.hasAttribute('data-import-close')) { close(); return; }
        if (button.hasAttribute('data-import-rail')) { view.railOpen = !view.railOpen; render(); return; }
        if (view.installing) return;
        if (button.hasAttribute('data-import-read') || button.hasAttribute('data-import-reread')) await preview(view.source);
        else if (button.hasAttribute('data-import-example')) await preview('https://github.com/vercel-labs/skills');
        else if (button.hasAttribute('data-import-link')) await preview(view.preview.links[Number(button.getAttribute('data-import-link'))].source);
        else if (button.hasAttribute('data-import-next')) await advance();
        else if (button.hasAttribute('data-import-back')) { view.step = 1; view.error = null; invalidatePlan(false); render(true); }
        else if (button.hasAttribute('data-import-mode')) { view.mode = button.getAttribute('data-import-mode'); invalidatePlan(); render(); }
        else if (button.hasAttribute('data-import-files')) { const name = button.getAttribute('data-import-files'); view.expanded.has(name) ? view.expanded.delete(name) : view.expanded.add(name); render(); }
        else if (button.hasAttribute('data-import-markdown')) {
          const skill = view.preview.skills.find(skill => skill.name === button.getAttribute('data-import-markdown'));
          if (skill) Kit.open({ kind: 'center', panel: { class: 'tc-sheet tc-context-sheet tc-source-markdown', role: 'dialog', 'aria-modal': 'true', 'aria-label': skill.name + ' SKILL.md' }, backdrop: 'close', render: () => html`<div class="tc-sheet-head"><h3 class="tc-sheet-title">${skill.name} · SKILL.md</h3><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-close-source-markdown aria-label="Close Markdown">${icon('x')}</button></div><div class="tc-sheet-body">${T3SkillInspector.code(skill.content)}</div>` }).panel.querySelector('[data-close-source-markdown]').addEventListener('click', () => Kit.top().close('close'));
        } else if (button.hasAttribute('data-import-review-again')) {
          view.agents = new Set([button.getAttribute('data-import-review-again')]); view.skills = new Set([button.getAttribute('data-import-name')]);
          view.mode = 'each'; view.result = null; view.step = 2; view.error = null; invalidatePlan(); render(true);
        } else if (button.hasAttribute('data-import-retry-plan')) { view.error = null; invalidatePlan(); render(); }
        else if (button.hasAttribute('data-import-show')) { const names = successful().map(entry => entry.name); view.layer.close('library'); if (location.hash !== '#instructions/skills') location.hash = '#instructions/skills'; showInLibrary(names); }
      });
      view.metadata = JSON.stringify([getLibrary().installed, getLibrary().roots]);
      view.reconcileMetadata = () => { if (view.step === 2 && !view.installing && !view.retryInstall) invalidatePlan(); render(); };
      if (options.source) void preview(options.source, true);
    };
    return { open, closeForNavigation: () => {
      if (active?.installing) { Kit.announce('Wait for the installation result before leaving this page'); return false; }
      active?.layer.close('route'); return true;
    }, repaint: () => {
      if (!active || active.closed) return;
      const metadata = JSON.stringify([getLibrary().installed, getLibrary().roots]);
      if (metadata !== active.metadata) {
        active.metadata = metadata;
        // Metadata only arrives while opening/scanning a library. The current
        // step will use it on its next explicit selection; no draft is reset.
        active.reconcileMetadata();
      }
    } };
  };
  return { create };
})();
