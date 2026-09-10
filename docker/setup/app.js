// The setup console's client script.
//
// It lives in its own file, not inside a template literal in server.mjs, and
// that is deliberate: a template literal eats backslashes on the way out, so
// `/\s+/` reached the browser as `/s+/` and split names on the letter s. The
// same trap ate an apostrophe once before. `node --check` cannot catch either,
// because the corrupted result still parses. Kept as a real file, nothing
// rewrites it between here and the browser.
//
// Markup here is the `tc-*` component system from docker/setup/console.css;
// the two are one design and should be changed together.
//
// `BASE` is set by a small inline script the page emits before this one.
const BASE = window.__T3_SETUP_BASE__ || '';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g,
  (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

// ---------------------------------------------------------------- theme --
// Three modes, not two: "system" is the default and keeps following the OS.
// The inline boot script in the page has already applied the stored mode, so
// this only has to keep the icon honest and cycle on click.
const THEME_KEY = 't3-console-theme';
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
  + ' stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/>'
  + '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2'
  + 'M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
  + ' stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

const themeMode = () => {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
};
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const applyTheme = (mode) => {
  const resolved = mode === 'system' ? (systemDark() ? 'dark' : 'light') : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-mode', mode);
  const button = $('theme-btn');
  if (button) {
    button.innerHTML = resolved === 'dark' ? SUN : MOON;
    button.title = mode === 'system'
      ? 'Following the system theme' : 'Theme: ' + mode;
  }
};
if ($('theme-btn')) {
  $('theme-btn').onclick = () => {
    const next = {system: 'light', light: 'dark', dark: 'system'}[themeMode()];
    try { localStorage.setItem(THEME_KEY, next); } catch { /* session only */ }
    applyTheme(next);
  };
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => { if (themeMode() === 'system') applyTheme('system'); });
  applyTheme(themeMode());
}

// ---------------------------------------------------------------- toasts --
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"'
  + ' stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

const toast = (message, icon) => {
  let stack = document.querySelector('.tc-toasts');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'tc-toasts';
    document.body.appendChild(stack);
  }
  const node = document.createElement('div');
  node.className = 'tc-toast';
  node.setAttribute('role', 'status');
  node.innerHTML = (icon || '') + '<span>' + esc(message) + '</span>';
  stack.appendChild(node);
  setTimeout(() => {
    node.classList.add('tc-toast--out');
    setTimeout(() => node.remove(), 200);
  }, 1900);
};

// execCommand is the fallback because clipboard.writeText needs a secure
// context, and this page is often served over plain http on a LAN.
const copy = (text, message) => {
  const done = () => toast(message || 'Copied to clipboard', CHECK);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
};
const fallbackCopy = (text, done) => {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); done(); }
  catch { toast('Press ⌘C to copy'); }
  area.remove();
};

// Any element carrying data-copy copies it, so a new copy button needs no wiring.
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-copy]');
  if (target) copy(target.dataset.copy, target.dataset.copyMsg);
});

// --------------------------------------------------------------- dialogs --
// Revoking cuts a device off. The design makes that a decision rather than a
// twitch, so it goes through a dialog with the name of what is about to break.
const confirmDialog = ({title, body, confirmLabel, onConfirm}) => {
  const backdrop = document.createElement('div');
  backdrop.className = 'tc-backdrop';
  backdrop.innerHTML =
    '<div class="tc-dialog" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">'
    + '<h3>' + esc(title) + '</h3><p>' + body + '</p>'
    + '<div class="tc-dialog-foot">'
    + '<button type="button" class="tc-btn tc-btn--ghost" data-close>Cancel</button>'
    + '<button type="button" class="tc-btn tc-btn--danger-solid" data-go>'
    + esc(confirmLabel) + '</button></div></div>';
  document.body.appendChild(backdrop);

  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-close]').onclick = close;
  backdrop.querySelector('[data-go]').onclick = () => { close(); onConfirm(); };
  backdrop.querySelector('[data-go]').focus();
};

// ---------------------------------------------------------------- format --
const when = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? '—' : d.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
};
// "in 29 days" is what you want to know about a device; the exact stamp stays
// on hover for when you need it.
const ago = (v) => {
  const d = new Date(v);
  if (!v || isNaN(d)) return '—';
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  const past = secs >= 0, n = Math.abs(secs);
  const [amount, unit] = n < 60 ? [n, 'second'] : n < 3600 ? [Math.round(n / 60), 'minute']
    : n < 86400 ? [Math.round(n / 3600), 'hour'] : [Math.round(n / 86400), 'day'];
  return new Intl.RelativeTimeFormat(undefined, {numeric: 'auto'})
    .format(past ? -amount : amount, unit);
};
// Two letters that tell the five apart: word initials where there are words,
// and camel-case counts as words - OpenCode reads OC, not OP.
const initials = (name) => {
  const parts = String(name).trim().split(/\s+/)
    .flatMap((w) => w.split(/(?=[A-Z])/).filter(Boolean));
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(name).slice(0, 2)).toUpperCase();
};

const dot = '<span class="tc-dot"></span>';
const chip = (kind, text) =>
  '<span class="tc-chip tc-chip--' + kind + '">'
  + (kind === 'idle' ? '' : dot) + esc(text) + '</span>';

const COPY_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none"'
  + ' stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="9" y="9" width="12" height="12" rx="2.5"/>'
  + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

// Everything below drives the console; the unlock screen has none of it.
if ($('mint')) {
  // Both a sign-in and a key form render into the agent's row, and the periodic
  // refresh rebuilds that list. It has to leave the row alone while either is
  // open, or the URL, the QR, the code field - or the key you are halfway
  // through pasting - vanish under you a few seconds after they appear.
  let panelActive = null;

  // ------------------------------------------------------------ pairing --
  let ttl = '30d';
  for (const button of $('ttl').querySelectorAll('button')) {
    button.onclick = () => {
      ttl = button.dataset.ttl;
      for (const other of $('ttl').querySelectorAll('button')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
    };
  }

  const STEPS = (active) => {
    const label = ['Link created', 'Device connects', 'Paired'];
    return '<div class="tc-steps">' + label.map((text, i) => {
      const cls = i < active ? ' tc-step--done' : i === active ? ' tc-step--active' : '';
      return (i ? '<span class="tc-step-line"></span>' : '')
        + '<span class="tc-step' + cls + '"><span class="tc-step-mark">'
        + (i < active ? '✓' : String(i + 1)) + '</span>' + text + '</span>';
    }).join('') + '</div>';
  };

  $('mint').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    $('out').innerHTML = '<div class="tc-panel"><span class="tc-skel" style="width:70%"></span></div>';
    try {
      const res = await fetch(BASE + '/pair', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({ttl, label: $('label').value}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create a link');
      $('out').innerHTML =
        '<div class="tc-panel"><div class="tc-split"><div class="tc-stack">'
        + STEPS(1)
        + '<p class="tc-hint">Single use · expires ' + esc(when(data.expiresAt))
        + '. The token lives in the link fragment — treat it as a credential.</p>'
        + '<div class="tc-copyrow">'
        + '<div class="tc-linkbox">' + esc(data.pairUrl) + '</div>'
        + '<button type="button" class="tc-btn tc-btn--outline" data-copy="'
        + esc(data.pairUrl) + '" data-copy-msg="Pairing link copied">Copy</button>'
        + '<a class="tc-btn tc-btn--outline" href="' + esc(data.pairUrl)
        + '" target="_blank" rel="noopener">Open</a>'
        + '</div></div>'
        + (data.qr ? '<div class="tc-qr">' + data.qr + '</div>' : '')
        + '</div></div>';
      $('label').value = '';
      load();
    } catch (error) {
      $('out').innerHTML = '<div class="tc-notice tc-notice--err">' + esc(error.message) + '</div>';
    }
    button.disabled = false;
  };

  // ------------------------------------------------------------- strip --
  const readout = (label, value) =>
    '<div class="tc-readout"><span class="tc-readout-label">' + label
    + '</span><span class="tc-readout-value">' + value + '</span></div>';

  const renderStrip = (s) => {
    const build = s.image && s.image.version
      ? s.image.version + (s.image.variant ? ' · ' + s.image.variant : '')
      : 'unversioned';
    $('strip').innerHTML =
      readout('Server', s.server.ok
        ? '<span class="tc-dot tc-dot--live" style="color:var(--ok-fg)"></span>Running '
          + esc(s.server.version)
        : '<span class="tc-dot" style="background:var(--err-fg)"></span>' + esc(s.server.detail))
      + readout('Image', '<span class="tc-mono">' + esc(build) + '</span>')
      + readout('Public URL', s.publicUrl
        ? '<span class="tc-mono tc-truncate" style="max-width:210px">' + esc(s.publicUrl)
          + '</span><button type="button" class="tc-iconbtn" style="width:22px;height:22px"'
          + ' data-copy="' + esc(s.publicUrl) + '" data-copy-msg="Public URL copied"'
          + ' aria-label="Copy public URL">' + COPY_ICON + '</button>'
        : '<span class="tc-chip tc-chip--warn" style="height:auto;padding:1px 8px">Not set</span>')
      + readout('Devices', '<span class="tc-mono">' + s.sessions.length + '</span> paired');
  };

  const renderDetails = (s) => {
    const item = (label, value) =>
      '<div class="tc-details-item"><span class="tc-details-label">' + label
      + '</span><span class="tc-details-value">' + value + '</span></div>';
    $('details').innerHTML =
      item('State volume', '<span class="tc-mono">' + esc(s.paths?.volume || '—') + '</span>')
      + item('Workspace', '<span class="tc-mono">' + esc(s.paths?.workspace || '—') + '</span>')
      + item('Pair TTL', '<span class="tc-mono">' + esc(s.paths?.pairTtl || '30d')
        + '</span> default')
      + item('Agent credentials', 'Persisted on the state volume — survive a recreate')
      + (s.publicUrl ? '' : item('Pairing',
          '<span style="color:var(--warn-fg)">Without T3_PUBLIC_URL, links point at this '
          + "container's own address and no device can reach them</span>"));
  };

  // ------------------------------------------------------------ agents --
  const renderAgents = (s) => {
    const signed = s.harnesses.filter((h) => h.signedIn === true).length;
    $('agent-count').textContent = signed + ' of ' + s.harnesses.length + ' signed in';
    $('agents').innerHTML = s.harnesses.map((h) => {
      const status = !h.installed ? chip('bad', 'Not installed')
        : h.signedIn === true ? chip('ok', 'Signed in')
        : h.signedIn === false ? chip('warn', 'Not signed in')
        : chip('idle', 'Sign-in state not readable');
      const actions = !h.installed ? ''
        : (h.canSignIn
            ? '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm signin"'
              + ' data-agent="' + h.id + '">Sign in</button>' : '')
          + (h.canSetKey
            ? '<button type="button" class="tc-btn tc-btn--outline tc-btn--sm setkey"'
              + ' data-agent="' + h.id + '" data-kind="' + esc(h.keyKind) + '">API key</button>' : '');
      // Saying how each one authenticates removes the guesswork about what a
      // button is going to do before you press it.
      const how = !h.installed ? 'Not present in this image'
        : h.canSignIn && h.canSetKey ? 'Browser sign-in, or a stored API key'
        : h.canSignIn ? 'Browser sign-in'
        : h.canSetKey ? 'API key, per provider'
        : '';
      return '<div class="tc-row">'
        + '<span class="tc-tile' + (h.signedIn === true ? ' tc-tile--signed' : '')
        + '" style="--tile:var(--id-' + h.id + ')" aria-hidden="true">'
        + esc(initials(h.name)) + '</span>'
        + '<div class="tc-row-main"><div class="tc-row-nameline">'
        + '<span class="tc-row-name">' + esc(h.name) + '</span>' + status + '</div>'
        + (how ? '<div class="tc-row-meta">' + esc(how) + '</div>' : '') + '</div>'
        + '<div class="tc-row-actions">' + actions + '</div>'
        + '<div class="tc-row-panel" id="agent-' + h.id + '"></div></div>';
    }).join('');
  };

  // ----------------------------------------------------------- sessions --
  const revokeButton = (kind, id, label) =>
    '<button type="button" class="tc-btn tc-btn--danger tc-btn--sm revoke" data-kind="'
    + kind + '" data-id="' + esc(id) + '" data-label="' + esc(label) + '">Revoke</button>';

  const renderSessions = (s) => {
    const links = s.pairings.length;
    $('sessioncount').textContent =
      s.sessions.length + (s.sessions.length === 1 ? ' device' : ' devices')
      + ' · ' + links + (links === 1 ? ' unused link' : ' unused links');

    $('clients').innerHTML = s.sessions.length
      ? s.sessions.map((c) => {
          const name = c.client?.label || c.subject || c.sessionId;
          return '<div class="tc-row"><div class="tc-row-main"><div class="tc-row-nameline">'
            + '<span class="tc-row-name">' + esc(name) + '</span>'
            + (c.connected ? chip('ok', 'Connected') : '') + '</div>'
            + '<div class="tc-row-meta" title="Expires ' + esc(when(c.expiresAt)) + '">'
            + (c.connected ? 'Expires ' + esc(ago(c.expiresAt))
                : 'Last seen ' + esc(ago(c.lastConnectedAt))
                  + ' · expires ' + esc(ago(c.expiresAt)))
            + '</div></div><div class="tc-row-actions">'
            + revokeButton('session', c.sessionId, name) + '</div></div>';
        }).join('')
      : '<div class="tc-empty tc-empty--compact">No devices paired yet.<br>'
        + 'Create a link above to add one.</div>';

    $('links').innerHTML = links
      ? s.pairings.map((l) => {
          const name = l.label || 'Unlabelled';
          return '<div class="tc-row"><div class="tc-row-main">'
            + '<div class="tc-row-nameline"><span class="tc-row-name">' + esc(name) + '</span></div>'
            + '<div class="tc-row-meta" title="' + esc(when(l.expiresAt)) + '">Expires '
            + esc(ago(l.expiresAt)) + '</div></div><div class="tc-row-actions">'
            + revokeButton('pairing', l.id, name) + '</div></div>';
        }).join('')
      : '<div class="tc-empty tc-empty--compact">None outstanding.<br>'
        + 'Every link created has been redeemed.</div>';
  };

  // -------------------------------------------------------------- ports --
  // Polled separately from the rest of the page and on a shorter interval: a
  // tunnel takes a few seconds to be handed a hostname, and a port appearing
  // moments after a dev server starts is the whole point. This calls the same
  // /ports API t3-expose calls, so publishing from a terminal shows up here
  // without anything having to tell the page about it.
  const qrOpen = new Set();
  const portsBusy = new Set();

  const loadPorts = async () => {
    let data;
    try { data = await (await fetch(BASE + '/ports')).json(); } catch { return; }

    if (data.available === false) {
      $('portnote').textContent = 'cloudflared is not in this image';
      $('ports').innerHTML = '<div class="tc-empty tc-empty--compact">'
        + 'Publishing is unavailable in this build.</div>';
      $('portfoot').hidden = true;
      return;
    }

    const tunnels = new Map((data.tunnels || []).map((t) => [t.port, t]));
    const ports = [...new Set([...(data.listening || []), ...tunnels.keys()])]
      .sort((a, b) => a - b);
    const open = [...tunnels.values()].filter((t) => t.state === 'open').length;
    $('portnote').textContent = open ? open + ' published' : '';
    $('portfoot').hidden = !open;

    if (!ports.length) {
      $('ports').innerHTML = '<div class="tc-empty tc-empty--compact">Nothing is listening yet.'
        + '<br>Start a dev server and it will appear here.</div>';
      return;
    }

    $('ports').innerHTML = ports.map((port) => {
      const t = tunnels.get(port);
      const state = t ? t.state : 'idle';
      const busy = portsBusy.has(port);

      let chipHtml = '', meta = 'Listening in the container', actions = '', panel = '';
      if (state === 'open') {
        chipHtml = chip('info', 'Published');
        meta = '<span class="tc-mono tc-truncate">' + esc(t.url) + '</span>';
        actions = '<a class="tc-btn tc-btn--outline tc-btn--sm" href="' + esc(t.url)
          + '" target="_blank" rel="noopener">Open</a>'
          + '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm portqr"'
          + ' data-port="' + port + '">QR code</button>'
          + '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm unexpose"'
          + ' data-port="' + port + '">Stop</button>';
        if (qrOpen.has(port) && t.qr) {
          panel = '<div class="tc-row-panel"><div class="tc-panel"><div class="tc-split">'
            + '<div class="tc-stack"><p class="tc-hint">Scan to open port ' + port
            + ' on another device.</p><div class="tc-copyrow">'
            + '<div class="tc-linkbox">' + esc(t.url) + '</div>'
            + '<button type="button" class="tc-btn tc-btn--outline" data-copy="' + esc(t.url)
            + '" data-copy-msg="Published URL copied">Copy</button></div></div>'
            + '<div class="tc-qr">' + t.qr + '</div></div></div></div>';
        }
      } else if (state === 'starting' || busy) {
        chipHtml = chip('idle', 'Publishing');
        meta = 'Waiting for a public hostname…';
        actions = '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm" disabled>'
          + '<span class="tc-spin"></span></button>';
      } else if (state === 'failed') {
        chipHtml = chip('bad', 'Failed');
        meta = '<span style="color:var(--err-fg)">' + esc(t.error || 'the tunnel failed') + '</span>';
        actions = '<button type="button" class="tc-btn tc-btn--outline tc-btn--sm expose"'
          + ' data-port="' + port + '">Retry</button>';
      } else {
        actions = '<button type="button" class="tc-btn tc-btn--outline tc-btn--sm expose"'
          + ' data-port="' + port + '">Publish</button>';
      }

      return '<div class="tc-row">'
        + '<span class="tc-tile tc-tile--port" aria-hidden="true">' + port + '</span>'
        + '<div class="tc-row-main"><div class="tc-row-nameline">'
        + '<span class="tc-row-name">Port ' + port + '</span>' + chipHtml + '</div>'
        + '<div class="tc-row-meta">' + meta + '</div></div>'
        + '<div class="tc-row-actions">' + actions + '</div>' + panel + '</div>';
    }).join('');

    for (const b of $('ports').querySelectorAll('.expose')) {
      b.onclick = async () => {
        const port = Number(b.dataset.port);
        portsBusy.add(port);
        b.disabled = true;
        try {
          await fetch(BASE + '/ports/expose', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({port}),
          });
        } finally { portsBusy.delete(port); }
        loadPorts();
      };
    }
    for (const b of $('ports').querySelectorAll('.unexpose')) {
      b.onclick = async () => {
        const port = Number(b.dataset.port);
        b.disabled = true;
        qrOpen.delete(port);
        await fetch(BASE + '/ports/unexpose', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({port}),
        });
        loadPorts();
      };
    }
    for (const b of $('ports').querySelectorAll('.portqr')) {
      b.onclick = () => {
        const port = Number(b.dataset.port);
        if (qrOpen.has(port)) qrOpen.delete(port); else qrOpen.add(port);
        loadPorts();
      };
    }
  };

  // --------------------------------------------------------------- load --
  const load = async () => {
    let s;
    try { s = await (await fetch(BASE + '/status')).json(); }
    catch {
      $('strip').innerHTML = '<div class="tc-notice tc-notice--err">Could not read status.</div>';
      return;
    }

    const build = s.image && s.image.version
      ? s.image.version + (s.image.variant ? ' · ' + s.image.variant : '')
      : 'unversioned build';
    $('build').textContent = build;
    $('health').innerHTML = s.server.ok
      ? '<span class="tc-dot tc-dot--live" style="color:var(--ok-fg)"></span>Running '
        + esc(s.server.version)
      : '<span class="tc-dot" style="background:var(--err-fg)"></span>Server down';

    renderStrip(s);
    renderSessions(s);
    renderDetails(s);
    if (!panelActive) renderAgents(s);

    for (const b of document.querySelectorAll('.revoke')) {
      b.onclick = () => confirmDialog({
        title: b.dataset.kind === 'session' ? 'Revoke this device?' : 'Revoke this link?',
        body: b.dataset.kind === 'session'
          ? '<strong>' + esc(b.dataset.label) + '</strong> loses access immediately and has to '
            + 'be paired again with a new link.'
          : '<strong>' + esc(b.dataset.label) + '</strong> has not been redeemed yet. '
            + 'Revoking it means the link stops working.',
        confirmLabel: 'Revoke',
        onConfirm: async () => {
          b.disabled = true;
          await fetch(BASE + '/revoke', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({kind: b.dataset.kind, id: b.dataset.id}),
          });
          toast('Revoked');
          load();
        },
      });
    }

    if (panelActive) return;

    // The provider list is fetched once and reused: it is the same for every
    // agent row and does not change while the page is open.
    let providerList = null;
    const loadProviders = async () => {
      if (providerList) return providerList;
      try { providerList = await (await fetch(BASE + '/providers')).json(); }
      catch { providerList = {providers: [], configured: []}; }
      return providerList;
    };

    for (const b of document.querySelectorAll('.setkey')) {
      b.onclick = async () => {
        const agent = b.dataset.agent;
        const needsProvider = b.dataset.kind === 'opencode';
        let providerField = '';
        if (needsProvider) {
          b.disabled = true;
          const {providers, configured} = await loadProviders();
          b.disabled = false;
          const done = new Set(configured || []);
          const opts = (providers || []).map((p) =>
            '<option value="' + esc(p.id) + '">' + esc(p.name)
            + (done.has(p.id) ? ' ✓' : '') + '</option>').join('');
          providerField =
            '<div class="tc-field"><label class="tc-label">Provider</label>'
            + '<select class="tc-select pv">'
            + '<option value="">Choose a provider' + (opts ? '' : ' (catalog unavailable)')
            + '</option>' + opts + '<option value="__custom">Other — type an id</option></select>'
            + '<input class="tc-input pv-custom" placeholder="Provider id, e.g. deepseek"'
            + ' style="display:none;margin-top:8px" /></div>';
        }
        panelActive = agent;
        $('agent-' + agent).innerHTML =
          '<div class="tc-panel"><div class="tc-stack">' + providerField
          + '<div class="tc-field"><label class="tc-label">API key</label>'
          + '<input class="tc-input tc-input--mono kv-key" type="password"'
          + ' placeholder="Paste the key" />'
          + '<span class="tc-hint">Written to this container\'s state volume, never sent '
          + 'anywhere else.</span></div>'
          + '<div class="tc-cluster">'
          + '<button type="button" class="tc-btn tc-btn--primary tc-btn--sm save">Save</button>'
          + '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm cancelkey">Cancel</button>'
          + '</div><div class="out"></div></div></div>';
        const box = $('agent-' + agent);
        // Closing is what lets the list start refreshing again, so it needs to
        // be reachable without saving something.
        box.querySelector('.cancelkey').onclick = () => {
          panelActive = null; box.innerHTML = ''; load();
        };
        const sel = box.querySelector('.pv');
        const custom = box.querySelector('.pv-custom');
        if (sel) sel.onchange = () => {
          const isCustom = sel.value === '__custom';
          custom.style.display = isCustom ? '' : 'none';
          if (isCustom) custom.focus();
        };
        box.querySelector('.save').onclick = async (e) => {
          e.target.disabled = true;
          const body = {agent, key: box.querySelector('.kv-key').value};
          if (sel) body.provider = sel.value === '__custom' ? custom.value.trim() : sel.value;
          const res = await fetch(BASE + '/auth/apikey', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify(body),
          });
          const data = await res.json();
          box.querySelector('.out').innerHTML = res.ok
            ? '<div class="tc-notice tc-notice--ok">Saved.</div>'
            : '<div class="tc-notice tc-notice--err">' + esc(data.error) + '</div>';
          e.target.disabled = false;
          // Leave a failed attempt on screen with the key still in it; only a
          // success closes the form and lets the list resume.
          if (res.ok) { toast('API key saved', CHECK); panelActive = null; setTimeout(load, 600); }
        };
      };
    }

    for (const b of document.querySelectorAll('.signin')) {
      b.onclick = async () => {
        const agent = b.dataset.agent;
        b.disabled = true;
        const box = $('agent-' + agent);
        box.innerHTML = '<div class="tc-panel"><span class="tc-skel" style="width:70%"></span></div>';
        const res = await fetch(BASE + '/auth/signin', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({agent}),
        });
        const started = await res.json();
        if (!res.ok) {
          box.innerHTML = '<div class="tc-notice tc-notice--err">' + esc(started.error) + '</div>';
          b.disabled = false;
          return;
        }
        panelActive = agent;
        const finish = (html) => { panelActive = null; box.innerHTML = html; b.disabled = false; };
        let painted = false;
        const poll = async () => {
          const st = await (await fetch(BASE + '/auth/session?id=' + started.id)).json();
          if (st.state === 'done') {
            finish('<div class="tc-notice tc-notice--ok">Signed in.</div>');
            toast('Signed in', CHECK);
            load();
            return;
          }
          if (st.state === 'failed' || st.state === 'cancelled') {
            finish('<div class="tc-notice tc-notice--err">'
              + esc(st.error || 'Sign-in stopped') + '</div>');
            return;
          }
          // Paint once. Re-rendering on every poll would clear the code field
          // under whoever is pasting into it.
          if (st.url && !painted) {
            painted = true;
            // Two columns: the code you scan on the right, everything you read
            // or type on the left, so the QR stops pushing the field you
            // actually need down the page.
            box.innerHTML =
              '<div class="tc-panel"><div class="tc-split"><div class="tc-stack">'
              + '<p class="tc-hint">Open this on any device and approve.</p>'
              + '<div class="tc-copyrow">'
              + '<div class="tc-linkbox">' + esc(st.url) + '</div>'
              + '<button type="button" class="tc-btn tc-btn--outline" data-copy="' + esc(st.url)
              + '" data-copy-msg="Sign-in URL copied">Copy</button>'
              + '<a class="tc-btn tc-btn--outline" href="' + esc(st.url)
              + '" target="_blank" rel="noopener">Open</a></div>'
              + (st.code ? '<div class="tc-cluster">' + chip('idle', 'Confirm code ' + st.code)
                 + '</div>' : '')
              + (st.needsCode
                 ? '<div class="tc-field"><label class="tc-label">Code from your browser</label>'
                   + '<div class="tc-copyrow"><input class="tc-input tc-input--mono codein"'
                   + ' placeholder="Paste the code" />'
                   + '<button type="button" class="tc-btn tc-btn--primary sendcode">Submit</button>'
                   + '</div></div>' : '')
              + '<div class="tc-cluster">'
              + '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm cancel">Cancel</button>'
              + '</div></div>'
              + (st.qr ? '<div class="tc-qr">' + st.qr + '</div>' : '')
              + '</div></div>';
            const send = box.querySelector('.sendcode');
            if (send) send.onclick = async () => {
              send.disabled = true;
              send.textContent = 'Submitting';
              await fetch(BASE + '/auth/code', {
                method: 'POST', headers: {'content-type': 'application/json'},
                body: JSON.stringify({id: started.id, code: box.querySelector('.codein').value}),
              });
            };
            box.querySelector('.cancel').onclick = async () => {
              await fetch(BASE + '/auth/cancel', {
                method: 'POST', headers: {'content-type': 'application/json'},
                body: JSON.stringify({id: started.id}),
              });
              finish('<div class="tc-notice tc-notice--quiet">Sign-in cancelled.</div>');
            };
          }
          setTimeout(poll, 2000);
        };
        poll();
      };
    }
  };

  load();
  loadPorts();
  setInterval(load, 15000);
  setInterval(loadPorts, 4000);
}
