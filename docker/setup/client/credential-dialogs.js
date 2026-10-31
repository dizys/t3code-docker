const T3CredentialDialogs = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3CredentialModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const create = ctx => {
    let active = null;
    const removing = new Set();
    const remove = async id => {
      const profile = ctx.row(id); if (!profile || ctx.busy.has(id) || removing.has(id)) return;
      removing.add(id);
      try {
        const yes = await Kit.confirm({ title: 'Delete ' + id + '?', body: html`Skills that call <code>${(profile.type === 'ssh' ? 't3-ssh ' : 't3-api ') + id}</code> fail until a credential with this name exists again.`,
          consequences: [
            { icon: 'book-open', text: profile.usedIn?.length ? 'Mentioned in ' + M.listOf(profile.usedIn.map(item => item.name)) : ctx.usageWarnings()?.length ? 'Some skills couldn’t be read; there may be mentions.' : 'Not used in a skill' },
            ...(ctx.usageWarnings()?.length && profile.usedIn?.length ? [{ icon: 'info', text: 'Some skills couldn’t be read; there may be other mentions.' }] : []),
            { icon: 'key-round', text: 'The saved ' + S.secretKind(profile) + ' is erased from this server' },
            { icon: 'archive', text: 'Backups of this volume still hold it' },
            ...(profile.type === 'ssh' ? [{ icon: 'shield-alert', text: 'Its trusted host key is forgotten' }] : []),
          ], confirm: 'Delete credential', tone: 'danger' });
        if (!yes) return;
        const response = await ctx.request(id, 'remove', '/credentials/remove', { id, revision: profile.revision });
        if (response?.ok) { ctx.deleted(id); Kit.toast(id + ' deleted'); }
        else if (response) Kit.toast('Couldn’t delete ' + id, { tone: 'danger', detail: response.error });
      } finally { removing.delete(id); }
    };
    const forget = async id => {
      if (ctx.busy.has(id)) return;
      const yes = await Kit.confirm({ title: 'Forget ' + id + '’s host key?', body: 'Agents will be blocked from connecting until you review and trust the server’s key again.', confirm: 'Forget host key', tone: 'danger' });
      if (!yes) return;
      const response = await ctx.request(id, 'forget', '/credentials/forget-host-key', { id });
      if (response?.ok) Kit.toast('Forgot ' + id + '’s host key');
    };
    const review = async id => {
      let profile = ctx.row(id); if (!profile || ctx.busy.has(id) || active) return;
      const view = { id, busy: false, scanned: null, error: null, changedAgain: false, stale: false }; active = view;
      const close = reason => { if (view.busy) { Kit.announce('Wait for the host-key check to finish.'); return false; } view.layer.close(reason); return true; };
      const changed = () => view.scanned?.state === 'changed';
      const paint = () => { if (active === view) view.layer.render(); };
      const scan = async () => {
        if (view.busy) return;
        const current = ctx.row(id); if (current) profile = current;
        view.scanned = null; view.stale = false; view.changedAgain = false; view.busy = true; view.error = null; paint();
        const response = await ctx.request(id, 'scan', '/credentials/scan', { id, revision: profile.revision }, { refresh: false });
        if (active !== view) return;
        view.busy = false;
        if (['changed', 'gone', 'not-found'].includes(response?.data?.code)) { view.stale = true; view.error = 'The saved connection details changed. Review the current host before trusting a key.'; }
        else if (!response?.ok || !response.data.hostKey) view.error = response?.data?.result ? S.state({ ...profile, hostKey: profile.hostKey || {}, test: response.data.result }).desc : response?.error || 'Couldn’t read this server’s host key. Try again.';
        else view.scanned = response.data.hostKey;
        paint(); view.layer.panel.querySelector('[data-cred-key="cancel"]')?.focus({ preventScroll: true });
      };
      view.layer = Kit.open({ kind: 'center', backdrop: 'ignore', panel: { class: 'tc-dialog tc-cred-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'cred-key-title', 'aria-describedby': 'cred-key-desc' }, focus: '[data-cred-key="cancel"]', onEscape: () => close('escape'), onClose: () => { if (active === view) active = null; }, render: () => html`
        <div class="tc-dialog-body"><h2 class="tc-dialog-title" id="cred-key-title">${changed() ? id + '’s host key changed' : 'Trust ' + profile.host + '’s host key?'}</h2><p class="tc-dialog-desc" id="cred-key-desc">${changed() ? profile.host + ' now presents a different key. That’s expected after a reinstall, and also what an interception looks like. Agents can’t connect until you decide.' : 'Compare this fingerprint with the server’s own key before trusting it. No password is sent while the key is being checked.'}</p>
        ${view.busy ? html`<p class="tc-hint" role="status"><span class="tc-spinner" aria-hidden="true"></span>${view.scanned ? 'Checking the key again before trusting it…' : 'Reading the server’s host key…'}</p>` : ''}
        ${view.scanned ? html`<ul class="tc-cred-keys">${view.scanned.trusted ? html`<li><span>Trusted ${profile.hostKey?.trustedAt ? S.day(profile.hostKey.trustedAt) : 'before'}</span><code>${S.keyType(view.scanned.trusted.type)}<br>${view.scanned.trusted.fingerprint}</code></li>` : ''}<li data-tone="warn"><span>Presented now</span><code>${S.keyType(view.scanned.presented.type)}<br>${view.scanned.presented.fingerprint}</code></li></ul><p class="tc-dialog-desc">On the server, this prints its real key:</p><ul class="tc-cred-cmds tc-group"><li><code>${S.keyCommand(view.scanned.presented.type)}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-cred-key="copy" aria-label="Copy host-key comparison command">${icon('copy')}</button></li></ul>` : ''}
        ${view.error ? html`<p class="tc-hint tc-danger" role="alert" tabindex="-1" id="cred-key-error">${view.error}</p>` : ''}${view.changedAgain ? html`<p class="tc-warning" role="alert">The key changed again. Compare this new fingerprint, then choose whether to trust it.</p>` : ''}</div>
        <div class="tc-dialog-foot"><button class="tc-btn tc-btn--ghost" type="button" data-cred-key="cancel"${disabled(view.busy)}>${changed() ? 'Keep blocking' : 'Cancel'}</button>${view.error && (!view.scanned || view.stale) ? html`<button class="tc-btn" type="button" data-cred-key="retry"${disabled(view.busy)}>${view.stale ? 'Review current host' : 'Try again'}</button>` : html`<button class="tc-btn ${changed() ? 'tc-btn--danger-solid' : 'tc-btn--primary'}" type="button" data-cred-key="trust"${disabled(view.busy || !view.scanned || view.stale)}>${view.busy && view.scanned ? html`<span class="tc-spinner" aria-hidden="true"></span>Trusting…` : changed() ? 'Trust new key' : 'Trust key'}</button>`}</div>` });
      view.layer.panel.addEventListener('click', async event => {
        const button = event.target.closest('[data-cred-key]'); if (!button || button.disabled) return;
        const action = button.dataset.credKey;
        if (action === 'cancel') return close('cancel');
        if (action === 'copy') return void Kit.copy(S.keyCommand(view.scanned.presented.type), button);
        if (action === 'retry') { await ctx.refresh(); return void scan(); }
        if (action !== 'trust' || view.busy || !view.scanned) return;
        view.busy = true; view.error = null; view.changedAgain = false; paint();
        const response = await ctx.request(id, 'trust', '/credentials/trust', { id, revision: profile.revision, fingerprint: view.scanned.presented.fingerprint });
        if (active !== view) return; view.busy = false;
        if (response?.ok) { view.layer.close('trusted'); Kit.toast(id + '’s host key trusted'); return; }
        if (['changed', 'gone', 'not-found'].includes(response?.data?.code)) { view.stale = true; view.error = 'The saved connection details changed. Review the current host before trusting a key.'; }
        else if (response?.data?.code === 'key-changed' && response.data.presented) { view.scanned = { ...view.scanned, state: 'changed', presented: response.data.presented }; view.changedAgain = true; }
        else view.error = response?.error || 'The host key could not be trusted. Try again.';
        paint(); (view.layer.panel.querySelector('#cred-key-error') || view.layer.panel.querySelector('[data-cred-key="cancel"]'))?.focus({ preventScroll: true });
      });
      await scan();
    };
    return { remove, forget, review, beforeNavigate: () => !active?.busy };
  };
  return { create };
})();
