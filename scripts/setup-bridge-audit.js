#!/usr/bin/env node
/*
 * End-to-end check of the setup bridge: T3 Code's own pages, with the console
 * routed beside them on one origin, driven in a real browser.
 *
 *   node scripts/setup-bridge-audit.js [--t3 URL] [--setup URL] [--bridge FILE]
 *
 *   T3_PAIR_CREDENTIAL   a pairing credential for this T3 (`t3 auth pairing create`)
 *   --bridge FILE        serve T3's shell with this bridge instead of the one
 *                        built into it, to try a working copy against an image
 *   T3_BRIDGE_UI_OUTPUT  optional light/dark desktop and phone screenshots
 *
 * The console is only reachable from T3 Code when one origin serves both, so
 * this starts that origin itself, with the image's own one-port router
 * (docker/router, what T3_SINGLE_PORT runs): /__setup* to the console and
 * everything else to T3. Through it, a fresh browser:
 *
 *   - sees the Setup pill on the pairing screen, and no entry;
 *   - pairs through T3's own /pair page, after which the pill is gone;
 *   - finds Setup at the end of the Settings sidebar, drawn like T3's rows;
 *   - opens the console in a dialog, signed in on its T3 session, in T3's
 *     theme, with the rest of the page inert;
 *   - closes it with Escape and gets focus back on the entry;
 *   - on a phone, opens it from the Settings rail or older sidebar sheet as a full-screen dialog;
 * and the console refuses a state change that did not come from its own
 * origin, even with a valid T3 session.
 *
 * Exits non-zero on the first finding, after saying what it was.
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const T3 = new URL(arg("--t3", "http://127.0.0.1:3773"));
const SETUP = new URL(arg("--setup", "http://127.0.0.1:3774"));
const BRIDGE = arg("--bridge", null);
const CREDENTIAL = process.env.T3_PAIR_CREDENTIAL || "";
const OUTPUT = process.env.T3_BRIDGE_UI_OUTPUT;
if (OUTPUT) fs.mkdirSync(OUTPUT, { recursive: true });
const CHROME = process.env.CHROME_PATH
  || (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

if (!CREDENTIAL) {
  console.error("setup-bridge-audit: set T3_PAIR_CREDENTIAL (t3 auth pairing create --json, its credential)");
  process.exit(2);
}

// ------------------------------------------------------------------ router --
// The image's router, wherever this runs: installed in a container (the smoke
// test copies this script to /tmp there), or beside it in a checkout.
const ROUTER_MODULE = [
  process.env.T3_ROUTER_MODULE,
  "/opt/t3-router/router.mjs",
  path.join(__dirname, "../docker/router/router.mjs"),
].find((candidate) => candidate && fs.existsSync(candidate));
if (!ROUTER_MODULE) {
  console.error("setup-bridge-audit: cannot find docker/router/router.mjs; set T3_ROUTER_MODULE");
  process.exit(2);
}

// ------------------------------------------------------------------ checks --
let passed = 0;
const fail = (what, detail) => {
  const error = new Error(what + (detail ? `\n    ${detail}` : ""));
  error.finding = true;
  throw error;
};
const ok = (what) => { passed += 1; console.log(`  ok  ${what}`); };
const expect = (cond, what, detail) => (cond ? ok(what) : fail(what, typeof detail === "function" ? detail() : detail));

/** Serve T3's shell with a working copy of the bridge in place of the built one. */
const useBridge = async (context) => {
  if (!BRIDGE) return;
  const code = fs.readFileSync(BRIDGE, "utf8");
  await context.route((url) => !/^\/(__setup|api|assets|ws|\.well-known|oauth)/.test(url.pathname) && !/\.\w+$/.test(url.pathname),
    async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const answer = await route.fetch();
      const body = (await answer.text())
        .replace(/<script data-t3-setup-bridge>[\s\S]*?<\/script>\n?/, "")
        .replace(/<script>\n\/\/ A link from T3 Code back to the setup console[\s\S]*?<\/script>\n?/, "")
        .replace("</body>", `<script data-t3-setup-bridge>\n${code}</script>\n</body>`);
      await route.fulfill({ response: answer, body, headers: { ...answer.headers(), "content-length": String(Buffer.byteLength(body)) } });
    });
};

/**
 * Go to a page of T3's, past the wizard T3 greets a fresh server with: it
 * decides after loading whether to show it, so wait for either the wizard or
 * the app, and decline the wizard's offers until it lets go.
 */
const visit = async (page, url) => {
  await page.goto(url);
  for (let round = 0; round < 3; round++) {
    await page.waitForFunction(() => location.pathname.startsWith("/welcome")
      || document.querySelector('[data-sidebar="menu-button"]') !== null, null, { timeout: 30000 }).catch(() => null);
    if (!new URL(page.url()).pathname.startsWith("/welcome")) return;
    for (let i = 0; i < 12 && new URL(page.url()).pathname.startsWith("/welcome"); i++) {
      let clicked = false;
      for (const name of [/^Do not import projects$/, /^Skip/, /^Continue/, /^(Finish|Done|Get started)/]) {
        const button = page.getByRole("button", { name }).last();
        if (await button.count() && await button.isEnabled().catch(() => false)) {
          await button.click({ timeout: 5000 }).catch(() => {});
          clicked = true;
          break;
        }
      }
      await page.waitForTimeout(clicked ? 1200 : 600);
    }
    if (new URL(page.url()).pathname.startsWith("/welcome")) fail("T3's welcome wizard could be finished", page.url());
    await page.goto(url);
  }
};

const ENTRY = "[data-t3-setup-entry] button";
const settingsRow = (label) => `[data-sidebar="menu-button"]:not([data-t3-setup-entry] *):text-is("${label}")`;
const captureSettings = async (page, name) => {
  if (!OUTPUT) return;
  fs.mkdirSync(OUTPUT, { recursive: true });
  await page.locator(ENTRY).scrollIntoViewIfNeeded();
  const wasDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  try {
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, theme === "dark");
      await page.screenshot({ path: path.join(OUTPUT, `settings-${name}-${theme}.png`), animations: "disabled" });
    }
  } finally {
    await page.emulateMedia({ colorScheme: wasDark ? "dark" : "light" });
    await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, wasDark);
  }
};

const run = async (base) => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    // A substituted shell (--bridge) loses its address space, and Chromium
    // would then refuse T3's WebSocket to a loopback address.
    args: ["--no-sandbox", "--disable-features=LocalNetworkAccessChecks"],
  });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await useBridge(context);
    page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    console.log("Before pairing");
    await page.goto(base + "/");
    await page.waitForSelector(".t3-setup-pill", { timeout: 20000 }).catch(() => null);
    expect(await page.locator(".t3-setup-pill").count() === 1, "the pairing screen shows the Setup pill");
    expect(await page.locator(".t3-setup-pill").getAttribute("href") === "/__setup/", "the pill opens the console's own page");

    console.log("Pairing");
    // Leave T3 first so the link loads a new document, even when the unpaired
    // page is already at /pair. Reloading after opening the link can interrupt
    // authentication after T3 has removed the credential from its URL.
    await page.goto("about:blank");
    const [pairingResponse] = await Promise.all([
      page.waitForResponse((response) => response.url() === base + "/api/auth/browser-session"
        && response.request().method() === "POST"),
      page.goto(base + "/pair#token=" + encodeURIComponent(CREDENTIAL)),
    ]);
    expect(pairingResponse.ok(), "the pairing link exchanges successfully", `HTTP ${pairingResponse.status()}`);
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30000, waitUntil: "commit" });
    await visit(page, base + "/");
    await page.waitForFunction(() => !document.querySelector(".t3-setup-pill"), null, { timeout: 10000 }).catch(() => null);
    expect(await page.locator(".t3-setup-pill").count() === 0, "once paired, the pill leaves T3's own corner alone", page.url());

    console.log("Settings");
    await visit(page, base + "/settings/general");
    await page.waitForSelector(ENTRY, { timeout: 20000 }).catch(() => null);
    expect(await page.locator(ENTRY).count() === 1, "Settings has exactly one Setup entry");
    const geometry = await page.evaluate(() => {
      const entry = document.querySelector("[data-t3-setup-entry]");
      const list = entry.previousElementSibling;
      const rows = list.querySelectorAll('[data-sidebar="menu-button"]');
      const last = rows[rows.length - 1].getBoundingClientRect();
      const mine = entry.querySelector("button").getBoundingClientRect();
      return {
        after: list.getAttribute("data-sidebar") === "menu"
          && list === [...entry.closest('[data-sidebar="content"]').querySelectorAll('[data-sidebar="menu"]')]
            .filter((menu) => !menu.hasAttribute('data-t3-setup-entry') && menu.getAttribute('role') !== 'listbox').at(-1),
        height: [Math.round(last.height), Math.round(mine.height)],
        left: [Math.round(last.left), Math.round(mine.left)],
        width: [Math.round(last.width), Math.round(mine.width)],
        below: mine.top > last.bottom,
        label: entry.querySelector("button").getAttribute("aria-label"),
        popup: entry.querySelector("button").getAttribute("aria-haspopup"),
      };
    });
    expect(geometry.after && geometry.below, "it comes after T3's own settings list", JSON.stringify(geometry));
    expect(geometry.height[0] === geometry.height[1] && geometry.left[0] === geometry.left[1] && geometry.width[0] === geometry.width[1],
      "it is drawn exactly like T3's rows", JSON.stringify(geometry));
    expect(/^Setup/.test(geometry.label) && geometry.popup === "dialog", "it says what it is and that it opens a dialog", JSON.stringify(geometry));
    await captureSettings(page, "desktop");

    const settingsSearch = page.locator('nav[aria-label="Settings sections"] input[aria-label="Search settings"]');
    if (await settingsSearch.count()) {
      await settingsSearch.fill("general");
      await page.locator('[role="listbox"][aria-label="Settings search results"]').waitFor();
      await page.locator(ENTRY).waitFor({ state: "detached" });
      expect(await page.locator(ENTRY).count() === 0, "Setup does not copy native search-result rows");
      await settingsSearch.fill("");
      await page.locator(ENTRY).waitFor();
      expect(await page.locator(ENTRY).count() === 1, "clearing Settings search restores one Setup entry");
    }

    const hello = await page.evaluate(() => fetch("/__setup/hello").then((r) => r.json()));
    expect(hello.signedIn === true, "the console accepts this browser's T3 session", JSON.stringify(hello));
    const badge = await page.locator("[data-t3-setup-entry] .t3-setup-badge").evaluate((el) => (el.hidden ? "" : el.textContent));
    expect(badge === (hello.attention > 0 ? String(hello.attention) : ""), "the count beside it is the console's", `badge "${badge}", console ${hello.attention}`);

    console.log("The dialog");
    const nativeModal = await page.locator('[data-app-modal]').boundingBox();
    await page.click(ENTRY);
    await page.waitForSelector(".t3-setup-layer[data-ready]", { timeout: 20000 }).catch(() => null);
    expect(await page.locator(".t3-setup-layer[data-ready]").count() === 1, "Setup opens the console in a dialog");
    const frame = page.frames().find((f) => f.url().includes("/__setup/"));
    expect(Boolean(frame) && /[?&]embed=t3/.test(frame.url()), "the dialog holds the console, embedded", frame && frame.url());
    await frame.waitForSelector("#app", { timeout: 15000 }).catch(() => null);
    const inside = await frame.evaluate(async () => ({
      app: Boolean(document.getElementById("app")),
      close: Boolean(document.querySelector('[data-cmd="embed.close"]')),
      lockless: !document.querySelector("#theme-toggle"),
      via: (await fetch(BASE + "/status", { headers: { accept: "application/json" } }).then((r) => r.json())).viewer,
    }));
    expect(inside.app && inside.via && inside.via.via === "t3", "it opens signed in, without the setup key", JSON.stringify(inside));
    expect(inside.close && inside.lockless, "it has a close button and leaves the theme to T3");
    if (nativeModal) {
      // The frame can become ready during the modal's opening scale animation.
      await page.waitForFunction(native => {
        const rect = document.querySelector('.t3-setup-panel').getBoundingClientRect();
        return ['x', 'y', 'width', 'height'].every(key => Math.abs(rect[key] - native[key]) <= 1);
      }, nativeModal, { timeout: 3000 });
      const setupModal = await page.locator('.t3-setup-panel').boundingBox();
      expect(['x', 'y', 'width', 'height'].every(key => Math.abs(setupModal[key] - nativeModal[key]) <= 1),
        'Setup uses the native Settings modal dimensions and gutters', JSON.stringify({ nativeModal, setupModal }));
    }
    const modal = await page.evaluate(() => ({
      dialog: document.querySelector('.t3-setup-panel[role="dialog"][aria-modal="true"]') !== null,
      reachable: [...document.body.children]
        .filter((node) => !node.inert && !node.classList.contains("t3-setup-layer") && !/^(SCRIPT|STYLE|LINK)$/.test(node.tagName))
        .map((node) => node.tagName.toLowerCase() + (node.id ? "#" + node.id : "")),
    }));
    expect(modal.dialog && modal.reachable.length === 0, "it is modal: T3 behind it is out of reach", "still reachable: " + modal.reachable.join(", "));

    const themeOf = () => frame.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const startTheme = await themeOf();
    const nextTheme = startTheme === 'dark' ? 'light' : 'dark';
    await page.emulateMedia({ colorScheme: nextTheme });
    await frame.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, nextTheme);
    const switched = await themeOf();
    await page.emulateMedia({ colorScheme: startTheme });
    await frame.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, startTheme);
    expect(startTheme !== switched && (switched === "dark" || switched === "light"), "it follows T3's theme as it changes", `${startTheme} -> ${switched}`);

    await require('./appearance-ui-audit.js').nativeAppearance({ page, frame, expect, output: OUTPUT });

    await frame.locator("#main").focus();
    await page.keyboard.press("Escape");
    await page.waitForSelector(".t3-setup-layer", { state: "detached", timeout: 5000 }).catch(() => null);
    expect(await page.locator(".t3-setup-layer").count() === 0, "Escape inside the console closes the dialog");
    expect(await page.evaluate(() => document.activeElement && document.activeElement.closest("[data-t3-setup-entry]") !== null),
      "focus goes back to the entry");
    expect(await page.evaluate(() => [...document.body.children].every((n) => !n.inert)), "and T3 is reachable again");

    await page.click(ENTRY);
    await page.waitForSelector(".t3-setup-layer[data-ready]", { timeout: 20000 });
    await page.mouse.click(8, 450);
    await page.waitForSelector(".t3-setup-layer", { state: "detached", timeout: 5000 }).catch(() => null);
    expect(await page.locator(".t3-setup-layer").count() === 0, "a click beside the dialog closes it");

    await visit(page, base + "/");
    await page.waitForTimeout(800);
    expect(await page.locator("[data-t3-setup-entry]").count() === 0, "outside Settings there is no entry");

    console.log("The command palette");
    const PALETTE = '[data-command-palette="true"]';
    // T3's palette spends the first Escape after an arrow key on its own
    // highlight (its own behaviour, not Setup's), so close it with as many as it takes.
    const closePalette = async () => {
      for (let i = 0; i < 3 && await page.locator(PALETTE).count(); i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
    };
    const rows = () => page.evaluate(() => {
      const dialog = document.querySelector('[data-command-palette="true"]');
      if (!dialog) return null;
      const ours = [...dialog.querySelectorAll("[data-t3-setup-item]")];
      const theirs = [...dialog.querySelectorAll('[data-slot="command-item"]:not([data-t3-setup-item])')];
      const lit = theirs.find((row) => row.hasAttribute("data-highlighted"));
      const list = dialog.querySelector('[data-slot="command-list"]');
      return {
        query: dialog.querySelector('input[role="combobox"]')?.value,
        ours: ours.map((row) => row.getAttribute("data-t3-setup-item")),
        ourLit: ours.findIndex((row) => row.hasAttribute("data-highlighted")),
        theirs: theirs.length,
        // T3 draws its highlighted row with a background; Setup's highlight leaves it plain.
        theirLitPainted: lit ? getComputedStyle(lit).backgroundColor !== "rgba(0, 0, 0, 0)" : null,
        first: list ? list.firstElementChild && list.firstElementChild.hasAttribute("data-t3-setup-palette") : null,
        virtualized: ![...dialog.querySelectorAll('[data-slot="command-group"]')].some((g) => !g.hasAttribute("data-t3-setup-palette")),
        emptyHidden: [...dialog.querySelectorAll("[data-t3-setup-empty] > :not([data-t3-setup-host])")].every((n) => !n.getClientRects().length),
        // A row, as T3's are: the icon beside the text, not above it.
        rowShaped: ours.every((row) => {
          const icon = row.querySelector("svg").getBoundingClientRect();
          const text = row.querySelector("svg + span").getBoundingClientRect();
          return Math.abs(icon.width - 16) < 1 && Math.abs(icon.height - 16) < 1
            && icon.right <= text.left && icon.top < text.bottom && icon.bottom > text.top
            && row.getBoundingClientRect().height <= 80;
        }),
        active: document.activeElement && document.activeElement.getAttribute("aria-activedescendant"),
        owns: dialog.hasAttribute("data-t3-setup-owns"),
      };
    });
    const search = async (query, { setupRows = true } = {}) => {
      await closePalette();
      // The native Search button is ready with the sidebar, independently of
      // the asynchronous keybinding preferences on a newly loaded client.
      const openSearch = page.getByRole("button", { name: /^Search/ }).first();
      if (await openSearch.count()) await openSearch.click();
      else await page.keyboard.press("Control+k");
      await page.locator(PALETTE + ' input[role="combobox"]').fill(query, { timeout: 5000 });
      if (setupRows) await page.locator(PALETTE + " [data-t3-setup-item]").first().waitFor({ state: "visible", timeout: 5000 });
      await page.waitForTimeout(600);
      if (setupRows) await page.locator(PALETTE + " [data-t3-setup-item]").first().waitFor({ state: "visible", timeout: 5000 });
      return rows();
    };
    const dialogRoute = async () => {
      await page.waitForSelector(".t3-setup-layer[data-ready]", { timeout: 20000 }).catch(() => null);
      const frame = page.frames().find((f) => f.url().includes("/__setup/"));
      return { open: await page.locator(".t3-setup-layer").count() === 1, palette: await page.locator(PALETTE).count(), hash: frame ? new URL(frame.url()).hash : null };
    };
    const closeDialog = async () => {
      await page.keyboard.press("Escape");
      await page.waitForSelector(".t3-setup-layer", { state: "detached", timeout: 5000 }).catch(() => null);
    };

    // First a search T3 has nothing for, on a page where its palette has shown
    // no rows yet: Setup's has no classes of T3's to copy.
    let found = await search("mise");
    expect(found && found.ours.join() === "toolchains" && found.ourLit === 0 && found.rowShaped,
      "\"mise\" offers Toolchains, drawn as a row", JSON.stringify(found));
    if (!found.theirs) expect(found.emptyHidden, "standing in for T3's \"No matching\" line", JSON.stringify(found));

    found = await search("setup");
    expect(found && found.ours[0] === "setup" && found.ourLit === 0 && found.rowShaped, "\"setup\" lists Open setup first, highlighted", JSON.stringify(found));
    expect(found.first !== false, "Setup's group comes first", JSON.stringify(found));
    expect(found.active === "t3-setup-cmd-0" && found.theirLitPainted !== true, "and only Setup's row reads as highlighted", JSON.stringify(found));
    await page.keyboard.press("Enter");
    let opened = await dialogRoute();
    expect(opened.open && opened.palette === 0 && opened.hash === "", "Enter closes the palette and opens Setup", JSON.stringify(opened));
    await closeDialog();

    found = await search("pair");
    expect(found && found.ours.join() === "pair" && found.ourLit === 0, "\"pair\" offers Pair a device", JSON.stringify(found));
    if (found.theirs) {
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => {
        const dialog = document.querySelector('[data-command-palette="true"]');
        return dialog && !dialog.hasAttribute('data-t3-setup-owns')
          && [...dialog.querySelectorAll('[data-slot="command-item"]:not([data-t3-setup-item])')]
            .some(row => row.hasAttribute('data-active') && getComputedStyle(row).backgroundColor !== 'rgba(0, 0, 0, 0)');
      });
      const down = await rows();
      expect(down.ourLit === -1 && down.theirLitPainted === true, "ArrowDown moves on to T3's own results", JSON.stringify(down));
      await page.keyboard.press("ArrowUp");
      await page.locator(PALETTE + ' [data-t3-setup-item][data-highlighted]').waitFor();
      const up = await rows();
      expect(up.ourLit === 0 && up.theirLitPainted !== true, "and ArrowUp back to Setup's", JSON.stringify(up));
    } else {
      expect(found.emptyHidden, "where T3 has nothing to offer, Setup's rows stand in for \"No matching\"", JSON.stringify(found));
    }
    await page.keyboard.press("Enter");
    opened = await dialogRoute();
    expect(opened.open && opened.palette === 0 && opened.hash === "#access", "it opens Setup on Access, after arrow keys too", JSON.stringify(opened));
    await closeDialog();

    // Setup's group sits where a group of commands does, after T3's Actions:
    // a search T3's own commands also answer keeps Enter on T3's first result.
    found = await search("open");
    expect(found && found.ours.join() === "setup", "\"open\" finds Open setup, by its title", JSON.stringify(found));
    if (found.theirs) {
      expect(found.ourLit === -1 && (found.virtualized || found.first === false) && /^base-ui/.test(found.active || ""),
        "leaving Enter with T3's first result when its Actions answer", JSON.stringify(found));
    }
    found = await search("open setup");
    expect(found && found.ours.join() === "setup" && found.ourLit === 0, "\"open setup\" is Open setup, highlighted", JSON.stringify(found));
    await page.keyboard.press("Enter");
    opened = await dialogRoute();
    expect(opened.open && opened.palette === 0 && opened.hash === "", "and Enter opens it", JSON.stringify(opened));
    await closeDialog();
    found = await search("set");
    if (found.theirs) {
      expect(found.ours[0] === "setup" && found.ourLit === -1 && /^base-ui/.test(found.active || ""),
        "\"set\" lists Open setup but leaves Enter with T3's first result", JSON.stringify(found));
    }
    found = await search("settings", { setupRows: false });
    expect(found && found.ours.length === 0, "\"settings\" is T3's alone", JSON.stringify(found));
    // Different native result types expose different SVG classes, sometimes
    // for a nested full-size illustration. The bridge must own its geometry
    // after learning each of them, including across palette reopenings.
    await search('setup');
    for (const iconClass of ['text-yellow-500', 'w-full h-full', '']) {
      await page.evaluate((iconClass) => {
        const list = document.querySelector('[data-command-palette="true"] [data-slot="command-list"]');
        const group = document.createElement('div');
        group.dataset.slot = 'command-group'; group.dataset.auditPalette = '';
        const row = document.createElement('div');
        row.dataset.slot = 'command-item'; row.className = 'p-2';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', iconClass); svg.setAttribute('viewBox', '0 0 24 24');
        row.append(svg, document.createTextNode('Native result fixture')); group.append(row); list.append(group);
        document.querySelector('[data-t3-setup-palette]')?.remove();
      }, iconClass);
      await page.locator('[data-t3-setup-item]').first().waitFor();
      found = await rows();
      expect(found.rowShaped, 'Setup icons stay 16px beside the text after learning ' + (iconClass || 'an unsized icon'), JSON.stringify(found));
      await page.locator('[data-audit-palette]').evaluate((el) => el.remove());
    }
    await closePalette();

    // Replace the native input as an isolated final scenario: React retains
    // references to the original node, so close this page after the assertion.
    await search("mise");
    await page.locator(PALETTE + ' input[role="combobox"]').evaluate((input) => {
      const next = input.cloneNode(true);
      next.value = input.value;
      next.removeAttribute('role');
      next.setAttribute('data-audit-remount', '');
      document.querySelector('[data-t3-setup-palette]')?.remove();
      input.replaceWith(next);
      next.focus();
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator(PALETTE + ' [data-t3-setup-palette]').waitFor({ state: 'detached' });
    await page.locator(PALETTE + ' input[data-audit-remount]').evaluate((input) => input.setAttribute('role', 'combobox'));
    await page.locator(PALETTE + ' [data-t3-setup-item="toolchains"]').waitFor();
    expect((await rows()).ours.join() === 'toolchains', "Setup recovers when native search replaces its input before the combobox role");
    await page.close();

    console.log("The console's own guard");
    // Asked from here rather than from the page, which cannot set Sec-Fetch-Site.
    const cookies = (await context.cookies()).filter((c) => c.name.startsWith("t3_session")).map((c) => `${c.name}=${c.value}`).join("; ");
    const post = (site) => fetch(base + "/__setup/revoke", {
      method: "POST",
      headers: { cookie: cookies, "content-type": "application/json", ...(site ? { "sec-fetch-site": site } : {}) },
      body: JSON.stringify({ kind: "link", id: "none" }),
    }).then((r) => r.status);
    expect(await post("cross-site") === 403 && await post("same-site") === 403, "a state change from another site is refused");
    expect(await post(null) === 401, "a T3 session alone does not authorise a state change the browser did not vouch for");
    const read = await fetch(base + "/__setup/status", { headers: { cookie: cookies, accept: "application/json" } });
    expect(read.status === 200 && (await read.json()).viewer.via === "t3", "a T3 session reads the console");
    const forged = await fetch(base + "/__setup/status", { headers: { cookie: cookies.replace(/=([^;]{8})/, "=x$1"), accept: "application/json" } });
    expect(forged.status === 401, "a forged T3 session does not");
    const framing = await fetch(base + "/__setup/", { headers: { cookie: cookies } });
    expect(framing.headers.get("x-frame-options") === "SAMEORIGIN" && /frame-ancestors 'self'/.test(framing.headers.get("content-security-policy") || ""),
      "only this origin may frame the console");

    console.log("On a phone");
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      storageState: await context.storageState(),
    });
    await useBridge(phone);
    const mobile = await phone.newPage();
    page = mobile;
    await visit(mobile, base + "/settings/general");
    const modernSettings = await mobile.locator('nav[aria-label="Settings sections"]').waitFor({ timeout: 5000 })
      .then(() => true, () => false);
    if (!modernSettings) {
      await mobile.waitForSelector('[data-sidebar="trigger"]', { timeout: 20000 });
      await mobile.locator('[data-sidebar="trigger"]').first().click();
    }
    await mobile.waitForSelector(ENTRY, { timeout: 10000 }).catch(() => null);
    expect(await mobile.locator(ENTRY).count() === 1, "T3's phone settings navigation has the entry too");
    await mobile.locator(ENTRY).scrollIntoViewIfNeeded();
    if (modernSettings) {
      const compact = await mobile.locator(ENTRY).evaluate((button) => {
        const row = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect();
        const nativeRows = button.closest('[data-t3-setup-entry]').previousElementSibling.querySelectorAll('[data-sidebar="menu-button"]');
        const nativeIcon = nativeRows[nativeRows.length - 1].querySelector('svg').getBoundingClientRect();
        return { width: row.width, iconInside: icon.left >= row.left && icon.right <= row.right,
          aligned: Math.abs(icon.left - nativeIcon.left) <= 1 && Math.abs(icon.width - nativeIcon.width) <= 1,
          badgeHidden: getComputedStyle(button.querySelector('.t3-setup-badge')).display === 'none',
          label: button.getAttribute('aria-label') };
      });
      expect(compact.width > 0 && compact.iconInside && compact.aligned && compact.badgeHidden && /^Setup/.test(compact.label),
        "the compact Settings rail matches native icons and keeps its accessible label", JSON.stringify(compact));
    }
    await captureSettings(mobile, "phone");
    await mobile.locator(ENTRY).tap();
    await mobile.waitForSelector(".t3-setup-layer[data-ready]", { timeout: 20000 }).catch(() => null);
    const sheet = await mobile.evaluate(() => {
      const panel = document.querySelector(".t3-setup-panel");
      const r = panel ? panel.getBoundingClientRect() : null;
      return { open: Boolean(panel), full: r && r.width === innerWidth && r.height === innerHeight };
    });
    expect(sheet.open && sheet.full, "it opens full screen", JSON.stringify(sheet));
    // T3's sheet animates out; it must be gone once that is over.
    if (!modernSettings) {
      const sheetGone = await mobile.waitForFunction(() => !document.querySelector('[data-mobile="true"]'), null, { timeout: 3000 })
        .then(() => true, () => false);
      expect(sheetGone, "having closed T3's sheet, as T3's own rows do");
    }
    const phoneFrame = mobile.frames().find((f) => f.url().includes("/__setup/"));
    await phoneFrame.waitForSelector('.tc-phonebar [data-cmd="embed.close"]', { timeout: 15000 });
    await phoneFrame.locator('.tc-phonebar [data-cmd="embed.close"]').tap();
    await mobile.waitForSelector(".t3-setup-layer", { state: "detached", timeout: 5000 }).catch(() => null);
    expect(await mobile.locator(".t3-setup-layer").count() === 0, "its close button closes it");
    if (modernSettings) {
      expect(await mobile.locator('nav[aria-label="Settings sections"]').isVisible(), "closing Setup returns to the native Settings modal");
      expect(await mobile.locator(ENTRY).evaluate((button) => document.activeElement === button), "phone focus returns to Setup in the Settings rail");
    }
    await phone.close();

    expect(errors.length === 0, "no script errors on T3's pages", errors.join("\n    "));
    await context.close();
  } catch (error) {
    if (OUTPUT && page) {
      await page.screenshot({ path: path.join(OUTPUT, "failure.png"), animations: "disabled", timeout: 5000 }).catch(() => {});
      fs.writeFileSync(path.join(OUTPUT, "failure.json"), JSON.stringify(await page.evaluate(() => ({
        path: location.pathname,
        settings: Boolean(document.querySelector('nav[aria-label="Settings sections"]')),
        layers: [...document.querySelectorAll('.t3-setup-layer')].map(node => ({ state: node.dataset.state, ready: node.hasAttribute('data-ready'), inert: node.inert })),
        active: document.activeElement?.getAttribute('aria-label'),
        palette: document.querySelector('[data-command-palette="true"]')?.outerHTML,
      })).catch(() => ({})), null, 2));
    }
    throw error;
  } finally {
    await browser.close();
  }
};

import(pathToFileURL(ROUTER_MODULE).href).then(({ createRouterServer }) => {
  const router = createRouterServer({
    t3: { host: T3.hostname, port: Number(T3.port) || 80 },
    setup: { host: SETUP.hostname, port: Number(SETUP.port) || 80 },
    log: (line) => console.log(`  [router] ${line}`),
  });
  router.listen(0, "127.0.0.1", () => audit(router));
});

const audit = async (router) => {
  const base = `http://127.0.0.1:${router.address().port}`;
  console.log(`setup-bridge-audit: T3 ${T3.origin}, console ${SETUP.origin}, routed together at ${base}`);
  let code = 0;
  try {
    await run(base);
    console.log(`\n${passed} checks passed`);
  } catch (error) {
    const detail = String(error.finding ? error.message : error.stack || error).replaceAll(CREDENTIAL, "[redacted]");
    console.error(`\nFAIL ${detail}`);
    code = 1;
  }
  router.close();
  process.exit(code);
};
