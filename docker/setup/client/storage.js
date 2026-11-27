// Storage composition and interactions. Polling only updates the page; open
// reviews and preference drafts live in Kit's separate overlay layer.
const T3StorageUI = (() => {
  'use strict';
  const M = T3Model;
  const { html, raw, icon, cx } = Kit;
  const disabled = (value) => value ? raw(' disabled') : '';

  const create = ({ api, getStatus, reload, render }) => {
    let expanded = false, requesting = false, pending = null, error = null;
    let lastToast = null;
    const toast = (message, options) => {
      lastToast?.close();
      // Completed work is also shown on the card. Keep that feedback from
      // covering the controls of a storage dialog someone is editing.
      if (document.querySelector('.tc-layer:not([data-closing]) .tc-storage-settings, .tc-layer:not([data-closing]) .tc-storage-review, .tc-layer:not([data-closing]) .tc-storage-cleanup')) return;
      lastToast = Kit.toast(message, options);
    };
    const view = () => M.storageView(getStatus(), Date.now());
    const busy = () => requesting || pending || view().busy;
    const observe = (storage) => {
      cleanup.observe(storage);
      const latest = storage && storage.operation;
      const op = latest && (latest.id === pending ? latest : (latest.recent || []).find((item) => item.id === pending));
      if (!pending || !op || op.id !== pending || op.state === 'running') return;
      pending = null;
      if (op.state === 'succeeded') {
        toast(op.ids && op.ids.includes('versions') ? 'Older versions trimmed' : 'Caches cleared', {
          detail: op.removedCount !== undefined ? M.plural(op.removedCount, 'version') + ' removed. Current and required versions are kept.'
            : M.formatBytes(op.removedCacheBytes ?? op.reclaimedBytes ?? 0) + ' of cached data removed. Shared files can remain allocated.',
        });
      } else {
        error = op.error || 'Cleanup did not finish. Refresh and try again.';
        toast('Cleanup needs attention', { tone: 'danger', detail: error });
      }
    };

    const run = async (route, body) => {
      if (busy()) return { ok: false, status: 409, data: { code: 'busy' }, error: 'Another storage operation is running. Check again when it finishes.' };
      requesting = true; error = null; render();
      const result = await api(route, { body });
      requesting = false;
      if (result.ok && result.status === 202) pending = result.data.operation.id;
      else if (!result.ok) { error = result.error; toast('Cleanup needs attention', { tone: 'danger', detail: error }); }
      else toast('Storage updated');
      await reload(); render();
      return result;
    };

    const cleanup = T3StorageReview.create({ api, run, view, isBusy: busy });
    const settings = T3StoragePreferences.create({ api, view, reload, saved: () => toast('Maintenance preferences saved') });
    const preferences = () => { lastToast?.close(); settings.open(); };
    const clean = (id) => { lastToast?.close(); if (id === 'operation') cleanup.inspect(view().operation); else cleanup.open(id === 'all' ? view().cacheRows.map((row) => row.id) : [id]); };
    const cacheMark = (row) => row.icon && T3C.agentMarks[row.icon] ? raw(T3C.agentMark(row.icon)) : icon(T3C.icons[row.icon] ? row.icon : 'hard-drive');

    const refresh = async () => {
      if (view().refreshing || busy()) return;
      error = null;
      const result = await api('/storage/refresh', { body: {} });
      if (!result.ok) error = result.error;
      await reload(); render();
    };

    const reviewVersions = async () => {
      if (busy()) return;
      lastToast?.close();
      let plan = null, failure = null, includePrevious = false, request = 0;
      const contents = () => html`
        <div class="tc-dialog-body">
          <h2 class="tc-dialog-title" id="storage-review-title">Review older tool versions</h2>
          <p class="tc-dialog-desc">Current versions, project requirements, provider selections, and running tools are protected.</p>
          <label class="tc-storage-previous"${includePrevious ? raw(' data-danger') : ''}>
            <input class="tc-checkbox" type="checkbox" data-storage-previous${includePrevious ? raw(' checked') : ''} aria-labelledby="storage-previous-label" aria-describedby="storage-previous-help">
            <span><span class="tc-row-name" id="storage-previous-label">Also remove previous versions</span><span class="tc-hint" id="storage-previous-help">Removes local rollback copies. You’ll need to reinstall them to switch back. This applies only to this cleanup.</span></span>
          </label>
          ${!plan && !failure ? html`<div class="tc-storage-review-loading" role="status"><span class="tc-spinner" aria-hidden="true"></span>Checking installed versions…</div>` : ''}
          ${failure ? html`<div class="tc-storage-review-error"><p class="tc-hint tc-hint--err" role="alert">${failure}</p><button class="tc-btn tc-btn--sm" type="button" data-storage-retry>${icon('refresh-cw')}Try again</button></div>` : ''}
          ${plan ? html`
            <div class="tc-storage-review-summary" role="status"><strong>${plan.removableCount ? M.plural(plan.removableCount, 'version') + ' can be removed' : 'No older versions to remove'}</strong><span class="tc-small tc-muted">${plan.removableCount ? 'Approximately ' + M.formatBytes(plan.estimatedBytes) + ' reclaimable' : includePrevious ? 'All remaining versions are current or required.' : 'Current, previous, and required versions are kept.'}</span></div>
            ${plan.warning ? html`<p class="tc-hint tc-hint--err" role="alert">${plan.warning}</p>` : ''}
            ${plan.items.length ? html`<div class="tc-storage-version-list" role="list" aria-label="Installed versions">${[...plan.items].sort((a, b) => Number(b.eligible) - Number(a.eligible)).map((item) => html`
              <div class="tc-storage-version" role="listitem"><div><span class="tc-row-name">${item.name}</span><span class="tc-mono tc-small">${item.version}</span></div><span class="${cx('tc-small', item.eligible ? 'tc-storage-removable' : 'tc-muted')}">${item.eligible ? 'Remove' : item.reason}</span></div>`)}</div>` : ''}` : ''}
        </div>
        <div class="tc-dialog-foot"><button class="tc-btn tc-btn--ghost" type="button" data-storage-cancel>Cancel</button><button class="${cx('tc-btn', includePrevious ? 'tc-btn--danger-solid' : 'tc-btn--primary')}" type="button" data-storage-trim${disabled(!plan || plan.warning || !plan.removableCount)}>${includePrevious ? 'Remove' : 'Trim'} ${plan && plan.removableCount ? M.plural(plan.removableCount, 'version') : 'older versions'}</button></div>`;
      const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-storage-review', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'storage-review-title' }, focus: '[data-storage-cancel]', render: contents });
      const review = async () => {
        const seq = ++request, mode = includePrevious;
        plan = null; failure = null; layer.render();
        const result = await api('/storage/versions' + (mode ? '?includePrevious=true' : ''));
        if (layer.closed || seq !== request) return;
        if (!result.ok || !result.data || result.data.ok === false || !Array.isArray(result.data.items)
          || Boolean(result.data.includePrevious) !== mode) {
          failure = result.error || result.data?.error || 'Older versions could not be checked. Try again.';
        } else plan = result.data;
        layer.render();
      };
      layer.panel.addEventListener('change', (event) => {
        if (!event.target.matches('[data-storage-previous]')) return;
        includePrevious = event.target.checked;
        void review();
      });
      layer.panel.addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.target.closest('[data-storage-trim]')) event.preventDefault(); });
      layer.panel.addEventListener('click', async (event) => {
        if (event.target.closest('[data-storage-cancel]')) layer.close('cancel');
        if (event.target.closest('[data-storage-retry]')) void review();
        if (event.target.closest('[data-storage-trim]') && plan && !plan.warning && plan.removableCount) {
          layer.close('confirmed'); await run('/storage/versions/prune', { token: plan.token, includePrevious });
        }
      });
      await review();
    };

    // A section like every page's: its label, its card, and its own action.
    const part = (id, title, body, action) => html`<section class="tc-section" aria-labelledby="${id}" data-key="${id}">
      <div class="tc-section-head"><h2 class="tc-section-title" id="${id}">${title}</h2>${action ? html`<div class="tc-section-actions">${action}</div>` : ''}</div>${body}</section>`;

    const content = () => {
      const current = view(), running = busy(), disk = current.disk, op = current.operation;
      const statusError = error || current.policyError || current.error;
      const cacheCount = current.cacheRows.length, readyCount = current.cacheRows.filter((row) => row.canClean).length;
      const awaitingScan = current.backgroundScansEnabled === false && current.loading && !current.refreshing;
      const cacheOperation = op?.ids?.some((id) => id !== 'versions') ? op : null;
      const completed = cacheOperation?.completedIds?.length || 0;
      const checked = current.checked;
      const refreshControl = html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-cmd="storage.refresh" data-key="storage-refresh" aria-label="Measure storage again"${disabled(current.refreshing || running)}>${current.refreshing ? html`<span class="tc-spinner" aria-hidden="true"></span>` : icon('refresh-cw', 'tc-icon--sm')}<span>${current.refreshing ? 'Measuring…' : 'Refresh'}</span></button>`;
      return html`<div class="tc-storage" data-key="storage-card">
        ${part('storage-disk-title', 'Disk space', html`<div class="tc-group"><div class="tc-storage-disk">
          <div class="tc-storage-disk-head"><div><span class="tc-storage-number">${disk ? disk.available : '—'}</span><span class="tc-storage-of"> available</span></div><span class="tc-small tc-muted">${disk ? disk.used + ' of ' + disk.total + ' used' : current.loading ? 'Reading filesystem space…' : 'Filesystem usage unavailable'}</span></div>
          ${disk ? html`<div class="tc-progress tc-storage-meter" role="meter" aria-label="Disk used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${disk.usedPercent}" aria-valuetext="${disk.usedPercent}% used" style="--value:${disk.usedPercent}%;--storage-tone:var(--${disk.tone === 'danger' ? 'danger' : disk.tone === 'warn' ? 'warn' : 'info'})"><span></span></div>` : ''}
          ${disk && (disk.tone === 'warn' || disk.tone === 'danger') ? html`<p class="tc-storage-disk-warning" data-tone="${disk.tone}">${icon('circle-alert', 'tc-icon--sm')}${disk.title}. Review caches and older tool versions below.</p>` : ''}
          <div class="tc-storage-disk-meta"><span>Shared with the host and other containers</span><span>${checked}</span></div>
        </div></div>`, refreshControl)}
        ${current.progress || requesting || pending ? html`<div class="tc-group tc-storage-active" role="status"><span class="tc-spinner" aria-hidden="true"></span><div><strong>${current.progress || 'Starting cleanup…'}</strong><span>${cacheOperation?.state === 'running' ? completed + ' of ' + cacheOperation.ids.length + ' caches complete' : 'The reviewed selection is being checked.'}</span></div>${cacheOperation?.state === 'running' ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="storage.clean" data-id="operation" data-key="storage-operation">Details</button>` : ''}</div>` : ''}
        ${statusError ? html`<div class="tc-storage-notice tc-storage-notice--danger" role="alert">${icon('triangle-alert')}<div><strong>Storage needs attention</strong><p>${statusError}</p><button class="tc-btn tc-btn--sm" type="button" data-cmd="storage.refresh"${disabled(current.refreshing || running)}>Check again</button></div></div>` : ''}
        <div class="tc-storage-layout">${part('storage-cache-title', 'Tool caches', html`<div class="tc-group">
          ${awaitingScan ? '' : html`<div class="tc-storage-cache-summary"><span>${current.loading ? 'Reading tool caches' : readyCount ? M.plural(readyCount, 'cache') + ' available for review' : 'No caches need cleanup'}</span><span class="tc-small tc-muted">${cacheCount ? M.formatBytes(current.cacheBytes) + ' cached in total' : ''}</span></div>`}
          <div class="tc-list">${cacheCount ? current.cacheRows.map((row) => html`<div class="tc-row tc-row--compact tc-storage-cache-row" data-key="storage-${row.id}" data-state="${row.state}">
            <span class="tc-tile tc-tile--sm" aria-hidden="true">${cacheMark(row)}</span>
            <div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">${row.label}</span></div><span class="tc-storage-cache-caption">${row.state === 'protected' ? html`${icon('shield-check', 'tc-icon--sm')}<span>${row.stateLabel}</span>` : row.state === 'empty' ? 'No cached data' : row.description}</span></div>
            <div class="tc-storage-cache-size"><span>${row.size}</span>${row.state === 'ready' && row.id === 'uv' ? html`<span class="tc-small tc-muted">Unused only</span>` : ''}</div>
            <div class="tc-row-actions"><button class="${cx('tc-btn', 'tc-btn--sm', !row.canClean && 'tc-btn--ghost')}" type="button" data-cmd="storage.clean" data-id="${row.id}" data-key="storage-clean-${row.id}" aria-label="${row.canClean ? 'Review' : 'Details for'} ${row.label}"${disabled(running || current.refreshing || current.loading)}>${row.canClean ? 'Review' : 'Details'}</button></div></div>`)
            : html`<div class="tc-storage-empty" role="status">${current.error ? html`${icon('circle-alert')}<span>Cache sizes could not be read. Use Refresh to try again.</span>`
              : awaitingScan ? html`<span>Choose Refresh to measure tool caches.</span>`
              : html`<span class="tc-spinner" aria-hidden="true"></span><span>Measuring tool caches…</span>`}</div>`}</div>
          <div class="tc-card-foot">${icon('shield-check', 'tc-icon--sm')}<span>Cleanup checks each location and keeps shared dependencies. You review the selection first.</span></div>
        </div>`)}
        <div class="tc-storage-secondary">${part('storage-maintenance-title', 'Maintenance', html`<div class="tc-group"><div class="tc-list">
          <div class="tc-row tc-row--compact"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('clock')}</span><div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">Automatic cache cleanup</span><span class="tc-badge">${current.policy.automatic ? 'On' : 'Off'}</span></div><span class="tc-status-text">${current.policy.automatic ? 'Runs after 10 quiet minutes for ' + M.plural(current.policy.automaticCaches?.length || 0, 'selected cache') + '.' : 'Clean caches manually, or choose what can run in the background.'}</span></div><div class="tc-row-actions"><button class="tc-btn tc-btn--sm" type="button" data-cmd="storage.preferences" data-key="storage-preferences">Configure</button></div></div>
          <div class="tc-row tc-row--compact" data-key="storage-versions"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('history')}</span><div class="tc-row-main"><span class="tc-row-name">Older tool versions</span><span class="tc-status-text">${current.policy.retainManagedVersions ? 'Trimmed after verified updates. Current, previous and required versions stay.' : 'Kept until you review them. Current and required versions are protected.'}</span></div><div class="tc-row-actions"><button class="tc-btn tc-btn--sm" type="button" data-cmd="storage.versions" data-key="storage-review"${disabled(running)}>Review</button></div></div>
        </div></div>`)}
        ${part('storage-folders-title', 'Container data', html`<div class="tc-group"><button class="tc-storage-disclosure" type="button" data-cmd="storage.details" data-key="storage-details" aria-expanded="${String(expanded)}" aria-controls="storage-data"><span>Folder sizes</span><span class="tc-small tc-muted">${expanded ? 'Hide details' : 'Show details'}</span>${icon('chevron-down')}</button>
          <div id="storage-data" class="tc-storage-data"${expanded ? '' : raw(' hidden')}>
            ${current.dataRows.map((row) => html`<div class="tc-storage-data-row" data-key="storage-data-${row.id}"><div><span class="tc-row-name">${row.label}</span><span class="tc-storage-path tc-mono" title="${row.path}">${row.path}</span></div><span class="tc-storage-size">${row.size}</span>${['workspace','history','backups'].includes(row.id)?html`<a class="tc-btn tc-btn--ghost tc-btn--sm" href="${row.id==='workspace'?'#files':'#files/path/'+row.path.split('/').map(encodeURIComponent).join('/')}" aria-label="Open ${row.label} in Files">${icon('folder-open')}Open in Files</a>`:''}</div>`)}
            <p class="tc-hint tc-storage-data-note">Folder sizes are estimates. Projects, agent profiles and backups are managed separately from tool caches.</p>
          </div></div>`)}
        </div></div>
        ${op && op.state !== 'running' ? html`<div class="tc-storage-last"><span aria-hidden="true">${icon(op.state === 'succeeded' ? 'circle-check' : 'triangle-alert', 'tc-icon--sm')}</span><span>${op.ids?.includes('versions') ? op.state === 'succeeded' ? M.plural(op.removedCount || 0, 'older version') + ' removed' : 'Version cleanup needs attention' : op.state === 'succeeded' ? M.formatBytes(op.removedCacheBytes ?? op.reclaimedBytes ?? 0) + ' of cached data removed' : 'Cache cleanup needs attention'}${op.finishedAt ? ' · ' + M.relTime(op.finishedAt, Date.now()) : ''}</span>${cacheOperation ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="storage.clean" data-id="operation" data-key="storage-operation">View result</button>` : ''}</div>` : ''}
      </div>`;
    };

    const actions = () => {
      const current = view();
      return html`<button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="storage.clean" data-id="all" data-key="storage-clean-all"${disabled(busy() || current.loading || current.refreshing || !current.cacheRows.length)}>Review cleanup${icon('arrow-right', 'tc-icon--sm')}</button>`;
    };
    return { content, actions, observe, clean, refresh, preferences, reviewVersions,
      toggle: () => { expanded = !expanded; render(); },
      isBusy: () => busy() || view().refreshing,
    };
  };
  return { create };
})();
