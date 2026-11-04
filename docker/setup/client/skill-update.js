// One reviewed installation, one immutable operation. The server owns every
// destination and conflict token. Source text is escaped, never interpreted.
const T3SkillUpdate = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const S = T3SkillModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const fileIcon = file => file.after?.executable || file.before?.executable ? 'terminal'
    : file.status === 'added' ? 'file-plus' : file.status === 'removed' ? 'file-minus' : 'file-diff';
  const fileBytes = bytes => bytes >= 1000 && bytes < 1000000 ? (Math.round(bytes / 100) / 10) + ' kB' : T3Model.formatBytes(bytes);
  const changeLabel = file => file.before?.linked ? 'linked file · its target is kept'
    : file.before && file.after && file.before.executable !== file.after.executable ? file.after.executable ? 'now executable' : 'no longer executable'
      : file.name === 'SKILL.md' ? 'Instructions · changed' : ({ added: 'new file', removed: 'deleted by the update', modified: 'changed', unchanged: file.after?.executable ? 'executable' : 'unchanged' })[file.status];
  const omittedText = { binary: 'No preview for binary files.', large: 'Too large to preview here (over 64 KB).', linked: 'A linked file. Its target is kept, not replaced.',
    budget: 'Not previewed: this update is too large to show every file.', unchanged: 'This file stays the same.' };
  const create = ({ api, refresh, home, showInLibrary, getLibrary = () => ({ rows: [], installed: [] }), downloadMarkdown }) => {
    let active = null;
    const request = async (...args) => {
      try { return await api(...args); }
      catch (error) { return { ok: false, status: 0, error: error.message || 'The connection was interrupted.' }; }
    };
    const discard = id => id && request('/context/skills/discard', { body: { previewId: id } });
    const close = () => {
      if (active?.phase === 'saving') { Kit.announce('Wait for the skill update to finish'); return false; }
      active?.layer.close('close'); return true;
    };
    const open = (provider, id, { queue = [] } = {}) => {
      if (active && !active.layer.closed) { active.layer.panel.focus(); return; }
      const allRows = () => getLibrary().physicalRows || getLibrary().rows || [];
      const lookup = (provider, id) => allRows().find(row => row.byProvider[provider]?.id === id);
      const original = lookup(provider, id);
      const media = window.matchMedia('(max-width: 639.98px)');
      const view = { provider, id, row: original, data: null, phase: 'loading', consent: false, message: '', code: null, result: null,
        timer: null, savedTimer: null, diffTimer: null, saved: false, layer: null, file: null, side: 'changes', folds: new Set(), diffs: new Map(),
        showUnchanged: false, queue: [...queue], index: Math.max(0, queue.indexOf(original?.key)), generation: 0 };
      active = view;
      const alive = () => active === view && !view.layer.closed;
      const saving = () => view.phase === 'saving';
      const busy = () => saving() || view.phase === 'loading';
      const compact = () => !['loading', 'review'].includes(view.phase);
      const name = () => view.data?.name || view.row?.name || 'skill';
      const source = () => view.data?.source || view.row?.origin?.source || 'the repository';
      const path = value => S.displayPath(value || '', home());
      const changed = () => (view.data?.changes || []).filter(file => file.status !== 'unchanged').sort(S.changeOrder);
      const readers = () => {
        const all = view.data?.target.readers || [], installed = getLibrary().installed;
        return { detected: all.filter(id => installed.includes(id)), undetected: all.filter(id => !installed.includes(id)) };
      };
      const recipients = () => readers().detected.length === 1 ? S.nameOf(readers().detected[0])
        : readers().detected.length ? M.plural(readers().detected.length, 'agent') : 'agents that read this folder';
      const actionLabel = () => readers().detected.length ? 'Update for ' + recipients() : 'Update this folder';
      const next = () => {
        for (let index = view.index + 1; index < view.queue.length; index++) {
          const row = allRows().find(row => row.key === view.queue[index]);
          if (row?.origin && row.update?.status === 'available') return { row, index };
        }
        return null;
      };
      const panelClass = () => compact() ? 'tc-ur tc-ur--compact' : media.matches ? 'tc-ur tc-ur--phone tc-sheet tc-sheet--bottom tc-sheet--full' : 'tc-ur';
      const paint = () => {
        if (!alive()) return;
        view.layer.panel.className = panelClass();
        view.layer.panel.setAttribute('aria-busy', String(busy()));
        view.layer.render();
      };
      const stateFocus = () => {
        queueMicrotask(() => {
          if (!alive()) return;
          (view.layer.panel.querySelector('[data-update-primary]:not([disabled])') || view.layer.panel.querySelector('#skill-update-title') || view.layer.panel).focus({ preventScroll: true });
        });
      };
      const phase = (value, message = '') => {
        view.phase = value; view.message = message; paint();
        if (compact()) { Kit.announce(stateCopy().title); stateFocus(); }
      };
      const diffFor = file => {
        if (!view.diffs.has(file.name)) view.diffs.set(file.name, T3SkillDiff.lines(file.text?.before, file.text?.after));
        return view.diffs.get(file.name);
      };
      const stats = file => {
        if (file.status === 'modified' && file.text && (file.name === view.file || view.diffs.has(file.name))) {
          const hunks = diffFor(file);
          if (hunks[0]?.kind !== 'limit') {
            const count = T3SkillDiff.counts(hunks);
            return html`<span class="add">+${count.added}</span><span class="del">−${count.removed}</span>`;
          }
        }
        return fileBytes(file.after?.bytes ?? file.before?.bytes ?? 0);
      };
      const cancelStats = () => {
        if (view.diffTimer !== null) { if (window.cancelIdleCallback) cancelIdleCallback(view.diffTimer); else clearTimeout(view.diffTimer); view.diffTimer = null; }
      };
      const warmStats = () => {
        cancelStats();
        const generation = view.generation;
        const work = () => {
          view.diffTimer = null;
          if (!alive() || generation !== view.generation || view.phase !== 'review') return;
          const file = changed().find(file => file.status === 'modified' && file.text && !view.diffs.has(file.name));
          if (!file) return;
          diffFor(file); paint(); warmStats();
        };
        view.diffTimer = window.requestIdleCallback ? requestIdleCallback(work, { timeout: 500 }) : setTimeout(work, 16);
      };
      const mark = id => html`<span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(id))}</span>`;
      const readerTiles = () => html`<span class="tc-tiles" aria-hidden="true">${readers().detected.map(mark)}</span>`;
      const readerTitle = () => readers().undetected.length ? M.listOf(readers().undetected.map(S.nameOf)) + (readers().undetected.length === 1 ? ' also reads this folder but isn’t detected here.' : ' also read this folder but aren’t detected here.') : '';
      const summary = () => html`<span class="tc-ur-counts">${changed().length ? [['modified', 'changed'], ['added', 'added'], ['removed', 'removed']].filter(([key]) => view.data.summary[key]).map(([key, label]) => html`<span data-change-kind="${key}">${view.data.summary[key]} <i>${label}</i></span>`) : 'Files match'}</span>`;
      const localEdits = () => view.data.localChanges ? media.matches
        ? html`<div class="tc-notice tc-notice--warn tc-ur-edits" role="status">${icon('triangle-alert')}<div class="tc-notice-body"><span class="tc-notice-title">Your local edits will be replaced</span><span class="tc-notice-desc">This folder changed since it was installed. <button class="tc-ur-save-inline" type="button" data-update-download>${view.saved ? 'Saved' : 'Save current SKILL.md'}</button></span></div></div>`
        : html`<div class="tc-notice tc-notice--warn tc-ur-edits" role="status">${icon('triangle-alert')}<div class="tc-notice-body"><span class="tc-notice-title">Your local edits will be replaced</span><span class="tc-notice-desc">This folder changed since it was installed. Updating replaces everything in it with the repository’s files.</span></div><div class="tc-notice-actions"><button class="tc-btn tc-btn--sm" type="button" data-update-download>${icon(view.saved ? 'check' : 'download')}${view.saved ? 'Saved' : 'Save current SKILL.md'}</button></div></div>` : '';
      const facts = () => media.matches ? html`<div class="tc-group tc-pur-facts"><div class="tc-pur-fact"><span>Changes</span>${summary()}</div><div class="tc-pur-fact" title="${readerTitle()}"><span>For</span><span class="tc-ur-mobile-readers">${readerTiles()}${recipients()}</span></div><div class="tc-pur-fact"><span>Folder</span><code title="${view.data.target.directory}">${path(view.data.target.directory)}</code></div></div>`
        : html`<div class="tc-ur-facts"><div class="tc-ur-fact"><span class="tc-ur-fact-label">Changes</span><div class="tc-ur-fact-value">${summary()}</div><span class="tc-ur-fact-note">${view.data.summary.unchanged ? view.data.summary.unchanged + (view.data.summary.unchanged === 1 ? ' other file stays the same' : ' other files stay the same') : 'No other files'}</span></div>
          <div class="tc-ur-fact" title="${readerTitle()}"><span class="tc-ur-fact-label">Updates the skill for</span><div class="tc-ur-fact-value">${readerTiles()}${recipients()}</div><span class="tc-ur-fact-note">${view.data.target.readers.length === 1 && readers().detected.length === 1 ? 'Only ' + recipients() + ' reads this folder' : 'Every agent that reads this folder'}</span></div>
          <div class="tc-ur-fact"><span class="tc-ur-fact-label">Folder, replaced in place</span><div class="tc-ur-fact-value">${icon(view.data.target.linked ? 'link' : 'folder')}<code title="${view.data.target.directory}">${path(view.data.target.directory)}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-update-copy aria-label="Copy skill folder path">${icon('copy')}</button></div><span class="tc-ur-fact-note${view.data.target.linked ? ' tc-ur-link-note' : ''}">${view.data.target.linked ? html`<span>Linked to</span><code title="${view.data.target.resolvedDirectory}">${path(view.data.target.resolvedDirectory)}</code><span>. The link is kept.</span>` : 'Files that aren’t in the repository are deleted.'}</span></div></div>`;
      const fileNote = file => {
        const slash = file.name.lastIndexOf('/');
        return (slash >= 0 ? file.name.slice(0, slash + 1) + ' · ' : '') + changeLabel(file);
      };
      const codeText = text => {
        const key = /^(\s*(?:name|description):)(.*)$/.exec(text);
        return key ? html`<span class="k">${key[1]}</span>${key[2]}` : html`${text}`;
      };
      const lineText = line => line.mark ? html`${codeText(line.text.slice(0, line.mark.start))}<mark>${line.text.slice(line.mark.start, line.mark.end)}</mark>${line.text.slice(line.mark.end)}` : codeText(line.text);
      const diffLine = (line, phone) => html`<div class="tc-dv-line" data-key="diff-${line.oldPosition}-${line.newPosition}-${line.kind}" data-k="${line.kind === 'added' ? 'add' : line.kind === 'removed' ? 'del' : 'context'}">${!phone ? html`<span class="n" aria-hidden="true">${line.oldLine ?? ''}</span><span class="n" aria-hidden="true">${line.newLine ?? ''}</span>` : ''}<span class="s" aria-hidden="true">${line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</span><span class="tc-dv-text"><span class="tc-sr">${line.kind === 'context' ? 'Unchanged' : line.kind === 'added' ? 'Added' : 'Removed'}${line.oldLine !== null ? ', installed line ' + line.oldLine : ''}${line.newLine !== null ? ', incoming line ' + line.newLine : ''}: </span>${line.text ? lineText(line) : '\n'}</span></div>`;
      const diffContents = (file, phone = false) => {
        if (!file.text) return html`<div class="tc-ur-no-text" role="status">${icon(file.before?.linked ? 'link' : 'file-text')}<p>${omittedText[file.textOmitted] || 'No text preview is available for this file.'}</p><span>${fileBytes(file.after?.bytes ?? file.before?.bytes ?? 0)}</span></div>`;
        const hunks = diffFor(file);
        if (hunks[0]?.kind === 'limit') return html`<p class="tc-ur-no-text" role="status">Too long to compare line by line.</p>${T3SkillInspector.code(file.text[view.side === 'before' || file.status === 'removed' ? 'before' : 'after'] ?? '', 'Selected file contents')}`;
        if (file.status !== 'modified' || view.side !== 'changes') return T3SkillInspector.code(file.text[file.status === 'removed' || view.side === 'before' ? 'before' : 'after'] ?? '', file.status === 'removed' || view.side === 'before' ? 'Installed file' : 'Incoming file');
        if (!hunks.length) return html`<p class="tc-ur-no-text">These files have the same text. Line endings or executable settings may differ.</p>`;
        return html`<div class="tc-dv${phone ? ' tc-dv--phone' : ''}">${hunks.map(hunk => hunk.kind === 'fold' ? html`<div class="tc-dv-fold" data-key="${file.name}-${hunk.id}"><button class="tc-dv-hunk" type="button" data-update-fold="${hunk.id}" aria-expanded="${String(view.folds.has(hunk.id))}" aria-label="${(view.folds.has(hunk.id) ? 'Hide ' : 'Show ') + M.plural(hunk.lines.length, 'unchanged line') + (hunk.headings.length ? ' · ' + hunk.headings.join(', ') : '')}">${icon(view.folds.has(hunk.id) ? 'chevron-down' : 'chevron-right')}${phone ? html`<span aria-hidden="true">${icon('ellipsis')}</span>` : html`${view.folds.has(hunk.id) ? 'Hide' : 'Show'} ${M.plural(hunk.lines.length, 'unchanged line')}${hunk.headings.length ? html`<span class="tc-dv-fold-headings" title="${hunk.headings.join(', ')}">· ${hunk.headings.join(', ')}</span>` : ''}`}</button>${view.folds.has(hunk.id) ? hunk.lines.map(line => diffLine(line, phone)) : ''}</div>` : html`<div class="tc-dv-block" data-key="${file.name}-${hunk.id}">${hunk.lines.map(line => diffLine(line, phone))}</div>`)}</div>`;
      };
      const fileSize = file => file.status === 'added' ? 'New · ' + fileBytes(file.after.bytes) : file.status === 'removed' ? 'Deleted · ' + fileBytes(file.before.bytes)
        : fileBytes(file.before.bytes) + ' → ' + fileBytes(file.after.bytes);
      const segments = file => file.status === 'modified' && file.text ? html`<div class="tc-seg tc-seg--sm" role="group" aria-label="File version">${[['changes', 'Changes'], ['after', 'Incoming file'], ['before', 'Installed file']].map(([side, label]) => html`<button type="button" data-update-side="${side}" aria-pressed="${String(view.side === side)}"${disabled(side === 'changes' && diffFor(file)[0]?.kind === 'limit')}>${label}</button>`)}</div>` : '';
      const fileOptions = () => {
        const files = changed(), unchanged = view.data.changes.filter(file => file.status === 'unchanged').sort(S.changeOrder);
        return html`<div class="tc-ur-files"><div class="tc-ur-files-scroll"><div class="tc-ur-files-label" id="skill-update-files-label">${M.plural(files.length, 'file')} ${files.length === 1 ? 'changes' : 'change'}</div><div role="${files.length ? 'listbox' : 'group'}" aria-labelledby="skill-update-files-label" aria-orientation="vertical" data-update-file-list>${files.map((file, index) => html`<button class="tc-ur-file" type="button" role="option" data-key="update-file-${file.name}" data-update-file="${file.name}" data-status="${file.status}" aria-selected="${String(view.file === file.name)}" tabindex="${view.file === file.name ? '0' : '-1'}" id="skill-update-file-${index}" aria-controls="skill-update-diff" title="${file.name}">${icon(fileIcon(file))}<span class="tc-ur-file-name"><span>${file.name.split('/').at(-1)}</span><small>${fileNote(file)}</small></span><span class="tc-ur-file-stat">${stats(file)}</span></button>`)}</div>
          ${unchanged.length ? html`<hr><div class="tc-ur-files-label">Stays the same</div>${unchanged.slice(0, view.showUnchanged ? unchanged.length : 5).map(file => html`<div class="tc-ur-file" data-dim data-key="unchanged-${file.name}" title="${file.name}">${icon(file.after?.executable ? 'terminal' : 'file-text')}<span class="tc-ur-file-name"><span>${file.name.split('/').at(-1)}</span><small>${fileNote(file)}</small></span><span class="tc-ur-file-stat">${fileBytes(file.after?.bytes ?? 0)}</span></div>`)}${unchanged.length > 5 && !view.showUnchanged ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-update-more>Show ${unchanged.length - 5} more</button>` : ''}` : ''}</div>
          ${view.data.changes.some(file => file.after?.executable || file.before?.executable) ? html`<p class="tc-ur-files-note">${icon('info')}<span>Nothing is run while updating. Agents may run a skill’s scripts later, so look closely at new or changed ones.</span></p>` : ''}</div>`;
      };
      const filePane = () => {
        const file = changed().find(file => file.name === view.file);
        return file ? html`<div class="tc-ur-diff"><div class="tc-ur-diff-head"><code title="${file.name}">${file.name}</code><span>${fileSize(file)}</span><span class="tc-spacer"></span>${segments(file)}</div><div class="tc-ur-diff-scroll" id="skill-update-diff" role="region" aria-label="Changes in ${file.name}" tabindex="0" data-key="file-pane-${file.name}">${diffContents(file)}</div></div>` : html`<div class="tc-ur-no-text">The files already match this repository snapshot. Updating refreshes its saved repository tracking.</div>`;
      };
      const accordion = () => html`<div class="tc-group tc-pur-files">${changed().map((file, index) => html`<button class="tc-pur-file" type="button" data-update-file="${file.name}" data-status="${file.status}" data-key="phone-update-${file.name}" aria-expanded="${String(view.file === file.name)}" aria-controls="phone-file-${index}">${icon(fileIcon(file))}<span title="${file.name}">${file.name.split('/').at(-1)}</span><span class="tc-ur-file-stat">${stats(file)}</span>${icon(view.file === file.name ? 'chevron-down' : 'chevron-right')}</button><div class="tc-pur-diff" id="phone-file-${index}" role="region" tabindex="0" aria-label="Changes in ${file.name}. Scroll to read all changes."${view.file !== file.name ? raw(' hidden') : ''}>${view.file === file.name ? html`${segments(file)}${diffContents(file, true)}` : ''}</div>`)}</div>`;
      const consent = () => view.data.localChanges ? html`<label class="tc-ur-consent"><input class="tc-checkbox" type="checkbox" data-key="update-consent" data-update-consent${view.consent ? raw(' checked') : ''}><span><strong>Replace my local edits</strong><small>I’ve saved anything I want to keep from the current folder.</small></span></label>`
        : html`<span class="tc-ur-foot-note">${icon('circle-check')}No local edits. The folder matches what was installed.</span>`;
      const header = () => html`<div class="tc-ur-head${media.matches ? ' tc-pur-head' : ''}">${!media.matches ? html`<span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('arrow-up')}</span>` : ''}<div class="tc-ur-title"><h2 id="skill-update-title">Update ${name()}</h2><div class="tc-ur-meta">${icon('git-branch')}<code title="${source()}">${source()}</code>${view.data ? html`<span>·</span>${view.data.sourceInfo?.ref || 'default branch'}${view.data.sourceInfo?.commit ? html`<span>·</span><code title="${view.data.sourceInfo.commit}">${view.data.sourceInfo.commit.slice(0, 7)}</code>` : ''}${!media.matches ? html`<span>·</span><span title="${M.absTime(view.data.createdAt)}">Fetched ${M.relTime(view.data.createdAt, Date.now())}</span>` : ''}` : ''}</div></div>
        ${view.queue.length > 1 ? html`<span class="tc-ur-queue"><span><strong>${view.index + 1}</strong> of ${view.queue.length} updates</span>${next() ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-update-next aria-label="Skip to ${next().row.name}"${disabled(busy())}>${icon('chevron-right')}</button>` : ''}</span>` : ''}<button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-update-close aria-label="Close skill update">${icon('x')}</button></div>`;
      const review = () => html`${header()}${view.phase === 'loading' ? html`<div class="tc-ur-loading" role="status"><span class="tc-spinner" aria-hidden="true"></span><strong>Downloading ${source()}</strong><span>Comparing its files with this installation…</span></div>`
        : media.matches ? html`<div class="tc-pur-body">${facts()}${(view.data.warnings || []).map(text => html`<div class="tc-notice tc-notice--info"><div class="tc-notice-body">${text}</div></div>`)}${localEdits()}${accordion()}</div><div class="tc-pur-foot">${consent()}<button class="tc-btn tc-btn--primary tc-btn--block" type="button" data-update-save${disabled(view.data.localChanges && !view.consent)}>${actionLabel()}</button></div>`
          : html`${facts()}${(view.data.warnings || []).map(text => html`<div class="tc-notice tc-notice--info tc-ur-edits"><div class="tc-notice-body">${text}</div></div>`)}${localEdits()}<div class="tc-ur-body">${fileOptions()}${filePane()}</div><div class="tc-ur-foot">${consent()}<span class="tc-spacer"></span><span class="tc-ur-foot-note">Applies to new sessions. Availability settings stay.</span><button class="tc-btn" type="button" data-update-close>Cancel</button><button class="tc-btn tc-btn--primary" type="button" data-update-save${disabled(view.data.localChanges && !view.consent)}>${actionLabel()}</button></div>`}`;
      const stateCopy = () => {
        if (view.phase === 'saving') return { title: 'Updating ' + name() + '…', tone: 'idle', body: html`Replacing the files in <code>${path(view.data.target.directory)}</code> for ${recipients()}. This usually takes a few seconds.` };
        if (view.phase === 'updated') return { title: name() + ' is updated', icon: 'check', tone: 'ok', body: recipients() + (readers().detected.length === 1 ? ' gets' : ' get') + ' the new version in their next session. Availability settings were kept.' };
        if (view.phase === 'current') return { title: name() + ' is up to date', icon: 'circle-check', tone: 'idle', body: html`Its files match <code>${source()}</code> on ${view.data.sourceInfo?.ref || 'the default branch'}${view.data.sourceInfo?.commit ? html` at <code title="${view.data.sourceInfo.commit}">${view.data.sourceInfo.commit.slice(0, 7)}</code>` : ''}. There’s nothing to update.` };
        if (view.phase === 'expired') return { title: 'This review is out of date', icon: 'hourglass', tone: 'warn', body: html`${view.message || name() + ' changed on disk, or 10 minutes passed since you opened the review.'} Nothing was replaced. Review it again to see the current changes.` };
        if (view.phase === 'uncertain') return { title: 'We couldn’t confirm the update', icon: 'wifi-off', tone: 'warn', body: 'The connection dropped before the result came back, so the update may have finished. Checking asks for the result of this same update; it never starts a new one.' };
        if (view.phase === 'result-expired') return { title: 'The update result is no longer available', icon: 'hourglass', tone: 'warn', body: 'The saved result expired. The original update may have finished. Review the installation in the library to see its current files.' };
        if (view.phase === 'write-error') return { title: 'Couldn’t update ' + name(), icon: 'triangle-alert', tone: 'danger', body: view.message + ' Review this installation again before retrying.' };
        return { title: view.code === 'unavailable' ? 'Couldn’t download ' + source() : 'Couldn’t prepare the review', icon: 'triangle-alert', tone: 'danger', body: view.message + ' Nothing on disk changed.' };
      };
      const compactState = () => {
        const copy = stateCopy(), following = next(), completed = view.phase === 'updated' || view.phase === 'current';
        return html`<div class="tc-dialog-body"><span class="tc-state-mark" data-tone="${copy.tone}" aria-hidden="true">${saving() ? html`<span class="tc-spinner"></span>` : icon(copy.icon)}</span><h2 class="tc-dialog-title" id="skill-update-title" tabindex="-1">${copy.title}</h2><p class="tc-dialog-desc">${copy.body}</p>
          ${view.phase === 'updated' ? html`${view.result.warning ? html`<div class="tc-notice tc-notice--warn"><div class="tc-notice-body">${view.result.warning}</div></div>` : ''}<ul class="tc-state-list">${changed().map(file => html`<li data-status="${file.status}">${icon(fileIcon(file))}<code>${file.name}</code><span class="end">${({ added: 'Added', modified: 'Changed', removed: 'Removed' })[file.status]}</span></li>`)}</ul>` : view.phase === 'current' ? html`<ul class="tc-state-list"><li>${icon('folder')}<code title="${view.data.target.directory}">${path(view.data.target.directory)}</code><span class="end">${M.plural(view.data.changes.length, 'file')}</span></li><li>Local edits since install<span class="end">${view.data.localChanges ? 'Yes, kept' : 'None'}</span></li></ul>` : ''}</div>
          <div class="tc-dialog-foot">${saving() ? html`<button class="tc-btn tc-btn--primary" type="button" disabled>Updating…</button>`
            : completed ? html`${following ? html`<button class="tc-btn" type="button" data-update-show>${view.phase === 'updated' ? 'Done' : 'Close'}</button><button class="tc-btn tc-btn--primary" type="button" data-update-next data-update-primary>Review ${following.row.name}</button>` : html`<button class="tc-btn tc-btn--primary" type="button" data-update-show data-update-primary>${view.phase === 'updated' ? 'Done' : 'Close'}</button>`}`
              : view.phase === 'result-expired' ? html`<button class="tc-btn" type="button" data-update-close>Close</button><button class="tc-btn tc-btn--primary" type="button" data-update-show data-update-primary>Show in library</button>`
                : html`<button class="tc-btn" type="button" data-update-close>${view.phase === 'expired' ? 'Cancel' : 'Close'}</button><button class="tc-btn tc-btn--primary" type="button" ${view.phase === 'uncertain' ? raw('data-update-retry') : raw('data-update-review')} data-update-primary>${view.phase === 'uncertain' ? 'Check result' : view.phase === 'prepare-error' ? 'Try again' : 'Review again'}</button>`}</div>`;
      };
      const load = async () => {
        if (saving()) return;
        const generation = ++view.generation, prior = view.data?.previewId;
        clearTimeout(view.timer); clearTimeout(view.savedTimer); cancelStats();
        view.data = null; view.result = null; view.consent = false; view.saved = false; view.code = null;
        view.file = null; view.side = 'changes'; view.folds.clear(); view.diffs.clear(); view.showUnchanged = false;
        phase('loading');
        await discard(prior);
        if (!alive() || generation !== view.generation) return;
        const response = await request('/context/skills/update/preview', { body: { provider: view.provider, id: view.id } });
        if (!alive() || generation !== view.generation) { await discard(response.data?.previewId); return; }
        if (!response.ok) { view.code = response.data?.code || response.code; phase('prepare-error', response.error || 'The source could not be read.'); return; }
        view.data = response.data;
        for (const file of view.data.changes) if (file.name === 'SKILL.md' && file.status !== 'unchanged' && !Object.hasOwn(file, 'text')) file.text = view.data.markdown;
        view.file = changed()[0]?.name || null;
        if (!view.data.canUpdate) { phase('current'); return; }
        const duration = Math.max(0, Math.min(600000, view.data.expiresAt - Date.now()));
        if (!duration) { phase('expired'); return; }
        view.timer = setTimeout(() => { if (alive() && view.phase === 'review') { view.consent = false; phase('expired'); } }, duration);
        phase('review'); warmStats();
      };
      const advance = async () => {
        if (busy() || view.phase === 'uncertain') return;
        const following = next(); if (!following) return;
        view.index = following.index; view.row = following.row; view.provider = following.row.provider; view.id = following.row.byProvider[view.provider].id;
        await load();
      };
      const save = async () => {
        const retry = view.phase === 'uncertain';
        if (busy() || !view.data || !retry && (view.phase !== 'review' || view.data.localChanges && !view.consent)) return;
        clearTimeout(view.timer); phase('saving');
        const response = await request('/context/skills/update', { body: { previewId: view.data.previewId, planId: view.data.planId, replace: true } });
        if (!alive()) return;
        const result = response.data?.results?.[0];
        if (response.ok && result?.status === 'installed') {
          view.result = result; phase('updated');
          await refresh(); if (alive()) paint();
        } else if (response.ok && result?.status !== 'failed' || !response.ok && (!response.status || response.status >= 500)) phase('uncertain');
        else if (response.status === 409) { view.consent = false; phase(retry ? 'result-expired' : 'expired', response.error); }
        else { view.consent = false; phase('write-error', response.error || result?.error || 'The update could not be verified.'); }
      };
      const selectFile = (file, toggle = false) => {
        if (view.phase !== 'review') return;
        view.file = toggle && view.file === file ? null : file;
        view.side = 'changes'; view.folds.clear(); paint();
        if (view.file) Kit.announce('Showing changes in ' + view.file);
      };
      const beforeUnload = event => { if (saving()) { event.preventDefault(); event.returnValue = ''; } };
      const resized = () => paint();
      view.layer = Kit.open({ kind: 'center', returnTo: document.activeElement,
        panel: { class: panelClass(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-update-title' },
        focus: '[data-update-close]', backdrop: 'ignore', onEscape: close, render: () => compact() ? compactState() : review(),
        onClose: () => { clearTimeout(view.timer); clearTimeout(view.savedTimer); cancelStats(); media.removeEventListener('change', resized); window.removeEventListener('beforeunload', beforeUnload); if (active === view) active = null; void discard(view.data?.previewId); } });
      media.addEventListener('change', resized); window.addEventListener('beforeunload', beforeUnload);
      view.layer.panel.addEventListener('change', event => {
        if (event.target.hasAttribute('data-update-consent') && view.phase === 'review') { view.consent = event.target.checked; paint(); }
      });
      view.layer.panel.addEventListener('keydown', event => {
        const option = event.target.closest('[data-update-file-list] [data-update-file]');
        if (!option || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const files = changed(), at = files.findIndex(file => file.name === option.dataset.updateFile);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? files.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + files.length) % files.length;
        selectFile(files[index].name);
        view.layer.panel.querySelector('[data-update-file-list] [data-update-file="' + CSS.escape(files[index].name) + '"]')?.focus({ preventScroll: true });
      });
      view.layer.panel.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.hasAttribute('data-update-close')) close();
        else if (button.hasAttribute('data-update-review')) void load();
        else if (button.hasAttribute('data-update-save') || button.hasAttribute('data-update-retry')) void save();
        else if (button.hasAttribute('data-update-next')) void advance();
        else if (button.hasAttribute('data-update-file')) selectFile(button.dataset.updateFile, media.matches);
        else if (button.hasAttribute('data-update-side')) { view.side = button.dataset.updateSide; paint(); }
        else if (button.hasAttribute('data-update-fold')) { const id = button.dataset.updateFold; if (view.folds.has(id)) view.folds.delete(id); else view.folds.add(id); paint(); }
        else if (button.hasAttribute('data-update-more')) { view.showUnchanged = true; paint(); }
        else if (button.hasAttribute('data-update-copy')) Kit.copy(view.data.target.directory, button, 'Skill folder path copied');
        else if (button.hasAttribute('data-update-download') && downloadMarkdown) {
          downloadMarkdown('SKILL.md', view.data.markdown.before); view.saved = true; paint();
          clearTimeout(view.savedTimer); view.savedTimer = setTimeout(() => { if (alive()) { view.saved = false; paint(); } }, 1600);
        } else if (button.hasAttribute('data-update-show')) {
          if (view.phase === 'current') { close(); return; }
          const key = view.data.target.resolvedDirectory + '/SKILL.md';
          view.layer.close('library'); showInLibrary(key);
        }
      });
      void load();
    };
    return { open, close };
  };
  return { create };
})();
