const T3CredentialInspector = (() => {
  'use strict';
  const { html, raw, icon } = Kit, S = T3CredentialModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const requestPreview = (profile, short = false) => {
    const lines = S.request(profile, short).split('\n');
    const mask = text => text.split('••••••••').map((part, index) => html`${index ? html`<em>••••••••</em>` : ''}${part}`);
    return html`<pre class="tc-cred-request">${lines.map((line, index) => html`${index ? '\n' : ''}${line.startsWith('GET ') ? html`<b>GET</b> ${mask(line.slice(4))}` : line.startsWith('Host: ') ? html`Host: <u>${line.slice(6)}</u>` : mask(line)}`)}</pre>`;
  };
  const create = ctx => {
    let active = null;
    const close = reason => { active?.layer.close(reason); return true; };
    const repaint = () => {
      if (!active || active.layer.closed) return;
      active.layer.panel.classList.toggle('tc-sheet--bottom', Kit.isPhone()); active.layer.render();
    };
    const open = id => {
      if (active?.id === id) { repaint(); return; }
      close('replaced'); const view = { id, snippetOpen: false }; active = view;
      const row = () => ctx.row(id), busy = () => ctx.busy.has(id);
      const action = (name, label, options = {}) => html`<button class="tc-btn ${options.primary ? 'tc-btn--primary' : options.ghost ? 'tc-btn--ghost' : ''} tc-btn--sm" type="button" data-cred-inspect="${name}"${disabled(busy())}>${options.icon ? icon(options.icon) : ''}${label}</button>`;
      const saved = profile => html`<span class="tc-cred-saved">${icon('lock')}Saved <small>${profile.secretChangedAt ? '· changed ' + S.day(profile.secretChangedAt) : '· from before the upgrade'}</small></span><span class="tc-spacer"></span>${action('replace', 'Replace…', { ghost: true })}`;
      const connection = profile => html`<section class="tc-insp-section"><h3 class="tc-insp-label">Connection</h3><dl class="tc-group tc-pathlist tc-cred-facts">${profile.type === 'ssh' ? html`
        <dt>Host</dt><dd><code>${profile.host}</code></dd><dt>Port</dt><dd><code>${profile.port}</code></dd><dt>Username</dt><dd><code>${profile.username}</code></dd><dt>Password</dt><dd>${saved(profile)}</dd><dt>Host key</dt><dd>${profile.hostKey ? html`<span class="tc-cred-fp"><span class="tc-cred-key-type">${S.keyType(profile.hostKey.type)}</span><span class="tc-cred-fingerprint">${profile.hostKey.fingerprint}</span><small>trusted ${S.day(profile.hostKey.trustedAt)}${profile.hostKey.carried ? ' · carried over' : ''}</small></span>` : html`<span class="tc-muted">Not trusted yet</span><span class="tc-spacer"></span>${action('review', 'Trust…', { ghost: true })}`}</dd>` : html`
        <dt>Base URL</dt><dd><code>${profile.baseUrl}</code></dd><dt>Auth</dt><dd>${profile.authType === 'header' ? 'Header ' + profile.authName : profile.authType === 'query' ? 'Query parameter ' + profile.authName : 'Bearer token'}</dd><dt>${profile.authType === 'bearer' ? 'Token' : 'Key'}</dt><dd>${saved(profile)}</dd><dt>Test with</dt><dd><code>GET ${profile.testPath || 'the base URL'}</code></dd>`}</dl></section>`;
      const bannerActions = profile => {
        const state = S.state(profile, { busy: ctx.busy.get(id)?.kind === 'test' });
        return html`<div class="tc-cred-banner-actions">${state.action.startsWith('Review') ? action('review', 'Review…') : state.action.startsWith('Replace') ? action('replace', 'Replace ' + S.secretKind(profile) + '…') : state.action.startsWith('Edit') ? action('edit', 'Edit…') : ''}${!state.action.startsWith('Review') ? action('test', profile.test ? 'Test again' : 'Test now') : ''}</div>`;
      };
      const banner = profile => {
        const state = S.state(profile, { busy: ctx.busy.get(id)?.kind === 'test' });
        return html`<div class="tc-cred-result"><div class="tc-cred-banner" data-tone="${state.tone}" role="status">${state.icon ? icon(state.icon) : html`<span class="tc-spinner" aria-hidden="true"></span>`}<div><strong>${state.title}</strong>${state.desc ? html`<span>${profile.type === 'api' && profile.test?.ok ? html`<code>GET ${profile.testPath || 'the base URL'}</code> answered HTTP ${profile.test.detail.status} in ${profile.test.ms} ms.` : state.desc}</span>` : ''}</div>${Kit.isPhone() ? '' : bannerActions(profile)}</div>${Kit.isPhone() ? bannerActions(profile) : ''}</div>`;
      };
      const snippet = profile => html`<pre class="tc-cred-snippet">${S.snippet(profile).split('\n').map((line, index) => html`${index ? '\n' : ''}${line.startsWith('t3-ssh ') || line.startsWith('t3-api ') ? html`<b>${line}</b>` : line}`)}</pre>`;
      const use = profile => html`<section class="tc-insp-section"><h3 class="tc-insp-label tc-cred-snippet-head">Use it in a skill<span class="tc-spacer"></span>${action('snippet', 'Copy snippet', { icon: 'copy' })}</h3>${profile.type === 'ssh' ? snippet(profile) : ''}<ul class="tc-group tc-cred-cmds">${S.commands(profile).map((command, index) => html`<li><code>${command}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-cred-inspect="command" data-index="${index}" aria-label="Copy ${index === 0 ? 'command' : 'script command'}">${icon('copy')}</button></li>`)}</ul>${profile.type === 'api' ? html`<details class="tc-cred-snippet-detail" data-key="cred-api-snippet"${view.snippetOpen ? raw(' open') : ''}><summary>Snippet for SKILL.md</summary>${snippet(profile)}</details>` : ''}<p class="tc-hint">${profile.type === 'ssh' ? 'Agents never need the password. Output that repeats it shows [redacted].' : 'Paths are relative to the base URL. JSON bodies go on stdin, up to 1 MiB.'}</p></section>`;
      const usedIn = profile => html`<section class="tc-insp-section"><h3 class="tc-insp-label">Used in<span class="tc-spacer"></span><span class="tc-hint">${S.usageCount(profile, ctx.usageWarnings()?.length > 0)}</span></h3><div class="tc-group">${profile.usedIn?.length ? profile.usedIn.map(item => html`<div class="tc-cred-skill"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('book-open')}</span><div><strong>${item.name}</strong><small>${item.kind === 'instructions' ? 'Shared global instructions' : 'Global skill · ' + item.where}</small></div><a class="tc-btn tc-btn--ghost tc-btn--xs" href="${item.kind === 'instructions' ? '#instructions' : '#instructions/skills'}">Open${icon('chevron-right')}</a></div>`) : html`<div class="tc-empty tc-empty--compact"><p class="tc-hint">${ctx.usageWarnings()?.length ? 'Couldn’t read all skills just now.' : 'Not in a skill yet'}</p></div>`}</div><p class="tc-hint">Skills that mention ${id}, from Instructions & skills.${ctx.usageWarnings()?.length ? ' Some skills couldn’t be read.' : ''}</p></section>`;
      const render = () => {
        const profile = row();
        return html`<div class="tc-insp-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(profile?.type === 'ssh' ? 'terminal' : 'globe')}</span><div class="tc-insp-title"><h2 id="cred-inspect-title" title="${id}">${id}</h2><span class="tc-insp-meta">${profile ? (profile.type === 'ssh' ? 'SSH' : 'API') + ' · ' + S.auth(profile) + ' · added ' + S.day(profile.createdAt) : 'Credential unavailable'}</span></div>${profile ? action('edit', 'Edit', { icon: 'pencil' }) : ''}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cred-inspect="menu" data-key="cred-inspect-menu" aria-haspopup="menu" aria-label="Credential actions"${disabled(!profile || busy())}>${icon('ellipsis')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cred-inspect="close" aria-label="Close credential details">${icon('x')}</button></div><div class="tc-insp-body">${profile ? html`${ctx.errors.get(id) ? html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><strong>Couldn’t complete the action</strong><span class="tc-notice-desc">${ctx.errors.get(id)}</span></div></div>` : ''}${banner(profile)}${connection(profile)}${profile.type === 'api' ? html`<section class="tc-insp-section"><h3 class="tc-insp-label">Every request<span class="tc-spacer"></span><span class="tc-hint">Stays under the base URL · no redirects</span></h3>${requestPreview(profile)}</section>` : ''}${use(profile)}${usedIn(profile)}` : html`<div class="tc-notice tc-notice--danger" role="alert"><div class="tc-notice-body"><strong>This credential isn’t available</strong><span class="tc-notice-desc">${ctx.loadError() || 'It may have been deleted in another window.'}</span></div><button class="tc-btn tc-btn--sm" type="button" data-cred-inspect="retry">Try again</button></div>`}</div>`;
      };
      view.layer = Kit.open({ kind: 'sheet', returnTo: document.activeElement, panel: { class: 'tc-sheet tc-skill-inspector tc-mcp-inspector tc-cred-inspector' + (Kit.isPhone() ? ' tc-sheet--bottom' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cred-inspect-title' }, focus: '[data-cred-inspect="close"]', backdrop: 'ignore', onEscape: () => close('escape'), onClose: reason => { if (active === view) active = null; ctx.inspectorClosed(id, reason); }, render });
      view.layer.panel.addEventListener('toggle', event => { if (event.target.matches('.tc-cred-snippet-detail')) view.snippetOpen = event.target.open; }, true);
      view.layer.panel.addEventListener('click', event => {
        const button = event.target.closest('[data-cred-inspect]'); if (!button || button.disabled) return;
        const action = button.dataset.credInspect, profile = row();
        if (action === 'close') return close('close');
        if (action === 'retry') return void ctx.refresh();
        if (!profile) return;
        if (action === 'menu') return ctx.menu(button, profile, true);
        if (action === 'snippet') return void Kit.copy(S.snippet(profile), button, 'Skill snippet copied');
        if (action === 'command') return void Kit.copy(S.commands(profile)[Number(button.dataset.index)], button, 'Command copied');
        ctx.action(action, id, button);
      });
    };
    return { open, close, repaint, id: () => active?.id || null };
  };
  return { create, requestPreview };
})();
