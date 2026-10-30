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

test("the tab opens the console in its host layout and T3 theme", () => {
  assert.equal(B.embedUrl("/__setup/", "dark", null), "/__setup/?embed=t3&host=tab&layout=compact&theme=dark#overview");
  assert.equal(B.embedUrl("/__setup/", "light", "agents", "wide"), "/__setup/?embed=t3&host=tab&layout=wide&theme=light#agents");
  assert.equal(B.embedUrl("/setup/", "<script>", null), "/setup/?embed=t3&host=tab&layout=compact&theme=light#overview", "anything else is light");
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
  assert.equal(found("context").split(",")[0], "context");
  assert.equal(found("skills").split(",")[0], "context", "Instructions & skills by either word");
  assert.equal(found("updates").split(",")[0], "updates");
  assert.equal(found("upgrade"), "updates");
  // T3's normalisation: case, accents and spacing do not matter; ">" (T3's commands) still finds them.
  assert.equal(found("  ÓPEN   setup "), "setup");
  assert.equal(found(">open setup"), "setup");
  // Nothing typed, or nothing that answers: none.
  for (const q of ["", "   ", ">", "settings", "new thread", "setup ports zzz", "theme"]) assert.equal(found(q), "", q);
  assert.equal(found('mcp').split(',')[0], 'mcp');
  for (const item of B.PALETTE_ITEMS) assert.ok(item.route === null || /^[a-z]+(?:\/mcp)?$/.test(item.route), item.id);
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

test("Setup does not take the first highlight from T3's virtualized Actions", () => {
  assert.equal(B.paletteOwnsFirst({ before: 0 }), true);
  assert.equal(B.paletteOwnsFirst({ before: 2 }), false);
  assert.equal(B.paletteOwnsFirst({ before: 0, virtualActions: true }), false);
  assert.equal(B.paletteOwnsFirst({ before: 0, virtualActions: false }), true);
});

const nativeRow = (id, attributes = {}, className = "") => ({
  id, className,
  hasAttribute: (name) => Object.hasOwn(attributes, name),
  getAttribute: (name) => attributes[name] ?? null,
});

test("native palette navigation uses T3's painted selection rather than the primitive default", () => {
  const initial = [nativeRow("native-first", { "data-highlighted": "", "aria-selected": "true" }), nativeRow("native-next")];
  assert.equal(B.paletteActiveIndex(initial), -1, "a primitive default is not T3's painted highlight");
  assert.equal(B.paletteStep({ key: "ArrowDown", own: 0, ours: 1, theirs: initial.length, at: -1, before: 0 }).pass, true,
    "leaving Setup must let T3 paint its first native row");
  const rows = [nativeRow("native-first", { "data-active": "true" }), nativeRow("native-next")];
  const at = B.paletteActiveIndex(rows);
  assert.equal(at, 0);
  const next = B.paletteStep({ key: "ArrowUp", own: -1, ours: 1, theirs: rows.length, at, before: 0 });
  assert.equal(next.own, 0);
  assert.equal(next.pass, false, "ArrowUp from the first native row returns to Setup");
});

test("false native active flags are ignored and older palette styles remain supported", () => {
  assert.equal(B.paletteActiveIndex([nativeRow("inactive", { "data-active": "false" }), nativeRow("active", { "data-active": "" })]), 1);
  assert.equal(B.paletteActiveIndex([nativeRow("old", {}, "p-2 bg-accent! text-accent-foreground!")]), 0);
  assert.equal(B.paletteActiveIndex([nativeRow("plain", { "data-highlighted": "false" })]), -1);
  assert.equal(B.paletteActiveIndex([]), -1);
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

test('tab host enums and native settings paths are bounded',()=>{
  assert.equal(B.layoutFor(768),'wide');assert.equal(B.layoutFor(767),'compact');
  for(const path of ['/settings/general','/settings/providers','/settings/source-control'])assert.equal(B.settingsPath(path),true);
  for(const path of ['/settings','/settings/../pair','https://evil.test/settings/general','/settings/providers?q=x','/settings/providers/extra',null])assert.equal(B.settingsPath(path),false);
});
const navFixture = () => ({current:'overview',groups:[{id:'home',label:null,pages:[{route:'overview',title:'Overview',icon:'home',badge:null}]}],status:{ok:true,text:'Running',version:'v1'},attention:2});
const iconsFixture = () => ({home:[['path',{d:'M1 1h2',fill:'none'}]]});
const paletteFixture = () => [{id:'overview',route:'overview',title:'Overview',meta:'Setup',icon:'home',terms:[]}];
test('authenticated hello validates and projects navigation, icons and palette',()=>{
  const hello={service:'t3-setup',signedIn:true,protocol:2,attention:2,nav:navFixture(),icons:iconsFixture(),palette:paletteFixture()};
  const result=B.readHello(hello);assert.equal(result.protocol,2);assert.equal(result.nav.current,'overview');assert.equal(result.palette[0].icon,'home');
  assert.equal(B.readHello({...hello,signedIn:false}).nav,undefined);
  for(const changes of [{nav:{...hello.nav,current:'unknown'}},{nav:{...hello.nav,attention:-1}},{icons:{home:[['script',{}]]}},{palette:[{...hello.palette[0],route:'unknown'}]}])assert.equal(B.readHello({...hello,...changes}).protocol,undefined);
  const secret={...hello.nav,internal:'secret'};assert.equal(B.readNav(secret).internal,undefined);
});
test('SVG boundary rejects executable elements, attributes, URLs and oversized shapes',()=>{
  assert.ok(B.readIconNodes([['circle',{cx:'12',cy:'12',r:'3'}]]));
  for(const nodes of [[['script',{d:'x'}]],[['path',{onload:'alert'}]],[['path',{d:'url(x)'}]],[['path',{fill:'red'}]],[['path',{d:'x'.repeat(2001)}]],[],Array(129).fill(['path',{d:'M1 1'}])])assert.equal(B.readIconNodes(nodes),null);
  assert.equal(B.readIcons({'bad key':iconsFixture().home}),null);
});
test('navigation rejects duplicate or malformed routes, groups and badges',()=>{
  const nav=navFixture();
  const cases=[{...nav,groups:[{...nav.groups[0],pages:[...nav.groups[0].pages,...nav.groups[0].pages]}]},{...nav,groups:[{...nav.groups[0],pages:[{...nav.groups[0].pages[0],route:'../pair'}]}]},{...nav,groups:[{...nav.groups[0],pages:[{...nav.groups[0].pages[0],badge:{kind:'html',count:1,label:'x'}}]}]},{...nav,status:{...nav.status,ok:'yes'}}];
  for(const value of cases)assert.equal(B.readNav(value),null);
});
test('future registry pages flow into navigation diffs and palette without a bridge page table',()=>{
  const previous=navFixture(),next=navFixture();next.groups[0].pages.push({route:'backups',title:'Backups',icon:'home',badge:{kind:'count',count:2,label:'2 backups'}});
  const diff=B.navDiff(previous,next);assert.equal([...diff.added].join(),'backups');assert.equal([...diff.order].join(),'overview,backups');
  next.groups[0].pages.shift();next.current='backups';assert.equal([...B.navDiff(previous,next).removed].join(),'overview');
  const items=B.readPalette([{id:'backups',route:'backups',title:'Backups',meta:'Setup · restore points',icon:'home',terms:['restore']}],next);
  assert.equal(B.paletteMatches('setup backups',items)[0].route,'backups');
});
