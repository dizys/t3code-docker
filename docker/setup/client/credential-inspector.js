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
      const saved = (profile, entry) => html`<span class="tc-cred-saved">${icon('lock')}Saved <small>${profile.secretChangedAt ? '· changed ' + S.day(profile.secretChangedAt) : '· from before the upgrade'}</small></span><span class="tc-spacer"></span>${entry?.primary || !entry ? action('replace', 'Replace…', { ghost: true }) : ''}`;
      const factRows = profile => {
        const spec = S.typeOf(profile.type);
        if (spec?.dynamic) return html`${Object.entries(profile.fields || {}).map(([name, value]) => html`<dt>${name}</dt><dd><code>${value}</code></dd>`)}${(profile.secretNames || []).map(name => html`<dt>${name}</dt><dd>${saved(profile)}</dd>`)}`;
        const fields = (spec?.fields || []).filter(entry => entry.kind !== 'derived' && S.applies(entry, profile.fields) && entry.key !== 'authType' && entry.key !== 'authName' && entry.key !== 'authPrefix' && entry.key !== 'auth' && profile.fields[entry.key] !== undefined && profile.fields[entry.key] !== '');
        const auth = profile.fields?.baseUrl ? html`<dt>Auth</dt><dd>${S.kind(profile)}</dd>` : '';
        const secrets = (spec?.secrets || []).filter(entry => profile.secretNames?.includes(entry.key));
        return html`${fields.map(entry => html`<dt>${entry.key === 'testPath' ? 'Test with' : entry.label}</dt><dd><code>${entry.key === 'testPath' ? 'GET ' + profile.fields.testPath : profile.fields[entry.key]}</code></dd>`)}${auth}${secrets.map(entry => html`<dt>${entry.label}</dt><dd>${saved(profile, entry)}</dd>`)}`;
      };
      const hostKeyRow = profile => profile.type !== 'ssh' ? '' : html`<dt>Host key</dt><dd>${profile.hostKey ? html`<span class="tc-cred-fp"><span class="tc-cred-key-type">${S.keyType(profile.hostKey.type)}</span><span class="tc-cred-fingerprint">${profile.hostKey.fingerprint}</span><small>${profile.hostKey.firstUse ? 'pinned on first use ' : 'trusted '}${S.day(profile.hostKey.trustedAt)}${profile.hostKey.carried ? ' · carried over' : ''}</small></span>` : profile.fields?.auth === 'key' ? html`<span class="tc-muted">Pinned on the first connection</span>` : html`<span class="tc-muted">Not trusted yet</span><span class="tc-spacer"></span>${action('review', 'Trust…', { ghost: true })}`}</dd>`;
      const connection = profile => html`<section class="tc-insp-section"><h3 class="tc-insp-label">Details</h3><dl class="tc-group tc-pathlist tc-cred-facts">${factRows(profile)}${hostKeyRow(profile)}${profile.description ? html`<dt>Description</dt><dd>${profile.description}</dd>` : ''}${profile.delivers?.length ? html`<dt>Commands get</dt><dd><span class="tc-cred-gives">${profile.delivers.map((name, index) => html`${index ? ', ' : ''}<code>${name}</code>`)}</span></dd>` : ''}</dl></section>`;
      const keySection = profile => {
        if (profile.type !== 'ssh') return '';
        if (profile.fields?.auth === 'password') return profile.hostKey ? html`<section class="tc-insp-section"><div class="tc-notice"><div class="tc-notice-body"><strong class="tc-notice-title">Switch to a key</strong><span class="tc-notice-desc">Signs in once with this password to add a new key, then deletes the password.</span></div>${action('use-key', 'Switch…')}</div></section>` : '';
        if (!profile.fields?.publicKey) return '';
        return html`<section class="tc-insp-section"><h3 class="tc-insp-label tc-cred-snippet-head">Add this key to a server<span class="tc-spacer"></span>${action('copy-install', 'Copy', { icon: 'copy' })}</h3><pre class="tc-cred-snippet">${S.installLine(profile.fields.publicKey)}</pre><p class="tc-hint">Run it on the server as ${profile.fields.username}. The private key stays here.</p></section>`;
      };
      const activity = profile => {
        const origin = S.originText(profile) || 'Added in Setup', link = S.threadUrl(profile.origin, ctx.environmentId());
        const used = profile.usage?.at ? 'Last used ' + M.relTime(profile.usage.at, Date.now()) + (profile.usage.command ? ' by ' + profile.usage.command : '') : 'Never used';
        const usedLink = S.threadUrl(profile.usage, ctx.environmentId());
        return html`<section class="tc-insp-section"><h3 class="tc-insp-label">Activity</h3><dl class="tc-group tc-pathlist tc-cred-facts"><dt>Added</dt><dd>${origin}, ${S.day(profile.createdAt)}${link ? html` · <a class="tc-cred-link" href="${link}" target="_top">View thread</a>` : ''}</dd><dt>Used</dt><dd>${used}${usedLink ? html` · <a class="tc-cred-link" href="${usedLink}" target="_top">View thread</a>` : ''}</dd>${profile.changedBy?.by === 'agent' ? html`<dt>Changed</dt><dd>By an agent, ${S.day(profile.updatedAt)}</dd>` : ''}</dl></section>`;
      };
      const bannerActions = profile => {
        const state = S.state(profile, { busy: ctx.busy.get(id)?.kind === 'test' });
        return html`<div class="tc-cred-banner-actions">${state.action.startsWith('Review') ? action('review', 'Review…') : state.action.startsWith('Replace') ? action('replace', 'Replace ' + S.secretKind(profile) + '…') : state.action.startsWith('Edit') ? action('edit', 'Edit…') : ''}${state.action && !state.action.startsWith('Review') ? action('test', profile.test ? 'Test again' : 'Test now') : ''}</div>`;
      };
      const banner = profile => {
        const state = S.state(profile, { busy: ctx.busy.get(id)?.kind === 'test' });
        return html`<div class="tc-cred-result"><div class="tc-cred-banner" data-tone="${state.tone}" role="status">${state.icon ? icon(state.icon) : html`<span class="tc-spinner" aria-hidden="true"></span>`}<div><strong>${state.title}</strong>${state.desc ? html`<span>${profile.fields?.baseUrl && profile.test?.ok ? html`<code>GET ${profile.fields.testPath || 'the address'}</code> answered HTTP ${profile.test.detail.status} in ${profile.test.ms} ms.` : state.desc}</span>` : ''}</div>${Kit.isPhone() ? '' : bannerActions(profile)}</div>${Kit.isPhone() ? bannerActions(profile) : ''}</div>`;
      };
      const snippet = profile => html`<pre class="tc-cred-snippet">${S.snippet(profile, { aliases: ctx.sshAliases() }).split('\n').map((line, index) => html`${index ? '\n' : ''}${/^(?:t3-vault|ssh) /.test(line) ? html`<b>${line}</b>` : line}`)}</pre>`;
      const use = profile => html`<section class="tc-insp-section"><h3 class="tc-insp-label tc-cred-snippet-head">Use it in a skill<span class="tc-spacer"></span>${action('snippet', 'Copy snippet', { icon: 'copy' })}</h3><ul class="tc-group tc-cred-cmds">${S.commands(profile, { aliases: ctx.sshAliases() }).map((command, index) => html`<li><code>${command}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-cred-inspect="command" data-index="${index}" aria-label="Copy command">${icon('copy')}</button></li>`)}</ul><details class="tc-cred-snippet-detail" data-key="cred-snippet"${view.snippetOpen ? raw(' open') : ''}><summary>Snippet for SKILL.md</summary>${snippet(profile)}</details><p class="tc-hint">${S.usesPlainSsh(profile, ctx.sshAliases()) ? 'Plain ssh, scp and git work with this name.' : 'Output that repeats a saved value shows [redacted].'}</p></section>`;
      const usedIn = profile => html`<section class="tc-insp-section"><h3 class="tc-insp-label">Used in<span class="tc-spacer"></span><span class="tc-hint">${S.usageCount(profile, ctx.usageWarnings()?.length > 0)}</span></h3><div class="tc-group">${profile.usedIn?.length ? profile.usedIn.map(item => html`<div class="tc-cred-skill"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('book-open')}</span><div><strong>${item.name}</strong><small>${item.kind === 'instructions' ? 'Shared global instructions' : 'Global skill · ' + item.where}</small></div><a class="tc-btn tc-btn--ghost tc-btn--xs" href="${item.kind === 'instructions' ? '#instructions' : '#instructions/skills'}">Open${icon('chevron-right')}</a></div>`) : html`<div class="tc-empty tc-empty--compact"><p class="tc-hint">${ctx.usageWarnings()?.length ? 'Couldn’t read all skills just now.' : 'Not in a skill yet'}</p></div>`}</div><p class="tc-hint">Skills that mention ${id}, from Instructions & skills.${ctx.usageWarnings()?.length ? ' Some skills couldn’t be read.' : ''}</p></section>`;
      const render = () => {
        const profile = row();
        return html`<div class="tc-insp-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(S.iconFor(profile?.type))}</span><div class="tc-insp-title"><h2 id="cred-inspect-title" title="${id}">${id}</h2><span class="tc-insp-meta">${profile ? S.typeLabel(profile.type) + (S.kind(profile) ? ' · ' + S.kind(profile) : '') + ' · added ' + S.day(profile.createdAt) : 'Credential unavailable'}</span></div>${profile ? action('edit', 'Edit', { icon: 'pencil' }) : ''}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cred-inspect="menu" data-key="cred-inspect-menu" aria-haspopup="menu" aria-label="Credential actions"${disabled(!profile || busy())}>${icon('ellipsis')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cred-inspect="close" aria-label="Close credential details">${icon('x')}</button></div><div class="tc-insp-body">${profile ? html`${ctx.errors.get(id) ? html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><strong>Couldn’t complete the action</strong><span class="tc-notice-desc">${ctx.errors.get(id)}</span></div></div>` : ''}${banner(profile)}${connection(profile)}${keySection(profile)}${profile.fields?.baseUrl ? html`<section class="tc-insp-section"><h3 class="tc-insp-label">Every request<span class="tc-spacer"></span><span class="tc-hint">Stays under the address</span></h3>${requestPreview(profile)}</section>` : ''}${use(profile)}${usedIn(profile)}${activity(profile)}` : html`<div class="tc-notice tc-notice--danger" role="alert"><div class="tc-notice-body"><strong>This credential isn’t available</strong><span class="tc-notice-desc">${ctx.loadError() || 'It may have been deleted in another window.'}</span></div><button class="tc-btn tc-btn--sm" type="button" data-cred-inspect="retry">Try again</button></div>`}</div>`;
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
        if (action === 'snippet') return void Kit.copy(S.snippet(profile, { aliases: ctx.sshAliases() }), button, 'Skill snippet copied');
        if (action === 'command') return void Kit.copy(S.commands(profile, { aliases: ctx.sshAliases() })[Number(button.dataset.index)], button, 'Command copied');
        ctx.action(action, id, button);
      });
    };
    return { open, close, repaint, id: () => active?.id || null };
  };
  return { create, requestPreview };
})();
