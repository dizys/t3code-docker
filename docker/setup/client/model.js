// The console's view model: pure functions from what /status and /ports return
// to what the page shows - each row's state, its status line, its one visible
// verb and its menu; readiness; what needs the user; navigation badges; the
// command palette's items and ranking; and the formatting every one of those
// shares.
//
// Nothing here touches the DOM, fetches, or reads the clock except through a
// `now` argument, so tests/console-model.test.mjs runs it under Node exactly as
// the browser does, and app.js stays a thin layer of markup and wiring.
const T3Model = (() => {
  'use strict';

  // ----------------------------------------------------------- catalogue --
  // How each agent looks and signs in. The server says what is installed and
  // signed in; this says how to present it, so the strings live in one place.
  const AGENTS = {
    claude: { name: 'Claude Code', mark: 'claude', mono: 'CC', hue: '--id-claude', how: 'browser sign-in', flow: 'code', command: 'claude auth login' },
    codex: { name: 'Codex', mark: 'codex', mono: 'CO', hue: '--id-codex', how: 'device code', flow: 'device', command: 'codex login --device-auth', keyCommand: 'codex login --with-api-key' },
    opencode: { name: 'OpenCode', mark: 'opencode', mono: 'OC', hue: '--id-opencode', how: 'API key, per provider', flow: 'key', command: null },
    grok: { name: 'Grok Build', mark: 'grok', mono: 'GB', hue: '--id-grok', how: 'device code', flow: 'device', command: 'grok login --device-auth' },
    cursor: { name: 'Cursor', mark: 'cursor', mono: 'CU', hue: '--id-cursor', how: 'browser sign-in', flow: 'browser', command: 'cursor-agent login' },
    muse: { name: 'Muse Code', mark: 'muse', mono: 'MC', hue: '--id-toolchain', how: 'device code', flow: 'device', command: 'muse login', keyCommand: 'muse auth set --api-key-stdin', requiresNightly: true },
    // Installed and signed in by T3 Code itself (managedBy: 't3').
    antigravity: { name: 'Antigravity', mark: 'antigravity', mono: 'AG', hue: '--id-toolchain', how: 'Google sign-in', flow: 'redirect', command: null },
  };
  const AGENT_ORDER = ['claude', 'codex', 'opencode', 'grok', 'cursor', 'muse', 'antigravity'];

  const TOOLCHAINS = {
    go: { name: 'Go', mark: 'go', mono: 'Go' },
    rust: { name: 'Rust', mark: 'rust', mono: 'Ru', detail: 'With clippy and rustfmt' },
    bun: { name: 'Bun', mark: 'bun', mono: 'Bu' },
    deno: { name: 'Deno', mark: 'deno', mono: 'De' },
    uv: { name: 'uv', mark: 'uv', mono: 'uv' },
  };

  // The CLI T3 Code drives for each source control host (its Settings >
  // Source Control). gh is part of the image; the rest install like a
  // toolchain, when someone asks for them. Bitbucket has none: T3 talks to
  // its API with a token saved in T3 Code itself.
  //
  // How each signs in here: gh and az with a device code (`flow: 'device'`,
  // `command`), nothing to make or paste; gh, glab, fj and tea with a token
  // for one host (`tokenCommand`, handed over as `handover` says; `host` is
  // the one most people mean, and `tokenPage` makes a token there with
  // `scopes` ticked, where the host lets a link do that). `mark` is the
  // host's mark (design/ui.js), as T3 Code's Source Control settings draw it.
  const SOURCE_CONTROL = {
    gh: { name: 'GitHub CLI', mono: 'gh', mark: 'github', hue: '--id-toolchain', provider: 'GitHub', flow: 'device', command: 'gh auth login --web',
      host: 'github.com', tokenCommand: 'gh auth login --with-token', handover: 'on stdin',
      tokenPage: (host) => 'https://' + host + '/settings/tokens/new?scopes=repo,read:org,workflow&description=T3+Code', scopes: 'repo, read:org, workflow' },
    glab: { name: 'GitLab CLI', mono: 'GL', mark: 'gitlab', hue: '--id-toolchain', provider: 'GitLab', flow: 'token', host: 'gitlab.com', tokenCommand: 'glab auth login', handover: 'on stdin',
      tokenPage: (host) => 'https://' + host + '/-/user_settings/personal_access_tokens?name=T3+Code&scopes=api,write_repository', scopes: 'api, write_repository' },
    fj: { name: 'Forgejo CLI', mono: 'fj', mark: 'forgejo', hue: '--id-toolchain', provider: 'Forgejo', flow: 'token', host: 'codeberg.org', tokenCommand: 'fj auth add-token', handover: 'on stdin',
      tokenPage: (host) => 'https://' + host + '/user/settings/applications', scopes: 'repository and issue: read and write; user: read' },
    tea: { name: 'Gitea CLI', mono: 'tea', mark: 'gitea', hue: '--id-toolchain', provider: 'Gitea', flow: 'token', host: 'gitea.com', tokenCommand: 'tea login add', handover: 'in its environment',
      tokenPage: (host) => 'https://' + host + '/user/settings/applications', scopes: 'repository and issue: read and write; user: read' },
    az: { name: 'Azure CLI', mono: 'az', mark: 'azure-devops', hue: '--id-toolchain', provider: 'Azure DevOps', flow: 'device', command: 'az login --use-device-code' },
  };

  const DONE = { install: 'Installed', update: 'Updated', uninstall: 'Uninstalled' };
  const WORKING = { install: 'Installing', update: 'Updating', uninstall: 'Removing' };
  const FAILED = { install: 'Install failed', update: 'Update failed', uninstall: 'Uninstall failed' };

  // A port that looks like a database asks before it is published.
  const DATABASE_PORTS = new Set([5432, 3306, 6379, 27017, 9000]);
  const DATABASE_PROCESSES = /^(postgres|mysqld|mariadbd|redis-server|mongod|clickhouse)/;

  // ------------------------------------------------------------ versions --
  // Keep the ordering in docker/harness/version.mjs: previews precede their
  // stable release, and build metadata never creates an update.
  const parseVersion = (v) => {
    const text = String(v ?? '').trim().replace(/^v/i, '');
    const numeric = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
    const revision = /^R(\d+)(?:\.(\d+))?$/.exec(numeric?.[2] ?? '');
    return numeric
      ? { numeric: true, core: numeric[1].split('.'), pre: revision ? null : numeric[2]?.split('.') ?? null,
        revision: revision ? [revision[1], revision[2] ?? '0'] : null }
      : { numeric: false, core: text.split(/[.+-]/).filter(Boolean), pre: null };
  };
  const compareParts = (left, right, prerelease) => {
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const x = left[i];
      const y = right[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const xNumeric = /^\d+$/.test(x);
      const yNumeric = /^\d+$/.test(y);
      if (prerelease && xNumeric !== yNumeric) return xNumeric ? -1 : 1;
      if (xNumeric && yNumeric) {
        if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      } else if (x !== y) {
        return x < y ? -1 : 1;
      }
    }
    return 0;
  };
  /** -1, 0 or 1 for numeric releases, prereleases and date versions. */
  const compareVersions = (a, b) => {
    const left = parseVersion(a);
    const right = parseVersion(b);
    const core = compareParts(left.core, right.core);
    if (core !== 0 || !left.numeric || !right.numeric) return core;
    if (left.revision && right.revision) return compareParts(left.revision, right.revision);
    if (left.pre === null) return right.pre === null ? 0 : 1;
    if (right.pre === null) return -1;
    return compareParts(left.pre, right.pre, true);
  };
  /** Whether `latest` is a newer release than `installed`. Unknown is no. */
  const isNewer = (latest, installed) => Boolean(latest && installed && compareVersions(latest, installed) > 0);

  const runtimeView = (s) => {
    const runtime = s?.t3?.runtime;
    if (!runtime) return null;
    const op = runtime.operation;
    const phases = { checking: 'Checking release', downloading: 'Downloading', verifying: 'Verifying download', stopping: 'Restarting T3 Code', snapshot: 'Saving a recovery snapshot', starting: 'Starting new version', restoring: 'Restoring previous version' };
    const busy = Boolean(op && phases[op.phase]);
    const target = runtime.releases?.[runtime.channel];
    const compatible = !runtime.expectedPatchRevision || target?.patchRevision === runtime.expectedPatchRevision;
    const release = compatible ? target?.version : null;
    const integrationMissing = Boolean(runtime.expectedPatchRevision && runtime.patchRevision !== runtime.expectedPatchRevision);
    const integrationUpdate = Boolean(release === runtime.version && target?.patchRevision && target.patchRevision !== runtime.patchRevision);
    const available = Boolean(release && (isNewer(release, runtime.version) || integrationUpdate));
    const targetVersion = busy ? op.version : available ? release : null;
    return { ...runtime, busy, phaseText: busy ? phases[op.phase] : null,
      available, versionTo: targetVersion === runtime.version ? null : targetVersion,
      integrationMissing, integrationUpdate,
      latest: release || null,
      verified: Boolean(release && runtime.checkedAt && !runtime.checkError),
      error: op && ['failed', 'rolled-back', 'interrupted'].includes(op.phase) ? op.error : null };
  };

  // ------------------------------------------------------------- formats --
  const toMs = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const ms = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** "1 Nov", in the reader's own time zone. */
  const shortDate = (value) => {
    const ms = toMs(value);
    if (ms === null) return '—';
    const d = new Date(ms);
    return d.getDate() + ' ' + MONTHS[d.getMonth()];
  };
  /** "1 Oct 2026, 19:40" for title attributes: the absolute time behind a relative one. */
  const absTime = (value) => {
    const ms = toMs(value);
    if (ms === null) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  /**
   * "just now", "6 min ago", "2 hours ago", "yesterday", "in 12 days". Past and
   * future both; anything beyond two months reads as a date.
   */
  const relTime = (value, now) => {
    const ms = toMs(value);
    if (ms === null) return '—';
    const diff = ms - now;
    const past = diff <= 0;
    const s = Math.abs(diff) / 1000;
    if (s < 45) return past ? 'just now' : 'in a moment';
    const say = (text) => (past ? text + ' ago' : 'in ' + text);
    if (s < 3600) return say(Math.max(1, Math.round(s / 60)) + ' min');
    if (s < 86400) return say(plural(Math.round(s / 3600), 'hour'));
    const days = Math.round(s / 86400);
    if (days === 1) return past ? 'yesterday' : 'tomorrow';
    if (days <= 60) return say(plural(days, 'day'));
    return shortDate(ms);
  };
  /** "3 days", "5 hours", "12 min": how long something has been up. */
  const duration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 90) return plural(Math.round(seconds), 'second');
    if (seconds < 5400) return Math.round(seconds / 60) + ' min';
    if (seconds < 172800) return plural(Math.round(seconds / 3600), 'hour');
    return plural(Math.round(seconds / 86400), 'day');
  };
  /** "14:32": minutes and seconds left. */
  const countdown = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return '0:00';
    const total = Math.floor(ms / 1000);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  };
  /** Decimal units, as a download dialog shows them: "148 MB", "4.1 GB". */
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1000) return bytes + ' B';
    const units = ['kB', 'MB', 'GB', 'TB'];
    let n = bytes / 1000;
    let i = 0;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
    return (n >= 100 || i < 1 ? Math.round(n) : Math.round(n * 10) / 10) + ' ' + units[i];
  };
  /**
   * The build a container runs, as the page names it: "v0.5.0 · browser". A
   * branch build is stamped ref@sha with the whole commit hash, which no
   * sidebar has room for, so the hash is cut to the seven characters git
   * itself shows; `full` keeps everything for a tooltip.
   */
  const imageLabel = (image) => {
    const i = image || {};
    if (!i.version) return { text: null, full: null };
    const variant = i.variant ? ' · ' + i.variant : '';
    const short = String(i.version).replace(/@([0-9a-f]{12,64})$/i, (_, sha) => '@' + sha.slice(0, 7));
    return { text: short + variant, version: short, full: i.version + variant };
  };

  /** "Grok Build and Cursor", "A, B and C". */
  const listOf = (names) => names.length <= 1 ? (names[0] || '')
    : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  const hostOf = (url) => {
    try { return new URL(url).host; } catch { return ''; }
  };

  /** Keep opaque diagnostics out of a row; the full text stays available. */
  const rowError = (row, source = 'status') => {
    const detail = source === 'notice' ? row.notice?.tone === 'danger' ? row.notice.text : ''
      : row.status?.dot === 'danger' ? row.status.text : '';
    if (!detail || (detail.length <= 100 && !/https?:\/\/|\n|\S{48}/.test(detail))) return null;
    const operation = /^(Install failed|Update failed|Uninstall failed|Not runnable):/.exec(detail)?.[1] || 'Operation failed';
    const reason = /rate.?limit|too many requests|\b429\b/i.test(detail) ? 'Source rate limit reached'
      : /timed? ?out|ETIMEDOUT/i.test(detail) ? 'Connection timed out'
        : /ENOTFOUND|ECONNREFUSED|network unreachable|could not resolve/i.test(detail) ? 'Could not reach the source' : null;
    return { text: reason || operation, title: row.name + ': ' + operation.toLowerCase(), detail };
  };

  /** The update check for `harness` sources, the others (`toolchain`), or every source (no scope). */
  const updateCheckView = (status, scope, requesting = false) => {
    const updates = status?.updates || {};
    const failures = Object.entries(updates.errors || {}).filter(([key]) => !scope ? true : scope === 'harness' ? key.startsWith('harness:') : !key.startsWith('harness:'));
    const checking = requesting || updates.refreshing;
    return { failures, checking, manual: requesting || updates.manual,
      label: checking ? 'Checking for updates' : failures.length ? 'Review update checks' : 'Check for updates' };
  };

  // ---------------------------------------------------------- operations --
  // What is happening to one agent or toolchain right now, from every source:
  // an operation this page started (operations), one the first-start install
  // is running (setup), or one t3-harness or a restart left in flight (the
  // manager's inProgress fact).
  const progressOf = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const phase = typeof raw.phase === 'string' && raw.phase ? raw.phase : null;
    const done = Number(raw.done);
    const total = Number(raw.total);
    const pct = Number.isFinite(done) && Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : null;
    return { phase, pct, done: Number.isFinite(done) ? done : null, total: Number.isFinite(total) && total > 0 ? total : null };
  };
  const progressText = (p) => {
    if (!p) return '';
    if (p.pct === null) return '';
    const done = formatBytes(p.done);
    const total = formatBytes(p.total);
    // "148 of 238 MB" when both share a unit, "900 kB of 1.2 MB" when not.
    const unit = (text) => text.split(' ')[1];
    return p.pct + '% · ' + (unit(done) === unit(total) ? done.split(' ')[0] : done) + ' of ' + total;
  };

  const activityOf = (status, target, id, ui) => {
    const key = target + ':' + id;
    const op = status.operations && status.operations[key];
    const kind = (op && op.state === 'running' && op.kind) || null;
    const serverQueued = Boolean(op && op.state === 'queued');
    const setup = status.setup || {};
    // The first start's source control CLIs install as toolchains.
    const kinds = target === 'harness' ? ['agent'] : ['toolchain', 'source-control'];
    const item = (setup.items || []).find((i) => kinds.includes(i.kind) && i.id === id);
    const queued = Boolean(setup.state === 'running' && item && item.state === 'pending');
    const installingFromSetup = Boolean(setup.state === 'running' && item && item.state === 'installing');
    return {
      key,
      ownOp: kind ? op : null,
      pending: ui && ui.pending ? ui.pending.get(key) : null,
      // The kind of a request this page has in flight for the row, if any.
      busy: (ui && ui.busy && ui.busy.get(key)) || null,
      queued,
      serverQueued,
      fromSetup: installingFromSetup,
      progress: progressOf((op && op.state === 'running' && op.progress) || (installingFromSetup && item.progress) || null),
    };
  };

  /**
   * A row's own notice (an error from its last click), unless the status line
   * already says it: a failed install reads the same from /status as from the
   * operation that just ended, and saying it twice reads as two problems.
   */
  const distinctNotice = (notice, status) =>
    notice && !(status && status.text && String(status.text).includes(notice.text)) ? notice : undefined;

  // ---------------------------------------------------------------- agents --
  /** "Signed in", or how, when it is not the usual sign-in: an API key. */
  const signedInAs = (h) => (h.authMethod === 'env' ? 'Signed in with a key from the environment'
    : h.authMethod === 'apikey' ? 'Signed in with an API key' : 'Signed in');

  /**
   * One agent row. `ui` carries the page's own bookkeeping (operations it is
   * waiting on, requests in flight, provider names for OpenCode).
   */
  const agentRow = (h, status, ui, now) => {
    const meta = AGENTS[h.id] || { name: h.name || h.id, mono: String(h.id || '?').slice(0, 2).toUpperCase(), hue: '--id-toolchain', how: '' };
    const act = activityOf(status, 'harness', h.id, ui);
    const version = h.installedVersion || h.version || null;
    // Older cache files can still carry an age-held release separately.
    // Explicit agent updates now take it, so promote it immediately.
    const latest = isNewer(h.newestVersion, h.latestVersion) || (!h.latestVersion && h.newestVersion)
      ? h.newestVersion : h.latestVersion || null;
    const updateAvailable = Boolean(h.installed && isNewer(latest, version));
    const runningKind = act.serverQueued ? null : (act.ownOp && act.ownOp.kind) || (act.pending && act.pending.kind)
      || (h.inProgress ? h.operation || 'install' : null) || (act.fromSetup ? 'install' : null) || act.busy;
    const isKey = meta.flow === 'key';

    const row = {
      id: h.id,
      key: act.key,
      target: 'harness',
      name: meta.name,
      mono: meta.mono,
      mark: meta.mark || null,
      hue: meta.hue,
      version,
      latest: updateAvailable ? latest : null,
      updateAvailable,
      state: 'ok',
      status: { dot: null, text: '' },
      badge: null,
      action: null,
      menu: [],
      progress: null,
      cancellable: false,
      attention: false,
    };

    if (h.supported === false) {
      row.state = 'unsupported';
      row.status.text = 'No build for this architecture';
      return row;
    }

    if (runningKind) {
      row.state = 'running';
      row.kind = runningKind;
      row.badge = { tone: 'info', text: WORKING[runningKind] || 'Working', spinner: true };
      row.progress = act.progress || progressOf(h.progress) || { phase: null, pct: null };
      row.cancellable = Boolean(act.ownOp);
      if (runningKind === 'update' && version && latest && latest !== version) row.versionTo = latest;
      row.status.text = runningKind === 'update' && version
        ? version + ' keeps working until this finishes'
        : runningKind === 'uninstall' ? 'Credentials stay on the volume'
          : act.fromSetup ? 'First start installs it in the background' : 'Runs in the background';
      if (row.cancellable) row.action = { cmd: 'op.cancel', label: 'Cancel', variant: 'ghost' };
      return row;
    }

    if (act.queued || act.serverQueued) {
      row.state = 'queued';
      row.badge = { tone: null, text: 'Queued' };
      row.status.text = act.serverQueued ? 'Starts when the install ahead of it finishes' : 'First start installs it in the background';
      if (act.serverQueued) row.action = { cmd: 'op.cancel', label: 'Cancel', variant: 'ghost' };
      return row;
    }

    if (ui && ui.signingIn === h.id) {
      row.state = 'signing';
      row.badge = { tone: 'info', text: 'Signing in', spinner: true };
      row.status.text = meta.flow === 'device' ? 'Waiting for approval on another device'
        : meta.flow === 'code' ? 'Waiting for the code from the sign-in page'
          : meta.flow === 'redirect' ? 'Waiting for the Google sign-in' : 'Waiting for the browser sign-in';
      row.menu = [];
      return row;
    }

    const notice = ui && ui.notices ? ui.notices.get(act.key) : null;
    if (h.managedBy === 't3') return t3AgentRow(row, h, meta, notice, updateAvailable, latest);

    if (!h.installed) {
      if (h.failed && h.failure) {
        // The install itself failed: that needs the user, and the verb is Retry.
        row.state = 'failed';
        row.attention = true;
        row.status = { dot: 'danger', text: (FAILED[h.operation] || 'Failed') + ': ' + h.failure };
        row.action = { cmd: 'harness.install', label: 'Retry', icon: 'refresh-cw', variant: 'warning' };
      } else {
        row.state = 'missing';
        row.status.text = 'Not installed' + (meta.requiresNightly ? ' · requires T3 Code Nightly' : '');
        row.action = { cmd: 'harness.install', label: 'Install', icon: 'download' };
      }
      row.menu = [{ cmd: 'harness.version', label: 'Install a specific version…', icon: 'history' }];
      row.notice = distinctNotice(notice, row.status);
      return row;
    }

    // Installed: what the user should do next decides the one visible verb.
    const lastFailed = Boolean(h.failed && h.failure && h.operation && h.operation !== 'install');
    if (!h.runnable) {
      row.state = 'failed';
      row.attention = true;
      row.status = { dot: 'danger', text: h.failure ? 'Not runnable: ' + h.failure : 'Installed but not runnable' };
      row.action = { cmd: 'harness.install', label: 'Reinstall', icon: 'refresh-cw', variant: 'warning' };
    } else if (lastFailed) {
      row.state = 'failed';
      row.attention = true;
      row.status = { dot: 'danger', text: (FAILED[h.operation] || 'Failed') + ': ' + h.failure };
      row.action = { cmd: h.operation === 'uninstall' ? 'harness.uninstall' : 'harness.update', label: 'Retry', icon: 'refresh-cw', variant: 'warning' };
    } else if (h.signedIn === false) {
      row.state = 'signin';
      row.attention = true;
      row.status = { dot: 'warn', text: isKey ? 'No provider key yet' : 'Not signed in' };
      row.action = isKey
        ? { cmd: 'harness.apikey', label: 'Add key', icon: 'key-round', variant: 'primary' }
        : { cmd: 'harness.signin', label: 'Sign in', icon: 'log-in', variant: 'primary' };
    } else if (h.signedIn !== true) {
      row.state = 'unknown';
      row.status.text = h.id === 'muse' && h.credentialsPresent
        ? 'Credentials saved, checked when you first use it' : 'Couldn’t check its sign-in';
      if (h.id === 'muse' && updateAvailable) row.action = { cmd: 'harness.update', label: 'Update' };
    } else {
      row.state = updateAvailable ? 'update' : 'ok';
      // The version beside the name says when there is a newer one; the
      // status says only how it is signed in.
      const names = (ui && ui.providerNames) || [];
      row.status.text = isKey && names.length ? (names.length === 1 ? 'Key saved for ' : 'Keys saved for ') + listOf(names) : signedInAs(h);
      if (updateAvailable) row.action = { cmd: 'harness.update', label: 'Update' };
      else if (isKey) row.action = { cmd: 'harness.apikey', label: 'Add key', icon: 'key-round' };
    }
    row.notice = distinctNotice(notice, row.status);
    row.held = null;

    // Everything else is one press away in the menu.
    if (updateAvailable) row.menu.push({ cmd: 'harness.update', label: 'Update to ' + latest, icon: 'circle-arrow-up' });
    row.menu.push({ cmd: 'harness.version', label: 'Install a specific version…', icon: 'history' });
    if (h.canSetKey) row.menu.push({ cmd: 'harness.apikey', label: isKey ? 'Add a provider key…' : 'Use an API key…', icon: 'key-round' });
    if (h.canSignIn && h.runnable && row.state !== 'signin') row.menu.push({ cmd: 'harness.signin', label: 'Sign in again', icon: 'log-in' });
    row.menu.push({ sep: true });
    row.menu.push({ cmd: 'harness.uninstall', label: 'Uninstall…', icon: 'trash-2', danger: true });
    return row;
  };

  /**
   * An agent T3 Code installs and signs in itself (Antigravity): T3's
   * installer and T3's Google sign-in, and no release to pick - T3 installs
   * the one it supports, and an update is T3 supporting a newer one.
   */
  const t3AgentRow = (row, h, meta, notice, updateAvailable, latest) => {
    if (h.reachable === false) {
      row.state = 'unreachable';
      row.status = { dot: 'warn', text: 'T3 Code did not answer' + (h.error ? ': ' + h.error : '') };
      row.notice = distinctNotice(notice, row.status);
      return row;
    }
    if (!h.installed) {
      if (h.failed && h.failure) {
        row.state = 'failed';
        row.attention = true;
        row.status = { dot: 'danger', text: 'Install failed: ' + h.failure };
        row.action = { cmd: 'harness.install', label: 'Retry', icon: 'refresh-cw', variant: 'warning' };
      } else {
        row.state = 'missing';
        row.status.text = 'Not installed' + (h.downloadBytes ? ' · a ' + formatBytes(h.downloadBytes) + ' download, through T3 Code' : ' · T3 Code installs it');
        row.action = { cmd: 'harness.install', label: 'Install', icon: 'download' };
      }
      row.notice = distinctNotice(notice, row.status);
      return row;
    }
    const signIn = { cmd: 'harness.signin', label: 'Sign in', icon: 'log-in' };
    if (h.enabled === false) {
      row.state = 'off';
      row.status.text = 'Installed · turned off in T3 Code';
      row.action = { cmd: 'harness.enable', label: 'Turn on', icon: 'circle-check' };
    } else if (h.t3Status === 'error') {
      row.state = 'failed';
      row.attention = true;
      row.status = { dot: 'danger', text: h.t3Message || 'T3 Code reports a problem with ' + meta.name };
      row.action = signIn;
    } else if (h.signedIn === false) {
      row.state = 'signin';
      row.attention = true;
      row.status = { dot: 'warn', text: 'Not signed in' };
      row.action = Object.assign({ variant: 'primary' }, signIn);
    } else if (updateAvailable) {
      row.state = 'update';
      row.status.text = h.signedIn ? (h.account ? 'Signed in as ' + h.account : 'Signed in') : 'Installed';
      row.action = { cmd: 'harness.update', label: 'Update' };
    } else if (h.signedIn === true) {
      row.state = 'ok';
      row.status.text = h.account ? 'Signed in as ' + h.account : 'Signed in';
    } else {
      // T3 checks the Google account when Antigravity is used, so "not
      // checked" is not "signed out": offer the sign-in, do not ask for it.
      row.state = 'unchecked';
      row.status.text = 'Installed · Google sign-in not checked yet';
      row.action = signIn;
    }
    row.notice = distinctNotice(notice, row.status);
    if (updateAvailable) row.menu.push({ cmd: 'harness.update', label: 'Update to ' + latest, icon: 'circle-arrow-up' });
    if (h.canSignIn && !(row.action && row.action.cmd === 'harness.signin')) row.menu.push({ cmd: 'harness.signin', label: h.signedIn ? 'Sign in again' : 'Sign in', icon: 'log-in' });
    row.menu.push({ sep: true });
    row.menu.push({ cmd: 'harness.uninstall', label: 'Uninstall…', icon: 'trash-2', danger: true });
    return row;
  };

  const agentRows = (status, ui, now) => {
    const list = (status && status.harnesses) || [];
    const byId = new Map(list.map((h) => [h.id, h]));
    const ids = [...AGENT_ORDER.filter((id) => byId.has(id)), ...list.map((h) => h.id).filter((id) => !AGENT_ORDER.includes(id))];
    return ids.map((id) => agentRow(byId.get(id), status, ui, now));
  };

  // ------------------------------------------------------------ toolchains --
  // The five toolchains the image installs and the tools added on top of them
  // (any other mise tool in the global config) share one row model: the same
  // states, verbs and menu, each under its own commands (toolchain.update,
  // package.update, ...).

  /** Two letters for a tile: "Jq", "Ri", "Ku". */
  const monogram = (name) => {
    const letters = String(name || '?').replace(/[^A-Za-z0-9]/g, '') || '?';
    return letters[0].toUpperCase() + (letters[1] || '').toLowerCase();
  };

  /** "Provides rg", "Provides node, npm and npx": said only when the commands are not just the name. */
  const providesText = (name, bins) => {
    const list = (bins || []).filter(Boolean);
    if (!list.length || (list.length === 1 && list[0] === name)) return null;
    const shown = list.length > 3 ? list.slice(0, 3).concat(plural(list.length - 3, 'more', 'more')) : list;
    return 'Provides ' + listOf(shown);
  };

  const toolRow = (t, target, status, ui, now) => {
    const isPackage = target === 'package';
    const meta = isPackage
      ? { name: t.name || t.id, mono: monogram(t.name || t.id), detail: providesText(t.name || t.id, t.bins) }
      : TOOLCHAINS[t.id] || SOURCE_CONTROL[t.id] || { name: t.name || t.id, mono: String(t.id || '?').slice(0, 2) };
    const cmd = (verb) => target + '.' + verb;
    const act = activityOf(status, target, t.id, ui);
    const version = t.version || null;
    // A stale server/cache may still name a Rust channel. It is not a release
    // number and must not become an update arrow or a newer-version offer.
    const latest = target === 'toolchain' && t.id === 'rust' && !parseVersion(t.latestVersion).numeric
      ? null : t.latestVersion || null;
    const updateAvailable = Boolean(t.installed && isNewer(latest, version));
    const held = t.installed ? heldRelease(t, version, status, now) : null;
    const runningKind = act.serverQueued ? null : (act.ownOp && act.ownOp.kind) || (act.pending && act.pending.kind)
      || (t.inProgress ? t.operation || 'install' : null) || (act.fromSetup ? 'install' : null) || act.busy;
    const planned = ((status.setup && status.setup.items) || []).some((i) => (i.kind === 'toolchain' || i.kind === 'source-control') && i.id === t.id);
    // What the global config asks for when it is not an exact version
    // (`latest`, `3`): the row says so instead of implying a pin.
    const follows = isPackage && t.requestedVersion && version && t.requestedVersion !== version ? t.requestedVersion : null;

    const row = {
      id: t.id,
      key: act.key,
      target,
      name: meta.name,
      mono: meta.mono,
      mark: meta.mark || null,
      hue: '--id-toolchain',
      version,
      latest: updateAvailable ? latest : null,
      updateAvailable,
      state: 'ok',
      status: { dot: null, text: '' },
      badge: null,
      action: null,
      menu: [],
      progress: null,
      cancellable: false,
      attention: false,
      dim: false,
      description: isPackage ? t.description || null : null,
      bins: isPackage ? t.bins || [] : [],
      // An added tool has no mark of its own; one icon reads better than "No" or "Yt".
      icon: isPackage ? 'terminal' : null,
    };

    if (runningKind) {
      row.state = 'running';
      row.kind = runningKind;
      row.badge = { tone: 'info', text: WORKING[runningKind] || 'Working', spinner: true };
      row.progress = act.progress || { phase: null, pct: null };
      row.cancellable = Boolean(act.ownOp);
      const parts = [];
      if (meta.detail) parts.push(meta.detail);
      if (runningKind === 'update' && version && latest && latest !== version) row.versionTo = latest;
      if (runningKind === 'update' && version) parts.push(version + ' keeps working until this finishes');
      else if (act.fromSetup) parts.push('First start installs it in the background');
      row.status.text = parts.join(' · ');
      if (row.cancellable) row.action = { cmd: 'op.cancel', label: 'Cancel', variant: 'ghost' };
      return row;
    }
    if (act.queued || act.serverQueued) {
      row.state = 'queued';
      row.badge = { tone: null, text: 'Queued' };
      row.status.text = act.serverQueued ? 'Starts when the install ahead of it finishes' : 'First start installs it in the background';
      if (act.serverQueued) row.action = { cmd: 'op.cancel', label: 'Cancel', variant: 'ghost' };
      return row;
    }
    const notice = ui && ui.notices ? ui.notices.get(act.key) : null;

    if (!t.installed) {
      row.dim = true;
      if (t.failed && t.failure) {
        row.state = 'failed';
        row.attention = true;
        row.status = { dot: 'danger', text: (FAILED[t.operation] || 'Failed') + ': ' + t.failure };
        row.action = { cmd: cmd('install'), label: 'Retry', icon: 'refresh-cw', variant: 'warning' };
        // A first install that never reached the config has nothing to
        // uninstall; it can only be retried, or taken off the list.
        if (isPackage && !t.configured) row.menu.push({ cmd: 'package.dismiss', label: 'Remove from this list', icon: 'x' });
      } else {
        row.state = 'missing';
        if (isPackage || planned || !status.setup || status.setup.state === 'off') row.status.text = 'Not installed';
        else row.status = { dot: null, text: 'Not installed · left out of', code: 'T3_PREINSTALL' };
        row.action = { cmd: cmd('install'), label: 'Install', icon: 'download' };
      }
      row.notice = distinctNotice(notice, row.status);
      return row;
    }
    if (t.failed && t.failure && t.operation && t.operation !== 'install') {
      row.state = 'failed';
      row.attention = true;
      row.status = { dot: 'danger', text: (FAILED[t.operation] || 'Failed') + ': ' + t.failure };
      row.action = { cmd: cmd(t.operation === 'uninstall' ? 'uninstall' : 'update'), label: 'Retry', icon: 'refresh-cw', variant: 'warning' };
    } else if (updateAvailable) {
      row.state = 'update';
      row.status.text = meta.detail || 'Installed';
      row.action = { cmd: cmd('update'), label: 'Update' };
    } else {
      const plain = follows ? 'follows ' + follows : held ? held.text : status.updates?.errors?.[target + ':' + t.id] ? 'couldn’t check for updates' : latest ? 'up to date' : null;
      row.status.text = meta.detail ? [meta.detail, plain].filter(Boolean).join(' · ')
        : plain === 'up to date' ? 'Up to date' : ['Installed', plain].filter(Boolean).join(' · ');
    }
    row.notice = distinctNotice(notice, row.status);
    row.held = held;
    if (updateAvailable) row.menu.push({ cmd: cmd('update'), label: 'Update to ' + latest, icon: 'circle-arrow-up' });
    else if (!latest) row.menu.push({ cmd: cmd('update'), label: 'Update to the latest', icon: 'circle-arrow-up' });
    // Toolchains take only mise's newest; an added tool installs any release named.
    if (held && isPackage) row.menu.push({ cmd: 'release.now', label: 'Install ' + held.version + ' now', icon: 'download', args: { version: held.version } });
    if (isPackage) row.menu.push({ cmd: 'package.version', label: 'Install a specific version…', icon: 'history' });
    row.menu.push({ sep: true });
    row.menu.push({ cmd: cmd('uninstall'), label: 'Uninstall…', icon: 'trash-2', danger: true });
    return row;
  };

  const toolchainRow = (t, status, ui, now) => toolRow(t, 'toolchain', status, ui, now);
  const toolchainRows = (status, ui, now) => ((status && status.toolchains) || []).map((t) => toolRow(t, 'toolchain', status, ui, now));
  // ------------------------------------------------------- source control --
  /** "Signed in as ana on gitlab.com", with what the CLI says of itself. */
  const signedInText = (a) => 'Signed in' + (a.account ? ' as ' + a.account : '') + (a.host ? (a.account ? ' on ' : ' to ') + a.host : '');
  /** "sign-in could not be checked: gitlab.example.com does not resolve": a check that got no answer, and why, kept to a line. */
  const uncheckedText = (a) => {
    const why = a && a.detail ? String(a.detail).trim() : '';
    return 'sign-in could not be checked' + (why ? ': ' + (why.length > 90 ? why.slice(0, 89) + '…' : why) : '');
  };
  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  /**
   * One source control CLI. The ones mise installs are toolchain rows (same
   * verbs, queue and commands) that also say which host they are for and who
   * is signed in; one that is installed and signed out needs the user, since
   * T3 Code cannot use it. The image's gh has no verbs, and is never a
   * warning: plenty of servers never talk to GitHub. Nor has a CLI that an
   * added tool provides (`providedBy`): it is updated and removed there, and
   * only signed in to here.
   */
  const sourceControlRow = (c, status, ui, now) => {
    const meta = SOURCE_CONTROL[c.id] || { name: c.name || c.id, mono: String(c.id || '?').slice(0, 2), provider: c.provider || '' };
    const auth = c.auth || null;
    const signIn = { cmd: 'scm.signin', label: 'Sign in', icon: 'log-in' };
    const withToken = { cmd: 'scm.token', label: 'Sign in with a token…', icon: 'key-round' };
    const added = !c.inImage && !c.installed && c.providedBy ? c.providedBy : null;
    const missing = (c.missingExtensions || []).filter(Boolean);
    let row;
    if (c.inImage || added) {
      const present = c.inImage ? c.installed : true;
      row = {
        id: c.id, key: 'toolchain:' + c.id, target: 'toolchain', name: meta.name, mono: meta.mono, mark: meta.mark || null, hue: '--id-toolchain',
        version: (added ? added.version : c.version) || null, latest: null, updateAvailable: false, state: present ? 'ok' : 'missing',
        status: { dot: null, text: '' }, badge: { tone: null, text: added ? 'Added tool' : 'In the image' }, action: null, menu: [],
        progress: null, cancellable: false, attention: false, dim: !present, description: null, bins: [],
      };
      // The image always has gh: one that is not there did not answer.
      row.status.text = !present ? 'Could not be run'
        : auth && auth.status === 'authenticated' ? signedInText(auth)
          : auth && auth.status === 'unauthenticated' ? 'Not signed in' + (auth.host ? ' to ' + auth.host : '')
            : auth && auth.status === 'unknown' ? capital(uncheckedText(auth))
              : added ? 'From ' + added.tool + ', under Added tools' : 'Part of the image';
      if (added && missing.length) {
        // An added az without azure-devops cannot reach a repository. It is
        // the added tool's, so the fix is az's own command.
        row.state = 'failed';
        row.attention = true;
        row.status = { dot: 'warn', text: 'Missing the ' + listOf(missing) + ' extension:', code: 'az extension add --name ' + missing[0] };
      } else if (present && auth && auth.status === 'unauthenticated') {
        // gh's is offered, never pressed on anyone: a quiet button. One the
        // user added is one they mean to use, like a CLI installed here.
        row.action = added ? Object.assign({ variant: 'primary' }, signIn) : signIn;
        if (added) { row.state = 'signin'; row.attention = true; row.status.dot = 'warn'; }
        // A device code is the quick way in; a token is for another server
        // (GitHub Enterprise) or a token with narrower scopes.
        if (meta.flow === 'device' && meta.tokenCommand) row.menu = [withToken];
      }
    } else {
      row = toolRow(c, 'toolchain', status, ui, now);
      if (row.state === 'missing') row.status = { dot: null, text: 'Not installed' };
      const settled = row.state === 'ok' || row.state === 'update';
      if (settled && missing.length) {
        // az without azure-devops cannot reach a repository: installing it
        // again adds the extension.
        row.state = 'failed';
        row.attention = true;
        row.status = { dot: 'warn', text: 'Missing the ' + listOf(missing) + ' extension' };
        row.action = { cmd: 'toolchain.update', label: 'Repair', icon: 'wrench', variant: 'warning' };
      } else if (settled && auth && auth.status === 'authenticated') {
        row.status = { dot: null, text: signedInText(auth) };
      } else if (settled && auth && auth.status === 'unauthenticated') {
        row.state = 'signin';
        row.attention = true;
        row.status = { dot: 'warn', text: 'Not signed in' + (auth.host ? ' to ' + auth.host : '') };
        // Signed out wins the one visible verb; an update stays in the menu.
        row.action = Object.assign({ variant: 'primary' }, signIn);
      } else if (settled && auth && auth.status === 'unknown') {
        // What T3 Code cannot be sure of comes first; an update after it, as
        // for a signed-in row.
        row.status = { dot: null, text: capital(uncheckedText(auth)) };
      }
    }
    const usable = Boolean(c.installed || added) && !c.inProgress && row.state !== 'running' && row.state !== 'queued';
    if (ui && (ui.signingIn === c.id || ui.signingOut === c.id) && (c.installed || added)) {
      const out = ui.signingOut === c.id;
      row.state = 'signing';
      row.badge = { tone: 'info', text: out ? 'Signing out' : 'Signing in', spinner: true };
      row.status = { dot: null, text: out ? 'Signing out' + (auth && auth.host && meta.tokenCommand ? ' of ' + auth.host : '') : 'Waiting for approval on another device' };
      row.action = null;
      row.menu = [];
    } else if (usable && auth) {
      const extra = [];
      if (auth.status === 'unauthenticated') {
        // Signing in is the row's one button, unless something else holds it
        // (a failed update's Retry): then it waits here.
        if (!row.action || row.action.cmd !== 'scm.signin') extra.push(Object.assign({}, signIn, { label: 'Sign in…' }));
      } else {
        // Signed in, or not known: another account or host, and out again. Not
        // known keeps the host it had, so signing in again is the way back.
        if (meta.flow === 'device') extra.push({ cmd: 'scm.signin', label: 'Sign in again…', icon: 'log-in' }, ...(meta.tokenCommand ? [withToken] : []));
        else extra.push({ cmd: 'scm.signin', label: auth.status === 'authenticated' ? 'Sign in to another host…' : 'Sign in again…', icon: 'log-in' });
        // A CLI with a sign-in per host signs out of that one; az of everything.
        if (auth.status === 'authenticated' || auth.host) {
          extra.push({ cmd: 'scm.signout', label: 'Sign out' + (auth.host && meta.tokenCommand ? ' of ' + auth.host : '') + '…', icon: 'log-out' });
        }
      }
      const fresh = extra.filter((item) => !row.menu.some((m) => m.cmd === item.cmd && m.label === item.label));
      const at = row.menu.findIndex((m) => m.sep);
      row.menu = at === -1 ? [...row.menu, ...fresh] : [...row.menu.slice(0, at), ...fresh, ...row.menu.slice(at)];
    }
    row.mark = meta.mark || null;
    row.provider = meta.provider;
    row.command = meta.command || meta.tokenCommand;
    row.flow = meta.flow;
    row.inImage = Boolean(c.inImage);
    row.providedBy = added ? added.tool : null;
    row.auth = auth;
    return row;
  };
  /** In the server's order, which is its catalogue's. */
  const sourceControlRows = (status, ui, now) =>
    ((status && status.sourceControl) || []).map((c) => sourceControlRow(c, status || {}, ui, now));
  /** The source control rows that are managed like a toolchain: not the image's gh, nor one an added tool provides. */
  const managedSourceControlRows = (status, ui, now) => sourceControlRows(status, ui, now).filter((row) => !row.inImage && !row.providedBy);

  /** The name a tool's row shows: its registry name, or the last part of a backend spec (npm:@biomejs/biome -> biome). */
  const toolName = (id) => {
    const spec = String(id || '');
    const name = spec.slice(spec.indexOf(':') + 1);
    return name.split('/').filter(Boolean).pop() || name || spec;
  };

  /**
   * Tools added beyond the toolchains: any other mise tool in the global
   * config. A tool still waiting in the queue (or whose request is in flight)
   * is not in /status yet - the manager lists it once its job holds the lock -
   * so it gets a row from the operation, and shows as queued from the click on.
   */
  const packageRows = (status, ui, now) => {
    const s = status || {};
    const list = [...(s.packages || [])];
    const waiting = [
      ...Object.entries(s.operations || {}).filter(([, op]) => op.state === 'queued' || op.state === 'running').map(([key]) => key),
      ...((ui && ui.pending && [...ui.pending.keys()]) || []),
      ...((ui && ui.busy && [...ui.busy.keys()]) || []),
    ];
    for (const key of waiting) {
      if (!key.startsWith('package:')) continue;
      const id = key.slice('package:'.length);
      const busyKind = ui && ui.busy && ui.busy.get(key);
      // An uninstall in flight is for a row that is already listed.
      if (busyKind === 'uninstall' || list.some((p) => p.id === id)) continue;
      list.push({ id, name: toolName(id), configured: false, installed: false, version: null });
    }
    // By the name a row shows (npm:prettier reads as prettier), so a tool that
    // is still waiting to start already sits where it will stay.
    return list.map((p) => toolRow(p, 'package', s, ui, now))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  };

  // ----------------------------------------------------------- added tools --
  // Names an agent or a toolchain is managed under. The server refuses them as
  // added tools; the Add a tool search shows them, but says where they live.
  const MANAGED_ON = {
    claude: 'Agents', 'claude-code': 'Agents', codex: 'Agents', opencode: 'Agents', grok: 'Agents', cursor: 'Agents',
    'cursor-agent': 'Agents', 'cursor-cli': 'Agents', muse: 'Agents', 'muse-code': 'Agents',
    'npm:@opencode/cli': 'Agents', '@opencode/cli': 'Agents',
    go: 'Toolchains', rust: 'Toolchains', bun: 'Toolchains', deno: 'Toolchains', uv: 'Toolchains',
    // The source control CLIs, under every name mise knows them by.
    glab: 'Source control', 'azure-cli': 'Source control', azure: 'Source control', 'pipx:azure-cli': 'Source control',
    'pypi:azure-cli': 'Source control', 'forgejo:forgejo-contrib/forgejo-cli': 'Source control', 'forgejo:gitea/tea': 'Source control',
  };
  const managedOn = (name) => MANAGED_ON[String(name || '')] || null;

  // A version as mise spells them; the server checks the same pattern.
  const VERSION_SPEC = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
  const isVersionSpec = (value) => VERSION_SPEC.test(String(value || '').trim());
  // `[backend:]name`, mirroring the server's check (docker/harness/packages.mjs).
  const TOOL_SPEC = /^(?:[a-z][a-z0-9-]{0,31}:)?[A-Za-z0-9@_][A-Za-z0-9@._/+-]{0,127}$/;
  const isToolSpec = (value) => {
    const id = String(value || '').trim();
    return TOOL_SPEC.test(id) && !id.includes('..') && !id.endsWith('/');
  };

  // A backend spec half typed ("npm:"): what goes after the colon, and a real
  // one to finish it with. mise has backends not listed here; they work the
  // same, and only miss out on the example.
  const SPEC_EXAMPLES = {
    npm: ['package', 'npm:prettier'],
    cargo: ['crate', 'cargo:ripgrep'],
    pipx: ['package', 'pipx:black'],
    gem: ['gem', 'gem:rubocop'],
    go: ['module path', 'go:golang.org/x/tools/gopls'],
    github: ['owner/repo', 'github:cli/cli'],
    gitlab: ['owner/repo', 'gitlab:gitlab-org/cli'],
    ubi: ['owner/repo', 'ubi:BurntSushi/ripgrep'],
    aqua: ['package', 'aqua:cli/cli'],
  };
  /** Backend specs to suggest when nothing in the registry matches. */
  const SPEC_SAMPLES = ['npm:prettier', 'cargo:ripgrep', 'github:cli/cli'];
  /** The backend of a search that is a backend and a colon, and nothing yet after it; else null. */
  const specPrefix = (query) => {
    const m = /^([a-z][a-z0-9-]{0,31}):$/.exec(String(query || '').trim());
    if (!m) return null;
    const known = SPEC_EXAMPLES[m[1]];
    return { backend: m[1], noun: known ? known[0] : null, example: known ? known[1] : null };
  };

  // A release as listed: a version string, or `{ version, waiting, prerelease,
  // releasedAt, supported }` from /harnesses/versions and /packages/versions.
  const versionOf = (release) => String((release && typeof release === 'object' ? release.version : release) || '');
  const under = (version, q) => version.startsWith(q + '.') || version.startsWith(q + '-') || version.startsWith(q + '+');

  /**
   * The release mise installs for a typed version, the way `mise latest
   * tool@1.3` reads it: exactly the one named, even one mise is still holding
   * back (naming it installs it at once); otherwise the newest under it segment
   * by segment (1.3 -> 1.3.10, never 1.37.1) that mise offers - not one still
   * waiting, not a preview. jq@1.7 is 1.7 even though 1.7.1 exists. Null when
   * it names none.
   */
  const resolveRelease = (releases, query) => {
    const q = String(query || '').trim();
    if (!q) return null;
    const list = releases || [];
    const exact = list.find((r) => versionOf(r) === q);
    if (exact) return versionOf(exact);
    const hit = list.find((r) => under(versionOf(r), q) && !(r && (r.waiting || r.prerelease)));
    return hit ? versionOf(hit) : null;
  };

  /**
   * The releases the version picker lists for what is typed, newest first: the
   * ones it names (the exact release and those under it), or, when it names
   * none - rc, part of a date - the ones containing it.
   */
  const matchReleases = (releases, query) => {
    const list = releases || [];
    const q = String(query || '').trim();
    if (!q) return list;
    const named = list.filter((r) => versionOf(r) === q || under(versionOf(r), q));
    return named.length ? named : list.filter((r) => versionOf(r).includes(q));
  };

  /** Which of the listed releases to highlight: the one the typed version installs, else the first. */
  const releaseIndex = (listed, query) => {
    const target = resolveRelease(listed, query);
    const at = target ? (listed || []).findIndex((r) => versionOf(r) === target) : -1;
    return at === -1 ? 0 : at;
  };

  /**
   * A release out but still inside mise's minimum release age: newer than what
   * is installed and than what mise offers as the newest. `when` says when mise
   * will offer it ("in 21 hours"), where the backend dates its releases.
   */
  const heldRelease = (t, version, status, now) => {
    const newest = t && t.newestVersion;
    // mise can name a channel ("stable" for Rust) where a release would be;
    // a word is no release to wait for.
    if (!newest || !version || !parseVersion(newest).numeric || !isNewer(newest, version)) return null;
    if (t.latestVersion && !isNewer(newest, t.latestVersion)) return null;
    const releasedAt = toMs(t.newestReleasedAt);
    const age = status && Number.isFinite(status.releaseAgeMs) ? status.releaseAgeMs : null;
    const availableAt = releasedAt !== null && age !== null ? releasedAt + age : null;
    return {
      version: newest,
      releasedAt,
      availableAt,
      // mise waits a day before it offers a release; say when, not why.
      text: newest + ' available ' + (availableAt !== null && availableAt > now ? relTime(availableAt, now) : 'once it’s a day old'),
    };
  };

  // What the search offers before anything is typed: common picks that are
  // not already in the image (which has git, gh, jq, ripgrep, fd, Node and
  // Python), each kept only if this mise's registry has it.
  const SUGGESTED_TOOLS = ['kubectl', 'helm', 'terraform', 'aws-cli', 'java', 'zig', 'pnpm', 'just', 'shellcheck', 'lazygit', 'k9s', 'duckdb'];
  // Well-known tools win a tie between equally good matches, so "kube" finds
  // kubectl before kubecm. Only a tie-break: a better match always comes first.
  const PROMINENT = new Set([...SUGGESTED_TOOLS,
    'node', 'python', 'ruby', 'php', 'dotnet', 'elixir', 'erlang', 'kotlin', 'lua', 'perl', 'gradle', 'maven', 'yarn',
    'gcloud', 'azure-cli', 'flyctl', 'opentofu', 'pulumi', 'packer', 'vault', 'kind', 'minikube', 'kustomize', 'helmfile',
    'argocd', 'stern', 'golangci-lint', 'ruff', 'prettier', 'biome', 'shfmt', 'hadolint', 'trivy', 'yq', 'fzf', 'bat',
    'eza', 'delta', 'lazydocker', 'hyperfine', 'sops', 'age', 'direnv', 'watchexec', 'neovim', 'tmux', 'hugo', 'buf',
    'protoc', 'bazel', 'cmake', 'task', 'mkcert', 'caddy', 'gh', 'glab', 'act', 'postgres', 'redis', 'sqlite']);

  /**
   * Rank registry entries for a query: the name itself, then an alias or a
   * command it provides (rg finds ripgrep), then a name that starts with or
   * contains it, then its description ("json" finds jq). The name's match is
   * returned so the option can bold it.
   */
  const searchRegistry = (entries, query, limit) => {
    const max = limit || 30;
    const list = entries || [];
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      const byName = new Map(list.map((e) => [e.name, e]));
      return SUGGESTED_TOOLS.map((name) => byName.get(name)).filter(Boolean).slice(0, max).map((entry) => ({ entry, match: null, score: 0 }));
    }
    const words = q.split(/\s+/);
    const scored = [];
    for (const entry of list) {
      const name = entry.name.toLowerCase();
      const others = (entry.aliases || []).concat(entry.bins || []).map((x) => String(x).toLowerCase());
      const at = name.indexOf(q);
      let score = -1;
      if (name === q) score = 0;
      else if (others.includes(q)) score = 1;
      else if (at === 0) score = 2;
      else if (others.some((x) => x.startsWith(q))) score = 3;
      else if (at > 0 && /[^a-z0-9]/.test(name[at - 1])) score = 4;
      else if (at > 0) score = 5;
      else {
        const hay = name + ' ' + others.join(' ') + ' ' + String(entry.description || '').toLowerCase();
        if (words.every((w) => new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(hay))) score = 6;
        else if (words.every((w) => hay.includes(w))) score = 7;
      }
      if (score === -1) continue;
      scored.push({ entry, match: at >= 0 ? [at, at + q.length] : null, score });
    }
    const prominent = (e) => (PROMINENT.has(e.name) ? 0 : 1);
    scored.sort((a, b) => a.score - b.score || prominent(a.entry) - prominent(b.entry)
      || a.entry.name.length - b.entry.name.length || a.entry.name.localeCompare(b.entry.name));
    return scored.slice(0, max);
  };

  // ---------------------------------------------------------------- ports --
  const looksLikeDatabase = (port, process) => DATABASE_PORTS.has(Number(port)) || DATABASE_PROCESSES.test(String(process || ''));

  /** Rows from what is listening and what is published, in port order. */
  const portRows = (ports, ui, now) => {
    if (!ports) return [];
    const tunnels = new Map((ports.tunnels || []).map((t) => [Number(t.port), t]));
    const details = new Map((ports.details || []).map((d) => [Number(d.port), d]));
    const numbers = [...new Set([...(ports.listening || []).map(Number), ...tunnels.keys()])].filter(Number.isFinite).sort((a, b) => a - b);
    return numbers.map((port) => {
      const t = tunnels.get(port) || null;
      const d = details.get(port) || {};
      const busy = Boolean(ui && ui.portsBusy && ui.portsBusy.has(port));
      let state = t ? t.state : 'idle';
      if (busy && state !== 'open') state = 'starting';
      const process = d.process || null;
      const db = d.looksLikeDatabase === true || (d.looksLikeDatabase === undefined && looksLikeDatabase(port, process));
      const listening = (ports.listening || []).map(Number).includes(port);
      return {
        port,
        state,
        live: state === 'open',
        url: t && t.url ? t.url : null,
        error: t && t.error ? t.error : null,
        qr: t && t.qr ? t.qr : null,
        startedAt: t ? t.startedAt : null,
        process,
        address: d.address || null,
        db,
        listening,
        expanded: Boolean(ui && ui.expandedPorts && ui.expandedPorts.has(port) && state === 'open'),
      };
    });
  };

  // -------------------------------------------------------------- devices --
  const deviceKind = (client) => {
    const c = client || {};
    const os = c.os || null;
    if (c.browser) return c.browser + (os ? ' on ' + os : '');
    if (c.deviceType === 'desktop') return os ? os + ' desktop app' : 'Desktop app';
    if (c.deviceType === 'mobile' || c.deviceType === 'tablet') return os ? os + ' app' : 'Mobile app';
    return os || 'Client';
  };
  const deviceIcon = (client) => {
    const type = (client && client.deviceType) || 'unknown';
    if (type === 'mobile' || type === 'tablet') return 'smartphone';
    if (type === 'desktop') return 'laptop';
    return 'monitor';
  };
  // T3 records how a session began as its subject ("one-time-token" for any
  // browser paired by link), which is no name for a device; what the browser
  // is, is.
  const HOW_PAIRED = new Set(['one-time-token', 'desktop-bootstrap']);
  const deviceLabel = (c) => c.setupLabel || (c.client && c.client.label) || c.label || (c.subject && !HOW_PAIRED.has(c.subject) ? c.subject : null);
  /** What to call a paired device: its label, else what it is ("Safari on iOS"). */
  const deviceName = (session) => deviceLabel(session || {}) || deviceKind((session || {}).client);
  const deviceRows = (sessions, now) => (sessions || []).map((c) => {
    const label = deviceLabel(c);
    const name = label || deviceKind(c.client);
    const seen = c.connected ? 'active now' : c.lastConnectedAt ? 'seen ' + relTime(c.lastConnectedAt, now) : 'not connected yet';
    const ends = toMs(c.expiresAt);
    const days = ends === null ? null : Math.round((ends - now) / 86400000);
    return {
      id: c.sessionId,
      name,
      label: label || '',
      kind: deviceKind(c.client),
      icon: deviceIcon(c.client),
      connected: Boolean(c.connected),
      current: Boolean(c.current),
      // The kind once: as the name when there is no label, else beside it.
      status: [label ? deviceKind(c.client) : null, seen].filter(Boolean).join(' · '),
      ends: ends === null ? null : (days <= 0 ? 'session ends today' : 'session ends ' + relTime(ends, now)),
      seenTitle: c.lastConnectedAt ? 'Seen ' + absTime(c.lastConnectedAt) : '',
    };
  });
  const linkRows = (pairings, waitingId, now) => (pairings || []).map((l) => ({
    id: l.id,
    name: l.label || 'Unlabelled',
    waiting: Boolean(waitingId && l.id === waitingId),
    status: 'Created ' + relTime(l.createdAt, now) + ' · expires ' + relTime(l.expiresAt, now).replace(/^in /, 'in '),
    expiresTitle: 'Expires ' + absTime(l.expiresAt),
  }));

  // -------------------------------------------------------------- connect --
  /**
   * T3 Connect as the page shows it, from status.connect (what T3 Code's CLI
   * has saved) and status.t3.pid (whether this page can restart T3 Code): a
   * badge, a line of text, and at most one action.
   *
   *   off        not set up
   *   restart    signed in; T3 Code makes the link when it next starts
   *   linking    T3 Code has started since, and is making it
   *   on         linked
   *   signin     set up, but its sign-in is gone
   *   unknown    the CLI's answer could not be read
   */
  const connectView = (s) => {
    const c = s && s.connect;
    const restartable = Boolean(s && s.t3 && s.t3.pid);
    if (!c) return { state: 'unknown', badge: null, text: 'Couldn’t read its state just now.', action: null };
    if (c.state === 'on') {
      const publishOnly = c.preferences ? c.preferences.managedTunnelActive === false : c.linkMode === 'publish_only';
      return {
        state: 'on',
        badge: { tone: 'ok', text: 'On' },
        text: publishOnly
          ? 'Linked to your T3 account for agent activity. Devices reach this server through your own address.'
          : 'Devices signed in to your T3 account reach this server through ' + (c.relayHost || 'T3’s relay') + '.',
        action: null,
        // Turning it off cuts devices off: a menu item and a confirmation away.
        menu: [{ cmd: 'connect.off', label: 'Turn off T3 Connect…', icon: 'log-out', danger: true }],
      };
    }
    if (c.state === 'pending' && c.startedSinceLink === true) {
      return {
        state: 'linking',
        badge: { tone: 'info', text: 'Linking', spinner: true },
        text: 'T3 Code is making the link. It can take a minute.',
        action: null,
      };
    }
    if (c.state === 'pending') {
      return {
        state: 'restart',
        badge: { tone: 'info', text: 'Needs a restart' },
        text: restartable
          ? 'Signed in. T3 Code makes the link when it next starts.'
          : 'Signed in. T3 Code makes the link when it next starts, so restart the container.',
        action: restartable ? { cmd: 'connect.restart', label: 'Restart T3 Code', icon: 'refresh-cw' } : null,
      };
    }
    if (c.state === 'signin') {
      return {
        state: 'signin',
        badge: { tone: 'warn', text: c.revoked ? 'Removed' : 'Signed out' },
        text: c.revoked ? 'This server was removed from your T3 account. Set it up again to restore the link.' : 'Its sign-in is gone, so the link cannot be made until you sign in again.',
        action: { cmd: 'connect.setup', label: c.revoked ? 'Set up again' : 'Sign in', icon: 'log-in' },
      };
    }
    return {
      state: 'off',
      badge: null,
      text: 'Reach this server from anywhere through T3’s relay, with no domain or tunnel of your own. Devices then sign in with your T3 account instead of a pairing link.',
      action: { cmd: 'connect.setup', label: 'Set up', icon: 'globe' },
    };
  };

  // ----------------------------------------------------------- public url --
  /** Where the public URL came from, as the page says it: "set here", "from Railway". */
  const publicUrlSource = (s) => {
    switch (s && s.publicUrlSource) {
      case 'env': return 'T3_PUBLIC_URL';
      case 'saved': return 'set here';
      case 'platform': return 'from ' + ((s.publicUrlPlatform && s.publicUrlPlatform.platform) || 'the host');
      default: return null;
    }
  };

  /**
   * The address this page is open on, when it is T3 Code's too: `ui.here` is
   * { url, local } once the page has confirmed that T3 Code answers on its own
   * origin with this server's environment. `local` means only this computer
   * can open it (localhost), which pairs a browser here and nothing else.
   */
  const hereOffer = (s, ui) => {
    const here = ui && ui.here;
    if (!here || !here.url || (s && s.publicUrl === here.url)) return null;
    return here;
  };

  // ------------------------------------------------------------ readiness --
  /**
   * The four steps from a fresh container to a working phone. Exactly one is
   * `todo` (the first not done) and carries the page's only primary button; a
   * later step that needs the user is `warn`.
   */
  const readiness = (status, ui) => {
    const s = status || {};
    const agents = agentRows(s, ui, 0);
    const notSigned = agents.filter((a) => a.state === 'signin');
    // Installed and able to work: signed in, or as far as this page can tell
    // (credentials saved that the agent checks on first use, or a Google
    // sign-in T3 Code checks when Antigravity runs).
    const saved = new Set((s.harnesses || []).filter((h) => h.credentialsPresent).map((h) => h.id));
    const ready = agents.filter((a) => ['ok', 'update', 'unchecked'].includes(a.state) || (a.state === 'unknown' && saved.has(a.id)));
    const unreadable = agents.filter((a) => a.state === 'unknown' && !saved.has(a.id));
    const anyAgent = (s.harnesses || []).some((h) => h.installed);
    const setupRunning = Boolean(s.setup && s.setup.state === 'running');
    const server = s.server || {};

    const urlStep = () => {
      const here = hereOffer(s, ui);
      if (s.publicUrl) return { id: 'url', title: 'Public URL set', done: true, aside: publicUrlSource(s) };
      const step = { id: 'url', title: 'Set the public URL', done: false };
      if (here && !here.local) {
        step.desc = 'Pairing links point at it. This page is open at ' + hostOf(here.url) + ', and T3 Code answers there too.';
        step.action = { cmd: 'url.use', label: 'Use ' + hostOf(here.url), icon: 'check' };
        step.alt = { cmd: 'url.edit', label: 'Other address' };
      } else {
        step.desc = here
          ? 'Pairing links point at it. ' + hostOf(here.url) + ' only opens on this computer, so a phone needs an address it can reach.'
          : 'Pairing links point at it: the address your phone or browser uses to reach this server.';
        step.action = { cmd: 'url.edit', label: 'Set address', icon: 'globe' };
      }
      return step;
    };

    const steps = [
      {
        id: 'server',
        title: server.ok ? 'Server running' : 'Start the server',
        done: Boolean(server.ok),
        aside: server.ok ? [server.version, s.t3 && s.t3.port ? 'port ' + s.t3.port : null].filter(Boolean).join(' · ') : null,
        desc: server.ok ? null : 'T3 Code is not answering yet' + (server.detail ? ' (' + server.detail + ')' : '') + '. It usually takes a few seconds after a start.',
        action: server.ok ? null : { cmd: 'refresh', label: 'Check again', icon: 'refresh-cw' },
      },
      urlStep(s, ui),
      {
        id: 'pair',
        title: s.authLists?.session.available === false ? 'Reading paired devices' : (s.sessions || []).length ? 'Device paired' : 'Pair a device',
        done: (s.sessions || []).length > 0,
        desc: s.authLists?.session.available === false ? 'The device list is loading in the background. This page updates automatically.'
          : !s.publicUrl ? 'A pairing link points at the public URL, so this comes after it.'
            : 'Scan the QR with the T3 Code app, or open the link in a browser.',
        // Before there is an address there is nothing for a link to point at.
        action: s.authLists?.session.available === false || !s.publicUrl ? null : { cmd: 'pair.start', label: 'Create pairing link', icon: 'link' },
      },
      {
        id: 'agents',
        title: notSigned.length === 0 && ready.length > 0 ? 'Agents signed in' : 'Sign in your agents',
        // Done once an agent can work and none waits for a sign-in. One whose
        // sign-in cannot be checked from here (Muse checks on first use) is
        // not waiting on anyone, so it never holds the step open.
        done: notSigned.length === 0 && ready.length > 0,
        desc: notSigned.length
          ? listOf(notSigned.map((a) => a.name)) + (notSigned.length === 1 ? ' is' : ' are') + ' installed but not signed in.'
          : setupRunning && !ready.length ? 'They are still installing. Each one can sign in as soon as it lands.'
            : !anyAgent ? 'No agent is installed yet.'
              : unreadable.length ? 'Couldn’t check whether ' + listOf(unreadable.map((a) => a.name)) + (unreadable.length === 1 ? ' is' : ' are') + ' signed in.'
                : 'Install an agent that can sign in from here.',
        action: notSigned.length
          ? { cmd: 'goto', route: 'agents', label: 'Sign in' }
          : setupRunning && !anyAgent ? null : { cmd: 'goto', route: 'agents', label: 'Open agents' },
      },
    ];
    let todo = -1;
    steps.forEach((step, i) => {
      if (step.done) step.state = 'done';
      else if (todo === -1) { todo = i; step.state = 'todo'; }
      else step.state = step.id === 'agents' && notSigned.length ? 'warn' : '';
      // Only the next step's button is primary; a later step keeps an outline.
      if (step.action) step.action.variant = step.state === 'todo' ? 'primary' : undefined;
      if (step.state === 'done') { step.action = null; step.alt = null; }
    });
    const done = steps.filter((x) => x.done).length;
    const headlines = {
      server: ['Waiting for T3 Code to start', 'The server answers on its own port inside the container. This page notices as soon as it does.'],
      url: ['Set the public URL', 'A paired phone reaches this server at its public URL, so a pairing link needs one before anything else.'],
      pair: s.authLists?.session.available === false
        ? ['Reading paired devices', 'T3 Code is reading the device list in the background. This page updates automatically.']
        : ['Pair your first device', 'A phone is enough to drive this server. Pairing takes one scan and no shell in the container.'],
      agents: ['Sign in your agents', 'Each agent signs in with its own flow, driven from here. Credentials stay on the volume.'],
    };
    const next = todo === -1 ? null : steps[todo];
    return {
      steps,
      done,
      total: steps.length,
      ready: todo === -1,
      next: next ? next.id : null,
      title: next ? headlines[next.id][0] : 'Ready',
      lede: next ? headlines[next.id][1] : '',
    };
  };

  /** "2 devices paired · 5 agents signed in · 5 toolchains · nothing needs you" */
  const readySummary = (status, ui, ports = null) => {
    const s = status || {};
    const agents = agentRows(s, ui, 0);
    const signed = agents.filter((a) => ['ok', 'update'].includes(a.state)).length;
    const tools = (s.toolchains || []).filter((t) => t.installed).length;
    const attention = needsYou(s, ports, ui).length;
    const keep = (text) => text.replace(/^(\d+) /, '$1\u00a0');
    return [
      keep(plural((s.sessions || []).length, 'device')) + ' paired',
      keep(plural(signed, 'agent')) + ' signed in',
      keep(plural(tools, 'toolchain')),
      attention ? keep(plural(attention, 'thing needs', 'things need')) + ' you' : 'nothing needs you',
    ].join(' · ');
  };

  // -------------------------------------------------------- what needs you --
  /**
   * The container's own problems, as items for the Overview's Needs you: a
   * home or state folder the next recreate would leave behind, a filling disk,
   * an older image's settings, a T3 Code update that did not finish, and T3
   * Connect waiting on a restart. Each says what is wrong in a line and offers
   * the one thing to do about it.
   */
  const containerItems = (status) => {
    const s = status || {};
    const paths = s.paths || {};
    const out = [];
    const item = (id, tone, icon, name, text, action) => out.push({ target: 'server', id, key: 'server:' + id, tone, icon, name, text, action });
    const lost = (kind) => kind === 'anonymous' || kind === 'none';
    if (lost(paths.volumeKind)) {
      item('home', 'danger', 'folder', 'Recreating this container would lose its home folder',
        'Agents, toolchains and caches are ' + (paths.volumeKind === 'none' ? 'inside the container.' : 'on an anonymous volume.'),
        { cmd: 'volume.fix', id: 'home', label: 'How to fix' });
    }
    if (lost(paths.stateKind)) {
      item('state', 'danger', 'folder', 'Recreating this container would lose T3 Code’s state',
        'Conversations, sign-ins and settings are ' + (paths.stateKind === 'none' ? 'inside the container.' : 'on an anonymous volume.'),
        { cmd: 'volume.fix', id: 'state', label: 'How to fix' });
    }
    const disk = diskWarning(s);
    if (disk) {
      item('disk', disk, 'hard-drive', 'The disk is ' + s.storage.disk.usedPercent + '% full',
        formatBytes(s.storage.disk.availableBytes) + ' free. Clearing caches and old versions makes room.',
        { cmd: 'goto', route: 'storage', label: 'Free up space' });
    }
    const legacy = (s.legacyEnv || []).filter((name) => name !== 'PATH');
    if ((s.legacyEnv || []).length) {
      item('legacy', 'warn', 'triangle-alert', 'Settings left over from an older image',
        (legacy.length ? listOf(legacy) + (legacy.length === 1 ? ' is' : ' are') : 'The old PATH is') + ' still set in the container. Nothing here uses them.',
        { cmd: 'goto', route: 'server', label: 'Review' });
    }
    const runtime = runtimeView(s);
    if (runtime && runtime.error) {
      item('runtime', 'warn', 'circle-arrow-up', 'T3 Code’s last update didn’t finish', String(runtime.error).split('\n')[0],
        { cmd: 'goto', route: 'updates', label: 'Review' });
    }
    const connect = connectView(s);
    if (connect.state === 'restart' && connect.action) {
      item('connect', 'warn', 'globe', 'T3 Connect is waiting for a restart', 'T3 Code makes the link when it next starts.', connect.action);
    }
    return out;
  };

  /**
   * What needs the person, worst first: anything failed, or lost on the next
   * recreate; then sign-ins and warnings. Agents, tools and source control
   * CLIs come as their own rows; a port that would not publish and the
   * container's own problems as items. Updates are not here: they are
   * offered, on Updates.
   */
  const needsYou = (status, ports, ui) => {
    const s = status || {};
    const rank = { failed: 0, signin: 1 };
    const rows = [
      ...agentRows(s, ui, 0).filter((a) => a.state in rank),
      ...[...toolchainRows(s, ui, 0), ...packageRows(s, ui, 0)].filter((t) => t.state === 'failed'),
      // Every CLI T3 Code would use and cannot yet, an added tool's too; the
      // image's gh is never pressed on anyone.
      ...sourceControlRows(s, ui, 0).filter((c) => !c.inImage && c.state in rank),
    ].map((row) => Object.assign(row, { severity: rank[row.state] }));
    const items = [...rows, ...containerItems(s).map((x) => Object.assign(x, { severity: x.tone === 'danger' ? 0 : 1 }))];
    if (ports) {
      for (const p of portRows(ports, ui, 0)) {
        if (p.state !== 'failed') continue;
        items.push({ target: 'port', id: p.port, key: 'port:' + p.port, tone: 'danger', icon: 'ethernet-port', severity: 0,
          name: 'Port ' + p.port + ' couldn’t be published', text: p.error || 'The tunnel failed.',
          action: { cmd: 'port.publish', id: String(p.port), label: 'Retry', icon: 'refresh-cw' } });
      }
    }
    // Stable within a severity: the order each page lists them in.
    return items.map((item, i) => [item, i]).sort((a, b) => a[0].severity - b[0].severity || a[1] - b[1]).map(([item]) => item);
  };

  // ------------------------------------------------------------- activity --
  /** Work running now, queued behind it, and what finished recently. */
  const activity = (status, ui, now) => {
    const s = status || {};
    const running = [];
    const queued = [];
    for (const row of [...agentRows(s, ui, now), ...toolchainRows(s, ui, now), ...managedSourceControlRows(s, ui, now), ...packageRows(s, ui, now)]) {
      if (row.state === 'running') running.push(row);
      else if (row.state === 'queued') queued.push(row);
    }
    const finished = [];
    for (const [key, op] of Object.entries(s.operations || {})) {
      if (op.state === 'running' || !op.finishedAt) continue;
      if (now - op.finishedAt > 30 * 60 * 1000) continue;
      // On the first colon only: an added tool's id can carry its own (npm:prettier).
      const target = key.slice(0, key.indexOf(':'));
      const id = key.slice(key.indexOf(':') + 1);
      const name = target === 'harness' ? (AGENTS[id] || {}).name || id
        : target === 'toolchain' ? (TOOLCHAINS[id] || SOURCE_CONTROL[id] || {}).name || id
          : ((s.packages || []).find((p) => p.id === id) || {}).name || toolName(id);
      finished.push({
        key,
        ok: op.state === 'ok',
        text: op.state === 'ok' ? op.message || (DONE[op.kind] || 'Finished') + ' ' + name : (FAILED[op.kind] || 'Failed') + ': ' + name,
        at: op.finishedAt,
      });
    }
    const setup = s.setup || {};
    if (setup.state === 'finished' && setup.finishedAt && now - toMs(setup.finishedAt) < 30 * 60 * 1000) {
      const done = (setup.items || []).filter((i) => i.state === 'done');
      if (done.length) {
        const agents = done.filter((i) => i.kind === 'agent').length;
        const tools = done.filter((i) => i.kind === 'toolchain').length;
        const scm = done.filter((i) => i.kind === 'source-control').length;
        finished.push({
          key: 'setup',
          ok: true,
          text: 'First start finished: ' + listOf([agents ? plural(agents, 'agent') : null, tools ? plural(tools, 'toolchain') : null,
            scm ? plural(scm, 'source control CLI') : null].filter(Boolean)),
          at: toMs(setup.finishedAt),
        });
      }
    }
    finished.sort((a, b) => b.at - a.at);
    return { running, queued, finished: finished.slice(0, 4) };
  };

  /** Failed or untried first-start installs that still need attention. */
  const setupFailures = (status) => {
    const setup = status?.setup;
    if (!setup) return [];
    return (setup.items || []).filter((item) => item.state === 'failed' || (setup.state === 'finished' && item.state === 'pending'))
      .filter((item) => {
        const rows = item.kind === 'agent' ? status.harnesses || [] : [...(status.toolchains || []), ...(status.sourceControl || [])];
        return !rows.some((row) => row.id === item.id && row.installed);
      });
  };

  /** The banner under the top bar while the first start installs. */
  const setupBanner = (status) => {
    const setup = (status && status.setup) || null;
    if (!setup || setup.state !== 'running') return null;
    const items = setup.items || [];
    const done = items.filter((i) => i.state === 'done').length;
    const left = items.filter((i) => i.state === 'installing' || i.state === 'pending').map((i) => i.name);
    return {
      done,
      total: items.length,
      pct: items.length ? Math.round((done / items.length) * 100) : 0,
      text: left.length ? 'installing ' + (left.length > 3 ? left.slice(0, 3).join(', ') + ' and ' + (left.length - 3) + ' more' : listOf(left)) + ' in the background. Everything else is ready.'
        : 'finishing up.',
    };
  };

  // ------------------------------------------------------------ navigation --
  /**
   * What the sidebar and the tab bar mark beside a page. Only what needs the
   * person is counted (`warn`); work in progress and a port open to the
   * internet get a quiet mark of their own (`running`, `live`) with no number.
   * How many of something a page holds is the page's to say.
   */
  const navBadges = (status, ports, ui) => {
    const s = status || {};
    const agents = agentRows(s, ui, 0);
    const tools = [...toolchainRows(s, ui, 0), ...packageRows(s, ui, 0)];
    const scm = sourceControlRows(s, ui, 0);
    const portList = ports ? portRows(ports, ui, 0) : [];
    const warn = (count) => (count ? { tone: 'warn', count } : null);
    const running = (count) => (count ? { tone: 'info', kind: 'running', count } : null);
    const live = (count) => (count ? { tone: 'info', kind: 'live', count } : null);
    // Updates are offered, not owed: their count is blue, and T3 Code's Setup
    // badge leaves it out.
    const offered = (count) => (count ? { tone: 'info', kind: 'count', count } : null);
    const busy = (rows) => rows.filter((r) => r.state === 'running' || r.state === 'signing').length;
    const updates = updatesView(s, ui, 0);
    const badges = {
      overview: null,
      // No address and no T3 Connect: nothing can pair yet.
      access: warn(!s.publicUrl && s.server && connectView(s).state !== 'on' && connectView(s).state !== 'linking' ? 1 : 0),
      agents: warn(agents.filter((a) => a.attention).length) || running(busy(agents)),
      instructions: null,
      mcp: warn((s.context?.mcp?.providers || []).filter(p => p.supported && s.harnesses?.some(a => a.id === p.provider && a.installed)).reduce((n, p) => n + (p.diverged?.length || 0) + (p.error ? 1 : 0), 0)),
      toolchains: warn(tools.filter((t) => t.state === 'failed').length) || running(busy(tools)),
      // A source control CLI someone installed and has not signed in is as
      // unusable to T3 Code as a failed one. The image's gh never counts.
      sourcecontrol: warn(scm.filter((c) => c.attention).length) || running(busy(scm)),
      ports: warn(portList.filter((p) => p.state === 'failed').length) || live(portList.filter((p) => p.state === 'open').length),
      updates: running(updates.running) || offered(updates.count),
      storage: warn(diskWarning(s) ? 1 : 0),
      server: warn(serverWarnings(s).length),
    };
    // The phone's More tab carries what needs the person on the pages under it.
    const tabOf = typeof T3Routes === 'object' ? T3Routes.tabOf : () => null;
    badges.more = warn(Object.entries(badges).filter(([route, b]) => tabOf(route) === 'more' && b && b.tone === 'warn')
      .reduce((n, [, b]) => n + b.count, 0));
    return badges;
  };

  /**
   * What about the container itself needs the person: a home or state folder
   * that the next recreate would leave behind, and settings an older image
   * left in its environment.
   */
  const serverWarnings = (status) => {
    const s = status || {};
    const paths = s.paths || {};
    const out = [];
    if (paths.volumeKind === 'anonymous' || paths.volumeKind === 'none') out.push('home');
    if (paths.stateKind === 'anonymous' || paths.stateKind === 'none') out.push('state');
    if ((s.legacyEnv || []).length) out.push('legacy');
    return out;
  };
  /** The home filesystem at 80% or more: 'warn', or 'danger' from 90%. */
  const diskWarning = (status) => {
    const used = status && status.storage && status.storage.disk && status.storage.disk.usedPercent;
    return used >= 90 ? 'danger' : used >= 80 ? 'warn' : null;
  };

  /**
   * How many things need the person, counted as the sidebar's warn badges
   * count them: agents signed out or failing, tools that failed, ports that
   * would not publish, and what is wrong with the container. Updates are not
   * counted; they are offered, not owed, and some agent has one most days.
   * T3 Code's settings show this beside Setup.
   */
  const attentionCount = (status, ports, ui) => {
    const badges = navBadges(status, ports, ui);
    return Object.entries(badges).filter(([route]) => route !== 'more')
      .reduce((n, [, b]) => n + (b && b.tone === 'warn' ? b.count : 0), 0);
  };

  /** The shared meaning of a badge, independent of the host's markup. */
  const navBadgeOf = (badge) => {
    if (!badge || !Number.isSafeInteger(badge.count) || badge.count <= 0) return null;
    const kind = badge.tone === 'warn' ? 'warn' : badge.kind;
    const label = kind === 'warn' ? plural(badge.count, 'thing needs', 'things need') + ' you'
      : kind === 'running' ? plural(badge.count, 'install') + ' running'
        : kind === 'live' ? plural(badge.count, 'port') + ' published'
          : kind === 'count' ? plural(badge.count, 'update') + ' available' : null;
    return label ? { kind, count: badge.count, label } : null;
  };

  /** One navigation model for the console, native Settings and compact menu. */
  const navModel = (status, ports, ui, route) => {
    const s = status || {}, badges = navBadges(s, ports, ui);
    const current = T3Routes.resolve(route);
    return {
      current: T3Routes.PAGES.some((p) => p.route === current) ? current : null,
      groups: T3Routes.grouped().filter((group) => group.pages.length).map((group) => ({
        id: group.id, label: group.label,
        pages: group.pages.map((p) => ({ route: p.route, title: p.title, icon: p.icon, badge: navBadgeOf(badges[p.route]) })),
      })),
      status: { ok: Boolean(s.server?.ok), text: s.server?.ok ? 'Running' : 'Not answering', version: imageLabel(s.image).text },
      attention: attentionCount(s, null, ui),
    };
  };

  // Icons cross the frame boundary as data. No host parses SVG markup from
  // a message. The receiver applies these same restrictions independently.
  const ICON_ELEMENTS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
  const ICON_ATTRIBUTES = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'points', 'fill']);
  const iconNodes = (markup) => {
    if (typeof markup !== 'string' || markup.length > 65536) return [];
    const nodes = [];
    for (const match of markup.matchAll(/<([a-z]+)\b([^<>]*?)\/?\s*>/g)) {
      if (!ICON_ELEMENTS.has(match[1])) continue;
      const attributes = {};
      for (const attr of match[2].matchAll(/\s([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const name = attr[1], value = attr[2] ?? attr[3];
        if (ICON_ATTRIBUTES.has(name) && /^[-0-9a-zA-Z .,]{1,2000}$/.test(value)
            && (name !== 'fill' || value === 'currentColor' || value === 'none')) attributes[name] = value;
      }
      nodes.push([match[1], attributes]);
    }
    return nodes;
  };
  const navIcons = (icons) => Object.fromEntries([...new Set([...T3Routes.PAGES, ...T3Routes.paletteEntries()].map((p) => p.icon))]
    .map((name) => [name, iconNodes(Object.hasOwn(icons || {}, name) ? icons[name] : null)]));

  // -------------------------------------------------------------- summary --
  /**
   * A few words on where each page stands, for the phone's More list:
   * "3 of 4 signed in", "2 available", "79% used".
   */
  const summaries = (status, ports, ui, now) => {
    const s = status || {};
    const agents = agentRows(s, ui, now);
    const installed = agents.filter((a) => a.version && a.state !== 'missing');
    const signed = agents.filter((a) => ['ok', 'update'].includes(a.state)).length;
    const tools = (s.toolchains || []).filter((t) => t.installed).length;
    const added = (s.packages || []).filter((p) => p.configured).length;
    const portList = ports ? portRows(ports, ui, now) : [];
    const scm = (s.sourceControl || []).filter((c) => c.installed || c.providedBy);
    const scmSigned = scm.filter((c) => c.auth && c.auth.status === 'authenticated').length;
    const updates = updatesView(s, ui, now);
    const disk = s.storage && s.storage.disk;
    const said = (text) => ({ text });
    return {
      overview: said(hostOf(s.publicUrl)),
      access: said(plural((s.sessions || []).length, 'device') + ' paired'),
      agents: said(installed.length ? signed + ' of ' + installed.length + ' signed in' : 'None installed yet'),
      instructions: said(contextView(s).present ? 'AGENTS.md written' : 'No AGENTS.md yet'),
      toolchains: said(tools + ' installed' + (added ? ' · ' + added + ' added' : '')),
      sourcecontrol: said(scm.length ? scmSigned + ' signed in' : 'None installed yet'),
      ports: said(ports ? (ports.available === false ? 'Unavailable' : portList.filter((p) => p.state === 'open').length
        ? plural(portList.filter((p) => p.state === 'open').length, 'port') + ' published' : plural(portList.filter((p) => p.listening).length, 'port') + ' listening') : ''),
      updates: said(updates.count ? updates.count + ' available' : 'Up to date'),
      storage: said(disk && Number.isFinite(disk.usedPercent) ? disk.usedPercent + '% used' : ''),
      server: said(imageLabel(s.image).version || ''),
    };
  };

  // ---------------------------------------------------------------- updates --
  /**
   * Everything that can be updated, in one place: T3 Code itself, then each
   * agent, toolchain, added tool and source control CLI with a newer release,
   * and the releases mise is still holding back a day. `count` is what Update
   * all and the sidebar offer.
   */
  const updatesView = (status, ui, now) => {
    const s = status || {};
    const rows = [...agentRows(s, ui, now), ...toolchainRows(s, ui, now), ...packageRows(s, ui, now), ...managedSourceControlRows(s, ui, now)];
    const updating = (r) => r.state === 'running' && r.kind === 'update';
    // An update that failed stays here, with Retry, until it goes through.
    const failedUpdate = (r) => r.state === 'failed' && r.action && /\.update$/.test(r.action.cmd);
    const available = rows.filter((r) => (r.updateAvailable && r.state !== 'running') || updating(r) || failedUpdate(r));
    const held = rows.filter((r) => !r.updateAvailable && r.held && r.state !== 'running');
    const runtime = runtimeView(s);
    const due = available.filter((r) => r.updateAvailable && !updating(r) && !failedUpdate(r) && r.state !== 'queued');
    return {
      available, held, runtime, due,
      count: due.length + (runtime && runtime.available && !runtime.busy ? 1 : 0),
      running: available.filter(updating).length + (runtime && runtime.busy ? 1 : 0),
    };
  };

  // --------------------------------------------------------------- palette --
  /**
   * Every action and object the palette can reach. Each item names its verb and
   * object and carries a command the page runs exactly as its button would.
   */
  const paletteItems = (status, ports, ui, now) => {
    const s = status || {};
    const items = [];
    // Words people reach for that the label does not use ("login", "expose",
    // "log out"): a query matching only these still finds the item.
    const KEYWORDS = {
      'harness.signin': 'login log in auth authenticate', 'harness.apikey': 'api key token credential provider',
      'harness.install': 'add download', 'harness.uninstall': 'remove delete', 'harness.update': 'upgrade',
      'toolchain.install': 'add download', 'toolchain.uninstall': 'remove delete', 'toolchain.update': 'upgrade', 'scm.updateAll': 'upgrade',
      'package.add': 'install new tool package mise registry', 'package.install': 'add download', 'package.uninstall': 'remove delete',
      'package.update': 'upgrade', 'package.version': 'pin downgrade older release', 'tools.updateAll': 'upgrade',
      'port.publish': 'expose share tunnel open', 'port.stop': 'unpublish unexpose close tunnel', 'port.qr': 'scan phone',
      'context.edit': 'edit agents instructions',
      'device.revoke': 'remove delete unpair sign out', 'link.revoke': 'remove delete pairing',
      'pair.start': 'new add phone device qr', lock: 'log out logout sign out', theme: 'appearance mode colour color',
      diagnostics: 'debug support report bug', 'updates.check': 'refresh latest new version', 'open.t3': 'launch app',
      goto: 'go to open page show',
    };
    // What a failed row's Retry does: install it again, or finish its update.
    const retryLabel = (row) => (row.action && /\.update$/.test(row.action.cmd) ? 'Retry the ' + row.name + ' update' : 'Retry installing ' + row.name);
    // An update says the version it starts from; the label says where it goes.
    const from = (version) => (version ? { text: 'from ' + version, mono: true } : null);
    const add = (group, label, icon, cmd, extra) => items.push(Object.assign(
      { group, label, icon, cmd, id: group + ':' + label, keywords: (KEYWORDS[cmd.cmd] || '') + (cmd.cmd === 'goto' ? ' ' + label : '') },
      extra || {}));
    // The container's own problems, as Overview lists them.
    const fixes = { home: 'Fix the home folder’s anonymous volume…', state: 'Fix the state folder’s anonymous volume…',
      legacy: 'Review settings left by an older image', runtime: 'Review the unfinished T3 Code update' };
    for (const item of containerItems(s)) {
      if (!fixes[item.id]) continue;
      add(item.id === 'runtime' ? 'Updates' : 'Server', fixes[item.id], item.icon,
        item.action.cmd === 'goto' ? { cmd: 'goto', route: item.action.route } : { cmd: item.action.cmd, id: item.action.id }, { attention: true });
    }
    add('MCP servers', 'Add MCP server…', 'plug', { cmd: 'mcp.add' });
    add('MCP servers', 'Rescan MCP servers', 'refresh-cw', { cmd: 'mcp.refresh' });
    for (const server of s.context?.mcp?.shared?.servers || []) add('MCP servers', server.name, 'plug', { cmd: 'mcp.view', id: server.name });
    for (const provider of s.context?.mcp?.providers || []) for (const name of provider.diverged || []) add('MCP servers', 'Review ' + name + ' in ' + ({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor' }[provider.provider] || provider.provider), 'triangle-alert', { cmd: 'mcp.view', id: name, provider: provider.provider }, { attention: true });
    add('Storage', 'Free up disk space', 'hard-drive', { cmd: 'storage.goto' }, { keywords: 'disk space caches cleanup folders usage manage storage', attention: Boolean(diskWarning(s)) });
    add('Storage', 'Storage maintenance…', 'settings-2', { cmd: 'storage.preferences' }, { keywords: 'cache limits automatic cleanup retention preferences' });

    for (const a of agentRows(s, ui, now)) {
      const hint = a.state === 'signin' ? { text: 'not signed in', dot: 'warn' }
        : a.state === 'failed' ? { text: 'failed', dot: 'danger' }
          : a.updateAvailable ? { text: a.latest, mono: true } : a.version ? { text: a.version, mono: true } : null;
      const attention = a.attention || a.updateAvailable;
      if (a.state === 'missing') add('Agents', 'Install ' + a.name, 'download', { cmd: 'harness.install', id: a.id }, { meta: null });
      if (a.state === 'signin') add('Agents', (a.action && a.action.label === 'Add key' ? 'Add a provider key for ' : 'Sign in to ') + a.name, a.action && a.action.icon || 'log-in', { cmd: a.action.cmd, id: a.id }, { meta: hint, attention: true });
      if (a.state === 'failed' && a.action) add('Agents', retryLabel(a), 'refresh-cw', { cmd: a.action.cmd, id: a.id }, { meta: hint, attention: true });
      if (a.updateAvailable) add('Agents', 'Update ' + a.name + ' to ' + a.latest, 'circle-arrow-up', { cmd: 'harness.update', id: a.id }, { meta: from(a.version) });
      for (const m of a.menu) {
        if (m.sep || m.cmd === 'harness.update') continue;
        const label = m.cmd === 'harness.signin' ? 'Sign in ' + a.name + ' again'
          : m.cmd === 'harness.version' ? 'Install a specific version of ' + a.name + '…'
            : m.cmd === 'harness.apikey' ? (a.id === 'opencode' ? 'Add a provider key for OpenCode…' : 'Use an API key for ' + a.name + '…')
              : m.cmd === 'harness.uninstall' ? 'Uninstall ' + a.name + '…' : m.label + ' ' + a.name;
        if (items.some((i) => i.label === label)) continue;
        add('Agents', label, m.icon, { cmd: m.cmd, id: a.id }, { meta: m.cmd === 'harness.uninstall' ? null : hint });
      }
    }
    for (const t of toolchainRows(s, ui, now)) {
      if (t.state === 'missing') add('Toolchains', 'Install ' + t.name, 'download', { cmd: 'toolchain.install', id: t.id });
      if (t.updateAvailable) add('Toolchains', 'Update ' + t.name + ' to ' + t.latest, 'circle-arrow-up', { cmd: 'toolchain.update', id: t.id }, { meta: from(t.version) });
      if (t.state === 'failed') add('Toolchains', retryLabel(t), 'refresh-cw', { cmd: t.action.cmd, id: t.id }, { meta: { text: 'failed', dot: 'danger' }, attention: true });
      if (t.version && t.state !== 'running') add('Toolchains', 'Uninstall ' + t.name + '…', 'trash-2', { cmd: 'toolchain.uninstall', id: t.id });
    }
    add('Toolchains', 'Add a tool…', 'plus', { cmd: 'package.add' }, { shortcut: 'N' });
    const installed = new Set();
    for (const t of packageRows(s, ui, now)) {
      installed.add(t.id);
      const version = t.version ? { text: t.version, mono: true } : null;
      if (t.updateAvailable) add('Toolchains', 'Update ' + t.name + ' to ' + t.latest, 'circle-arrow-up', { cmd: 'package.update', id: t.id }, { meta: from(t.version) });
      if (t.state === 'failed') add('Toolchains', retryLabel(t), 'refresh-cw', { cmd: t.action.cmd, id: t.id }, { meta: { text: 'failed', dot: 'danger' }, attention: true });
      if (t.version && t.state !== 'running') {
        add('Toolchains', 'Install a specific version of ' + t.name + '…', 'history', { cmd: 'package.version', id: t.id }, { meta: version });
        add('Toolchains', 'Uninstall ' + t.name + '…', 'trash-2', { cmd: 'package.uninstall', id: t.id });
      }
    }
    for (const c of managedSourceControlRows(s, ui, now)) {
      const keywords = 'source control git ' + c.provider + ' ' + c.id + ' ' + (KEYWORDS[c.action ? c.action.cmd : ''] || '');
      if (c.state === 'missing') add('Source control', 'Install ' + c.name, 'download', { cmd: 'toolchain.install', id: c.id }, { meta: { text: c.provider }, keywords: keywords + ' add download' });
      if (c.updateAvailable) add('Source control', 'Update ' + c.name + ' to ' + c.latest, 'circle-arrow-up', { cmd: 'toolchain.update', id: c.id }, { meta: from(c.version), keywords: keywords + ' upgrade' });
      if (c.state === 'failed' && c.action) {
        const repair = c.action.label === 'Repair';
        add('Source control', repair ? 'Repair ' + c.name : retryLabel(c), c.action.icon || 'refresh-cw', { cmd: c.action.cmd, id: c.id },
          { meta: repair ? { text: 'needs repair', dot: 'warn' } : { text: 'failed', dot: 'danger' }, attention: true, keywords });
      }
      if (c.version && c.state !== 'running') add('Source control', 'Uninstall ' + c.name + '…', 'trash-2', { cmd: 'toolchain.uninstall', id: c.id }, { keywords: keywords + ' remove delete' });
    }
    for (const c of sourceControlRows(s, ui, now)) {
      const keywords = 'source control git login log in auth token ' + c.provider + ' ' + c.id;
      // Signed out, with sign-in on the row's button or, behind a Retry, in its menu.
      const signsIn = (c.action && c.action.cmd === 'scm.signin') || c.menu.some((m) => m.cmd === 'scm.signin' && m.label === 'Sign in…');
      if (signsIn && c.auth && c.auth.status === 'unauthenticated') {
        add('Source control', 'Sign in to ' + c.name, 'log-in', { cmd: 'scm.signin', id: c.id }, { meta: { text: 'not signed in', dot: c.inImage ? null : 'warn' }, attention: !c.inImage, keywords });
      }
      for (const m of c.menu) {
        if (m.cmd === 'scm.signout') add('Source control', m.label.replace('Sign out', 'Sign ' + c.name + ' out'), 'log-out', { cmd: 'scm.signout', id: c.id }, { keywords: keywords + ' log out logout' });
      }
    }
    // The registry, once loaded: anything mise can install, reachable by name,
    // command or description. Only offered for a query; a thousand tools would
    // bury everything else.
    for (const entry of (ui && ui.registry) || []) {
      if (installed.has(entry.name) || managedOn(entry.name)) continue;
      add('Install from mise', 'Install ' + entry.name + '…', 'download', { cmd: 'package.add', id: entry.name }, {
        meta: entry.bins && entry.bins.length && !(entry.bins.length === 1 && entry.bins[0] === entry.name) ? { text: entry.bins.slice(0, 2).join(' '), mono: true } : null,
        keywords: [entry.description, ...(entry.aliases || []), ...(entry.bins || [])].join(' '),
        searchOnly: true,
      });
    }
    if (ports && ports.available !== false) {
      for (const p of portRows(ports, ui, now)) {
        const meta = p.db ? { text: 'database', dot: 'warn' } : p.process ? { text: p.process, mono: true } : null;
        if (p.state === 'idle') add('Ports', 'Publish port ' + p.port + (p.db ? '…' : ''), 'globe', { cmd: 'port.publish', id: p.port }, { meta });
        if (p.state === 'failed') add('Ports', 'Retry publishing port ' + p.port, 'refresh-cw', { cmd: 'port.publish', id: p.port }, { meta: { text: 'failed', dot: 'danger' }, attention: true });
        if (p.state === 'open') {
          add('Ports', 'Copy published URL for port ' + p.port, 'copy', { cmd: 'copy', text: p.url, toast: 'Published URL copied' });
          add('Ports', 'Show QR code for port ' + p.port, 'qr-code', { cmd: 'port.qr', id: p.port });
          add('Ports', 'Stop publishing port ' + p.port, 'circle-stop', { cmd: 'port.stop', id: p.port });
        }
      }
    }
    // Found by name, never listed unasked: there is one per device.
    for (const d of deviceRows(s.sessions, now)) add('Access', 'Revoke ' + d.name + '…', 'trash-2', { cmd: 'device.revoke', id: d.id }, { meta: { text: d.kind }, quiet: true });
    for (const l of linkRows(s.pairings, null, now)) add('Access', 'Revoke link ' + l.name + '…', 'trash-2', { cmd: 'link.revoke', id: l.id }, { quiet: true });

    if (!contextView(s).error) {
      add('Instructions & skills', 'Edit the shared AGENTS.md…', 'pencil', { cmd: 'context.edit' }, { keywords: 'context instructions global' });
      if (contextView(s).present) add('Instructions & skills', 'Delete the shared AGENTS.md…', 'trash-2', { cmd: 'context.delete' }, { keywords: 'context instructions global' });
    }
    for (const row of contextProviderRows(s).filter((row) => row.mode === 'separate' && !row.error)) {
      add('Instructions & skills', 'Edit ' + row.name + '’s ' + row.ownFile + '…', 'pencil', { cmd: 'context.provider.edit', id: row.id }, { keywords: 'context instructions' });
    }
    add('Access', 'Create pairing link', 'link', { cmd: 'pair.start' }, { shortcut: 'P' });
    const updates = updatesView(s, ui, now);
    const runtime = updates.runtime;
    if (runtime && runtime.available && !runtime.busy) {
      add('Updates', runtime.integrationUpdate ? 'Install T3 integration update…' : 'Update T3 Code to ' + runtime.latest + '…', 'circle-arrow-up', { cmd: 't3.update' }, { meta: { text: runtime.version, mono: true }, keywords: 'upgrade t3 code runtime release integration workspace' });
    }
    const agentUpdates = agentRows(s, ui, now).filter((a) => a.updateAvailable).length;
    if (agentUpdates) add('Updates', 'Update all agents', 'circle-arrow-up', { cmd: 'harness.updateAll' }, { meta: { text: plural(agentUpdates, 'update') }, attention: true });
    const toolUpdates = toolchainRows(s, ui, now).filter((t) => t.updateAvailable).length;
    const scmUpdates = managedSourceControlRows(s, ui, now).filter((c) => c.updateAvailable).length;
    if (scmUpdates) add('Updates', 'Update all source control CLIs', 'circle-arrow-up', { cmd: 'scm.updateAll' }, { meta: { text: plural(scmUpdates, 'update') } });
    const packageUpdates = packageRows(s, ui, now).filter((t) => t.updateAvailable).length;
    if (toolUpdates + packageUpdates) {
      add('Updates', packageUpdates ? 'Update all toolchains and tools' : 'Update all toolchains', 'circle-arrow-up', { cmd: 'tools.updateAll' },
        { meta: { text: plural(toolUpdates + packageUpdates, 'update') } });
    }
    add('Updates', 'Check for updates now', 'refresh-cw', { cmd: 'updates.check' });
    add('Updates', 'Automatic updates…', 'clock', { cmd: 'auto.settings' }, { keywords: 'auto update idle schedule providers agents toolchains tools t3' });
    add('Actions', 'Open T3 Code', 'external-link', { cmd: 'open.t3' });
    add('Actions', 'Theme: light', 'sun', { cmd: 'theme', mode: 'light' });
    add('Actions', 'Theme: dark', 'moon', { cmd: 'theme', mode: 'dark' });
    add('Actions', 'Theme: follow the system', 'monitor', { cmd: 'theme', mode: 'system' });
    if (s.publicUrl) add('Access', 'Copy public URL', 'copy', { cmd: 'copy', text: s.publicUrl, toast: 'Public URL copied' }, { meta: { text: hostOf(s.publicUrl), mono: true } });
    if (s.publicUrlSource !== 'env') add('Access', s.publicUrl ? 'Change public URL' : 'Set public URL', 'globe', { cmd: 'url.edit' }, { meta: s.publicUrl ? { text: publicUrlSource(s) } : { text: 'not set', dot: 'warn' }, attention: !s.publicUrl });
    const connect = connectView(s);
    if (connect.state === 'off' || connect.state === 'signin') add('Access', 'Set up T3 Connect', 'globe', { cmd: 'connect.setup' });
    if (connect.state === 'restart') add('Access', 'Restart T3 Code to turn T3 Connect on', 'refresh-cw', { cmd: 'connect.restart' }, { attention: true });
    if (connect.state === 'on') add('Access', 'Turn T3 Connect off', 'globe', { cmd: 'connect.off' });
    if (s.t3 && s.t3.pid) add('Server', 'Restart T3 Code', 'refresh-cw', { cmd: 't3.restart' });
    add('Server', 'Show setup key', 'key-round', { cmd: 'key.show' });
    if (s.setupKeySource && s.setupKeySource !== 'env') add('Server', 'Replace setup key', 'refresh-cw', { cmd: 'key.replace' });
    add('Server', 'Copy diagnostics', 'copy', { cmd: 'diagnostics' });
    add('Server', 'Lock console', 'lock', { cmd: 'lock' });

    // A page answers to the name it had before it moved, too ("environment").
    const routes = typeof T3Routes === 'object' ? T3Routes : { PAGES: [], ALIASES: {} };
    for (const page of routes.PAGES) {
      const formerly = Object.keys(routes.ALIASES).filter((name) => routes.ALIASES[name] === page.route).join(' ');
      add('Go to', page.title, page.icon, { cmd: 'goto', route: page.route }, {
        shortcut: page.key ? 'G ' + page.key.toUpperCase() : null,
        keywords: KEYWORDS.goto + ' ' + page.title + (formerly ? ' ' + formerly : ''),
      });
    }
    for (const target of routes.DESTINATIONS || []) add('Go to', target.title, target.icon, { cmd: 'goto', route: target.hash }, { keywords: target.terms.join(' ') });
    return items;
  };

  // The sidebar's order, then what belongs to no one page.
  const GROUP_ORDER = ['Access', 'Agents', 'Instructions & skills', 'Toolchains', 'Source control', 'Ports', 'Updates', 'Storage', 'Server', 'Actions', 'Go to', 'Install from mise'];
  // Registry results are capped: the best few, after everything the console itself offers.
  const SEARCH_ONLY_LIMIT = 6;

  /**
   * Filter and rank. An empty query lists what needs attention first, then
   * everything by group. A query matches the label anywhere - a prefix above a
   * word start above the middle of a word, and the match is returned so the
   * label can bold it - or, failing that, when every word of it appears in the
   * label or the item's keywords ("go to env", "log out"). Groups stay
   * together, the group holding the best match first.
   */
  const searchPalette = (items, query) => {
    const q = String(query || '').trim().toLowerCase();
    const groupRank = (g) => { const i = GROUP_ORDER.indexOf(g); return i === -1 ? GROUP_ORDER.length : i; };
    if (!q) {
      const attention = items.filter((i) => i.attention).map((i) => Object.assign({}, i, { group: 'Needs you', match: null }));
      const rest = items.filter((i) => !i.attention && !i.searchOnly && !i.quiet).map((i) => Object.assign({}, i, { match: null }));
      rest.sort((a, b) => groupRank(a.group) - groupRank(b.group));
      return [...attention, ...rest];
    }
    const scored = [];
    for (const item of items) {
      const label = item.label.toLowerCase();
      const at = label.indexOf(q);
      let score = -1;
      let match = null;
      if (at === 0) score = 0;
      else if (at > 0 && /[\s(/-]/.test(label[at - 1])) score = 1;
      else if (at > 0) score = 2;
      if (at >= 0) match = [at, at + q.length];
      else {
        const hay = label + ' ' + String(item.keywords || '').toLowerCase();
        if (q.split(/\s+/).every((word) => hay.includes(word))) score = 3;
      }
      if (score === -1) continue;
      scored.push({ item: Object.assign({}, item, { match }), score });
    }
    const best = new Map();
    for (const s of scored) if (!s.item.searchOnly) best.set(s.item.group, Math.min(best.get(s.item.group) ?? Infinity, s.score));
    // Search-only results (the registry) always come after the console's own.
    for (const s of scored) if (s.item.searchOnly) best.set(s.item.group, 99);
    scored.sort((a, b) => best.get(a.item.group) - best.get(b.item.group)
      || groupRank(a.item.group) - groupRank(b.item.group) || a.score - b.score || a.item.label.length - b.item.label.length);
    let searchOnly = 0;
    return scored.filter((s) => !s.item.searchOnly || ++searchOnly <= SEARCH_ONLY_LIMIT).map((s) => s.item);
  };

  // ----------------------------------------------------------- diagnostics --
  /** Storage presentation stays pure so loading, partial scans, disk pressure,
   * and interrupted operations can be verified without a browser. */
  const currentCacheLabel = (phase, cacheRows) => {
    const row = (cacheRows || []).find((item) => item.id === phase);
    return row ? (row.label || phase) : null;
  };
  // Rows written before per-tool caches existed carry no kind; Go and npm
  // were the only caches then, so those ids stay cache rows.
  const isCacheRow = (item) => item.kind === 'cache' || (!item.kind && ['go', 'npm'].includes(item.id));
  const storageView = (status, now) => {
    const storage = status && status.storage || {};
    const operation = storage.operation || null;
    const categories = Array.isArray(storage.categories) ? storage.categories : [];
    const size = (item) => Number.isFinite(item.bytes) && item.bytes >= 0 ? item.bytes : null;
    const cacheRows = categories.filter(isCacheRow).map((item) => ({
      ...item, bytes: size(item), size: formatBytes(size(item)),
      canClean: Boolean(item.cleanable && size(item) > 0),
      state: item.protection || item.unavailable ? 'protected' : size(item) === null ? 'unknown' : size(item) === 0 ? 'empty' : 'ready',
      stateLabel: item.protection || (item.unavailable ? 'Unavailable' : size(item) === 0 ? 'Empty' : size(item) === null ? 'Not measured' : 'Ready to review'),
    }));
    const dataRows = categories.filter((item) => !isCacheRow(item)).map((item) => ({ ...item, bytes: size(item), size: formatBytes(size(item)) }))
      .sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    const ids = cacheRows.filter((item) => item.canClean).map((item) => item.id);
    const cleanableBytes = cacheRows.filter((item) => item.canClean).reduce((sum, item) => sum + item.bytes, 0);
    const cacheBytes = cacheRows.reduce((sum, item) => sum + (item.bytes || 0), 0);
    const cachePolicies = Array.isArray(storage.cachePolicies) && storage.cachePolicies.length ? storage.cachePolicies
      : cacheRows.map((row) => ({ id: row.id, label: row.label, icon: row.icon, budgetKey: row.id + 'BudgetBytes', defaultBytes: row.id === 'go' ? 10e9 : row.id === 'mise' ? 5e9 : row.id === 'deno' ? 1e9 : 2e9 }));
    const rawDisk = storage.disk;
    const disk = rawDisk && Number.isFinite(rawDisk.usedPercent) ? {
      ...rawDisk, usedPercent: Math.max(0, Math.min(100, rawDisk.usedPercent)),
      used: formatBytes(rawDisk.usedBytes), total: formatBytes(rawDisk.totalBytes), available: formatBytes(rawDisk.availableBytes),
      tone: rawDisk.usedPercent >= 90 ? 'danger' : rawDisk.usedPercent >= 80 ? 'warn' : 'info',
      title: rawDisk.usedPercent >= 90 ? 'Disk space is nearly full' : rawDisk.usedPercent >= 80 ? 'Disk space is running low' : 'Filesystem space',
    } : null;
    return {
      ...storage, operation, disk, cacheRows, dataRows, ids, cleanableBytes, cacheBytes, cachePolicies,
      busy: Boolean(operation && operation.state === 'running'),
      loading: !storage.at, refreshing: Boolean(storage.refreshing),
      checked: storage.at ? 'Checked ' + relTime(storage.at, now) : 'Not measured yet',
      progress: !operation || operation.state !== 'running' ? null : operation.phase === 'versions' ? 'Trimming older tool versions…' : currentCacheLabel(operation.phase, cacheRows) ? 'Clearing ' + currentCacheLabel(operation.phase, cacheRows) + '…' : 'Checking caches…',
      policy: storage.policy || { automatic: false, retainManagedVersions: true, goBudgetBytes: 10_000_000_000, npmBudgetBytes: 2_000_000_000, uvBudgetBytes: 2_000_000_000, bunBudgetBytes: 2_000_000_000, miseBudgetBytes: 5_000_000_000, denoBudgetBytes: 1_000_000_000, gomodBudgetBytes: 2_000_000_000 },
    };
  };

  /** /status with anything identifying taken out, for pasting into an issue. */
  const redactedDiagnostics = (status, ports, extra) => {
    const copy = JSON.parse(JSON.stringify(status || {}));
    for (const c of copy.sessions || []) {
      if (c.client) { delete c.client.ipAddress; delete c.client.userAgent; }
      c.sessionId = c.sessionId ? c.sessionId.slice(0, 8) + '…' : c.sessionId;
    }
    for (const l of copy.pairings || []) l.id = l.id ? l.id.slice(0, 8) + '…' : l.id;
    const portCopy = ports ? JSON.parse(JSON.stringify(ports)) : null;
    if (portCopy) for (const t of portCopy.tunnels || []) delete t.qr;
    return Object.assign({ generatedAt: new Date().toISOString() }, extra || {}, { status: copy, ports: portCopy });
  };

  // Global instructions are optional, so Context never adds an attention badge.
  const contextView = (status) => {
    const file = status?.context?.agentsMd || {};
    return { present: Boolean(file.present), bytes: file.bytes || 0, error: file.error || null };
  };

  const PROVIDER_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
  // The file each agent reads on its own when it is not using the shared one.
  const OWN_FILE = { claude: 'CLAUDE.md', codex: 'AGENTS.md', opencode: 'AGENTS.md' };

  /** The shared AGENTS.md: how big it is, and which agents read it. */
  const contextAgentsMdRow = (status) => {
    const view = contextView(status);
    const readers = contextProviderRows(status).filter((row) => row.mode === 'shared').map((row) => row.name);
    return {
      id: 'global',
      key: 'agentsmd:global',
      target: 'context-agentsmd',
      name: 'AGENTS.md',
      description: '',
      mono: 'AG',
      hue: '--id-toolchain',
      version: null,
      state: view.error ? 'unavailable' : 'ok',
      icon: 'file-text',
      status: view.error ? { dot: 'danger', text: view.error }
        : !view.present ? { text: 'Not written yet' + (readers.length ? ' · ' + listOf(readers) + (readers.length === 1 ? ' reads' : ' read') + ' it once you do' : '') }
          : { text: formatBytes(view.bytes) + ' · ' + (readers.length ? 'read by ' + listOf(readers) : 'no agent reads it yet') },
      badge: view.error ? { tone: 'warn', text: 'Unavailable' } : null,
      action: view.error ? null : { cmd: 'context.edit', label: view.present ? 'Edit' : 'Write', icon: 'pencil' },
      menu: view.present && !view.error ? [{ cmd: 'context.delete', label: 'Delete…', icon: 'trash-2', danger: true }] : [],
      attention: false,
      readers,
    };
  };

  /**
   * Each agent's instructions, said as what it reads: the shared AGENTS.md, a
   * file of its own, or nothing. Only the agents in use are listed: installed
   * ones, plus any that already has instructions (so an uninstalled agent's
   * leftover file can still be edited or cleared). Without harness facts,
   * every provider is listed.
   */
  const contextProviderRows = (status) => {
    const providers = status?.context?.providers || [];
    const harnesses = status?.harnesses;
    const installed = Array.isArray(harnesses) ? new Set(harnesses.filter((h) => h.installed).map((h) => h.id)) : null;
    const list = !installed || installed.size === 0 ? providers
      : providers.filter((file) => installed.has(file.provider) || file.mode || file.error);
    return list.map((file) => {
      const name = PROVIDER_NAMES[file.provider] || file.provider;
      const own = OWN_FILE[file.provider] || 'AGENTS.md';
      return {
        id: file.provider,
        key: 'agentsmd:' + file.provider,
        name,
        mark: file.provider, mono: 'AG', hue: '--id-toolchain',
        ownFile: own,
        status: file.error ? { dot: 'danger', text: file.error }
          : file.mode === 'shared' ? { text: 'Reads the shared AGENTS.md' }
            : file.mode === 'separate' ? { text: 'Reads its own ' + own }
              : { text: 'Reads no global instructions' },
        // What the row says under its name, beside the choice that already
        // says what it reads: where its own file is, or why it reads nothing.
        note: file.error ? null : file.mode === 'separate' ? file.path || null
          : file.mode === 'shared' && !(status?.context?.agentsMd || {}).present ? 'The shared file isn’t written yet' : null,
        path: file.path || null,
        badge: file.error ? { tone: 'warn', text: 'Unavailable' } : null,
        mode: file.mode || null, bytes: file.bytes, modifiedAt: file.modifiedAt, sourceRevision: file.sourceRevision, error: file.error || null,
      };
    });
  };

  // Shared MCP servers: redacted summaries in /status, secrets only in the
  // editor. Provider support is uneven; unsupported providers stay visible
  // with their reason instead of failing the whole section.
  const mcpView = (status) => {
    const mcp = status?.context?.mcp || {};
    const shared = mcp.shared || {};
    return { present: Boolean(shared.present), count: shared.count || (shared.servers || []).length, revision: shared.revision || null,
      bytes: shared.bytes || 0, error: shared.error || null, ok: mcp.ok !== false };
  };
  // Automatic updates: the policy and last run from /status, as the Updates
  // page's switches say them. Pure, so the words are testable without a browser.
  const autoUpdateView = (status, now) => {
    const auto = status?.autoUpdate || {};
    const rawPolicy = auto.policy || {};
    const policy = {
      providers: rawPolicy.providers || { enabled: false },
      // Tolerate a version 1 status payload during rollout: toolchains used
      // to be an add-on flag under providers.
      toolchains: rawPolicy.toolchains || {
        enabled: Boolean(rawPolicy.providers?.enabled && rawPolicy.providers?.includeToolchains),
        checkMinutes: rawPolicy.providers?.checkMinutes,
        idleMinutes: rawPolicy.providers?.idleMinutes,
      },
      t3: rawPolicy.t3 || { enabled: false },
    };
    const state = auto.state || {};
    const idleMs = (at) => (Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : null);
    const fmtIdle = (at) => {
      const ms = idleMs(at);
      if (ms === null) return "Not used since the setup service started";
      if (ms < 60_000) return "Last used just now";
      return "Last used " + relTime(at, now);
    };
    const hours = (m) => (m % 60 === 0 ? plural(m / 60, 'hour') : m >= 60 ? Math.round(m / 6) / 10 + ' hours' : m + ' min');
    // How a category's schedule reads under its switch on the Updates page.
    const schedule = (kind) => (!kind?.enabled ? 'Off'
      : 'Checks every ' + hours(kind.checkMinutes || 180) + ', and installs after ' + (kind.idleMinutes || 30) + ' min without activity.');
    const checked = (at) => (Number.isFinite(at) && at > 0 ? 'Last checked ' + relTime(at, now) + '.' : null);
    return {
      policy, state,
      schedule: { providers: schedule(policy.providers), toolchains: schedule(policy.toolchains), t3: schedule(policy.t3) },
      lastChecked: { providers: checked(state.lastProviderCheckAt), toolchains: checked(state.lastToolchainCheckAt), t3: checked(state.lastT3CheckAt) },
      lastActivity: auto.lastActivityAt || null,
      lastActivityText: fmtIdle(auto.lastActivityAt),
      busy: auto.busy || null,
      lastResult: state.lastResult || null,
    };
  };

  return {
    AGENTS, TOOLCHAINS, SOURCE_CONTROL, DONE, WORKING, FAILED,
    compareVersions, isNewer,
    relTime, absTime, shortDate, duration, countdown, formatBytes, listOf, hostOf, plural, toMs, imageLabel,
    progressOf, progressText, rowError, updateCheckView,
    agentRow, agentRows, toolRow, toolchainRow, toolchainRows, sourceControlRows, managedSourceControlRows, packageRows, portRows, looksLikeDatabase,
    monogram, managedOn, isVersionSpec, isToolSpec, specPrefix, SPEC_SAMPLES, searchRegistry, resolveRelease, matchReleases, releaseIndex, heldRelease, versionOf, toolName, SUGGESTED_TOOLS,
    deviceRows, linkRows, deviceKind, deviceName,
    readiness, readySummary, needsYou, containerItems, activity, setupBanner, setupFailures,
    publicUrlSource, hereOffer, connectView,
    contextView, contextAgentsMdRow, contextProviderRows,
    mcpView,
    navBadges, navBadgeOf, navModel, iconNodes, navIcons, serverWarnings, diskWarning, attentionCount, summaries, updatesView, runtimeView, autoUpdateView,
    paletteItems, searchPalette,
    redactedDiagnostics, storageView,
  };
})();
