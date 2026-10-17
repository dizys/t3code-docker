#!/usr/bin/env node
// Measure shared row layouts using the running console's exact styles.
// Includes the Provider updates markup from b60e9cf, removed in 8823eff:
// its plain modifier must not override the icon/text/actions grid.
// No scripts or API mutations run in the fixture document.
// Usage: node scripts/row-ui-audit.js <console-url> <setup-key>
const assert = require("node:assert/strict");
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }
const base = process.argv[2] || "http://127.0.0.1:23780/__setup/";
const key = process.argv[3] || "dev";

const icon = '<svg class="tc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/></svg>';
const settingsIcon = '<svg class="tc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 17H5M19 7h-9"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>';
const button = (label, glyph = "") => `<button class="tc-btn tc-btn--sm" type="button">${glyph}${label}</button>`;
const actions = (update) => `<div class="tc-row-actions tc-row-actions--wrap">${button("Check for updates", icon)}${update ? button("Update all") : ""}<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button">${settingsIcon}Auto-update</button></div>`;
const main = (title, text) => `<div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">${title}</span></div><span class="tc-status tc-status--prose">${text}</span></div>`;
const section = (id, title, row) => `<section class="tc-section" id="${id}"><div class="tc-section-head"><h2 class="tc-section-title">${title}</h2></div><div class="tc-group"><div class="tc-list">${row}</div></div></section>`;
const provider = (update) => `<div class="tc-row tc-row--compact tc-row--plain"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon}</span><div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">Provider updates</span><span class="tc-badge tc-badge--ok">Auto</span><span class="tc-badge">${update ? "3 available" : "Up to date"}</span></div><span class="tc-status tc-status--prose">Providers not checked yet · On · check every 3h · update after 30m idle</span></div>${actions(update)}</div>`;
const fixtures = [
  section("reported-row", "Updates", provider(false)),
  section("available-row", "Updates available", provider(true)),
  section("lead-row", "Leading element variant", `<div class="tc-row tc-row--compact tc-row--plain"><span class="tc-row-lead">${icon}</span>${main("Provider updates", "A leading element uses the same text and action columns as a tile.")}${actions(false)}</div>`),
  section("plain-row", "Without an icon", `<div class="tc-row tc-row--compact tc-row--plain">${main("Setup key", "The key this setup page asks for. Stored on the volume.")}<div class="tc-row-actions tc-row-actions--wrap">${button("Show")}${button("New key")}</div></div>`),
  section("connect-row", "With an icon", `<div class="tc-row tc-row--compact"><span class="tc-tile tc-tile--icon">${icon}</span>${main("T3 Connect", "Connect this server to reach it from your other devices.")}<div class="tc-row-actions tc-row-actions--wrap">${button("Connect")}</div></div>`),
  section("plain-single", "Single action", `<div class="tc-row tc-row--compact tc-row--plain">${main("Lock console", "Ends this browser’s session. You will need the setup key to come back.")}${button("Lock")}</div>`),
  section("plain-empty", "Without an action", `<div class="tc-row tc-row--compact tc-row--plain">${main("Signed in through T3 Code", "This browser is paired with T3 Code.")}</div>`),
].join("");

const geometry = () => {
  const issues = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push("horizontal page overflow");
  for (const row of document.querySelectorAll(".tc-row")) {
    const id = row.closest("section").id;
    const text = row.querySelector(":scope > .tc-row-main").getBoundingClientRect();
    const lead = row.querySelector(":scope > .tc-tile, :scope > .tc-row-lead")?.getBoundingClientRect();
    const style = getComputedStyle(row);
    const left = lead ? lead.right + parseFloat(style.columnGap) : row.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    if (Math.abs(text.left - left) > 1) issues.push(`${id}: text detached from ${lead ? "leading icon" : "row padding"}`);
    if (lead && (lead.top >= text.bottom || lead.bottom <= text.top)) issues.push(`${id}: icon and text on different lines`);
    const actions = row.querySelector(":scope > .tc-row-actions, :scope > button");
    if (!actions) continue;
    const rect = actions.getBoundingClientRect();
    const wrapped = innerWidth < 640 && actions.classList.contains("tc-row-actions--wrap");
    if (wrapped) {
      if (rect.top < text.bottom - 1 || Math.abs(rect.left - text.left) > 1) issues.push(`${id}: phone actions must follow and align with text`);
    } else if (rect.left < text.right - 1 || rect.top >= text.bottom || rect.bottom <= text.top) {
      issues.push(`${id}: actions must sit beside text`);
    }
    const parent = row.getBoundingClientRect();
    for (const child of row.querySelectorAll(".tc-btn, .tc-row-main")) {
      const r = child.getBoundingClientRect();
      if (r.left < parent.left || r.right > parent.right || r.bottom > parent.bottom) issues.push(`${id}: content outside row`);
    }
  }
  return issues;
};

(async () => {
  const response = await fetch(base, { headers: { "x-t3-setup-key": key } });
  assert.equal(response.ok, true, "console must serve its document");
  const document = await response.text();
  assert.ok(document.includes('id="page-agents"'), "console must accept the supplied setup key");
  const styles = [...document.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  assert.ok(styles.includes(".tc-row--plain"), "use the console's actual row styles");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const failures = [];
  try {
    const runs = [[360,800,false],[390,844,false],[639,900,false],[640,900,false],[820,1180,false],[1100,1000,false],[1440,900,false],[390,844,true],[1198,878,true]];
    for (const [width, height, embedded] of runs) for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce" });
      const page = await context.newPage();
      const tag = `${width}-${theme}${embedded ? "-embedded" : ""}`;
      const html = `<!doctype html><html data-theme="${theme}"${embedded ? ' data-embed="t3"' : ""}><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body class="tc-root"${width < 1024 ? ' data-density="touch"' : ""}><main class="tc-page">${fixtures}</main></body></html>`;
      if (embedded) {
        await page.setContent('<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe></iframe>');
        await page.locator("iframe").evaluate((iframe, html) => { iframe.srcdoc = html; }, html);
      } else await page.setContent(html);
      const frame = embedded ? await (await page.locator("iframe").elementHandle()).contentFrame() : page;
      await frame.locator("#reported-row").waitFor();
      await frame.evaluate(() => document.fonts.ready);
      const issues = await frame.evaluate(geometry);
      if (issues.length) failures.push({ tag, issues });
      else console.log(`PASS ${tag}: icon/text alignment, action placement, containment (7 row variants)`);
      await context.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(failures, [], "row layout regressions");
})().catch((error) => { console.error(error); process.exitCode = 1; });
