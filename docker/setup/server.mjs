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

// Ask each CLI what it thinks rather than guessing from a file on disk. A
// credentials file is only one of the ways these tools are authenticated -
// ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN leave nothing on disk at all,
// and T3 Code honours those, which is why the two screens used to disagree.
const HARNESSES = [
  { id: "claude", name: "Claude Code", bin: "claude",
    probe: ["claude", "auth", "status", "--json"],
    reads: ({ stdout }) => JSON.parse(stdout).loggedIn === true },
  { id: "codex", name: "Codex", bin: "codex",
    // Codex prints both verdicts on stderr, and exits 1 for "Not logged in".
    probe: ["codex", "login", "status"],
    reads: ({ stdout, stderr }) => /^logged in/i.test((stderr + stdout).trim()) },
  { id: "opencode", name: "OpenCode", bin: "opencode",
    cred: `${process.env.HOME}/.local/share/opencode/auth.json` },
  { id: "cursor", name: "Cursor", bin: "cursor-agent",
    probe: ["cursor-agent", "status", "--format", "json"],
    reads: ({ stdout }) => JSON.parse(stdout).isAuthenticated === true },
  { id: "grok", name: "Grok Build", bin: "grok", detect: () => grokSignedIn() },
];

/**
 * Grok ships no status command, so read its model listing the way T3 Code does:
 * an xAI key in the environment wins, otherwise `grok models` says which it is.
 *
 * Not from its credentials file. Grok documents one - `jq -r '."https://
 * accounts.x.ai/sign-in".key' ~/.grok/auth.json` - but a file of exactly that
 * shape still leaves the CLI reporting "You are not authenticated", so the file
 * existing proves nothing. Asking costs 287ms and is the truth.
 */
const grokSignedIn = async () => {
  if (process.env.XAI_API_KEY?.trim()) return true;
  let text;
  try {
    const { stdout, stderr } = await run("grok", ["models"], { timeout: 8000, maxBuffer: 1024 * 1024 });
    text = stdout + stderr;
  } catch (error) {
    text = (error?.stdout ?? "") + (error?.stderr ?? "");
  }
  // "You are using XAI_API_KEY." is its own phrasing for a key it picked up.
  if (/you are logged in|using XAI_API_KEY/i.test(text)) return true;
  if (/not authenticated|not logged in/i.test(text)) return false;
  return null;
};

// Probing spawns a process per agent, so cache briefly: the page polls status
// every 15s and several browsers may watch at once. Anything that changes a
// sign-in clears this, so the panel never shows a stale verdict after acting.
let probeCache = { at: 0, value: null };
const PROBE_TTL_MS = 10_000;
const forgetSignInState = () => { probeCache = { at: 0, value: null }; };

const signedInState = async (h) => {
  if (h.detect) return h.detect();
  if (!h.probe) {
    const { existsSync } = await import("node:fs");
    return h.cred ? existsSync(h.cred) : null;
  }
  const [bin, ...args] = h.probe;
  let out;
  try {
    // A hung CLI must not hang the status endpoint.
    out = await run(bin, args, { timeout: 5000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    // Signed out is how these tools spend most of their life, and both Claude
    // and Codex report it with exit 1 while still printing the answer - so
    // read the output before calling the probe failed. A missing binary or a
    // timeout leaves nothing to read and stays unknown.
    out = { stdout: error?.stdout ?? "", stderr: error?.stderr ?? "" };
    if ((out.stdout + out.stderr).trim() === "") return null;
  }
  try {
    return h.reads(out);
  } catch {
    // Unparseable output is not evidence of being signed out; null renders as
    // "not readable", which is honest.
    return null;
  }
};

const harnessStatus = async () => {
  if (probeCache.value && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.value;
  // In parallel: serially these add up to seconds, and the slowest alone is
  // most of the wait.
  const value = await Promise.all(HARNESSES.map(async (h) => {
    const installed = await which(h.bin);
    return {
      id: h.id,
      name: h.name,
      installed,
      signedIn: installed ? await signedInState(h) : null,
      canSignIn: Boolean(AGENTS[h.id]?.signin),
      canSetKey: Boolean(AGENTS[h.id]?.apiKey),
      keyKind: AGENTS[h.id]?.apiKey?.kind ?? null,
    };
  }));
  probeCache = { at: Date.now(), value };
  return value;
};

/**
 * OpenCode takes a key per provider, and there are north of two hundred of them
 * - typing the id from memory is a guess. models.dev is the catalog OpenCode
 * itself resolves providers from, so offer that list and let the browser pick.
 *
 * The document is 4.5MB, which is not something to hand a phone on every page
 * load, so pull it here, keep the id and name and nothing else, and cache that
 * to disk: a restart stays instant and an offline container keeps working. The
 * fallback below is only for a container that has never once reached the net.
 */
const PROVIDER_FALLBACK = [
  ["anthropic", "Anthropic"], ["openai", "OpenAI"], ["google", "Google"],
  ["openrouter", "OpenRouter"], ["deepseek", "DeepSeek"], ["xai", "xAI"],
  ["groq", "Groq"], ["mistral", "Mistral"], ["amazon-bedrock", "Amazon Bedrock"],
  ["azure", "Azure"], ["cerebras", "Cerebras"], ["together", "Together"],
  ["fireworks-ai", "Fireworks"], ["ollama", "Ollama"], ["opencode", "OpenCode Zen"],
].map(([id, name]) => ({ id, name }));

const PROVIDER_CACHE = `${process.env.T3CODE_HOME || `${process.env.HOME}/.t3`}/setup/providers.json`;
const PROVIDER_TTL_MS = 24 * 60 * 60 * 1000;
let providerMemo = null;

const providers = async () => {
  if (providerMemo) return providerMemo;
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  try {
    const cached = JSON.parse(await readFile(PROVIDER_CACHE, "utf8"));
    if (Array.isArray(cached.list) && Date.now() - cached.at < PROVIDER_TTL_MS) {
      providerMemo = cached.list;
      return providerMemo;
    }
  } catch { /* no usable cache; fetch */ }
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = Object.entries(await res.json())
      .map(([id, p]) => ({ id, name: typeof p?.name === "string" && p.name ? p.name : id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (list.length === 0) throw new Error("empty catalog");
    providerMemo = list;
    try {
      await mkdir(PROVIDER_CACHE.replace(/\/[^/]+$/, ""), { recursive: true });
      await writeFile(PROVIDER_CACHE, JSON.stringify({ at: Date.now(), list }));
    } catch { /* the cache is an optimisation, not a requirement */ }
    return providerMemo;
  } catch {
    // Serve a stale cache before the built-in list: it is the real catalog.
    try {
      const cached = JSON.parse(await readFile(PROVIDER_CACHE, "utf8"));
      if (Array.isArray(cached.list) && cached.list.length) return (providerMemo = cached.list);
    } catch { /* fall through */ }
    return PROVIDER_FALLBACK;
  }
};

/** Which providers already hold a key, so the picker can say so. */
const configuredProviders = async () => {
  try {
    const { readFile } = await import("node:fs/promises");
    const auth = JSON.parse(await readFile(`${process.env.HOME}/.local/share/opencode/auth.json`, "utf8"));
    return Object.keys(auth ?? {});
  } catch {
    return [];
  }
};

const status = async () => {
  const harnesses = await harnessStatus();
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


// --- agent authentication ---------------------------------------------------
//
// Every one of these CLIs has a headless path, established by running them:
//   grok    login --device-auth   prints a URL and a code, then polls. No input.
//   cursor  login (NO_OPEN_BROWSER) prints a URL, then polls. No input.
//   claude  setup-token           prints a URL, then waits for a pasted code.
//   codex   login --with-api-key  reads the key from stdin. No browser.
//   opencode                      stores credentials in a JSON file we can write.
//
// The browser flows are TUIs, so they are run under `script` for a pty and
// their output is stripped of escapes before anything is scraped out of it.
import { spawn } from "node:child_process";
import { writeFile, mkdir, readFile } from "node:fs/promises";

const AGENTS = {
  claude: { name: "Claude Code",
    // `setup-token` mints a 1-year CI token and prints it; `auth login` is the
    // sign-in that actually leaves this container authenticated, which is what
    // the panel reports and what the agents then use.
    signin: { argv: ["claude", "auth", "login"], pty: true, expectsCode: true } },
  codex: { name: "Codex",
    apiKey: { kind: "stdin", argv: ["codex", "login", "--with-api-key"] },
    // Plain `codex login` starts a callback server on localhost:1455, which a
    // browser on any other machine cannot reach - it lands on the user's own
    // localhost instead. Codex says so itself and offers the device flow.
    signin: { argv: ["codex", "login", "--device-auth"], pty: true } },
  grok: { name: "Grok Build",
    signin: { argv: ["grok", "login", "--device-auth"], pty: false } },
  cursor: { name: "Cursor",
    signin: { argv: ["cursor-agent", "login"], pty: true, env: { NO_OPEN_BROWSER: "1" } } },
  opencode: { name: "OpenCode", apiKey: { kind: "opencode" } },
};

const stripAnsi = (text) =>
  text
    .replace(/\u001b\]8;[^\u0007\u001b]*(\u0007|\u001b\\)/g, "")  // OSC-8 hyperlinks
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")                  // CSI
    .replace(/\u001b[()][A-Za-z0-9]/g, "")
    .replace(/\u001b[<-?]/g, "");

/**
 * Claude renders its sign-in URL as an OSC-8 hyperlink, wrapped across several
 * lines. The visible text is therefore broken into pieces and scraping it
 * yields a truncated URL missing every parameter after client_id - but the
 * escape sequence carries the whole thing as its target, so read that first
 * and only fall back to plain text for the CLIs that print one.
 */
const OSC8 = /\u001b\]8;[^;]*;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/g;

const findUrl = (raw, stripped) => {
  const targets = [...raw.matchAll(OSC8)].map((m) => m[1]).filter((u) => /^https?:/.test(u));
  const plain = stripped.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const all = [...targets, ...plain];
  if (all.length === 0) return null;
  return all.sort((a, b) => b.length - a.length)[0];
};
const findCode = (text) => (text.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/) ?? [null])[0];

const sessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;
const SUBMIT_TTL_MS = 90 * 1000;
const TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);

const startSignin = (agentId) => {
  const agent = AGENTS[agentId];
  if (!agent?.signin) throw new Error(`${agentId} has no browser sign-in`);
  const { argv, pty, env, expectsCode } = agent.signin;

  // argv is fixed per agent, never built from request input, so the shell that
  // `script` needs cannot be steered from outside.
  const [cmd, args] = pty
    ? ["script", ["-qec", argv.join(" "), "/dev/null"]]
    : [argv[0], argv.slice(1)];

  const child = spawn(cmd, args, {
    env: { ...process.env, ...(env ?? {}), NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const id = randomBytes(9).toString("hex");
  const session = {
    id, agentId, state: "starting", url: null, code: null,
    needsCode: Boolean(expectsCode), output: "", error: null, child,
    startedAt: Date.now(),
  };

  // Keep a window of the raw stream too: the escape sequences carry the real
  // hyperlink targets, and stripping them first loses the URL.
  let raw = "";
  const absorb = (chunk) => {
    raw = (raw + String(chunk)).slice(-20000);
    session.output = (session.output + stripAnsi(String(chunk))).slice(-8000);
    if (!session.url) {
      session.url = findUrl(raw, session.output);
      if (session.url) {
        run("qrencode", ["-t", "SVG", "-m", "1", "-o", "-", session.url])
          .then(({ stdout }) => { session.qr = stdout; })
          .catch(() => {});
      }
    }
    session.code ??= findCode(session.output);
    if (session.url && session.state === "starting") {
      session.state = session.needsCode ? "awaiting-code" : "awaiting-browser";
    }
    // A rejected code does not end the process: `claude setup-token` prints the
    // error and offers "Press Enter to retry", so waiting for an exit waits for
    // ever. Take the verdict from the output instead. The message itself is a
    // half-redrawn TUI frame, so say something useful rather than quoting it.
    if (session.state === "submitted" && /OAuth error|Press Enter to retry/i.test(session.output)) {
      session.state = "failed";
      session.error = "That code was not accepted. Copy the whole value from the "
        + "address bar, including everything after the #, and try again.";
      try { child.kill(); } catch {}
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  child.on("error", (err) => { session.state = "failed"; session.error = String(err.message); });
  child.on("close", (code) => {
    // Either way the CLI may have written credentials, so re-probe next time.
    forgetSignInState();
    // A verdict already reached wins. We kill the child ourselves once the
    // output says the code was rejected, and `script` reports that kill as a
    // clean exit - which used to overwrite "failed" with "done" and tell
    // someone they were signed in when they had just been turned away.
    if (TERMINAL_STATES.has(session.state)) return;
    session.state = code === 0 ? "done" : "failed";
    if (code !== 0 && !session.error) {
      session.error = session.output.trim().split("\n").slice(-3).join(" ").slice(0, 300)
        || `exited with code ${code}`;
    }
  });

  sessions.set(id, session);
  setTimeout(() => {
    if (sessions.get(id)?.state?.startsWith("awaiting")) {
      try { session.child.kill(); } catch {}
      session.state = "failed";
      session.error = "Timed out waiting for the browser step.";
    }
  }, SESSION_TTL_MS).unref?.();
  // Waiting for the process to exit is the wrong finish line. These CLIs are
  // terminal UIs: several print their result and stay up. The question is not
  // "did it exit" but "is this agent signed in now", and we already have a way
  // to ask that, so ask it - and keep the deadline for the case where nothing
  // ever becomes true.
  const harness = HARNESSES.find((h) => h.id === agentId);
  // Only a transition counts. Someone signing in again while already signed in
  // - to switch accounts, say - would otherwise see the attempt declared done
  // before they had touched it.
  let wasSignedIn = null;
  if (harness) signedInState(harness).then((v) => { wasSignedIn = v; }).catch(() => {});
  const watchSession = setInterval(async () => {
    const live = sessions.get(id);
    if (!live || TERMINAL_STATES.has(live.state)) return;
    if (harness && wasSignedIn !== true && (await signedInState(harness)) === true) {
      try { live.child.kill(); } catch {}
      live.state = "done";
      forgetSignInState();
      return;
    }
    if (live.state !== "submitted") return;
    if (Date.now() - (live.submittedAt ?? Date.now()) < SUBMIT_TTL_MS) return;
    try { live.child.kill(); } catch {}
    live.state = "failed";
    live.error = "The CLI never reported being signed in after the code was sent.";
  }, 4000);
  watchSession.unref?.();
  child.on("close", () => clearInterval(watchSession));
  return session;
};

const publicSession = (s) => ({
  id: s.id, agent: s.agentId, state: s.state, url: s.url, code: s.code, qr: s.qr ?? null,
  needsCode: s.needsCode, error: s.error,
  tail: s.output.trim().split("\n").slice(-4).join("\n"),
});

const setApiKey = async (agentId, key, providerId) => {
  const agent = AGENTS[agentId];
  if (!agent?.apiKey) throw new Error(`${agentId} does not take a stored API key`);
  if (!key || key.length > 500) throw new Error("Enter a key");

  if (agent.apiKey.kind === "stdin") {
    await new Promise((resolve, reject) => {
      const child = spawn(agent.apiKey.argv[0], agent.apiKey.argv.slice(1), {
        env: process.env, stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { out += c; });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(stripAnsi(out).trim().slice(-200) || "login failed")));
      child.stdin.end(`${key}\n`);
    });
    forgetSignInState();
    return { ok: true };
  }

  // OpenCode reads credentials from a file, which is far steadier than driving
  // its picker; verified by writing one and having `opencode auth list` see it.
  if (agent.apiKey.kind === "opencode") {
    // Dots are in the catalog too (wafer.ai), and this only ever becomes a key
    // in a JSON object, never a path segment.
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(String(providerId ?? "")))
      throw new Error("Choose a provider (e.g. anthropic, openai, deepseek)");
    const dir = `${process.env.HOME}/.local/share/opencode`;
    await mkdir(dir, { recursive: true });
    let current = {};
    try { current = JSON.parse(await readFile(`${dir}/auth.json`, "utf8")); } catch {}
    current[providerId] = { type: "api", key };
    await writeFile(`${dir}/auth.json`, JSON.stringify(current, null, 2), { mode: 0o600 });
    forgetSignInState();
    return { ok: true };
  }
  throw new Error("unsupported");
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23111'/%3E%3Ctext x='16' y='22' font-family='ui-monospace,monospace' font-size='16' font-weight='700' fill='%23fff' text-anchor='middle'%3ET3%3C/text%3E%3C/svg%3E">
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

<div class="card"><h2>Agents</h2>
  <p class="hint">Sign in here, or set an API key. Credentials are stored on the
  state volume, so they survive the container being recreated.</p>
  <div id="agents"><div class="skeleton" style="width:55%"></div></div>
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
  // Both a sign-in and a key form render into the agent's row, and the periodic
  // refresh rebuilds that list. It has to leave the row alone while either is
  // open, or the URL, the QR, the code field - or the key you are halfway
  // through pasting - vanish under you a few seconds after they appear.
  let panelActive = null;
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
    $('status').innerHTML = '<dl>' + rows.map(([k, v]) =>
      '<div class="kv"><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('') + '</dl>' +
      (s.publicUrl ? '' : '<div class="notice warn">Without T3_PUBLIC_URL, pairing links ' +
        "point at this container's own address and no device can reach them.</div>");

    if (!panelActive) $('agents').innerHTML = '<div class="rows">' + s.harnesses.map((h) => {
      const status = !h.installed ? '<span class="bad">Not installed</span>'
        : h.signedIn === true ? '<span class="ok"><span class="dot"></span>Signed in</span>'
        : h.signedIn === false ? '<span class="warn">Not signed in</span>'
        : '<span class="meta">Sign-in state not readable</span>';
      const actions = !h.installed ? '' :
        (h.canSignIn ? '<button class="ghost tiny signin" data-agent="' + h.id + '">Sign in</button>' : '') +
        (h.canSetKey ? '<button class="ghost tiny setkey" data-agent="' + h.id +
           '" data-kind="' + esc(h.keyKind) + '">API key</button>' : '');
      return '<div class="row"><div class="main"><div class="name">' + esc(h.name) +
        '</div><div class="meta">' + status + '</div>' +
        '<div id="agent-' + h.id + '"></div></div>' +
        '<div style="display:flex;gap:6px">' + actions + '</div></div>';
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
          '<div class="controls" style="margin-top:8px;flex-wrap:wrap">' + providerField +
          '<input class="kv-key" type="password" placeholder="API key" style="flex:1 1 150px" />' +
          '<button class="tiny save">Save</button>' +
          '<button class="ghost tiny cancelkey">Cancel</button></div><div class="out"></div>';
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
            box.innerHTML =
              '<p class="meta" style="margin:8px 0 0">Open this on any device and approve:</p>' +
              '<div class="link">' + esc(st.url) + '</div>' +
              '<div class="controls"><a href="' + esc(st.url) + '" target="_blank" rel="noopener">' +
              '<button class="ghost tiny">Open</button></a>' +
              (st.code ? '<span class="meta">Confirm code <strong>' + esc(st.code) + '</strong></span>' : '') +
              '<button class="ghost tiny cancel">Cancel</button></div>' +
              (st.qr ? '<div class="qr">' + st.qr + '</div>' : '') +
              (st.needsCode ? '<div class="controls" style="margin-top:8px">' +
                 '<input class="codein" placeholder="Paste the code from your browser" style="flex:1 1 180px" />' +
                 '<button class="tiny sendcode">Submit</button></div>' : '');
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
  load();
  setInterval(load, 15000);
}
</script></body></html>`;

const ROUTES = ["/login", "/status", "/pair", "/revoke",
  "/auth/apikey", "/auth/signin", "/auth/session", "/auth/code", "/auth/cancel",
  "/providers"];

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


    if (req.method === "GET" && route === "/providers") {
      return sendJson(res, 200, {
        providers: await providers(),
        configured: await configuredProviders(),
      });
    }
    if (req.method === "POST" && route === "/auth/apikey") {
      try {
        const input = JSON.parse((await readBody(req)) || "{}");
        return sendJson(res, 200, await setApiKey(input.agent, input.key, input.provider));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    if (req.method === "POST" && route === "/auth/signin") {
      try {
        const input = JSON.parse((await readBody(req)) || "{}");
        return sendJson(res, 200, publicSession(startSignin(input.agent)));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    if (route === "/auth/session") {
      const session = sessions.get(new URL(req.url ?? "/", "http://x").searchParams.get("id"));
      if (!session) return sendJson(res, 404, { error: "no such session" });
      return sendJson(res, 200, publicSession(session));
    }

    if (req.method === "POST" && route === "/auth/code") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const session = sessions.get(input.id);
      if (!session) return sendJson(res, 404, { error: "no such session" });
      try {
        // A carriage return, not a newline. These prompts run the terminal in
        // raw mode, where Enter arrives as CR; an LF is accepted as part of the
        // text and the prompt just sits there. The characters showed up as
        // asterisks and nothing ever happened.
        session.child.stdin.write(`${String(input.code ?? "").trim()}\r`);
        session.state = "submitted";
        session.submittedAt = Date.now();
        return sendJson(res, 200, publicSession(session));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    if (req.method === "POST" && route === "/auth/cancel") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const session = sessions.get(input.id);
      if (session) {
        session.state = "cancelled";
        try { session.child.kill(); } catch {}
      }
      return sendJson(res, 200, { ok: true });
    }

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
