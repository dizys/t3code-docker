// Unit tests for what the image adds to T3 Code's own client
// (docker/t3-client/setup-bridge.js and the build step that injects it).
//
//   node --test tests/t3-client.test.mjs
//
// The bridge is a classic script inlined into T3's HTML shell. Loaded here
// with no document, it exports its pure helpers instead of starting; what it
// does on T3's real pages is scripts/setup-bridge-audit.js's job.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const BRIDGE = new URL("../docker/t3-client/setup-bridge.js", import.meta.url);
const PATCH = new URL("../docker/t3-client/patch.mjs", import.meta.url);
const source = readFileSync(BRIDGE, "utf8");
const context = vm.createContext({});
vm.runInContext(source, context, { filename: "setup-bridge.js" });
const B = context.T3SetupBridge;

test("the bridge can be inlined into an HTML script tag", () => {
  assert.doesNotMatch(source, /<\/script/i);
  assert.match(source, /data-t3-setup-entry/, "the build step recognises it by this");
});

test("it looks for the console on the documented route first", () => {
  assert.deepEqual([...B.PROBE_PATHS], ["/__setup/", "/setup/"]);
});

test("Settings is every page under /settings, and nothing else", () => {
  for (const path of ["/settings", "/settings/", "/settings/general", "/settings/projects/abc"]) assert.equal(B.isSettingsPath(path), true, path);
  for (const path of ["/", "/pair", "/welcome", "/settingsx", "/chat/settings", ""]) assert.equal(B.isSettingsPath(path), false, path);
});

test("the dialog opens the console embedded, in T3's theme", () => {
  assert.equal(B.embedUrl("/__setup/", "dark", null), "/__setup/?embed=t3&theme=dark");
  assert.equal(B.embedUrl("/__setup/", "light", "agents"), "/__setup/?embed=t3&theme=light#agents");
  assert.equal(B.embedUrl("/setup/", "<script>", null), "/setup/?embed=t3&theme=light", "anything else is light");
});

test("only the console's own answer counts as the console", () => {
  assert.deepEqual({ ...B.readHello({ service: "t3-setup", signedIn: true, attention: 2 }) }, { signedIn: true, attention: 2 });
  assert.deepEqual({ ...B.readHello({ service: "t3-setup", signedIn: false }) }, { signedIn: false, attention: 0 });
  assert.deepEqual({ ...B.readHello({ service: "t3-setup", signedIn: "yes", attention: -1 }) }, { signedIn: false, attention: 0 });
  assert.deepEqual({ ...B.readHello({ service: "t3-setup", signedIn: true, attention: 1.5 }) }, { signedIn: true, attention: 0 });
  assert.equal(B.readHello({ authenticated: true }), null, "T3's own JSON is not the console");
  assert.equal(B.readHello(null), null, "nor is T3's HTML shell, which parses to nothing");
});

test("the count beside Setup is short, and says itself to a screen reader", () => {
  assert.equal(B.badgeText(0), "");
  assert.equal(B.badgeText(3), "3");
  assert.equal(B.badgeText(120), "99+");
  assert.equal(B.entryLabel(0), "Setup");
  assert.equal(B.entryLabel(1), "Setup, 1 thing needs you");
  assert.equal(B.entryLabel(4), "Setup, 4 things need you");
});

test("only the console in the dialog is listened to", () => {
  const frame = { contentWindow: {} };
  const message = (over) => ({ source: frame.contentWindow, origin: "https://t3.example.com", data: { source: "t3-setup", type: "close" }, ...over });
  assert.equal(B.fromConsole(message({}), frame, "https://t3.example.com"), true);
  assert.equal(B.fromConsole(message({ source: {} }), frame, "https://t3.example.com"), false, "another frame");
  assert.equal(B.fromConsole(message({ origin: "https://evil.example.com" }), frame, "https://t3.example.com"), false, "another origin");
  assert.equal(B.fromConsole(message({ data: { source: "other", type: "close" } }), frame, "https://t3.example.com"), false);
  assert.equal(B.fromConsole(message({ data: "close" }), frame, "https://t3.example.com"), false);
  assert.equal(B.fromConsole(message({}), null, "https://t3.example.com"), false, "no dialog open");
});

test("Setup's commands are found in T3's palette the way T3 finds its own", () => {
  const found = (q) => B.paletteMatches(q).map((i) => i.id).join(",");
  // A title's words, typed in any order or part: what the row says is what finds it.
  for (const q of ["open", "open setup", "Open Setup", "open set", "set", "setu", "setup", "op se", "console"]) {
    assert.equal(found(q).split(",")[0], "setup", q);
  }
  assert.equal(found("open setup"), "setup", "only what has both words");
  // The line under a title counts too, ranked after a title that answers.
  assert.equal(found("ports"), "ports,setup", "Ports first; Open setup lists them");
  assert.equal(found("setup ports"), "ports,setup", "a page by Setup's name first");
  assert.equal(found("ports setup"), "ports,setup");
  assert.equal(found("pair"), "pair");
  assert.equal(found("devices"), "pair,setup");
  assert.equal(found("mise"), "toolchains");
  assert.equal(found("go"), "toolchains");
  assert.equal(found("publish"), "ports");
  assert.equal(found("source control"), "sourcecontrol,setup");
  assert.equal(found("github"), "sourcecontrol");
  assert.equal(found("codeberg"), "sourcecontrol");
  assert.equal(found("glab"), "sourcecontrol");
  assert.equal(found("sign in"), "agents,sourcecontrol");
  // T3's normalisation: case, accents and spacing do not matter; ">" (T3's commands) still finds them.
  assert.equal(found("  ÓPEN   setup "), "setup");
  assert.equal(found(">open setup"), "setup");
  // Nothing typed, or nothing that answers: none.
  for (const q of ["", "   ", ">", "settings", "new thread", "setup ports x", "theme"]) assert.equal(found(q), "", q);
  for (const item of B.PALETTE_ITEMS) assert.ok(item.route === null || /^[a-z]+$/.test(item.route), item.id);
});

test("arrow keys walk Setup's rows and T3's as one list that wraps", () => {
  const step = (key, own, at, ours = 2, theirs = 3) => { const r = B.paletteStep({ key, own, ours, theirs, at }); return [r.own, r.pass]; };
  // Within Setup's rows: T3 never sees the key.
  assert.deepEqual(step("ArrowDown", 0, -1), [1, false]);
  assert.deepEqual(step("ArrowUp", 1, -1), [0, false]);
  // Off Setup's last row: T3 lights its first itself when it has no active row yet...
  assert.deepEqual(step("ArrowDown", 1, -1), [-1, true]);
  // ...is left on it when it already is there, and wraps to it from its last.
  assert.deepEqual(step("ArrowDown", 1, 0), [-1, false]);
  assert.deepEqual(step("ArrowDown", 1, 2), [-1, true]);
  // Up off T3's first row, or down off its last: into Setup's.
  assert.deepEqual(step("ArrowUp", -1, 0), [1, false]);
  assert.deepEqual(step("ArrowDown", -1, 2), [0, false]);
  // Within T3's rows: T3's keys.
  assert.deepEqual(step("ArrowDown", -1, 1), [-1, true]);
  assert.deepEqual(step("ArrowUp", -1, 2), [-1, true]);
  // Up off Setup's first row: round to T3's last, which T3 moves to itself.
  assert.deepEqual(step("ArrowUp", 0, 0), [-1, true]);
  // With nothing from T3, Setup's rows wrap among themselves.
  assert.deepEqual(step("ArrowDown", 1, -1, 2, 0), [0, false]);
  assert.deepEqual(step("ArrowUp", 0, -1, 2, 0), [1, false]);
  // A fresh search where T3 has the highlight: down lights the top row, Setup's.
  assert.deepEqual(step("ArrowDown", -1, -1), [0, false]);
  assert.deepEqual(step("Enter", 0, -1), [0, true], "other keys are not its business");
});

test("arrow keys pass through Setup's rows where they sit among T3's", () => {
  // T3's Actions (2 rows) above Setup's (2), then T3's other rows (3 more): 5 of T3's.
  const step = (key, own, at) => { const r = B.paletteStep({ key, own, ours: 2, theirs: 5, at, before: 2 }); return [r.own, r.pass]; };
  // A fresh search: T3's first row is the top, so T3 lights it.
  assert.deepEqual(step("ArrowDown", -1, -1), [-1, true]);
  // From T3's last Action down into Setup's first; T3 keeps its highlight where it was.
  assert.deepEqual(step("ArrowDown", -1, 1), [0, false]);
  // Off Setup's last row onto T3's next: T3 moves there from the row above.
  assert.deepEqual(step("ArrowDown", 1, 1), [-1, true]);
  // Back up from that row into Setup's last, and on up off Setup's first onto
  // T3's row above, which T3 moves to itself.
  assert.deepEqual(step("ArrowUp", -1, 2), [1, false]);
  assert.deepEqual(step("ArrowUp", 0, 2), [-1, true]);
  // Came in from above, left upward: T3's highlight is already on that row.
  assert.deepEqual(step("ArrowUp", 0, 1), [-1, false]);
  // Came in from below, left downward: likewise.
  assert.deepEqual(step("ArrowDown", 1, 2), [-1, false]);
  // Elsewhere in T3's rows, and round T3's ends: T3's keys.
  assert.deepEqual(step("ArrowDown", -1, 3), [-1, true]);
  assert.deepEqual(step("ArrowDown", -1, 4), [-1, true]);
  assert.deepEqual(step("ArrowUp", -1, 0), [-1, true]);

  // Setup's group last (all of T3's above it): round from its last row to T3's first, and up from there into it.
  const last = (key, own, at) => { const r = B.paletteStep({ key, own, ours: 2, theirs: 3, at, before: 3 }); return [r.own, r.pass]; };
  assert.deepEqual(last("ArrowDown", 1, 2), [-1, true]);
  assert.deepEqual(last("ArrowUp", -1, 0), [1, false]);
  assert.deepEqual(last("ArrowUp", -1, -1), [1, false], "up from nothing lands on the bottom row, Setup's");
  assert.deepEqual(last("ArrowDown", -1, 2), [0, false]);
});

test("the build step injects the bridge once, before </body>, or fails loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-client-"));
  const shell = join(dir, "index.html");
  const run = () => execFileSync(process.execPath, [PATCH.pathname], {
    env: { ...process.env, T3_CLIENT_SHELL: shell, T3_SETUP_BRIDGE: BRIDGE.pathname },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  writeFileSync(shell, "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");
  assert.match(run(), /setup bridge injected/);
  const once = readFileSync(shell, "utf8");
  assert.match(once, /<script data-t3-setup-bridge>\n[\s\S]+<\/script>\n<\/body>/);
  assert.ok(once.includes(source), "verbatim");
  assert.match(run(), /already present/);
  assert.equal(readFileSync(shell, "utf8"), once, "a second run changes nothing");

  writeFileSync(shell, "<!doctype html><html><body><div id=\"root\"></div></html>");
  assert.throws(run, /no <\/body>/, "an upstream layout change stops the build");
});
