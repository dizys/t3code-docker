#!/usr/bin/env node
/*
 * The README's and the guides' pictures of the setup console, from the
 * console itself.
 *
 *   node scripts/readme-media.js [url] [key] [--out docs/media]
 *
 * Point it at a running console (scripts/dev-console.mjs serves one at the
 * default address with the key "dev"). Like console-screens.js it shows the
 * console's own pages with sample data from scripts/fixtures/console, and
 * nothing it presses reaches the server. It writes:
 *
 *   setup-light.png, setup-dark.png   the README's picture: Overview at a
 *                                     desk and Agents on a phone, mid-setup
 *   ports-panel.png                   the Ports guide's list of ports
 *   files-light.png, files-dark.png   the Files guide's projects and details
 */
const fs = require("node:fs");
const path = require("node:path");
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }
const { statusFor, portsFor, routeConsole, unlock, visit } = require("./lib/console-fixtures.cjs");

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const BASE = positional[0] || "http://127.0.0.1:23780/__setup/";
const KEY = positional[1] || "dev";
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(__dirname, "..", "docs", "media");
const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";

// Mid-setup, as someone first sees it: an address set, no device yet, the
// last toolchains installing, two agents waiting to sign in and one update.
const heroStatus = () => statusFor("ready", (s, now) => {
  s.sessions = [];
  s.events = [];
  for (const id of ["grok", "cursor"]) {
    const h = s.harnesses.find((x) => x.id === id);
    Object.assign(h, { installed: true, runnable: true, signedIn: false, credentialsPresent: false, version: h.latestVersion, installedVersion: h.latestVersion });
  }
  Object.assign(s.harnesses.find((x) => x.id === "codex"), { latestVersion: "0.164.0" });
  s.setup = { state: "running", startedAt: now - 240_000, finishedAt: null, current: "rust",
    items: s.setup.items.map((item) => ({ ...item, state: item.id === "rust" ? "installing" : item.id === "uv" ? "pending" : "done",
      progress: item.id === "rust" ? { phase: "downloading", done: 151_000_000, total: 244_000_000 } : undefined })) };
  for (const t of s.toolchains) if (t.id === "rust" || t.id === "uv") Object.assign(t, { installed: false, version: null });
});

const heroPorts = () => portsFor("ready");

// Every state a port can be in, at once.
const panelPorts = () => portsFor("ready", (p, now) => ({
  available: true,
  listening: [3000, 5173, 5432, 8080],
  details: [
    { port: 3000, process: "next-server", address: "127.0.0.1", looksLikeDatabase: false },
    { port: 5173, process: "vite", address: "::1", looksLikeDatabase: false },
    { port: 5432, process: "postgres", address: "127.0.0.1", looksLikeDatabase: true },
    { port: 8080, process: "node", address: "0.0.0.0", looksLikeDatabase: false },
  ],
  tunnels: [
    { port: 3000, state: "open", url: "https://quiet-river-1234.trycloudflare.com", startedAt: now - 8 * 60_000 },
    { port: 5173, state: "starting" },
    { port: 8080, state: "failed", error: "Couldn’t reach Cloudflare. Publishing needs outbound UDP 7844 or HTTP/2 to argotunnel.com." },
  ],
}));

/** One page of the console, as a PNG in memory. */
const shoot = async (browser, { width, height, scale, theme, route, status, ports, clip }) => {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: theme, reducedMotion: "reduce" });
  const page = await context.newPage();
  await routeConsole(page, { status, ports });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await unlock(page, KEY);
  await visit(page, page, route);
  // A clipped section keeps a little of the page around it, so its card's edges show.
  const box = clip && await (await page.waitForSelector(clip)).boundingBox();
  const shot = await page.screenshot(box ? { clip: { x: box.x - 16, y: box.y - 12, width: box.width + 32, height: box.height + 28 } } : {});
  await context.close();
  return shot;
};

// The README's frame: a window and a phone on a soft field, in each theme.
const frame = (theme, desk, phone) => `<!doctype html><html><head><style>
  html, body { margin: 0; width: 1136px; height: 704px; overflow: hidden; }
  body { position: relative; background: ${theme === "dark"
    ? "radial-gradient(60rem 30rem at 30% 0%, #1b2233, transparent), linear-gradient(160deg, #0d1017, #111520)"
    : "radial-gradient(60rem 30rem at 30% 0%, #e6ebf8, transparent), linear-gradient(160deg, #eef1f8, #f8f9fc)"}; }
  .desk { position: absolute; left: 48px; top: 50%; transform: translateY(-50%); width: 760px; border-radius: 14px; overflow: hidden;
    border: 1px solid ${theme === "dark" ? "rgb(255 255 255 / 0.1)" : "rgb(15 23 42 / 0.1)"};
    box-shadow: 0 30px 60px -20px rgb(15 23 42 / ${theme === "dark" ? 0.6 : 0.25}), 0 2px 6px rgb(15 23 42 / 0.06); }
  .phone { position: absolute; right: 48px; top: 50%; transform: translateY(-50%); width: 212px; padding: 8px; border-radius: 40px;
    background: ${theme === "dark" ? "#22262f" : "#e7e9ee"}; border: 1px solid ${theme === "dark" ? "rgb(255 255 255 / 0.12)" : "rgb(15 23 42 / 0.12)"};
    box-shadow: 0 30px 60px -20px rgb(15 23 42 / ${theme === "dark" ? 0.7 : 0.3}); }
  .phone img { border-radius: 32px; }
  img { display: block; width: 100%; }
</style></head><body>
  <div class="desk"><img src="data:image/png;base64,${desk.toString("base64")}"></div>
  <div class="phone"><img src="data:image/png;base64,${phone.toString("base64")}"></div>
</body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    for (const theme of ["light", "dark"]) {
      // Keep the full grouped sidebar and its footer in view, including Gateways.
      const desk = await shoot(browser, { width: 1280, height: 860, scale: 2, theme, route: "overview", status: heroStatus, ports: heroPorts });
      const phone = await shoot(browser, { width: 390, height: 844, scale: 3, theme, route: "agents", status: heroStatus, ports: heroPorts });
      const context = await browser.newContext({ viewport: { width: 1136, height: 704 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      await page.setContent(frame(theme, desk, phone), { waitUntil: "load" });
      await page.screenshot({ path: path.join(OUT, `setup-${theme}.png`) });
      await context.close();
      console.log(path.join(OUT, `setup-${theme}.png`));
    }
    // The Files guide uses the same real page and synthetic Files routes.
    for (const theme of ["light", "dark"]) {
      const files = await shoot(browser, { width: 1440, height: 900, scale: 1, theme, route: "files", status: () => statusFor("ready"), ports: heroPorts });
      fs.writeFileSync(path.join(OUT, `files-${theme}.png`), files);
      console.log(path.join(OUT, `files-${theme}.png`));
    }
    const panel = await shoot(browser, { width: 1100, height: 900, scale: 2, theme: "light", route: "ports", status: heroStatus, ports: panelPorts, clip: "#page-ports [data-key='pl-title']" });
    fs.writeFileSync(path.join(OUT, "ports-panel.png"), panel);
    console.log(path.join(OUT, "ports-panel.png"));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
