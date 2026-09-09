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
:root{color-scheme:light dark;--bg:#f6f6f7;--fg:#16161a;--card:#fff;--mut:#6b7280;--line:#e5e7eb;--acc:#2b3af5}
@media(prefers-color-scheme:dark){:root{--bg:#0e0e11;--fg:#f3f4f6;--card:#17171c;--mut:#9ca3af;--line:#2a2a33}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{max-width:720px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--mut);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 14px}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
button.sec{background:transparent;color:var(--fg);border:1px solid var(--line)}
button:disabled{opacity:.55;cursor:default}
input,select{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.link{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin:12px 0}
.qr{background:#fff;padding:12px;border-radius:8px;display:inline-block;margin-top:4px}
.qr svg{display:block;width:220px;height:220px}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:6px 0;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:0}
.ok{color:#16a34a}.bad{color:#dc2626}.warn{color:#d97706}
.err{background:#fee2e2;color:#991b1b;border-radius:8px;padding:10px;margin-top:12px}
@media(prefers-color-scheme:dark){.err{background:#3f1d1d;color:#fca5a5}}
</style></head><body><main>
<h1>T3 Code setup</h1>
<p class="sub">Pair a device, then carry on in T3 Code itself.</p>
${
  authed
    ? `<div class="card"><h2>Pair a device</h2>
<div class="row">
  <select id="ttl"><option value="30d">Valid 30 days</option><option value="7d">7 days</option><option value="1h">1 hour</option></select>
  <input id="label" placeholder="Label (optional)" />
  <button id="mint">Create pairing link</button>
</div>
<div id="out"></div></div>
<div class="card"><h2>Environment</h2><div id="status">Loading…</div></div>
<div class="card"><h2>Connected clients</h2><div id="clients">Loading…</div></div>
<div class="card"><h2>Unredeemed links</h2><div id="links">Loading…</div></div>
<div class="card"><h2>Signing in your agents</h2>
<p style="margin:0;color:var(--mut)">Do this inside T3 Code once paired — its setup flow opens a terminal
on this machine with the right command ready to run. You do not need a shell in the container.</p></div>`
    : `<div class="card"><h2>Setup key</h2>
<form method="POST" action="${mount}/login" class="row">
  <input type="password" name="key" placeholder="T3_SETUP_KEY" autofocus style="flex:1" />
  <button>Unlock</button>
</form>
<p style="margin:12px 0 0;color:var(--mut)">The value of <code>T3_SETUP_KEY</code> from this container's environment.</p>
</div>`
}
</main>
<script>
const BASE = ${JSON.stringify(mount)};
if (document.getElementById('mint')) {
  const out = document.getElementById('out');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  document.getElementById('mint').onclick = async (e) => {
    e.target.disabled = true; out.innerHTML = '<p style="color:var(--mut)">Minting…</p>';
    try {
      const res = await fetch(BASE + '/pair', {method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ttl: document.getElementById('ttl').value, label: document.getElementById('label').value})});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed');
      out.innerHTML = '<div class="link">' + esc(data.pairUrl) + '</div>' +
        '<div class="row"><button class="sec" id="copy">Copy link</button>' +
        '<a href="' + esc(data.pairUrl) + '" target="_blank"><button class="sec">Open</button></a></div>' +
        (data.qr ? '<div class="qr">' + data.qr + '</div>' : '') +
        '<p style="color:var(--mut);font-size:13px">One-time link. Expires ' + esc(data.expiresAt) + '.</p>';
      document.getElementById('copy').onclick = () => navigator.clipboard.writeText(data.pairUrl);
      load();
    } catch (err) { out.innerHTML = '<div class="err">' + esc(err.message) + '</div>'; }
    e.target.disabled = false;
  };
  const load = async () => {
    const s = await (await fetch(BASE + '/status')).json();
    const row = (k, v) => '<tr><td>' + k + '</td><td style="text-align:right">' + v + '</td></tr>';
    let html = '<table>';
    html += row('Server', s.server.ok ? '<span class="ok">running ' + esc(s.server.version) + '</span>' : '<span class="bad">' + esc(s.server.detail) + '</span>');
    html += row('Public URL', s.publicUrl ? esc(s.publicUrl) : '<span class="warn">not set — links will be unusable</span>');
    for (const h of s.harnesses) {
      html += row(esc(h.name), !h.installed ? '<span class="bad">not installed</span>'
        : h.signedIn === true ? '<span class="ok">signed in</span>'
        : h.signedIn === false ? '<span class="warn">not signed in</span>'
        : '<span style="color:var(--mut)">installed</span>');
    }
    document.getElementById('status').innerHTML = html + '</table>';

    const when = (v) => v ? new Date(v).toLocaleString() : '—';
    const revokeBtn = (kind, id) =>
      '<button class="sec revoke" data-kind="' + kind + '" data-id="' + esc(id) + '">Revoke</button>';

    document.getElementById('clients').innerHTML = s.sessions.length
      ? '<table>' + s.sessions.map((c) =>
          '<tr><td>' + esc(c.client?.label || c.subject || c.sessionId) +
          '<br><span style="color:var(--mut);font-size:12px">' +
          (c.connected ? '<span class="ok">connected</span>' : 'last seen ' + when(c.lastConnectedAt)) +
          ' · expires ' + when(c.expiresAt) + '</span></td>' +
          '<td style="text-align:right">' + revokeBtn('session', c.sessionId) + '</td></tr>').join('') + '</table>'
      : '<p style="margin:0;color:var(--mut)">No paired devices yet.</p>';

    document.getElementById('links').innerHTML = s.pairings.length
      ? '<table>' + s.pairings.map((l) =>
          '<tr><td>' + esc(l.label || 'unlabelled') +
          '<br><span style="color:var(--mut);font-size:12px">expires ' + when(l.expiresAt) + '</span></td>' +
          '<td style="text-align:right">' + revokeBtn('pairing', l.id) + '</td></tr>').join('') + '</table>'
      : '<p style="margin:0;color:var(--mut)">None outstanding.</p>';

    for (const b of document.querySelectorAll('.revoke')) {
      b.onclick = async () => {
        b.disabled = true;
        await fetch(BASE + '/revoke', {method:'POST', headers:{'content-type':'application/json'},
          body: JSON.stringify({kind: b.dataset.kind, id: b.dataset.id})});
        load();
      };
    }
  };
  load();
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
