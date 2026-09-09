// Setup service: everything you need before T3 Code's own UI can take over.
//
// T3 Code's welcome wizard handles agent sign-in and project import perfectly
// well - but only once you have reached it, and reaching it needs a pairing
// link. Minting one otherwise means a shell in the container, which a hosting
// panel makes awkward. This serves that one step over HTTP, on its own port,
// gated by a key you set as an environment variable when creating the
// container.
//
// Deliberately dependency-free: Node's http, plus `t3` and `qrencode` from the
// image.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

const PORT = Number(process.env.T3_SETUP_PORT ?? 3774);
const KEY = process.env.T3_SETUP_KEY ?? "";
const T3_PORT = process.env.T3CODE_PORT ?? "3773";
const PUBLIC_URL = (process.env.T3_PUBLIC_URL ?? "").replace(/\/+$/, "");
const COOKIE = "t3setup";
// Lets a single public hostname route a path prefix here instead of needing a
// second subdomain: e.g. Cloudflare Tunnel sending /__setup* to this port.
const BASE_PATH = (process.env.T3_SETUP_BASE_PATH ?? "").replace(/\/+$/, "");

if (!KEY) {
  console.error("[setup] T3_SETUP_KEY is empty; refusing to start");
  process.exit(1);
}

/** Constant-time compare that tolerates length differences. */
const keyMatches = (candidate) => {
  const a = Buffer.from(String(candidate ?? ""));
  const b = Buffer.from(KEY);
  if (a.length !== b.length) {
    // Still burn a comparison so failures cost the same either way.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
};

// A trivial throttle: the key is the only thing between a stranger and a
// pairing token, so make guessing expensive.
const failures = new Map();
const throttle = (ip) => {
  const n = failures.get(ip) ?? 0;
  failures.set(ip, n + 1);
  return new Promise((r) => setTimeout(r, Math.min(n * 250, 3000)));
};

const t3 = (args) =>
  run("t3", args, { env: process.env, maxBuffer: 4 * 1024 * 1024 });

const health = async () => {
  try {
    const res = await fetch(
      `http://127.0.0.1:${T3_PORT}/.well-known/t3/environment`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, version: body.serverVersion, label: body.label };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  }
};

const which = async (bin) => {
  try {
    await run("sh", ["-c", `command -v ${bin}`]);
    return true;
  } catch {
    return false;
  }
};

const HARNESSES = [
  { id: "claude", name: "Claude Code", bin: "claude", cred: `${process.env.HOME}/.claude/.credentials.json` },
  { id: "codex", name: "Codex", bin: "codex", cred: `${process.env.HOME}/.codex/auth.json` },
  { id: "opencode", name: "OpenCode", bin: "opencode", cred: `${process.env.HOME}/.local/share/opencode/auth.json` },
  { id: "cursor", name: "Cursor", bin: "cursor-agent", cred: null },
  { id: "grok", name: "Grok Build", bin: "grok", cred: null },
];

const status = async () => {
  const { existsSync } = await import("node:fs");
  const harnesses = [];
  for (const h of HARNESSES) {
    const installed = await which(h.bin);
    harnesses.push({
      id: h.id,
      name: h.name,
      installed,
      signedIn: h.cred ? existsSync(h.cred) : null,
    });
  }
  return {
    server: await health(),
    publicUrl: PUBLIC_URL || null,
    harnesses,
    pairings: await listJson(["auth", "pairing", "list", "--json"]),
    sessions: await listJson(["auth", "session", "list", "--json"]),
  };
};

/** `t3 auth` prefixes JSON with log chatter; take the array and nothing else. */
const listJson = async (args) => {
  try {
    const { stdout } = await t3(args);
    const start = stdout.indexOf("[");
    if (start < 0) return [];
    return JSON.parse(stdout.slice(start));
  } catch {
    return [];
  }
};

const revoke = async ({ kind, id }) => {
  if (kind !== "session" && kind !== "pairing") throw new Error("unknown kind");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(id ?? ""))) throw new Error("bad id");
  await t3(["auth", kind, "revoke", String(id)]);
  return { ok: true };
};

const mintPairing = async ({ ttl, label }) => {
  if (!PUBLIC_URL) {
    throw new Error(
      "T3_PUBLIC_URL is not set, so a pairing link would point at this container's own address. Set it and restart.",
    );
  }
  const args = ["auth", "pairing", "create", "--base-url", PUBLIC_URL, "--json"];
  if (ttl) args.push("--ttl", ttl);
  if (label) args.push("--label", label);
  const { stdout } = await t3(args);
  const issued = JSON.parse(stdout.slice(stdout.indexOf("{")));
  let qr = null;
  try {
    const { stdout: svg } = await run("qrencode", ["-t", "SVG", "-m", "1", "-o", "-", issued.pairUrl]);
    qr = svg;
  } catch {
    qr = null;
  }
  return { ...issued, qr };
};

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { "cache-control": "no-store", ...headers });
  res.end(body);
};
const sendJson = (res, code, value, headers = {}) =>
  send(res, code, JSON.stringify(value), { "content-type": "application/json", ...headers });

const cookieFrom = (req) =>
  Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length === 2),
  )[COOKIE];

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) throw new Error("body too large");
  }
  return Buffer.concat(chunks).toString("utf8");
};

const page = (authed, mount) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>T3 Code setup</title>
<style>
/* Tokens lifted from T3 Code's own stylesheet (apps/web/src/index.css) so this
   page does not feel like a different product: its radii, its zinc/neutral
   ramps, its primary, and its emerald/amber/red semantics. */
:root{
  color-scheme:light dark;
  --background:oklch(99.2% 0 0);
  --foreground:oklch(0.274 0.006 286.033);
  --card:#fff;
  --muted:oklch(0.985 0 0);
  --muted-foreground:oklch(0.552 0.016 285.938);
  --border:oklch(0.92 0.004 286.32);
  --input:oklch(0.871 0.006 286.286);
  --primary:oklch(0.488 0.217 264);
  --primary-foreground:#fff;
  --accent:oklch(0.967 0.001 286.375);
  --success-foreground:oklch(0.508 0.118 165.612);
  --warning-foreground:oklch(0.555 0.163 48.998);
  --warning-surface:color-mix(in srgb, oklch(0.769 0.188 70.08) 8%, transparent);
  --error:oklch(0.637 0.237 25.331);
  --error-foreground:oklch(0.505 0.213 27.518);
  --error-surface:color-mix(in srgb, oklch(0.637 0.237 25.331) 8%, transparent);
  --radius:0.625rem;
  --control-radius:0.5rem;
  --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --background:oklch(0.145 0 0);
  --foreground:oklch(0.97 0 0);
  --card:color-mix(in srgb, oklch(0.145 0 0) 97%, #fff);
  --muted:rgb(255 255 255/3%);
  --muted-foreground:color-mix(in srgb, oklch(0.556 0 0) 90%, #fff);
  --border:rgb(255 255 255/6%);
  --input:rgb(255 255 255/8%);
  --primary:oklch(0.571 0.21 264);
  --accent:rgb(255 255 255/4%);
  --success-foreground:oklch(0.765 0.177 163.223);
  --warning-foreground:oklch(0.828 0.189 84.429);
  --warning-surface:color-mix(in srgb, oklch(0.769 0.188 70.08) 16%, transparent);
  --error-foreground:oklch(0.704 0.191 22.216);
  --error-surface:color-mix(in srgb, oklch(0.637 0.237 25.331) 16%, transparent);
}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--background);color:var(--foreground);
  font-family:var(--font-sans);font-size:14px;line-height:1.5;
  -webkit-font-smoothing:antialiased;padding:32px 20px 64px}
main{max-width:640px;margin:0 auto}
.brand{display:flex;align-items:center;gap:9px;margin-bottom:28px}
.mark{width:26px;height:26px;border-radius:7px;background:var(--primary);color:#fff;
  display:grid;place-items:center;font-size:11px;font-weight:700;letter-spacing:-.02em}
.brand h1{font-size:14px;font-weight:600;margin:0;letter-spacing:-.01em}
.brand span{color:var(--muted-foreground);font-size:13px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  padding:20px;margin-bottom:14px}
.card>h2{font-size:13px;font-weight:600;margin:0 0 3px;letter-spacing:-.01em}
.card>p.hint{margin:0 0 16px;color:var(--muted-foreground);font-size:13px}
.card>p.hint:last-child{margin-bottom:0}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.controls>.grow{flex:1 1 150px;min-width:0}
button,select,input{font:inherit;border-radius:var(--control-radius);
  border:1px solid var(--input);background:var(--card);color:var(--foreground);
  padding:7px 11px;transition:background .12s,border-color .12s,opacity .12s}
button{border-color:transparent;background:var(--primary);color:var(--primary-foreground);
  font-weight:550;cursor:pointer;padding:7px 14px}
button:hover:not(:disabled){opacity:.9}
button.ghost{background:transparent;color:var(--foreground);border-color:var(--input)}
button.ghost:hover:not(:disabled){background:var(--accent);opacity:1}
button.tiny{padding:4px 9px;font-size:12.5px}
button:disabled{opacity:.5;cursor:default}
:where(button,select,input,a):focus-visible{outline:2px solid var(--primary);outline-offset:2px}
select{cursor:pointer}
.link{font-family:var(--font-mono);font-size:12.5px;word-break:break-all;
  background:var(--muted);border:1px solid var(--border);
  border-radius:var(--control-radius);padding:11px 12px;margin:14px 0 10px;line-height:1.45}
.qr{background:#fff;border:1px solid var(--border);border-radius:var(--control-radius);
  padding:12px;display:inline-block;margin-top:12px;line-height:0}
.qr svg{width:min(212px,58vw);height:auto;display:block;shape-rendering:crispEdges}
.rows{display:flex;flex-direction:column}
.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border)}
.row:first-child{border-top:0;padding-top:2px}
.row .main{flex:1;min-width:0}
.row .name{font-weight:500}
.row .meta,.empty{color:var(--muted-foreground);font-size:12.5px}
.empty{margin:0}
.kv{display:flex;justify-content:space-between;gap:16px;padding:7px 0;
  border-top:1px solid var(--border);font-size:13px}
.kv:first-child{border-top:0}
.kv dt{color:var(--muted-foreground);margin:0;flex:none}
/* A public URL is easily longer than the space left for it; let it wrap
   rather than run off the edge of the card. */
.kv dd{margin:0;text-align:right;font-weight:500;min-width:0;overflow-wrap:anywhere}
dl{margin:0}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;
  vertical-align:1px;background:currentColor}
.ok{color:var(--success-foreground)}
.warn{color:var(--warning-foreground)}
.bad{color:var(--error-foreground)}
.notice{border-radius:var(--control-radius);padding:10px 12px;font-size:13px;margin-top:12px}
.notice.err{background:var(--error-surface);color:var(--error-foreground)}
.notice.warn{background:var(--warning-surface);color:var(--warning-foreground)}
.skeleton{height:13px;border-radius:4px;background:var(--muted);margin:9px 0}
.login{max-width:400px;margin:8vh auto 0}
@media (max-width:520px){body{padding:20px 14px 48px}.card{padding:16px}}
</style></head><body><main>
<div class="brand"><div class="mark">T3</div>
  <h1>T3 Code</h1><span>&middot; setup</span></div>
${
  authed
    ? `<div class="card">
  <h2>Pair a device</h2>
  <p class="hint">Creates a single-use link for one device. Scan it with the T3 Code
  app, or open it in a browser.</p>
  <div class="controls">
    <select id="ttl" aria-label="How long the link stays valid">
      <option value="30d">Valid 30 days</option>
      <option value="7d">Valid 7 days</option>
      <option value="1h">Valid 1 hour</option>
    </select>
    <input id="label" class="grow" placeholder="Label, e.g. my phone" aria-label="Label" />
    <button id="mint">Create link</button>
  </div>
  <div id="out" aria-live="polite"></div>
</div>

<div class="card"><h2>Devices</h2>
  <p class="hint">Paired clients. Revoking one signs that device out; nothing else is touched.</p>
  <div id="clients"><div class="skeleton" style="width:60%"></div></div>
</div>

<div class="card"><h2>Unused links</h2>
  <p class="hint">Created but not yet redeemed.</p>
  <div id="links"><div class="skeleton" style="width:40%"></div></div>
</div>

<div class="card"><h2>Environment</h2>
  <div id="status"><div class="skeleton" style="width:70%"></div>
  <div class="skeleton" style="width:50%"></div></div>
</div>

<div class="card"><h2>Signing in your agents</h2>
  <p class="hint">Do this inside T3 Code once you are paired &mdash; its setup flow opens
  a terminal on this machine with the right command ready to run. You do not need a
  shell in the container.</p>
</div>`
    : `<div class="login"><div class="card">
  <h2>Setup key</h2>
  <p class="hint">The value of <code>T3_SETUP_KEY</code> from this container's
  environment. If you did not set one, it was generated at boot and printed to
  the container log.</p>
  <form method="POST" action="${mount}/login" class="controls">
    <input type="password" name="key" class="grow" placeholder="Setup key"
           autofocus autocomplete="current-password" aria-label="Setup key" />
    <button>Unlock</button>
  </form>
</div></div>`
}
</main>
<script>
const BASE = ${JSON.stringify(mount)};
if (document.getElementById('mint')) {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const when = (v) => { if (!v) return '—'; const d = new Date(v);
    return isNaN(d) ? '—' : d.toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'}); };

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
        '<div class="link">' + esc(data.pairUrl) + '</div>' +
        '<div class="controls"><button class="ghost tiny" id="copy">Copy link</button>' +
        '<a href="' + esc(data.pairUrl) + '" target="_blank" rel="noopener">' +
        '<button class="ghost tiny">Open</button></a>' +
        '<span class="meta">Single use &middot; expires ' + esc(when(data.expiresAt)) + '</span></div>' +
        (data.qr ? '<div class="qr">' + data.qr + '</div>' : '');
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

    $('clients').innerHTML = s.sessions.length
      ? '<div class="rows">' + s.sessions.map((c) =>
          '<div class="row"><div class="main"><div class="name">' +
          esc(c.client?.label || c.subject || c.sessionId) + '</div><div class="meta">' +
          (c.connected ? '<span class="ok"><span class="dot"></span>Connected</span>'
                       : 'Last seen ' + esc(when(c.lastConnectedAt))) +
          ' &middot; expires ' + esc(when(c.expiresAt)) + '</div></div>' +
          revokeButton('session', c.sessionId) + '</div>').join('') + '</div>'
      : '<p class="empty">No devices paired yet. Create a link above.</p>';

    $('links').innerHTML = s.pairings.length
      ? '<div class="rows">' + s.pairings.map((l) =>
          '<div class="row"><div class="main"><div class="name">' +
          esc(l.label || 'Unlabelled') + '</div><div class="meta">Expires ' +
          esc(when(l.expiresAt)) + '</div></div>' + revokeButton('pairing', l.id) + '</div>').join('') + '</div>'
      : '<p class="empty">None outstanding.</p>';

    const rows = [];
    rows.push(['Server', s.server.ok
      ? '<span class="ok"><span class="dot"></span>Running ' + esc(s.server.version) + '</span>'
      : '<span class="bad"><span class="dot"></span>' + esc(s.server.detail) + '</span>']);
    rows.push(['Public URL', s.publicUrl ? esc(s.publicUrl)
      : '<span class="warn">Not set</span>']);
    for (const h of s.harnesses) {
      rows.push([esc(h.name), !h.installed ? '<span class="bad">Not installed</span>'
        : h.signedIn === true ? '<span class="ok">Signed in</span>'
        : h.signedIn === false ? '<span class="warn">Not signed in</span>'
        : '<span class="meta">Installed</span>']);
    }
    $('status').innerHTML = '<dl>' + rows.map(([k, v]) =>
      '<div class="kv"><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('') + '</dl>' +
      (s.publicUrl ? '' : '<div class="notice warn">Without T3_PUBLIC_URL, pairing links ' +
        "point at this container's own address and no device can reach them.</div>");

    for (const b of document.querySelectorAll('.revoke')) {
      b.onclick = async () => {
        b.disabled = true; b.textContent = 'Revoking';
        await fetch(BASE + '/revoke', {method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({kind: b.dataset.kind, id: b.dataset.id})});
        load();
      };
    }
  };
  load();
  setInterval(load, 15000);
}
</script></body></html>`;

const ROUTES = ["/login", "/status", "/pair", "/revoke"];

/**
 * Work out which prefix this request arrived under, and which route it wants.
 *
 * A reverse proxy that routes by path (a Cloudflare Tunnel sending /__setup*
 * here, say) forwards the prefix intact. Requiring the operator to also declare
 * that prefix as an environment variable duplicates knowledge the request
 * already carries - and getting it wrong produced a bare "unauthorized", which
 * looks like a password problem rather than a routing one. So infer it, and
 * keep T3_SETUP_BASE_PATH only as an override.
 */
const resolve = (pathname) => {
  if (BASE_PATH && (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`))) {
    return { mount: BASE_PATH, route: pathname.slice(BASE_PATH.length) || "/" };
  }
  for (const route of ROUTES) {
    if (pathname === route) return { mount: "", route };
    if (pathname.endsWith(route)) {
      return { mount: pathname.slice(0, -route.length), route };
    }
  }
  // Anything else is a request for the page itself, whatever path it came in on.
  return { mount: pathname.replace(/\/+$/, ""), route: "/" };
};

const server = createServer(async (req, res) => {
  const ip = req.socket.remoteAddress ?? "?";
  const raw = new URL(req.url ?? "/", "http://localhost");
  const { mount, route } = resolve(raw.pathname);
  const authed = keyMatches(cookieFrom(req));

  try {
    // Don't answer asset probes with the page.
    if (route === "/" && /\.[a-z0-9]{1,5}$/i.test(raw.pathname)) {
      return sendJson(res, 404, { error: "not found" });
    }

    if (req.method === "POST" && route === "/login") {
      const body = new URLSearchParams(await readBody(req));
      if (!keyMatches(body.get("key"))) {
        await throttle(ip);
        return send(res, 303, "", { location: `${mount}/` });
      }
      failures.delete(ip);
      return send(res, 303, "", {
        location: `${mount}/`,
        "set-cookie": `${COOKIE}=${encodeURIComponent(KEY)}; HttpOnly; SameSite=Strict; Path=${mount || "/"}; Max-Age=86400`,
      });
    }

    if (route === "/") {
      return send(res, 200, page(authed, mount), { "content-type": "text/html; charset=utf-8" });
    }

    if (!authed) {
      await throttle(ip);
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (route === "/status") return sendJson(res, 200, await status());

    if (req.method === "POST" && route === "/revoke") {
      try {
        return sendJson(res, 200, await revoke(JSON.parse((await readBody(req)) || "{}")));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    if (req.method === "POST" && route === "/pair") {
      const input = JSON.parse((await readBody(req)) || "{}");
      try {
        return sendJson(res, 200, await mintPairing(input));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    return sendJson(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[setup] listening on 0.0.0.0:${PORT}`);
});
