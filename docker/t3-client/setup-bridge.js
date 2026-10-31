// T3 Code's way to the setup console, injected into T3 Code's client shell at
// image build time by docker/t3-client/patch.mjs.
//
// The console and T3 Code are separate services, and nothing in T3 Code knows
// the console exists. This adds it where a person would look for it:
//
//   - Before pairing, a Setup pill in the pairing screen's empty corner. It
//     opens the console in a tab of its own, which asks for the setup key.
//   - Once paired, a pinned Setup entry in Settings opens its own pages in
//     that same surface, with the console's grouped nav and attention count.
//   - Native command-palette results use authenticated registry metadata and
//     open Settings on the requested Setup page.
//
// Both appear only when the console answers on this origin (the documented
// route puts it at /__setup), so a deployment that does not route it keeps
// exactly the upstream UI. Neither reaches into T3's React tree: the entry is
// a pin outside T3's scrolling settings list, built from its own row attributes so it matches whatever T3's styles are, and put back if T3 redraws the
// sidebar without it. Whether this browser is paired is T3's answer
// (/api/auth/session), not a guess from the path: T3 serves its app and its
// pairing screen at the same "/".
//
// Keep this file self-contained: it is inlined into an HTML script tag, so it
// must never contain a closing script tag sequence. The pure helpers at the
// top are what tests/t3-client.test.mjs loads, where there is no document.
(() => {
  'use strict';

  // ----------------------------------------------------------------- pure --
  // Where the console may answer: the documented route, then a shorter one.
  const PROBE_PATHS = ['/__setup/', '/setup/'];

  /** Whether a path is one of T3 Code's settings pages. */
  const isSettingsPath = (pathname) => /^\/settings(?:\/|$)/.test(String(pathname));

  /** Host layout is independent of the console frame's density. */
  const embedUrl = (base, theme, route, layout) =>
    base + '?embed=t3&host=tab&layout=' + (layout === 'wide' ? 'wide' : 'compact')
      + '&theme=' + (theme === 'dark' ? 'dark' : 'light') + '#' + (route || 'overview');

  const layoutFor = width => width >= 768 ? 'wide' : 'compact';
  const settingsPath = path => typeof path === 'string' && /^\/settings\/[a-z0-9-]+$/.test(path);
  const routeKey = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
  const boundedText = (value, max = 200) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  const safeCount = value => Number.isSafeInteger(value) && value >= 0;
  // Data, never executable SVG markup. Rechecked at the consuming boundary.
  const readIconNodes = nodes => {
    if (!Array.isArray(nodes) || !nodes.length || nodes.length > 128) return null;
    const tags = new Set(['path','circle','rect','line','polyline','polygon','ellipse']);
    const attrs = new Set(['d','cx','cy','r','rx','ry','x','y','x1','x2','y1','y2','width','height','points','fill']);
    const result = [];
    for (const node of nodes) {
      if (!Array.isArray(node) || node.length !== 2 || !tags.has(node[0]) || !node[1] || typeof node[1] !== 'object' || Array.isArray(node[1])) return null;
      const picked = {};
      for (const [name,value] of Object.entries(node[1])) {
        if (!attrs.has(name) || typeof value !== 'string' || !/^[-0-9a-zA-Z .,]{1,2000}$/.test(value) || name === 'fill' && value !== 'none' && value !== 'currentColor') return null;
        picked[name] = value;
      }
      result.push([node[0],picked]);
    }
    return result;
  };
  const readIcons = icons => {
    if (!icons || typeof icons !== 'object' || Array.isArray(icons) || Object.keys(icons).length > 100) return null;
    const result = Object.create(null);
    for (const [name,nodes] of Object.entries(icons)) {
      if (!routeKey(name)) return null;
      const safe = readIconNodes(nodes); if (!safe) return null;
      result[name] = safe;
    }
    return result;
  };
  const readNav = body => {
    if (!body || !Array.isArray(body.groups) || body.groups.length > 20 || !safeCount(body.attention)) return null;
    const seen = new Set(), groups = [];
    for (const group of body.groups) {
      if (!group || !routeKey(group.id) || (group.label !== null && !boundedText(group.label)) || !Array.isArray(group.pages) || !group.pages.length || group.pages.length > 50 || groups.some(g=>g.id===group.id)) return null;
      const pages = [];
      for (const page of group.pages) {
        if (!page || !routeKey(page.route) || seen.has(page.route) || !boundedText(page.title) || !page.title || !routeKey(page.icon) || seen.size >= 100) return null;
        seen.add(page.route);
        let badge = null;
        if (page.badge != null) {
          const b = page.badge;
          if (!['warn','count','live','running'].includes(b.kind) || !safeCount(b.count) || !boundedText(b.label) || !b.label) return null;
          badge = { kind:b.kind, count:b.count, label:b.label };
        }
        pages.push({route:page.route,title:page.title,icon:page.icon,badge});
      }
      groups.push({id:group.id,label:group.label||'',pages});
    }
    const status = body.status;
    if (!status || typeof status.ok !== 'boolean' || !boundedText(status.text) || !boundedText(status.version)) return null;
    if (body.current !== null && (!routeKey(body.current) || !seen.has(body.current))) return null;
    return {current:body.current,groups,status:{ok:status.ok,text:status.text,version:status.version},attention:body.attention};
  };
  const readPalette = (items, nav) => {
    if (!Array.isArray(items) || !items.length || items.length > 101) return null;
    const ids = new Set(), routes = new Set(nav.groups.flatMap(g=>g.pages.map(p=>p.route)));
    const result = [];
    for (const item of items) {
      if (!item || !routeKey(item.id) || ids.has(item.id) || item.route !== null && !routes.has(item.route) || !boundedText(item.title) || !boundedText(item.meta,500) || !routeKey(item.icon) || !Array.isArray(item.terms) || item.terms.length > 25 || !item.terms.every(t=>boundedText(t))) return null;
      if (item.hash !== undefined && (typeof item.hash !== 'string' || item.hash.length > 100 || !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*){1,2}$/.test(item.hash) || item.hash.split('/')[0] !== item.route)) return null;
      ids.add(item.id); result.push({id:item.id,route:item.route,...(item.hash ? {hash:item.hash} : {}),title:item.title,meta:item.meta,icon:item.icon,terms:[...item.terms]});
    }
    return result;
  };
  const navDiff = (prev, next) => {
    const a = prev?.groups.flatMap(g=>g.pages.map(p=>p.route)) || [], b = next.groups.flatMap(g=>g.pages.map(p=>p.route));
    return {added:b.filter(r=>!a.includes(r)),removed:a.filter(r=>!b.includes(r)),order:b};
  };

  const readHello = body => {
    if (!body || body.service !== 't3-setup') return null;
    const result = {signedIn:body.signedIn === true,attention:safeCount(body.attention) ? body.attention : 0};
    if (result.signedIn && body.protocol === 2) {
      const nav = readNav(body.nav), icons = readIcons(body.icons);
      const palette = nav && readPalette(body.palette,nav);
      if (nav && icons && palette && nav.groups.every(g=>g.pages.every(p=>Object.hasOwn(icons,p.icon)))) Object.assign(result,{protocol:2,nav,icons,palette});
    }
    return result;
  };

  /** The count beside Setup: nothing at zero, and never more than two digits. */
  const badgeText = (count) => (count > 99 ? '99+' : count > 0 ? String(count) : '');

  /** How the entry reads to a screen reader, count included. */
  const entryLabel = (count) => (count > 0
    ? 'Setup, ' + count + (count === 1 ? ' thing needs' : ' things need') + ' you'
    : 'Setup');

  /** A message from the console in our pane, not from another frame or origin. */
  const fromConsole = (event, frame, origin) => Boolean(frame
    && event.source === frame.contentWindow
    && event.origin === origin
    && event.data && event.data.source === 't3-setup' && typeof event.data.type === 'string');

  // Setup's commands in T3's command palette, searched the way T3 searches its
  // own: each by what its row shows (its title, and the line under it), a
  // page's title with Setup's name, and its `terms`, a few names it goes by.
  const PALETTE_ITEMS = [
    { id: 'setup', route: null, title: 'Open setup', meta: 'Agents, skills, toolchains, source control, ports, devices and updates on this server', terms: ['setup console'] },
    { id: 'overview', route: 'overview', title: 'Overview', meta: 'Setup · progress, and anything that needs you', terms: [] },
    { id: 'files', route: 'files', title: 'Files', meta: 'Setup · projects, the home folder and disk use', terms: ['upload download', 'workspace'] },
    { id: 'storage', route: 'storage', title: 'Storage', meta: 'Setup · disk space, caches and old versions', terms: ['disk', 'cache'] },
    { id: 'server', route: 'server', title: 'Server', meta: 'Setup · T3 Code, this container and Setup itself', terms: ['environment', 'configuration'] },
    { id: 'agents', route: 'agents', title: 'Agents', meta: 'Setup · sign in, install and update', terms: [] },
    { id: 'context', route: 'instructions', title: 'Instructions & skills', meta: 'Setup · global AGENTS.md and skills', terms: ['agents.md global instructions', 'context', 'skills'] },
    { id: 'mcp', route: 'mcp', title: 'MCP servers', meta: 'Setup · shared definitions and provider configuration', terms: ['mcp tools servers'] },
    { id: 'credentials', route: 'credentials', title: 'Credentials', meta: 'Setup · SSH and API logins agents use by name', terms: ['ssh', 'api key', 'token', 'password', 'secret', 'server credentials'] },
    { id: 'pair', route: 'access', title: 'Pair a device', meta: 'Setup · Access', terms: ['devices', 'pairing'] },
    { id: 'toolchains', route: 'toolchains', title: 'Toolchains', meta: 'Setup · Go, Rust, Bun, Deno, uv and any mise tool', terms: [] },
    { id: 'sourcecontrol', route: 'sourcecontrol', title: 'Source control', meta: 'Setup · sign in to GitHub, GitLab, Forgejo, Gitea and Azure DevOps', terms: ['codeberg', 'gh glab fj tea az'] },
    { id: 'ports', route: 'ports', title: 'Ports', meta: 'Setup · publish a dev server', terms: [] },
    { id: 'updates', route: 'updates', title: 'Updates', meta: 'Setup · T3 Code, agents and tools, automatic updates', terms: ['upgrade'] },
  ];

  /** T3's own search normalisation: no accents, lower case, single spaces. */
  const searchText = (text) => String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

  /**
   * How well one search term answers a search, as T3 scores its own: all of
   * the search's words must be in it, and it is the whole search (3), starts
   * with it (2), has it somewhere (1), or only has its words (0).
   */
  const termScore = (term, query, words) => {
    const text = searchText(term);
    if (!text || !words.every((word) => text.includes(word))) return null;
    return text === query ? 3 : text.startsWith(query) ? 2 : text.includes(query) ? 1 : 0;
  };

  /**
   * Setup's commands for a palette search, best first, matched and ranked as
   * T3 matches and ranks its own: every word of the search somewhere in an
   * item's terms, and the earliest term that has them all deciding its place.
   * A leading ">" (T3's commands only) still finds them: they are commands.
   */
  const paletteMatches = (raw, items = PALETTE_ITEMS) => {
    const query = searchText(String(raw || '').replace(/^\s*>/, ''));
    if (!query) return [];
    const words = query.split(' ');
    return items
      .map((item, index) => {
        // A page's title also goes by Setup's name with it ("setup ports"); an
        // item's own names come before the line under it, which mentions others.
        const terms = [item.title, ...(item.route ? ['Setup ' + item.title] : []), ...item.terms, item.meta];
        if (!words.every((word) => searchText(terms.join(' ')).includes(word))) return null;
        const at = terms.findIndex((term) => termScore(term, query, words) !== null);
        return { item, index, rank: at === -1 ? 0 : 1000 - at * 100 + termScore(terms[at], query, words) };
      })
      .filter(Boolean)
      .sort((a, b) => b.rank - a.rank || a.index - b.index)
      .map((found) => found.item);
  };

  /**
   * Where an arrow key takes the highlight in the palette, over T3's rows
   * (`theirs` of them) with Setup's (`ours`) among them after the first
   * `before` of T3's: one list, wrapping at both ends as T3's does. `own` is
   * Setup's highlighted row, or -1 while T3's are in charge; `at` is T3's
   * active row, or -1 before T3 has one (a fresh search: T3's first arrow key
   * then lights its first row or its last). T3 keeps its own highlight where
   * it was while Setup has it, and can only be moved a row at a time, so
   * leaving Setup's rows passes T3 the key unless its highlight is already
   * where the person is going. Returns the new `own`, and whether T3 should
   * get the key too.
   */
  const paletteStep = ({ key, own, ours, theirs, at, before = 0 }) => {
    const split = Math.min(Math.max(before, 0), theirs);
    if (key === 'ArrowDown') {
      if (own >= 0 && own < ours - 1) return { own: own + 1, pass: false };
      if (own >= 0) {
        if (!theirs) return { own: 0, pass: false };
        // Off Setup's last row onto T3's next, or round to T3's first.
        return { own: -1, pass: split < theirs ? at !== split : true };
      }
      // Onto Setup's first row: from T3's row above it, or, when Setup's rows
      // are at the top, from nothing or round from T3's last.
      if (!theirs || (split > 0 ? at === split - 1 : at === -1 || at === theirs - 1)) return { own: 0, pass: false };
      return { own: -1, pass: true };
    }
    if (key === 'ArrowUp') {
      if (own > 0) return { own: own - 1, pass: false };
      if (own === 0) {
        if (!theirs) return { own: ours - 1, pass: false };
        // Off Setup's first row onto T3's row above, or round to T3's last.
        return { own: -1, pass: split > 0 ? at !== split - 1 : true };
      }
      // Onto Setup's last row: from T3's row below it, or, when Setup's rows
      // are at the bottom, from nothing or round from T3's first.
      if (!theirs || (split < theirs ? at === split : at === -1 || at === 0)) return { own: ours - 1, pass: false };
      return { own: -1, pass: true };
    }
    return { own, pass: true };
  };

  /**
   * Whether Setup starts with the palette highlight. It does when no row of
   * T3's comes before its group, except in T3's virtualized list, where its
   * group cannot be placed after the Actions rows inside the scroller: there
   * an Actions heading among T3's results leaves Enter with T3's first row.
   */
  const paletteOwnsFirst = ({ before = 0, virtualActions = false } = {}) => before === 0 && !virtualActions;

  /** T3 tracks its own visual selection; primitive hover/ARIA may name an unpainted row. */
  const paletteActiveIndex = (rows) => {
    const marked = rows.findIndex((row) => row.hasAttribute('data-active') && row.getAttribute('data-active') !== 'false');
    if (marked >= 0) return marked;
    return rows.findIndex((row) => /(^|\s)bg-\S+!(\s|$)/.test(row.className));
  };

  // The wire format uses native names. The console maps these roles onto its
  // own components and accepts only supported literal colors and font lists.
  const APPEARANCE_COLORS = ['background', 'card', 'popover', 'muted', 'foreground', 'muted-foreground',
    'placeholder', 'border', 'input', 'primary', 'primary-foreground', 'update-foreground', 'ring', 'accent',
    'sidebar', 'sidebar-foreground', 'sidebar-muted-foreground', 'sidebar-border', 'sidebar-row-hover',
    'sidebar-row-active', 'sidebar-row-selected', 'sidebar-control-surface', 'warning', 'warning-foreground',
    'warning-surface', 'destructive', 'destructive-foreground', 'error-surface', 'success', 'success-foreground',
    'info', 'info-foreground'];
  // These are the adjusted roles used by native index.css's @theme mapping.
  // Primary and semantic feedback colors intentionally stay unadjusted.
  const APPEARANCE_CONTRAST = new Set(['foreground', 'muted-foreground', 'placeholder', 'border', 'input',
    'sidebar-foreground', 'sidebar-muted-foreground', 'sidebar-border']);
  const appearanceFromStyles = (styles) => {
    const read = name => styles.getPropertyValue('--' + name).trim();
    const colors = {};
    for (const name of APPEARANCE_COLORS) {
      const value = (APPEARANCE_CONTRAST.has(name) && read('contrast-' + name)) || read(name);
      if (value) colors[name] = value;
    }
    return { version: 1, colors, fonts: { sans: read('font-sans'), mono: read('font-mono'), smoothing: styles.getPropertyValue('-webkit-font-smoothing').trim() },
      fontSize: styles.fontSize, radius: read('control-radius') };
  };

  if (typeof document === 'undefined') {
    globalThis.T3SetupBridge = {
      PROBE_PATHS, isSettingsPath, embedUrl, readHello, badgeText, entryLabel, fromConsole,
      PALETTE_ITEMS, paletteMatches, paletteStep, paletteOwnsFirst, paletteActiveIndex,
      APPEARANCE_COLORS, appearanceFromStyles, layoutFor, settingsPath, readNav, readIcons, readIconNodes, readPalette, navDiff,
    };
    return;
  }

  // ---------------------------------------------------------------- state --
  const state = {
    base: null,        // where the console answered, such as '/__setup/'
    paired: null,      // whether T3 Code has a session for this browser (null: not known)
    attention: 0,      // what needs the person, from the console
    checkedAt: 0,      // when the console was last asked for that count
    path: location.pathname,
    tab: null,         // one pane, never reparented during resize
    nav: null, icons: Object.create(null), paletteItems: PALETTE_ITEMS, pendingRoute: null,
  };
  const ENTRY = 'data-t3-setup-entry';
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

  // --------------------------------------------------------------- styles --
  // T3's own custom properties first, so the pin and pane follow its
  // theme, including a custom one; the fallbacks are its default palette.
  const CSS = [
    // The pill: first contact, before pairing.
    '.t3-setup-pill{position:fixed;left:calc(14px + env(safe-area-inset-left,0px));bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147483646;',
    'display:inline-flex;align-items:center;gap:7px;padding:7px 12px 7px 10px;border-radius:999px;',
    'border:1px solid rgba(0,0,0,.14);background:rgba(255,255,255,.92);color:#262626;',
    'font:500 12px/1.1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;text-decoration:none;',
    'box-shadow:0 2px 10px rgba(0,0,0,.14);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}',
    '.t3-setup-pill:hover{border-color:rgba(0,0,0,.3);color:#000;}',
    'html.dark .t3-setup-pill{background:rgba(23,23,23,.9);color:#f5f5f5;border-color:rgba(255,255,255,.16);}',
    'html.dark .t3-setup-pill:hover{border-color:rgba(255,255,255,.36);color:#fff;}',
    '.t3-setup-pill svg{width:13px;height:13px;flex:none;}',
    '.t3-setup-badge{margin-left:auto;flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:999px;',
    'display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;line-height:1;',
    'font-variant-numeric:tabular-nums;color:var(--warning-foreground,#b45309);',
    'background:var(--warning-surface,rgba(245,158,11,.12));}',
    '.t3-setup-badge[hidden]{display:none;}',
    '.t3-setup-frame{display:block;flex:1;min-width:0;height:100%;border:0;background:transparent;color-scheme:normal;',
    'opacity:0;transition:opacity .15s ease-out;}',
    // A spinner, only if loading takes long enough to notice.
    '.t3-setup-loading{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;',
    'opacity:0;animation:t3-setup-show .2s .3s forwards;}',
    '.t3-setup-loading::after{content:"";width:18px;height:18px;border-radius:50%;',
    'border:2px solid color-mix(in srgb,var(--foreground,#262626) 14%,transparent);',
    'border-top-color:var(--muted-foreground,#71717a);animation:t3-setup-spin .8s linear infinite;}',
    '@keyframes t3-setup-show{to{opacity:1}}',
    // Setup's rows in T3's command palette, highlighted as T3 highlights its
    // own; while one of them is, T3's highlighted row is drawn plain.
    '.t3-setup-cmd-text{display:flex;flex-direction:column;min-width:0;flex:1;line-height:1.3;}',
    '.t3-setup-cmd-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.t3-setup-cmd-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted-foreground,#71717a);}',
    '.t3-setup-cmd{display:flex;align-items:center;gap:8px;min-width:0;}',
    '.t3-setup-cmd>.t3-setup-cmd-icon{display:block;width:16px;height:16px;min-width:16px;max-width:16px;min-height:16px;max-height:16px;flex:none;color:var(--muted-foreground,#71717a);}',
    '.t3-setup-cmd--plain{display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 8px;border-radius:calc(var(--radius,.625rem) - 4px);cursor:pointer;font-size:14px;}',
    '.t3-setup-cmd-label{padding:6px 8px;font-size:12px;font-weight:500;color:var(--muted-foreground,#71717a);}',
    '.t3-setup-cmd-host{padding:8px;}',
    '[data-t3-setup-item][data-highlighted]{background-color:var(--accent,#f4f4f5)!important;color:var(--accent-foreground,inherit)!important;}',
    // T3 paints its active row with Tailwind's bg-accent!, an !important rule
    // in its utilities layer. Among !important rules the earliest layer wins,
    // so the plain-row rule goes in T3's own earlier base layer as well as
    // unlayered (which wins should T3 ever drop layers).
    '[data-t3-setup-owns] [data-slot="command-item"]:not([data-t3-setup-item]){background-color:transparent!important;color:inherit!important;}',
    '@layer base{[data-t3-setup-owns] [data-slot="command-item"]:not([data-t3-setup-item]){background-color:transparent!important;color:inherit!important;}}',
    '[data-t3-setup-empty]>:not([data-t3-setup-host]){display:none!important;}',
    '@media (prefers-reduced-motion:reduce){.t3-setup-frame{transition:none;}',
    '.t3-setup-loading::after{animation-duration:2.4s;}}',
  ].join('') + `
/* Setup as a native Settings tab. Native custom properties keep the host
   in step with built-in and custom themes. Row geometry is borrowed from
   native page-row attributes; these rules style only Setup-owned elements. */

/* ---------------------------------------------------------------- the pin */
/* Pinned between T3's list (the ScrollArea holding [data-sidebar=content]) and
   T3's footer, so it is in view however far the list scrolls. */
.t3-setup-pin {
  container: t3-setup-pin / inline-size;
  flex: none;
  padding: var(--sidebar-content-inset, 0.5rem);
  border-top: 1px solid var(--sidebar-border, rgba(0, 0, 0, 0.08));
  background: var(--sidebar, #fafafa);
}
.t3-setup-pin > ul { margin: 0; }
.t3-setup-pin [data-sidebar="menu-button"] { position: relative; }
.t3-setup-chev {
  width: 14px; height: 14px; flex: none; margin-left: 2px;
  color: color-mix(in srgb, var(--sidebar-muted-foreground, #71717a) 80%, transparent);
}
.t3-setup-badge:not([hidden]) + .t3-setup-chev { margin-left: 6px; }
/* The rail (T3's nav is 56px below md): icon only, a dot for the count. */
.t3-setup-dot {
  display: none; position: absolute; top: 5px; right: 8px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--warning, #f59e0b); box-shadow: 0 0 0 2px var(--sidebar, #fafafa);
}
/* An element can't query its own container: these style the pin's children.
   No safe-area padding here: T3's dialog already has max-sm:pb-safe. */
@container t3-setup-pin (max-width: 80px) {
  .t3-setup-pin > ul { display: flex; justify-content: center; }
  .t3-setup-pin .t3-setup-badge, .t3-setup-pin .t3-setup-chev { display: none; }
  .t3-setup-pin .t3-setup-dot[data-on] { display: block; }
}

/* A tooltip, drawn as T3 draws its own: after a 600ms hover, and on focus on
   the rail, where it is the only visible label. */
.t3-setup-tip {
  position: fixed; z-index: 60; pointer-events: none; padding: 6px 10px; border-radius: calc(var(--radius, 0.625rem) - 4px);
  background: var(--foreground, #18181b); color: var(--background, #fff); font-size: 12px; line-height: 16px; white-space: nowrap;
  box-shadow: 0 16px 40px -18px rgb(0 0 0 / 0.55);
}
.t3-setup-tip small { display: block; font-size: 11px; opacity: 0.7; }

/* ------------------------------------------------------ Setup's nav (wide) */
/* Over T3's whole settings nav, which the bridge marks data-t3-setup-host so
   it positions this. T3's own children are inert underneath. */
nav[data-t3-setup-host] { position: relative; }
.t3-setup-nav {
  position: absolute; inset: 0; z-index: 40;
  display: flex; flex-direction: column; gap: 0.5rem; padding: var(--sidebar-content-inset, 0.5rem); min-height: 0;
  background: var(--sidebar, #fafafa); color: var(--sidebar-foreground, #18181b);
  transition: opacity 0.15s ease-out, translate 0.15s ease-out;
}
.t3-setup-nav[data-state="opening"], .t3-setup-nav[data-state="closing"] { opacity: 0; translate: 8px 0; }
.t3-setup-back { flex: none; color: var(--sidebar-muted-foreground, #71717a); }
.t3-setup-back:hover { color: var(--sidebar-foreground, #18181b); }

.t3-setup-title {
  flex: none; display: flex; align-items: center; gap: 10px;
  margin: 0 -0.5rem 2px; padding: 6px 1rem 10px;
  border-bottom: 1px solid var(--sidebar-border, rgba(0, 0, 0, 0.08));
}
.t3-setup-tile {
  width: 32px; height: 32px; flex: none; display: grid; place-items: center;
  border-radius: calc(var(--radius, 0.625rem) - 2px); border: 1px solid var(--border, #e4e4e7);
  background: var(--card, #fff); color: var(--foreground, #18181b); box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
}
.t3-setup-tile > svg { width: 16px; height: 16px; }
.t3-setup-title > div { display: flex; flex-direction: column; min-width: 0; }
.t3-setup-title strong { font-size: 15px; line-height: 20px; font-weight: 600; letter-spacing: -0.005em; }
.t3-setup-title span { font-size: 12px; line-height: 16px; color: var(--muted-foreground, #71717a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Only the pages scroll; a fade says there is more below. */
.t3-setup-groups { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 1rem; padding-top: 6px; }
.t3-setup-groups[data-overflow] {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
}
.t3-setup-group { display: flex; flex-direction: column; gap: 0.25rem; }
.t3-setup-group > ul { margin: 0; }
.t3-setup-row-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Badges: the warning count is the existing .t3-setup-badge. */
.t3-setup-badge--info { color: var(--info-foreground, #1d4ed8); background: color-mix(in srgb, var(--info, #3b82f6) 12%, transparent); }
.t3-setup-mark { margin-left: auto; flex: none; width: 1rem; height: 1rem; display: inline-grid; place-items: center; }
.t3-setup-mark::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--info, #3b82f6); }
.t3-setup-mark--live::before { box-shadow: 0 0 0 3px color-mix(in srgb, var(--info, #3b82f6) 18%, transparent); }
.t3-setup-mark--running::before {
  width: 10px; height: 10px; background: none; border: 1.5px solid var(--info, #3b82f6); border-right-color: transparent;
  animation: t3-setup-spin 0.75s linear infinite;
}

.t3-setup-foot { flex: none; display: flex; flex-direction: column; gap: 0.25rem; }
.t3-setup-server {
  display: flex; flex-direction: column; gap: 2px; margin-bottom: 0.25rem; padding: 0.375rem 0.625rem;
  border-radius: calc(var(--radius, 0.625rem)); border: 1px solid color-mix(in srgb, var(--border, #e4e4e7) 80%, transparent);
  background: color-mix(in srgb, var(--card, #fff) 50%, transparent);
  font-size: 12px; line-height: 16px; color: var(--sidebar-muted-foreground, #71717a);
}
.t3-setup-server-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.t3-setup-server-row strong { font-weight: 500; color: var(--foreground, #18181b); }
.t3-setup-server-version { font-family: var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
.t3-setup-status { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--success, #16a34a); }
.t3-setup-status[data-tone="danger"] { background: var(--destructive, #dc2626); }

/* One scrim over the nav while the console has a dialog open over its frame;
   the console draws the rest. */
.t3-setup-scrim {
  position: absolute; inset: 0; z-index: 3;
  background: color-mix(in srgb, var(--background, #fff) 60%, transparent);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  transition: opacity 0.15s ease-out;
}
html.dark .t3-setup-scrim { background: color-mix(in srgb, var(--background, #0a0a0a) 64%, transparent); }
.t3-setup-scrim[data-state="opening"], .t3-setup-scrim[data-state="closing"] { opacity: 0; }

/* ------------------------------------------------------------- the pane */
/* Mounted once in the settings body (the nav's parent, already relative) and
   never moved: re-inserting an iframe reloads it. Wide: its inline start is the
   nav's measured width, so it covers T3's content column (header and page).
   Compact: over the whole body, rail included. z-index 40 keeps it above what
   T3 positions inside its pages (z-20, z-30 on Appearance). */
.t3-setup-pane {
  position: absolute; inset: 0; z-index: 40; display: flex; min-width: 0; min-height: 0;
  background: var(--background, #fff);
}
.t3-setup-pane[data-layout="wide"] { inset-inline-start: var(--t3-setup-nav-w, 15rem); }
.t3-setup-pane > .t3-setup-frame { flex: 1; width: 100%; height: 100%; }
.t3-setup-pane[data-ready] > .t3-setup-frame { opacity: 1; }
.t3-setup-pane[data-ready] > .t3-setup-loading { display: none; }
.t3-setup-load-error { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; color: var(--foreground); background: var(--background); font-size: 14px; }
.t3-setup-load-error p { max-width: 32ch; color: var(--muted-foreground); }
.t3-setup-load-error > div { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.t3-setup-load-error button, .t3-setup-load-error a { border: 1px solid var(--border); border-radius: var(--control-radius, 6px); padding: 8px 12px; color: inherit; background: var(--card); cursor: pointer; }

@keyframes t3-setup-spin { to { rotate: 360deg; } }
@media (prefers-reduced-motion: reduce) {
  .t3-setup-nav, .t3-setup-scrim, .t3-setup-pane > .t3-setup-frame { transition: none; }
  .t3-setup-nav[data-state] { opacity: 1; translate: none; }
  .t3-setup-mark--running::before, .t3-setup-loading, .t3-setup-loading::after { animation: none; }
  .t3-setup-loading { opacity: 1; }
}
`;

  const addStyles = () => {
    if (document.getElementById('t3-setup-style')) return;
    const style = document.createElement('style');
    style.id = 't3-setup-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  };

  // Lucide's icons, as T3 draws its own: settings for the pill, server-cog for the entry.
  const SETTINGS_ICON = '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0'
    + 'l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51'
    + 'a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08'
    + 'a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18'
    + 'a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39'
    + 'a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09'
    + 'a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25'
    + 'a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>';
  const SERVER_COG_ICON = '<path d="m10.852 14.772-.383.923"/><path d="M13.148 14.772a3 3 0 1 0-2.296-5.544l-.383-.923"/>'
    + '<path d="m13.148 9.228.383-.923"/><path d="m13.53 15.696-.382-.924a3 3 0 1 1-2.296-5.544"/>'
    + '<path d="m14.772 10.852.923-.383"/><path d="m14.772 13.148.923.383"/>'
    + '<path d="M4.5 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5"/>'
    + '<path d="M4.5 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-.5"/>'
    + '<path d="M6 18h.01"/><path d="M6 6h.01"/><path d="m9.228 10.852-.923-.383"/><path d="m9.228 13.148-.923.383"/>';

  // ------------------------------------------------------------- questions --
  const getJson = async (path) => {
    const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) return null;
    return res.json();
  };

  /**
   * Ask the console where it is and how much needs the person. T3 answers an
   * unknown path with its HTML shell, which is not the console.
   */
  const hello = async () => {
    for (const path of state.base ? [state.base] : PROBE_PATHS) {
      try {
        const answer = readHello(await getJson(path + 'hello'));
        if (answer) {
          state.base = path;
          return answer;
        }
      } catch {
        // Not here.
      }
    }
    return null;
  };

  /** Whether T3 Code has a session for this browser, as T3 says (null: it did not say). */
  const pairedWithT3 = async () => {
    try {
      const body = await getJson('/api/auth/session');
      return body && typeof body.authenticated === 'boolean' ? body.authenticated : null;
    } catch {
      return null;
    }
  };

  const refreshPaired = async () => {
    const paired = await pairedWithT3();
    const previous = state.paired;
    if (paired !== null) state.paired = paired;
    // Pairing can finish in the same document that received anonymous hello.
    // Do not keep its missing registry until the attention cache expires.
    if (paired === true && previous !== true) await refreshAttention(true);
    if (paired === false) {
      state.nav = null; state.icons = Object.create(null); state.paletteItems = PALETTE_ITEMS; state.attention = 0;
      if (state.tab) closeTab(false);
    }
    schedule();
    schedulePalette();
  };

  /** The count beside Setup, asked again at most every half minute unless forced. */
  const refreshAttention = async (force) => {
    if (!state.base || (!force && Date.now() - state.checkedAt < 30000)) return;
    state.checkedAt = Date.now();
    const answer = await hello();
    if (!answer) return;
    state.attention = answer.signedIn ? answer.attention : 0;
    if(answer.nav&&!state.tab){state.nav=answer.nav;state.icons=answer.icons;state.paletteItems=answer.palette;}
    syncBadges();
  };

  // ----------------------------------------------------------------- pill --
  const pill = () => document.querySelector('.t3-setup-pill');

  const showPill = () => {
    if (pill()) return;
    const link = document.createElement('a');
    link.className = 't3-setup-pill';
    link.href = state.base;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = 'Pair a device or manage this server';
    link.setAttribute('aria-label', 'Open the T3 Code setup console');
    link.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + SETTINGS_ICON + '</svg><span>Setup</span>';
    document.body.appendChild(link);
  };

  // ------------------------------------------------ native Settings host --
  const theme = () => document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  const appearance = () => appearanceFromStyles(getComputedStyle(document.documentElement));
  const toConsole = (frame,message) => frame.contentWindow?.postMessage({source:'t3-code',...message},location.origin);
  const node = (tag,attrs = {},text) => {
    const result = document.createElement(tag);
    for (const [key,value] of Object.entries(attrs)) if(value != null) result.setAttribute(key,String(value));
    if(text != null) result.textContent = text;
    return result;
  };
  const setAttr = (element,key,value) => {
    if(value == null) {if(element.hasAttribute(key)) element.removeAttribute(key);}
    else if(element.getAttribute(key) !== String(value)) element.setAttribute(key,String(value));
  };
  const svg = (name,classes = '') => {
    const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
    for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:classes,width:'16',height:'16'})) icon.setAttribute(key,value);
    const nodes = readIconNodes(state.icons[name]);
    if(nodes) for(const [tag,attrs] of nodes) {
      const shape = document.createElementNS('http://www.w3.org/2000/svg',tag);
      for(const [key,value] of Object.entries(attrs)) shape.setAttribute(key,value);
      icon.appendChild(shape);
    } else {
      // Only this fixed, source-controlled fallback may be parsed as markup.
      icon.innerHTML = name === 'chevron-left' ? '<path d="m15 18-6-6 6-6"/>' : name === 'chevron-right' ? '<path d="m9 18 6-6-6-6"/>' : name === 'external-link' ? '<path d="M15 3h6v6M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>' : SERVER_COG_ICON;
    }
    return icon;
  };
  const rowTemplates = new WeakMap();
  const settingsHost = () => {
    const nav = document.querySelector('nav[data-workspace-area="settings-nav"]') || document.querySelector('nav[aria-label="Settings sections"]');
    if(!nav) return null;
    const content = nav.parentElement?.querySelector('[data-workspace-area="settings"]');
    const found = nav.querySelector('[data-sidebar="content"] [data-settings-section]')
      || nav.querySelector('[data-sidebar="content"] [role="tree"] [role="treeitem"]');
    if(found)rowTemplates.set(nav,found);
    const source = found || rowTemplates.get(nav);
    const scroll = [...nav.children].find(child=>child.querySelector('[data-sidebar="content"]') || child.matches('[data-sidebar="content"]'));
    if(!content || !source || !scroll || !nav.parentElement.contains(content)
      || !content.querySelector('header button[aria-label="Close"]')) return null;
    return {nav,content,source,scroll,body:nav.parentElement};
  };
  const sourceAttrs = source => Object.fromEntries([...source.attributes].filter(a=>/^(class|data-sidebar|data-slot|data-size)$/.test(a.name)).map(a=>[a.name,a.value]));
  const row = (host,tag,title,mark) => {
    const result = node(tag,{...sourceAttrs(host.source),...(tag==='button'?{type:'button'}:{})});
    const sourceIcon = host.source.querySelector('svg');
    const iconClass = (sourceIcon?.getAttribute('class') || 'lucide').replace(/\blucide-[\w-]+/g,'').trim();
    result.append(svg(mark,iconClass),node('span',{class:host.source.querySelector('span')?.getAttribute('class')||''},title));
    return result;
  };
  const SESSION = 't3-setup-tab';
  const remember = route => {try{sessionStorage.setItem(SESSION,JSON.stringify({open:true,route}));}catch{/* Storage is optional. */}};
  const forget = () => {try{sessionStorage.removeItem(SESSION);}catch{/* Storage is optional. */}};
  const remembered = () => {
    try {const saved = JSON.parse(sessionStorage.getItem(SESSION)); return saved?.open===true && routeKey(saved.route)?saved.route:null;} catch{return null;}
  };
  let tooltip = null, tooltipTimer = null;
  const hideTip = () => {clearTimeout(tooltipTimer);tooltipTimer=null;tooltip?.remove();tooltip=null;for(const button of document.querySelectorAll('[aria-describedby="t3-setup-tip"]'))button.removeAttribute('aria-describedby');};
  const showTip = button => {
    hideTip(); if(!button.isConnected || state.tab) return;
    tooltip=node('div',{class:'t3-setup-tip',role:'tooltip',id:'t3-setup-tip'},'Setup');
    tooltip.append(node('small',{},'Agents, devices, files and updates on this server'));
    document.body.append(tooltip);
    const b=button.getBoundingClientRect(),t=tooltip.getBoundingClientRect();
    tooltip.style.left=Math.max(8,Math.min(b.right+8,innerWidth-t.width-8))+'px';
    tooltip.style.top=Math.max(8,Math.min(b.top,innerHeight-t.height-8))+'px';
    button.setAttribute('aria-describedby','t3-setup-tip');
  };
  const removeEntries = () => {hideTip();for(const pin of document.querySelectorAll('['+ENTRY+']'))pin.remove();};
  const ensureEntries = () => {
    const host=settingsHost();
    for(const pin of document.querySelectorAll('['+ENTRY+']')) if(pin.parentElement!==host?.nav) pin.remove();
    if(!host) {if(state.tab) closeTab(false);return;}
    if(state.tab && state.tab.host.nav !== host.nav)closeTab(false);
    if(!host.nav.querySelector(':scope > ['+ENTRY+']')) {
      const pin=node('div',{class:'t3-setup-pin',[ENTRY]:''});
      const menu=node('ul',{'data-sidebar':'menu',class:host.source.closest('ul')?.className||''});
      const item=node('li',{'data-sidebar':'menu-item',class:host.source.parentElement.className});
      const button=row(host,'button','Setup','server-cog');
      button.append(node('span',{class:'t3-setup-badge',hidden:''}),svg('chevron-right','t3-setup-chev'),node('span',{class:'t3-setup-dot','aria-hidden':'true'}));
      button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();openTab(button);});
      button.addEventListener('pointerenter',()=>{hideTip();tooltipTimer=setTimeout(()=>showTip(button),600);});
      button.addEventListener('pointerleave',hideTip);
      button.addEventListener('focus',()=>{if(host.nav.offsetWidth<=80)showTip(button);});
      button.addEventListener('blur',()=>{hideTip();button.removeAttribute('aria-describedby');});
      item.append(button);menu.append(item);pin.append(menu);host.scroll.after(pin);
    }
    if(state.tab){for(const child of host.content.children)mask(state.tab.masks,child);for(const child of host.nav.children)if(child!==state.tab.nav)mask(state.tab.masks,child);}
    syncBadges();
    if(!state.tab && (state.pendingRoute || isSettingsPath(location.pathname) && remembered())) {
      const route=state.pendingRoute||remembered();state.pendingRoute=null;
      openTab(host.nav.querySelector('['+ENTRY+'] button'),route);
    }
  };
  const syncBadges = () => {
    for(const pin of document.querySelectorAll('['+ENTRY+']')) {
      const badge=pin.querySelector('.t3-setup-badge'),text=badgeText(state.attention),button=pin.querySelector('button');
      if(badge.textContent!==text)badge.textContent=text;
      if(badge.hidden!==!text)badge.hidden=!text;
      setAttr(button,'aria-label',entryLabel(state.attention));setAttr(button,'data-active',Boolean(state.tab));
      setAttr(pin.querySelector('.t3-setup-dot'),'data-on',text?'':null);
    }
  };
  // Exact attribute restoration, including native nodes that were already inert.
  const mask = (map,element) => {
    if(!map.has(element))map.set(element,{inert:element.getAttribute('inert'),hidden:element.getAttribute('aria-hidden')});
    setAttr(element,'inert','');setAttr(element,'aria-hidden','true');
  };
  const unmask = map => {for(const [element,saved] of map){setAttr(element,'inert',saved.inert);setAttr(element,'aria-hidden',saved.hidden);}map.clear();};
  const updateOverflow = tab => {
    if(!tab.groups)return;
    const overflow=tab.groups.scrollHeight-tab.groups.clientHeight-tab.groups.scrollTop>2;
    setAttr(tab.groups,'data-overflow',overflow?'':null);
  };
  const paintBadge = (element,badge) => {
    const signature=JSON.stringify(badge);
    if(element.dataset.signature===signature)return;
    element.dataset.signature=signature;
    element.hidden=!badge;
    element.className=!badge?'t3-setup-badge':badge.kind==='warn'||badge.kind==='count'?'t3-setup-badge'+(badge.kind==='count'?' t3-setup-badge--info':''):'t3-setup-mark t3-setup-mark--'+badge.kind;
    element.textContent=badge&&(badge.kind==='warn'||badge.kind==='count')?badgeText(badge.count):'';
    setAttr(element,'aria-label',badge?.label);setAttr(element,'title',badge?.label);
  };
  const ordered = (parent,child,index) => {if(parent.children[index]!==child)parent.insertBefore(child,parent.children[index]||null);};
  const roving = (tab,active) => {for(const element of [tab.back,...tab.groups.querySelectorAll('a[data-route]'),tab.external])element.tabIndex=element===active?0:-1;};
  const paintNav = () => {
    const tab=state.tab,model=state.nav;
    if(!tab?.nav || !model)return;
    const focused=document.activeElement,wasFocused=tab.nav.contains(focused);
    const wanted=new Set();
    model.groups.forEach((group,index)=>{
      let entry=tab.groupNodes.get(group.id);
      if(!entry){
        const outer=node('div',{class:'t3-setup-group',role:'group'}),list=node('ul',{'data-sidebar':'menu',class:tab.host.source.closest('ul')?.className||''});
        const heading=node('h3',{class:tab.host.nav.querySelector('[role="group"] > h3')?.className||'text-xs text-muted-foreground px-2'});
        outer.append(heading,list);entry={outer,list,heading};tab.groupNodes.set(group.id,entry);
      }
      entry.heading.hidden=!group.label;
      if(entry.heading.textContent!==group.label)entry.heading.textContent=group.label;
      setAttr(entry.outer,'aria-label',group.label||null);ordered(tab.groups,entry.outer,index);
      group.pages.forEach((page,at)=>{
        wanted.add(page.route);
        let link=tab.rows.get(page.route);
        if(!link){
          link=row(tab.host,'a',page.title,page.icon);link.dataset.route=page.route;
          link.children[1].className='t3-setup-row-text';link.append(node('span',{class:'t3-setup-badge',hidden:''}));
          link.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;event.preventDefault();event.stopPropagation();toConsole(tab.frame,{type:'navigate',route:page.route});});
          link.addEventListener('focus',()=>roving(tab,link));tab.rows.set(page.route,link);
        }
        const iconSignature=page.icon+JSON.stringify(state.icons[page.icon]);
        if(link.dataset.icon!==iconSignature){link.replaceChild(svg(page.icon,tab.host.source.querySelector('svg')?.getAttribute('class')||''),link.firstElementChild);link.dataset.icon=iconSignature;}
        if(link.children[1].textContent!==page.title)link.children[1].textContent=page.title;
        setAttr(link,'title',page.title);setAttr(link,'href',state.base+'#'+page.route);
        setAttr(link,'aria-current',page.route===model.current?'page':null);setAttr(link,'data-active',page.route===model.current);
        paintBadge(link.lastElementChild,page.badge);
        let item=link.parentElement;
        if(!item){item=node('li',{'data-sidebar':'menu-item',class:tab.host.source.parentElement.className});item.append(link);}
        ordered(entry.list,item,at);
      });
    });
    for(const [route,link]of tab.rows)if(!wanted.has(route)){link.parentElement.remove();tab.rows.delete(route);}
    for(const [id,entry]of tab.groupNodes)if(!model.groups.some(g=>g.id===id)){entry.outer.remove();tab.groupNodes.delete(id);}
    setAttr(tab.external,'href',state.base+'#'+(model.current||tab.route));
    setAttr(tab.statusDot,'data-tone',model.status.ok?null:'danger');
    if(tab.statusText.textContent!==model.status.text)tab.statusText.textContent=model.status.text;
    if(tab.version.textContent!==model.status.version)tab.version.textContent=model.status.version;
    const active=tab.rows.get(model.current)||tab.groups.querySelector('a[data-route]')||tab.back;
    roving(tab,wasFocused&&focused.isConnected?focused:active);
    if(wasFocused&&!focused.isConnected)active.focus({preventScroll:true});
    updateOverflow(tab);
  };
  const drawNav = tab => {
    const nav=node('nav',{class:'t3-setup-nav','aria-label':'Setup pages','data-state':'opening'});
    tab.nav=nav;tab.rows=new Map();tab.groupNodes=new Map();
    tab.back=row(tab.host,'button','Settings','chevron-left');tab.back.classList.add('t3-setup-back');tab.back.setAttribute('aria-label','Back to Settings');
    tab.back.addEventListener('click',()=>closeTab(true));
    const title=node('div',{class:'t3-setup-title'}),tile=node('span',{class:'t3-setup-tile'}),text=node('div');
    tile.append(svg('server-cog'));text.append(node('strong',{},'Setup'),node('span',{title:location.host},location.host));title.append(tile,text);
    tab.groups=node('div',{class:'t3-setup-groups'});tab.groups.addEventListener('scroll',()=>updateOverflow(tab));
    tab.external=row(tab.host,'a','Open in a new tab','external-link');setAttr(tab.external,'target','_blank');setAttr(tab.external,'rel','noopener');
    const footer=node('div',{class:'t3-setup-foot'}),status=node('div',{class:'t3-setup-server'}),line=node('div',{class:'t3-setup-server-row'});
    tab.statusDot=node('span',{class:'t3-setup-status','aria-hidden':'true'});tab.statusText=node('strong');tab.version=node('div',{class:'t3-setup-server-version'});
    line.append(tab.statusDot,tab.statusText);status.append(line,tab.version);footer.append(status,tab.external);
    nav.append(tab.back,title,tab.groups,footer);tab.host.nav.append(nav);paintNav();
    tab.back.addEventListener('focus',()=>roving(tab,tab.back));tab.external.addEventListener('focus',()=>roving(tab,tab.external));
    nav.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      const items=[tab.back,...tab.groups.querySelectorAll('a[data-route]'),tab.external],at=items.indexOf(document.activeElement);
      const next=event.key==='ArrowDown'?items[(at+1)%items.length]:event.key==='ArrowUp'?items[(at-1+items.length)%items.length]:event.key==='Home'?items[0]:event.key==='End'?items.at(-1):null;
      if(next){event.preventDefault();roving(tab,next);next.focus();}
    });
    requestAnimationFrame(()=>{if(state.tab===tab)setAttr(nav,'data-state',null);});
    tab.resize.observe(tab.groups);
  };
  const paintLayer = () => {
    const tab=state.tab;if(!tab)return;
    unmask(tab.modalMasks);tab.scrim?.remove();tab.scrim=null;
    if(tab.modal && tab.nav){
      for(const child of tab.nav.children)mask(tab.modalMasks,child);
      tab.scrim=node('div',{class:'t3-setup-scrim','aria-hidden':'true'});tab.nav.append(tab.scrim);
    }
  };
  const paintLayout = () => {
    const tab=state.tab;if(!tab)return;
    const layout=tab.media.matches?'wide':'compact',focused=document.activeElement;
    tab.layout=layout;setAttr(tab.pane,'data-layout',layout);
    unmask(tab.modalMasks);unmask(tab.masks);
    if(layout==='wide'){
      setAttr(tab.host.nav,'data-t3-setup-host','');
      if(!tab.nav)drawNav(tab);
    }else if(tab.nav){
      tab.resize.unobserve(tab.groups);tab.nav.remove();tab.nav=null;tab.groups=null;
      if(focused?.closest('.t3-setup-nav'))tab.frame.focus();
    }
    for(const child of tab.host.content.children)mask(tab.masks,child);
    for(const child of tab.host.nav.children)if(child!==tab.nav)mask(tab.masks,child);
    tab.pane.style.setProperty('--t3-setup-nav-w',tab.host.nav.offsetWidth+'px');
    paintLayer();toConsole(tab.frame,{type:'host',layout});
  };
  const openTab = (trigger,route = 'overview') => {
    if(state.tab){toConsole(state.tab.frame,{type:'navigate',route});return;}
    if(!state.nav){window.open(state.base+'#'+route,'_blank','noopener');return;}
    const host=settingsHost();if(!host || !state.base)return;
    hideTip();
    const pane=node('div',{class:'t3-setup-pane',role:'region','aria-label':'Setup'}),frame=node('iframe',{class:'t3-setup-frame',title:'T3 Code setup',allow:'clipboard-read; clipboard-write'});
    const loading=node('div',{class:'t3-setup-loading','aria-hidden':'true'});
    const tab={host,pane,frame,trigger,route,nav:null,masks:new Map(),modalMasks:new Map(),modal:false,priorHost:host.nav.getAttribute('data-t3-setup-host'),media:matchMedia('(min-width: 768px)')};
    state.tab=tab;
    tab.loadTimer=setTimeout(()=>{
      if(state.tab!==tab||pane.hasAttribute('data-ready'))return;
      const failure=node('div',{class:'t3-setup-load-error',role:'status'});
      failure.append(node('strong',{},'Setup is taking longer than expected'),node('p',{},'You can try again or open the console in a new tab.'));
      const actions=node('div'),retry=node('button',{type:'button'},'Try again'),back=node('button',{type:'button'},'Back to Settings'),external=node('a',{href:state.base,target:'_blank',rel:'noopener'},'Open in a new tab');
      retry.addEventListener('click',()=>{const route=tab.route;closeTab(false);openTab(trigger,route);});back.addEventListener('click',()=>closeTab(true));
      actions.append(retry,back,external);failure.append(actions);pane.append(failure);loading.hidden=true;
    },12000);
    tab.resize=new ResizeObserver(()=>{if(state.tab===tab){const width=host.nav.offsetWidth+'px';if(pane.style.getPropertyValue('--t3-setup-nav-w')!==width)pane.style.setProperty('--t3-setup-nav-w',width);updateOverflow(tab);}});
    tab.resize.observe(host.nav);
    frame.src=embedUrl(state.base,theme(),route,tab.media.matches?'wide':'compact');
    pane.append(loading,frame);host.body.append(pane); // The iframe is mounted exactly once.
    tab.media.addEventListener('change',paintLayout);paintLayout();syncBadges();remember(route);
    const sendAppearance = () => {
      if(state.tab!==tab)return;
      const message={type:'theme',theme:theme(),appearance:appearance()},signature=JSON.stringify(message);
      if(signature!==tab.appearanceSignature){tab.appearanceSignature=signature;toConsole(frame,message);}
    };
    tab.themeWatch=new MutationObserver(sendAppearance);
    tab.themeWatch.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme-id']});
  };
  const closeTab = (focus = false) => {
    const tab=state.tab;if(!tab)return;
    state.tab=null;state.pendingRoute=null;forget();hideTip();
    clearTimeout(tab.loadTimer);tab.resize.disconnect();tab.themeWatch.disconnect();tab.media.removeEventListener('change',paintLayout);
    unmask(tab.modalMasks);unmask(tab.masks);setAttr(tab.host.nav,'data-t3-setup-host',tab.priorHost);
    tab.pane.remove();tab.nav?.remove();syncBadges();
    if(focus){const button=document.querySelector('['+ENTRY+'] button');button?.focus({preventScroll:true});}
  };
  const nativeClose = () => {
    const button=state.tab?.host.content.querySelector('header button[aria-label="Close"]');
    if(button)button.click();else closeTab(true);
  };
  const navigateNative = (path,route) => {
    if(!isSettingsPath(path))return;
    if(route){state.pendingRoute=route;remember(route);}
    history.pushState(null,'',path);window.dispatchEvent(new PopStateEvent('popstate'));
    // TanStack's listener normally mounts this in the next frame. A changed
    // native client that ignores popstate still has a usable, reload-safe path.
    setTimeout(()=>{
      if(!route || state.tab || settingsHost() || location.pathname!==path)return;
      if(document.querySelector('[data-app-modal][aria-label="Settings"]')) {
        state.pendingRoute=null;forget();location.assign(state.base+'#'+route);
      }else location.assign(path);
    },1500);
    schedule();
  };
  const acceptNavigation = (model,icons) => {
    // Preserve the authenticated hello snapshot while the child is connecting.
    // Its current page is authoritative even before the first status read.
    if(state.nav && !model.status.version && !model.status.ok)model={...state.nav,current:model.current};
    state.nav=model;state.icons=icons;state.attention=model.attention;state.checkedAt=Date.now();
    if(state.tab && model.current){state.tab.route=model.current;remember(model.current);}
    syncBadges();paintNav();
  };
  window.addEventListener('message',event=>{
    const tab=state.tab;if(!tab||!fromConsole(event,tab.frame,location.origin))return;
    const message=event.data;
    if(message.type==='ready'){
      clearTimeout(tab.loadTimer);tab.pane.querySelector('.t3-setup-load-error')?.remove();
      setAttr(tab.pane,'data-ready','');
      const appearanceMessage={type:'theme',theme:theme(),appearance:appearance()};tab.appearanceSignature=JSON.stringify(appearanceMessage);toConsole(tab.frame,appearanceMessage);
      toConsole(tab.frame,{type:'host',layout:tab.layout});
      if(tab.layout==='wide'&&tab.rows?.size)(tab.rows.get(tab.route)||tab.groups.querySelector('a[data-route]')).focus({preventScroll:true});else tab.frame.focus();
    }else if(message.type==='nav'){
      const model=readNav(message),icons=readIcons(message.icons);
      if(model&&icons&&model.groups.every(g=>g.pages.every(p=>Object.hasOwn(icons,p.icon))))acceptNavigation(model,icons);
    }else if(message.type==='attention'&&safeCount(message.count)){
      state.attention=message.count;syncBadges();
    }else if(message.type==='layer'&&typeof message.open==='boolean'){
      if(tab.modal!==message.open){tab.modal=message.open;paintLayer();}
    }else if(message.type==='back')closeTab(true);
    else if(message.type==='settings'&&settingsPath(message.path)){closeTab(false);navigateNative(message.path);}
    else if(message.type==='close')nativeClose();
  });

  // ------------------------------------------------------ command palette --
  // Setup's commands in T3's command palette (⌘K), as a group of their own
  // among T3's when a search finds them: commands, so after T3's Actions and
  // before its Projects, Settings and Threads, the order T3 keeps its own
  // groups in whatever the search. The palette is base-ui's Autocomplete,
  // which knows nothing of rows it did not draw, so Setup's keep their own
  // highlight: while one of them has it, they "own" it, T3's own highlighted
  // row is drawn plain, and Enter is theirs. A search starts it where T3
  // starts its own, on the first row, which is Setup's only when Setup's group
  // comes first. The arrow keys and the pointer move it between the two as
  // through one list (paletteStep).
  // Only on the palette's first page: T3's pages within it (the theme list,
  // say) say "Backspace Back" in their footer.
  const PALETTE = '[data-command-palette="true"]';
  const OWN_ROW = 'data-t3-setup-item';
  // `chosen`: the person has moved the highlight themselves since the search
  // changed, so where it is is theirs, not a default to keep recomputing.
  const palette = { dialog: null, input: null, items: [], own: -1, chosen: false, query: null, watch: null };


  const theirRows = () => (palette.dialog
    ? [...palette.dialog.querySelectorAll('[data-slot="command-item"]:not([' + OWN_ROW + '])')] : []);
  // T3's active row, as T3 draws it: with a forced background class (bg-accent!).
  // Before its first arrow key after a search it has none, though Enter would
  // still take its first row.
  const theirActive = (rows) => paletteActiveIndex(rows);
  const ourGroup = () => palette.dialog && palette.dialog.querySelector('[data-t3-setup-palette]');
  const subPage = () => {
    const footer = palette.dialog.querySelector('[data-slot="command-footer"]');
    return Boolean(footer && /Backspace/.test(footer.textContent));
  };

  // T3's classes for its groups and rows, kept from the last time some were
  // in view: a search T3 has nothing for, or only one-line rows, still draws
  // Setup's like T3's two-line rows (a title over "Settings · Project"). Before
  // any have been seen, Setup's own fallback styles stand in.
  const looks = { group: null, label: null, row: null, twoLine: null };
  const learnLooks = () => {
    const group = palette.dialog.querySelector('[data-slot="command-group"]:not([data-t3-setup-palette])');
    const label = group && group.querySelector('[data-slot="command-group-label"]');
    if (group) looks.group = group.className;
    if (label) looks.label = label.className;
    for (const row of theirRows()) {
      // T3 marks its active row with forced background classes, which are
      // T3's to set: they are not copied.
      looks.row = row.className.split(/\s+/).filter((c) => !/!$/.test(c)).join(' ');
      // Native results can contain a full-size illustration or an icon sized
      // by a parent selector. Never borrow arbitrary descendant SVG classes.
      const text = row.querySelector(':scope > span');
      const title = text && text.children[0];
      const meta = text && text.children[1];
      if (title && meta && title.firstElementChild) {
        looks.twoLine = { text: text.className, title: title.className, name: title.firstElementChild.className, meta: meta.className };
      }
    }
  };

  /** Setup's group, drawn with T3's own classes for its groups and rows. */
  const buildGroup = (items) => {
    learnLooks();
    const twoLine = looks.twoLine;
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('data-slot', 'command-group');
    group.setAttribute('data-t3-setup-palette', '');
    group.setAttribute('aria-labelledby', 't3-setup-cmd-label');
    if (looks.group) group.className = looks.group;
    const label = document.createElement('div');
    label.id = 't3-setup-cmd-label';
    label.setAttribute('data-slot', 'command-group-label');
    label.className = looks.label || 't3-setup-cmd-label';
    label.textContent = 'Setup';
    group.appendChild(label);
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.id = 't3-setup-cmd-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('data-slot', 'command-item');
      row.setAttribute(OWN_ROW, item.id);
      row.setAttribute('aria-selected', 'false');
      row.className = looks.row ? looks.row + ' t3-setup-cmd' : 't3-setup-cmd t3-setup-cmd--plain';
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
        ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['width', '16'], ['height', '16']]) icon.setAttribute(name, value);
      icon.setAttribute('class', 't3-setup-cmd-icon');
      const supplied = svg(item.icon,'t3-setup-cmd-icon');
      icon.replaceChildren(...supplied.childNodes);
      const text = document.createElement('span');
      text.className = 't3-setup-cmd-text' + (twoLine ? ' ' + twoLine.text : '');
      const title = document.createElement('span');
      title.className = twoLine ? twoLine.title : 't3-setup-cmd-title';
      const name = document.createElement('span');
      name.className = twoLine ? twoLine.name : '';
      name.textContent = item.title;
      title.appendChild(name);
      const meta = document.createElement('span');
      meta.className = twoLine ? twoLine.meta : 't3-setup-cmd-meta';
      meta.textContent = item.id === 'setup' && state.attention > 0
        ? (state.attention === 1 ? '1 thing needs you' : state.attention + ' things need you') + ' · agents, toolchains, source control, ports and devices'
        : item.meta;
      text.append(title, meta);
      row.append(icon, text);
      group.appendChild(row);
    });
    return group;
  };

  /** T3's group of commands, the one Setup's follows. */
  const actionsGroup = (list) => [...list.querySelectorAll('[data-slot="command-group"]:not([data-t3-setup-palette])')]
    .find((group) => {
      const label = group.querySelector('[data-slot="command-group-label"]');
      return Boolean(label) && label.textContent.trim() === 'Actions';
    }) || null;

  // In the virtualized list T3 renders group headings as rows of their own,
  // with no group element for Setup's to follow. An "Actions" heading there
  // still means T3's own commands answered the search.
  const hasVirtualActions = (list) => {
    if (!list || actionsGroup(list)) return false;
    return [...list.querySelectorAll('[data-slot="command-group-label"]')]
      .some((label) => !label.closest('[data-t3-setup-palette]') && label.textContent.trim() === 'Actions');
  };

  /** How many of T3's rows come before Setup's group. */
  const rowsBefore = (group) => theirRows()
    .filter((row) => Boolean(row.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING)).length;

  /**
   * Where Setup's group goes: after T3's Actions, or first in T3's list when
   * it shows none, or in place of "No matching…" when T3 has nothing.
   */
  const placeGroup = (group) => {
    const list = palette.dialog.querySelector('[data-slot="command-list"]');
    const footer = palette.dialog.querySelector('[data-slot="command-footer"]');
    for (const region of palette.dialog.querySelectorAll('[data-t3-setup-empty]')) {
      if (list || region !== (footer && footer.previousElementSibling)) region.removeAttribute('data-t3-setup-empty');
    }
    if (list) {
      const actions = actionsGroup(list);
      // Moved only when out of place: every move is a mutation T3's list
      // watcher answers with another sync.
      if (actions) {
        if (actions.nextElementSibling !== group) actions.after(group);
      } else if (list.firstElementChild !== group) list.prepend(group);
      const host = palette.dialog.querySelector('[data-t3-setup-host]');
      if (host) host.remove();
      return;
    }
    const region = footer && footer.previousElementSibling;
    if (!region) return;
    let host = region.querySelector('[data-t3-setup-host]');
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-t3-setup-host', '');
      host.setAttribute('role', 'listbox');
      host.setAttribute('aria-label', 'Setup');
      host.className = 't3-setup-cmd-host';
      region.appendChild(host);
    }
    region.setAttribute('data-t3-setup-empty', '');
    if (group.parentElement !== host) host.appendChild(group);
  };

  const removeGroup = () => {
    if (!palette.dialog) return;
    const group = ourGroup();
    if (group) group.remove();
    for (const node of palette.dialog.querySelectorAll('[data-t3-setup-host]')) node.remove();
    for (const node of palette.dialog.querySelectorAll('[data-t3-setup-empty]')) node.removeAttribute('data-t3-setup-empty');
    palette.dialog.removeAttribute('data-t3-setup-owns');
  };

  /** Draw whose row is highlighted, and tell assistive technology the same. */
  const paintPalette = () => {
    const group = ourGroup();
    if (!group) return;
    const rows = [...group.querySelectorAll('[' + OWN_ROW + ']')];
    rows.forEach((row, index) => {
      const on = index === palette.own;
      if (row.hasAttribute('data-highlighted') !== on) row.toggleAttribute('data-highlighted', on);
      row.setAttribute('aria-selected', String(on));
    });
    palette.dialog.toggleAttribute('data-t3-setup-owns', palette.own >= 0);
    const mine = rows[palette.own];
    const theirRowList = theirRows();
    const theirs = theirRowList[theirActive(theirRowList)];
    const active = mine ? mine.id : theirs ? theirs.id : '';
    if (active && palette.input.getAttribute('aria-activedescendant') !== active) palette.input.setAttribute('aria-activedescendant', active);
    if (mine) mine.scrollIntoView({ block: 'nearest' });
  };

  const syncPalette = () => {
    if (!palette.dialog) return;
    if (!palette.dialog.isConnected) return detachPalette();
    if (!palette.input.isConnected) {
      // T3 can remount its input while asynchronous search state arrives. Its
      // focus event may precede the combobox role, so recover through the DOM.
      const replacement = palette.dialog.querySelector('input[role="combobox"]');
      if (replacement) attachPalette(replacement);
      else removeGroup();
      return;
    }
    const query = palette.input.value;
    const items = state.base && state.paired === true && !subPage() ? paletteMatches(query,state.paletteItems) : [];
    if (!items.length) {
      removeGroup();
      palette.items = [];
      palette.own = -1;
      palette.query = query;
      return;
    }
    // T3 redraws its list as results arrive, which can take Setup's group with
    // it: draw it again, but only a new search or new matches move the highlight.
    const same = palette.items.map((i) => i.id).join() === items.map((i) => i.id).join();
    let group = ourGroup();
    if (!group || !same) {
      if (group) group.remove();
      group = buildGroup(items);
    }
    placeGroup(group);
    // A new search starts the highlight where T3 starts its own: on the first
    // row, which is Setup's when its group comes first (T3 shows no Actions
    // for the search) or T3 has nothing to offer. T3's results can arrive a
    // moment after the search (and vanish while it redraws), so the default
    // follows them until the person moves the highlight.
    if (query !== palette.query || !same) palette.chosen = false;
    if (!palette.chosen) {
      const list = palette.dialog.querySelector('[data-slot="command-list"]');
      palette.own = paletteOwnsFirst({ before: rowsBefore(group), virtualActions: hasVirtualActions(list) }) ? 0 : -1;
    }
    palette.items = items;
    palette.query = query;
    paintPalette();
  };

  let paletteQueued = false;
  const schedulePalette = () => {
    if (paletteQueued) return;
    paletteQueued = true;
    requestAnimationFrame(() => {
      paletteQueued = false;
      syncPalette();
    });
  };

  const attachPalette = (input) => {
    const dialog = input.closest(PALETTE);
    if (palette.dialog === dialog && palette.input === input) return;
    detachPalette();
    Object.assign(palette, { dialog, input, items: [], own: -1, chosen: false, query: null });
    // T3 redraws its list as results arrive; put Setup's group back each time.
    palette.watch = new MutationObserver(schedulePalette);
    palette.watch.observe(dialog, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] });
    schedulePalette();
  };

  const detachPalette = () => {
    if (palette.watch) palette.watch.disconnect();
    removeGroup();
    Object.assign(palette, { dialog: null, input: null, items: [], own: -1, query: null, watch: null });
  };

  /**
   * Close T3's palette as its own commands do, then open Setup on the
   * command's page once the palette has gone: two modal layers at once would
   * each pull focus and mark the page inert for themselves. After an arrow
   * key, T3's palette spends the first Escape on its own highlight, so Escape
   * is pressed again (a few times at most) until the palette starts closing.
   */
  const runPaletteItem = (item) => {
    const input = palette.input;
    const dialog = palette.dialog;
    detachPalette();
    const started = Date.now();
    let presses = 0;
    const step = () => {
      if (dialog.isConnected && Date.now() - started < 1500) {
        if (dialog.hasAttribute('data-open') && presses < 3) {
          presses += 1;
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        }
        requestAnimationFrame(step);
        return;
      }
      if(!state.nav){window.open(state.base+'#'+(item.route||'overview'),'_blank','noopener');return;}
      if(state.tab)toConsole(state.tab.frame,{type:'navigate',route:item.hash||item.route||'overview'});
      else if(settingsHost())openTab(document.activeElement,item.hash||item.route||'overview');
      else navigateNative('/settings',item.hash||item.route||'overview');
    };
    step();
  };

  const inPalette = (node) => Boolean(node && node.closest && node.closest(PALETTE));
  // Attached even before the console has answered: syncPalette waits for
  // that, and start() draws again once it has.
  document.addEventListener('focusin', (event) => {
    if (inPalette(event.target) && event.target.matches('input[role="combobox"]')) attachPalette(event.target);
  }, true);
  document.addEventListener('input', (event) => {
    if (palette.input && event.target === palette.input) schedulePalette();
  }, true);
  // Ahead of base-ui's own handlers (which React runs from the palette's
  // container), so a key that is Setup's never reaches them.
  window.addEventListener('keydown', (event) => {
    if (!palette.input || event.target !== palette.input || !ourGroup() || event.isComposing) return;
    const { key } = event;
    if (key === 'Enter' && palette.own >= 0) {
      event.preventDefault();
      event.stopPropagation();
      runPaletteItem(palette.items[palette.own]);
      return;
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
    const rows = theirRows();
    const next = paletteStep({ key, own: palette.own, ours: palette.items.length, theirs: rows.length, at: theirActive(rows), before: rowsBefore(ourGroup()) });
    palette.own = next.own;
    palette.chosen = true;
    if (!next.pass) {
      event.preventDefault();
      event.stopPropagation();
    }
    // After T3 has moved its own highlight, if it got the key.
    requestAnimationFrame(paintPalette);
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (!palette.dialog || !inPalette(event.target)) return;
    const mine = event.target.closest('[' + OWN_ROW + ']');
    const theirs = !mine && event.target.closest('[data-slot="command-item"]');
    const index = mine ? [...ourGroup().querySelectorAll('[' + OWN_ROW + ']')].indexOf(mine) : -1;
    if (mine && index !== palette.own) {
      palette.own = index;
      palette.chosen = true;
      paintPalette();
    } else if (theirs && palette.own >= 0) {
      palette.own = -1;
      palette.chosen = true;
      requestAnimationFrame(paintPalette);
    }
  }, true);
  // Keep focus in the search field when a row of Setup's is pressed.
  document.addEventListener('pointerdown', (event) => {
    if (palette.dialog && event.target.closest && event.target.closest('[' + OWN_ROW + ']')) event.preventDefault();
  }, true);
  document.addEventListener('click', (event) => {
    const row = palette.dialog && event.target.closest && event.target.closest('[' + OWN_ROW + ']');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    const item = palette.items.find((i) => i.id === row.getAttribute(OWN_ROW));
    if (item) runPaletteItem(item);
  }, true);

  // ------------------------------------------------------------ keeping up --
  /** Draw what this screen should have: the pill before pairing, the entry in settings. */
  const sync = () => {
    if (!state.base) return;
    // T3 not answering is not the same as T3 saying "not paired": fall back to
    // the pairing screen's own path then.
    const unpaired = state.paired === false || (state.paired === null && /^\/pair\/?$/.test(location.pathname));
    if (unpaired) showPill();
    else if (pill()) pill().remove();

    const inSettings = state.paired === true && isSettingsPath(location.pathname);
    watch(inSettings);
    if (inSettings) ensureEntries();
    else removeEntries();
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sync();
    });
  };

  // T3 draws its settings sidebar after the route changes, and on a phone
  // only when the sheet opens; watch the page for it only while in settings.
  let observer = null;
  const watch = (on) => {
    if (on && !observer) {
      observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
    } else if (!on && observer) {
      observer.disconnect();
      observer = null;
    }
  };

  const onNavigate = () => {
    if (location.pathname === state.path) return;
    const wasSettings = isSettingsPath(state.path);
    state.path = location.pathname;
    // Leaving Settings tears down its Setup pane too.
    if (state.tab && !isSettingsPath(state.path)) closeTab(false);
    if (!isSettingsPath(state.path) && !state.pendingRoute) forget();
    if (!state.base) return;
    // Pairing finishes without a reload, and a revoked session lands back on
    // the pairing screen, so ask T3 again until it says paired.
    if (state.paired !== true || /^\/pair\/?$/.test(state.path)) refreshPaired();
    if (isSettingsPath(state.path) && !wasSettings) refreshAttention(false);
    schedule();
  };

  // T3's router moves with pushState and replaceState. Wrapped now, while
  // this script runs and before T3's own module does, so the router's calls
  // come through here too.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function () {
      const result = original.apply(this, arguments);
      queueMicrotask(onNavigate);
      return result;
    };
  }
  window.addEventListener('popstate', onNavigate);

  const start = async () => {
    const [answer, paired] = await Promise.all([hello(), pairedWithT3()]);
    // The console is not routed on this origin: leave T3 Code exactly as it is.
    if (!answer) return;
    state.paired = paired;
    state.attention = answer.signedIn ? answer.attention : 0;
    state.checkedAt = Date.now();
    if(answer.nav){state.nav=answer.nav;state.icons=answer.icons;state.paletteItems=answer.palette;}
    if(!isSettingsPath(location.pathname))forget();
    addStyles();
    sync();
    // A palette opened while the console was still being asked.
    schedulePalette();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
