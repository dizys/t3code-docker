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
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const run = promisify(execFile);

// Read verbatim rather than embedded in a template literal: see the note at the
// top of app.js for what that cost twice.
const CLIENT_JS = readFileSync(new URL("./app.js", import.meta.url), "utf8");

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
    const { stdout, stderr } = await run("grok", ["models"], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
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
const PROBE_TIMEOUT_MS = 20_000;
// Last definite answer per agent. Five CLIs probed at once contend for the box,
// and the slowest two - Claude and Cursor - can miss the deadline even though
// each takes well under it alone. A missed deadline is not news about anyone's
// credentials, so it must not turn a known "Not signed in" into "not readable".
const lastKnown = new Map();
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
    out = await run(bin, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
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

/** signedInState, but a probe that could not answer keeps the last real one. */
const stableSignedIn = async (h) => {
  const now = await signedInState(h);
  if (now === null) return lastKnown.has(h.id) ? lastKnown.get(h.id) : null;
  lastKnown.set(h.id, now);
  return now;
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
      signedIn: installed ? await stableSignedIn(h) : null,
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
    image: {
      version: process.env.T3_IMAGE_VERSION || null,
      variant: process.env.T3_IMAGE_VARIANT || null,
    },
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
/* Tokens and shape lifted from T3 Code's own stylesheet so this page reads as
   part of the same product: its zinc ramp, its 0.625rem radius, and its
   app-chrome/toolbar split between the bar at the top and the content below. */
:root{
  color-scheme:light dark;
  --background:oklch(99.2% 0 0);
  --foreground:oklch(0.274 0.006 286.033);
  --card:#fff;
  --muted:oklch(0.985 0 0);
  --muted-foreground:oklch(0.552 0.016 285.938);
  --subtle-foreground:oklch(0.646 0.014 285.9);
  --border:oklch(0.92 0.004 286.32);
  --hairline:oklch(0.945 0.003 286.32);
  --input:oklch(0.871 0.006 286.286);
  --primary:oklch(0.488 0.217 264);
  --primary-foreground:#fff;
  --accent:oklch(0.967 0.001 286.375);
  --chrome:color-mix(in srgb, oklch(99.2% 0 0) 82%, transparent);
  --success-foreground:oklch(0.508 0.118 165.612);
  --success-surface:color-mix(in srgb, oklch(0.696 0.17 162.48) 11%, transparent);
  --warning-foreground:oklch(0.555 0.163 48.998);
  --warning-surface:color-mix(in srgb, oklch(0.769 0.188 70.08) 10%, transparent);
  --error:oklch(0.637 0.237 25.331);
  --error-foreground:oklch(0.505 0.213 27.518);
  --error-surface:color-mix(in srgb, oklch(0.637 0.237 25.331) 8%, transparent);
  --shadow-raised:0 1px 2px oklch(0 0 0/.04), 0 1px 1px oklch(0 0 0/.03);
  --shadow-pop:0 4px 16px -4px oklch(0 0 0/.10), 0 1px 2px oklch(0 0 0/.04);
  --radius:0.625rem;
  --control-radius:0.5rem;
  --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  /* Agent identity is deliberately low-chroma: it separates five rows at a
     glance without competing with the saturated colours that carry state. */
  --id-claude:oklch(0.70 0.075 55);
  --id-codex:oklch(0.62 0.035 265);
  --id-opencode:oklch(0.64 0.062 175);
  --id-cursor:oklch(0.62 0.062 300);
  --id-grok:oklch(0.60 0.045 230);
}
@media (prefers-color-scheme:dark){:root{
  --background:oklch(0.145 0 0);
  --foreground:oklch(0.97 0 0);
  --card:color-mix(in srgb, oklch(0.145 0 0) 96%, #fff);
  --muted:rgb(255 255 255/3.5%);
  --muted-foreground:color-mix(in srgb, oklch(0.556 0 0) 92%, #fff);
  --subtle-foreground:oklch(0.53 0 0);
  --border:rgb(255 255 255/7%);
  --hairline:rgb(255 255 255/5%);
  --input:rgb(255 255 255/9%);
  --primary:oklch(0.571 0.21 264);
  --accent:rgb(255 255 255/5%);
  --chrome:color-mix(in srgb, oklch(0.145 0 0) 82%, transparent);
  --success-foreground:oklch(0.765 0.177 163.223);
  --success-surface:color-mix(in srgb, oklch(0.696 0.17 162.48) 17%, transparent);
  --warning-foreground:oklch(0.828 0.189 84.429);
  --warning-surface:color-mix(in srgb, oklch(0.769 0.188 70.08) 15%, transparent);
  --error-foreground:oklch(0.704 0.191 22.216);
  --error-surface:color-mix(in srgb, oklch(0.637 0.237 25.331) 16%, transparent);
  --shadow-raised:0 1px 2px oklch(0 0 0/.30);
  --shadow-pop:0 8px 28px -8px oklch(0 0 0/.65), 0 1px 2px oklch(0 0 0/.30);
  --id-claude:oklch(0.72 0.075 55);
  --id-codex:oklch(0.70 0.030 265);
  --id-opencode:oklch(0.70 0.060 175);
  --id-cursor:oklch(0.70 0.060 300);
  --id-grok:oklch(0.68 0.045 230);
}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--background);color:var(--foreground);
  font-family:var(--font-sans);font-size:14px;line-height:1.5;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}

/* --- app chrome ---------------------------------------------------------
   A real bar rather than a row of text: it stays put while you scroll, which
   is what keeps "which image am I on" answerable at any point on the page. */
.chrome{position:sticky;top:0;z-index:10;background:var(--chrome);
  -webkit-backdrop-filter:saturate(180%) blur(12px);backdrop-filter:saturate(180%) blur(12px);
  border-bottom:1px solid var(--hairline)}
.chrome-in{max-width:820px;margin:0 auto;padding:11px 24px;
  display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px;min-width:0}
.mark{width:26px;height:26px;border-radius:8px;flex:none;
  background:linear-gradient(160deg,color-mix(in srgb,var(--primary) 88%,#fff),var(--primary));
  color:#fff;display:grid;place-items:center;font-size:10.5px;font-weight:700;
  letter-spacing:-.03em;box-shadow:inset 0 1px 0 rgb(255 255 255/.28)}
.brand h1{font-size:14.5px;font-weight:600;margin:0;letter-spacing:-.015em;white-space:nowrap}
.brand .sub{color:var(--subtle-foreground);font-size:13px;white-space:nowrap}
.chrome .spacer{flex:1 1 auto}
.tag{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:7px;
  border:1px solid var(--hairline);background:var(--muted);color:var(--muted-foreground);
  font-size:11.5px;font-weight:500;white-space:nowrap}
.tag.mono{font-family:var(--font-mono);letter-spacing:-.02em}

main{max-width:820px;margin:0 auto;padding:26px 24px 72px}

/* --- section rhythm -----------------------------------------------------
   Titles sit outside their surface. Cards then hold content instead of being
   five labelled boxes of identical weight, which is what made the page read
   as a form dump rather than a layout. */
section{margin-bottom:30px}
section:last-child{margin-bottom:0}
.head{display:flex;align-items:baseline;gap:10px;margin:0 2px 10px;flex-wrap:wrap}
.head h2{font-size:12px;font-weight:600;margin:0;letter-spacing:.055em;
  text-transform:uppercase;color:var(--muted-foreground)}
.head .note{font-size:12.5px;color:var(--subtle-foreground);margin:0}
.head .spacer{flex:1 1 auto}

.surface{background:var(--card);border:1px solid var(--border);
  border-radius:var(--radius);box-shadow:var(--shadow-raised)}
.surface.pad{padding:18px}
.lede{margin:0 0 14px;color:var(--muted-foreground);font-size:13px;max-width:62ch}
.hero{box-shadow:var(--shadow-pop)}

.grid{display:grid;gap:16px 16px;grid-template-columns:1fr;margin-bottom:30px}
.grid>section{margin-bottom:0}
@media (min-width:720px){.grid{grid-template-columns:1fr 1fr}}

/* --- controls ----------------------------------------------------------- */
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.controls>.grow{flex:1 1 160px;min-width:0}
button,select,input{font:inherit;border-radius:var(--control-radius);
  border:1px solid var(--input);background:var(--card);color:var(--foreground);
  padding:8px 11px;transition:background .14s ease,border-color .14s ease,
  box-shadow .14s ease,opacity .14s ease,transform .14s ease}
input::placeholder{color:var(--subtle-foreground)}
input:hover:not(:disabled),select:hover:not(:disabled){border-color:var(--muted-foreground)}
button{border-color:transparent;background:var(--primary);color:var(--primary-foreground);
  font-weight:550;cursor:pointer;padding:8px 15px;box-shadow:var(--shadow-raised)}
button:hover:not(:disabled){filter:brightness(1.07)}
button:active:not(:disabled){transform:translateY(.5px)}
button.ghost{background:var(--card);color:var(--foreground);border-color:var(--input);
  box-shadow:none;font-weight:500}
button.ghost:hover:not(:disabled){background:var(--accent);filter:none}
button.tiny{padding:5px 10px;font-size:12.5px;border-radius:7px}
button:disabled{opacity:.55;cursor:default}
:where(button,select,input,a):focus-visible{outline:2px solid var(--primary);outline-offset:2px}
select{cursor:pointer}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}

/* --- lists -------------------------------------------------------------- */
.rows{display:flex;flex-direction:column}
.row{display:flex;align-items:center;gap:12px;padding:12px 18px;
  border-top:1px solid var(--hairline);flex-wrap:wrap;transition:background .14s ease}
.row:first-child{border-top:0}
.row:hover{background:color-mix(in srgb,var(--accent) 60%,transparent)}
.row .main{flex:1 1 130px;min-width:0}
.row .name{font-weight:550;letter-spacing:-.01em}
.row .meta{color:var(--subtle-foreground);font-size:12.5px;margin-top:1px}
.row .actions{display:flex;gap:6px;flex:none;margin-left:auto}
.nameline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* An agent's monogram makes five rows distinguishable before you read them. */
.mono-tile{width:30px;height:30px;border-radius:9px;flex:none;display:grid;place-items:center;
  font-size:12px;font-weight:650;letter-spacing:-.02em;color:#fff;
  background:var(--tile,var(--muted-foreground));
  box-shadow:inset 0 1px 0 rgb(255 255 255/.22)}

.chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;
  font-size:11.5px;font-weight:500;line-height:1.7;white-space:nowrap}
.chip.ok{background:var(--success-surface);color:var(--success-foreground)}
.chip.warn{background:var(--muted);color:var(--muted-foreground)}
.chip.warn .dot{background:var(--warning-foreground)}
.chip.bad{background:var(--error-surface);color:var(--error-foreground)}
.chip.idle{background:var(--muted);color:var(--subtle-foreground)}

/* A panel opens under its row, full width, so acting on one agent never
   reflows the row you clicked. */
.panel{flex:1 0 100%;margin-top:2px}
.panel:empty{display:none}
.panel-in{background:var(--muted);border:1px solid var(--hairline);
  border-radius:var(--control-radius);padding:14px;margin-top:10px}

.empty{margin:0;padding:20px 18px;text-align:center;color:var(--subtle-foreground);
  font-size:13px}

/* --- pairing result ----------------------------------------------------- */
.result{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-top:14px}
.result .col{flex:1 1 260px;min-width:0}
.link{font-family:var(--font-mono);font-size:12.5px;word-break:break-all;
  background:var(--muted);border:1px solid var(--hairline);
  border-radius:var(--control-radius);padding:11px 12px;line-height:1.5}
/* Ports. The tile carries the number itself rather than a monogram - a port
   is already its own label, and nothing else on the page is a number. */
.mono-tile.port{background:var(--muted);color:var(--muted-foreground);border:1px solid var(--border);
  font-size:11px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.portlive{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:6px}
.porturl{font-family:var(--font-mono);font-size:12.5px;color:var(--primary);
  word-break:break-all;text-decoration:none}
.porturl:hover{text-decoration:underline}
.portlive .qr svg{width:min(104px,30vw)}
.meta.err{color:var(--error-foreground)}
a.btn{display:inline-flex;align-items:center;text-decoration:none}
a.btn.ghost:hover{background:var(--accent)}
.qr{background:#fff;border:1px solid var(--border);border-radius:var(--control-radius);
  padding:10px;line-height:0;flex:none;box-shadow:var(--shadow-raised)}
.qr svg{width:min(168px,46vw);height:auto;display:block;shape-rendering:crispEdges}

/* --- key/value ---------------------------------------------------------- */
dl{margin:0}
.kv{display:flex;justify-content:space-between;gap:16px;padding:11px 18px;
  border-top:1px solid var(--hairline);font-size:13px}
.kv:first-child{border-top:0}
.kv dt{color:var(--muted-foreground);margin:0;flex:none}
.kv dd{margin:0;text-align:right;font-weight:500;min-width:0;overflow-wrap:anywhere}
.kv dd.mono{font-family:var(--font-mono);font-size:12.5px}

.dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;
  vertical-align:1px;background:currentColor;flex:none}
.chip .dot,.tag .dot{margin-right:0}
.ok{color:var(--success-foreground)}
.warn{color:var(--warning-foreground)}
.bad{color:var(--error-foreground)}
.notice{border-radius:var(--control-radius);padding:10px 12px;font-size:12.5px;margin:12px 18px 14px}
.notice.err{background:var(--error-surface);color:var(--error-foreground)}
.notice.warn{background:var(--warning-surface);color:var(--warning-foreground)}
.skeleton{height:12px;border-radius:5px;background:var(--muted);margin:14px 18px;
  animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.45}}

/* --- unlock ------------------------------------------------------------- */
.login{max-width:380px;margin:14vh auto 0}
.login h2{font-size:16px;font-weight:600;margin:0 0 4px;letter-spacing:-.02em}
@media (max-width:560px){
  .chrome-in{padding:10px 16px}
  main{padding:20px 16px 56px}
  .surface.pad{padding:15px}
  .row{padding:12px 15px}
  .kv{padding:10px 15px}
}
</style></head><body>
<header class="chrome"><div class="chrome-in">
  <div class="brand"><div class="mark">T3</div>
    <h1>T3 Code</h1><span class="sub">setup</span></div>
  <div class="spacer"></div>
  ${authed ? `<span class="tag mono" id="build" title="Image this container was built from">&mdash;</span>
  <span class="tag" id="health"><span class="dot" style="background:var(--subtle-foreground)"></span>Checking</span>` : ""}
</div></header>
<main>
${
  authed
    ? `<section>
  <div class="head"><h2>Pair a device</h2></div>
  <div class="surface hero pad">
    <p class="lede">Creates a single-use link for one device. Scan it with the T3 Code
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
</section>

<section>
  <div class="head"><h2>Agents</h2>
    <p class="note">Credentials live on the state volume and survive a recreate.</p></div>
  <div class="surface"><div id="agents"><div class="skeleton" style="width:44%"></div>
    <div class="skeleton" style="width:33%"></div></div></div>
</section>

<section>
  <div class="head"><h2>Ports</h2>
    <p class="note" id="portnote">Publish a dev server running in this container.</p></div>
  <div class="surface"><div id="ports"><div class="skeleton" style="width:38%"></div></div></div>
</section>

<div class="grid">
  <section>
    <div class="head"><h2>Devices</h2>
      <p class="note" id="devcount"></p></div>
    <div class="surface"><div id="clients"><div class="skeleton" style="width:56%"></div></div></div>
  </section>

  <section>
    <div class="head"><h2>Unused links</h2>
      <p class="note" id="linkcount"></p></div>
    <div class="surface"><div id="links"><div class="skeleton" style="width:40%"></div></div></div>
  </section>
</div>

<section>
  <div class="head"><h2>Environment</h2></div>
  <div class="surface"><div id="status"><div class="skeleton" style="width:64%"></div>
    <div class="skeleton" style="width:48%"></div></div></div>
</section>`
    : `<div class="login"><div class="surface pad">
  <h2>Setup key</h2>
  <p class="lede">The value of <code>T3_SETUP_KEY</code> from this container's
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
<script>window.__T3_SETUP_BASE__ = ${JSON.stringify(mount)};</script>
<script>${CLIENT_JS}</script></body></html>`;

// ---------------------------------------------------------------------------
// Ports
//
// A dev server started inside the container - by the user in a T3 Code terminal
// or by an agent - listens on a port nothing outside the container can reach.
// The whole premise here is that a phone is enough, so "now SSH in and forward
// a port" is not an answer. cloudflared publishes it instead: one click, a
// public https URL, and a QR code to open it on the device in your hand.
//
// This module is the only place tunnels are started or stopped. `t3-expose`
// does not run cloudflared itself - it calls this API - so the terminal and the
// page cannot hold different ideas about what is exposed.
// ---------------------------------------------------------------------------

const CLOUDFLARED = process.env.T3CODE_CLOUDFLARED_PATH || "cloudflared";
const STATE_DIR = process.env.T3CODE_HOME || `${process.env.HOME || "/home/t3"}/.t3`;
const EXPOSED_FILE = `${STATE_DIR}/exposed-ports.json`;

// Ports that belong to the container's own plumbing rather than to anything a
// user started. Exposing the setup page itself would be a foot-gun.
const RESERVED = new Set([PORT, Number(process.env.T3CODE_PORT ?? 3773)]);

/** Ports currently in LISTEN state, whatever interface they bound to. */
const listeningPorts = async () => {
  // A dev server bound to 127.0.0.1 is the normal case and the one that most
  // needs a tunnel, so loopback-only listeners are included deliberately.
  // -p names the owning process, which is how cloudflared's own metrics
  // listener gets filtered out: publishing a port opened a second "port" in
  // this list, which is confusing and not something anyone would want to expose.
  const { stdout } = await run("ss", ["-H", "-l", "-t", "-n", "-p"]).catch(() => ({ stdout: "" }));
  const found = new Map();
  for (const line of stdout.split("\n")) {
    if (/"cloudflared"/.test(line)) continue;
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port <= 0 || RESERVED.has(port)) continue;
    // ss lists one row per bound address; a server on :: and 0.0.0.0 is one port.
    found.set(port, (found.get(port) ?? 0) + 1);
  }
  return [...found.keys()].sort((a, b) => a - b);
};

/** port -> { port, state, url, error, startedAt, child } */
const tunnels = new Map();

const publicTunnel = ({ port, state, url, error, startedAt, qr }) =>
  ({ port, state, url: url ?? null, error: error ?? null,
     startedAt: startedAt ?? null, qr: qr ?? null });

// Written for anything that wants to read the state without asking the server -
// a status line, a doctor check, a human with `cat`. The API is the source of
// truth; this file only ever mirrors it.
const persistExposed = () => {
  try {
    const live = [...tunnels.values()]
      .filter((t) => t.state === "open")
      .map(({ port, url, startedAt }) => ({ port, url, startedAt }));
    writeFileSync(EXPOSED_FILE, `${JSON.stringify({ exposed: live }, null, 2)}\n`, { mode: 0o600 });
  } catch { /* the state volume may be read-only; the API still works */ }
};

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

// cloudflared retries a blocked edge forever rather than exiting, so without
// this a firewalled network shows a spinner that never resolves and a CLI that
// times out saying nothing useful. Its own precheck already knows: it reports
// hard_fail when neither QUIC nor HTTP/2 can reach the edge. Say so instead.
const EDGE_UNREACHABLE = /precheck complete.*hard_fail=true/i;
// A hostname is assigned before any connection to the edge is established, so
// the URL alone is not proof the tunnel carries traffic - on a network that
// blocks the edge you get a name that answers 530. cloudflared logs this line
// when a connection is actually up, and T3 Code watches for the same one.
const EDGE_REGISTERED = /Registered tunnel connection/i;
const EDGE_MESSAGE =
  "cannot reach the Cloudflare edge from this network - it needs outbound "
  + "UDP 7844, or HTTP/2 to argotunnel.com";

const startTunnel = (rawPort) => {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be between 1 and 65535");
  }
  if (RESERVED.has(port)) {
    throw new Error(`port ${port} belongs to T3 Code itself`);
  }
  const existing = tunnels.get(port);
  if (existing && existing.state !== "failed") return existing;

  const child = spawn(CLOUDFLARED, [
    "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const tunnel = { port, state: "starting", url: null, error: null, startedAt: Date.now(), child };
  tunnels.set(port, tunnel);

  // cloudflared prints the assigned hostname to stderr, banner-style. Watch both
  // streams rather than guessing which release writes where.
  const watch = (chunk) => {
    const text = String(chunk);
    const match = text.match(QUICK_TUNNEL_URL);
    if (match) tunnel.url ??= match[0];
    if (EDGE_REGISTERED.test(text)) tunnel.registered = true;

    // Open means both: a hostname to hand out, and a connection to carry it.
    if (tunnel.url && tunnel.registered && tunnel.state !== "open") {
      tunnel.state = "open";
      persistExposed();
      // Rendered here rather than in the browser for the same reason pairing
      // does it: qrencode is already in the image, and the device that needs
      // to scan this is rarely the one showing the page.
      run("qrencode", ["-t", "SVG", "-m", "1", "-o", "-", tunnel.url])
        .then(({ stdout }) => { tunnel.qr = stdout; })
        .catch(() => { tunnel.qr = null; });
    }
    tunnel.log = `${(tunnel.log ?? "") + text}`.slice(-4000);

    if (tunnel.state === "starting" && EDGE_UNREACHABLE.test(tunnel.log)) {
      tunnel.state = "failed";
      tunnel.error = EDGE_MESSAGE;
      try { tunnel.child.kill(); } catch { /* already gone */ }
      persistExposed();
    }
  };
  child.stdout.on("data", watch);
  child.stderr.on("data", watch);

  child.on("exit", (code) => {
    // A tunnel we stopped on purpose is already gone from the map.
    if (tunnels.get(port) !== tunnel) return;
    if (tunnel.state === "failed") return;   // already diagnosed above
    tunnel.state = "failed";
    tunnel.error = tunnel.url
      ? `tunnel closed unexpectedly (exit ${code})`
      : firstUsefulLine(tunnel.log) || `cloudflared exited ${code}`;
    tunnel.url = null;
    persistExposed();
  });
  child.on("error", (error) => {
    tunnel.state = "failed";
    tunnel.error = String(error?.message ?? error);
    persistExposed();
  });

  return tunnel;
};

// cloudflared is chatty; surface the line that actually says what went wrong.
const firstUsefulLine = (log) => {
  for (const line of String(log ?? "").split("\n")) {
    const text = line.replace(/^\S+Z\s+/, "").trim();
    if (/ERR|error|failed|refused/i.test(text)) return text.slice(0, 200);
  }
  return "";
};

const stopTunnel = (rawPort) => {
  const port = Number(rawPort);
  const tunnel = tunnels.get(port);
  if (!tunnel) return { ok: false, error: `port ${port} is not exposed` };
  tunnels.delete(port);
  try { tunnel.child.kill("SIGTERM"); } catch { /* already gone */ }
  persistExposed();
  return { ok: true, port };
};

const portsStatus = async () => ({
  // `available` means cloudflared can run at all; the page says so plainly
  // rather than letting every Expose click fail with the same opaque error.
  available: existsSync(CLOUDFLARED) || CLOUDFLARED === "cloudflared",
  listening: await listeningPorts(),
  tunnels: [...tunnels.values()].map(publicTunnel),
});

const ROUTES = ["/login", "/status", "/pair", "/revoke", "/ports",
  "/ports/expose", "/ports/unexpose",
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
  // The page sends a cookie; the in-container CLIs send a header. Same key,
  // same comparison - so `t3-expose` and the page are the same client as far
  // as this server is concerned, and neither can act on state the other cannot.
  const authed = keyMatches(cookieFrom(req)) || keyMatches(req.headers["x-t3-setup-key"]);

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

    if (req.method === "GET" && route === "/ports") {
      return sendJson(res, 200, await portsStatus());
    }
    if (req.method === "POST" && route === "/ports/expose") {
      try {
        const input = JSON.parse((await readBody(req)) || "{}");
        return sendJson(res, 200, publicTunnel(startTunnel(input.port)));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }
    if (req.method === "POST" && route === "/ports/unexpose") {
      try {
        const input = JSON.parse((await readBody(req)) || "{}");
        const result = stopTunnel(input.port);
        return sendJson(res, result.ok ? 200 : 404, result);
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }


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
