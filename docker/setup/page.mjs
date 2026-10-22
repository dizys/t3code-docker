// The setup console's one HTML document.
//
// Everything the browser runs is inlined into this single response: the design
// system's stylesheets, the page composition, and the client scripts. The page
// makes no other request for code or fonts, because it is often opened over a
// tunnel from a phone, and because a reverse proxy routing only a prefix here
// should not have to know about asset paths.
//
// Every asset is read verbatim from its own file once, at startup, never
// embedded in a template literal: a template literal eats backslashes on the
// way out (`/\s+/` once reached the browser as `/s+/`). The smoke test holds
// each inlined script byte-for-byte to its file.
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Order matters: tokens, then components, then the page's own composition.
export const STYLES = ["design/tokens.css", "design/components.css", "console.css"];

// Classic scripts that share one global scope, run in this order. base.js
// resolves where the API lives; ui.js is the design system's behaviour layer
// (window.T3C); routes.js the table of pages (window.T3Routes); model.js the
// console's pure view model (window.T3Model); kit.js the DOM layer (overlays,
// toasts, keyboard); app.js the console itself.
export const CONSOLE_SCRIPTS = [
  "client/base.js",
  "design/ui.js",
  "client/routes.js",
  "client/model.js",
  "client/kit.js",
  "client/access-state.js",
  "client/storage.js",
  "client/skill-model.js",
  "client/skill-inspector.js",
  "client/skill-import.js",
  "client/skills.js",
  "app.js",
];
export const UNLOCK_SCRIPTS = ["client/base.js", "design/ui.js", "client/unlock.js"];

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * Run classic scripts (no DOM) in one fresh context and return the globals
 * they define: the server reads the console's own route table and view model
 * this way, so the shell it draws and the counts it reports are the page's.
 */
export const runClassic = (paths, names) => {
  const context = vm.createContext({ URL });
  for (const path of paths) vm.runInContext(read(path), context, { filename: path });
  return Object.fromEntries(names.map((name) => [name, vm.runInContext(name, context)]));
};

const { T3Routes: ROUTES } = runClassic(["client/routes.js"], ["T3Routes"]);

/**
 * Read every asset once. Throws at startup if one could not be inlined safely,
 * rather than shipping a page whose script ends early.
 */
export function loadAssets() {
  const css = STYLES.map((path) => `/* ${path} */\n${read(path)}`).join("\n");
  if (/<\/style/i.test(css)) throw new Error("a stylesheet contains </style and cannot be inlined");
  const script = (path) => {
    const code = read(path);
    if (/<\/script/i.test(code)) throw new Error(`${path} contains </script and cannot be inlined`);
    return { path, code };
  };
  return {
    css,
    console: CONSOLE_SCRIPTS.map(script),
    unlock: UNLOCK_SCRIPTS.map(script),
  };
}

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Resolve the theme before first paint. Left to the client scripts, the page
// flashes light for as long as it takes them to parse, which on a phone over a
// tunnel is long enough to see. Inside T3 Code the theme is T3's, passed in the
// address (?theme=dark) and kept current by message, never saved here.
const BOOT = `(function(){var r=document.documentElement;try{var m=localStorage.getItem("t3-console-theme")||"system";`
  + `if(r.hasAttribute("data-embed")){var t=new URLSearchParams(location.search).get("theme");m=t==="dark"||t==="light"?t:"system";}`
  + `var d=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;`
  + `r.setAttribute("data-theme",d);r.setAttribute("data-theme-mode",m);}catch(e){r.setAttribute("data-theme","light");}})();`;
// Touch density lives on .tc-root, which is <body>, so it is set first thing
// inside it rather than from <head>; kit.js keeps it current on resize.
const DENSITY = `try{if(matchMedia("(max-width: 1023.98px)").matches)document.body.setAttribute("data-density","touch");}catch(e){}`;

// The console's app icon, as the favicon: the handoff's t3-mark.svg.
const FAVICON = `data:image/svg+xml,${encodeURIComponent(read("design/favicon.svg").trim())}`;

/**
 * The Content-Security-Policy for one response. Scripts run only with this
 * response's nonce; styles are inline by construction (components set hues
 * through style attributes); images are data: URIs and inline SVG; the only
 * network the page itself uses is its own API.
 */
export const contentSecurityPolicy = (nonce) => [
  "default-src 'none'",
  `script-src 'nonce-${nonce}'`,
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  // T3 Code's settings open the console in a frame; only this origin may.
  "frame-ancestors 'self'",
].join("; ");

const head = ({ nonce, css, mount, embed }) => `<!doctype html>
<html lang="en"${embed ? ' data-embed="t3"' : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>T3 Code setup</title>
<link rel="icon" href="${FAVICON}">
<script nonce="${nonce}">${BOOT}</script>
<style>${css}</style>
<script nonce="${nonce}">window.__T3_SETUP_BASE__ = ${JSON.stringify(mount)};</script>
</head>`;

const scripts = (list, nonce) =>
  list.map(({ path, code }) => `<script nonce="${nonce}" data-src="${path}">${code}</script>`).join("\n");

const skeleton = (rows) => `<div class="tc-group" aria-hidden="true">${
  Array.from({ length: rows }, (_, i) =>
    `<div class="tc-skel-row"><span class="tc-skel tc-skel--tile"></span><span class="tc-skel" style="width:${[38, 52, 30, 44][i % 4]}%"></span></div>`).join("")
}</div>`;

// Inside T3 Code the console is a dialog over the app: it closes rather than
// linking to T3, opens in a tab of its own on request, and leaves the theme to T3.
const CLOSE = `<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm tc-embed-close" type="button" data-cmd="embed.close" aria-label="Close" title="Close (Esc)"><i data-icon="x"></i></button>`;

/**
 * "G A": a page's two-key shortcut, as its sidebar tooltip says it. Not
 * aria-keyshortcuts, which lists alternatives and has no way to say "then".
 */
const shortcut = (page) => (page.key ? `G ${page.key.toUpperCase()}` : "");

const navItem = (page) => `<a class="tc-nav-item" href="#${page.route}" data-nav="${page.route}"${page.key ? ` title="${escapeHtml(page.title)} · ${shortcut(page)}"` : ""}><i data-icon="${page.icon}"></i><span class="tc-nav-text">${escapeHtml(page.title)}</span><span class="tc-nav-badge" id="nav-${page.route}" hidden></span></a>`;

/** The sidebar's pages in their groups; a group without a label draws no heading. */
const sidebarNav = () => ROUTES.grouped().filter((group) => group.pages.length).map((group) =>
  `<div class="tc-nav-group"${group.label ? ` role="group" aria-labelledby="nav-group-${group.id}"` : ""}>${group.label ? `<div class="tc-nav-label" id="nav-group-${group.id}">${escapeHtml(group.label)}</div>` : ""}${group.pages.map(navItem).join("")}</div>`).join("");

/**
 * The console once unlocked: the shell, with every page awaiting its first
 * status. `embed` is the variant T3 Code's settings open in a dialog.
 */
export function renderConsole({ assets, nonce, mount, embed = false }) {
  const tabs = ROUTES.TABS.map((tab) =>
    `<a class="tc-tab" href="#${tab.route}" data-nav="${tab.route}"><span class="tc-tab-ico"><i data-icon="${tab.icon}"></i><span class="tc-tab-badge" id="tab-${tab.route}" hidden></span></span>${escapeHtml(tab.title)}</a>`).join("");
  const pages = [...ROUTES.PAGES, ROUTES.page("more")].map((page) =>
    `<section class="tc-page${page.route === "instructions" ? " tc-page--wide" : ""}" id="page-${page.route}" data-route="${page.route}" aria-label="${escapeHtml(page.title)}" hidden>${skeleton(page.route === "more" ? 2 : 3)}</section>`).join("\n");
  const foot = embed
    ? `<a class="tc-nav-item" id="open-tab" href="${escapeHtml(mount)}/" target="_blank" rel="noopener" data-open-tab><i data-icon="external-link"></i>Open in a new tab</a>`
    : `<a class="tc-nav-item" id="open-t3" href="/" target="_blank" rel="noopener" data-open-t3><i data-icon="external-link"></i>Open T3 Code</a>
        <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" id="theme-toggle" data-cmd="theme.cycle" aria-label="Switch theme"><i data-icon="monitor"></i></button>`;
  return `${head({ nonce, css: assets.css, mount, embed })}
<body class="tc-root">
<script nonce="${nonce}">${DENSITY}</script>
<div class="tc-app" id="app">
  <nav class="tc-sidebar" aria-label="Console">
    <div class="tc-brand"><span class="tc-wordmark" aria-label="T3 Code"><span>Code</span></span><span class="tc-badge tc-badge--outline tc-badge--sm">Setup</span></div>
    <button class="tc-search" type="button" data-cmd="palette" aria-keyshortcuts="Meta+K Control+K"><i data-icon="search"></i>Search<span class="tc-kbd" data-mod-key>⌘K</span></button>
    <div class="tc-nav">${sidebarNav()}</div>
    <div class="tc-sidebar-foot">
      <div class="tc-server" id="server-card"><div class="tc-server-row"><span class="tc-skel tc-skel--line"></span></div></div>
      <div class="tc-sidebar-row">
        ${foot}
      </div>
    </div>
  </nav>
  <main class="tc-main" id="main" tabindex="-1">
${embed ? `    <div class="tc-embed-corner">${CLOSE}</div>` : ""}
    <header class="tc-phonebar">
      <span class="tc-wordmark" aria-label="T3 Code"><span>Code</span></span><span class="tc-badge tc-badge--outline tc-badge--sm">Setup</span>
      <span class="tc-spacer"></span>
      <span class="tc-phone-status" id="phone-status"></span>
      <button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-cmd="palette" aria-label="Search"><i data-icon="search"></i></button>${embed ? CLOSE.replace(" tc-btn--sm", "") : ""}
    </header>
${pages}
  </main>
  <nav class="tc-tabbar" aria-label="Console">${tabs}</nav>
</div>
<div id="layers"></div>
<div class="tc-toaster" id="toaster" role="region" aria-label="Notifications" aria-live="polite"></div>
${scripts(assets.console, nonce)}
</body></html>`;
}

/**
 * The standalone unlock page. The form posts `key` to `{mount}/login` and works
 * without JavaScript; unlock.js only keeps the user on the page to show a wrong
 * key in place, and reveals the key on request.
 */
export function renderUnlock({ assets, nonce, mount, host, publicUrl, error, embed = false }) {
  // Inside T3 Code there is no T3 Code to open: the dialog closes instead.
  const t3Url = embed ? "" : publicUrl || (mount ? "/" : "");
  const invalid = error ? ' aria-invalid="true" aria-describedby="key-error"' : "";
  return `${head({ nonce, css: assets.css, mount, embed })}
<body class="tc-root">
<script nonce="${nonce}">${DENSITY}</script>
<main class="tc-standalone">
  <div class="tc-standalone-card">
    <div class="tc-masthead"><div class="tc-masthead-in"><span class="tc-eyebrow">T3 Code · Setup</span>${embed ? CLOSE : ""}</div></div>
    <div class="tc-standalone-body">
      ${host ? `<span class="tc-eyebrow">${escapeHtml(host)}</span>` : ""}
      <h1 class="tc-standalone-title">Unlock the console</h1>
      <p class="tc-standalone-desc">Pair devices, sign agents in and publish ports on this server. Enter the setup key: the one you set as <code>T3_SETUP_KEY</code>, or the one this server generated on its first start.</p>
      <form class="tc-unlock-form" method="POST" action="${escapeHtml(mount)}/login" id="loginform" novalidate>${embed ? `
        <input type="hidden" name="embed" value="t3">` : ""}
        <div class="tc-field">
          <label class="tc-label" for="key">Setup key</label>
          <div class="tc-inputwrap">
            <input class="tc-input tc-input--mono tc-input--lg" id="key" name="key" type="password" placeholder="Paste the setup key"
              autocomplete="current-password" autocapitalize="off" spellcheck="false" required autofocus${invalid}>
            <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs tc-reveal" type="button" id="reveal" aria-label="Show the setup key" aria-pressed="false" hidden><i data-icon="eye"></i></button>
          </div>
          <p class="tc-hint tc-hint--err" id="key-error" role="alert"${error ? "" : " hidden"}>That key was not accepted. Keys are case-sensitive; paste it rather than typing it.</p>
        </div>
        <div class="tc-unlock-actions">
          <button class="tc-btn tc-btn--primary tc-btn--lg" type="submit" id="unlock">Unlock</button>
          ${t3Url ? `<a class="tc-btn tc-btn--lg" href="${escapeHtml(t3Url)}" rel="noopener">Open T3 Code</a>` : ""}
        </div>
      </form>
      <div class="tc-note">Left <code>T3_SETUP_KEY</code> empty? The first start generated a key and kept it. Every start prints it to the log, under the line that names <code>T3_SETUP_KEY</code>:<br><code>docker compose logs t3code | grep -A1 T3_SETUP_KEY</code></div>
    </div>
  </div>
</main>
${scripts(assets.unlock, nonce)}
</body></html>`;
}
