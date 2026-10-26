// The setup console.
//
// It lives in its own file, not inside a template literal in server.mjs, and
// that is deliberate: a template literal eats backslashes on the way out, so
// `/\s+/` reached the browser as `/s+/` and split names on the letter s. The
// same trap ate an apostrophe once before. `node --check` cannot catch either,
// because the corrupted result still parses. Kept as a real file, nothing
// rewrites it between here and the browser.
//
// Five scripts share one scope, in this order: client/base.js (BASE, where the
// API lives), design/ui.js (window.T3C: icons and copy), client/routes.js
// (T3Routes: the table of pages), client/model.js
// (T3Model: what every row, badge and step should say, as pure functions) and
// client/kit.js (Kit: markup, patching, overlays, toasts, keys). This file is
// the console on top of them:
//
//   data      /status every 15s (3s while work runs), /ports every 4s, paused
//             while the tab is hidden
//   routes    one per page in client/routes.js, plus #more on a phone
//   pages     one renderer per route, its head first, markup in, Kit.patch out
//   commands  every button carries data-cmd; the palette runs the same table
//   flows     pairing, sign-in, API keys, versions, confirmations
//
// The page keeps a few facts the server cannot know: a click still in flight
// (lifecycleBusy), an operation it is waiting to hear the end of
// (pendingOps), the error a row should keep showing (notices), a version typed
// but not yet installed (versionDrafts). Polling never repaints an overlay,
// and patching never undoes typing, focus or an expanded row.
(() => {
  'use strict';
  if (!document.getElementById('app')) return;

  const M = T3Model;
  const { html, raw, icon, cx, patch } = Kit;
  const $ = (id) => document.getElementById(id);
  const now = () => Date.now();
  const access = T3AccessState.create();
  let accessNotice = null;
  const closeAccessNotice = () => { accessNotice?.close(); accessNotice = null; };
  const accessToast = (message, options) => { closeAccessNotice(); accessNotice = Kit.toast(message, options); };

  // ------------------------------------------------------------- embedded --
  // Opened from T3 Code's settings, in a dialog over T3 Code
  // (docker/t3-client/setup-bridge.js), rather than on its own. The two
  // documents share an origin and talk by message: this page says when it is
  // ready, when the person asked to close it and how many things need them;
  // T3 Code passes its theme. Nothing else is accepted from anywhere else.
  const EMBED = document.documentElement.getAttribute('data-embed') === 't3' && window.parent !== window;
  const toHost = (type, detail) => {
    if (EMBED) window.parent.postMessage(Object.assign({ source: 't3-setup', type }, detail), location.origin);
  };
  // An embedded address opened in a tab of its own (copied, say) has nothing
  // to close back to: show the page as itself.
  if (!EMBED && document.documentElement.hasAttribute('data-embed')) {
    location.replace(BASE + '/' + location.hash);
    return;
  }

  // ------------------------------------------------------------------ api --
  let locked = false;
  /**
   * One request to the setup API. Never throws: the answer carries `ok`,
   * `status`, the parsed body and a sentence for the user when it failed.
   */
  const api = async (path, { body, method, headers = {}, signal, rawBody, onProgress } = {}) => {
    let res;
    try {
      if(rawBody!==undefined&&onProgress)res=await new Promise((resolve,reject)=>{
        const xhr=new XMLHttpRequest();let idle;
        const arm=()=>{clearTimeout(idle);idle=setTimeout(()=>xhr.abort(),120000);};
        const abort=()=>xhr.abort();
        const cleanup=()=>{clearTimeout(idle);signal?.removeEventListener('abort',abort);};
        xhr.open(method||'POST',BASE+path);xhr.withCredentials=true;
        for(const [name,value]of Object.entries({accept:'application/json','content-type':'application/octet-stream',...headers}))xhr.setRequestHeader(name,value);
        xhr.upload.onprogress=event=>{arm();onProgress(event.loaded);};
        xhr.onprogress=arm;
        xhr.onload=()=>{cleanup();resolve({status:xhr.status,ok:xhr.status>=200&&xhr.status<300,json:async()=>JSON.parse(xhr.responseText)});};
        xhr.onerror=()=>{cleanup();reject(new Error('The upload connection was interrupted.'));};
        xhr.onabort=()=>{cleanup();reject(new DOMException('Upload paused or interrupted','AbortError'));};
        if(signal?.aborted){reject(new DOMException('Aborted','AbortError'));return;}signal?.addEventListener('abort',abort,{once:true});arm();xhr.send(rawBody);
      });else res = await fetch(BASE + path, {
        method: method || (body === undefined && rawBody === undefined ? 'GET' : 'POST'),
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        signal,
        body: rawBody === undefined ? body === undefined ? undefined : JSON.stringify(body) : rawBody,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (error) {
      return { ok: false, status: 0, data: {}, error: 'Could not reach the setup service (' + (error.message || error) + ')' };
    }
    // The key changed (a recreated container generates a new one) or the
    // cookie expired. The page itself asks for the key again.
    if (res.status === 401 && !locked) {
      locked = true;
      // The unlock form is served at this same address: reload it (going to
      // the same address with a #page in it would only scroll).
      location.reload();
    }
    if (res.status === 304) return { ok: true, status: 304, data: null, error: null };
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data.ok !== false;
    return { ok, status: res.status, data, error: ok ? null : (data.error || 'HTTP ' + res.status) };
  };

  // ---------------------------------------------------------------- state --
  const state = {
    status: null,
    statusError: null,
    ports: null,
    portsAt: 0,
    providers: null,
    route: 'overview',
    // Instructions & skills' open tab, from the address: #instructions/skills.
    contextTab: 'instructions',
    toolFilter: '',
  };
  // What the page knows that /status cannot: see the header comment.
  const versionDrafts = new Map();   // agent id -> version typed in the dialog
  const lifecycleBusy = new Map();   // "harness:claude" -> kind, while the POST is in flight
  const pendingOps = new Map();      // accepted (202), waiting on /status for the end
  const notices = new Map();         // the last error or warning per row: {tone, text}
  const portsBusy = new Set();       // ports with a publish request in flight
  const expandedPorts = new Set();   // published ports showing their QR
  const ui = {
    busy: lifecycleBusy,
    pending: pendingOps,
    notices,
    portsBusy,
    expandedPorts,
    providerNames: [],
    signingIn: null,
    // A source control CLI being signed out, while its request runs.
    signingOut: null,
    // This page's own address, once confirmed to be T3 Code's too: see checkHere.
    here: null,
    updatePosting: false,
    updateAwaiting: false,
  };

  const harness = (id) => ((state.status && state.status.harnesses) || []).find((h) => h.id === id) || null;
  // A toolchain, or a source control CLI: both are run as toolchains.
  const toolchain = (id) => [...((state.status && state.status.toolchains) || []), ...((state.status && state.status.sourceControl) || [])]
    .find((t) => t.id === id) || null;
  const addedTool = (id) => ((state.status && state.status.packages) || []).find((p) => p.id === id) || null;
  const nameOf = (target, id) => target === 'harness' ? (M.AGENTS[id] || {}).name || (harness(id) || {}).name || id
    : target === 'package' ? (addedTool(id) || {}).name || M.toolName(id)
      : (M.TOOLCHAINS[id] || M.SOURCE_CONTROL[id] || {}).name || (toolchain(id) || {}).name || id;
  // Where each kind of row's operations live in the API.
  const LIFECYCLE_PATH = { harness: 'harnesses', toolchain: 'toolchains', package: 'packages' };
  const storageUI = T3StorageUI.create({ api, getStatus: () => state.status, reload: () => loadStatus(), render: () => render() });
  const skillsUI = T3SkillsUI.create({ api, getStatus: () => state.status, render: () => render(),
    readMarkdown: (file) => readMarkdownFile(file, 64 * 1024), downloadMarkdown: (...args) => downloadMarkdown(...args) });
  const mcpUI = T3McpUI.create({ api, getStatus: () => state.status, render: () => render() });
  const credentialsUI = T3CredentialsUI.create({ api, render: () => render() });
  const filesUI = T3FilesUI.create({ api, base: BASE, getStatus: () => state.status, getRoute: () => state.route, render: () => render(), go: route => go(route) });

  /** Whether this browser came in on its T3 Code session rather than the key, so Lock would end nothing. */
  const viaT3 = (s) => Boolean(s && s.viewer && s.viewer.via === 't3');

  /** Where "Open T3 Code" goes: the public URL, else T3 Code beside this page. */
  const t3Url = () => {
    const s = state.status;
    if (s && s.publicUrl) return s.publicUrl;
    if (BASE) return '/';
    const port = (s && s.t3 && s.t3.port) || 3773;
    return location.protocol + '//' + location.hostname + ':' + port + '/';
  };

  // --------------------------------------------------------------- polling --
  const POLL_MS = 15000;
  const FAST_MS = 3000;
  const PORTS_MS = 4000;
  let statusTimer = null;
  let portsTimer = null;
  let statusLoading = null;
  let portsLoading = null;

  const busyNow = (s) => Boolean(s && (
    storageUI.isBusy()
    ||
    s.updates?.refreshing
    || M.runtimeView(s)?.busy
    || ui.runtimeChecking
    || (s.setup && s.setup.state === 'running')
    || pendingOps.size > 0
    || Object.values(s.operations || {}).some((op) => op.state === 'running' || op.state === 'queued')
    || (s.harnesses || []).some((h) => h.inProgress)
    || (s.toolchains || []).some((t) => t.inProgress)
    || (s.packages || []).some((p) => p.inProgress)));

  // The address this page is open on can be offered as the public URL when it
  // is T3 Code's too: the console under a prefix on T3's own origin (one port,
  // or a proxy routing by path), or inside T3 Code's dialog. Confirmed rather
  // than assumed: this origin's /.well-known/t3/environment has to name the
  // environment the server reports for its own T3 Code.
  let hereChecked = false;
  const LOOPBACK_HOST = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
  const checkHere = async () => {
    const s = state.status;
    const id = s && s.server && s.server.environmentId;
    if (hereChecked || !id || !(BASE || EMBED)) return;
    hereChecked = true;
    try {
      const res = await fetch('/.well-known/t3/environment', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } });
      const body = res.ok ? await res.json() : null;
      if (!body || body.environmentId !== id) return;
      ui.here = { url: location.origin, local: LOOPBACK_HOST.test(location.hostname) };
      render();
    } catch {
      // Not answering right now; the next poll asks again.
      hereChecked = false;
    }
  };

  const loadStatus = () => {
    if (statusLoading) return statusLoading;
    statusLoading = (async () => {
      const accessRevision = access.revision;
      const res = await api('/status');
      if (res.ok) {
        state.status = access.reconcile(res.data, state.status, accessRevision);
        state.statusError = null;
        settleOperations(res.data);
        settleRuntime(res.data);
        settleSoftwareCheck(res.data);
        storageUI.observe(res.data.storage);
        trackPairing(res.data);
        loadProvidersOnce();
        tellAttention();
        checkHere();
        if (state.route === 'instructions' && state.contextTab === 'skills') skillsUI.activate();
        if (state.route === 'mcp') mcpUI.activate();
        if (state.route === 'credentials') credentialsUI.activate();
        if (state.route === 'files') filesUI.activate();
        if (state.route === 'instructions' && state.contextTab === 'instructions') void loadInstructionsPreview();
      } else if (!locked) {
        // Name the URL and the reason. "Could not read status" sent someone
        // hunting a migration bug when the page was calling the wrong path.
        state.statusError = res.error;
      }
      render();
      clearTimeout(statusTimer);
      const readingDevices = Object.values(state.status?.authLists || {}).some((entry) => entry.refreshing);
      if (!document.hidden && !locked) statusTimer = setTimeout(loadStatus, busyNow(state.status) || readingDevices || access.busy || pair.minting ? FAST_MS : POLL_MS);
    })().finally(() => { statusLoading = null; });
    return statusLoading;
  };

  // T3 Code shows the count beside Setup; the closed dialog keeps the last one.
  let toldAttention = null;
  const tellAttention = () => {
    const count = M.attentionCount(state.status, null, ui);
    if (count !== toldAttention) toHost('attention', { count });
    toldAttention = count;
  };

  // Polled separately and more often: a tunnel takes a few seconds to be
  // handed a hostname, and a port appearing moments after a dev server starts
  // is the whole point. This is the same /ports API t3-expose calls, so
  // publishing from a terminal shows up here without anything telling the page.
  const loadPorts = () => {
    if (portsLoading) return portsLoading;
    portsLoading = (async () => {
      const res = await api('/ports');
      if (res.ok) { state.ports = res.data; state.portsAt = now(); }
      render();
      clearTimeout(portsTimer);
      if (!document.hidden && !locked) portsTimer = setTimeout(loadPorts, PORTS_MS);
    })().finally(() => { portsLoading = null; });
    return portsLoading;
  };

  // A hidden tab polls nothing; coming back catches up at once.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(statusTimer); clearTimeout(portsTimer); return; }
    loadStatus();
    loadPorts();
  });

  // OpenCode's row names its provider keys, and the key sheet lists them.
  let providersAsked = false, providersPending = null, providersTimer = null, providersRead = 0;
  const loadProviders = (refresh = false) => {
    if (providersPending && !refresh) return providersPending;
    clearTimeout(providersTimer);
    const read = ++providersRead;
    providersPending = (async () => {
      const res = await api('/providers' + (refresh ? '?refresh=1' : ''));
      if (read !== providersRead) return state.providers;
      providersPending = null;
      if (res.ok) {
        state.providers = res.data;
        const names = new Map((res.data.providers || []).map((p) => [p.id, p.name]));
        ui.providerNames = (res.data.configured || []).map((id) => names.get(id) || id);
      } else {
        state.providers = { ...(state.providers || {}), credentials: { ...(state.providers?.credentials || {}),
          stale: true, refreshing: false, error: 'Saved sign-ins could not be checked. Try again.' } };
      }
      // Native account reads warm in the background. Follow their progress
      // without clearing drafts or starting another native process per poll.
      if (state.providers?.credentials?.refreshing) providersTimer = setTimeout(() => {
        loadProviders().then(() => { render(); renderKeySheet(); });
      }, 1000);
      return state.providers;
    })();
    return providersPending;
  };
  const loadProvidersOnce = () => {
    if (providersAsked) return;
    const oc = harness('opencode');
    if (!oc || !oc.installed) return;
    providersAsked = true;
    loadProviders().then(render);
  };

  // ------------------------------------------------------------ operations --
  /** A click accepted earlier has finished: say how, once. */
  const settleOperations = (s) => {
    for (const [key, pending] of pendingOps) {
      const op = (s.operations || {})[key];
      // The id may hold colons of its own: package:npm:prettier.
      const target = key.slice(0, key.indexOf(':'));
      const id = key.slice(target.length + 1);
      if (!op) {
        // The setup service restarted and forgot it. Once nothing is running
        // for this row any more, stop waiting: the row shows where it ended.
        const facts = target === 'harness' ? harness(id) : target === 'package' ? addedTool(id) : toolchain(id);
        if (now() - pending.at > 10000 && !(facts && facts.inProgress)) {
          pendingOps.delete(key);
          notices.set(key, { tone: 'warn', text: 'The setup service restarted during this ' + pending.kind + '; the row shows where it ended up.' });
        }
        continue;
      }
      if (op.state === 'running' || op.state === 'queued') continue;
      pendingOps.delete(key);
      if (op.state === 'ok') {
        if (op.warning) notices.set(key, { tone: 'warn', text: op.warning });
        else notices.delete(key);
        Kit.toast(op.message || M.DONE[op.kind] + ' ' + pending.name, op.changed === false ? { tone: 'info' } : {});
      } else if (op.state === 'cancelled') {
        notices.delete(key);
        Kit.toast('Cancelled: ' + pending.kind + ' ' + pending.name, { tone: 'info' });
      } else {
        const text = op.error || 'Could not ' + op.kind + ' ' + pending.name;
        notices.set(key, { tone: 'danger', text });
        const route = target === 'harness' ? 'agents' : M.SOURCE_CONTROL[id] ? 'sourcecontrol' : 'toolchains';
        Kit.toast(M.FAILED[op.kind] + ': ' + pending.name, {
          tone: 'danger',
          detail: text,
          action: state.route === route ? null : { label: 'View', run: () => go(route) },
        });
      }
    }
  };

  /**
   * Install, update or uninstall. The POST answers 202 as soon as the work
   * holds the lock (or is queued behind other work); /status says how it ends.
   */
  const callLifecycle = async (target, kind, id, version) => {
    const key = target + ':' + id;
    const name = nameOf(target, id);
    notices.delete(key);
    lifecycleBusy.set(key, kind);
    render();
    const res = await api('/' + LIFECYCLE_PATH[target] + '/' + kind, { body: version ? { id, version } : { id } });
    lifecycleBusy.delete(key);
    if (res.status === 202) {
      pendingOps.set(key, { kind, name, at: now() });
      if (target === 'harness') versionDrafts.delete(id);
    } else if (!res.ok) {
      notices.set(key, { tone: 'danger', text: res.error || 'Could not ' + kind + ' ' + name });
    } else {
      if (target === 'harness') versionDrafts.delete(id);
      notices.delete(key);
      Kit.toast(res.data.message || M.DONE[kind] + ' ' + name, res.data.changed === false ? { tone: 'info' } : {});
    }
    render();
    await loadStatus();
    return res;
  };

  const cancelOperation = async (target, id) => {
    const res = await api('/' + LIFECYCLE_PATH[target] + '/cancel', { body: { id } });
    if (!res.ok) Kit.toast('Could not cancel', { tone: 'danger', detail: res.error });
    await loadStatus();
  };

  const confirmUninstall = async (target, id) => {
    const name = nameOf(target, id);
    const facts = target === 'harness' ? harness(id) : target === 'package' ? addedTool(id) : toolchain(id);
    const version = facts && (facts.installedVersion || facts.version);
    const ok = await Kit.confirm(target === 'package'
      ? {
        title: 'Uninstall ' + name + '?',
        body: 'Removes ' + name + (version ? ' ' + version : '') + ' from your global mise config and from the volume. A project that pins its own version in mise.toml still gets that one.',
        consequences: [
          { icon: 'trash-2', text: 'Removed: every release this console installed' },
          { icon: 'shield-check', text: 'Kept: project pins in mise.toml and .tool-versions' },
          { icon: 'plus', text: 'Add it again any time from Add a tool' },
        ],
        confirm: 'Uninstall',
      }
      : facts && facts.managedBy === 't3'
      ? {
        title: 'Uninstall ' + name + '?',
        body: 'T3 Code removes the ' + name + ' runtime it downloaded' + (version ? ' (' + version + ')' : '') + ' and turns ' + name + ' off. Anything running in ' + name + ' has to stop first.',
        consequences: [
          { icon: 'trash-2', text: 'Removed: the runtime, from T3 Code’s data on the volume' },
          { icon: 'shield-check', text: 'Kept: T3 Code’s ' + name + ' profile and its Google sign-in' },
          { icon: 'download', text: 'Install it again any time from here' },
        ],
        confirm: 'Uninstall',
      }
      : M.SOURCE_CONTROL[id]
      ? {
        title: 'Uninstall ' + name + '?',
        body: 'Removes ' + name + (version ? ' ' + version : '') + ' from the volume. T3 Code stops offering ' + M.SOURCE_CONTROL[id].provider + ' pull requests until it is installed again.',
        consequences: [
          { icon: 'trash-2', text: 'Removed: every release this console installed' },
          { icon: 'shield-check', text: 'Kept: its sign-in, so installing again signs you straight back in' },
          { icon: 'lock', text: 'Stays uninstalled across restarts' },
        ],
        confirm: 'Uninstall',
      }
      : target === 'harness'
      ? {
        title: 'Uninstall ' + name + '?',
        body: 'Removes ' + (version ? 'the ' + version + ' executable' : 'the executable') + ' and its T3 Code wiring. Your sign-in and user data stay on the volume, so installing again signs you straight back in.',
        consequences: [
          { icon: 'trash-2', text: 'Removed: the CLI and T3 Code’s provider path' },
          { icon: 'shield-check', text: 'Kept: credentials, settings, history' },
          { icon: 'lock', text: 'Stays uninstalled across restarts' },
        ],
        confirm: 'Uninstall',
      }
      : {
        title: 'Uninstall ' + name + '?',
        body: 'Removes ' + name + (version ? ' ' + version : '') + ' from the volume. A project that pins its own version in mise.toml still gets that one from mise.',
        consequences: [
          { icon: 'trash-2', text: 'Removed: every release this console installed' },
          { icon: 'shield-check', text: 'Kept: project pins in mise.toml and .tool-versions' },
          { icon: 'lock', text: 'Stays uninstalled across restarts' },
        ],
        confirm: 'Uninstall',
      });
    if (ok) callLifecycle(target, 'uninstall', id);
  };

  /**
   * "Update all": one request each; the server runs them one after another.
   * `tools` is the Toolchains page's: the toolchains and the added tools;
   * `scm` the Source control page's CLIs; `all` the Updates page's, every one
   * of them but T3 Code, which restarts and so updates on its own button.
   */
  const updateAll = async (target) => {
    const rows = target === 'all' ? M.updatesView(state.status, ui, now()).due
      : target === 'harness' ? M.agentRows(state.status, ui, now())
        : target === 'scm' ? M.managedSourceControlRows(state.status, ui, now())
          : [...M.toolchainRows(state.status, ui, now()), ...M.packageRows(state.status, ui, now())];
    const due = rows.filter((r) => r.updateAvailable && r.state !== 'running' && r.state !== 'queued');
    if (!due.length) { Kit.toast('Everything is up to date', { tone: 'info' }); return; }
    for (const row of due) await callLifecycle(row.target, 'update', row.id);
  };

  // ---------------------------------------------------------- auto-update --
  // Agents, toolchains and T3 Code each have a switch on the Updates page that
  // saves as it is pressed, and a schedule of their own: how often to look for
  // a release, and how long the server must be quiet before one installs.
  const AUTO_NAMES = { providers: 'Agents', toolchains: 'Toolchains and tools', t3: 'T3 Code' };
  const confirmT3AutoUpdate = () => Kit.confirm({
    title: 'Update T3 Code automatically?',
    body: 'T3 Code is alpha software: a release can break it, or how it works with this setup console. Updates would install without asking, once nothing has used the server for a while.',
    consequences: [
      { icon: 'circle-stop', text: 'Only T3 Code restarts. Active agent turns and terminals stop, and open apps reconnect.' },
      { icon: 'shield-check', text: 'It stays on your Stable or Nightly channel, and goes back to the last version if a new one fails to start.' },
    ],
    confirm: 'Turn on automatic updates', tone: 'primary',
  });

  /** Save one category's change on top of the policy as it stands. */
  const saveAutoPolicy = async (kind, change) => {
    const policy = JSON.parse(JSON.stringify(M.autoUpdateView(state.status, now()).policy));
    Object.assign(policy[kind], change);
    autoSaving.add(kind);
    render();
    const res = await api('/auto-update/policy', { body: policy });
    autoSaving.delete(kind);
    if (!res.ok) {
      Kit.toast('Couldn’t save automatic updates', { tone: 'danger', detail: res.error || 'Try again.' });
      render();
      return false;
    }
    await loadStatus();
    return true;
  };

  const toggleAuto = async (kind) => {
    if (autoSaving.has(kind) || !AUTO_NAMES[kind]) return;
    const on = !M.autoUpdateView(state.status, now()).policy[kind].enabled;
    // T3 Code restarts itself to update: that is said, and agreed to, first.
    if (kind === 't3' && on && !(await confirmT3AutoUpdate())) return;
    const saved = await saveAutoPolicy(kind, { enabled: on });
    const toggle = document.querySelector('[data-key="auto-toggle-' + kind + '"]');
    if (toggle && toggle.isConnected) toggle.focus({ preventScroll: true });
    if (saved) Kit.announce(AUTO_NAMES[kind] + ': automatic updates ' + (on ? 'on' : 'off'));
  };

  const openSchedule = (kind, trigger) => {
    const policy = M.autoUpdateView(state.status, now()).policy[kind];
    if (!policy || !AUTO_NAMES[kind]) return;
    let saving = false;
    const layer = Kit.open({
      kind: 'center', returnTo: trigger, focus: '#auto-check',
      panel: { tag: 'form', class: 'tc-dialog tc-auto-schedule', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'auto-schedule-title', 'aria-describedby': 'auto-schedule-desc', novalidate: true },
      render: () => html`<div class="tc-dialog-body">
          <h2 class="tc-dialog-title" id="auto-schedule-title">${AUTO_NAMES[kind]}: when to update</h2>
          <p class="tc-dialog-desc" id="auto-schedule-desc">How often to look for a new release, and how long the server must be quiet before one installs.</p>
          <div class="tc-storage-budgets">
            <div class="tc-field"><label class="tc-label" for="auto-check">Check every</label><div class="tc-storage-input"><input class="tc-input" type="number" min="0.25" max="24" step="0.25" id="auto-check" value="${Math.round((policy.checkMinutes || 180) / 60 * 100) / 100}" inputmode="decimal"><span>hours</span></div></div>
            <div class="tc-field"><label class="tc-label" for="auto-idle">Install after</label><div class="tc-storage-input"><input class="tc-input" type="number" min="5" max="480" step="5" id="auto-idle" value="${policy.idleMinutes || 30}" inputmode="numeric"><span>min quiet</span></div></div>
          </div>
          <p class="tc-hint">Quiet means no T3 Code client and no setup page has done anything. Agent turns already running inside T3 Code aren’t visible here, so pick a window that fits how you work.</p>
          <p class="tc-hint tc-hint--err" id="auto-schedule-error" role="alert" hidden></p>
        </div>
        <div class="tc-dialog-foot"><button class="tc-btn tc-btn--ghost" type="button" data-schedule-cancel>Cancel</button><button class="tc-btn tc-btn--primary" type="submit" data-schedule-save>Save</button></div>`,
    });
    const panel = layer.panel;
    const message = (text) => { const el = panel.querySelector('#auto-schedule-error'); el.textContent = text; el.hidden = !text; };
    const read = (selector, min, max, words) => {
      const el = panel.querySelector(selector);
      const value = Number(el.value);
      el.removeAttribute('aria-invalid');
      if (!el.value.trim() || !Number.isFinite(value) || value < min || value > max) {
        el.setAttribute('aria-invalid', 'true');
        message(words);
        el.focus();
        return null;
      }
      return value;
    };
    panel.addEventListener('click', (event) => { if (event.target.closest('[data-schedule-cancel]') && !saving) layer.close('cancel'); });
    panel.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;
      const hours = read('#auto-check', 0.25, 24, 'Check between every 0.25 and every 24 hours.');
      if (hours === null) return;
      const idle = read('#auto-idle', 5, 480, 'Wait between 5 and 480 minutes.');
      if (idle === null) return;
      saving = true;
      message('');
      panel.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
      const ok = await saveAutoPolicy(kind, { checkMinutes: Math.round(hours * 60), idleMinutes: Math.round(idle) });
      saving = false;
      if (layer.closed) return;
      if (!ok) { panel.querySelectorAll('button, input').forEach((el) => { el.disabled = false; }); message('Couldn’t save. Try again.'); return; }
      layer.close('saved');
      Kit.toast(AUTO_NAMES[kind] + ' schedule saved', { tone: 'info' });
    });
  };

  // ------------------------------------------------------------- markup --
  // An agent shows its own mark; anything without one, its monogram.
  const tile = (row, size) => row.icon && !row.mark ? html`<span class="${cx('tc-tile tc-tile--icon', size && 'tc-tile--' + size)}" aria-hidden="true">${icon(row.icon)}</span>`
    : row.mark && T3C.agentMarks[row.mark]
    ? html`<span class="${cx('tc-tile tc-tile--mark', size && 'tc-tile--' + size, row.dim && 'tc-tile--dim')}" aria-hidden="true">${raw(T3C.agentMark(row.mark))}</span>`
    : html`<span class="${cx('tc-tile', size && 'tc-tile--' + size, row.dim && 'tc-tile--dim')}" style="--_tile: var(${row.hue})" aria-hidden="true">${row.mono}</span>`;
  const dot = (tone, extra) => html`<span class="${cx('tc-dot', 'tc-dot--' + tone, extra)}"></span>`;
  const badge = (b) => b ? html`<span class="${cx('tc-badge', b.tone && 'tc-badge--' + b.tone)}">${b.spinner ? html`<span class="tc-spinner" aria-hidden="true"></span>` : ''}${b.text}</span>` : '';
  const statusLine = (st, attrs) => html`<span class="tc-status"${attrs || ''}>${st.dot ? dot(st.dot) : ''}<span class="tc-status-text">${st.text}${st.code ? html` <code>${st.code}</code>` : ''}</span></span>`;
  const noticeLine = (n) => n ? html`<span class="tc-status" role="${n.tone === 'danger' ? 'alert' : 'status'}">${dot(n.tone === 'danger' ? 'danger' : 'warn')}<span class="tc-status-text">${n.text}</span></span>` : '';
  const versionLabel = (row) => {
    if (!row.version) return '';
    if (row.versionTo) return html`<span class="tc-version">${row.version} <span class="tc-version-arrow" aria-label="to">→</span> ${row.versionTo}</span>`;
    // A newer release says where it goes; while work runs the row shows its progress instead.
    const next = row.updateAvailable && row.state !== 'running' && row.state !== 'queued';
    return html`<span class="tc-version">${row.version}${next ? html` <span class="tc-version-arrow" aria-label="update available:">→</span> <span class="tc-version-to">${row.latest}</span>` : ''}</span>`;
  };
  const progressBar = (p) => html`<div class="tc-progress"${p && p.pct !== null ? '' : raw(' data-indeterminate')} style="--value: ${p && p.pct !== null ? p.pct : 0}%" role="progressbar" aria-label="Progress"${p && p.pct !== null ? raw(' aria-valuenow="' + p.pct + '" aria-valuemin="0" aria-valuemax="100"') : ''}><span></span></div>`;
  const phaseText = (p, kind) => {
    if (p && p.phase) return p.phase[0].toUpperCase() + p.phase.slice(1);
    return (M.WORKING[kind] || 'Working') + '…';
  };
  const opLine = (row) => html`<div class="tc-op tc-row-op"><span class="tc-op-line tc-muted">${phaseText(row.progress, row.kind)}</span><span class="tc-op-pct">${M.progressText(row.progress)}</span>${progressBar(row.progress)}</div>`;

  const btnClass = (variant, size) => cx('tc-btn', size || 'tc-btn--sm', variant && 'tc-btn--' + variant);
  const actionButton = (row, opts) => {
    const a = row.action;
    if (!a) return '';
    // A list of calls to action (Needs you) keeps every button alike.
    const variant = opts.plain ? null : a.variant === 'primary' && opts.primary === false ? null : a.variant;
    return html`<button class="${btnClass(variant)}" type="button" data-cmd="${a.cmd}" data-target="${row.target}" data-id="${row.id}" data-key="act-${row.key}">${a.icon ? icon(a.icon) : ''}${a.label}</button>`;
  };
  // Only real controls occupy the action group; its last control uses the row inset.
  const menuButton = (row) => row.menu.length
    ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" aria-label="More for ${row.name}" aria-haspopup="menu" aria-expanded="${String(Kit.menuOpenFor('menu-' + row.key))}" data-cmd="row.menu" data-target="${row.target}" data-id="${row.id}" data-key="menu-${row.key}">${icon('ellipsis')}</button>`
    : '';

  /** An agent or toolchain row: tile, name and version, one status line, one verb, a menu. */
  const resourceRow = (row, opts = {}) => {
    const error = M.rowError(row);
    const noticeError = M.rowError(row, 'notice');
    const detail = (source) => html` <button class="tc-row-details" type="button" data-cmd="row.error" data-target="${row.target}" data-id="${row.id}" data-source="${source}" data-key="error-${source}-${row.key}" aria-label="${source === 'notice' ? 'Notice' : 'Error'} details for ${row.name}">Details</button>`;
    return html`
    <div class="${cx('tc-row tc-row--compact', (row.state === 'running' || row.state === 'signing') && 'tc-row--expanded')}" data-key="row-${row.key}">
      ${tile(row)}
      <div class="tc-row-main">
        <div class="tc-row-title"><span class="tc-row-name"${row.description ? html` title="${row.description}"` : ''}>${row.name}</span>${versionLabel(row)}${badge(row.badge)}</div>
        ${error ? html`<span class="tc-status" role="alert">${dot('danger')}<span class="tc-status-text">${error.text}${detail('status')}</span></span>` : statusLine(row.status, row.status.dot === 'danger' ? raw(' role="alert"') : '')}
        ${noticeError ? html`<span class="tc-status" role="alert">${dot('danger')}<span class="tc-status-text">${noticeError.text}${detail('notice')}</span></span>` : noticeLine(row.notice)}
        ${row.state === 'running' ? opLine(row) : ''}
      </div>
      <div class="${cx('tc-row-actions', opts.wrap && 'tc-row-actions--wrap')}">${actionButton(row, opts)}${opts.menu === false ? '' : menuButton(row)}</div>
    </div>`;
  };

  const section = (id, title, body, { actions, level } = {}) => html`
    <section class="tc-section" data-key="${id}" aria-labelledby="${id}">
      <div class="tc-section-head"><${raw(level || 'h2')} class="tc-section-title" id="${id}">${title}</${raw(level || 'h2')}>${actions ? html`<div class="tc-section-actions">${actions}</div>` : ''}</div>
      ${body}
    </section>`;
  /**
   * The top of every page: its title, one line saying what it is for with a
   * link to the guide that explains the rest, and the page's main action.
   * Pages carry no explanation tables of their own; the guide is one press away.
   */
  const learnMore = (doc) => doc ? html`<a class="tc-page-learn" href="${T3Routes.docUrl(doc, state.status?.image?.version)}" target="_blank" rel="noopener">Learn more<span class="tc-sr"> (opens the guide in a new tab)</span></a>` : '';
  const pageHead = (route, { title, sub, actions, doc } = {}) => {
    const page = T3Routes.page(route) || {};
    const line = sub === undefined ? page.summary : sub;
    const guide = doc === undefined ? page.doc : doc;
    return html`
      <header class="tc-page-head" data-key="page-head">
        <div class="tc-page-head-text">
          <h1 class="tc-page-title" id="title-${route}">${title || page.title}</h1>
          ${line || guide ? html`<p class="tc-page-sub">${line || ''}${line && guide ? ' ' : ''}${learnMore(guide)}</p>` : ''}
        </div>
        ${actions ? html`<div class="tc-page-head-actions">${actions}</div>` : ''}
      </header>`;
  };
  const muted = (text) => html`<span class="tc-small tc-muted">${text}</span>`;
  // An empty state's icon, on its card with two more fanned out behind it.
  const emptyIcon = (name, cls) => html`<span class="tc-empty-media" aria-hidden="true"><span class="tc-empty-icon">${icon(name, cls)}</span></span>`;
  const linkButton = (href, label, extra) => html`<a class="tc-btn tc-btn--ghost tc-btn--ghost-muted tc-btn--xs" href="${href}"${extra || ''}>${label}${icon('arrow-right')}</a>`;
  const notice = (tone, iconName, title, desc, action) => html`
    <div class="${cx('tc-notice', tone && 'tc-notice--' + tone)}"${tone === 'danger' ? raw(' role="alert"') : ''}>${icon(iconName)}<div class="tc-notice-body">${title ? html`<span class="tc-notice-title">${title}</span>` : ''}${desc ? html`<span class="tc-notice-desc">${desc}</span>` : ''}</div>${action || ''}</div>`;
  // `size` is a tc-btn size class; '' is the default size, absent is xs.
  const copyButton = (text, label, opts = {}) => {
    const size = opts.size === undefined ? 'tc-btn--xs' : opts.size;
    return opts.iconOnly
      ? html`<button class="${cx('tc-btn tc-btn--icon', opts.ghost !== false && 'tc-btn--ghost', size)}" type="button" data-cmd="copy" data-text="${text}" aria-label="${label}">${icon('copy')}</button>`
      : html`<button class="${cx('tc-btn', opts.ghost !== false && 'tc-btn--ghost', size)}" type="button" data-cmd="copy" data-text="${text}">${icon('copy')}<span data-label>${label || 'Copy'}</span></button>`;
  };
  // `wrap` shows a long value whole, over several lines, rather than cut short.
  const copyField = (value, { code, actions, label, wrap } = {}) => html`
    <div class="${cx('tc-copyfield', code && 'tc-copyfield--code')}"${wrap ? raw(' data-wrap') : ''}><span class="tc-copyfield-value">${value}</span><span class="tc-copyfield-actions">${actions || copyButton(value, label)}</span></div>`;
  /**
   * qrencode's SVG, minus its XML prolog and the root's size in centimetres,
   * so the stylesheet sizes it. Only the root tag is touched: every module is
   * a <rect> with a width and height of its own.
   */
  const qrSvg = (svg) => {
    const text = String(svg || '');
    const at = text.indexOf('<svg');
    if (at < 0) return '';
    const tag = text.indexOf('>', at);
    return raw(text.slice(at, tag).replace(/\s(width|height)="[^"]*"/g, '') + text.slice(tag));
  };
  const skeletonGroup = (rows) => html`<div class="tc-group" aria-hidden="true">${Array.from({ length: rows }, (_, i) => html`<div class="tc-skel-row"><span class="tc-skel tc-skel--tile"></span><span class="tc-skel" style="width:${[38, 52, 30, 44][i % 4]}%"></span></div>`)}</div>`;

  // ------------------------------------------------------- page notices --
  /**
   * What could not be read, above the page it affects. Only failures are
   * said: a slow read, or one answered from the last check while a fresh one
   * runs, fills in by itself and is no news to anyone.
   */
  const pageNotices = (route) => {
    const s = state.status;
    const out = [];
    if (state.statusError) {
      out.push(notice('danger', 'circle-alert', 'Couldn’t reach the setup service',
        html`From <code>${BASE + '/status'}</code>: ${state.statusError}.${BASE ? '' : html` If this page is served under a path prefix, set <code>T3_SETUP_BASE_PATH</code>.`}`,
        html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="refresh">${icon('refresh-cw')}Retry</button>`));
    }
    if (!s) return out;
    // What the first start is still installing, on every page but Overview,
    // whose checklist and activity already say it.
    const banner = M.setupBanner(s);
    if (banner && route !== 'overview') {
      out.push(html`<div class="tc-notice tc-notice--progress" role="status" data-key="setup-progress"><span class="tc-spinner tc-info" aria-hidden="true"></span><div class="tc-notice-body"><span class="tc-notice-desc"><strong>First start</strong> · ${banner.text}</span></div>${progressBar({ pct: banner.pct })}<span class="tc-op-pct">${banner.done}/${banner.total}</span></div>`);
    }
    // A part that could not be read says so, instead of rendering as "none".
    if ((s.degraded || []).length) {
      out.push(notice('warn', 'triangle-alert', 'Some details couldn’t be read',
        'Couldn’t read ' + M.listOf(s.degraded.map((d) => d.what)) + '. The console tries again on its own.'));
    }
    if ((route === 'access' || route === 'overview') && Object.values(s.authLists || {}).some((entry) => entry.error)) {
      out.push(notice('warn', 'triangle-alert', 'Couldn’t refresh the device list',
        'Showing devices from the last check. The console keeps trying.'));
    }
    const setup = s.setup;
    if (setup && ['overview', 'agents', 'toolchains', 'sourcecontrol', 'updates'].includes(route)) {
      const items = setup.items || [];
      // After a finished run, anything still pending was not tried: the run
      // stops after three failures in a row, which is nearly always no network.
      const failed = M.setupFailures(s);
      if (setup.state !== 'running' && failed.length) {
        const title = failed.length === 1 ? 'First start couldn’t install ' + (failed[0].name || failed[0].id)
          : 'First start left ' + M.plural(failed.length, 'install') + ' unfinished';
        out.push(notice('warn', 'triangle-alert', title,
          html`Try again from ${failed.length === 1 ? 'its row' : 'each row'}. <button class="tc-row-details" type="button" data-cmd="setup.errors" data-key="setup-errors-${route}" aria-label="Setup failure details">Details</button>`));
      } else if (setup.state === 'interrupted') {
        const done = items.filter((i) => i.state === 'done').length;
        out.push(notice(null, 'history', 'First start stopped part way', done + ' of ' + items.length + ' installed. It carries on the next time the container starts.'));
      }
    }
    return out;
  };

  // ------------------------------------------------------------- overview --
  const stepAction = (a, size) => {
    if (!a) return '';
    const cls = cx('tc-btn', a.variant === 'primary' && 'tc-btn--primary', a.variant === 'ghost' && 'tc-btn--ghost', size || 'tc-btn--sm');
    if (a.cmd === 'goto') return html`<a class="${cls}" href="#${a.route}">${a.icon ? icon(a.icon) : ''}${a.label}</a>`;
    return html`<button class="${cls}" type="button" data-cmd="${a.cmd}"${a.copy ? html` data-text="${a.copy}"` : ''}>${a.icon ? icon(a.icon) : ''}${a.label}</button>`;
  };

  const readinessGroup = (r) => {
    const next = r.steps.find((step) => step.state === 'todo');
    return html`
      <section class="tc-group tc-group--brand" aria-labelledby="ready-title" data-key="readiness">
        <div class="tc-ready">
          <div class="tc-ready-head">
            <div class="tc-ready-heading"><span class="tc-small tc-muted">Setup · ${r.done} of ${r.total} done</span><h2 class="tc-ready-title" id="ready-title">${r.title}</h2></div>
            <span class="tc-spacer"></span>
            <div class="tc-ready-meter" aria-hidden="true">${r.steps.map((step) => html`<span${step.done ? raw(' data-done') : ''}></span>`)}</div>
          </div>
          <p class="tc-page-lede">${r.lede}</p>
          ${next && next.action ? html`<div class="tc-phone-only tc-ready-cta">${stepAction(next.action, 'tc-btn--block')}${next.alt ? stepAction(Object.assign({ variant: 'ghost' }, next.alt), 'tc-btn--block') : ''}</div>` : ''}
        </div>
        <ol class="tc-checklist">
          ${r.steps.map((step, i) => html`
            <li class="${cx('tc-check', step.state === 'todo' && step.action && 'tc-desk-only')}" data-state="${step.state}" data-key="step-${step.id}">
              <span class="tc-check-mark">${step.done ? icon('check') : String(i + 1)}</span>
              <span class="tc-check-title">${step.title}</span>
              ${step.done && step.aside ? html`<span class="tc-check-aside tc-mono tc-muted">${step.aside}</span>` : ''}
              ${step.alt ? html`<span class="tc-check-actions">${stepAction(Object.assign({ variant: 'ghost' }, step.alt))}${stepAction(step.action)}</span>` : stepAction(step.action)}
              ${!step.done && step.desc ? html`<span class="tc-check-desc">${step.desc}</span>` : ''}
            </li>`)}
        </ol>
      </section>`;
  };

  /** Setup is done: a line that says so, and what is set up. */
  const readyLine = (s) => html`
    <section class="tc-group tc-group--brand" aria-labelledby="ready-title" data-key="ready">
      <div class="tc-ready-line">
        <span class="tc-check-mark" aria-hidden="true">${icon('check')}</span>
        <div class="tc-row-main"><h2 class="tc-ready-line-title" id="ready-title">Ready</h2><span class="tc-status">${M.readySummary(s, ui, state.ports)}</span></div>
      </div>
    </section>`;

  /** A button for an item's one action: a command, or a page to go to. */
  const itemAction = (a, primary) => !a ? ''
    : a.cmd === 'goto' ? html`<a class="${cx('tc-btn tc-btn--sm', primary && 'tc-btn--primary')}" href="#${a.route}">${a.label}</a>`
      : html`<button class="${cx('tc-btn tc-btn--sm', primary && 'tc-btn--primary')}" type="button" data-cmd="${a.cmd}"${a.id ? raw(' data-id="' + Kit.esc(a.id) + '"') : ''}>${a.icon ? icon(a.icon) : ''}${a.label}</button>`;

  /** A Needs you item that is not a row of its own page: the container's problems, a port. */
  const itemRow = (item) => html`
    <div class="tc-row tc-row--compact" data-key="needs-${item.key}">
      <span class="tc-tile tc-tile--icon" data-tone="${item.tone}" aria-hidden="true">${icon(item.icon)}</span>
      <div class="tc-row-main"><span class="tc-row-name">${item.name}</span><span class="tc-status"><span class="tc-status-text">${item.text}</span></span></div>
      <div class="tc-row-actions tc-row-actions--wrap">${itemAction(item.action)}</div>
    </div>`;
  // On a phone each item's one action goes under its words, so they read whole.
  const attentionRow = (item) => (item.icon ? itemRow(item) : resourceRow(item, { plain: true, menu: false, wrap: true }));

  const activitySection = (act, n) => {
    const lines = [];
    for (const row of act.running) {
      const p = row.progress;
      lines.push(html`<div class="tc-op" data-key="op-${row.key}"><span class="tc-op-line">${tile(row)}<span class="tc-truncate">${row.badge.text} ${row.name}${row.versionTo ? ' ' + row.versionTo : ''}</span></span><span class="tc-op-pct">${p && p.pct !== null ? p.pct + '%' : p && p.phase ? p.phase : ''}</span>${progressBar(p)}</div>`);
    }
    act.queued.forEach((row, i) => {
      lines.push(html`<div class="tc-op" data-key="op-${row.key}"><span class="tc-op-line">${tile(row)}<span class="tc-truncate tc-muted">${row.name}</span></span><span class="tc-op-pct">${i === 0 ? 'next' : 'queued'}</span></div>`);
    });
    for (const f of act.finished) {
      lines.push(html`<div class="tc-op" data-key="op-done-${f.key}"><span class="tc-op-line">${icon(f.ok ? 'circle-check' : 'circle-alert', f.ok ? 'tc-ok' : 'tc-danger')}<span class="tc-truncate">${f.text}</span></span><span class="tc-op-pct" title="${M.absTime(f.at)}">${M.relTime(f.at, n)}</span></div>`);
    }
    if (!lines.length) return '';
    return section('act-title', 'Activity', html`<div class="tc-group"><div class="tc-card-body tc-op-list">${lines}</div></div>`);
  };

  /**
   * One release on the Overview: what is installed, what it goes to, and
   * Update. T3 Code's own restarts it, so its button asks first.
   */
  const updateRow = (row) => html`
    <div class="tc-row tc-row--compact" data-key="ov-up-${row.key}">
      ${row.runtime ? html`<span class="tc-row-lead tc-mark tc-runtime-mark" aria-hidden="true"></span>` : tile(row)}
      <div class="tc-row-main"><span class="tc-row-name">${row.name}</span><span class="tc-version">${row.version}${row.latest ? html` <span class="tc-version-arrow" aria-label="to">→</span> ${row.latest}` : ''}</span></div>
      <div class="tc-row-actions">${row.state === 'running'
        ? html`<span class="tc-badge tc-badge--info"><span class="tc-spinner" aria-hidden="true"></span>Updating</span>`
        : row.runtime ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="t3.update" data-key="ov-up-t3">Update…</button>`
          : html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="${row.target}.update" data-target="${row.target}" data-id="${row.id}" data-key="ov-act-${row.key}">Update</button>`}</div>
    </div>`;

  const overviewUpdates = (s, n) => {
    const view = M.updatesView(s, ui, n);
    const rt = view.runtime;
    const rows = [
      ...(rt && (rt.available || rt.busy) ? [{ runtime: true, key: 't3', name: 'T3 Code', version: rt.version, latest: rt.busy ? rt.operation.version : rt.latest, state: rt.busy ? 'running' : 'update' }] : []),
      ...view.available,
    ];
    const shown = rows.slice(0, 4);
    const checked = s.updates && s.updates.checkedAt ? 'Checked ' + M.relTime(s.updates.checkedAt, n) + '.' : 'Checked every hour.';
    return section('ov-updates', 'Updates', html`<div class="tc-group">
      ${shown.length ? html`<div class="tc-list">${shown.map(updateRow)}</div>`
        : html`<div class="tc-empty tc-empty--compact" role="status">${icon('circle-check', 'tc-ok')}<span class="tc-empty-desc">Everything is up to date. ${checked}</span></div>`}
      ${rows.length > shown.length ? html`<a class="tc-group-more" href="#updates">${M.plural(rows.length - shown.length, 'more update')}${icon('arrow-right')}</a>` : ''}
    </div>`, { actions: view.due.length > 1 ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="updates.all">Update all · ${view.due.length}</button>` : linkButton('#updates', 'All updates') });
  };

  const RECENT_ICONS = {
    'device.paired': 'smartphone', 'device.renamed': 'pencil', 'port.published': 'globe', 'port.stopped': 'circle-stop', 'harness.updated': 'circle-arrow-up',
    'harness.installed': 'download', 'harness.uninstalled': 'trash-2', 'harness.failed': 'circle-alert', 'harness.enabled': 'circle-check', 'signin.ok': 'log-in', 'signin.out': 'log-out', 'setup.finished': 'download',
    'toolchain.installed': 'download', 'toolchain.updated': 'circle-arrow-up', 'toolchain.uninstalled': 'trash-2', 'toolchain.failed': 'circle-alert',
    'package.installed': 'download', 'package.updated': 'circle-arrow-up', 'package.uninstalled': 'trash-2', 'package.failed': 'circle-alert',
    'url.set': 'globe', 'url.cleared': 'globe', 'key.replaced': 'key-round',
    'files.deleted':'trash-2', 'files.cleaned':'eraser', 'files.extracted':'file-archive', 'files.trash-emptied':'trash-2', 'files.managed':'file-code', 'files.t3-stopped':'circle-stop',
    'connect.linked': 'globe', 'connect.unlinked': 'globe', 't3.restarted': 'refresh-cw', 't3.updating': 'circle-arrow-up',
  };
  const recentSection = (s, n) => {
    const events = (s.events || []).slice(0, 6);
    return section('recent-title', 'Recent', html`<div class="tc-group">${events.length
      ? html`<ol class="tc-log">${events.map((e) => html`
        <li data-key="ev-${e.at}-${e.kind}">${icon(RECENT_ICONS[e.kind] || 'activity')}<span class="tc-truncate">${e.text}${e.detail ? html` <span class="${cx(!/\s/.test(e.detail) && 'tc-mono')}">${e.detail}</span>` : ''}</span><time datetime="${new Date(e.at).toISOString()}" title="${M.absTime(e.at)}">${M.relTime(e.at, n)}</time></li>`)}</ol>`
      : html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">Nothing yet since the setup service started.</span></div>`}</div>`);
  };

  /** A paired device: what it is, when it was last here, and (on Access) its menu. */
  const accessFeedback = (kind, id) => {
    const pending = access.pending(kind, id), error = access.error(kind, id);
    return pending ? html`<span class="tc-status tc-access-pending" role="status"><span class="tc-spinner" aria-hidden="true"></span>${pending.verb}</span>`
      : error ? html`<span class="tc-status tc-danger" role="alert">${icon('circle-alert', 'tc-icon--sm')}<span class="tc-status-text">${error}</span></span>` : '';
  };
  const deviceRow = (d, { manage, fresh } = {}) => html`
    <div class="tc-row tc-row--compact tc-device-row tc-access-row" data-key="dev-${d.id}" aria-busy="${String(Boolean(access.pending('session', d.id)))}">
      <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(d.icon)}</span>
      <div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name" title="${d.name}">${d.name}</span>${d.connected ? html`<span class="tc-dot tc-dot--ok tc-dot--live" role="img" aria-label="Connected now"></span>` : ''}${fresh ? html`<span class="tc-badge tc-badge--ok">New</span>` : ''}</div>${accessFeedback('session', d.id) || html`<span class="tc-status" title="${d.seenTitle}">${[d.status, d.ends].filter(Boolean).join(' · ')}</span>`}</div>
      ${manage ? html`<div class="tc-row-actions"><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" aria-label="More for ${d.name}" aria-haspopup="menu" aria-expanded="${String(Kit.menuOpenFor('menu-dev-' + d.id))}" data-cmd="device.menu" data-id="${d.id}" data-key="menu-dev-${d.id}"${access.pending('session', d.id) ? raw(' disabled') : ''}>${icon('ellipsis')}</button></div>` : ''}
    </div>`;

  /** The page a "Needs you" item lives on, and that page's link when they all share one. */
  const NEEDS_PAGES = { agents: 'All agents', toolchains: 'All toolchains', sourcecontrol: 'Source control', ports: 'All ports', server: 'Server', storage: 'Storage', updates: 'Updates' };
  const needsPage = (x) => x.target === 'port' ? 'ports' : x.target === 'harness' ? 'agents'
    : x.target === 'server' ? (x.action && x.action.route) || 'server'
      : x.target === 'toolchain' && M.SOURCE_CONTROL[x.id] ? 'sourcecontrol' : 'toolchains';

  /**
   * Overview: which server this is, then setup until it is done, and after
   * that a health check: what needs you, what can update, what happened.
   */
  const overviewPage = (s, n) => {
    const r = M.readiness(s, ui);
    // Until setup is done, signing agents in is its last step: said there, not twice.
    const needs = M.needsYou(s, state.ports, ui).filter((item) => r.ready || item.state !== 'signin');
    const pages = new Set(needs.map(needsPage));
    const [page] = pages;
    const server = s.server || {};
    const host = M.hostOf(s.publicUrl);
    const keep = (text) => text.replace(/ /g, '\u00a0');
    const sub = html`${host ? html`<span class="tc-nowrap">${host}</span> · ` : ''}${server.ok
      ? ['T3 Code is running', Number.isFinite(server.uptimeSeconds) ? keep('up ' + M.duration(server.uptimeSeconds)) : null].filter(Boolean).join(', ') + '.'
      : 'T3 Code isn’t answering yet.'}`;
    const actions = EMBED ? '' : html`<a class="tc-btn tc-btn--sm" href="${t3Url()}" target="_blank" rel="noopener">${icon('external-link')}Open T3 Code</a>`;
    return html`
      ${pageHead('overview', { sub, actions })}
      ${pageNotices('overview')}
      ${r.ready ? readyLine(s) : readinessGroup(r)}
      ${needs.length ? section('needs-title', 'Needs you', html`<div class="tc-group"><div class="tc-list">${needs.map(attentionRow)}</div></div>`,
        pages.size === 1 && NEEDS_PAGES[page] ? { actions: linkButton('#' + page, NEEDS_PAGES[page]) } : undefined) : ''}
      ${activitySection(M.activity(s, ui, n), n)}
      ${r.ready ? html`<div class="tc-overview-split">${overviewUpdates(s, n)}${recentSection(s, n)}</div>` : ''}`;
  };

  // -------------------------------------------------------------- devices --
  // A minted pairing link, tracked until the device it was made for shows up.
  // The sessions that existed at mint time are the baseline; a new one is what
  // proves the scan landed. Held here, not in the DOM, so the poll can advance
  // the tracker without repainting the QR underneath it.
  const pair = {
    label: '',
    ttl: '30d',
    showForm: true,
    minting: false,
    error: null,
    minted: null,       // {id, pairUrl, credential, expiresAt, qr, label, baseline, seen, outcome, pairedName, pairedId}
    freshSession: null, // the session that just paired, for its "New" badge
  };
  const TTLS = [['1h', '1 hour'], ['7d', '7 days'], ['30d', '30 days']];

  const trackPairing = (s) => {
    const m = pair.minted;
    if (!m || m.outcome) return;
    if (m.expiresAt && Date.parse(m.expiresAt) < now()) { m.outcome = 'expired'; return; }
    // Missing or stale snapshots cannot establish a pairing or revocation.
    if (s.authLists && Object.values(s.authLists).some((entry) => !entry.available || entry.stale)) return;
    const sessions = s.sessions || [];
    if (m.baseline === null) { m.baseline = new Set(sessions.map((c) => c.sessionId)); return; }
    const fresh = sessions.find((c) => !m.baseline.has(c.sessionId));
    if (fresh) {
      m.outcome = 'paired';
      m.pairedName = M.deviceName(fresh);
      pair.freshSession = fresh.sessionId;
      accessToast('Paired with ' + m.pairedName, { detail: 'It is already signed in.' });
      return;
    }
    const listed = (s.pairings || []).some((l) => l.id === m.id);
    if (listed) { m.seen = true; m.missingAt = null; }
    else if (s.authLists && m.missingAt == null) m.missingAt = s.authLists.pairing.at;
    // Only call it revoked once the list has shown the link at least once: the
    // status read that follows a mint can land before the pairing is listed.
    // A consumed link can disappear before the independent session read catches
    // the new device. Wait for a session read after the first missing result.
    if (m.seen && !listed && (!s.authLists || s.authLists.session.at >= m.missingAt)) m.outcome = 'revoked';
  };

  const mint = async () => {
    const s = state.status;
    if (pair.minting) return;
    closeAccessNotice();
    if (s && !s.publicUrl) {
      pair.error = 'Set the public URL first: a pairing link points at it, and without it a device has nowhere to go.';
      render();
      return;
    }
    const label = pair.showForm ? pair.label.trim() : (pair.minted && pair.minted.label) || '';
    pair.minting = true;
    pair.error = null;
    Kit.announce('Creating pairing link.');
    render();
    const res = await api('/pair', { body: { ttl: pair.ttl, label } });
    pair.minting = false;
    if (!res.ok) {
      pair.error = res.error || 'Could not create a link';
      pair.showForm = true;
      render();
      return;
    }
    // Baseline the session list before the ceremony goes up. Null only if no
    // status read has finished yet; the next one captures it instead.
    pair.minted = {
      id: res.data.id,
      pairUrl: res.data.pairUrl,
      credential: res.data.credential || null,
      expiresAt: res.data.expiresAt,
      qr: res.data.qr,
      label,
      ttl: pair.ttl,
      baseline: s && s.authLists?.session.available !== false ? new Set((s.sessions || []).map((c) => c.sessionId)) : null,
      seen: false,
      outcome: null,
    };
    pair.showForm = false;
    pair.freshSession = null;
    pair.label = '';
    render();
    Kit.announce('Pairing link created. Waiting for the device.');
    loadStatus();
  };

  const pairSteps = (m) => {
    const failed = m.outcome === 'expired' || m.outcome === 'revoked';
    const paired = m.outcome === 'paired';
    const stepState = [ 'done', failed ? 'failed' : paired ? 'done' : 'active', paired ? 'done' : '' ];
    const labels = [['Link created', 'Created'], [failed ? (m.outcome === 'expired' ? 'Link expired' : 'Link revoked') : 'Waiting for the device', failed ? (m.outcome === 'expired' ? 'Expired' : 'Revoked') : 'Waiting'], ['Paired', 'Paired']];
    const parts = [];
    labels.forEach(([long, short], i) => {
      if (i) parts.push(html`<span class="tc-step-line"${stepState[i - 1] === 'done' && stepState[i] !== '' ? raw(' data-done') : ''} aria-hidden="true"></span>`);
      const mark = stepState[i] === 'done' ? icon('check') : stepState[i] === 'failed' ? icon('x') : String(i + 1);
      parts.push(html`<li class="tc-step"${stepState[i] ? raw(' data-state="' + stepState[i] + '"') : ''}${stepState[i] === 'active' ? raw(' aria-current="step"') : ''}><span class="tc-step-mark">${mark}</span><span class="tc-step-text-long">${long}</span><span class="tc-step-text-short">${short}</span></li>`);
    });
    return html`<ol class="tc-steps" aria-label="Pairing progress">${parts}</ol>`;
  };

  const pairForm = (s) => {
    const noUrl = s && !s.publicUrl;
    return html`
      <div class="tc-group tc-group--brand" data-key="pair-form" aria-busy="${String(pair.minting)}"><div class="tc-card-body tc-pair-form">
        <div class="tc-pair-form-intro"><span class="tc-row-name">A single-use link for one device</span><span class="tc-small tc-muted">Scan it with the T3 Code app, open it in a browser, or paste the pair code into the desktop app.</span></div>
        <div class="tc-pair-form-fields">
          <div class="tc-field"><label class="tc-label" for="pair-label">Label <span class="tc-label-opt">optional</span></label><input id="pair-label" class="tc-input" value="${pair.label}" placeholder="e.g. iPhone" maxlength="64" autocomplete="off" spellcheck="false"${pair.minting ? raw(' disabled') : ''}></div>
          <div class="tc-field"><span class="tc-label" id="ttl-label">Expires in</span><div class="tc-seg" role="group" aria-labelledby="ttl-label">${TTLS.map(([value, label]) => html`<button type="button" aria-pressed="${String(pair.ttl === value)}" data-cmd="pair.ttl" data-value="${value}"${pair.minting ? raw(' disabled') : ''}>${label}</button>`)}</div></div>
        </div>
        <button class="${cx('tc-btn', !noUrl && 'tc-btn--primary')}" type="button" data-cmd="pair.start" data-key="pair-create" aria-keyshortcuts="P" title="Create pairing link · P"${pair.minting || noUrl ? raw(' disabled') : ''}>${pair.minting ? html`<span class="tc-spinner" aria-hidden="true"></span>Creating link…` : html`${icon('link')}Create pairing link`}</button>
        ${noUrl ? html`<p class="tc-hint tc-pair-form-note">${icon('info', 'tc-icon--sm')}A pairing link points at the public URL, so set it above first.</p>` : ''}
        ${pair.error && !noUrl ? html`<p class="tc-hint tc-hint--err tc-pair-form-note" role="alert">${pair.error}</p>` : ''}
      </div></div>`;
  };

  const pairCeremony = (m, s, n) => {
    if (m.outcome === 'paired') {
      return html`
        <div class="tc-group tc-group--brand" data-key="pair-done"><div class="tc-card-body tc-pair-done">
          ${pairSteps(m)}
          ${emptyIcon('smartphone', 'tc-icon--lg')}
          <div class="tc-pair-done-text"><h3 class="tc-pair-done-title">Paired with ${m.pairedName}</h3><p class="tc-page-lede">It is already signed in.${EMBED ? '' : ' You can close this page.'}</p></div>
          <div class="tc-pair-done-actions">${EMBED
            ? html`<button class="tc-btn tc-btn--primary" type="button" data-cmd="embed.close">Done</button>`
            : html`<a class="tc-btn tc-btn--primary" href="${t3Url()}" target="_blank" rel="noopener">${icon('external-link')}Open T3 Code</a>`}<button class="tc-btn tc-btn--ghost" type="button" data-cmd="pair.new">Pair another device</button></div>
        </div></div>`;
    }
    if (m.outcome) {
      return html`
        <div class="tc-group tc-group--brand" data-key="pair-ended"><div class="tc-card-body tc-stack tc-pair-body">
          ${pairSteps(m)}
          <p class="tc-page-lede">${m.outcome === 'expired' ? 'This link expired before a device used it.' : 'This link was revoked before a device used it.'} Create another one to pair.</p>
          <div><button class="tc-btn tc-btn--primary" type="button" data-cmd="pair.again">${icon('link')}Create another link</button></div>
        </div></div>`;
    }
    const code = m.credential;
    return html`
      <div class="tc-group tc-group--brand" data-key="pair-live">
        <div class="tc-card-body tc-stack tc-pair-body">
          ${pairSteps(m)}
          <div class="tc-pair">
            <div class="tc-pair-fields">
              <div class="tc-field tc-desk-only"><span class="tc-label">Pairing link</span>${copyField(m.pairUrl, { actions: html`${copyButton(m.pairUrl)}<a class="tc-btn tc-btn--ghost tc-btn--xs tc-btn--icon" href="${m.pairUrl}" target="_blank" rel="noopener" aria-label="Open pairing link">${icon('external-link')}</a>` })}</div>
              ${code ? html`<div class="tc-field"><span class="tc-label">Pair code</span>${copyField(code, { code: code.length <= 14 })}<p class="tc-hint tc-desk-only">For desktop clients that ask for a server URL and a code separately. The server URL is ${s.publicUrl}.</p></div>` : ''}
              <div class="tc-pair-phone-actions tc-phone-only">${copyButton(m.pairUrl, 'Copy link', { ghost: false, size: '' })}<a class="tc-btn" href="${m.pairUrl}" target="_blank" rel="noopener">${icon('external-link')}Open here</a></div>
              <div class="tc-notice tc-desk-only">${icon('shield-check')}<div class="tc-notice-body"><span class="tc-notice-desc">The token lives in the link fragment. Treat the link like a password.</span></div></div>
            </div>
            ${m.qr ? html`<div class="tc-pair-qr"><div class="tc-qr" role="img" aria-label="QR code for the pairing link" data-keep>${qrSvg(m.qr)}</div><div class="tc-qr-caption">Scan with the T3 Code app</div></div>` : ''}
          </div>
        </div>
        <div class="tc-card-foot" aria-live="polite"><span class="tc-spinner tc-info" aria-hidden="true"></span><span>${access.pending('pairing', m.id) ? 'Revoking link…' : html`Listening for the device…<span class="tc-desk-only"> this page updates on its own.</span>`}</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="link.revoke" data-id="${m.id}"${access.pending('pairing', m.id) ? raw(' disabled') : ''}>${access.pending('pairing', m.id) ? 'Revoking…' : 'Revoke link'}</button></div>
      </div>`;
  };

  /** How devices reach this server: its public address, and T3 Connect. */
  const reachGroup = (s) => {
    const url = s.publicUrl;
    const source = M.publicUrlSource(s);
    const here = M.hereOffer(s, ui);
    const action = !url ? (here && !here.local
      ? html`<button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="url.use">${icon('check')}Use ${M.hostOf(here.url)}</button>`
      : html`<button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="url.edit">${icon('globe')}Set address</button>`)
      : s.publicUrlSource === 'env' ? '' : html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="url.edit">Change</button>`;
    return html`<div class="tc-group"><div class="tc-list">
      <div class="tc-row tc-row--compact" data-key="public-url">
        <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('link')}</span>
        <div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">Public URL</span></div>
          ${url ? html`<span class="tc-status tc-url-line"><span class="tc-mono tc-truncate">${url}</span>${copyButton(url, 'Copy public URL', { iconOnly: true })}${source && source !== 'set here' ? html`<span class="tc-url-source">${source === 'T3_PUBLIC_URL' ? 'from T3_PUBLIC_URL' : source}</span>` : ''}</span>`
            : html`<span class="tc-status">${dot('warn')}<span class="tc-status-text">Not set. Pairing links point at it, so they need one${here && !here.local ? html`: this page is open at ${M.hostOf(here.url)}, and T3 Code answers there too` : ''}.</span></span>`}
        </div>
        <div class="tc-row-actions tc-row-actions--wrap">${action}${!url && here && !here.local ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" aria-label="More for the public URL" aria-haspopup="menu" aria-expanded="${String(Kit.menuOpenFor('menu-url'))}" data-cmd="url.menu" data-key="menu-url">${icon('ellipsis')}</button>` : ''}</div>
      </div>
      ${connectRow(s)}
    </div></div>`;
  };

  const accessPage = (s, n) => {
    const devices = M.deviceRows(s.sessions, n);
    const m = pair.minted;
    const waiting = m && !m.outcome ? m.id : null;
    const links = M.linkRows(s.pairings, waiting, n);
    const ceremony = m && !pair.showForm;
    const sub = ceremony && !m.outcome
      ? (m.label ? '“' + m.label + '” · ' : '') + 'single use · expires ' + M.relTime(m.expiresAt, n)
      : null;
    // With no address yet, how devices reach the server is the first thing to do.
    const reach = section('reach-title', 'How devices reach this server', reachGroup(s));
    return html`
      ${pageHead('access')}
      ${pageNotices('access')}
      ${s.publicUrl ? '' : reach}
      ${section('pair-title', 'Pair a device', ceremony ? pairCeremony(m, s, n) : pairForm(s),
        { actions: ceremony ? html`${sub ? muted(sub) : ''}<button class="tc-btn tc-btn--sm" type="button" data-cmd="pair.new" aria-keyshortcuts="P" title="New link · P"${pair.minting ? raw(' disabled') : ''}>${pair.minting ? html`<span class="tc-spinner" aria-hidden="true"></span>Creating link…` : html`${icon('plus')}New link`}</button>` : null })}
      ${section('paired-title', 'Paired devices', devices.length
        ? html`<div class="tc-group"><div class="tc-list">${devices.map((d) => deviceRow(d, { manage: true, fresh: d.id === pair.freshSession }))}</div></div>`
        : s.authLists?.session.available === false ? html`<div class="tc-group"><div class="tc-empty tc-empty--compact" role="status">
            <span class="tc-spinner tc-info" aria-hidden="true"></span><span class="tc-empty-desc">Reading paired devices…</span>
          </div></div>`
        : html`<div class="tc-group"><div class="tc-empty">
            ${emptyIcon('smartphone')}
            <span class="tc-empty-title">No devices paired yet</span>
            <span class="tc-empty-desc">Create a link above, then scan it with the phone you want to drive this server from.</span>
          </div></div>`)}
      ${links.length ? section('links-title', 'Unused links', html`<div class="tc-group"><div class="tc-list">${links.map((l) => html`
        <div class="tc-row tc-row--compact tc-access-row" data-key="link-${l.id}" aria-busy="${String(Boolean(access.pending('pairing', l.id)))}">
          <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('link')}</span>
          <div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">${l.name}</span>${l.waiting ? html`<span class="tc-badge tc-badge--info">Waiting</span>` : ''}</div>${accessFeedback('pairing', l.id) || html`<span class="tc-status" title="${l.expiresTitle}">${l.status}</span>`}</div>
          <div class="tc-row-actions"><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" aria-label="More for link ${l.name}" aria-haspopup="menu" aria-expanded="${String(Kit.menuOpenFor('menu-link-' + l.id))}" data-cmd="link.menu" data-id="${l.id}" data-key="menu-link-${l.id}"${access.pending('pairing', l.id) ? raw(' disabled') : ''}>${icon('ellipsis')}</button></div>
        </div>`)}</div></div>`) : ''}
      ${s.publicUrl ? reach : ''}`;
  };

  /** T3 Connect: where it stands, the one thing to do next, and a menu for the rest. */
  const connectRow = (s) => {
    const view = M.connectView(s);
    const menu = view.menu || [];
    return html`<div class="tc-row tc-row--compact" data-key="connect">
      <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('globe')}</span>
      <div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">T3 Connect</span>${badge(view.badge)}</div><span class="tc-status tc-status--prose">${view.text}</span></div>
      <div class="tc-row-actions tc-row-actions--wrap">${view.action ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="${view.action.cmd}">${view.action.icon ? icon(view.action.icon) : ''}${view.action.label}</button>` : ''}${menu.length ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" aria-label="More for T3 Connect" aria-haspopup="menu" aria-expanded="${String(Kit.menuOpenFor('menu-connect'))}" data-cmd="connect.menu" data-key="menu-connect">${icon('ellipsis')}</button>` : ''}</div>
    </div>`;
  };

  // --------------------------------------------------------------- agents --
  const settleSoftwareCheck = (s) => {
    if (!ui.updateAwaiting || s.updates?.refreshing) return;
    ui.updateAwaiting = false;
    const failures = Object.keys(s.updates?.errors || {});
    Kit.toast(failures.length ? 'Some update checks failed' : 'Update check complete', {
      tone: 'info',
      detail: failures.length ? M.plural(failures.length, 'source') + ' could not be verified. Last known releases are kept.' : 'Available releases are shown beside each tool.',
      ...(failures.length ? { action: { label: 'Review', run: () => openUpdateChecks(null, null) } } : {}),
    });
  };

  const requestUpdateCheck = async () => {
    if (ui.updatePosting || ui.updateAwaiting || state.status?.updates?.manual) return;
    ui.updatePosting = true;
    render();
    const res = await api('/updates/check', { body: {} });
    if (!res.ok) {
      ui.updatePosting = false;
      Kit.toast('Couldn’t start the update check', { tone: 'danger', detail: res.error });
      render();
      return;
    }
    // A status read started before the POST cannot report its completion.
    if (statusLoading) await statusLoading;
    ui.updatePosting = false;
    ui.updateAwaiting = true;
    Kit.announce('Checking for updates');
    render();
    await loadStatus();
  };

  const openUpdateChecks = (scope, trigger) => {
    const failures = Object.entries(state.status?.updates?.errors || {}).filter(([key]) => !scope || (scope === 'harness' ? key.startsWith('harness:') : !key.startsWith('harness:')));
    const sources = failures.map(([key, detail]) => {
      const split = key.indexOf(':');
      return { name: nameOf(key.slice(0, split), key.slice(split + 1)), detail };
    });
    const report = sources.map((source) => source.name + '\n' + source.detail).join('\n\n');
    const layer = Kit.open({
      kind: 'center', returnTo: trigger, focus: '[data-check-close]',
      panel: { class: 'tc-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'update-check-title', 'aria-describedby': 'update-check-desc' },
      render: () => html`<div class="tc-dialog-body">
        <h2 class="tc-dialog-title" id="update-check-title">Update checks</h2>
        <p class="tc-dialog-desc" id="update-check-desc">${sources.length ? 'These sources could not be verified. Last known releases are still shown. Check again to refresh them.' : 'No failed checks remain. You can check again for fresh releases.'}</p>
        ${sources.length ? html`<ul class="tc-check-failures">${sources.map((source) => html`<li><strong>${source.name}</strong><details><summary>Technical details</summary><pre class="tc-error-detail">${source.detail}</pre></details></li>`)}</ul>` : ''}
      </div><div class="tc-dialog-foot">
        ${sources.length ? copyButton(report, 'Copy details') : ''}
        <button class="tc-btn tc-btn--ghost" type="button" data-check-close>Close</button>
        <button class="tc-btn tc-btn--primary" type="button" data-check-retry>Check again</button>
      </div>`,
    });
    layer.panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-check-close]')) layer.close('close');
      if (e.target.closest('[data-check-retry]')) { layer.close('retry'); requestUpdateCheck(); }
    });
  };

  const openErrorDetails = ({ title, description, detail }, trigger) => {
    const layer = Kit.open({
      kind: 'center', returnTo: trigger, focus: '[data-error-close]',
      panel: { class: 'tc-dialog tc-error-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'row-error-title', 'aria-describedby': 'row-error-desc' },
      render: () => html`<div class="tc-dialog-body"><h2 class="tc-dialog-title" id="row-error-title">${title}</h2><p class="tc-dialog-desc" id="row-error-desc">${description}</p><pre class="tc-error-detail">${detail}</pre></div><div class="tc-dialog-foot">${copyButton(detail, 'Copy details')}<button class="tc-btn" type="button" data-error-close>Close</button></div>`,
    });
    layer.panel.addEventListener('click', (e) => { if (e.target.closest('[data-error-close]')) layer.close('close'); });
  };
  /**
   * A page's own Update all, when something on it has one. Checking for
   * updates, and their schedule, are the Updates page's.
   */
  const updateAllButton = (rows, cmd) => {
    const due = rows.filter((r) => r.updateAvailable && r.state !== 'running' && r.state !== 'queued').length;
    return due ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="${cmd}">${icon('circle-arrow-up')}Update all · ${due}</button>` : '';
  };

  const agentsPage = (s, n) => {
    const rows = M.agentRows(s, ui, n);
    return html`
      ${pageHead('agents', { actions: updateAllButton(rows, 'harness.updateAll') })}
      ${pageNotices('agents')}
      <div class="tc-group" data-key="agents-list">
        ${rows.length ? html`<div class="tc-list">${rows.map((row) => resourceRow(row))}</div>`
          : html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">Couldn’t read the agents just now. The console tries again on its own.</span></div>`}
        <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Turn each agent on in T3 Code under Settings → Providers.</span></div>
      </div>`;
  };

  // ----------------------------------------------------------- toolchains --
  // What every image already has, said once under the lists rather than as a
  // section of its own: none of it is managed here.
  const IN_THE_IMAGE = ['Node', 'Python', 'git', 'clang', 'CMake', 'psql', 'redis-cli', 'ffmpeg', 'ImageMagick'];
  const toolchainsPage = (s, n) => {
    const rows = M.toolchainRows(s, ui, n);
    const added = M.packageRows(s, ui, n);
    const browserImage = (s.image && s.image.variant === 'browser') || Boolean(s.browser);
    // A filter once the list is long enough to need one; it matches the name,
    // the commands a tool provides and its description.
    const filterable = added.length > 6;
    const q = filterable ? state.toolFilter.trim().toLowerCase() : '';
    const shown = q ? added.filter((r) => [r.name, r.id, ...(r.bins || []), r.description || ''].join(' ').toLowerCase().includes(q)) : added;
    const addButton = html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="package.add" data-key="tool-add" aria-keyshortcuts="N" title="Add a tool · N">${icon('plus')}Add a tool</button>`;
    const filter = filterable ? html`<div class="tc-inputwrap tc-tool-filter">${icon('search')}<input class="tc-input tc-input--sm" id="tool-filter" type="search" placeholder="Filter" aria-label="Filter added tools" autocomplete="off" spellcheck="false"></div>` : '';
    return html`
      ${pageHead('toolchains', { actions: updateAllButton([...rows, ...added], 'tools.updateAll') })}
      ${pageNotices('toolchains')}
      ${section('tc-title', 'Default toolchains', html`<div class="tc-group">
        ${rows.length ? html`<div class="tc-list">${rows.map((row) => resourceRow(row))}</div>`
          : html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">Couldn’t read the toolchains just now. The console tries again on its own.</span></div>`}
        <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Available in every directory. A project that pins a version in <code>mise.toml</code> or <code>.tool-versions</code> gets that one instead.</span></div>
      </div>`)}
      ${section('pk-title', 'Added tools', html`<div class="tc-group">
        ${shown.length ? html`<div class="tc-list">${shown.map((row) => resourceRow(row))}</div>`
          : added.length ? html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">No added tool matches “${state.toolFilter.trim()}”.</span></div>`
            : toolsEmpty()}
        ${added.length ? html`<div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Tools added with <code class="tc-nowrap">mise use -g</code> in a terminal show up here too.</span></div>` : ''}
      </div>`, { actions: html`${filter}${addButton}` })}
      <p class="tc-page-foot">Also in the image: ${M.listOf([...IN_THE_IMAGE, ...(browserImage ? ['headless Chromium'] : [])])}.</p>`;
  };

  // A first look at what can be added: one press opens the sheet on that tool.
  const QUICK_ADD = ['kubectl', 'terraform', 'aws-cli', 'java', 'zig', 'just'];
  const toolsEmpty = () => html`<div class="tc-empty">
    ${emptyIcon('plus')}
    <span class="tc-empty-title">Add any tool mise can install</span>
    <span class="tc-empty-desc">Cloud CLIs, other languages, linters: about a thousand tools, each pinned to an exact version like the toolchains above. Or name one with a backend, like <code class="tc-nowrap">npm:prettier</code>.</span>
    <div class="tc-chips" role="group" aria-label="Suggestions">${QUICK_ADD.map((name) => html`<button class="tc-chip-btn" type="button" data-cmd="package.add" data-id="${name}">${name}</button>`)}</div>
    <button class="tc-btn tc-btn--primary tc-btn--sm tc-empty-cta" type="button" data-cmd="package.add">${icon('plus')}Add a tool</button>
  </div>`;

  // ------------------------------------------------------- source control --
  // The CLI T3 Code drives for each source control host. A row tells the
  // provider apart from the CLI's name, and who it is signed in as.
  const sourceControlPage = (s, n) => {
    const rows = M.sourceControlRows(s, ui, n);
    return html`
      ${pageHead('sourcecontrol', { actions: updateAllButton(M.managedSourceControlRows(s, ui, n), 'scm.updateAll') })}
      ${pageNotices('sourcecontrol')}
      <div class="tc-group" data-key="scm-list">
        ${rows.length ? html`<div class="tc-list">${rows.map((row) => resourceRow(row))}</div>`
          : html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">Couldn’t read the source control CLIs just now. The console tries again on its own.</span></div>`}
        <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Bitbucket needs no CLI: add its token in T3 Code under Settings → Source Control.</span></div>
      </div>`;
  };

  // ---------------------------------------------------------------- ports --
  const portRow = (p) => {
    // The number is the row's name; the tile says whether it is out on the internet.
    // A link or an error needs the row's width, so on a phone its buttons go under it.
    const tileEl = html`<span class="tc-tile tc-tile--icon tc-tile--port-state"${p.state === 'open' || p.state === 'starting' ? raw(' data-live') : ''} aria-hidden="true">${icon(p.state === 'open' || p.state === 'starting' ? 'globe' : 'ethernet-port')}</span>`;
    const proc = p.process ? html`<code>${p.process}</code>` : null;
    const where = p.address && p.address !== '0.0.0.0' && p.address !== '*' && p.address !== '::' ? html`<span class="tc-mono">${p.address}</span>` : null;
    const joinParts = (parts) => parts.filter(Boolean).map((x, i) => i ? html` · ${x}` : x);
    let title = html`<span class="tc-row-name">Port ${p.port}</span>`;
    let status;
    let actions;
    let panel = '';
    if (p.state === 'open') {
      title = html`${title}<span class="tc-badge tc-badge--info">Published</span>`;
      status = html`<span class="tc-status"><a class="tc-mono tc-truncate" href="${p.url}" target="_blank" rel="noopener">${p.url}</a></span>`;
      // The link is what a published port is for: one press copies it, and
      // the QR code, opening it and stopping it are in its menu.
      actions = html`${copyButton(p.url, 'Copy link', { ghost: false, size: 'tc-btn--sm' })}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" aria-label="More for port ${p.port}" aria-haspopup="menu" aria-expanded="${String(Kit.menuOpenFor('menu-port-' + p.port))}" data-cmd="port.menu" data-id="${p.port}" data-key="menu-port-${p.port}">${icon('ellipsis')}</button>`;
      // The QR code, for another device, once asked for.
      panel = p.expanded ? html`<div class="tc-row-panel tc-port-panel">
        ${p.qr ? html`<div class="tc-qr" role="img" aria-label="QR code for port ${p.port}" data-keep>${qrSvg(p.qr)}</div>` : ''}
        <div class="tc-stack tc-port-panel-text"><span class="tc-hint">Scan to open port ${p.port} on another device.</span></div>
      </div>` : '';
    } else if (p.state === 'starting') {
      title = html`${title}<span class="tc-badge tc-badge--info"><span class="tc-spinner" aria-hidden="true"></span>Publishing</span>`;
      status = html`<span class="tc-status"><span class="tc-status-text">${joinParts([proc, 'waiting for a public hostname…'])}</span></span>${progressBar(null)}`;
      actions = html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-cmd="port.stop" data-id="${p.port}" data-key="stop-${p.port}">Cancel</button>`;
    } else if (p.state === 'failed') {
      title = html`${title}<span class="tc-badge tc-badge--danger">Failed</span>`;
      status = statusLine({ dot: 'danger', text: p.error || 'The tunnel failed' });
      actions = html`<button class="tc-btn tc-btn--warning tc-btn--sm" type="button" data-cmd="port.publish" data-id="${p.port}" data-key="pub-${p.port}">${icon('refresh-cw')}Retry</button>`;
    } else {
      status = p.db
        ? html`<span class="tc-status">${dot('warn')}<span class="tc-status-text">${joinParts([proc, 'looks like a database, so Publish asks first'])}</span></span>`
        : html`<span class="tc-status"><span class="tc-status-text">${proc || where ? joinParts([proc, where]) : p.listening ? 'Listening in the container' : 'Not listening right now'}</span></span>`;
      actions = html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="port.publish" data-id="${p.port}" data-key="pub-${p.port}">${p.db ? 'Publish…' : 'Publish'}</button>`;
    }
    return html`
      <div class="${cx('tc-row tc-row--compact', p.expanded && 'tc-row--expanded')}" data-key="port-${p.port}">
        ${tileEl}
        <div class="tc-row-main"><div class="tc-row-title">${title}</div>${status}</div>
        <div class="${cx('tc-row-actions', (p.state === 'open' || p.state === 'failed') && 'tc-row-actions--wrap')}">${actions}</div>
        ${panel}
      </div>`;
  };

  const portsPage = (s, n) => {
    const ports = state.ports;
    const head = pageHead('ports');
    if (!ports) return html`${head}${pageNotices('ports')}${skeletonGroup(3)}`;
    if (ports.available === false) {
      return html`${head}${pageNotices('ports')}<div class="tc-group"><div class="tc-empty tc-empty--compact"><span class="tc-empty-title">Publishing isn’t available in this image</span><span class="tc-empty-desc">It has no cloudflared, so a port can’t get a public address from here.</span></div></div>`;
    }
    const rows = M.portRows(ports, ui, n);
    return html`
      ${head}
      ${pageNotices('ports')}
      ${section('pl-title', 'Listening in this container', html`<div class="tc-group">
        ${rows.length ? html`<div class="tc-list">${rows.map(portRow)}</div>`
          : html`<div class="tc-empty tc-empty--compact">${emptyIcon('ethernet-port')}<span class="tc-empty-title">Nothing is listening yet</span><span class="tc-empty-desc">Start a dev server in a T3 Code terminal and it shows up here within a few seconds.</span></div>`}
        <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>A published address is public: anyone who has it can open that port. Stop it when you’re done.</span></div>
      </div>`)}`;
  };

  const publishPort = async (port) => {
    const row = M.portRows(state.ports, ui, now()).find((p) => p.port === port);
    if (row && row.db) {
      const ok = await Kit.confirm({
        title: 'Publish port ' + port + '?',
        body: (row.process ? row.process : 'Port ' + port) + ' looks like a database. Publishing gives it a public URL that anyone holding it can reach.',
        consequences: [
          { icon: 'globe', text: 'Public: a random trycloudflare.com address' },
          { icon: 'triangle-alert', text: 'Nothing in front of it checks who is connecting' },
          { icon: 'circle-stop', text: 'Stops when you press Stop or the container restarts' },
        ],
        confirm: 'Publish anyway',
      });
      if (!ok) return;
    }
    portsBusy.add(port);
    render();
    const res = await api('/ports/expose', { body: { port } });
    portsBusy.delete(port);
    if (!res.ok) Kit.toast('Could not publish port ' + port, { tone: 'danger', detail: res.error });
    await loadPorts();
  };

  const stopPort = async (port) => {
    expandedPorts.delete(port);
    const res = await api('/ports/unexpose', { body: { port } });
    if (!res.ok && res.status !== 404) Kit.toast('Could not stop port ' + port, { tone: 'danger', detail: res.error });
    else Kit.toast('Stopped publishing port ' + port, { tone: 'info' });
    await loadPorts();
  };

  // --------------------------------------------------------------- server --
  const kindBadge = (kind) => kind === 'durable' ? html`<span class="tc-badge tc-badge--ok">Durable</span>`
    : kind === 'anonymous' ? html`<span class="tc-badge tc-badge--warn">Anonymous</span>`
      : kind === 'none' ? html`<span class="tc-badge tc-badge--warn">Not mounted</span>` : '';
  const kindText = (kind, name) => kind === 'durable' ? (name ? html`Volume <span class="tc-nowrap">${name}</span>` : 'Kept when the container is recreated')
    : kind === 'anonymous' ? 'Anonymous volume · a recreated container starts without it'
      : kind === 'none' ? 'Inside the container · lost when it is removed' : null;

  // ------------------------------------------------------------- setup key --
  // The key itself is fetched only when someone asks to see it, never with
  // /status: status is polled, and copied whole into diagnostics.
  const keyView = { value: null };
  const KEY_STATES = {
    env: { text: html`Set with <code>T3_SETUP_KEY</code> in the container’s settings.` },
    volume: { text: 'Made on the first start and kept on the volume, so it stays the same across restarts.' },
    boot: { text: html`Made at this start because the volume couldn’t keep one, so it changes on every start. Set <code>T3_SETUP_KEY</code> to keep one.`, badge: 'Changes on restart', tone: 'warn' },
  };
  const keyRow = (source) => {
    const view = KEY_STATES[source] || KEY_STATES.env;
    return html`<div class="tc-row tc-row--compact" data-key="setup-key">
      <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('key-round')}</span>
      <div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">Setup key</span>${view.badge ? html`<span class="tc-badge tc-badge--${view.tone}">${view.badge}</span>` : ''}</div>
        <span class="tc-status tc-status--prose">${view.text}</span>
        ${keyView.value ? html`<div class="tc-key-field">${copyField(keyView.value, { label: 'Copy', wrap: true })}</div>` : ''}
      </div>
      <div class="tc-row-actions tc-row-actions--wrap">
        ${keyView.value
          ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="key.hide" data-key="key-toggle">${icon('eye-off')}Hide</button>`
          : html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="key.show" data-key="key-toggle">${icon('eye')}Show</button>`}
        ${source === 'env' ? '' : html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" aria-label="More for the setup key" aria-haspopup="menu" aria-expanded="${String(Kit.menuOpenFor('menu-key'))}" data-cmd="key.menu" data-key="menu-key">${icon('ellipsis')}</button>`}
      </div>
    </div>`;
  };

  /** A volume row: what lives there, and whether a recreated container keeps it. */
  const volumeRow = ({ key, name, path, kind, volume, holds, extra }) => html`
    <div class="tc-row tc-row--compact" data-key="volume-${key}">
      <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('folder')}</span>
      <div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">${name}</span><code class="tc-row-path">${path || '—'}</code>${kindBadge(kind)}</div>
        <span class="tc-status"><span class="tc-status-text">${[holds, kindText(kind, volume && kind === 'durable' ? volume : null), extra].filter(Boolean).map((part, i) => html`${i ? ' · ' : ''}${part}`)}</span></span></div>
    </div>`;

  // A shell command shown whole, wrapped rather than cut, with its own Copy.
  const commandBlock = (text, label) => html`<div class="tc-cmd"><pre class="tc-cmd-text">${text}</pre>${copyButton(text, label || 'Copy command', { iconOnly: true, size: 'tc-btn--sm' })}</div>`;

  /**
   * How to move a folder off an anonymous volume, with this container's own
   * volume hash in the command. Nothing here runs anything: these commands are
   * for the host, where the console cannot reach.
   */
  const openVolumeFix = (which, trigger) => {
    const paths = (state.status && state.status.paths) || {};
    const home = which === 'home';
    const kind = home ? paths.volumeKind : paths.stateKind;
    const where = home ? paths.volume || '/home/t3' : paths.state || '/home/t3/.t3';
    const hash = (home ? paths.volumeName : paths.stateVolumeName) || '<volume>';
    const named = home ? 't3-home' : 't3-state';
    const what = home ? 'agents, toolchains, caches and shell history' : 'conversations, sign-ins and settings';
    const layer = Kit.open({
      kind: 'center', returnTo: trigger, focus: '[data-fix-close]',
      panel: { class: 'tc-dialog tc-volume-fix', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'volume-fix-title', 'aria-describedby': 'volume-fix-desc' },
      render: () => html`<div class="tc-dialog-body">
        <h2 class="tc-dialog-title" id="volume-fix-title">${kind === 'none' ? 'Mount a volume at ' + where : 'Move ' + where + ' to a named volume'}</h2>
        <p class="tc-dialog-desc" id="volume-fix-desc">${kind === 'none'
          ? html`${where} is inside the container, so removing the container removes its ${what}. Mount a named volume or a host folder there the next time you create it.`
          : html`${where} is on an anonymous volume. A restart keeps it, but a recreated container starts with a new, empty one and leaves its ${what} behind. Copy it to a named volume, then mount that.`}</p>
        ${kind === 'none' ? commandBlock('-v ' + named + ':' + where, 'Copy volume option') : html`
          <ol class="tc-fix-steps">
            <li><span>On the host, stop the container and make the named volume.</span>${commandBlock('docker stop t3code\ndocker volume create ' + named, 'Copy commands')}</li>
            <li><span>Copy this container’s volume into it. It runs in the image you already have.</span>${commandBlock('docker run --rm --entrypoint sh -v ' + hash + ':/from -v ' + named + ':/to dizys/t3code-docker -c \'cp -a /from/. /to/\'', 'Copy command')}</li>
            <li><span>Recreate the container with <code>-v ${named}:${where}</code>, or in Compose, <code>- ${named}:${where}</code> under <code>volumes:</code>.</span></li>
          </ol>`}
        <p class="tc-hint">Use your container’s name if it isn’t <code>t3code</code>. ${learnMore('configuration.md')}</p>
      </div><div class="tc-dialog-foot"><button class="tc-btn tc-btn--primary" type="button" data-fix-close>Done</button></div>`,
    });
    layer.panel.addEventListener('click', (e) => { if (e.target.closest('[data-fix-close]')) layer.close('done'); });
  };

  const serverPage = (s, n) => {
    const server = s.server || {};
    const image = s.image || {};
    const paths = s.paths || {};
    const t3 = s.t3 || {};
    const legacy = s.legacyEnv || [];
    const legacyVars = legacy.filter((name) => name !== 'PATH');
    const warnings = M.serverWarnings(s);
    const readout = (label, value, mono) => html`<div class="${cx('tc-readout', mono && 'tc-readout--wide')}"><span class="tc-readout-label">${label}</span><span class="${cx('tc-readout-value', mono && 'tc-mono tc-mono--body')}">${value}</span></div>`;
    const lost = warnings.filter((w) => w === 'home' || w === 'state');
    return html`
      ${pageHead('server', { actions: html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="diagnostics">${icon('copy')}<span data-label>Copy diagnostics</span></button>` })}
      ${pageNotices('server')}
      ${lost.length ? notice('danger', 'triangle-alert', lost.includes('home') ? 'Recreating this container would lose its home folder' : 'Recreating this container would lose T3 Code’s state',
        lost.includes('home') ? 'Agents, toolchains and caches live in it. A restart keeps them; a recreated container starts without them.'
          : 'Conversations, sign-ins and settings live in it. A restart keeps them; a recreated container starts without them.',
        html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="volume.fix" data-id="${lost[0]}">How to fix</button>`) : ''}
      ${legacy.length ? notice('warn', 'triangle-alert', 'Settings left over from an older image',
        html`This container’s environment still has ${legacyVars.map((name, i) => html`${i ? (i === legacyVars.length - 1 ? ' and ' : ', ') : ''}<code>${name}</code>`)}${legacy.includes('PATH') ? html`${legacyVars.length ? ' and ' : ''}the old <code>PATH</code>` : ''}, from an image that shipped its own Go, Rust, Bun and Deno. Nothing this image starts uses them. Remove them from the container’s settings so <code>docker exec</code> stops seeing them too.`) : ''}
      ${section('srv-t3', 'T3 Code', html`<div class="tc-group"><div class="tc-readouts tc-readouts--server">
        ${readout('Status', server.ok ? html`${dot('ok')}Running` : html`${dot('danger')}Not answering`)}
        ${Number.isFinite(server.uptimeSeconds) ? readout('Up for', M.duration(server.uptimeSeconds)) : ''}
        ${readout('Version', server.version || '—', true)}
        ${readout('Image', html`<span class="tc-truncate" title="${M.imageLabel(image).full || ''}">${M.imageLabel(image).text || 'unversioned'}</span>`, true)}
      </div></div>`, { actions: t3.pid ? html`<button class="tc-btn tc-btn--xs" type="button" data-cmd="t3.restart"${M.runtimeView(s)?.busy ? raw(' disabled') : ''}>${icon('refresh-cw')}Restart</button>` : null })}
      ${section('srv-volumes', 'Volumes', html`<div class="tc-group"><div class="tc-list">
        ${volumeRow({ key: 'home', name: 'Home', path: paths.volume, kind: paths.volumeKind, volume: paths.volumeName, holds: 'Agents, toolchains and caches',
          extra: Number.isFinite(paths.volumeBytes) ? M.formatBytes(paths.volumeBytes) : null })}
        ${volumeRow({ key: 'state', name: 'T3 state', path: paths.state, kind: paths.stateKind, volume: paths.stateVolumeName, holds: 'Conversations, sign-ins and settings' })}
        ${volumeRow({ key: 'workspace', name: 'Workspace', path: paths.workspace, kind: paths.workspaceKind, volume: paths.workspaceVolumeName,
          holds: Number.isFinite(paths.workspaceProjects) ? M.plural(paths.workspaceProjects, 'project') : 'Your projects' })}
      </div></div>`)}
      ${section('srv-network', 'Network', html`<div class="tc-group"><dl class="tc-kv">
        ${t3.bind ? html`<dt>T3 Code</dt><dd><span class="tc-mono tc-mono--body">${t3.bind}</span><span class="tc-kv-aside">${/^(127\.|localhost|\[?::1)/.test(t3.bind) ? 'loopback, behind your proxy' : 'every interface in the container'}</span></dd>` : ''}
        <dt>Setup console</dt><dd><span class="tc-mono tc-mono--body">${BASE || '/'}</span><span class="tc-kv-aside">${BASE ? 'on the same hostname · ' : ''}port ${s.setupPort || 3774}</span></dd>
        ${s.singlePort ? html`<dt>One port</dt><dd><span class="tc-mono tc-mono--body">${s.singlePort.port}</span><span class="tc-kv-aside">T3 Code at /, this console at ${s.singlePort.prefix}</span></dd>` : ''}
        ${s.platform ? html`<dt>Platform</dt><dd><span class="tc-mono tc-mono--body">${s.platform}</span></dd>` : ''}
      </dl></div>`)}
      ${s.browser ? section('srv-browser', 'Agent browser', html`<div class="tc-group"><dl class="tc-kv">
        <dt>Headless Chromium</dt><dd>${s.browser.chromium ? html`${dot('ok')}Ready` : html`${dot('warn')}Missing`}</dd>
        ${s.browser.playwrightMcp ? html`<dt>Playwright MCP</dt><dd><span class="tc-mono tc-mono--body">${s.browser.playwrightMcp}</span></dd>` : ''}
        ${s.browser.devtoolsMcp ? html`<dt>Chrome DevTools MCP</dt><dd><span class="tc-mono tc-mono--body">${s.browser.devtoolsMcp}</span></dd>` : ''}
      </dl><div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Claude Code, Codex and OpenCode are set up to use these.</span></div></div>`) : ''}
      ${section('srv-console', 'This console', html`<div class="tc-group"><div class="tc-list">
        ${s.setupKeySource ? keyRow(s.setupKeySource) : ''}
        ${viaT3(s)
          ? html`<div class="tc-row tc-row--compact"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('shield-check')}</span><div class="tc-row-main"><span class="tc-row-name">Signed in through T3 Code</span><span class="tc-status tc-status--prose">This browser is paired with T3 Code, which already gives it a terminal here, so the console didn’t ask for the key. Revoking it under Access ends both.</span></div></div>`
          : html`<div class="tc-row tc-row--compact"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('lock')}</span><div class="tc-row-main"><span class="tc-row-name">Lock this browser</span><span class="tc-status">Ends this browser’s session here. Coming back takes the setup key.</span></div><div class="tc-row-actions tc-row-actions--wrap"><button class="tc-btn tc-btn--sm" type="button" data-cmd="lock">Lock</button></div></div>`}
        <div class="tc-row tc-row--compact"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('circle-stop')}</span><div class="tc-row-main"><span class="tc-row-name">Turn the console off</span><span class="tc-status tc-status--prose">Set <code>T3_SETUP_ENABLED=0</code> once you’re set up. Pairing then takes <code class="tc-nowrap">t3-pair</code> in a shell.</span></div><div class="tc-row-actions tc-row-actions--wrap">${copyButton('T3_SETUP_ENABLED=0', 'Copy setting', { ghost: false, size: 'tc-btn--sm' })}</div></div>
      </div></div>`)}`;
  };

  // -------------------------------------------------------------- storage --
  const storagePage = () => html`
    ${pageHead('storage', { actions: storageUI.actions() })}
    ${pageNotices('storage')}
    ${storageUI.content()}`;

  // -------------------------------------------------------------- updates --
  /** T3 Code's own release: its channel, where it stands, and the one thing to do. */
  const runtimeCard = (s) => {
    const view = M.runtimeView(s);
    if (!view) return '';
    const checking = ui.runtimeChecking || view.checking;
    const busy = view.busy || checking;
    const channelName = view.channel === 'nightly' ? 'Nightly' : 'Stable';
    const targetVersion = view.busy && view.operation.version ? view.operation.version : view.available ? view.latest : null;
    const state = view.busy ? view.phaseText : checking ? 'Checking for updates' : view.available ? channelName + ' update available'
      : view.checkError ? 'Couldn’t check for updates' : view.verified ? 'Up to date' : 'Not checked yet';
    return html`<div class="tc-group tc-runtime" data-key="runtime">
      <div class="tc-row tc-runtime-row">
        <span class="tc-row-lead tc-mark tc-runtime-mark" aria-hidden="true"></span>
        <div class="tc-row-main" role="status" aria-live="polite">
          <div class="tc-row-title"><span class="tc-row-name">T3 Code</span><span class="tc-version">${view.version || 'unknown version'}${targetVersion ? html` <span class="tc-version-arrow" aria-label="to">→</span> ${targetVersion}` : ''}</span>${busy ? html`<span class="tc-badge tc-badge--info"><span class="tc-spinner" aria-hidden="true"></span>${view.busy ? 'Updating' : 'Checking'}</span>` : ''}</div>
          <span class="tc-status">${view.available || view.busy ? '' : view.checkError ? dot('warn') : ''}<span class="tc-status-text"><span>${state}</span>${view.checkedAt && !busy ? ' · checked ' + M.relTime(view.checkedAt, now()) : ''}</span></span>
        </div>
        <div class="tc-row-actions">${view.available || view.error ? html`<button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="t3.update" data-channel="${view.error ? view.operation.channel : view.channel}"${busy || !view.supported || !view.latest ? raw(' disabled') : ''}>${view.error ? 'Retry update' : 'Update and restart'}</button>` : ''}</div>
      </div>
      <div class="tc-row tc-row--compact tc-runtime-channel">
        <div class="tc-row-main"><span class="tc-row-name">Release channel</span><span class="tc-status">${view.channel === 'nightly' ? 'New features first. Nightly builds can be less reliable.' : 'Published releases, for everyday work.'}</span></div>
        <div class="tc-row-actions tc-runtime-channel-actions"><div class="tc-seg" role="group" aria-label="T3 Code release channel">${['stable', 'nightly'].map((channel) => html`<button type="button" data-cmd="t3.channel" data-channel="${channel}" aria-pressed="${view.channel === channel}" ${busy || !view.supported ? 'disabled' : ''}>${channel === 'stable' ? icon('shield-check') : icon('moon')}${channel === 'stable' ? 'Stable' : 'Nightly'}</button>`)}</div></div>
      </div>
      ${view.error || view.checkError ? html`<div class="tc-runtime-notes">
        ${view.error ? notice('danger', 'circle-alert', 'The last T3 Code update didn’t finish', view.error) : ''}
        ${view.checkError ? notice('warn', 'globe', 'Couldn’t check for T3 Code updates', view.checkError + ' The last known releases are shown.') : ''}
      </div>` : ''}
      ${!view.supported || view.separateHistory ? html`<div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>${!view.supported
        ? 'Updating in place needs the container’s T3 Code supervisor. Pull a newer image once to turn it on.'
        : 'An older release shows its own, earlier conversations. Newer ones are kept for when you come back.'}</span></div>` : ''}
    </div>`;
  };

  // Each category's switch, as the Updates page shows it: what it covers, its
  // schedule in a sentence, and a way to change that schedule.
  // In the page's own order: T3 Code, then the agents, then the tools.
  const AUTO_KINDS = [
    ['t3', 'T3 Code', null],
    ['providers', 'Agents', 'bot'],
    ['toolchains', 'Toolchains and tools', 'wrench'],
  ];
  const autoSaving = new Set();
  const autoRow = (auto, [kind, label, glyph]) => {
    const on = Boolean(auto.policy[kind] && auto.policy[kind].enabled);
    const busy = autoSaving.has(kind);
    return html`<div class="tc-row tc-row--compact" data-key="auto-${kind}">
      ${glyph ? html`<span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(glyph)}</span>` : html`<span class="tc-row-lead tc-mark tc-runtime-mark" aria-hidden="true"></span>`}
      <div class="tc-row-main"><span class="tc-row-name" id="auto-${kind}-name">${label}</span><span class="tc-status" id="auto-${kind}-desc">${auto.schedule[kind]}${on && auto.lastChecked[kind] ? ' ' + auto.lastChecked[kind] : ''}</span></div>
      <div class="tc-row-actions">
        ${on ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-cmd="auto.schedule" data-id="${kind}" data-key="auto-schedule-${kind}" aria-label="Change the ${label} schedule">Schedule</button>` : ''}
        <label class="tc-switch-hit" for="auto-toggle-${kind}"><button class="tc-switch" id="auto-toggle-${kind}" type="button" role="switch" aria-checked="${String(on)}" aria-labelledby="auto-${kind}-name" aria-describedby="auto-${kind}-desc" data-cmd="auto.toggle" data-id="${kind}" data-key="auto-toggle-${kind}"${busy ? raw(' disabled aria-busy="true"') : ''}></button></label>
      </div>
    </div>`;
  };

  const updatesPage = (s, n) => {
    const view = M.updatesView(s, ui, n);
    const auto = M.autoUpdateView(s, n);
    const check = M.updateCheckView(s, null, ui.updatePosting || ui.updateAwaiting);
    const checking = check.checking || ui.runtimeChecking;
    const failures = !checking ? check.failures : [];
    const lastChecked = s.updates && s.updates.checkedAt ? M.relTime(s.updates.checkedAt, n) : null;
    const headActions = html`
      <button class="tc-btn tc-btn--sm tc-update-check tc-update-check--label" type="button" data-cmd="updates.check" data-key="updates-check" aria-label="${checking ? 'Checking for updates' : 'Check for updates'}"${check.checking && !check.manual ? raw(' title="Checking in the background. Press to check again now."') : ''} aria-disabled="${String(Boolean(check.manual || ui.runtimeChecking))}">${checking ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking…` : html`${icon('refresh-cw')}Check for updates`}</button>
      ${view.due.length ? html`<button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="updates.all" data-key="updates-all">${icon('circle-arrow-up')}Update all · ${view.due.length}</button>` : ''}`;
    return html`
      ${pageHead('updates', { actions: headActions })}
      ${pageNotices('updates')}
      ${failures.length ? notice('warn', 'globe', M.plural(failures.length, 'source') + (failures.length === 1 ? ' couldn’t be checked' : ' couldn’t be checked'),
        'Their last known releases are shown below.', html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="updates.failures" data-key="updates-failures">Details</button>`) : ''}
      <section class="tc-section" aria-label="T3 Code" data-key="up-t3">${runtimeCard(s) || html`<div class="tc-group"><div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">This T3 Code doesn’t report its release, so it updates with the image.</span></div></div>`}</section>
      ${section('up-available', 'Agents and tools', html`<div class="tc-group">
        ${view.available.length || view.held.length ? html`<div class="tc-list">${view.available.map((row) => resourceRow(row))}${view.held.map((row) => resourceRow(Object.assign({}, row, { action: null, status: { dot: null, text: row.held.text } })))}</div>`
          : html`<div class="tc-empty tc-empty--compact" role="status">${emptyIcon('circle-check')}<span class="tc-empty-title">Everything is up to date</span><span class="tc-empty-desc">${checking ? 'Checking for newer releases…' : lastChecked ? 'Checked ' + lastChecked + '.' : 'Agents, toolchains, added tools and source control CLIs.'}</span></div>`}
      </div>`, { actions: view.available.length && lastChecked && !checking ? muted('Checked ' + lastChecked) : null })}
      ${section('up-auto', 'Automatic updates', html`<div class="tc-group">
        <div class="tc-list">${AUTO_KINDS.map((k) => autoRow(auto, k))}</div>
        <div class="tc-card-foot">${icon(auto.busy ? 'loader-circle' : 'clock', 'tc-icon--sm')}<span>${auto.busy ? auto.busy + '. ' : ''}Installs wait until nothing has used this server for a while. ${auto.lastActivityText}.${auto.lastResult ? ' Last time: ' + auto.lastResult + '.' : ''}</span></div>
      </div>`)}`;
  };

  // ----------------------------------------------------------------- more --
  const THEMES = [['light', 'Light'], ['system', 'System'], ['dark', 'Dark']];
  const themeSeg = (cls) => html`<div class="${cx('tc-seg', cls)}" role="group" aria-label="Theme">${THEMES.map(([mode, label]) => html`<button type="button" aria-pressed="${String(themeMode() === mode)}" data-cmd="theme" data-mode="${mode}">${label}</button>`)}</div>`;
  /** The phone's More: every page the tab bar has no room for, in the sidebar's groups. */
  const morePage = (s, n) => {
    const badges = M.navBadges(s, state.ports, ui);
    const said = M.summaries(s, state.ports, ui, n);
    const groups = T3Routes.grouped()
      .map((group) => ({ ...group, pages: group.pages.filter((page) => T3Routes.tabOf(page.route) === 'more') }))
      .filter((group) => group.pages.length);
    const aside = (route) => {
      const b = badges[route];
      if (b && b.tone === 'warn') return html`<span class="tc-badge tc-badge--warn">${b.count === 1 ? 'Needs you' : b.count + ' need you'}</span>`;
      return html`<span class="tc-linkrow-aside tc-truncate">${(said[route] || {}).text || ''}</span>`;
    };
    return html`
      ${pageHead('more')}
      ${groups.map((group) => section('more-' + group.id, group.label || 'Pages', html`<div class="tc-group">${group.pages.map((page) => html`
        <a class="tc-linkrow" href="#${page.route}">${icon(page.icon)}<span class="tc-linkrow-label">${page.title}</span>${aside(page.route)}${icon('chevron-right')}</a>`)}</div>`))}
      ${section('pm-app', 'Appearance', html`<div class="tc-group"><div class="tc-linkrow">Theme${EMBED ? html`<span class="tc-linkrow-aside">Follows T3 Code</span>` : themeSeg()}</div></div>`)}
      ${section('pm-srv', 'This browser', html`<div class="tc-group">
        ${EMBED
          ? html`<a class="tc-linkrow" href="${BASE + '/' + location.hash}" target="_blank" rel="noopener" data-open-tab>${icon('layout-dashboard')}<span class="tc-linkrow-label">Open in a new tab</span><span class="tc-spacer"></span>${icon('external-link')}</a>`
          : html`<a class="tc-linkrow" href="${t3Url()}" target="_blank" rel="noopener">${icon('layout-dashboard')}<span class="tc-linkrow-label">Open T3 Code</span><span class="tc-spacer"></span>${icon('external-link')}</a>`}
        ${viaT3(s) ? '' : html`<button class="tc-linkrow" type="button" data-cmd="lock">${icon('lock')}<span class="tc-linkrow-label">Lock this browser</span></button>`}
      </div>`)}`;
  };

  // -------------------------------------------------------------- context --
  // Metadata is polled; the editor loads instruction text on demand.
  const contextEditor = { loading: false, layer: null, content: '', saving: false, error: null, provider: null, revision: null, path: '', readError: false };
  const contextSwitching = new Set();
  const instructionsPreview = { signature: null, content: '', error: null, loading: false, generation: 0 };
  const loadInstructionsPreview = async (force = false) => {
    const file = state.status?.context?.agentsMd;
    if (file?.error) { instructionsPreview.generation++; instructionsPreview.loading = false; instructionsPreview.content = ''; instructionsPreview.error = file.error; instructionsPreview.signature = null; return; }
    if (!file?.present) { instructionsPreview.generation++; instructionsPreview.loading = false; instructionsPreview.content = ''; instructionsPreview.error = null; instructionsPreview.signature = null; return; }
    const signature = file.revision || String(file.bytes) + ':' + String(file.modifiedAt || '');
    if (!force && (instructionsPreview.loading || instructionsPreview.signature === signature)) return;
    const generation = ++instructionsPreview.generation;
    instructionsPreview.loading = true; instructionsPreview.error = null; instructionsPreview.signature = signature;
    render();
    const response = await api('/context/agents-md');
    if (generation !== instructionsPreview.generation) return;
    instructionsPreview.loading = false;
    if (response.ok) instructionsPreview.content = response.data.content || '';
    else instructionsPreview.error = response.error;
    render();
  };
  /**
   * What one agent reads at the start of a session, and the choice of it:
   * the shared AGENTS.md, a file of its own, or nothing. Each choice says
   * itself, so the row needs no explaining.
   */
  const contextProviderRow = (row) => {
    const busy = contextSwitching.has(row.id);
    const shared = M.contextView(state.status).present;
    const options = [
      ['shared', 'Shared', !shared && row.mode !== 'shared'],
      ['separate', 'Own ' + row.ownFile, false],
      ['none', 'Nothing', false],
    ];
    return html`
    <div class="tc-reads-row tc-context-provider" data-key="row-${row.key}">
      ${tile(row)}
      <div class="tc-row-main">
        <div class="tc-row-title"><span class="tc-row-name">${row.name}</span>${badge(row.badge)}</div>
        ${row.error ? statusLine(row.status) : html`<span class="tc-reads-path">${row.mode === 'shared' ? icon('link') : ''}<code title="${row.path || ''}">${T3SkillModel.displayPath(row.path, state.status?.paths?.volume) || row.ownFile}</code>${row.mode === 'shared' ? html`<span>→ shared</span>` : ''}${row.mode === 'separate' && typeof row.bytes === 'number' ? html`<span>${M.formatBytes(row.bytes)}</span>` : ''}${row.mode === 'separate' ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="context.provider.edit" data-id="${row.id}" aria-label="Edit ${row.name}’s ${row.ownFile}"${busy ? raw(' disabled') : ''}>Edit</button>` : ''}</span>`}
      </div>
      <div class="tc-seg" role="group" aria-label="What ${row.name} reads">${options.map(([mode, label, off]) => html`<button type="button" data-key="instruction-mode-${row.id}-${mode}" data-cmd="context.provider.mode" data-id="${row.id}" data-mode="${mode}" aria-pressed="${String((row.mode || 'none') === mode)}"${busy || row.error || off ? raw(' disabled') : ''}${off ? raw(' title="Write the shared AGENTS.md first"') : ''}>${label}</button>`)}</div>
    </div>`;
  };

  const CONTEXT_TABS = [['instructions', 'Instructions'], ['skills', 'Skills']];
  /** Instructions and skills: two tabs on one page, each at an address of its own. */
  const instructionsPage = (s) => {
    const tab = state.contextTab;
    const rows = M.contextProviderRows(s);
    const view = M.contextView(s);
    const previewLines = instructionsPreview.content.split('\n', 19);
    const panel = tab === 'skills'
      ? skillsUI.content()
      : html`
        ${view.error ? notice('danger', 'circle-alert', 'Couldn’t read the instructions', view.error) : ''}
        <div class="tc-ins-grid"><section class="tc-ins-section"><div class="tc-ins-section-head"><h2 class="tc-insp-label">Shared instructions</h2><span class="tc-hint">${M.contextAgentsMdRow(s).readers.length ? 'Read by ' + M.listOf(M.contextAgentsMdRow(s).readers) : 'No agents set to Shared'}</span></div><div class="tc-group">
          ${view.error && !view.present ? html`<div class="tc-empty tc-ins-empty" role="status">${emptyIcon('triangle-alert')}<span class="tc-empty-title">Shared instructions unavailable</span><span class="tc-empty-desc">Read the file before making changes. Refresh to try again.</span><button class="tc-btn tc-btn--sm" type="button" data-cmd="refresh">${icon('refresh-cw')}Try again</button></div>` : view.present ? html`<div class="tc-doc-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('file-text')}</span><div class="tc-row-main"><strong>AGENTS.md</strong><span class="tc-hint" title="${M.absTime(s.context?.agentsMd?.modifiedAt)}">${M.formatBytes(view.bytes)}${s.context?.agentsMd?.modifiedAt ? ' · saved ' + M.relTime(s.context.agentsMd.modifiedAt, now()) : ''}</span></div>${!view.error ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cmd="context.menu" aria-label="Shared instructions actions">${icon('ellipsis')}</button><button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="context.edit">${icon('pencil')}Edit</button>` : html`<span class="tc-badge tc-badge--warn">Unavailable</span>`}</div>
            <div class="tc-doc-preview" data-preview-state="${instructionsPreview.loading ? 'loading' : instructionsPreview.error ? 'error' : 'content'}">${instructionsPreview.loading ? html`<p class="tc-hint" role="status">Reading shared instructions…</p>` : instructionsPreview.error ? notice('warn', 'triangle-alert', 'Preview unavailable', instructionsPreview.error, html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="context.preview.retry">Retry preview</button>`) : T3SkillInspector.code(previewLines.slice(0, 18).join('\n'), 'Shared AGENTS.md preview')}</div>
            <div class="tc-card-foot tc-doc-foot"><code>${T3SkillModel.displayPath(s.context?.agentsMd?.path || '', s.paths?.volume)}</code><span>${previewLines.length > 18 && !instructionsPreview.loading && !instructionsPreview.error ? 'First 18 lines · ' : ''}On the state volume</span></div>` : html`<div class="tc-empty tc-ins-empty">${emptyIcon('file-text')}<span class="tc-empty-title">No shared instructions yet</span><span class="tc-empty-desc">Write them once and every agent set to Shared reads them.</span><button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="context.edit">${icon('pencil')}Write AGENTS.md</button></div>`}
        </div></section><section class="tc-ins-section"><div class="tc-ins-section-head"><h2 class="tc-insp-label">What each agent reads</h2></div><div class="tc-group">
          ${rows.length ? html`<div class="tc-list">${rows.map(contextProviderRow)}</div>`
            : html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">No agent that reads global instructions is installed.</span></div>`}
          <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Switching away from an own file keeps it as a backup next to it.</span></div>
        </div><p class="tc-hint">Cursor, Grok Build, Muse Code and Antigravity global instructions aren’t managed here. A repository’s own AGENTS.md still applies on top of these.</p></section></div><p class="tc-hint tc-ins-session-note">Agents read instructions when a session starts. Start a new one after you save.</p>`;
    return html`
      <header class="tc-instructions-phone-head"><a class="tc-btn tc-btn--ghost" href="#more">${icon('chevron-right', 'tc-back-icon')}Setup</a><h1>Instructions & skills</h1>${EMBED ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-cmd="embed.close" aria-label="Close setup">${icon('x')}</button>` : html`<a class="tc-btn tc-btn--ghost tc-btn--icon" href="${T3Routes.docUrl('context-management.md', s.image?.version)}" target="_blank" rel="noopener" aria-label="Instructions and skills guide">${icon('info')}</a>`}</header>
      ${pageHead('instructions')}
      <div class="tc-tabs" role="tablist" aria-label="Instructions and skills" data-key="cx-tabs">${CONTEXT_TABS.map(([value, label]) => html`<button class="tc-tab-button" type="button" role="tab" id="cx-tab-${value}" aria-controls="cx-panel" aria-selected="${String(tab === value)}" tabindex="${tab === value ? '0' : '-1'}" data-cmd="context.tab" data-value="${value}">${label}${value === 'skills' && skillsUI.count() ? html` <span class="tc-tab-count">${skillsUI.count()}</span>` : ''}</button>`)}</div>
      ${pageNotices('instructions')}
      <div class="tc-tabpanel" role="tabpanel" id="cx-panel" aria-labelledby="cx-tab-${tab}" data-key="cx-panel-${tab}">${panel}</div>`;
  };

  const downloadMarkdown = (filename, content) => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const readMarkdownFile = async (file, maxBytes) => {
    if (!/\.md$/i.test(file.name)) throw new Error('Choose a Markdown (.md) file.');
    if (file.size > maxBytes) throw new Error('File too large (' + (maxBytes / 1024) + ' KB max).');
    return file.text();
  };

  const openContextEditor = async (trigger, provider = null) => {
    if (contextEditor.layer) return;
    Object.assign(contextEditor, { content: '', original: '', loading: true, saving: false, error: null, provider, revision: null, path: '', readError: false });
    const providerName = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }[provider];
    const filename = provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
    const title = provider ? providerName + '’s ' + filename : 'Shared AGENTS.md';
    const readers = M.contextAgentsMdRow(state.status).readers;
    const isDirty = () => !contextEditor.readError && contextEditor.content !== contextEditor.original;
    const beforeUnload = event => { if (contextEditor.saving || isDirty()) { event.preventDefault(); event.returnValue = ''; } };
    const close = async () => {
      if (contextEditor.saving) { Kit.announce('Wait for instructions to finish saving before leaving'); return false; }
      if (isDirty()) {
        const confirmed = await Kit.confirm({ title: 'Discard these instruction changes?', body: 'Your unsaved changes will be lost. You can keep editing and download a copy first.', confirm: 'Discard draft', tone: 'danger' });
        if (!confirmed || contextEditor.layer !== layer) return false;
      }
      if (contextEditor.layer !== layer) return false;
      layer.close('cancel'); return true;
    };
    contextEditor.requestClose = close;
    const editorMeta = () => contextEditor.loading ? 'Loading…'
      : M.formatBytes(new TextEncoder().encode(contextEditor.content).length) + ' · ' + (isDirty() ? 'Unsaved changes' : contextEditor.revision ? 'Saved' : 'New file');
    contextEditor.layer = Kit.open({
      kind: 'center',
      panel: { tag: 'div', class: 'tc-sheet tc-context-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cx-title' },
      returnTo: trigger,
      backdrop: 'ignore',
      onEscape: () => { void close(); },
      render: () => html`
        <div class="tc-sheet-head">${provider ? tile({ mark: provider }, 'lg') : html`<span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('book-open')}</span>`}<div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="cx-title">${title}</h2><span class="tc-small tc-muted">${provider ? 'Only ' + providerName + ' reads this file' : readers.length ? 'Read by ' + M.listOf(readers) : 'For every agent set to read it'}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-sheet="close" aria-label="Close"${contextEditor.saving ? raw(' disabled') : ''}>${icon('x')}</button></div>
        <div class="tc-sheet-body">
          ${contextEditor.error ? notice('danger', 'circle-alert', 'Could not load or save instructions', contextEditor.error) : ''}
          ${provider && contextEditor.path ? html`<span class="tc-hint tc-context-path" title="${contextEditor.path}">${contextEditor.path}</span>` : ''}
          <div class="tc-editor-toolbar"><label class="tc-label" for="cx-input">Markdown</label><div class="tc-editor-tools"><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-sheet="upload" title="Replace this draft from a Markdown file"${contextEditor.loading || contextEditor.saving || contextEditor.readError ? raw(' disabled') : ''}>${icon('upload')}Upload</button><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-sheet="download" title="Download, including unsaved edits"${contextEditor.loading || contextEditor.saving || contextEditor.readError ? raw(' disabled') : ''}>${icon('download')}Download</button><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-sheet="copy"${contextEditor.loading || contextEditor.saving || contextEditor.readError ? raw(' disabled') : ''}>${icon('copy')}Copy</button></div><input id="cx-file" data-key="cx-file" type="file" accept=".md,text/markdown" aria-label="Upload instructions Markdown" hidden></div>
          <textarea class="tc-input tc-input--area tc-editor-area" id="cx-input" data-key="cx-input" aria-describedby="cx-meta"${contextEditor.loading || contextEditor.saving || contextEditor.readError ? raw(' disabled') : ''} rows="14" spellcheck="false" placeholder="${provider ? '# ' + providerName + ' instructions\n\nWrite guidance only ' + providerName + ' should follow.' : '# Instructions\n\nWrite guidance every agent reading this file should follow.'}">${contextEditor.content}</textarea>
          <div class="tc-editor-meta"><span id="cx-meta" data-key="cx-meta">${editorMeta()}</span><span>${provider ? 'Saving updates this file wherever it is used. Symlinks stay in place.' : 'Agents with a file of their own keep it.'}<span class="tc-desk-only"> Ctrl/⌘ S to save.</span></span></div>
        </div>
        <div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-sheet="close"${contextEditor.saving ? raw(' disabled') : ''}>Cancel</button><button class="tc-btn tc-btn--primary" type="button" data-sheet="save"${!isDirty() || contextEditor.loading || contextEditor.saving ? raw(' disabled') : ''}>${contextEditor.saving ? 'Saving…' : 'Save'}</button></div>`,
      focus: '#cx-input',
      onClose: () => { window.removeEventListener('beforeunload', beforeUnload); contextEditor.layer = null; contextEditor.requestClose = null; },
    });
    const layer = contextEditor.layer;
    const panel = layer.panel;
    window.addEventListener('beforeunload', beforeUnload);
    const syncEditor = () => {
      const meta = panel.querySelector('#cx-meta');
      if (meta) meta.textContent = editorMeta();
      const save = panel.querySelector('[data-sheet="save"]');
      if (save) save.disabled = !isDirty() || contextEditor.loading || contextEditor.saving;
    };
    panel.addEventListener('change', async (e) => {
      if (e.target.id !== 'cx-file' || !e.target.files?.[0]) return;
      const file = e.target.files[0];
      e.target.value = '';
      contextEditor.loading = true;
      contextEditor.error = null;
      layer.render();
      try {
        const content = await readMarkdownFile(file, 64 * 1024);
        if (contextEditor.layer !== layer) return;
        contextEditor.content = content;
      } catch (error) {
        if (contextEditor.layer !== layer) return;
        contextEditor.error = error.message;
      }
      contextEditor.loading = false;
      layer.render();
      const area = panel.querySelector('#cx-input');
      if (area) { area.value = contextEditor.content; area.focus(); }
    });
    panel.addEventListener('input', (e) => {
      if (e.target.id === 'cx-input') { contextEditor.content = e.target.value; syncEditor(); }
    });
    panel.addEventListener('keydown', (e) => {
      if (e.target.id === 'cx-input' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        panel.querySelector('[data-sheet="save"]')?.click();
      }
    });
    panel.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-sheet]');
      if (!action || action.disabled) return;
      const what = action.getAttribute('data-sheet');
      if (what === 'close') await close();
      else if (what === 'upload') panel.querySelector('#cx-file').click();
      else if (what === 'download') downloadMarkdown(filename, contextEditor.content);
      else if (what === 'copy') Kit.copy(contextEditor.content, action, filename + ' copied');
      else if (what === 'save') {
        if (!isDirty() || contextEditor.loading || contextEditor.saving) return;
        contextEditor.saving = true;
        contextEditor.error = null;
        contextEditor.layer.render();
        const body = { content: contextEditor.content, revision: contextEditor.revision };
        if (provider) body.provider = provider;
        const save = await api('/context/agents-md', { body });
        if (contextEditor.layer !== layer) return;
        contextEditor.saving = false;
        if (!save.ok) { contextEditor.error = save.error; contextEditor.layer.render(); return; }
        contextEditor.layer.close('saved');
        const skipped = (save.data?.reconcile?.skipped || []).filter((target) => !target.preserved);
        Kit.toast(provider ? 'Saved ' + providerName + '’s ' + filename : 'Saved the shared AGENTS.md', skipped.length ? { tone: 'warn', detail: skipped.map((t) => t.provider + ': ' + t.reason).join('; ') } : undefined);
        loadStatus();
      }
    });
    // Load current content.
    const res = await api('/context/agents-md' + (provider ? '?provider=' + encodeURIComponent(provider) : ''));
    if (contextEditor.layer !== layer) return;
    contextEditor.loading = false;
    if (res.ok) {
      contextEditor.content = res.data.content || '';
      contextEditor.original = contextEditor.content;
      contextEditor.revision = res.data.revision || null;
      contextEditor.path = res.data.resolvedPath || res.data.path || '';
    } else {
      contextEditor.error = res.error;
      contextEditor.readError = true;
    }
    contextEditor.layer.render();
    const area = panel.querySelector('#cx-input');
    if (area) { area.value = contextEditor.content; area.focus(); }
  };

  // ---------------------------------------------------------------- shell --
  const PAGES = {
    files: () => html`${filesUI.phoneHead()}${pageHead('files')}${filesUI.content()}`,
    overview: overviewPage, access: accessPage, agents: agentsPage, instructions: instructionsPage,
    mcp: () => html`${mcpUI.phoneHead()}${pageHead('mcp', { sub: 'Servers your agents can start or connect to. Define one once, then add it to the agents you choose.' })}${mcpUI.content()}`,
    credentials: () => html`${pageHead('credentials')}${credentialsUI.content()}`,
    toolchains: toolchainsPage, sourcecontrol: sourceControlPage, ports: portsPage,
    updates: updatesPage, storage: storagePage, server: serverPage, more: morePage,
  };
  const ROUTES = Object.keys(PAGES);
  const titleOf = (route) => (T3Routes.page(route) || {}).title || route;

  /** A sidebar mark: a count of what needs the person, or a quiet sign of work or of something live. */
  const NAV_MARK = {
    warn: (b) => ({ cls: 'tc-nav-badge tc-badge tc-badge--warn tc-badge--count', text: String(b.count), title: M.plural(b.count, 'thing needs', 'things need') + ' you' }),
    running: (b) => ({ cls: 'tc-nav-badge tc-nav-mark tc-nav-mark--running', text: '', title: M.plural(b.count, 'install') + ' running' }),
    live: (b) => ({ cls: 'tc-nav-badge tc-nav-mark tc-nav-mark--live', text: '', title: M.plural(b.count, 'port') + ' published' }),
    count: (b) => ({ cls: 'tc-nav-badge tc-badge tc-badge--info tc-badge--count', text: String(b.count), title: M.plural(b.count, 'update') + ' available' }),
  };
  const navMark = (b) => (!b ? null : b.tone === 'warn' ? NAV_MARK.warn(b) : NAV_MARK[b.kind] ? NAV_MARK[b.kind](b) : null);

  const renderShell = (s, n) => {
    const badges = M.navBadges(s, state.ports, ui);
    for (const route of ROUTES) {
      const el = $('nav-' + route);
      const mark = navMark(badges[route]);
      if (el) {
        const cls = mark ? mark.cls : 'tc-nav-badge';
        if (el.className !== cls) el.className = cls;
        if (el.textContent !== (mark ? mark.text : '')) el.textContent = mark ? mark.text : '';
        el.hidden = !mark;
        // Said with the link's name, so a screen reader hears "Agents, 2 things need you".
        if (mark) el.setAttribute('aria-label', mark.title); else el.removeAttribute('aria-label');
        el.title = mark ? mark.title : '';
      }
      const tab = $('tab-' + route);
      if (tab) tab.hidden = !(badges[route] && badges[route].tone === 'warn');
    }
    const server = s.server || {};
    const image = s.image || {};
    patch($('server-card'), html`
      <div class="tc-server-row">${dot(server.ok ? 'ok' : 'danger', server.ok && 'tc-dot--live')}<strong>${server.ok ? 'Running' : 'Not answering'}</strong></div>
      <div class="tc-server-row"><span class="tc-mono tc-truncate" title="${['T3 Code ' + (server.version || ''), 'image ' + (M.imageLabel(image).full || 'unversioned')].join(' · ')}">${M.imageLabel(image).text || 'unversioned build'}</span></div>`);
    patch($('phone-status'), html`${dot(server.ok ? 'ok' : 'danger', server.ok && 'tc-dot--live')}${server.ok ? 'Running' : 'Down'}`);
    for (const link of document.querySelectorAll('[data-open-t3]')) if (link.getAttribute('href') !== t3Url()) link.setAttribute('href', t3Url());
    for (const link of document.querySelectorAll('[data-open-tab]')) if (link.getAttribute('href') !== BASE + '/' + location.hash) link.setAttribute('href', BASE + '/' + location.hash);
  };

  const render = () => {
    const s = state.status;
    const n = now();
    document.body.dataset.consoleRoute = state.route;
    if (s) renderShell(s, n);
    const route = state.route;
    const el = $('page-' + route);
    if (!el) return;
    if (!s) {
      // Still waiting for the first answer: keep the skeleton, unless the
      // answer was an error worth showing.
      if (state.statusError) patch(el, html`${pageHead(route)}${pageNotices(route)}${skeletonGroup(3)}`);
      return;
    }
    patch(el, PAGES[route](s, n));
  };

  // --------------------------------------------------------------- routes --
  // #agents, or an address a page had before it moved (#devices once it is
  // Access), which is rewritten in place so the address bar says where it is.
  const routeFromHash = () => {
    const [name, sub] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
    if (name === 'instructions' && sub === 'mcp') { history.replaceState(null, '', '#mcp'); return 'mcp'; }
    const route = T3Routes.resolve(name);
    if (route && route !== name) history.replaceState(null, '', '#' + route + (sub ? '/' + sub : ''));
    if (route === 'instructions') state.contextTab = sub === 'skills' ? 'skills' : 'instructions';
    return route && PAGES[route] ? route : 'overview';
  };
  const go = (route) => {
    if (location.hash === '#' + route) void navigateFromHash(true);
    else location.hash = route;
  };
  let first = true;
  let shownHash = location.hash, navigationTask = null, navigationVersion = 0;
  const show = (route, focus) => {
    const changed = route !== state.route || first;
    state.route = route;
    Kit.closeAll('route');
    for (const page of document.querySelectorAll('.tc-page[data-route]')) page.hidden = page.getAttribute('data-route') !== route;
    for (const link of document.querySelectorAll('[data-nav]')) {
      const here = link.getAttribute('data-nav') === route
        || (link.closest('.tc-tabbar') && link.getAttribute('data-nav') === T3Routes.tabOf(route));
      if (here) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    render();
    if (changed && !first) {
      window.scrollTo(0, 0);
      Kit.announce(titleOf(route));
      if (focus) $('main').focus({ preventScroll: true });
    }
    first = false; shownHash = location.hash;
    if (route === 'ports' && !state.ports) loadPorts();
    if (route === 'instructions' && state.contextTab === 'skills' && state.status) skillsUI.activate(true);
    if (route === 'instructions' && state.contextTab === 'instructions' && state.status) void loadInstructionsPreview(true);
    if (route === 'mcp' && state.status) mcpUI.activate(true);
    if (route === 'credentials' && state.status) credentialsUI.activate(true);
    if (route === 'files' && state.status) filesUI.activate();
  };
  const navigateFromHash = async focus => {
    const version = ++navigationVersion;
    // Back/forward can arrive while a discard confirmation is open. Share the
    // decision, then apply only the latest destination; cancelled navigation
    // keeps the old route, tab and draft together.
    if (!navigationTask) navigationTask = (async () => {
      if (contextEditor.layer && !await contextEditor.requestClose()) return false;
      if (!await skillsUI.beforeNavigate()) return false;
      if (!await mcpUI.beforeNavigate()) return false;
      return filesUI.beforeNavigate();
    })();
    const allowed = await navigationTask;
    if (version !== navigationVersion) return;
    navigationTask = null;
    if (!allowed) { history.replaceState(null, '', shownHash || location.pathname + location.search); return; }
    show(routeFromHash(), focus);
  };
  window.addEventListener('hashchange', () => { void navigateFromHash(keyboardNav); });
  let keyboardNav = false;

  // ---------------------------------------------------------------- theme --
  const THEME_KEY = 't3-console-theme';
  const themeMode = () => {
    // Inside T3 Code the theme is T3's (BOOT read it from the address).
    if (EMBED) return document.documentElement.getAttribute('data-theme-mode') || 'system';
    try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
  };
  const SYSTEM_DARK = window.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = (mode) => {
    const resolved = mode === 'system' ? (SYSTEM_DARK.matches ? 'dark' : 'light') : mode;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', mode);
    const toggle = $('theme-toggle');
    if (toggle) {
      const next = { system: 'light', light: 'dark', dark: 'system' }[mode];
      toggle.innerHTML = String(icon(mode === 'system' ? 'monitor' : mode === 'dark' ? 'moon' : 'sun'));
      toggle.setAttribute('aria-label', 'Theme: ' + (mode === 'system' ? 'following the system' : mode) + '. Switch to ' + (next === 'system' ? 'the system theme' : next));
      toggle.title = toggle.getAttribute('aria-label');
    }
  };
  const setTheme = (mode) => {
    if (!EMBED) {
      try { localStorage.setItem(THEME_KEY, mode); } catch { /* this session only */ }
    }
    applyTheme(mode);
    render();
  };
  SYSTEM_DARK.addEventListener('change', () => { if (themeMode() === 'system') applyTheme('system'); });

  // -------------------------------------------------------------- sign-in --
  // A sheet that follows each CLI's real flow as numbered steps. The server
  // runs the CLI; this page shows what it printed and polls until the
  // manager's probe says the agent is signed in.
  const signin = { layer: null, agent: null, session: null, phase: 'idle', error: null, cancelled: false, startedAt: 0, poll: null, tick: null };

  // Pieces of a sheet that walks through numbered steps: the agent sign-ins
  // and T3 Connect's both.
  const sheetQr = (st) => st.qr ? html`<div class="tc-qr tc-qr--sm tc-desk-only" role="img" aria-label="QR code for the sign-in page" data-keep>${qrSvg(st.qr)}</div>` : '';
  const sheetWaiting = (text, extra) => html`<div class="tc-op tc-op--quiet"><span class="tc-op-line">${raw('<span class="tc-spinner tc-info" aria-hidden="true"></span>')}<span>${text}</span></span><span class="tc-op-pct">${extra || ''}</span></div>`;
  const sheetStep = (n, title, stateName, body) => html`<div class="tc-sheet-step"${stateName ? raw(' data-state="' + stateName + '"') : ''}><span class="tc-step-mark">${stateName === 'done' ? icon('check') : String(n)}</span><div class="tc-sheet-step-body"><span class="${cx('tc-sheet-step-title', !stateName && 'tc-muted')}">${title}</span>${body || ''}</div></div>`;
  /** A device-code sign-in's first two steps: the page to open, and the code to enter there. */
  const deviceSteps = (st) => {
    const left = st.expiresAt ? M.countdown(st.expiresAt - now()) : null;
    return html`
      ${sheetStep(1, 'Open the device page', 'done', html`<div class="tc-signin-split"><div class="tc-stack tc-signin-fields">${copyField(st.url, { actions: copyButton(st.url, 'Copy device page link', { iconOnly: true }) })}<a class="tc-btn tc-btn--sm tc-self-start" href="${st.url}" target="_blank" rel="noopener">${icon('external-link')}Open device page</a>${st.qr ? html`<span class="tc-hint tc-desk-only">Or scan to approve on your phone.</span>` : ''}</div>${sheetQr(st)}</div>`)}
      ${sheetStep(2, 'Enter this code there', 'active', st.code
        ? html`${copyField(st.code, { code: true })}${sheetWaiting('Waiting for you to approve…', left ? 'expires in ' + left : '')}`
        : sheetWaiting('Waiting for the code…'))}`;
  };

  /** What signs in through this sheet: an agent, or az's device code. */
  const signinMeta = (id) => M.AGENTS[id] || M.SOURCE_CONTROL[id] || {};
  const signinSheet = () => {
    const meta = signinMeta(signin.agent);
    const st = signin.session || {};
    const host = M.hostOf(st.url);
    const qr = sheetQr(st);
    const waiting = sheetWaiting;
    const step = sheetStep;
    const openPage = (label) => html`<div class="tc-signin-open"><a class="tc-btn" href="${st.url}" target="_blank" rel="noopener">${icon('external-link')}${label}</a>${copyButton(st.url, 'Copy the sign-in link', { iconOnly: true, size: '' })}</div>`;
    let body;
    if (signin.phase === 'failed') {
      body = html`${notice('danger', 'circle-alert', 'Sign-in did not finish', signin.error || 'The CLI stopped before it reported a session.')}
        ${st.tail ? html`<pre class="tc-log-tail">${st.tail}</pre>` : ''}`;
    } else if (!st.url) {
      body = step(1, 'Starting ' + (meta.name || 'the CLI'), 'active', waiting('Waiting for ' + (meta.name || 'it') + ' to print a sign-in link…'));
    } else if (meta.flow === 'device') {
      body = html`
        ${deviceSteps(st)}
        ${step(3, 'Signed in', '', html`<span class="tc-hint">This sheet closes on its own when ${meta.name} reports a session.</span>`)}`;
    } else if (meta.flow === 'code') {
      const submitted = st.state === 'submitted' || signin.phase === 'submitting';
      body = html`
        ${step(1, 'Approve on ' + (host.replace(/^www\./, '') || 'the sign-in page'), 'done', html`<div class="tc-signin-split"><div class="tc-stack tc-signin-fields">${openPage('Open sign-in page')}<span class="tc-hint">Opens in a new tab. Come back here for the code.</span></div>${qr}</div>`)}
        ${step(2, 'Paste the code it shows you', submitted ? 'done' : 'active', html`
          <form class="tc-signin-code" data-sheet-form="code" novalidate>
            <label class="tc-sr" for="signin-code">Code from the sign-in page</label>
            <input id="signin-code" name="code" class="tc-input tc-input--mono" placeholder="Paste the code" autocomplete="one-time-code" autocapitalize="off" spellcheck="false"${submitted ? raw(' disabled') : ''}>
            <button class="tc-btn tc-btn--primary" type="submit"${submitted ? raw(' disabled') : ''}>${submitted ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking` : 'Submit'}</button>
          </form>`)}
        ${submitted ? step(3, 'Signed in', 'active', waiting('Waiting for ' + meta.name + ' to accept the code…')) : step(3, 'Signed in', '', '')}`;
    } else if (meta.flow === 'redirect') {
      // T3's Google sign-in: Google sends the browser to a 127.0.0.1 address
      // only the container could answer; that address, pasted here, finishes it.
      const submitted = st.state === 'submitted' || signin.phase === 'submitting';
      const left = st.expiresAt ? M.countdown(st.expiresAt - now()) : null;
      body = html`
        ${step(1, 'Sign in with Google', 'done', html`<div class="tc-stack tc-signin-fields">${openPage('Open Google sign-in')}<span class="tc-hint">Opens in a new tab. Choose the Google account ${meta.name} should use.</span></div>`)}
        ${step(2, 'Paste the address Google sends you to', submitted ? 'done' : 'active', html`
          <span class="tc-hint">After you approve, the tab goes to an address starting with <code>http://127.0.0.1</code> that does not load. That is expected: copy the whole address from the address bar and paste it here.</span>
          <form class="tc-signin-code" data-sheet-form="code" novalidate>
            <label class="tc-sr" for="signin-code">The address Google sent you to</label>
            <input id="signin-code" name="code" type="url" class="tc-input tc-input--mono" placeholder="http://127.0.0.1:…/?code=…" autocomplete="off" autocapitalize="off" spellcheck="false"${submitted ? raw(' disabled') : ''}>
            <button class="tc-btn tc-btn--primary" type="submit"${submitted ? raw(' disabled') : ''}>${submitted ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking` : 'Submit'}</button>
          </form>
          ${signin.pasteError && !submitted ? html`<span class="tc-hint tc-hint--err" role="alert">${signin.pasteError}</span>` : ''}
          ${left && !submitted ? html`<span class="tc-hint">This sign-in link works for ${left} more.</span>` : ''}`)}
        ${submitted ? step(3, 'Signed in', 'active', waiting('Waiting for T3 Code to check it…')) : step(3, 'Signed in', '', '')}`;
    } else {
      body = html`
        ${step(1, 'Open the sign-in page', 'done', html`<div class="tc-signin-split"><div class="tc-stack tc-signin-fields">${openPage('Open sign-in page')}<span class="tc-hint">Sign in there with the account ${meta.name} should use.</span></div>${qr}</div>`)}
        ${step(2, 'Approve, then come back', 'active', waiting('Waiting for ' + meta.name + ' to report a session…'))}`;
    }
    return html`
      <div class="tc-sheet-head">${tile(meta, 'lg')}<div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="signin-title">Sign in to ${meta.provider || meta.name}</h2>${meta.command ? html`<span class="tc-small tc-muted">Runs <code>${meta.command}</code> for you</span>` : meta.flow === 'redirect' ? html`<span class="tc-small tc-muted">T3 Code’s own Google sign-in</span>` : ''}</div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-sheet="cancel" aria-label="Close and cancel sign-in">${icon('x')}</button></div>
      <div class="tc-sheet-body" aria-live="polite">${body}</div>
      <div class="tc-sheet-foot">${signin.phase === 'failed'
        ? html`<button class="tc-btn tc-btn--ghost" type="button" data-sheet="close">Close</button><button class="tc-btn tc-btn--primary" type="button" data-sheet="retry">${icon('refresh-cw')}Try again</button>`
        : html`<span class="tc-sheet-foot-note tc-desk-only"><span class="tc-kbd">Esc</span> cancels</span><button class="tc-btn tc-btn--ghost" type="button" data-sheet="cancel">Cancel sign-in</button>`}</div>`;
  };

  const endSignin = () => {
    clearTimeout(signin.poll);
    clearInterval(signin.tick);
    signin.poll = null;
    signin.tick = null;
    ui.signingIn = null;
    render();
  };

  const cancelSignin = () => {
    signin.cancelled = true;
    const id = signin.session && signin.session.id;
    if (id && signin.phase !== 'failed') api('/auth/cancel', { body: { id } });
    if (signin.layer) signin.layer.close('cancel');
  };

  const pollSignin = async () => {
    if (!signin.layer || signin.cancelled || !signin.session) return;
    const attempt = signin.attempt;
    const res = await api('/auth/session?id=' + encodeURIComponent(signin.session.id));
    if (!signin.layer || signin.cancelled || signin.attempt !== attempt) return;
    if (!res.ok) {
      signin.phase = 'failed';
      signin.error = res.status === 404 ? 'The setup service no longer knows this sign-in (it may have restarted).' : res.error;
      signin.layer.render();
      return;
    }
    const st = res.data;
    signin.session = Object.assign({}, signin.session, st, { expiresAt: st.expiresAt || signin.session.expiresAt });
    if (st.state === 'done') {
      const meta = signinMeta(signin.agent);
      signin.layer.close('done');
      // A source control CLI names its host (GitHub), an agent itself. What
      // came after the sign-in and did not work (gh as git's credential
      // helper) is said, without undoing it.
      Kit.toast('Signed in to ' + (meta.provider || meta.name || signin.agent), st.warning ? { detail: st.warning } : undefined);
      loadStatus();
      return;
    }
    if (st.state === 'failed' || st.state === 'cancelled') {
      signin.phase = 'failed';
      signin.error = st.error || (st.state === 'cancelled' ? 'Sign-in was cancelled.' : null);
      signin.layer.render();
      return;
    }
    if (signin.phase === 'submitting' && st.state !== 'submitted') signin.phase = 'awaiting';
    signin.layer.render();
    signin.poll = setTimeout(pollSignin, 1500);
  };

  const beginSignin = async () => {
    // Each start is an attempt; an answer for an older one (the sheet closed,
    // or Try again was pressed, while the CLI was starting) only cleans up.
    const attempt = signin.attempt = (signin.attempt || 0) + 1;
    signin.phase = 'starting';
    signin.session = null;
    signin.error = null;
    signin.layer.render();
    const res = await api('/auth/signin', { body: { agent: signin.agent } });
    if (!signin.layer || signin.cancelled || signin.attempt !== attempt) {
      if (res.ok && res.data.id) api('/auth/cancel', { body: { id: res.data.id } });
      return;
    }
    if (!res.ok) {
      signin.phase = 'failed';
      signin.error = res.error;
      signin.layer.render();
      return;
    }
    signin.session = Object.assign({}, res.data, { expiresAt: res.data.expiresAt || now() + 15 * 60 * 1000 });
    signin.phase = 'awaiting';
    signin.layer.render();
    signin.poll = setTimeout(pollSignin, 1200);
  };

  const openSignin = (id, trigger) => {
    if (signin.layer) return;
    Object.assign(signin, { agent: id, session: null, phase: 'starting', error: null, pasteError: null, cancelled: false, startedAt: now() });
    ui.signingIn = id;
    render();
    signin.layer = Kit.open({
      kind: 'sheet',
      panel: { tag: 'aside', class: 'tc-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'signin-title' },
      returnTo: trigger,
      backdrop: 'ignore',
      render: signinSheet,
      onEscape: cancelSignin,
      onClose: (reason) => {
        // Closed by anything but success or an explicit cancel (a route
        // change, the back button): the CLI is still waiting, so stop it.
        const id = signin.session && signin.session.id;
        if (reason !== 'done' && !signin.cancelled && signin.phase !== 'failed' && id) api('/auth/cancel', { body: { id } });
        signin.cancelled = reason !== 'done';
        signin.layer = null;
        endSignin();
      },
    });
    const panel = signin.layer.panel;
    panel.addEventListener('click', (e) => {
      const action = e.target.closest('[data-sheet]');
      if (!action) return;
      const what = action.getAttribute('data-sheet');
      if (what === 'cancel') cancelSignin();
      else if (what === 'close') signin.layer.close('close');
      else if (what === 'retry') { signin.cancelled = false; beginSignin(); }
    });
    panel.addEventListener('submit', async (e) => {
      const form = e.target.closest('[data-sheet-form="code"]');
      if (!form) return;
      e.preventDefault();
      const code = form.querySelector('input').value.trim();
      if (!code || !signin.session) { form.querySelector('input').focus(); return; }
      signin.phase = 'submitting';
      signin.pasteError = null;
      signin.layer.render();
      const res = await api('/auth/code', { body: { id: signin.session.id, code } });
      if (!res.ok && signinMeta(signin.agent).flow === 'redirect') {
        // T3 keeps the sign-in waiting after a wrong address: say why, and
        // let the right one be pasted.
        signin.phase = 'awaiting';
        signin.pasteError = res.error;
      } else if (!res.ok) {
        signin.phase = 'failed';
        signin.error = res.error;
      } else {
        signin.session = Object.assign({}, signin.session, res.data);
      }
      if (signin.layer) signin.layer.render();
    });
    // The device code's countdown.
    signin.tick = setInterval(() => {
      if (signin.layer && signin.session && (signin.session.code || signinMeta(signin.agent).flow === 'redirect')) signin.layer.render();
    }, 1000);
    beginSignin();
  };

  // ------------------------------------------------ source control sign-in --
  // gh, glab, fj and tea sign in with a token for one host, made on that host
  // with the scopes T3 Code needs. The setup service hands it to the CLI on
  // stdin and asks the host whether it took it; az uses the device-code sheet
  // above.
  const scmSheet = { layer: null, id: null, host: '', reveal: false, saving: false, error: null };
  const scmHostOf = () => {
    const field = scmSheet.layer && scmSheet.layer.panel.querySelector('#scm-host');
    return ((field ? field.value : scmSheet.host) || '').trim().replace(/^https:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  };
  const scmSheetBody = () => {
    const meta = M.SOURCE_CONTROL[scmSheet.id] || {};
    const host = scmHostOf() || meta.host;
    const page = meta.tokenPage ? meta.tokenPage(host) : null;
    return html`
      <div class="tc-sheet-head">${tile(Object.assign({}, meta, { hue: '--id-toolchain' }), 'lg')}<div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="scm-title">Sign in to ${meta.provider}</h2><span class="tc-small tc-muted">Runs <code>${meta.tokenCommand}</code> for you, with the token ${meta.handover}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-sheet="close" aria-label="Close">${icon('x')}</button></div>
      <div class="tc-sheet-body">
        <div class="tc-sheet-step" data-state="done"><span class="tc-step-mark">1</span><div class="tc-sheet-step-body"><label class="tc-sheet-step-title" for="scm-host">Server</label>
          <input id="scm-host" name="host" class="tc-input tc-input--mono" value="${scmSheet.host}" placeholder="${meta.host}" autocomplete="off" spellcheck="false" autocapitalize="off" inputmode="url">
          <span class="tc-hint">${meta.host} unless yours runs somewhere else.</span></div></div>
        <div class="tc-sheet-step" data-state="active"><span class="tc-step-mark">2</span><div class="tc-sheet-step-body"><span class="tc-sheet-step-title">Make a token there</span>
          ${page ? html`<a class="tc-btn tc-btn--sm tc-self-start" href="${page}" target="_blank" rel="noopener" data-key="scm-page">${icon('external-link')}Open ${host}’s token page</a>` : ''}
          <span class="tc-hint">With these scopes: ${meta.scopes}.</span></div></div>
        <div class="tc-sheet-step"><span class="tc-step-mark">3</span><div class="tc-sheet-step-body"><label class="tc-sheet-step-title" for="scm-token">Paste it here</label>
          <div class="tc-inputwrap"><input id="scm-token" name="token" class="tc-input tc-input--mono" type="${scmSheet.reveal ? 'text' : 'password'}" placeholder="Token" autocomplete="off" spellcheck="false" autocapitalize="off"><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-sheet="reveal" aria-label="${scmSheet.reveal ? 'Hide' : 'Show'} token" aria-pressed="${String(scmSheet.reveal)}">${icon(scmSheet.reveal ? 'eye-off' : 'eye')}</button></div>
          ${scmSheet.error ? html`<p class="tc-hint tc-hint--err" role="alert">${scmSheet.error}</p>` : html`<span class="tc-hint">Kept by ${meta.name} on the state volume, and checked with ${host || meta.host} before it counts.</span>`}</div></div>
      </div>
      <div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-sheet="close">Cancel</button><button class="tc-btn tc-btn--primary" type="submit" data-key="scm-save" disabled>${scmSheet.saving ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking` : 'Sign in'}</button></div>`;
  };
  const syncScmSave = () => {
    const panel = scmSheet.layer && scmSheet.layer.panel;
    if (!panel) return;
    const token = panel.querySelector('#scm-token');
    const save = panel.querySelector('[data-key="scm-save"]');
    if (save) save.disabled = scmSheet.saving || !(token && token.value.trim());
  };
  const renderScmSheet = () => { if (scmSheet.layer) { scmSheet.layer.render(); syncScmSave(); } };
  const openScmSheet = (id, trigger) => {
    if (scmSheet.layer) return;
    const facts = toolchain(id) || {};
    // Another host is a fresh field; signing in again keeps the host it had.
    const signedIn = facts.auth && facts.auth.status === 'authenticated';
    Object.assign(scmSheet, { id, host: signedIn ? '' : (facts.auth && facts.auth.host) || '', reveal: false, saving: false, error: null });
    scmSheet.layer = Kit.open({
      kind: 'sheet',
      panel: { tag: 'form', class: 'tc-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'scm-title', novalidate: true },
      returnTo: trigger,
      backdrop: 'ignore',
      render: scmSheetBody,
      focus: '#scm-token',
      onClose: () => { scmSheet.layer = null; },
    });
    syncScmSave();
    const panel = scmSheet.layer.panel;
    panel.addEventListener('input', (e) => {
      if (e.target.id === 'scm-host') {
        // The token page follows the server typed.
        scmSheet.host = e.target.value;
        const link = panel.querySelector('[data-key="scm-page"]');
        const meta = M.SOURCE_CONTROL[scmSheet.id] || {};
        const host = scmHostOf() || meta.host;
        if (link && meta.tokenPage) {
          link.setAttribute('href', meta.tokenPage(host));
          link.lastChild.textContent = 'Open ' + host + '’s token page';
        }
      }
      if (scmSheet.error && e.target.id === 'scm-token') { scmSheet.error = null; renderScmSheet(); }
      syncScmSave();
    });
    panel.addEventListener('click', (e) => {
      const action = e.target.closest('[data-sheet]');
      if (!action) return;
      const what = action.getAttribute('data-sheet');
      if (what === 'close') scmSheet.layer.close('cancel');
      else if (what === 'reveal') { scmSheet.reveal = !scmSheet.reveal; renderScmSheet(); }
    });
    panel.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = panel.querySelector('#scm-token').value.trim();
      if (!token || scmSheet.saving) return;
      const meta = M.SOURCE_CONTROL[scmSheet.id] || {};
      scmSheet.saving = true;
      scmSheet.error = null;
      renderScmSheet();
      const res = await api('/source-control/signin', { body: { id: scmSheet.id, host: scmHostOf() || meta.host, token } });
      scmSheet.saving = false;
      if (!res.ok) {
        // Leave a refused token on screen, to fix or replace; with the sheet
        // closed while it was checked, say so instead.
        if (scmSheet.layer) { scmSheet.error = res.error; renderScmSheet(); } else Kit.toast('Could not sign in to ' + meta.provider, { tone: 'danger', detail: res.error });
        return;
      }
      // The account the row reads is the CLI's current one, which is only this
      // host's when the host is the one it reads.
      const auth = res.data.sourceControl && res.data.sourceControl.auth;
      const account = auth && auth.account && auth.host === res.data.host ? auth.account : null;
      if (scmSheet.layer) scmSheet.layer.close('saved');
      Kit.toast('Signed in to ' + (res.data.host || meta.provider) + (account ? ' as ' + account : ''),
        res.data.warning ? { detail: res.data.warning } : undefined);
      loadStatus();
    });
  };

  const confirmScmSignOut = async (id) => {
    const meta = M.SOURCE_CONTROL[id] || {};
    const auth = (toolchain(id) || {}).auth || {};
    const host = meta.tokenCommand ? auth.host || meta.host : null;
    const ok = await Kit.confirm({
      title: 'Sign ' + meta.name + ' out' + (host ? ' of ' + host : '') + '?',
      // gh and tea are git's credential helper for the hosts they sign in to.
      body: 'T3 Code stops opening ' + meta.provider + ' pull requests' + (host ? ' on ' + host : '') + ' until it is signed in again.'
        + (id === 'gh' || id === 'tea' ? ' git push over HTTPS to it stops working too.' : ''),
      confirm: 'Sign out',
    });
    if (!ok) return;
    ui.signingOut = id;
    render();
    // gh will not guess which of two accounts on a host to sign out.
    const res = await api('/source-control/signout', { body: { id, host, account: auth.account || null } });
    ui.signingOut = null;
    if (!res.ok) Kit.toast('Could not sign ' + meta.name + ' out', { tone: 'danger', detail: res.error });
    else Kit.toast('Signed ' + meta.name + ' out' + (host ? ' of ' + host : ''));
    loadStatus();
  };

  // ------------------------------------------------------------- API keys --
  const keySheet = { layer: null, agent: null, query: '', provider: null, other: false, reveal: false, saving: false, removing: null, error: null, active: 0 };
  const HUES = ['--id-claude', '--id-codex', '--id-opencode', '--id-grok', '--id-cursor'];
  const hueOf = (id) => HUES[[...String(id)].reduce((a, c) => (a + c.charCodeAt(0)) % HUES.length, 0)];
  const initials = (name) => {
    const words = String(name).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : String(name).slice(0, 1)).toUpperCase();
  };
  const providerMatches = () => {
    const list = (state.providers && state.providers.providers) || [];
    const q = keySheet.query.trim().toLowerCase();
    if (!q) return list.slice(0, 40).map((p) => ({ p, at: -1 }));
    const scored = [];
    for (const p of list) {
      const name = p.name.toLowerCase();
      const at = name.indexOf(q);
      const idAt = p.id.indexOf(q);
      if (at === -1 && idAt === -1) continue;
      scored.push({ p, at, score: at === 0 || idAt === 0 ? 0 : at > 0 ? 1 : 2 });
    }
    scored.sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name));
    return scored.slice(0, 40);
  };

  const keySheetBody = () => {
    const meta = M.AGENTS[keySheet.agent] || {};
    const isOpenCode = keySheet.agent === 'opencode';
    const providers = state.providers || {};
    const configured = new Set(providers.configured || []);
    const names = new Map((providers.providers || []).map((p) => [p.id, p.name]));
    const chosen = keySheet.provider;
    const credentials = providers.credentials || (state.providers ? {} : { available: false, refreshing: true });
    const addsAccount = isOpenCode && /^v?2\./.test(harness('opencode')?.version || '');
    const disabled = keySheet.saving ? raw(' disabled') : '';
    const keyStep = (n, active) => html`<div class="tc-sheet-step"${active ? raw(' data-state="active"') : ''}><span class="tc-step-mark">${String(n)}</span><div class="tc-sheet-step-body"><label class="tc-sheet-step-title" for="apikey">API key</label>
      <div class="tc-inputwrap"><input id="apikey" name="key" class="tc-input tc-input--mono"${disabled} type="${keySheet.reveal ? 'text' : 'password'}" placeholder="sk-…" autocomplete="off" spellcheck="false" autocapitalize="off"><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-sheet="reveal"${disabled} aria-label="${keySheet.reveal ? 'Hide' : 'Show'} API key" aria-pressed="${String(keySheet.reveal)}">${icon(keySheet.reveal ? 'eye-off' : 'eye')}</button></div>
      ${keySheet.error ? html`<p class="tc-hint tc-hint--err" role="alert" id="key-error" tabindex="-1">${keySheet.error}</p>` : html`<span class="tc-hint">${addsAccount ? 'Adds and selects a new saved account. Other accounts are kept.' : 'Stored on the state volume, never in the image.'}</span>`}</div></div>`;
    let steps;
    if (isOpenCode) {
      const matches = providerMatches();
      const cache = providers.cache || {};
      const freshness = cache.source === 'fallback' || !cache.at
        ? 'A built-in list; the full catalog loads once models.dev is reachable'
        : ((providers.providers || []).length + ' providers from models.dev · catalog cached ' + M.relTime(cache.at, now()));
      const options = matches.map(({ p, at }, i) => {
        const label = at >= 0 && keySheet.query.trim() ? raw(Kit.esc(p.name.slice(0, at)) + '<mark>' + Kit.esc(p.name.slice(at, at + keySheet.query.trim().length)) + '</mark>' + Kit.esc(p.name.slice(at + keySheet.query.trim().length))) : p.name;
        return html`<li class="tc-option" role="option" id="prov-opt-${i}" data-provider="${p.id}" data-index="${i}" aria-selected="${String(keySheet.active === i)}"><span class="tc-tile tc-tile--sm" style="--_tile: var(${hueOf(p.id)})" aria-hidden="true">${initials(p.name)}</span><span class="tc-truncate">${label}</span><span class="tc-option-meta tc-mono">${configured.has(p.id) ? html`${icon('check', 'tc-icon--xs')} ` : ''}${p.id}</span></li>`;
      });
      options.push(html`<li class="tc-option" role="option" id="prov-opt-${matches.length}" data-provider="__other" data-index="${matches.length}" aria-selected="${String(keySheet.active === matches.length)}">${icon('plus')}<span>Other — type an id</span></li>`);
      const providerStep = keySheet.other
        ? html`<div class="tc-field"><input id="prov-other" class="tc-input tc-input--mono"${disabled} placeholder="Provider id, e.g. deepseek" autocomplete="off" spellcheck="false" autocapitalize="off"><button class="tc-btn tc-btn--ghost tc-btn--xs tc-self-start" type="button" data-sheet="list"${disabled}>Back to the list</button></div>`
        : html`<div class="tc-combobox">
            <div class="tc-palette-input">${icon('search', 'tc-muted')}<input id="prov" role="combobox"${disabled} aria-expanded="true" aria-controls="provl" aria-autocomplete="list" aria-activedescendant="prov-opt-${keySheet.active}" placeholder="Search providers" autocomplete="off" spellcheck="false" autocapitalize="off"></div>
            <ul class="tc-listbox" id="provl" role="listbox" aria-label="Providers">${options}</ul>
          </div><span class="tc-hint">${chosen ? html`Selected: <strong>${names.get(chosen) || chosen}</strong> <span class="tc-mono">${chosen}</span>` : freshness}</span>`;
      steps = html`
        <div class="tc-sheet-step" data-state="${chosen ? 'done' : 'active'}"><span class="tc-step-mark">${chosen ? icon('check') : '1'}</span><div class="tc-sheet-step-body"><label class="tc-sheet-step-title" for="${keySheet.other ? 'prov-other' : 'prov'}">Provider</label>${providerStep}</div></div>
        ${keyStep(2, Boolean(chosen))}
        <div class="tc-stack tc-saved-keys-wrap"><span class="tc-small tc-muted">Saved sign-ins</span>
          ${credentials.refreshing ? html`<span class="tc-hint tc-saved-read" role="status"><span class="tc-spinner" aria-hidden="true"></span>Checking saved sign-ins…</span>` : ''}
          ${credentials.error ? html`<div class="tc-hint" role="status">Could not check saved sign-ins. ${credentials.available ? 'The last checked providers are shown.' : ''}<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-sheet="retry-providers"${disabled}>Try again</button></div>` : ''}
          ${configured.size ? html`<div class="tc-group"><div class="tc-list">${[...configured].map((id) => html`
            <div class="tc-row tc-row--compact tc-row--key" data-key="saved-${id}"><span class="tc-tile tc-tile--sm" style="--_tile: var(${hueOf(id)})" aria-hidden="true">${initials(names.get(id) || id)}</span><div class="tc-row-main"><span class="tc-row-name">${names.get(id) || id}</span>${credentials.counts?.[id] ? html`<span class="tc-small tc-muted">${credentials.counts[id]} saved ${credentials.counts[id] === 1 ? 'account' : 'accounts'}</span>` : ''}</div><button class="tc-btn tc-btn--ghost tc-btn--ghost-muted tc-btn--xs" type="button" data-sheet="remove" data-provider="${id}" aria-label="Remove saved sign-ins for ${names.get(id) || id}"${keySheet.saving || credentials.error || credentials.available === false ? raw(' disabled') : ''}>${keySheet.removing === id ? 'Removing…' : 'Remove'}</button></div>`)}</div></div>` : credentials.available !== false && !credentials.refreshing && !credentials.error ? html`<span class="tc-hint">No saved sign-ins yet.</span>` : ''}
          <span class="tc-hint">Remove clears every saved account for that provider.</span>
        </div>`;

    } else {
      steps = keyStep(1, true);
    }
    return html`
      <div class="tc-sheet-head">${tile(meta, 'lg')}<div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="key-title" tabindex="-1">${isOpenCode ? 'Add a provider key' : 'Use an API key'}</h2><span class="tc-small tc-muted">${isOpenCode ? html`Stored with OpenCode on the volume` : html`Runs <code>${meta.keyCommand}</code>; the key goes in on stdin`}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-sheet="close" aria-label="Close"${disabled}>${icon('x')}</button></div>
      <div class="tc-sheet-body" aria-busy="${String(keySheet.saving)}">${steps}</div>
      <div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-sheet="close"${disabled}>Cancel</button><button class="tc-btn tc-btn--primary" type="submit" data-key="key-save" disabled>${keySheet.saving ? html`<span class="tc-spinner" aria-hidden="true"></span>${keySheet.removing ? 'Removing…' : 'Saving…'}` : 'Save key'}</button></div>`;
  };

  /** Save stays disabled until every step is filled; this reads the live fields. */
  const syncKeySave = () => {
    const panel = keySheet.layer && keySheet.layer.panel;
    if (!panel) return;
    const key = panel.querySelector('#apikey');
    const other = panel.querySelector('#prov-other');
    const provider = keySheet.agent !== 'opencode' || (keySheet.other ? other && other.value.trim() : keySheet.provider);
    const save = panel.querySelector('[data-key="key-save"]');
    if (save) save.disabled = keySheet.saving || !(key && key.value.trim() && provider);
  };

  const renderKeySheet = () => {
    const layer = keySheet.layer;
    if (!layer || layer.closed) return;
    layer.render(); syncKeySave();
    if (!layer.panel.contains(document.activeElement) || document.activeElement.matches(':disabled')) layer.panel.querySelector('#key-title').focus({ preventScroll: true });
  };

  const chooseProvider = (id) => {
    if (keySheet.saving) return;
    if (id === '__other') {
      keySheet.other = true;
      keySheet.provider = null;
      renderKeySheet();
      const other = keySheet.layer.panel.querySelector('#prov-other');
      if (other) other.focus();
      return;
    }
    keySheet.provider = id;
    const p = ((state.providers && state.providers.providers) || []).find((x) => x.id === id);
    const input = keySheet.layer.panel.querySelector('#prov');
    if (input && p) input.value = p.name;
    keySheet.query = p ? p.name : '';
    keySheet.active = 0;
    renderKeySheet();
    const key = keySheet.layer.panel.querySelector('#apikey');
    if (key) key.focus();
  };

  const openKeySheet = async (id, trigger) => {
    if (keySheet.layer) return;
    Object.assign(keySheet, { agent: id, query: '', provider: null, other: false, reveal: false, saving: false, removing: null, error: null, active: 0 });
    keySheet.layer = Kit.open({
      kind: 'sheet',
      panel: { tag: 'form', class: 'tc-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'key-title', novalidate: true },
      returnTo: trigger,
      backdrop: 'ignore',
      render: keySheetBody,
      focus: id === 'opencode' ? '#prov' : '#apikey',
      onEscape: () => { if (!keySheet.saving) keySheet.layer?.close('cancel'); },
      onClose: () => { keySheet.layer = null; },
    });
    syncKeySave();
    const layer = keySheet.layer, panel = layer.panel;
    if (id === 'opencode') void loadProviders().then(() => { if (keySheet.layer === layer) renderKeySheet(); });
    panel.addEventListener('input', (e) => {
      if (e.target.id === 'prov') {
        keySheet.query = e.target.value;
        keySheet.provider = null;
        keySheet.active = 0;
        renderKeySheet();
        const list = panel.querySelector('#provl');
        if (list) list.scrollTop = 0;
      } else {
        if (keySheet.error && e.target.id === 'apikey') { keySheet.error = null; renderKeySheet(); }
        syncKeySave();
      }
    });
    panel.addEventListener('keydown', (e) => {
      if (e.target.id !== 'prov') return;
      const count = panel.querySelectorAll('#provl .tc-option').length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        keySheet.active = (keySheet.active + (e.key === 'ArrowDown' ? 1 : -1) + count) % count;
        renderKeySheet();
        const opt = panel.querySelector('#prov-opt-' + keySheet.active);
        if (opt) opt.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const opt = panel.querySelector('#prov-opt-' + keySheet.active);
        if (opt) chooseProvider(opt.getAttribute('data-provider'));
      }
    });
    panel.addEventListener('click', async (e) => {
      if (keySheet.saving || keySheet.layer !== layer) return;
      const option = e.target.closest('.tc-option[data-provider]');
      if (option) { chooseProvider(option.getAttribute('data-provider')); return; }
      const action = e.target.closest('[data-sheet]');
      if (!action) return;
      const what = action.getAttribute('data-sheet');
      if (what === 'close') keySheet.layer.close('cancel');
      else if (what === 'reveal') { keySheet.reveal = !keySheet.reveal; renderKeySheet(); }
      else if (what === 'list') { keySheet.other = false; renderKeySheet(); }
      else if (what === 'retry-providers') { await loadProviders(true); if (keySheet.layer === layer) renderKeySheet(); }
      else if (what === 'remove') {
        const provider = action.getAttribute('data-provider');
        const label = ((state.providers.providers || []).find((p) => p.id === provider) || {}).name || provider;
        const ok = await Kit.confirm({
          title: 'Remove ' + label + ' sign-ins?',
          body: 'Removes all saved OpenCode accounts for ' + label + ', including API keys and browser sign-ins. Other providers and environment credentials stay in place.',
          confirm: 'Remove sign-ins',
        });
        if (!ok || keySheet.layer !== layer) return;
        keySheet.saving = true; keySheet.removing = provider; renderKeySheet();
        const res = await api('/auth/apikey/remove', { body: { agent: 'opencode', provider } });
        if (!res.ok) Kit.toast('Could not remove saved sign-ins', { tone: 'danger', detail: res.error });
        else Kit.toast('Removed saved ' + label + ' sign-ins');
        await loadProviders(true); loadStatus();
        if (keySheet.layer !== layer) return;
        keySheet.saving = false; keySheet.removing = null; renderKeySheet();
      }
    });
    panel.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (keySheet.saving || keySheet.layer !== layer) return;
      const agent = keySheet.agent;
      const key = panel.querySelector('#apikey').value.trim();
      const other = panel.querySelector('#prov-other');
      const provider = keySheet.agent === 'opencode' ? (keySheet.other ? other && other.value.trim() : keySheet.provider) : undefined;
      if (!key || (keySheet.agent === 'opencode' && !provider)) return;
      keySheet.saving = true;
      keySheet.error = null;
      renderKeySheet();
      const res = await api('/auth/apikey', { body: { agent, key, provider } });
      if (agent === 'opencode') await loadProviders(true);
      loadStatus();
      if (keySheet.layer !== layer) return;
      keySheet.saving = false;
      if (!res.ok) {
        // Leave a failed attempt on screen with the key still in it.
        keySheet.error = res.error;
        renderKeySheet();
        panel.querySelector('#key-error')?.focus({ preventScroll: true });
        return;
      }
      const label = provider ? (((state.providers || {}).providers || []).find((p) => p.id === provider) || {}).name || provider : null;
      keySheet.layer.close('saved');
      Kit.toast(label ? 'Saved the ' + label + ' key' : 'API key saved');

    });
  };

  // ------------------------------------------------------------ add a tool --
  // Finds any tool in mise's registry (or takes a backend spec such as
  // npm:prettier), says where it comes from, what it provides and how its
  // downloads are verified, and installs it pinned to an exact release: the
  // newest, or one picked from what its backend offers. The same sheet picks a
  // release for a tool already added ("Install a specific version…").
  const registryLoad = { pending: null, error: null };
  const loadRegistry = () => {
    if (ui.registry) return Promise.resolve(ui.registry);
    registryLoad.pending ??= api('/packages/registry').then((res) => {
      registryLoad.pending = null;
      if (res.ok && Array.isArray(res.data.tools)) {
        ui.registry = res.data.tools;
        registryLoad.error = null;
      } else {
        registryLoad.error = res.error || 'mise’s registry could not be read';
      }
      return ui.registry;
    });
    return registryLoad.pending;
  };

  const SECURITY = {
    checksum: 'checksums', github_attestations: 'GitHub attestations', slsa: 'SLSA provenance',
    cosign: 'Cosign signatures', minisign: 'Minisign signatures', gpg: 'GPG signatures',
  };
  const describeSecurity = (types) => (types && types.length
    ? 'Verified with ' + M.listOf(types.map((t) => SECURITY[t] || t.replace(/_/g, ' ')))
    : 'mise checks no checksum or signature for this source');

  // ------------------------------------------------------------ public url --
  /**
   * The buttons that set a missing public URL: one tap for this page's own
   * address when it is T3 Code's, and a sheet for any other.
   */
  // What the check from inside the container found, said as a toast's detail.
  const reachDetail = (check) => !check ? null
    : check.reaches === 'this' ? 'Checked: it reaches this server.'
      : 'Couldn’t confirm it from inside the container: ' + check.why + '. That’s normal for LAN and tailnet addresses; only your devices need to reach it.';

  /**
   * Take the server's answer about the public URL at once, rather than leave
   * the old offer on screen until the next status read lands (a second or
   * more, long enough to click it again). The read that follows confirms it.
   */
  const applyUrl = (data) => {
    if (state.status) Object.assign(state.status, { publicUrl: data.publicUrl, publicUrlSource: data.publicUrlSource });
    render();
    loadStatus();
  };

  /**
   * Save an address, from the one-tap offer or the sheet. Resolves to the API
   * answer. `seen` is for this page's own address: the browser has just reached
   * T3 Code there, so the server need not ask it again.
   */
  let urlSaving = false;
  const saveUrl = async (url, { seen } = {}) => {
    if (urlSaving) return { ok: false, error: null };
    urlSaving = true;
    const res = await api('/public-url', { body: seen ? { url, check: false } : { url } });
    urlSaving = false;
    if (!res.ok) return res;
    Kit.toast('Pairing links now point at ' + M.hostOf(res.data.publicUrl), seen ? {} : { detail: reachDetail(res.data.check) });
    applyUrl(res.data);
    return res;
  };

  const urlSheet = { layer: null, saving: false, error: null, http: false };

  const urlSheetBody = () => {
    const s = state.status || {};
    const here = M.hereOffer(s, ui);
    const platform = s.publicUrlPlatform;
    const back = s.publicUrlSource === 'saved'
      ? html`<button class="tc-btn tc-btn--ghost" type="button" data-sheet="clear">${platform ? 'Use ' + platform.platform + '’s address' : 'Clear'}</button>`
      : '';
    const hint = urlSheet.error ? html`<p class="tc-hint tc-hint--err" role="alert">${urlSheet.error}</p>`
      : urlSheet.http ? html`<span class="tc-hint tc-hint--warn">Over http://, a pairing link’s token travels unencrypted. Fine on your own network; use https:// anywhere else.</span>`
        : html`<span class="tc-hint">A domain, a tunnel’s host name, or a LAN address such as http://192.168.1.20:3773.</span>`;
    return html`
      <div class="tc-sheet-head"><span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('globe')}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="url-title">Public URL</h2><span class="tc-small tc-muted">Where your devices reach this server. Pairing links point here.</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-sheet="close" aria-label="Close">${icon('x')}</button></div>
      <div class="tc-sheet-body">
        <div class="tc-field"><label class="tc-label" for="url-input">Address</label>
          <input id="url-input" name="url" class="tc-input tc-input--mono" type="text" inputmode="url" placeholder="https://t3.example.com" value="${s.publicUrlSource === 'env' ? '' : s.publicUrl || ''}" autocomplete="off" spellcheck="false" autocapitalize="off" aria-describedby="url-hint">
          <div id="url-hint">${hint}</div></div>
        ${here ? html`<div class="tc-group"><div class="tc-list"><div class="tc-row tc-row--compact" data-key="url-here"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(here.local ? 'laptop' : 'globe')}</span><div class="tc-row-main"><span class="tc-row-name">This page’s address</span><span class="tc-status tc-mono">${here.url}</span>${here.local ? html`<span class="tc-status">Only this computer can open it.</span>` : ''}</div><button class="tc-btn tc-btn--sm" type="button" data-sheet="here">Use</button></div></div></div>` : ''}
        ${platform && s.publicUrlSource === 'platform' ? html`<p class="tc-small tc-muted">${platform.platform} gives this service ${html`<span class="tc-mono">${M.hostOf(platform.url)}</span>`}. Set an address here only to use another, such as your own domain.</p>` : ''}
      </div>
      <div class="tc-sheet-foot">${back}<span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost" type="button" data-sheet="close">Cancel</button><button class="tc-btn tc-btn--primary" type="submit" data-key="url-save">${urlSheet.saving ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking` : 'Save'}</button></div>`;
  };

  const syncUrlSheet = () => {
    const panel = urlSheet.layer && urlSheet.layer.panel;
    if (!panel) return;
    const input = panel.querySelector('#url-input');
    const value = input ? input.value.trim() : '';
    const http = /^http:\/\//i.test(value);
    if (http !== urlSheet.http) { urlSheet.http = http; urlSheet.layer.render(); }
    const save = panel.querySelector('[data-key="url-save"]');
    if (save) save.disabled = urlSheet.saving || !value;
  };

  const openUrlSheet = (trigger) => {
    if (urlSheet.layer || (state.status && state.status.publicUrlSource === 'env')) return;
    Object.assign(urlSheet, { saving: false, error: null, http: /^http:\/\//i.test((state.status && state.status.publicUrl) || '') });
    urlSheet.layer = Kit.open({
      kind: 'sheet',
      panel: { tag: 'form', class: 'tc-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'url-title', novalidate: true },
      returnTo: trigger,
      backdrop: 'ignore',
      render: urlSheetBody,
      focus: '#url-input',
      onClose: () => { urlSheet.layer = null; },
    });
    const panel = urlSheet.layer.panel;
    const input = panel.querySelector('#url-input');
    if (input) input.select();
    syncUrlSheet();
    panel.addEventListener('input', () => {
      if (urlSheet.error) { urlSheet.error = null; urlSheet.layer.render(); }
      syncUrlSheet();
    });
    panel.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-sheet]');
      if (!action) return;
      const what = action.getAttribute('data-sheet');
      if (what === 'close') urlSheet.layer.close('cancel');
      else if (what === 'here') {
        const here = M.hereOffer(state.status, ui);
        const field = panel.querySelector('#url-input');
        if (here && field) { field.value = here.url; field.focus(); }
        urlSheet.error = null;
        syncUrlSheet();
        urlSheet.layer.render();
      } else if (what === 'clear') {
        const res = await api('/public-url/clear', { body: {} });
        if (!res.ok) { urlSheet.error = res.error; urlSheet.layer.render(); return; }
        urlSheet.layer.close('saved');
        Kit.toast(res.data.publicUrl ? 'Pairing links point at ' + M.hostOf(res.data.publicUrl) + ' again' : 'Public URL cleared');
        applyUrl(res.data);
      }
    });
    panel.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = panel.querySelector('#url-input').value.trim();
      if (!value || urlSheet.saving) return;
      urlSheet.saving = true;
      urlSheet.error = null;
      urlSheet.layer.render();
      syncUrlSheet();
      const here = M.hereOffer(state.status, ui);
      const res = await saveUrl(value, { seen: Boolean(here && here.url === value) });
      urlSheet.saving = false;
      if (!urlSheet.layer) return;
      if (!res.ok) {
        // Left on screen with the address still in it.
        urlSheet.error = res.error;
        urlSheet.layer.render();
        syncUrlSheet();
        return;
      }
      urlSheet.layer.close('saved');
    });
  };

  // ------------------------------------------------------------ T3 Connect --
  // One sheet for the whole way: sign in to T3 with a device code (T3 Code's
  // own `t3 connect link --headless`, which the setup service runs), restart
  // T3 Code so it makes the link, and wait for it to come on. Opened again
  // later, it starts wherever the server says things are.
  const conn = { layer: null, phase: 'idle', session: null, error: null, identity: null, attempt: 0, poll: null, oldPid: null, since: 0 };

  const connectSheetBody = () => {
    const st = conn.session || {};
    const s = state.status || {};
    const restartable = Boolean(s.t3 && s.t3.pid);
    const signedIn = sheetStep(1, 'Sign in to T3' + (conn.identity ? ' as ' + conn.identity : ''), 'done', '');
    let body;
    if (conn.phase === 'failed') {
      body = html`${notice('danger', 'circle-alert', 'T3 Connect did not finish', conn.error || 'The sign-in stopped before it finished.')}${st.tail ? html`<pre class="tc-log-tail">${st.tail}</pre>` : ''}`;
    } else if (conn.phase === 'signin') {
      body = st.url
        ? html`${deviceSteps(st)}${sheetStep(3, 'Turn it on', '', '')}`
        : sheetStep(1, 'Starting the sign-in', 'active', sheetWaiting('Waiting for T3 Code to print a sign-in link…'));
    } else if (conn.phase === 'authorized') {
      body = html`${signedIn}${sheetStep(2, 'Turn it on', 'active', restartable
        ? html`<span class="tc-hint">T3 Code makes the link when it starts. A restart takes a few seconds: open apps reconnect by themselves, and any agent turn in progress stops.</span>`
        : notice('warn', 'triangle-alert', 'Restart the container', 'T3 Code makes the link when it starts, and here this page cannot restart it on its own.'))}`;
    } else if (conn.phase === 'restarting') {
      body = html`${signedIn}${sheetStep(2, 'Turn it on', 'active', sheetWaiting('Restarting T3 Code…'))}`;
    } else if (conn.phase === 'linking') {
      body = html`${signedIn}${sheetStep(2, 'Turn it on', 'active', html`${sheetWaiting('T3 Code is making the link…')}${now() - conn.since > 120_000 ? html`<span class="tc-hint">This is taking longer than usual. You can close this: Access shows when it is on.</span>` : ''}`)}`;
    } else if (conn.phase === 'on') {
      body = notice('ok', 'circle-check', 'T3 Connect is on', 'Devices signed in to your T3 account reach this server through ' + ((s.connect && s.connect.relayHost) || 'T3’s relay') + '.');
    }
    const close = (label, variant) => html`<button class="${cx('tc-btn', variant || 'tc-btn--ghost')}" type="button" data-sheet="close">${label}</button>`;
    const foot = conn.phase === 'failed'
      ? html`${close('Close')}<button class="tc-btn tc-btn--primary" type="button" data-sheet="retry">${icon('refresh-cw')}Try again</button>`
      : conn.phase === 'authorized'
        ? html`${close('Later')}${restartable ? html`<button class="tc-btn tc-btn--primary" type="button" data-sheet="restart">${icon('refresh-cw')}Restart T3 Code</button>` : ''}`
        : conn.phase === 'on' ? close('Done', 'tc-btn--primary')
          : conn.phase === 'signin' ? html`<span class="tc-sheet-foot-note tc-desk-only"><span class="tc-kbd">Esc</span> cancels</span>${close('Cancel')}`
            : close('Close');
    return html`
      <div class="tc-sheet-head"><span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('globe')}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="connect-title">T3 Connect</h2><span class="tc-small tc-muted">Runs <code>t3 connect link</code> for you</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-sheet="close" aria-label="Close">${icon('x')}</button></div>
      <div class="tc-sheet-body" aria-live="polite">${body}</div>
      <div class="tc-sheet-foot">${foot}</div>`;
  };

  const connRender = () => { if (conn.layer) conn.layer.render(); };
  // Each phase change is an attempt; an answer for an older one is dropped.
  const connNext = () => { clearTimeout(conn.poll); conn.poll = null; return ++conn.attempt; };
  const connFail = (error) => { conn.phase = 'failed'; conn.error = error; connRender(); };

  const connPollSignin = async (attempt) => {
    if (!conn.layer || conn.attempt !== attempt || !conn.session) return;
    const res = await api('/auth/session?id=' + encodeURIComponent(conn.session.id));
    if (!conn.layer || conn.attempt !== attempt) return;
    if (!res.ok) return connFail(res.status === 404 ? 'The setup service no longer knows this sign-in (it may have restarted).' : res.error);
    conn.session = Object.assign({}, conn.session, res.data);
    if (res.data.state === 'done') {
      conn.identity = res.data.identity || null;
      conn.phase = 'authorized';
      connRender();
      loadStatus();
      return;
    }
    if (res.data.state === 'failed' || res.data.state === 'cancelled') return connFail(res.data.error);
    connRender();
    conn.poll = setTimeout(() => connPollSignin(attempt), 1500);
  };

  const connBeginSignin = async () => {
    const attempt = connNext();
    Object.assign(conn, { phase: 'signin', session: null, error: null });
    connRender();
    const res = await api('/auth/signin', { body: { agent: 'connect' } });
    if (!conn.layer || conn.attempt !== attempt) {
      if (res.ok && res.data.id) api('/auth/cancel', { body: { id: res.data.id } });
      return;
    }
    if (!res.ok) return connFail(res.error);
    conn.session = res.data;
    connRender();
    conn.poll = setTimeout(() => connPollSignin(attempt), 1200);
  };

  // After a restart: T3 Code back (answering, under a new pid), then the link.
  const connWatch = async (attempt) => {
    if (!conn.layer || conn.attempt !== attempt) return;
    await loadStatus();
    if (!conn.layer || conn.attempt !== attempt) return;
    const s = state.status || {};
    if (conn.phase === 'restarting' && s.server && s.server.ok && s.t3 && s.t3.pid && s.t3.pid !== conn.oldPid) {
      conn.phase = 'linking';
      conn.since = now();
    }
    if (conn.phase === 'linking' && s.connect && s.connect.state === 'on') {
      conn.phase = 'on';
      connRender();
      Kit.announce('T3 Connect is on.');
      return;
    }
    connRender();
    conn.poll = setTimeout(() => connWatch(attempt), conn.phase === 'restarting' ? 1500 : 3000);
  };

  const connRestart = async () => {
    const attempt = connNext();
    conn.oldPid = state.status && state.status.t3 && state.status.t3.pid;
    conn.phase = 'restarting';
    connRender();
    const res = await api('/t3/restart', { body: { why: 'connect' } });
    if (!conn.layer || conn.attempt !== attempt) return;
    if (!res.ok) return connFail(res.error);
    conn.poll = setTimeout(() => connWatch(attempt), 1500);
  };

  const openConnect = (trigger, { restart } = {}) => {
    if (conn.layer) return;
    const view = M.connectView(state.status);
    const phase = { on: 'on', linking: 'linking', restart: 'authorized' }[view.state] || 'signin';
    Object.assign(conn, { phase, session: null, error: null, identity: null, since: now() });
    conn.layer = Kit.open({
      kind: 'sheet',
      panel: { tag: 'aside', class: 'tc-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'connect-title' },
      returnTo: trigger,
      backdrop: 'ignore',
      render: connectSheetBody,
      onClose: () => {
        // A sign-in still waiting for approval has nobody left to finish it.
        if (conn.phase === 'signin' && conn.session && conn.session.id) api('/auth/cancel', { body: { id: conn.session.id } });
        connNext();
        conn.layer = null;
        render();
      },
    });
    conn.layer.panel.addEventListener('click', (e) => {
      const action = e.target.closest('[data-sheet]');
      if (!action) return;
      const what = action.getAttribute('data-sheet');
      if (what === 'close') conn.layer.close('close');
      else if (what === 'retry') connBeginSignin();
      else if (what === 'restart') connRestart();
    });
    if (phase === 'signin') connBeginSignin();
    else if (phase === 'linking') { const attempt = connNext(); conn.poll = setTimeout(() => connWatch(attempt), 1500); }
    else if (phase === 'authorized' && restart) connRestart();
  };

  /** Restart T3 Code from Environment or the palette, and say when it is back. */
  let runtimePending = null;
  const settleRuntime = (s) => {
    if (!runtimePending) return;
    const op = s.t3?.runtime?.operation;
    if (op?.id !== runtimePending) return;
    if (op.phase === 'succeeded' && s.server?.ok && s.server.version === op.version) {
      Kit.toast('T3 Code updated', { detail: op.version + ' · ' + (op.channel === 'nightly' ? 'Nightly' : 'Stable') });
      runtimePending = null;
    } else if (['failed', 'rolled-back', 'interrupted'].includes(op.phase)) {
      Kit.toast('T3 Code update did not finish', { tone: 'danger', detail: op.error });
      runtimePending = null;
    }
  };
  const checkRuntime = async ({ quiet = false, channel } = {}) => {
    if (ui.runtimeChecking) return null;
    const trigger = document.activeElement;
    ui.runtimeChecking = true;
    render();
    try {
      const response = await api('/t3/updates/check', { body: { channel } });
      await loadStatus();
      if (!response.ok && !quiet) Kit.toast('Could not check T3 Code updates', { tone: 'danger', detail: response.error });
      return response.ok ? response.data : null;
    } finally {
      ui.runtimeChecking = false;
      render();
      if (trigger instanceof HTMLElement && trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
    }
  };
  const updateRuntime = async (channel = state.status?.t3?.runtime?.channel) => {
    if (M.runtimeView(state.status)?.busy || ui.runtimeChecking) return;
    const checked = await checkRuntime({ channel });
    if (checked?.errors?.[channel]) {
      Kit.toast('Could not check ' + (channel === 'nightly' ? 'Nightly' : 'Stable') + ' releases', { tone: 'danger', detail: checked.errors[channel] });
      return;
    }
    const target = checked?.channels?.[channel]?.version;
    if (!target) return;
    const current = state.status?.t3?.runtime;
    const switching = current?.channel !== channel;
    const name = channel === 'nightly' ? 'Nightly' : 'Stable';
    const ok = await Kit.confirm({
      title: switching ? 'Switch to ' + name + '?' : 'Update T3 Code?',
      body: html`Install <span class="tc-runtime-target tc-mono tc-mono--body">${target}</span> and restart T3 Code. The container keeps running.`,
      consequences: [
        ...(channel === 'nightly' && switching ? [{ icon: 'moon', text: 'Nightly gives you new features earlier and can be less reliable.' }] : []),
        { icon: 'circle-stop', text: 'Active agent turns and T3 Code terminals stop. Open apps reconnect.' },
        ...(switching ? [{ icon: 'history', text: 'Newer releases can use a different thread store. Switching back may show earlier history; both stores are kept.' }] : []),
        ...(switching ? [{ icon: 'globe', text: 'Devices may need pairing again when releases use different credential permissions.' }] : []),
        { icon: 'shield-check', text: 'A failed startup restores the previous version and database.' },
      ],
      confirm: switching ? 'Switch and restart' : 'Update and restart', tone: 'primary',
    });
    if (!ok) return;
    const response = await api('/t3/update', { body: { channel, version: target } });
    if (!response.ok) { Kit.toast('Could not update T3 Code', { tone: 'danger', detail: response.error }); return; }
    if (response.data.current) Kit.toast('T3 Code is already up to date');
    else { runtimePending = response.data.operation.id; Kit.toast('T3 Code update started', { tone: 'info', detail: 'The current version keeps running while the download is verified.' }); }
    await loadStatus();
  };

  const restartT3 = async () => {
    const ok = await Kit.confirm({
      title: 'Restart T3 Code?',
      body: 'It stops and starts again inside this container, which keeps running. It takes a few seconds.',
      consequences: [
        { icon: 'refresh-cw', text: 'Open apps and browsers reconnect by themselves.' },
        { icon: 'circle-stop', text: 'Any agent turn in progress stops.' },
      ],
      confirm: 'Restart',
      tone: 'primary',
    });
    if (!ok) return;
    const before = state.status && state.status.t3 && state.status.t3.pid;
    const res = await api('/t3/restart', { body: {} });
    if (!res.ok) { Kit.toast('Could not restart T3 Code', { tone: 'danger', detail: res.error }); return; }
    Kit.toast('Restarting T3 Code', { tone: 'info' });
    const deadline = now() + 90_000;
    const watch = async () => {
      await loadStatus();
      const s = state.status || {};
      if (s.server && s.server.ok && s.t3 && s.t3.pid && s.t3.pid !== before) { Kit.toast('T3 Code is back'); return; }
      if (now() < deadline) setTimeout(watch, 1500);
      else Kit.toast('T3 Code has not come back yet', { tone: 'danger', detail: 'Its log, in the container’s, says why.' });
    };
    setTimeout(watch, 1500);
  };

  const toolSheet = { layer: null };
  const spinnerNote = (text) => html`<div class="tc-combobox-note"><span class="tc-spinner tc-info" aria-hidden="true"></span>${text}</div>`;
  // A backend spec wraps after its colon and slashes, not mid-name.
  const pathBreaks = (text) => raw(Kit.esc(text).replace(/[:/]/g, '$&<wbr>'));
  const marked = (text, match) => match
    ? raw(Kit.esc(text.slice(0, match[0])) + '<mark>' + Kit.esc(text.slice(match[0], match[1])) + '</mark>' + Kit.esc(text.slice(match[1])))
    : text;

  /** The picker's options: registry matches, and the query itself when it is a usable backend spec. */
  const toolOptions = () => {
    const q = toolSheet.query.trim();
    const installed = new Map(((state.status && state.status.packages) || []).map((p) => [p.id, p]));
    const options = M.searchRegistry(ui.registry || [], q, 30).map(({ entry, match }) => ({
      kind: 'entry', entry, match, managed: M.managedOn(entry.name), installed: installed.get(entry.name) || null,
    }));
    const known = (ui.registry || []).some((e) => e.name === q || (e.aliases || []).includes(q));
    if (q && M.isToolSpec(q) && !known && !M.managedOn(q)) {
      // A spec reads as one ("npm:prettier"): offer it first. A bare word may
      // be a typo of a registry name: offer it after the matches.
      options[q.includes(':') ? 'unshift' : 'push']({ kind: 'spec', id: q });
    }
    return options;
  };

  const toolOption = (o, i) => {
    const selected = String(i === toolSheet.active);
    if (o.kind === 'spec') {
      return html`<li class="tc-option tc-option--rich" role="option" id="tool-opt-${i}" data-index="${i}" aria-selected="${selected}">
        <span class="tc-tile tc-tile--sm tc-tile--icon" aria-hidden="true">${icon('plus')}</span>
        <span class="tc-option-text"><span class="tc-option-name">Use <code>${o.id}</code></span><span class="tc-option-desc">As a mise tool spec, installed from its backend</span></span></li>`;
    }
    const e = o.entry;
    const bins = (e.bins || []).filter((b) => b !== e.name);
    const meta = o.managed ? html`<span class="tc-option-meta"><span>On ${o.managed}</span></span>`
      : o.installed ? html`<span class="tc-option-meta">${icon('check', 'tc-icon--xs')}<span>${o.installed.version || 'Added'}</span></span>`
        : bins.length ? html`<span class="tc-option-meta tc-mono">${bins.slice(0, 2).map((b) => html`<span>${b}</span>`)}</span>` : '';
    return html`<li class="tc-option tc-option--rich" role="option" id="tool-opt-${i}" data-index="${i}" aria-selected="${selected}"${o.managed ? raw(' aria-disabled="true"') : ''}>
      <span class="tc-tile tc-tile--sm" style="--_tile: var(--id-toolchain)" aria-hidden="true">${M.monogram(e.name)}</span>
      <span class="tc-option-text"><span class="tc-option-name">${marked(e.name, o.match)}</span>${e.description ? html`<span class="tc-option-desc">${e.description}</span>` : ''}</span>${meta}</li>`;
  };

  // A backend spec to try, as a button that fills the search with it.
  const specExample = (spec) => html`<button class="tc-chip-btn" type="button" data-sheet="spec" data-spec="${spec}">${spec}</button>`;
  /** What to say when the search lists nothing: how to finish a half-typed spec, or that a spec works. */
  const noToolMatch = (q) => {
    const prefix = M.specPrefix(q);
    if (prefix) {
      return html`<div class="tc-combobox-note tc-combobox-note--stack" role="status"><span>${prefix.noun
        ? html`Name the ${prefix.noun} after <code>${prefix.backend}:</code>, for example`
        : html`Name the tool after <code>${prefix.backend}:</code>.`}</span>${prefix.example ? html`<span class="tc-chips">${specExample(prefix.example)}</span>` : ''}</div>`;
    }
    return html`<div class="tc-combobox-note tc-combobox-note--stack" role="status"><span>Nothing in mise’s registry matches. A backend spec works too, such as</span><span class="tc-chips">${M.SPEC_SAMPLES.map(specExample)}</span></div>`;
  };

  const toolPicker = () => {
    const options = toolOptions();
    const q = toolSheet.query.trim();
    const loading = !ui.registry && !registryLoad.error;
    return html`
      <div class="tc-combobox">
        <div class="tc-palette-input">${icon('search', 'tc-muted')}<input id="tool-q" role="combobox" aria-expanded="true" aria-controls="tool-list" aria-autocomplete="list" aria-activedescendant="${options.length ? 'tool-opt-' + toolSheet.active : ''}" placeholder="kubectl, terraform, json, npm:prettier…" autocomplete="off" spellcheck="false" autocapitalize="off"></div>
        ${loading ? spinnerNote('Loading mise’s registry…')
          : options.length ? html`<ul class="tc-listbox tc-listbox--rich" id="tool-list" role="listbox" aria-label="${q ? 'Matching tools' : 'Suggested tools'}">${options.map(toolOption)}</ul>`
            : noToolMatch(q)}
      </div>
      <span class="tc-hint">${registryLoad.error ? registryLoad.error + '. A backend spec still works.'
        : ui.registry ? (q ? '' : 'A few to start with. ') + 'Search ' + ui.registry.length.toLocaleString() + ' tools by name, command or what they do.' : ''}</span>`;
  };

  // The sheet serves two things: adding a tool (or picking another release of
  // one already added), and picking a release of an agent. `target` says which
  // ('package' or 'harness'); everything below reads it rather than guessing.
  const sheetFacts = () => {
    const t = toolSheet.tool;
    if (!t) return null;
    return toolSheet.target === 'harness' ? harness(t.id) : addedTool(t.id);
  };
  const sheetCurrent = () => {
    const facts = sheetFacts();
    return facts ? facts.installedVersion || facts.version || null : null;
  };

  const toolDetails = (t) => {
    if (toolSheet.target === 'harness') {
      // An agent needs no provenance: the catalogue pins where it comes from.
      // Say what the switch does instead.
      const current = sheetCurrent();
      const kept = ((sheetFacts() || {}).managedVersions || []).filter((v) => v !== current);
      return html`<span class="tc-hint">${current
        ? html`On <span class="tc-mono">${current}</span>. T3 Code switches to the release you pick once it is installed and runs; ${current} keeps working until then.`
        : html`T3 Code is pointed at the release you pick once it is installed and runs.`}${kept.length ? html` Also on the volume: <span class="tc-mono">${kept.join(', ')}</span>.` : ''}</span>
        ${t.id === 'opencode' ? html`<span class="tc-hint">OpenCode 1 is the default. Choose a 2.x release to use OpenCode 2 with T3 Code Nightly. Updates stay on the selected major version.</span>` : ''}`;
    }
    const info = toolSheet.info;
    const bins = (info && info.bins && info.bins.length ? info.bins : t.bins) || [];
    const rows = [
      ['Source', info ? html`<code>${pathBreaks(info.backend || t.id)}</code>` : toolSheet.infoError ? html`<span class="tc-muted">${toolSheet.infoError}</span>` : html`<span class="tc-muted"><span class="tc-spinner tc-info" aria-hidden="true"></span> Asking mise…</span>`],
    ];
    if (info) rows.push(['Downloads', describeSecurity(info.security)]);
    if (bins.length) rows.push(['Provides', html`${bins.slice(0, 6).map((b, i) => html`${i ? ' ' : ''}<code>${b}</code>`)}${bins.length > 6 ? ' and ' + (bins.length - 6) + ' more' : ''}`]);
    const installed = addedTool(t.id);
    const shadows = (info && info.shadows) || [];
    return html`
      <dl class="tc-kv tc-kv--sheet">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
      ${installed && installed.version && toolSheet.mode !== 'version' ? html`<span class="tc-hint">${t.name} ${installed.version} is already added. Installing switches it to the release below.</span>` : ''}
      ${shadows.length ? html`<span class="tc-hint">The image already has ${M.listOf(shadows.map((b) => b))}. Once added, this one comes first in terminals and for agents.</span>` : ''}`;
  };

  const releaseOf = (version) => (toolSheet.releases || []).find((r) => r.version === version) || null;
  const releaseAgeText = () => {
    const ms = state.status && state.status.releaseAgeMs;
    return Number.isFinite(ms) && ms > 0 ? M.duration(ms / 1000).replace(/^1 day$/, 'a day') : 'a day';
  };

  /** The labels beside one release in the list: newest, installed, on the volume, how new. */
  const releaseMeta = (r) => {
    const facts = sheetFacts() || {};
    const current = sheetCurrent();
    const tags = [];
    if (r.supported === false) tags.push('too old for T3');
    else if (r.waiting) tags.push(r.releasedAt ? 'out ' + M.relTime(r.releasedAt, now()) : 'new');
    else if (r.prerelease) tags.push('preview');
    if (r.requiresNightly) tags.push('requires Nightly');
    if (r.version === toolSheet.offered) tags.push('newest');
    if (r.version === current) tags.push('installed');
    else if ((facts.managedVersions || []).includes(r.version)) tags.push('on the volume');
    return tags.length ? html`<span class="tc-option-meta">${tags.map((tag) => html`<span>${tag}</span>`)}</span>` : '';
  };

  const versionPicker = () => {
    const list = toolSheet.releases;
    const q = toolSheet.versionQuery.trim();
    const filtered = M.matchReleases(list, q).slice(0, 80);
    const exact = q ? M.resolveRelease(list, q) : null;
    const picked = exact ? releaseOf(exact) : null;
    const typedPrefix = q && exact && exact !== q;
    const hint = q && !M.isVersionSpec(q) ? { err: true, text: 'That is not a version mise can install.' }
      : noSuchRelease(q) ? { err: true, text: 'None of its releases starts with ' + q + (toolSheet.offered ? '. The newest is ' + toolSheet.offered + '.' : '.') }
        : picked && picked.supported === false ? { err: true, text: picked.version + ' is older than T3 Code supports.' }
          : picked && picked.waiting ? { text: picked.version + ' came out ' + (picked.releasedAt ? M.relTime(picked.releasedAt, now()) : 'recently') + '. mise offers a release as the newest once it has been out ' + releaseAgeText() + ', in case it is pulled; naming it installs it now.' }
            : typedPrefix ? { text: 'Installs ' + exact + ', the newest ' + q + ' release mise offers, recorded exactly.' }
              : { text: (list ? list.length.toLocaleString() + ' releases. ' : '') + 'Pick one, or type a prefix to take the newest under it.' };
    return html`
      <div class="tc-combobox">
        <div class="tc-palette-input">${icon('history', 'tc-muted')}<input id="ver-q" class="tc-mono" role="combobox" aria-expanded="true" aria-controls="ver-list" aria-autocomplete="list" aria-activedescendant="${filtered.length ? 'ver-opt-' + toolSheet.versionActive : ''}" aria-label="Version" placeholder="${toolSheet.offered ? toolSheet.offered + ', or a prefix' : '1.8.2, or a prefix like 3.12'}" autocomplete="off" spellcheck="false" autocapitalize="off"></div>
        ${!list && !toolSheet.versionsError ? spinnerNote('Asking mise for releases…')
          : toolSheet.versionsError ? html`<div class="tc-combobox-note">${toolSheet.versionsError}. Type a version instead.</div>`
            : filtered.length ? html`<ul class="tc-listbox tc-listbox--releases" id="ver-list" role="listbox" aria-label="Releases">${filtered.map((r, i) => html`
              <li class="tc-option" role="option" id="ver-opt-${i}" data-version="${r.version}" aria-selected="${String(i === toolSheet.versionActive)}"${r.supported === false ? raw(' aria-disabled="true"') : ''}><span class="tc-mono">${r.version}</span>${releaseMeta(r)}</li>`)}</ul>`
              : ''}
      </div>
      <span class="${cx('tc-hint', hint.err && 'tc-hint--err')}">${hint.text}</span>
      ${toolSheet.versionsWarning ? html`<span class="tc-hint tc-hint--err">${toolSheet.versionsWarning}</span>` : ''}`;
  };

  /**
   * The release to highlight: the one a typed version installs, or with
   * nothing typed, the newest mise offers - never one it is still holding back.
   */
  const activeRelease = (query) => {
    const q = String(query || '').trim();
    if (q) return M.releaseIndex(M.matchReleases(toolSheet.releases, q), q);
    return Math.max(0, (toolSheet.releases || []).findIndex((r) => r.version === toolSheet.offered));
  };

  /** A typed release or prefix that none of the listed releases starts with. */
  const noSuchRelease = (version) => Boolean(toolSheet.releases && version && !M.resolveRelease(toolSheet.releases, version));

  /** The release the sheet would install now: '' for the newest, or what was picked or typed. */
  const chosenVersion = () => (toolSheet.versionMode === 'pick' ? (toolSheet.version || toolSheet.versionQuery).trim() : '');

  /** Exactly what Install installs: a typed prefix resolved, or what was typed when the list could not load. */
  const exactChoice = () => {
    const version = chosenVersion();
    if (toolSheet.versionMode !== 'pick') return toolSheet.offered || '';
    return M.resolveRelease(toolSheet.releases, version) || version;
  };

  const toolSheetBody = () => {
    const t = toolSheet.tool;
    const agent = toolSheet.target === 'harness';
    const editing = toolSheet.mode === 'version';
    const mode = toolSheet.versionMode;
    const newest = toolSheet.offered;
    const version = chosenVersion();
    const exact = exactChoice();
    const unsupported = mode === 'pick' && releaseOf(exact) && releaseOf(exact).supported === false;
    const canInstall = Boolean(t) && !toolSheet.saving && !unsupported
      && (mode === 'latest' || (M.isVersionSpec(version) && !noSuchRelease(version)));
    // The button names the exact release: a typed prefix shows what it resolves to.
    const label = !t ? 'Install' : 'Install ' + t.name + (exact ? ' ' + exact : '');
    const headTile = agent && t ? tile(Object.assign({ mono: t.id.slice(0, 2).toUpperCase(), hue: '--id-toolchain' }, M.AGENTS[t.id]), 'lg')
      : t ? html`<span class="tc-tile tc-tile--lg" style="--_tile: var(--id-toolchain)" aria-hidden="true">${M.monogram(t.name)}</span>`
        : html`<span class="tc-tile tc-tile--lg tc-tile--icon" aria-hidden="true">${icon('plus')}</span>`;
    return html`
      <div class="tc-sheet-head">
        ${headTile}
        <div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="tool-title">${editing && t ? 'Install a specific version of ' + t.name : 'Add a tool'}</h2>
          <span class="tc-small tc-muted">${agent ? 'Pinned to the exact release you pick, from mise' : editing ? 'Pinned to the exact release you pick' : 'From mise’s registry, pinned to an exact release'}</span></div>
        <span class="tc-spacer"></span>
        <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-sheet="close" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="tc-sheet-body">
        ${editing ? '' : html`<div class="tc-sheet-step" data-state="${t ? 'done' : 'active'}"><span class="tc-step-mark">${t ? icon('check') : '1'}</span><div class="tc-sheet-step-body">
          ${t ? html`<span class="tc-sheet-step-title">Tool</span>
            <div class="tc-tool-picked"><div class="tc-tool-picked-text"><span class="tc-row-name">${t.name}</span>${t.description ? html`<span class="tc-small tc-muted">${t.description}</span>` : ''}</div>
              <button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-sheet="change">Change</button></div>
            ${toolDetails(t)}`
          : html`<label class="tc-sheet-step-title" for="tool-q">Tool</label>${toolPicker()}`}
        </div></div>`}
        ${editing && t ? toolDetails(t) : ''}
        ${t ? html`<div class="tc-sheet-step" data-state="active"><span class="tc-step-mark">${editing ? '1' : '2'}</span><div class="tc-sheet-step-body">
          <span class="tc-sheet-step-title" id="ver-label">Version</span>
          ${editing ? '' : html`<div class="tc-seg tc-seg--fill" role="group" aria-labelledby="ver-label">
            <button type="button" aria-pressed="${String(mode === 'latest')}" data-sheet="ver-latest">Newest${newest ? html` <span class="tc-mono">${newest}</span>` : ''}</button>
            <button type="button" aria-pressed="${String(mode === 'pick')}" data-sheet="ver-pick">Choose a version</button></div>`}
          ${mode === 'pick' ? versionPicker()
            : html`<span class="tc-hint">${newest ? 'mise’s newest release, recorded exactly; Update moves it on later.'
              : toolSheet.versionsError ? 'mise resolves its newest release when it installs.' : 'Looking up the newest release…'}</span>`}
        </div></div>` : ''}
        ${toolSheet.error ? html`<p class="tc-hint tc-hint--err" role="alert">${toolSheet.error}</p>` : ''}
      </div>
      <div class="tc-sheet-foot">
        <button class="tc-btn tc-btn--ghost" type="button" data-sheet="close">Cancel</button>
        <button class="tc-btn tc-btn--primary" type="submit" data-key="tool-install"${canInstall ? '' : raw(' disabled')}>${toolSheet.saving ? html`<span class="tc-spinner" aria-hidden="true"></span>Starting` : html`${icon('download')}${label}`}</button>
      </div>`;
  };

  const renderToolSheet = () => { if (toolSheet.layer) toolSheet.layer.render(); };
  const focusIn = (selector) => {
    const el = toolSheet.layer && toolSheet.layer.panel.querySelector(selector);
    if (el) el.focus({ preventScroll: true });
  };

  /** Take a tool: look up where it comes from and what releases it has, in parallel. */
  const selectTool = (tool) => {
    const draft = toolSheet.target === 'harness' ? versionDrafts.get(tool.id) || '' : '';
    Object.assign(toolSheet, {
      tool, info: null, infoError: null, releases: null, offered: null, versionsError: null, versionsWarning: null,
      versionMode: toolSheet.mode === 'version' ? 'pick' : 'latest', versionQuery: draft, version: '', versionActive: 0, error: null,
    });
    renderToolSheet();
    const id = tool.id;
    const agent = toolSheet.target === 'harness';
    if (!agent) {
      api('/packages/info?id=' + encodeURIComponent(id)).then((res) => {
        if (!toolSheet.tool || toolSheet.tool.id !== id) return;
        if (res.ok) toolSheet.info = res.data;
        else toolSheet.infoError = res.error;
        renderToolSheet();
      });
    }
    api((agent ? '/harnesses/versions?id=' : '/packages/versions?id=') + encodeURIComponent(id)).then((res) => {
      if (!toolSheet.tool || toolSheet.tool.id !== id) return;
      if (res.ok) {
        toolSheet.releases = res.data.releases || [];
        toolSheet.offered = res.data.latest || null;
        if (agent && tool.id === 'opencode' && res.data.degraded?.length) {
          toolSheet.versionsWarning = res.data.degraded.map((item) => item.tool === 'npm:@opencode/cli' ? 'OpenCode 2' : 'OpenCode 1').join(' and ') + ' releases could not be loaded. Try reopening this picker.';
        }
        toolSheet.versionActive = activeRelease(toolSheet.versionQuery);
      } else {
        toolSheet.versionsError = res.error || 'mise could not list its releases';
      }
      renderToolSheet();
    });
    focusIn(toolSheet.mode === 'version' ? '#ver-q' : '[data-key="tool-install"]');
    const input = toolSheet.layer && toolSheet.layer.panel.querySelector('#ver-q');
    if (input && draft) input.value = draft;
  };

  const toolFromEntry = (entry) => ({ id: entry.name, name: entry.name, description: entry.description || '', bins: entry.bins || [] });
  const chooseOption = (index) => {
    const option = toolOptions()[index];
    if (!option || option.managed) return;
    selectTool(option.kind === 'spec'
      ? { id: option.id, name: M.toolName(option.id), description: '', bins: [] }
      : toolFromEntry(option.entry));
  };

  const submitTool = async () => {
    const t = toolSheet.tool;
    if (!t || toolSheet.saving) return;
    const agent = toolSheet.target === 'harness';
    const version = chosenVersion();
    if (toolSheet.versionMode === 'pick' && (!M.isVersionSpec(version) || noSuchRelease(version))) {
      toolSheet.error = 'Pick a release, or type one such as 1.8.2 or a prefix such as 3.12.';
      renderToolSheet();
      focusIn('#ver-q');
      return;
    }
    if (agent && t.id === 'opencode') {
      const current = sheetCurrent() || '';
      const target = exactChoice();
      const toV2 = /^2\./.test(target) && !/^2\./.test(current);
      const toV1 = /^1\./.test(target) && /^2\./.test(current);
      if (toV2 || toV1) {
        const confirmed = await Kit.confirm({
          title: toV2 ? 'Install OpenCode 2?' : 'Switch back to OpenCode 1?',
          body: toV2
            ? 'Use T3 Code Nightly and stop running OpenCode sessions before switching. OpenCode 2 converts its shared database on first use.'
            : 'Stop running OpenCode sessions before switching. Installing OpenCode 1 does not restore a database or configuration converted by OpenCode 2.',
          consequences: [
            { icon: 'shield-check', text: 'Keep a backup of your OpenCode data before switching' },
            { icon: 'info', text: 'OpenCode 1 and 2 must not run together against the same data' },
          ],
          confirm: toV2 ? 'Install OpenCode 2' : 'Install OpenCode 1',
        });
        if (!confirmed) return;
      }
    }
    toolSheet.saving = true;
    toolSheet.error = null;
    renderToolSheet();
    // An agent is installed at an exact release, so a typed prefix goes as
    // the release it resolves to; an added tool's resolves on the server.
    const facts = sheetFacts();
    const res = agent
      ? await callLifecycle('harness', facts && facts.installed ? 'update' : 'install', t.id, exactChoice() || undefined)
      : await callLifecycle('package', 'install', t.id, version || undefined);
    toolSheet.saving = false;
    if (res.ok || res.status === 202) {
      if (toolSheet.layer) toolSheet.layer.close('saved');
      if (!agent && state.route !== 'toolchains') go('toolchains');
      return;
    }
    // Refused before it started (a name managed elsewhere, a version mise
    // does not have): say so here, where it can be fixed.
    notices.delete((agent ? 'harness:' : 'package:') + t.id);
    toolSheet.error = res.error || 'Could not install ' + t.name;
    renderToolSheet();
  };

  /**
   * Open the sheet: empty, on a tool (`id`, from a suggestion or the palette),
   * on an added tool to pick another release (`mode: 'version'`), or on an
   * agent to pick one of its releases (`target: 'harness'`).
   */
  const openToolSheet = ({ id, mode, trigger, target = 'package' } = {}) => {
    if (toolSheet.layer) return;
    const agent = target === 'harness';
    Object.assign(toolSheet, { target, mode: agent ? 'version' : mode || 'add', query: '', active: 0, tool: null, saving: false, error: null, versionMode: 'latest' });
    toolSheet.layer = Kit.open({
      kind: 'sheet',
      panel: { tag: 'form', class: 'tc-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tool-title', novalidate: true },
      returnTo: trigger,
      backdrop: 'ignore',
      render: toolSheetBody,
      focus: agent ? '#ver-q' : '#tool-q',
      onClose: () => { toolSheet.layer = null; },
    });
    const panel = toolSheet.layer.panel;
    if (agent) {
      selectTool({ id, name: nameOf('harness', id), description: '', bins: [] });
    } else {
      // A tool already added needs nothing from the registry to be picked; a
      // name from a suggestion or the palette is looked up there first.
      const existing = id ? addedTool(id) : null;
      if (existing) selectTool({ id, name: existing.name, description: existing.description || '', bins: existing.bins || [] });
      loadRegistry().then(() => {
        if (!toolSheet.layer) return;
        if (id && !toolSheet.tool) {
          const entry = (ui.registry || []).find((e) => e.name === id || (e.aliases || []).includes(id));
          selectTool(entry ? toolFromEntry(entry) : { id, name: M.toolName(id), description: '', bins: [] });
        } else {
          renderToolSheet();
        }
      });
    }

    const moveActive = (field, count, delta) => {
      if (!count) return;
      toolSheet[field] = (toolSheet[field] + delta + count) % count;
      renderToolSheet();
      const id = field === 'active' ? '#tool-opt-' + toolSheet.active : '#ver-opt-' + toolSheet.versionActive;
      const el = panel.querySelector(id);
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    const takeRelease = (value) => {
      if (releaseOf(value) && releaseOf(value).supported === false) return false;
      toolSheet.version = value;
      toolSheet.versionQuery = value;
      if (toolSheet.target === 'harness') versionDrafts.set(toolSheet.tool.id, value);
      const input = panel.querySelector('#ver-q');
      if (input) input.value = value;
      toolSheet.error = null;
      renderToolSheet();
      return true;
    };
    panel.addEventListener('input', (e) => {
      if (e.target.id === 'tool-q') {
        toolSheet.query = e.target.value;
        toolSheet.active = 0;
        renderToolSheet();
        const list = panel.querySelector('#tool-list');
        if (list) list.scrollTop = 0;
      } else if (e.target.id === 'ver-q') {
        toolSheet.versionQuery = e.target.value;
        toolSheet.version = '';
        // A typed draft for an agent survives closing the sheet and polls.
        if (toolSheet.target === 'harness') versionDrafts.set(toolSheet.tool.id, e.target.value);
        // Highlight the release this would install, wherever it sits.
        toolSheet.versionActive = activeRelease(e.target.value);
        toolSheet.error = null;
        renderToolSheet();
        const el = panel.querySelector('#ver-opt-' + toolSheet.versionActive);
        if (el) el.scrollIntoView({ block: 'nearest' });
      }
    });
    panel.addEventListener('keydown', (e) => {
      if (e.target.id === 'tool-q') {
        const count = panel.querySelectorAll('#tool-list .tc-option').length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveActive('active', count, e.key === 'ArrowDown' ? 1 : -1); }
        else if (e.key === 'Enter') { e.preventDefault(); chooseOption(toolSheet.active); }
      } else if (e.target.id === 'ver-q') {
        const options = [...panel.querySelectorAll('#ver-list .tc-option')];
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveActive('versionActive', options.length, e.key === 'ArrowDown' ? 1 : -1); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          // Enter takes the highlighted release, then a second Enter installs
          // it; one already typed out in full installs at once.
          const pick = options[toolSheet.versionActive];
          const value = pick ? pick.getAttribute('data-version') : '';
          if (pick && toolSheet.version !== value && toolSheet.versionQuery.trim() !== value) takeRelease(value);
          else submitTool();
        }
      }
    });
    panel.addEventListener('click', (e) => {
      const option = e.target.closest('#tool-list .tc-option');
      if (option) { chooseOption(Number(option.getAttribute('data-index'))); return; }
      const release = e.target.closest('#ver-list .tc-option');
      if (release) {
        if (takeRelease(release.getAttribute('data-version'))) focusIn('[data-key="tool-install"]');
        return;
      }
      const action = e.target.closest('[data-sheet]');
      if (!action) return;
      const what = action.getAttribute('data-sheet');
      if (what === 'spec') {
        // An example spec: into the search, offered at the top, ready for Enter.
        toolSheet.query = action.getAttribute('data-spec');
        toolSheet.active = 0;
        renderToolSheet();
        const input = panel.querySelector('#tool-q');
        if (input) {
          input.value = toolSheet.query;
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
        return;
      }
      if (what === 'close') toolSheet.layer.close('cancel');
      else if (what === 'change') {
        Object.assign(toolSheet, { tool: null, info: null, releases: null, offered: null, error: null });
        renderToolSheet();
        const input = panel.querySelector('#tool-q');
        if (input) { input.value = toolSheet.query; input.focus(); }
      } else if (what === 'ver-latest') {
        toolSheet.versionMode = 'latest';
        toolSheet.error = null;
        renderToolSheet();
      } else if (what === 'ver-pick') {
        toolSheet.versionMode = 'pick';
        renderToolSheet();
        focusIn('#ver-q');
      }
    });
    panel.addEventListener('submit', (e) => {
      e.preventDefault();
      submitTool();
    });
  };

  // ------------------------------------------------------------- commands --
  const rowFor = (target, id) => (target === 'harness' ? M.agentRows(state.status, ui, now())
    : target === 'package' ? M.packageRows(state.status, ui, now())
    : target === 'context-agentsmd' ? [M.contextAgentsMdRow(state.status)]
      : [...M.toolchainRows(state.status, ui, now()), ...M.sourceControlRows(state.status, ui, now())]).find((r) => r.id === id);

  const deviceRename = { layer: null, device: null, label: '', initial: '', saving: false, error: null, invalid: false };
  const deviceRenameChanged = () => deviceRename.label.trim() !== deviceRename.initial.trim();
  const deviceRenameBody = () => html`
    <div class="tc-dialog-body tc-device-rename-body">
      <div class="tc-device-rename-head"><div><h2 class="tc-dialog-title" id="device-title">Rename device</h2><p class="tc-dialog-desc" id="device-desc">Choose a name you can recognise.</p></div><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-device-close aria-label="Close"${deviceRename.saving ? raw(' disabled') : ''}>${icon('x')}</button></div>
      <div class="tc-device-rename-context" id="device-current"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(deviceRename.device.icon)}</span><div class="tc-row-main"><span class="tc-device-rename-name" title="${deviceRename.device.name}">${deviceRename.device.name}</span><span class="tc-status">${deviceRename.device.kind}</span></div></div>
      <div class="tc-field">
        <div class="tc-device-rename-label"><label class="tc-label" for="device-label">Device label</label><span class="tc-hint" id="device-count" aria-label="${deviceRename.label.length} of 64 characters">${String(deviceRename.label.length)} / 64</span></div>
        <input id="device-label" name="label" class="tc-input" value="${deviceRename.label}" maxlength="64" placeholder="e.g. Work phone" autocomplete="off" spellcheck="false" aria-invalid="${String(deviceRename.invalid)}" aria-describedby="device-hint device-count${deviceRename.error ? ' device-error' : ''}"${deviceRename.saving ? raw(' disabled') : ''}>
        <span class="tc-hint" id="device-hint">Leave blank to use the original device name.</span>
        ${deviceRename.error ? html`<div class="tc-device-rename-error" id="device-error" role="alert">${icon('circle-alert')}<span>${deviceRename.error}</span></div>` : ''}
      </div>
    </div>
    <div class="tc-dialog-foot tc-device-rename-foot"><button class="tc-btn tc-btn--ghost" type="button" data-device-close${deviceRename.saving ? raw(' disabled') : ''}>Cancel</button><button class="tc-btn tc-btn--primary" type="submit" data-key="device-save"${deviceRename.saving || !deviceRenameChanged() ? raw(' disabled') : ''}>${deviceRename.saving ? html`<span class="tc-spinner" aria-hidden="true"></span>Saving` : 'Save changes'}</button></div>`;

  const openDeviceRename = (id, trigger) => {
    if (deviceRename.layer || access.pending('session', id)) return;
    closeAccessNotice();
    const device = M.deviceRows((state.status || {}).sessions, now()).find((row) => row.id === id);
    if (!device) { accessToast('This device is no longer paired.', { tone: 'info' }); return; }
    Object.assign(deviceRename, { device, label: device.label, initial: device.label, saving: false, error: null, invalid: false });
    const layer = Kit.open({
      kind: 'center',
      panel: { tag: 'form', class: 'tc-dialog tc-device-rename', role: 'dialog', 'aria-modal': 'true', 'aria-busy': 'false', 'aria-labelledby': 'device-title', 'aria-describedby': 'device-desc device-current', novalidate: true },
      returnTo: trigger,
      backdrop: 'close',
      render: deviceRenameBody,
      focus: '#device-label',
      onEscape: () => { if (!deviceRename.saving) layer.close('escape'); },
      onClose: () => { deviceRename.layer = null; },
    });
    deviceRename.layer = layer;
    const panel = layer.panel;
    const renderForm = () => {
      layer.render();
      panel.setAttribute('aria-busy', String(deviceRename.saving));
      layer.el.querySelector('.tc-backdrop').inert = deviceRename.saving;
    };
    panel.querySelector('#device-label').select();
    panel.addEventListener('click', (event) => {
      if (!deviceRename.saving && event.target.closest('[data-device-close]')) layer.close('cancel');
    });
    panel.addEventListener('input', (event) => {
      if (event.target.id !== 'device-label' || deviceRename.saving) return;
      deviceRename.label = event.target.value;
      deviceRename.error = null;
      deviceRename.invalid = false;
      renderForm();
    });
    panel.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (deviceRename.saving || !deviceRenameChanged()) return;
      const operation = access.begin('session', id, 'Saving name…');
      if (!operation) return;
      const label = panel.querySelector('#device-label').value.trim();
      deviceRename.saving = true;
      deviceRename.error = null;
      deviceRename.invalid = false;
      renderForm();
      render();
      Kit.announce('Saving device name.');
      const res = await api('/devices/rename', { body: { id, label } });
      access.finish(operation, res.ok ? { session: res.data.session } : { error: res.error });
      if (res.ok) {
        if (state.status) state.status = access.reconcile(state.status, state.status);
        loadStatus();
        accessToast(res.data.label ? 'Device renamed' : 'Original device name restored');
      }
      render();
      if (deviceRename.layer !== layer) {
        if (!res.ok) accessToast(res.error, { tone: 'danger' });
        return;
      }
      deviceRename.saving = false;
      if (!res.ok) { deviceRename.error = res.error; deviceRename.invalid = res.status === 400; renderForm(); panel.querySelector('#device-label').focus(); return; }
      layer.close('saved');
    });
  };

  const confirmRevoke = async (kind, id) => {
    closeAccessNotice();
    const operation = access.begin(kind, id, 'Awaiting confirmation…');
    if (!operation) return;
    const s = state.status || {};
    let label = id;
    if (kind === 'session') {
      const c = (s.sessions || []).find((x) => x.sessionId === id);
      label = c ? M.deviceName(c) : 'this device';
    } else {
      const l = (s.pairings || []).find((x) => x.id === id);
      label = (l && l.label) || 'Unlabelled';
    }
    const ok = await Kit.confirm(kind === 'session'
      ? { title: 'Revoke ' + label + '?', body: label + ' loses access immediately and has to be paired again with a new link.', confirm: 'Revoke' }
      : { title: 'Revoke this link?', body: '“' + label + '” has not been used yet. Revoking it means the link stops working.', confirm: 'Revoke link' });
    if (!ok) { access.finish(operation); render(); return; }
    operation.verb = kind === 'session' ? 'Revoking access…' : 'Revoking link…';
    render();
    Kit.announce(operation.verb);
    const res = await api('/revoke', { body: { kind, id } });
    access.finish(operation, res.ok ? { removed: true } : { error: res.error });
    if (res.ok) {
      if (state.status) state.status = access.reconcile(state.status, state.status);
      if (kind === 'pairing' && pair.minted?.id === id) pair.minted.outcome = 'revoked';
    }
    render();
    if (!res.ok) { accessToast('Could not revoke', { tone: 'danger', detail: res.error }); return; }
    // Disabling then removing the trigger can leave keyboard focus on body.
    // Move it to another item (or the section heading), unless the user has
    // already moved on to another control while the request was in flight.
    if (document.activeElement === document.body) {
      const heading = $(kind === 'session' ? 'paired-title' : 'links-title') || $('pair-title');
      const next = heading?.closest('section')?.querySelector('button:not([disabled])') || heading;
      if (next) { if (next === heading) next.tabIndex = -1; next.focus({ preventScroll: true }); }
    }
    accessToast(kind === 'session' ? 'Revoked ' + label : 'Link revoked');
    await loadStatus();
  };

  const COMMANDS = {
    'storage.clean': (a) => storageUI.clean(a.id),
    'storage.refresh': () => storageUI.refresh(),
    'storage.preferences': () => storageUI.preferences(),
    'storage.versions': () => storageUI.reviewVersions(),
    'storage.details': () => storageUI.toggle(),
    'skills.check-updates': () => skillsUI.checkUpdates(),
    'skills.refresh': () => skillsUI.refresh(),
    'skills.hooks': a => skillsUI.hooks(a.id),
    'skills.show': a => skillsUI.show(a.id),
    'skills.view-menu': (a, el) => skillsUI.viewMenu(el),
    'skills.all-agents': () => skillsUI.allAgents(),
    'skills.update': a => skillsUI.update(a.id),
    'skills.check-one': a => skillsUI.checkOne(a.id),
    'skills.review-updates': () => skillsUI.reviewUpdates(),
    'skills.bundled': () => skillsUI.toggleBundled(),
    'skills.view': (a) => skillsUI.view(a.id),
    'skills.add': () => skillsUI.add(),
    'skills.import': () => skillsUI.install(),
    'skills.edit': (a) => skillsUI.view(a.id, true),
    'skills.state': (a) => skillsUI.setState(a.id, a.provider),
    'skills.policy': (a, el) => skillsUI.policyMenu(a.id, a.provider, el),
    'skills.menu': (a, el) => skillsUI.menu(a.id, el),
    'skills.filter': (a, el) => skillsUI.filter(el),
    'skills.agent': (a) => skillsUI.select(a.provider || ''),
    'skills.attention': () => skillsUI.attention(),
    'skills.clear': () => skillsUI.clear(),
    'skills.columns': (a, el) => skillsUI.columns(el),
    'skills.group': (a) => skillsUI.group(a.id),
    'skills.copy': (a) => skillsUI.copy(a.id, a.provider),
    'skills.copy-group': (a) => skillsUI.copyGroup(a.id),
    'mcp.refresh': () => mcpUI.refresh(),
    'mcp.view': (a) => mcpUI.view(a.id, a.provider),
    'mcp.add': () => mcpUI.add(),
    'mcp.cell': (a, el) => mcpUI.cellMenu(a.id, a.provider, el),
    'mcp.agent': (a, el) => mcpUI.agentMenu(el),
    'mcp.filter': (a) => mcpUI.filterAgent(a.provider || ''),
    'mcp.attention': () => mcpUI.attention(),
    'mcp.columns': (a, el) => mcpUI.columnsMenu(el),
    'mcp.group': (a) => mcpUI.group(a.id),
    'mcp.share': (a) => mcpUI.share(a.id, a.provider),
    'mcp.link': (a) => mcpUI.toggle(a.provider, a.id),
    'mcp.apply': (a) => mcpUI.apply(a.provider, a.id),
    'storage.goto': () => go('storage'),
    refresh: () => { loadStatus(); loadPorts(); },
    goto: (a) => go(a.route),
    copy: (a, el) => Kit.copy(a.text, el, a.toast),
    theme: (a) => setTheme(a.mode),
    'theme.cycle': () => setTheme({ system: 'light', light: 'dark', dark: 'system' }[themeMode()]),
    palette: () => openPalette(),
    // Inside T3 Code, T3 Code is right behind the dialog.
    'open.t3': () => (EMBED ? toHost('close') : window.open(t3Url(), '_blank', 'noopener')),
    'embed.close': () => toHost('close'),
    lock: async () => {
      await fetch(BASE + '/logout', { method: 'POST', credentials: 'same-origin', redirect: 'manual' }).catch(() => {});
      locked = true;
      // Keeps ?embed=t3, so inside T3 Code the key is asked for in the dialog.
      location.replace(BASE + '/' + location.search);
    },
    diagnostics: (a, el) => {
      const report = M.redactedDiagnostics(state.status, state.ports, { console: { base: BASE || '/', route: state.route, viewport: innerWidth + 'x' + innerHeight } });
      Kit.copy(JSON.stringify(report, null, 2), el && el.closest('[data-cmd]'), 'Diagnostics copied');
    },
    // One check for everything: the agents and tools, and T3 Code's own release.
    'updates.check': (a, el) => {
      if (el && el.getAttribute('aria-disabled') === 'true') return;
      if (state.route !== 'updates') go('updates');
      requestUpdateCheck();
      checkRuntime({ quiet: true });
    },
    'updates.failures': (a, el) => openUpdateChecks(null, el),
    'updates.all': () => updateAll('all'),
    'row.error': (a, el) => {
      const row = rowFor(a.target, a.id);
      const error = row && M.rowError(row, a.source);
      if (!error) return;
      openErrorDetails({ ...error, description: error.text + '. Full diagnostic from the last operation:' }, el);
    },
    'setup.errors': (a, el) => {
      const failures = M.setupFailures(state.status);
      if (!failures.length) return;
      const detail = failures.map((item) => (item.name || item.id) + '\n' + (item.error || (item.state === 'pending' ? 'Not attempted before first start stopped.' : 'The installer returned no further details.'))).join('\n\n');
      openErrorDetails({ title: 'Setup failures', description: 'Retry from a row to try again now. A restart retries these installs too.', detail }, el);
    },
    // The palette's way in: the Updates page, at its switches.
    'auto.settings': () => {
      if (state.route !== 'updates') go('updates');
      requestAnimationFrame(() => {
        $('up-auto')?.scrollIntoView({ block: 'start', behavior: Kit.REDUCED.matches ? 'auto' : 'smooth' });
        document.querySelector('[data-key="auto-toggle-providers"]')?.focus({ preventScroll: true });
      });
    },
    'auto.toggle': (a) => toggleAuto(a.id),
    'auto.schedule': (a, el) => openSchedule(a.id, el),
    'volume.fix': (a, el) => openVolumeFix(a.id, el),
    'key.menu': (a, el) => Kit.menu(el, {
      label: 'Setup key actions',
      head: { title: 'Setup key', tile: html`<span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('key-round')}</span>` },
      items: [{ label: 'Make a new key…', icon: 'refresh-cw', run: () => run('key.replace', {}, el) }],
    }),
    'url.menu': (a, el) => Kit.menu(el, {
      label: 'Public URL actions',
      head: { title: 'Public URL', tile: html`<span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('link')}</span>` },
      items: [{ label: 'Use another address…', icon: 'globe', run: () => openUrlSheet(el) }],
    }),

    'row.menu': (a, el) => {
      const row = rowFor(a.target, a.id);
      if (!row || !row.menu.length) return;
      const status = row.status.text;
      Kit.menu(el, {
        label: row.name + ' actions',
        head: { title: row.name, sub: [row.version, Kit.isPhone() ? status.toLowerCase() : null].filter(Boolean).join(' · '), tile: tile(row, 'lg') },
        items: row.menu.map((m) => m.sep ? m : Object.assign({}, m, { run: () => run(m.cmd, Object.assign({ target: row.target, id: row.id }, m.args), el) })),
      });
    },
    'harness.install': (a) => callLifecycle('harness', 'install', a.id),
    'harness.enable': async (a) => {
      const res = await api('/harnesses/enable', { body: { id: a.id } });
      if (res.ok) Kit.toast('Turned ' + nameOf('harness', a.id) + ' on in T3 Code');
      else Kit.toast('Could not turn ' + nameOf('harness', a.id) + ' on', { tone: 'danger', detail: res.error });
      loadStatus();
    },
    // A release named in full installs even while mise still holds it back.
    'release.now': (a) => {
      if (a.target === 'harness') callLifecycle('harness', harness(a.id) && harness(a.id).installed ? 'update' : 'install', a.id, a.version);
      else callLifecycle('package', 'install', a.id, a.version);
    },
    'harness.update': (a) => callLifecycle('harness', 'update', a.id),
    'harness.uninstall': (a) => confirmUninstall('harness', a.id),
    'harness.version': (a, el) => openToolSheet({ id: a.id, target: 'harness', trigger: el }),
    'harness.signin': (a, el) => openSignin(a.id, el),
    'harness.apikey': (a, el) => openKeySheet(a.id, el),
    'harness.updateAll': () => updateAll('harness'),
    'toolchain.install': (a) => callLifecycle('toolchain', 'install', a.id),
    'toolchain.update': (a) => callLifecycle('toolchain', 'update', a.id),
    'toolchain.uninstall': (a) => confirmUninstall('toolchain', a.id),
    'toolchain.updateAll': () => updateAll('tools'),
    'scm.signin': (a, el) => ((M.SOURCE_CONTROL[a.id] || {}).flow === 'device' ? openSignin(a.id, el) : openScmSheet(a.id, el)),
    'scm.token': (a, el) => openScmSheet(a.id, el),
    'scm.signout': (a) => confirmScmSignOut(a.id),
    'scm.updateAll': () => updateAll('scm'),
    'tools.updateAll': () => updateAll('tools'),
    'package.add': (a, el) => openToolSheet({ id: a.id, trigger: el }),
    'package.install': (a) => callLifecycle('package', 'install', a.id),
    'package.update': (a) => callLifecycle('package', 'update', a.id),
    'package.version': (a, el) => openToolSheet({ id: a.id, mode: 'version', trigger: el }),
    'package.uninstall': (a) => confirmUninstall('package', a.id),
    // A failed first install never reached the config: nothing to confirm.
    'package.dismiss': (a) => callLifecycle('package', 'uninstall', a.id),
    'op.cancel': (a) => cancelOperation(a.target, a.id),

    // The browser just reached T3 Code there, so there is nothing to check.
    'url.use': async () => {
      const here = ui.here;
      if (!here) return;
      const res = await saveUrl(here.url, { seen: true });
      if (!res.ok && res.error) Kit.toast('Could not set the public URL', { tone: 'danger', detail: res.error });
    },
    'url.edit': (a, el) => openUrlSheet(el),

    'connect.setup': (a, el) => openConnect(el),
    'connect.restart': (a, el) => openConnect(el, { restart: true }),
    'connect.off': async () => {
      const ok = await Kit.confirm({
        title: 'Turn T3 Connect off?',
        body: 'This server leaves T3’s relay. Devices that reach it through T3 Connect lose it until it is on again.',
        consequences: [{ icon: 'check', text: 'Your T3 sign-in is kept: turning it on again asks for no new code.' }],
        confirm: 'Turn off',
      });
      if (!ok) return;
      const res = await api('/connect/unlink', { body: {} });
      if (!res.ok) { Kit.toast('Could not turn T3 Connect off', { tone: 'danger', detail: res.error }); return; }
      Kit.toast('T3 Connect is off');
      loadStatus();
    },
    't3.restart': () => restartT3(),
    't3.check': () => checkRuntime(),
    't3.update': (a) => updateRuntime(a.channel || undefined),
    't3.channel': (a) => { if (a.channel !== state.status?.t3?.runtime?.channel) updateRuntime(a.channel); },

    'key.show': async () => {
      if (state.route !== 'server') go('server');
      const res = await api('/setup-key/reveal', { body: {} });
      if (!res.ok) { Kit.toast('Could not read the setup key', { tone: 'danger', detail: res.error }); return; }
      keyView.value = res.data.key;
      render();
    },
    'key.hide': () => { keyView.value = null; render(); },
    'key.replace': async () => {
      if (state.route !== 'server') go('server');
      const t3Session = viaT3(state.status);
      const ok = await Kit.confirm({
        title: 'Replace the setup key?',
        body: 'A new key is generated and kept on the volume, and the current one stops working at once.',
        consequences: [
          { icon: 'log-out', text: 'Browsers signed in with the current key are signed out, and need the new one.' },
          { icon: 'check', text: t3Session ? 'This browser stays in, through its T3 Code session.' : 'This browser stays signed in.' },
          { icon: 'terminal', text: 't3-expose in the container picks the new key up by itself.' },
        ],
        confirm: 'Replace key',
      });
      if (!ok) return;
      const res = await api('/setup-key/replace', { body: {} });
      if (!res.ok) { Kit.toast('Could not replace the setup key', { tone: 'danger', detail: res.error }); return; }
      // Shown at once: the old key must not stay on screen while status reloads.
      keyView.value = res.data.key;
      render();
      Kit.toast('Setup key replaced', { detail: 'Copy the new one now: it is the key the setup page asks for from here on.' });
      await loadStatus();
    },

    'pair.start': () => {
      if (state.route !== 'access') go('access');
      mint();
    },
    'pair.again': () => {
      // Same label and lifetime as the link that lapsed.
      if (pair.minted) pair.ttl = pair.minted.ttl || pair.ttl;
      mint();
    },
    'pair.new': () => {
      if (pair.minting) return;
      if (state.route !== 'access') go('access');
      pair.showForm = true;
      pair.error = null;
      render();
      const input = $('pair-label');
      if (input) input.focus();
    },
    'pair.ttl': (a) => { if (!pair.minting) { pair.ttl = a.value; render(); } },
    'device.menu': (a, el) => {
      if (access.pending('session', a.id)) return;
      closeAccessNotice();
      const d = M.deviceRows((state.status || {}).sessions, now()).find((row) => row.id === a.id);
      if (!d) return;
      Kit.menu(el, {
        label: d.name + ' actions',
        head: { title: d.name, sub: d.status, tile: html`<span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon(d.icon)}</span>` },
        items: [
          { label: 'Rename…', icon: 'pencil', run: () => openDeviceRename(d.id, el) },
          { sep: true },
          { label: 'Revoke…', icon: 'log-out', danger: true, run: () => confirmRevoke('session', d.id) },
        ],
      });
    },
    'link.menu': (a, el) => {
      if (access.pending('pairing', a.id)) return;
      closeAccessNotice();
      const l = M.linkRows((state.status || {}).pairings, null, now()).find((row) => row.id === a.id);
      if (!l) return;
      Kit.menu(el, {
        label: 'Link ' + l.name + ' actions',
        head: { title: l.name, sub: l.status, tile: html`<span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('link')}</span>` },
        items: [{ label: 'Revoke link…', icon: 'trash-2', danger: true, run: () => confirmRevoke('pairing', l.id) }],
      });
    },
    'connect.menu': (a, el) => {
      const view = M.connectView(state.status);
      if (!(view.menu || []).length) return;
      Kit.menu(el, {
        label: 'T3 Connect actions',
        head: { title: 'T3 Connect', sub: view.badge ? view.badge.text : null, tile: html`<span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('globe')}</span>` },
        items: view.menu.map((m) => m.sep ? m : Object.assign({}, m, { run: () => run(m.cmd, m.args || {}, el) })),
      });
    },
    'device.revoke': (a) => confirmRevoke('session', a.id),
    'device.rename': (a, el) => openDeviceRename(a.id, el),
    'link.revoke': (a) => confirmRevoke('pairing', a.id),

    'context.tab': (a) => {
      const hash = '#instructions' + (a.value === 'skills' ? '/skills' : '');
      if (location.hash !== hash) location.hash = hash;
    },
    'context.preview.retry': () => loadInstructionsPreview(true),
    'context.edit': (a, el) => openContextEditor(el),
    'context.menu': (a, el) => Kit.menu(el, { label: 'Shared instructions actions', items: [
      { label: 'Upload…', icon: 'upload', run: async () => { await openContextEditor(el); if (!contextEditor.loading && !contextEditor.readError) contextEditor.layer?.panel.querySelector('#cx-file')?.click(); } },
      { label: 'Download', icon: 'download', run: async () => {
        const response = await api('/context/agents-md');
        if (response.ok) downloadMarkdown('AGENTS.md', response.data.content || '');
        else Kit.toast('Couldn’t download instructions', { tone: 'danger', detail: response.error });
      } }, { sep: true }, { label: 'Delete…', icon: 'trash-2', danger: true, run: () => run('context.delete') },
    ] }),
    'context.delete': async () => {
      const view = M.contextView(state.status);
      if (!view.present) return;
      const confirmed = await Kit.confirm({
        title: 'Delete the shared AGENTS.md?',
        body: 'Agents set to read it read nothing until you write it again, or give them a file of their own.',
        confirm: 'Delete',
      });
      if (!confirmed) return;
      const current = await api('/context/agents-md');
      if (!current.ok) { Kit.toast('Could not delete instructions', { tone: 'danger', detail: current.error }); return; }
      const result = await api('/context/agents-md', { body: { delete: true, revision: current.data.revision } });
      if (!result.ok) { Kit.toast('Could not delete instructions', { tone: 'danger', detail: result.error }); return; }
      Kit.toast('Deleted the shared AGENTS.md');
      await loadStatus();
    },
    'context.provider.edit': (a, el) => {
      const row = M.contextProviderRows(state.status).find((entry) => entry.id === a.id);
      if (row?.mode) openContextEditor(el, row.mode === 'shared' ? null : a.id);
    },
    'context.provider.mode': async (a, el) => {
      const row = M.contextProviderRows(state.status).find((entry) => entry.id === a.id);
      // A choice that does not happen leaves the menu showing what is in effect.
      const settle = () => {
        const current = M.contextProviderRows(state.status).find((entry) => entry.id === a.id);
        if (el && el.tagName === 'SELECT' && el.isConnected) el.value = (current && current.mode) || 'none';
      };
      if (!row || (row.mode || 'none') === a.mode || contextSwitching.has(a.id)) { settle(); return; }
      contextSwitching.add(a.id);
      render();
      try {
        if (a.mode === 'shared' && row.mode === 'separate') {
          const confirmed = await Kit.confirm({
            title: row.name + ': read the shared AGENTS.md?',
            body: 'Its own ' + row.ownFile + ' is backed up, and comes back if you choose it again. Its contents aren’t added to the shared file.',
            confirm: 'Use shared', tone: 'primary',
          });
          if (!confirmed) return;
        }
        if (a.mode === 'none') {
          const confirmed = await Kit.confirm({
            title: row.name + ': read no instructions?',
            body: row.mode === 'separate'
              ? 'Its own ' + row.ownFile + ' is backed up, and comes back if you choose it again.'
              : 'It stops reading the shared AGENTS.md. A file of its own backed up earlier is kept for later.',
            confirm: 'Read nothing',
          });
          if (!confirmed) return;
        }
        const result = await api('/context/agents-md', { body: { provider: a.id, mode: a.mode, sourceRevision: row.sourceRevision } });
        if (!result.ok) { Kit.toast('Couldn’t change what ' + row.name + ' reads', { tone: 'danger', detail: result.error }); return; }
        Kit.toast(row.name + (a.mode === 'shared' ? ' reads the shared AGENTS.md' : a.mode === 'none' ? ' reads no instructions' : ' reads its own ' + row.ownFile));
        await loadStatus();
        if (a.mode === 'separate') openContextEditor(el, a.id);
      } finally {
        contextSwitching.delete(a.id);
        render();
        settle();
      }
    },

    'port.menu': (a, el) => {
      const port = Number(a.id);
      const p = M.portRows(state.ports, ui, now()).find((row) => row.port === port);
      if (!p || p.state !== 'open') return;
      Kit.menu(el, {
        label: 'Port ' + port + ' actions',
        head: { title: 'Port ' + port, sub: M.hostOf(p.url), tile: html`<span class="tc-tile tc-tile--icon tc-tile--lg tc-tile--port-state" data-live aria-hidden="true">${icon('globe')}</span>` },
        items: [
          ...(Kit.isPhone() ? [] : [{ label: p.expanded ? 'Hide the QR code' : 'Show a QR code', icon: 'qr-code', run: () => run('port.qr', { id: String(port) }, el) }]),
          { label: 'Open the link', icon: 'external-link', run: () => window.open(p.url, '_blank', 'noopener') },
          { sep: true },
          { label: 'Stop publishing', icon: 'circle-stop', run: () => stopPort(port) },
        ],
      });
    },
    'port.publish': (a) => publishPort(Number(a.id)),
    'port.stop': (a) => stopPort(Number(a.id)),
    'port.qr': (a) => {
      const port = Number(a.id);
      if (expandedPorts.has(port)) expandedPorts.delete(port);
      else expandedPorts.add(port);
      if (state.route !== 'ports') go('ports');
      render();
    },
  };

  /** Run one command by name: buttons, menus, shortcuts and the palette all come through here. */
  const run = (name, args, el) => {
    const command = name.startsWith('files.') ? (a, target) => filesUI.command(name.slice(6), a, target) : COMMANDS[name];
    if (!command) return;
    try {
      const result = command(args || {}, el || null);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => Kit.toast('Something went wrong', { tone: 'danger', detail: String(error && error.message || error) }));
      }
    } catch (error) {
      Kit.toast('Something went wrong', { tone: 'danger', detail: String(error && error.message || error) });
    }
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd]');
    if (!el || el.disabled || el.closest('[inert]')) return;
    e.preventDefault();
    const args = Object.assign({}, el.dataset);
    run(el.getAttribute('data-cmd'), args, el);
  });

  // The added-tools filter: typing narrows the list as it goes.
  document.addEventListener('input', (e) => {
    if (e.target.id === 'pair-label') { pair.label = e.target.value; return; }
    if (e.target.id === 'skill-search') { skillsUI.search(e.target.value); return; }
    if (e.target.id !== 'tool-filter') return;
    state.toolFilter = e.target.value;
    render();
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'mcp-provider') mcpUI.select(e.target.value);
    if (e.target.hasAttribute('data-skill-policy')) skillsUI.setState(e.target.getAttribute('data-skill-policy'), e.target.getAttribute('data-skill-provider'), e.target.value);
  });

  // A tab list moves with the arrow keys, and the tab under focus opens.
  document.addEventListener('keydown', (e) => {
    const tab = e.target.closest && e.target.closest('[role="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const at = tabs.indexOf(tab);
    const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1]
      : tabs[(at + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    e.preventDefault();
    next.focus();
    next.click();
  });

  // Navigation links keep their hrefs (middle-click, copy link); keyboard
  // navigation from them moves focus to the page.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-nav]')) keyboardNav = true;
  }, true);
  window.addEventListener('hashchange', () => { keyboardNav = false; });

  // -------------------------------------------------------------- palette --
  const openPalette = () => {
    const layer = Kit.palette({
      items: () => [...M.paletteItems(state.status || {}, state.ports, ui, now()), ...skillsUI.paletteItems().map(item => ({ ...item, group: 'Instructions & skills', keywords: item.desc || '' })), ...filesUI.paletteItems()],
      search: M.searchPalette,
      run: (item) => {
        const { cmd, ...args } = item.cmd;
        if (cmd === 'goto') keyboardNav = true;
        run(cmd, args, null);
      },
    });
    // The registry makes "install kubectl" reachable from here; it loads the
    // first time the palette opens and joins the results in place.
    if (layer && !ui.registry) loadRegistry().then(() => layer.refresh && layer.refresh());
  };

  // ------------------------------------------------------------ shortcuts --
  Kit.bind('mod+k', openPalette);
  Kit.bind('/', () => state.route === 'files' ? filesUI.focusSearch() : state.route === 'mcp' ? mcpUI.focusSearch() : state.route === 'instructions' && state.contextTab === 'skills' ? skillsUI.focusSearch() : openPalette());
  for (const page of T3Routes.PAGES) {
    if (page.key) Kit.bind('g ' + page.key, () => { keyboardNav = true; go(page.route); });
  }
  Kit.bind('p', () => {
    if (pair.showForm || !pair.minted || pair.minted.outcome) run('pair.start');
    else run('pair.new');
  }, () => state.route === 'access');
  Kit.bind('n', () => run('package.add'), () => state.route === 'toolchains');

  // ------------------------------------------------------------------ boot --
  window.T3C.hydrateIcons(document);
  Kit.syncDensity();
  applyTheme(themeMode());
  // ⌘ on Apple keyboards, Ctrl elsewhere.
  if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')) {
    for (const k of document.querySelectorAll('[data-mod-key]')) k.textContent = 'Ctrl K';
  }
  // Re-render when the layout crosses the phone breakpoint (menus and sheets
  // pick their shape at open time; rows pick theirs on render).
  Kit.PHONE.addEventListener('change', render);
  if (EMBED) {
    // T3 Code's theme as it changes; a message from any other window is not T3's.
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (e.source !== window.parent || e.origin !== location.origin || !m || m.source !== 't3-code') return;
      if (m.type === 'theme' && (m.theme === 'light' || m.theme === 'dark') && m.theme !== themeMode()) setTheme(m.theme);
    });
    // Escape closes the dialog once nothing on this page wants it: an open
    // menu, sheet or palette takes it first (Kit stops it there).
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) toHost('close');
    });
  }
  show(routeFromHash());
  loadStatus();
  loadPorts();
  if (EMBED) {
    $('main').focus({ preventScroll: true });
    toHost('ready');
  }
})();
