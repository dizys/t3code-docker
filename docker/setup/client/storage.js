// Storage composition and interactions. Polling only updates the page; open
// reviews and preference drafts live in Kit's separate overlay layer.
const T3StorageUI = (() => {
  'use strict';
  const M = T3Model;
  const { html, raw, icon, cx } = Kit;
  const disabled = (value) => value ? raw(' disabled') : '';
  const GB = 1_000_000_000;

  const create = ({ api, getStatus, reload, render }) => {
    let expanded = false, requesting = false, pending = null, error = null;
    let lastToast = null;
    const toast = (message, options) => {
      lastToast?.close();
      // Completed work is also shown on the card. Keep that feedback from
      // covering the controls of a storage dialog someone is editing.
      if (document.querySelector('.tc-layer:not([data-closing]) .tc-storage-settings, .tc-layer:not([data-closing]) .tc-storage-review')) return;
      lastToast = Kit.toast(message, options);
    };
    const view = () => M.storageView(getStatus(), Date.now());
    const busy = () => requesting || pending || view().busy;
    const observe = (storage) => {
      const latest = storage && storage.operation;
      const op = latest && (latest.id === pending ? latest : (latest.recent || []).find((item) => item.id === pending));
      if (!pending || !op || op.id !== pending || op.state === 'running') return;
      pending = null;
      if (op.state === 'succeeded') {
        toast(op.ids && op.ids.includes('versions') ? 'Older versions trimmed' : 'Caches cleared', {
          detail: op.removedCount !== undefined ? M.plural(op.removedCount, 'version') + ' removed. Current and required versions are kept.'
            : M.formatBytes(op.reclaimedBytes) + ' freed. Future builds and installs recreate the cache.',
        });
      } else {
        error = op.error || 'Cleanup did not finish. Refresh and try again.';
        toast('Cleanup needs attention', { tone: 'danger', detail: error });
      }
    };

    const run = async (route, body) => {
      if (busy()) return;
      requesting = true; error = null; render();
      const result = await api(route, { body });
      requesting = false;
      if (result.ok && result.status === 202) pending = result.data.operation.id;
      else if (!result.ok) { error = result.error; toast('Cleanup did not start', { tone: 'danger', detail: error }); }
      else toast('Storage updated');
      await reload(); render();
    };

    const clean = async (id) => {
      const current = view();
      const ids = id === 'all' ? current.ids : [id];
      const rows = current.cacheRows.filter((row) => ids.includes(row.id) && row.canClean);
      if (!rows.length || busy() || current.refreshing) return;
      lastToast?.close();
      const amount = rows.reduce((sum, row) => sum + row.bytes, 0);
      const title = rows.length === 1 ? 'Clear ' + (rows[0].id === 'go' ? 'Go build cache' : 'npm downloads') + '?' : 'Clear build and download caches?';
      const confirmed = await Kit.confirm({
        title, body: 'Approximately ' + M.formatBytes(amount) + ' can be freed. These files are recreated when needed.',
        consequences: [
          { icon: 'history', text: 'The next build or package install may take longer.' },
          { icon: 'shield-check', text: 'Project files, sign-ins, conversations, and installed tools are kept.' },
          { icon: 'circle-stop', text: 'Finish any build or package installation first.' },
        ], confirm: 'Clear ' + (rows.length > 1 ? 'caches' : 'cache'), tone: 'primary',
      });
      if (confirmed) await run('/storage/clean', { ids: rows.map((row) => row.id) });
    };

    const refresh = async () => {
      if (view().refreshing || busy()) return;
      error = null;
      const result = await api('/storage/refresh', { body: {} });
      if (!result.ok) error = result.error;
      await reload(); render();
    };

    const preferences = () => {
      lastToast?.close();
      const initial = view().policy;
      const draft = { ...initial };
      let saving = false;
      const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-storage-settings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'storage-settings-title' },
        focus: '[data-storage-cancel]', render: () => html`
          <form id="storage-settings-form" novalidate>
            <div class="tc-dialog-body">
              <h2 class="tc-dialog-title" id="storage-settings-title">Storage maintenance</h2>
              <p class="tc-dialog-desc">Choose what happens in the background. Your projects, conversations, and sign-ins are kept.</p>
              <div class="tc-storage-setting">
                <div><label class="tc-row-name" id="storage-auto-label">Automatic cache cleanup</label><p class="tc-hint" id="storage-auto-help">Clear Go and npm caches over their limits after 10 minutes without build or install activity.</p></div>
                <span class="tc-storage-toggle"><button type="button" class="tc-switch" role="switch" aria-labelledby="storage-auto-label" aria-describedby="storage-auto-help" aria-checked="${String(draft.automatic)}" data-storage-switch="automatic"></button></span>
              </div>
              <div class="tc-storage-budgets">
                <div class="tc-field"><label class="tc-label" for="storage-go-limit">Go cache limit</label><div class="tc-storage-input"><input class="tc-input" type="number" min="0.25" max="500" step="0.25" id="storage-go-limit" value="${draft.goBudgetBytes / GB}" inputmode="decimal" aria-describedby="storage-limit-help"><span>GB</span></div></div>
                <div class="tc-field"><label class="tc-label" for="storage-npm-limit">npm cache limit</label><div class="tc-storage-input"><input class="tc-input" type="number" min="0.25" max="500" step="0.25" id="storage-npm-limit" value="${draft.npmBudgetBytes / GB}" inputmode="decimal" aria-describedby="storage-limit-help"><span>GB</span></div></div>
              </div>
              <p class="tc-hint" id="storage-limit-help">A cache is cleared when it exceeds its limit. The next build or install may take longer.</p>
              <div class="tc-storage-setting tc-storage-setting--border">
                <div><label class="tc-row-name" id="storage-retain-label">Trim older tool versions</label><p class="tc-hint" id="storage-retain-help">After successful updates, keep the current and previous versions, plus versions required by projects, providers, or running tools.</p></div>
                <span class="tc-storage-toggle"><button type="button" class="tc-switch" role="switch" aria-labelledby="storage-retain-label" aria-describedby="storage-retain-help" aria-checked="${String(draft.retainManagedVersions)}" data-storage-switch="retainManagedVersions"></button></span>
              </div>
              <p class="tc-hint tc-hint--err" id="storage-settings-error" role="alert" hidden></p>
            </div>
            <div class="tc-dialog-foot"><button class="tc-btn tc-btn--ghost" type="button" data-storage-cancel>Cancel</button><button class="tc-btn tc-btn--primary" type="submit" data-storage-save>Save preferences</button></div>
          </form>` });
      const panel = layer.panel;
      const message = (text) => { const el = panel.querySelector('#storage-settings-error'); el.textContent = text; el.hidden = !text; };
      panel.addEventListener('click', (event) => {
        if (event.target.closest('[data-storage-cancel]') && !saving) layer.close('cancel');
        const toggle = event.target.closest('[data-storage-switch]');
        if (toggle && !saving) { const key = toggle.dataset.storageSwitch; draft[key] = !draft[key]; toggle.setAttribute('aria-checked', String(draft[key])); }
      });
      panel.querySelector('form').addEventListener('submit', async (event) => {
        event.preventDefault(); if (saving) return;
        const fields = [['#storage-go-limit', 'goBudgetBytes'], ['#storage-npm-limit', 'npmBudgetBytes']];
        for (const [selector, key] of fields) {
          const input = panel.querySelector(selector), value = Number(input.value);
          input.removeAttribute('aria-invalid');
          if (!input.value.trim() || !Number.isFinite(value) || value < 0.25 || value > 500) {
            input.setAttribute('aria-invalid', 'true'); message('Enter a cache limit between 0.25 and 500 GB.'); input.focus(); return;
          }
          draft[key] = Math.round(value * GB);
        }
        saving = true; message('');
        panel.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
        const save = panel.querySelector('[data-storage-save]'); save.textContent = 'Saving…';
        const result = await api('/storage/policy', { body: draft });
        saving = false;
        if (layer.closed) { await reload(); return; }
        if (!result.ok) {
          message(result.error); panel.querySelectorAll('button, input').forEach((el) => { el.disabled = false; }); save.textContent = 'Save preferences'; return;
        }
        layer.close('saved'); toast('Storage preferences saved'); await reload();
      });
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
      const lastRun = op && op.state !== 'running' && !statusError
        ? (op.state === 'succeeded' ? op.removedCount !== undefined ? M.plural(op.removedCount, 'older version') + ' removed' : M.formatBytes(op.reclaimedBytes) + ' freed' : op.error || 'Cleanup didn’t finish')
          + (op.finishedAt ? ' ' + M.relTime(op.finishedAt, Date.now()) : '') : null;
      const trimmedVersions = op && op.removedCount !== undefined;
      const policy = current.policy;
      const refresh = html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cmd="storage.refresh" data-key="storage-refresh" aria-label="Measure again" title="Measure again"${disabled(current.refreshing || running)}>${current.refreshing ? html`<span class="tc-spinner" aria-hidden="true"></span>` : icon('refresh-cw')}</button>`;
      return html`<div class="tc-storage" data-key="storage-card">
        ${part('storage-disk-title', 'Disk', html`<div class="tc-group"><div class="tc-storage-disk">
          <div class="tc-storage-disk-head"><span class="tc-storage-number">${disk ? disk.available : '—'}</span><span class="tc-storage-of">${disk ? 'free of ' + disk.total : current.loading ? 'Measuring…' : 'Not measured yet'}</span>${disk && (disk.tone === 'warn' || disk.tone === 'danger') ? html`<span class="tc-badge tc-badge--${disk.tone}">${disk.usedPercent}% used</span>` : ''}</div>
          ${disk ? html`<div class="tc-progress tc-storage-meter" role="meter" aria-label="Disk used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${disk.usedPercent}" aria-valuetext="${disk.usedPercent}% used" style="--value:${disk.usedPercent}%;--storage-tone:var(--${disk.tone === 'danger' ? 'danger' : disk.tone === 'warn' ? 'warn' : 'info'})"><span></span></div>` : ''}
        </div>
        ${current.progress || requesting || pending ? html`<div class="tc-storage-operation" role="status"><span class="tc-spinner" aria-hidden="true"></span><span>${current.progress || 'Starting cleanup…'}</span><div class="tc-progress" data-indeterminate><span></span></div></div>` : ''}
        ${statusError ? html`<div class="tc-storage-message" role="alert">${icon('triangle-alert')}<span>${statusError}</span></div>` : ''}
        <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>The disk is shared with anything else on it; the sizes below are this container’s.</span></div></div>`, refresh)}
        ${part('storage-cache-title', 'Caches', html`<div class="tc-group">
          <div class="tc-list">${current.cacheRows.length ? current.cacheRows.map((row) => html`<div class="tc-row tc-row--compact" data-key="storage-${row.id}">
            <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(row.id === 'go' ? 'wrench' : 'download')}</span>
            <div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">${row.label}</span><span class="tc-storage-size">${row.size}</span></div><span class="tc-status"><span class="tc-status-text">${row.unavailable || row.description}</span></span></div>
            <div class="tc-row-actions"><button class="tc-btn tc-btn--sm" type="button" data-cmd="storage.clean" data-id="${row.id}" data-key="storage-clean-${row.id}" aria-label="Clear ${row.label}"${disabled(running || current.refreshing || !row.canClean)}>Clear</button></div></div>`)
            : html`<div class="tc-storage-empty" role="status">${current.error ? 'Couldn’t measure the caches. Measure again in a moment.' : html`<span class="tc-spinner" aria-hidden="true"></span>Measuring…`}</div>`}</div>
          <div class="tc-card-foot tc-storage-foot">${icon('info', 'tc-icon--sm')}<span>${policy.automatic ? 'Cleared on their own when one grows past its limit.' : 'Cleared only when you choose.'} Builds and installs fill them again.</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="storage.preferences" data-key="storage-preferences">Settings</button></div>
        </div>`)}
        ${part('storage-versions-title', 'Older tool versions', html`<div class="tc-group"><div class="tc-list"><div class="tc-row tc-row--compact" data-key="storage-versions">
          <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('history')}</span>
          <div class="tc-row-main"><span class="tc-row-name">${policy.retainManagedVersions ? 'Trimmed after each update' : 'Kept until you trim them'}</span><span class="tc-status"><span class="tc-status-text">${trimmedVersions && lastRun ? lastRun + '. ' : ''}Current and required versions stay. Previous versions are kept unless you include them in a manual cleanup.</span></span></div>
          <div class="tc-row-actions"><button class="tc-btn tc-btn--sm" type="button" data-cmd="storage.versions" data-key="storage-review"${disabled(running)}>Review</button></div>
        </div></div></div>`)}
        ${part('storage-folders-title', 'Folders', html`<div class="tc-group">
          <button class="tc-storage-disclosure" type="button" data-cmd="storage.details" data-key="storage-details" aria-expanded="${String(expanded)}" aria-controls="storage-data"><span>${expanded ? 'Hide folder sizes' : 'Show folder sizes'}</span>${icon('chevron-down')}</button>
          <div id="storage-data" class="tc-storage-data"${expanded ? '' : raw(' hidden')}>
            ${current.dataRows.map((row) => html`<div class="tc-storage-data-row" data-key="storage-data-${row.id}"><div><span class="tc-row-name">${row.label}</span><span class="tc-storage-path tc-mono" title="${row.path}">${row.path}</span></div><span class="tc-storage-size">${row.size}</span></div>`)}
            <p class="tc-hint tc-storage-data-note">Projects, backups, agent profiles and other caches are managed elsewhere. Sizes are estimates.</p>
          </div>
        </div>`)}
        ${!trimmedVersions && lastRun ? html`<p class="tc-page-foot tc-storage-last">${icon(op.state === 'succeeded' ? 'check' : 'triangle-alert', 'tc-icon--sm')}${lastRun}.</p>` : ''}
      </div>`;
    };

    // The page's one action: clear what can be cleared.
    const actions = () => {
      const current = view();
      return html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="storage.clean" data-id="all" data-key="storage-clean-all"${disabled(busy() || current.loading || current.refreshing || !current.ids.length)}>Clear caches${current.cleanableBytes ? html` <span class="tc-storage-btn-size">${M.formatBytes(current.cleanableBytes)}</span>` : ''}</button>`;
    };
    return { content, actions, observe, clean, refresh, preferences, reviewVersions,
      toggle: () => { expanded = !expanded; render(); },
      isBusy: () => busy() || view().refreshing,
    };
  };
  return { create };
})();
