// The setup page's client script.
//
// It lives in its own file, not inside a template literal in server.mjs, and
// that is deliberate: a template literal eats backslashes on the way out, so
// `/\s+/` reached the browser as `/s+/` and split names on the letter s. The
// same trap ate an apostrophe once before. `node --check` cannot catch either,
// because the corrupted result still parses. Kept as a real file, nothing
// rewrites it between here and the browser.
//
// `BASE` is set by a small inline script the page emits before this one.
const BASE = window.__T3_SETUP_BASE__ || '';
if (document.getElementById('mint')) {
  const $ = (id) => document.getElementById(id);
  // Both a sign-in and a key form render into the agent's row, and the periodic
  // refresh rebuilds that list. It has to leave the row alone while either is
  // open, or the URL, the QR, the code field - or the key you are halfway
  // through pasting - vanish under you a few seconds after they appear.
  let panelActive = null;
  // Two letters that tell the five apart: word initials where there are words,
  // and camel-case counts as words - OpenCode reads OC, not OP.
  const initials = (name) => {
    const parts = String(name).trim().split(/\s+/)
      .flatMap((w) => w.split(/(?=[A-Z])/).filter(Boolean));
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(name).slice(0, 2)).toUpperCase();
  };
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const when = (v) => { if (!v) return '—'; const d = new Date(v);
    return isNaN(d) ? '—' : d.toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'}); };
  // "2 hours ago" is what you actually want to know about a device; the exact
  // stamp stays on hover for when you need it.
  const ago = (v) => {
    const d = new Date(v); if (!v || isNaN(d)) return '\u2014';
    const secs = Math.round((Date.now() - d.getTime()) / 1000);
    const past = secs >= 0, n = Math.abs(secs);
    const [amount, unit] = n < 60 ? [n, 'second'] : n < 3600 ? [Math.round(n / 60), 'minute']
      : n < 86400 ? [Math.round(n / 3600), 'hour'] : [Math.round(n / 86400), 'day'];
    const rel = new Intl.RelativeTimeFormat(undefined, {numeric: 'auto'});
    return rel.format(past ? -amount : amount, unit);
  };

  $('mint').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    $('out').innerHTML = '<div class="skeleton" style="width:80%"></div>';
    try {
      const res = await fetch(BASE + '/pair', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({ttl: $('ttl').value, label: $('label').value}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create a link');
      $('out').innerHTML =
        '<div class="result"><div class="col">' +
        '<div class="link">' + esc(data.pairUrl) + '</div>' +
        '<div class="controls" style="margin-top:10px">' +
        '<button class="ghost tiny" id="copy">Copy link</button>' +
        '<a href="' + esc(data.pairUrl) + '" target="_blank" rel="noopener">' +
        '<button class="ghost tiny">Open</button></a>' +
        '<span class="chip idle">Single use &middot; expires ' +
        esc(when(data.expiresAt)) + '</span></div></div>' +
        (data.qr ? '<div class="qr">' + data.qr + '</div>' : '') + '</div>';
      $('copy').onclick = async (e) => {
        try { await navigator.clipboard.writeText(data.pairUrl); e.target.textContent = 'Copied'; }
        catch { e.target.textContent = 'Press ⌘C'; }
        setTimeout(() => { e.target.textContent = 'Copy link'; }, 1600);
      };
      $('label').value = '';
      load();
    } catch (error) {
      $('out').innerHTML = '<div class="notice err">' + esc(error.message) + '</div>';
    }
    button.disabled = false;
  };

  const revokeButton = (kind, id) =>
    '<button class="ghost tiny revoke" data-kind="' + kind + '" data-id="' + esc(id) + '">Revoke</button>';

  const load = async () => {
    let s;
    try { s = await (await fetch(BASE + '/status')).json(); }
    catch { $('status').innerHTML = '<div class="notice err">Could not read status.</div>'; return; }

    $('devcount').textContent = s.sessions.length
      ? s.sessions.length + (s.sessions.length === 1 ? ' paired' : ' paired') : '';
    $('clients').innerHTML = s.sessions.length
      ? '<div class="rows">' + s.sessions.map((c) =>
          '<div class="row"><div class="main"><div class="nameline"><span class="name">' +
          esc(c.client?.label || c.subject || c.sessionId) + '</span>' +
          (c.connected ? '<span class="chip ok"><span class="dot"></span>Connected</span>' : '') +
          '</div><div class="meta" title="Expires ' + esc(when(c.expiresAt)) + '">' +
          (c.connected ? 'Expires ' + esc(ago(c.expiresAt))
                       : 'Last seen ' + esc(ago(c.lastConnectedAt)) +
                         ' &middot; expires ' + esc(ago(c.expiresAt))) +
          '</div></div>' +
          '<div class="actions">' + revokeButton('session', c.sessionId) + '</div></div>').join('') + '</div>'
      : '<p class="empty">No devices paired yet.<br>Create a link above to add one.</p>';

    $('linkcount').textContent = s.pairings.length ? s.pairings.length + ' waiting' : '';
    $('links').innerHTML = s.pairings.length
      ? '<div class="rows">' + s.pairings.map((l) =>
          '<div class="row"><div class="main"><div class="name">' +
          esc(l.label || 'Unlabelled') + '</div><div class="meta" title="' +
          esc(when(l.expiresAt)) + '">Expires ' + esc(ago(l.expiresAt)) + '</div></div>' +
          '<div class="actions">' + revokeButton('pairing', l.id) + '</div></div>').join('') + '</div>'
      : '<p class="empty">None outstanding.<br>Every link created has been redeemed.</p>';

    // The top bar carries the two facts worth knowing before anything else:
    // whether the server is up, and which image this is.
    const build = s.image && s.image.version
      ? s.image.version + (s.image.variant ? ' \u00b7 ' + s.image.variant : '')
      : 'unversioned build';
    $('build').textContent = build;
    $('health').className = 'tag';
    $('health').innerHTML = s.server.ok
      ? '<span class="dot" style="background:var(--success-foreground)"></span>Running ' +
        esc(s.server.version)
      : '<span class="dot" style="background:var(--error-foreground)"></span>Server down';

    const rows = [];
    rows.push(['Server', s.server.ok
      ? '<span class="ok"><span class="dot"></span>Running ' + esc(s.server.version) + '</span>'
      : '<span class="bad"><span class="dot"></span>' + esc(s.server.detail) + '</span>']);
    rows.push(['Image', build === 'unversioned build'
      ? '<span class="meta">Not stamped &mdash; built outside CI</span>'
      : esc(build), true]);
    rows.push(['Public URL', s.publicUrl ? esc(s.publicUrl)
      : '<span class="warn">Not set</span>', Boolean(s.publicUrl)]);
    $('status').innerHTML = '<dl>' + rows.map(([k, v, mono]) =>
      '<div class="kv"><dt>' + k + '</dt><dd' + (mono ? ' class="mono"' : '') + '>' +
      v + '</dd></div>').join('') + '</dl>' +
      (s.publicUrl ? '' : '<div class="notice warn">Without T3_PUBLIC_URL, pairing links ' +
        "point at this container's own address and no device can reach them.</div>");

    if (!panelActive) $('agents').innerHTML = '<div class="rows">' + s.harnesses.map((h) => {
      const status = !h.installed ? '<span class="chip bad">Not installed</span>'
        : h.signedIn === true ? '<span class="chip ok"><span class="dot"></span>Signed in</span>'
        : h.signedIn === false ? '<span class="chip warn"><span class="dot"></span>Not signed in</span>'
        : '<span class="chip idle">Checking\u2026</span>';
      const actions = !h.installed ? '' :
        (h.canSignIn ? '<button class="ghost tiny signin" data-agent="' + h.id + '">Sign in</button>' : '') +
        (h.canSetKey ? '<button class="ghost tiny setkey" data-agent="' + h.id +
           '" data-kind="' + esc(h.keyKind) + '">API key</button>' : '');
      // Saying how each one authenticates removes the guesswork about what a
      // button is going to do before you press it.
      const how = !h.installed ? 'Not present in this image'
        : h.canSignIn && h.canSetKey ? 'Browser sign-in, or a stored API key'
        : h.canSignIn ? 'Browser sign-in'
        : h.canSetKey ? 'API key, per provider'
        : '';
      return '<div class="row">' +
        '<div class="mono-tile" style="--tile:var(--id-' + h.id + ')" aria-hidden="true">' +
        esc(initials(h.name)) + '</div>' +
        '<div class="main"><div class="nameline">' +
        '<span class="name">' + esc(h.name) + '</span>' + status + '</div>' +
        (how ? '<div class="meta">' + esc(how) + '</div>' : '') + '</div>' +
        '<div class="actions">' + actions + '</div>' +
        '<div class="panel" id="agent-' + h.id + '"></div></div>';
    }).join('') + '</div>';

    if (panelActive) return;

    // The provider list is fetched once and reused: it is the same for every
    // agent row and does not change while the page is open.
    let providerList = null;
    const loadProviders = async () => {
      if (providerList) return providerList;
      try {
        providerList = await (await fetch(BASE + '/providers')).json();
      } catch (err) {
        providerList = {providers: [], configured: []};
      }
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
            '<option value="' + esc(p.id) + '">' + esc(p.name) +
            (done.has(p.id) ? ' \u2713' : '') + '</option>').join('');
          providerField =
            '<select class="pv" style="flex:1 1 100%">' +
            '<option value="">Choose a provider' + (opts ? '' : ' (catalog unavailable)') + '</option>' +
            opts + '<option value="__custom">Other - type an id</option></select>' +
            '<input class="pv-custom" placeholder="Provider id, e.g. deepseek" ' +
            'style="flex:1 1 130px;display:none" />';
        }
        panelActive = agent;
        $('agent-' + agent).innerHTML =
          '<div class="panel-in"><div class="controls" style="flex-wrap:wrap">' + providerField +
          '<input class="kv-key" type="password" placeholder="API key" style="flex:1 1 150px" />' +
          '<button class="tiny save">Save</button>' +
          '<button class="ghost tiny cancelkey">Cancel</button></div><div class="out"></div></div>';
        const box = $('agent-' + agent);
        // Closing is what lets the list start refreshing again, so it needs to
        // be reachable without saving something.
        box.querySelector('.cancelkey').onclick = () => { panelActive = null; box.innerHTML = ''; load(); };
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
          const res = await fetch(BASE + '/auth/apikey', {method: 'POST',
            headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
          const data = await res.json();
          box.querySelector('.out').innerHTML = res.ok
            ? '<div class="notice" style="background:var(--muted)">Saved.</div>'
            : '<div class="notice err">' + esc(data.error) + '</div>';
          e.target.disabled = false;
          // Leave a failed attempt on screen with the key still in it; only a
          // success closes the form and lets the list resume.
          if (res.ok) { panelActive = null; setTimeout(load, 600); }
        };
      };
    }

    for (const b of document.querySelectorAll('.signin')) {
      b.onclick = async () => {
        const agent = b.dataset.agent;
        b.disabled = true;
        const box = $('agent-' + agent);
        box.innerHTML = '<div class="skeleton" style="width:70%"></div>';
        const res = await fetch(BASE + '/auth/signin', {method: 'POST',
          headers: {'content-type': 'application/json'}, body: JSON.stringify({agent})});
        const started = await res.json();
        if (!res.ok) {
          box.innerHTML = '<div class="notice err">' + esc(started.error) + '</div>';
          b.disabled = false; return;
        }
        panelActive = agent;
        const finish = (html) => {
          panelActive = null;
          box.innerHTML = html;
          b.disabled = false;
        };
        let painted = false;
        const poll = async () => {
          const st = await (await fetch(BASE + '/auth/session?id=' + started.id)).json();
          if (st.state === 'done') {
            finish('<div class="notice" style="background:var(--muted)">Signed in.</div>');
            load(); return;
          }
          if (st.state === 'failed' || st.state === 'cancelled') {
            finish('<div class="notice err">' + esc(st.error || 'Sign-in stopped') + '</div>');
            return;
          }
          // Paint once. Re-rendering on every poll would clear the code field
          // under whoever is pasting into it.
          if (st.url && !painted) {
            painted = true;
            // Two columns: the code you scan on the right, everything you
            // read or type on the left, so the QR stops pushing the field you
            // actually need down the page.
            box.innerHTML = '<div class="panel-in">' +
              '<div class="result"><div class="col">' +
              '<p class="meta" style="margin:0 0 8px">Open this on any device and approve:</p>' +
              '<div class="link">' + esc(st.url) + '</div>' +
              '<div class="controls" style="margin-top:10px">' +
              '<a href="' + esc(st.url) + '" target="_blank" rel="noopener">' +
              '<button class="ghost tiny">Open</button></a>' +
              (st.code ? '<span class="chip idle">Confirm code <strong>' + esc(st.code) +
                 '</strong></span>' : '') +
              '<button class="ghost tiny cancel">Cancel</button></div>' +
              (st.needsCode ? '<div class="controls" style="margin-top:10px">' +
                 '<input class="codein" placeholder="Paste the code from your browser" ' +
                 'style="flex:1 1 190px" />' +
                 '<button class="tiny sendcode">Submit</button></div>' : '') +
              '</div>' +
              (st.qr ? '<div class="qr">' + st.qr + '</div>' : '') +
              '</div></div>';
            const send = box.querySelector('.sendcode');
            if (send) send.onclick = async () => {
              send.disabled = true;
              send.textContent = 'Submitting';
              await fetch(BASE + '/auth/code', {method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({id: started.id, code: box.querySelector('.codein').value})});
            };
            box.querySelector('.cancel').onclick = async () => {
              await fetch(BASE + '/auth/cancel', {method: 'POST',
                headers: {'content-type': 'application/json'}, body: JSON.stringify({id: started.id})});
              finish('<div class="meta">Sign-in cancelled.</div>');
            };
          }
          setTimeout(poll, 2000);
        };
        poll();
      };
    }

    for (const b of document.querySelectorAll('.revoke')) {
      b.onclick = async () => {
        b.disabled = true; b.textContent = 'Revoking';
        await fetch(BASE + '/revoke', {method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({kind: b.dataset.kind, id: b.dataset.id})});
        load();
      };
    }
  };
  // ---------------------------------------------------------------------
  // Ports
  //
  // Polled separately from the rest of the page and on a shorter interval: a
  // tunnel takes a few seconds to be handed a hostname, and a port appearing
  // moments after a dev server starts is the whole point. This calls the same
  // /ports API t3-expose calls, so publishing from a terminal shows up here
  // without anything having to tell the page about it.
  // ---------------------------------------------------------------------
  const portsEl = $('ports');
  const portNote = $('portnote');
  let portsBusy = new Set();

  const loadPorts = async () => {
    let data;
    try {
      data = await (await fetch(BASE + '/ports')).json();
    } catch { return; }

    if (data.available === false) {
      portNote.textContent = 'cloudflared is not in this image, so publishing is off.';
      portsEl.innerHTML = '<div class="empty">Nothing to publish to.</div>';
      return;
    }

    const tunnels = new Map((data.tunnels || []).map((t) => [t.port, t]));
    const ports = [...new Set([...(data.listening || []), ...tunnels.keys()])]
      .sort((a, b) => a - b);
    const open = [...tunnels.values()].filter((t) => t.state === 'open').length;
    portNote.textContent = ports.length
      ? (open ? open + ' published' : 'Publish a dev server running in this container.')
      : 'Publish a dev server running in this container.';

    if (!ports.length) {
      portsEl.innerHTML = '<div class="empty">Nothing is listening yet.<br>'
        + 'Start a dev server and it will appear here.</div>';
      return;
    }

    portsEl.innerHTML = ports.map((port) => {
      const t = tunnels.get(port);
      const state = t ? t.state : 'idle';
      const busy = portsBusy.has(port);

      let right;
      if (state === 'open') {
        right = '<div class="actions">'
          + '<a class="btn ghost tiny" href="' + esc(t.url) + '" target="_blank" rel="noopener">Open</a>'
          + '<button class="ghost tiny unexpose" data-port="' + port + '">Stop</button></div>';
      } else if (state === 'starting' || busy) {
        right = '<div class="actions"><button class="ghost tiny" disabled>Publishing</button></div>';
      } else {
        right = '<div class="actions"><button class="ghost tiny expose" data-port="'
          + port + '">Publish</button></div>';
      }

      let detail;
      if (state === 'open') {
        // The URL is the payload here: monospace, selectable, and a QR beside
        // it because the device you want it on is usually not this one.
        detail = '<div class="portlive">'
          + '<a class="porturl" href="' + esc(t.url) + '" target="_blank" rel="noopener">'
          + esc(t.url) + '</a>'
          + (t.qr ? '<div class="qr">' + t.qr + '</div>' : '') + '</div>';
      } else if (state === 'failed') {
        detail = '<div class="meta err">' + esc(t.error || 'the tunnel failed') + '</div>';
      } else if (state === 'starting') {
        detail = '<div class="meta">Waiting for a public hostname\u2026</div>';
      } else {
        detail = '<div class="meta">Listening in the container</div>';
      }

      return '<div class="row"><div class="mono-tile port">' + port + '</div>'
        + '<div class="main"><div class="nameline"><span class="name">Port '
        + port + '</span></div>' + detail + '</div>' + right + '</div>';
    }).join('');

    for (const b of portsEl.querySelectorAll('.expose')) {
      b.onclick = async () => {
        const port = Number(b.dataset.port);
        portsBusy.add(port);
        b.disabled = true; b.textContent = 'Publishing';
        try {
          await fetch(BASE + '/ports/expose', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({port}),
          });
        } finally {
          portsBusy.delete(port);
        }
        loadPorts();
      };
    }
    for (const b of portsEl.querySelectorAll('.unexpose')) {
      b.onclick = async () => {
        b.disabled = true; b.textContent = 'Stopping';
        await fetch(BASE + '/ports/unexpose', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({port: Number(b.dataset.port)}),
        });
        loadPorts();
      };
    }
  };

  load();
  loadPorts();
  setInterval(load, 15000);
  setInterval(loadPorts, 4000);
}
