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
const CONSOLE_CSS = readFileSync(new URL("./console.css", import.meta.url), "utf8");

// Resolve the theme before first paint. Left to the client script, the page
// flashes light for as long as it takes to parse, which on a phone over a
// tunnel is long enough to see. Kept tiny and inline for that reason.
const THEME_BOOT = `(function(){try{var m=localStorage.getItem("t3-console-theme")||"system";` +
  `var d=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;` +
  `document.documentElement.setAttribute("data-theme",d);` +
  `document.documentElement.setAttribute("data-theme-mode",m);}catch(e){}})();`;

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
    // The footer states where things live. Read them rather than printing a
    // plausible-looking default: a wrong path here is worse than no path.
    paths: {
      // What you mount is the home directory; the state dir lives inside it.
      volume: STATE_DIR.replace(/\/\.t3\/?$/, "") || STATE_DIR,
      state: STATE_DIR,
      workspace: process.env.T3_WORKSPACE || "/workspace",
      pairTtl: process.env.T3_PAIR_TTL || "30d",
    },
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
<meta name="color-scheme" content="light dark">
<title>T3 Code setup</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23111'/%3E%3Ctext x='16' y='22' font-family='ui-monospace,monospace' font-size='16' font-weight='700' fill='%23fff' text-anchor='middle'%3ET3%3C/text%3E%3C/svg%3E">
<style>${CONSOLE_CSS}</style>
<script>${THEME_BOOT}</script>
</head><body>
<div class="console-top">
<header class="tc-chrome">
  <div class="tc-wrap tc-wrap--wide tc-chrome-in">
    <div class="tc-brand">
      <span class="tc-mark" aria-hidden="true"></span>
      <span class="tc-brand-name">T3 Code</span>
      <span class="tc-brand-sub">setup</span>
    </div>
    <div class="tc-chrome-spacer"></div>
    ${authed ? `<span class="tc-tag tc-tag--mono" id="build"
      title="Image this container was built from">&mdash;</span>
    <span class="tc-health" id="health" role="status" aria-live="polite">Checking&hellip;</span>` : ""}
    <button type="button" class="tc-iconbtn" id="theme-btn"
      title="Switch color theme" aria-label="Switch color theme"></button>
  </div>
</header>
${authed ? `<div class="tc-strip"><div class="tc-wrap tc-wrap--wide tc-strip-in" id="strip"></div></div>` : ""}
</div>
<main class="tc-wrap tc-wrap--wide tc-main">
${
  authed
    ? `<h1 class="tc-sr">T3 Code setup console</h1>
<div class="tc-deck">
  <div class="tc-deck-col">

    <section class="tc-card tc-card--hero">
      <div class="tc-cardhead">
        <h2 class="tc-eyebrow">Pair a device</h2>
        <div class="tc-cardhead-spacer"></div>
        <p class="tc-cardhead-note">A phone is enough &mdash; no shell, no restart.</p>
      </div>
      <div class="tc-cardbody">
        <p class="tc-lede">Creates a single-use link for one device. Scan it with the
        T3 Code app, or open it in a browser.</p>
        <div class="pair-controls">
          <div class="tc-seg" id="ttl" role="group" aria-label="How long the link stays valid">
            <button type="button" data-ttl="1h">1 hour</button>
            <button type="button" data-ttl="7d">7 days</button>
            <button type="button" data-ttl="30d" aria-pressed="true">30 days</button>
          </div>
          <input id="label" class="tc-input grow" placeholder="Label, e.g. my phone"
            aria-label="Device label" />
          <button type="button" class="tc-btn tc-btn--primary" id="mint">Create pairing link</button>
        </div>
        <div id="out" aria-live="polite"></div>
      </div>
    </section>

    <section class="tc-card">
      <div class="tc-cardhead">
        <h2 class="tc-eyebrow">Agents</h2>
        <div class="tc-cardhead-spacer"></div>
        <p class="tc-cardhead-note" id="agent-count"></p>
      </div>
      <div class="tc-list" id="agents"><div class="tc-row"><span class="tc-skel"
        style="width:44%"></span></div><div class="tc-row"><span class="tc-skel"
        style="width:33%"></span></div></div>
    </section>

  </div>
  <div class="tc-deck-col">

    <section class="tc-card">
      <div class="tc-cardhead">
        <h2 class="tc-eyebrow">Ports</h2>
        <div class="tc-cardhead-spacer"></div>
        <p class="tc-cardhead-note" id="portnote"></p>
      </div>
      <div class="tc-list" id="ports"><div class="tc-row"><span class="tc-skel"
        style="width:38%"></span></div></div>
      <div class="tc-cardfoot" id="portfoot">A published URL is public while it is up.
        Take it down when you are done.</div>
    </section>

    <section class="tc-card">
      <div class="tc-cardhead">
        <h2 class="tc-eyebrow">Sessions</h2>
        <div class="tc-cardhead-spacer"></div>
        <p class="tc-cardhead-note" id="sessioncount"></p>
      </div>
      <div class="tc-grouphead">Devices</div>
      <div class="tc-list" id="clients"><div class="tc-row"><span class="tc-skel"
        style="width:56%"></span></div></div>
      <div class="tc-grouphead">Unused links</div>
      <div class="tc-list" id="links"><div class="tc-row"><span class="tc-skel"
        style="width:40%"></span></div></div>
    </section>

  </div>
</div>
<div class="tc-details" id="details"></div>`
    : `<section class="tc-card tc-card--pad" style="max-width:34rem;margin:8vh auto 0">
  <h2 style="font-size:22px;letter-spacing:-.02em;margin:0 0 6px">Unlock the console.
    <span style="color:var(--muted);font-weight:400;font-size:15px">one key, then you pair</span></h2>
  <p class="tc-lede" style="margin-bottom:20px">This page is the only door to the setup
  console. The key is <span class="tc-mono">T3_SETUP_KEY</span> from this container's
  environment &mdash; set by you, or generated at boot and printed to the log.</p>
  <form method="POST" action="${mount}/login" class="tc-stack">
    <div class="tc-field">
      <label class="tc-label" for="key">Setup key</label>
      <input class="tc-input tc-input--mono" id="key" name="key" type="password"
        placeholder="Paste the setup key" autofocus autocomplete="current-password" />
      <span class="tc-hint">Treat it like a password &mdash; anything it can do, a
        pairing link can do.</span>
    </div>
    <button class="tc-btn tc-btn--primary tc-btn--lg tc-btn--block" type="submit">Unlock console</button>
  </form>
</section>
<div class="tc-details" style="max-width:34rem;margin:20px auto 0;border:0;padding-top:0">
  <div class="tc-details-item"><span class="tc-details-value tc-mono">port ${
    process.env.T3_SETUP_PORT ?? 3774} · setup</span></div>
  <div class="tc-details-item"><span class="tc-details-value">Credentials never leave
    this container.</span></div>
</div>`
}
</main>
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
