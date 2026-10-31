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
 *   - opens the console inside native Settings, signed in on its T3 session, in T3's
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
      await page.screenshot({ path: path.join(OUTPUT, `settings-${name}-${theme}.png`), scale: page.viewportSize().width < 768 ? 'device' : 'css', animations: "disabled" });
    }
  } finally {
    await page.emulateMedia({ colorScheme: wasDark ? "dark" : "light" });
    await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, wasDark);
  }
};

const run = async base => {
  const browser = await chromium.launch({executablePath:CHROME,args:['--no-sandbox','--disable-features=LocalNetworkAccessChecks']});
  let page;
  try {
    const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:2,reducedMotion:'reduce'});
    await useBridge(context);page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/');
    await page.locator('.t3-setup-pill').waitFor();
    expect(await page.locator('.t3-setup-pill').getAttribute('href')==='/__setup/','unpaired clients have the standalone Setup pill');
    await page.goto('about:blank');
    const [paired]=await Promise.all([page.waitForResponse(r=>r.url()===base+'/api/auth/browser-session'&&r.request().method()==='POST'),page.goto(base+'/pair#token='+encodeURIComponent(CREDENTIAL))]);
    expect(paired.ok(),'native pairing exchanges the disposable credential');
    await page.waitForURL(url=>!url.pathname.startsWith('/pair'),{waitUntil:'commit'});
    await visit(page,base+'/');
    await visit(page,base+'/settings/general');await page.locator(ENTRY).waitFor();
    expect(await page.locator('.t3-setup-pill').count()===0,'the pill goes away after pairing');
    const hello=await page.evaluate(()=>fetch('/__setup/hello').then(r=>r.json()));
    expect(hello.signedIn&&hello.protocol===2&&hello.nav.groups.length>0,'authenticated hello provides the navigation registry');
    const pin=await page.locator(ENTRY).evaluate(button=>{
      const pin=button.closest('[data-t3-setup-entry]'),nav=pin.parentElement,previous=pin.previousElementSibling;
      const source=nav.querySelector('[data-sidebar=content] [data-settings-section]'),a=button.getBoundingClientRect(),b=source.getBoundingClientRect();
      return {outside:nav.tagName==='NAV'&&!!previous.querySelector('[data-sidebar=content]'),height:a.height,nativeHeight:b.height,left:a.left,nativeLeft:b.left,width:a.width,nativeWidth:b.width,visible:a.bottom<innerHeight,label:button.getAttribute('aria-label')};
    });
    expect(pin.outside&&pin.visible,'the pin is outside the native scrolling list and visible');
    expect(Math.abs(pin.height-pin.nativeHeight)<=1&&Math.abs(pin.width-pin.nativeWidth)<=1&&Math.abs(pin.left-pin.nativeLeft)<=1,'the pin copies a native page row, including its geometry',JSON.stringify(pin));
    expect(pin.label.startsWith('Setup'),'the pin has an accessible name');
    const badge=await page.locator('[data-t3-setup-entry] .t3-setup-badge').evaluate(el=>el.hidden?'':el.textContent);
    expect(badge===(hello.attention>99?'99+':hello.attention?String(hello.attention):''),'the pin count matches authenticated hello');
    await captureSettings(page,'desktop');
    await page.setViewportSize({width:1024,height:600});
    expect(await page.locator(ENTRY).evaluate(el=>el.getBoundingClientRect().bottom<innerHeight),'the pin remains visible at 600px height');
    await page.setViewportSize({width:1440,height:900});
    const bodyChildren=await page.evaluate(()=>document.body.children.length);
    const open=async()=>{await page.locator(ENTRY).click();await page.locator('.t3-setup-pane[data-ready]').waitFor();return page.frames().find(f=>f.url().includes('/__setup/'));};
    let frame=await open();await frame.locator('#page-overview .tc-page-head').waitFor();
    expect(await page.locator('.t3-setup-layer').count()===0&&await page.locator('.t3-setup-pane').count()===1,'Setup uses a pane inside native Settings, with no second modal');
    expect(await page.evaluate(count=>document.body.children.length===count,bodyChildren),'opening Setup adds no body-level overlay');
    const geometry=await page.evaluate(()=>{
      const nav=document.querySelector('nav[data-t3-setup-host]'),pane=document.querySelector('.t3-setup-pane'),content=document.querySelector('[data-workspace-area=settings]');
      const n=nav.getBoundingClientRect(),p=pane.getBoundingClientRect();
      return {adjacent:Math.abs(n.right-p.left)<=1,inert:[...content.children].every(el=>el.inert&&el.getAttribute('aria-hidden')==='true'),parent:pane.parentElement===nav.parentElement};
    });
    expect(geometry.adjacent&&geometry.inert&&geometry.parent,'wide pane covers only native content and masks the original nodes',JSON.stringify(geometry));
    expect(await frame.locator('.tc-crumbs').textContent().then(t=>/Settings.*Setup.*Overview/.test(t)),'the wide header reads Settings / Setup / Overview');
    expect(await frame.locator('.tc-sidebar,.tc-phonebar,.tc-tabbar,#page-more').count()===0,'tab mode has one navigation system');
    await page.locator('.t3-setup-nav [data-route=agents]').focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.locator('.t3-setup-nav [data-route=instructions]').evaluate(el=>el===document.activeElement),'arrow keys follow visual navigation order');
    await page.keyboard.press('Home');
    expect(await page.locator('.t3-setup-back').evaluate(el=>el===document.activeElement),'Home reaches Back to Settings');
    const nativeURL=page.url();
    await page.locator('.t3-setup-nav [data-route=agents]').click();
    await frame.waitForFunction(()=>document.body.dataset.consoleRoute==='agents');
    await page.locator('.t3-setup-nav [data-route=agents][aria-current=page]').waitFor();
    expect(page.url()===nativeURL,'child navigation preserves the native Settings URL');
    expect(await page.locator('.t3-setup-nav [data-route=agents]').getAttribute('href')==='/__setup/#agents','modified clicks use the standalone page address');
    await frame.locator('#main').focus();await page.keyboard.press('g');await page.keyboard.press('o');
    await page.locator('.t3-setup-nav [data-route=overview][aria-current=page]').waitFor();ok('the child shortcut controls the parent highlight');
    const [standalone]=await Promise.all([context.waitForEvent('page'),page.locator('.t3-setup-nav [data-route=agents]').click({modifiers:['Control']})]);
    await standalone.waitForLoadState('domcontentloaded');
    expect(new URL(standalone.url()).hash==='#agents'&&!new URL(standalone.url()).searchParams.has('embed'),'Control-click opens the standalone page in a new tab');
    await standalone.close();
    // The whole console is already loaded. Changing pages must remain local
    // even while API reads take a full network round trip.
    const frameToken=await frame.evaluate(()=>window.__slowNavigationIdentity=String(Math.random()));
    const documents=[];const record=request=>{if(request.resourceType()==='document'&&new URL(request.url()).pathname.includes('/__setup/'))documents.push(request.url());};
    page.on('request',record);
    const network=await context.newCDPSession(page),timings=[];
    await network.send('Network.enable');
    await network.send('Network.emulateNetworkConditions',{offline:false,latency:1800,downloadThroughput:512000,uploadThroughput:128000});
    try {
      for(const route of hello.nav.groups.flatMap(group=>group.pages.map(page=>page.route))) {
        const started=Date.now();await page.locator('.t3-setup-nav [data-route="'+route+'"]').click();
        await frame.waitForFunction(route=>document.body.dataset.consoleRoute===route,route,{timeout:1200});
        await page.locator('.t3-setup-nav [data-route="'+route+'"][aria-current=page]').waitFor({timeout:1200});
        timings.push({route,ms:Date.now()-started});
      }
      if(OUTPUT)fs.writeFileSync(path.join(OUTPUT,'slow-navigation.json'),JSON.stringify({networkLatencyMs:1800,documents,timings},null,2));
      expect(timings.every(t=>t.ms<1200),'every Setup page switches before the throttled network round trip',JSON.stringify(timings));
      expect(await frame.evaluate(()=>window.__slowNavigationIdentity)===frameToken&&documents.length===0,'slow-network navigation keeps one iframe document and downloads no new shell');
    } finally {
      await network.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await network.detach();page.off('request',record);
    }
    await page.locator('.t3-setup-nav [data-route=overview]').click();await frame.waitForFunction(()=>document.body.dataset.consoleRoute==='overview');
    // A sibling frame, a forged source, and malformed payloads cannot navigate.
    await page.evaluate(()=>{
      window.postMessage({source:'t3-setup',type:'close'},location.origin);
      dispatchEvent(new MessageEvent('message',{source:document.querySelector('iframe.t3-setup-frame').contentWindow,origin:'https://untrusted.invalid',data:{source:'t3-setup',type:'back'}}));
      const child=document.querySelector('iframe.t3-setup-frame').contentWindow;
      dispatchEvent(new MessageEvent('message',{source:child,origin:location.origin,data:{source:'t3-setup',type:'settings',path:'/settings/../../pair'}}));
    });
    expect(await page.locator('.t3-setup-pane').count()===1&&page.url()===nativeURL,'source, origin and settings-path guards reject forged messages');
    // Future pages arrive as data, and surviving anchors keep DOM and focus.
    await page.locator('.t3-setup-nav [data-route=agents]').focus();
    await page.evaluate(()=>window.__agentRow=document.querySelector('.t3-setup-nav [data-route=agents]'));
    const future=structuredClone(hello.nav);future.current='overview';future.groups.find(g=>g.id==='system').pages.push({route:'backups',title:'Backups',icon:'hard-drive',badge:null});
    // Reuse a supplied safe icon; no new executable markup crosses the boundary.
    future.groups.at(-1).pages.at(-1).icon=future.groups[0].pages[0].icon;
    await frame.evaluate(payload=>parent.postMessage({source:'t3-setup',type:'nav',...payload},location.origin),{...future,icons:hello.icons});
    await page.locator('.t3-setup-nav [data-route=backups]').waitFor();
    expect(await page.evaluate(()=>window.__agentRow===document.querySelector('.t3-setup-nav [data-route=agents]')&&document.activeElement===window.__agentRow),'adding a registry page keeps existing row DOM and focus');
    const removed=structuredClone(future);removed.groups.find(g=>g.id==='agents').pages=removed.groups.find(g=>g.id==='agents').pages.filter(p=>p.route!=='agents');
    await frame.evaluate(payload=>parent.postMessage({source:'t3-setup',type:'nav',...payload},location.origin),{...removed,icons:hello.icons});
    await page.locator('.t3-setup-nav [data-route=agents]').waitFor({state:'detached'});
    expect(await page.locator('.t3-setup-nav [data-route=overview]').evaluate(el=>el===document.activeElement),'removing the focused page moves focus to the current row');
    await page.evaluate(()=>document.querySelector('.t3-setup-frame').contentWindow.postMessage({source:'t3-code',type:'navigate',route:'overview'},location.origin));
    await page.locator('.t3-setup-nav [data-route=agents]').waitFor();
    await require('./appearance-ui-audit.js').nativeAppearance({page,frame,expect,output:OUTPUT});
    // Layer masking is reference-counted by the child stack, never by popovers.
    await frame.waitForFunction(()=>document.body.dataset.consoleRoute==='overview');
    await frame.locator('#main').focus();await page.keyboard.press('Control+k');await frame.locator('.tc-palette').waitFor();
    await page.locator('.t3-setup-scrim').waitFor();
    expect(await page.locator('.t3-setup-scrim').count()===1,'one host scrim covers the nav while a child modal is open');
    expect(await page.locator('.t3-setup-nav').evaluate(el=>[...el.children].filter(c=>!c.classList.contains('t3-setup-scrim')).every(c=>c.inert)),'the drilled nav is inert during the child modal');
    await page.keyboard.press('Escape');await frame.locator('.tc-palette').waitFor({state:'detached'});await page.locator('.t3-setup-scrim').waitFor({state:'detached'});ok('Escape closes the child layer first');
    await page.locator('.t3-setup-back').click();await page.locator('.t3-setup-pane').waitFor({state:'detached'});
    expect(page.url()===nativeURL&&await page.locator(ENTRY).evaluate(el=>el===document.activeElement),'Back to Settings restores the native page and pin focus');
    expect(await page.locator('[data-workspace-area=settings]').evaluate(el=>[...el.children].every(c=>!c.inert&&!c.hasAttribute('aria-hidden'))),'leaving Setup restores native reachability');
    frame=await open();await page.locator('.t3-setup-nav [data-route=agents]').click();await frame.locator('[data-cmd="embed.settings"]').click();
    await page.waitForURL(url=>url.pathname==='/settings/providers');
    await page.locator('.t3-setup-pane').waitFor({state:'detached'});
    await page.locator('[data-settings-section="/settings/providers"][data-active=true]').waitFor();ok('the Providers link returns to the native Providers page');
    frame=await open();await page.locator('.t3-setup-nav [data-route=access]').click();await frame.locator('#pair-label').fill('Preserve this draft across host layouts');
    await frame.evaluate(()=>window.__resizeIdentity={});
    for(const width of [1024,930,820,767,744,390,1024,1440]){
      await page.setViewportSize({width,height:width<768?1000:768});
      await frame.waitForFunction(wide=>document.documentElement.dataset.hostLayout===(wide?'wide':'compact'),width>=768);
      expect(await frame.evaluate(()=>!!window.__resizeIdentity&&document.getElementById('pair-label').value==='Preserve this draft across host layouts'),'resizing to '+width+' preserves the frame document and draft');
      await frame.waitForFunction(()=>document.documentElement.hasAttribute('data-compact')===(innerWidth<640));
      const density=await frame.evaluate(()=>({width:innerWidth,compact:document.documentElement.hasAttribute('data-compact')}));
      expect(density.compact===(density.width<640),'frame density is independent of host layout at '+width);
    }
    await page.reload();await page.locator('.t3-setup-pane[data-ready]').waitFor();frame=page.frames().find(f=>f.url().includes('/__setup/'));
    await frame.waitForFunction(()=>document.body.dataset.consoleRoute==='access');ok('reload restores the open Setup page');
    await frame.locator('.tc-console-topbar [data-cmd="embed.close"]').click();await page.locator('[data-app-modal][aria-label=Settings]').waitFor({state:'detached'});
    expect(!new URL(page.url()).pathname.startsWith('/settings'),'the console Close button closes native Settings');
    expect(await page.evaluate(()=>sessionStorage.getItem('t3-setup-tab'))===null,'closing Settings clears remembered Setup state');
    // Native palette navigation is verified from chat, including new registry pages.
    const search=async query=>{
      const button=page.getByRole('button',{name:/^Search/}).first();if(await button.count())await button.click();else await page.keyboard.press('Control+k');
      await page.locator('[data-command-palette=true] input[role=combobox]').fill(query);
      await page.locator('[data-t3-setup-item]').first().waitFor();
    };
    for(const entry of hello.palette.filter(item=>item.route)){
      const query='setup '+entry.title,route=entry.route,id=entry.id;
      const documentToken=await page.evaluate(()=>{window.__setupPaletteDocument=String(Math.random());return window.__setupPaletteDocument;});
      await search(query);
      const result=page.locator('[data-t3-setup-item="'+id+'"]');
      await result.waitFor();
      if(id==='files-trash') {
        // Native asynchronous results can replace the list after our first
        // row appears. Exercise that redraw instead of assuming the first
        // observation remains valid until the next browser call.
        const removed=await page.evaluate(()=>{
          document.querySelector('[data-t3-setup-palette]')?.remove();
          return document.querySelectorAll('[data-t3-setup-item="files-trash"]').length===0;
        });
        expect(removed,'native list redraw removes the injected palette results');
      }
      await page.waitForFunction(({id,query})=>{
        const input=document.querySelector('[data-command-palette=true] input[role=combobox]');
        const rows=document.querySelectorAll('[data-t3-setup-item="'+id+'"]');
        return input?.value===query&&rows.length===1&&rows[0].getBoundingClientRect().height>0;
      },{id,query});
      ok('registry palette search finds '+id+' after native results settle');
      await page.waitForFunction(id=>{const icon=document.querySelector('[data-t3-setup-item="'+id+'"] > svg');return icon&&Math.abs(icon.getBoundingClientRect().width-16)<0.2;},id);
      expect(await result.locator('svg').evaluate(el=>Math.abs(el.getBoundingClientRect().width-16)<0.2&&Math.abs(el.getBoundingClientRect().height-16)<0.2),'palette icons stay bounded at 16px');
      await result.click();await page.locator('.t3-setup-pane[data-ready]').waitFor();frame=page.frames().find(f=>f.url().includes('/__setup/'));
      await frame.waitForFunction(route=>document.body.dataset.consoleRoute===route,route);
      if(entry.hash)expect(await frame.evaluate(()=>location.hash)==='#'+entry.hash,'palette opens the exact '+entry.title+' subpage');
      ok('native palette opens Settings / Setup / '+entry.title);
      expect(await page.evaluate(()=>window.__setupPaletteDocument)===documentToken,'the pinned native router opens Settings without a document reload');
      await frame.locator('.tc-console-topbar [data-cmd="embed.close"]').click();await page.locator('.t3-setup-pane').waitFor({state:'detached'});
    }
    if(process.env.T3_BRIDGE_UI_FIXTURES==='1') {
      const {routeConsole,statusFor,portsFor}=require('./lib/console-fixtures.cjs');
      await routeConsole(page,{status:()=>statusFor('skills'),ports:()=>portsFor('ready')});
    }
    for(const width of [1440,1024,820,744,390]){
      await page.setViewportSize({width,height:width===1440?900:width===1024?768:width===390?844:1000});
      await visit(page,base+'/settings/general');await page.locator(ENTRY).waitFor();
      if(width===390)expect(await page.locator(ENTRY).evaluate(el=>getComputedStyle(el.querySelector('.t3-setup-badge')).display==='none'),'the compact rail hides the count in favor of a dot');
      if(OUTPUT)await captureSettings(page,String(width));
      frame=await open();
      for(const mode of ['light','dark']){
        await page.emulateMedia({colorScheme:mode});await frame.waitForFunction(mode=>document.documentElement.dataset.theme===mode,mode);
        if(OUTPUT)await page.screenshot({path:path.join(OUTPUT,`tab-${width}-${mode}.png`),scale:width<768?'device':'css',animations:'disabled'});
      }
      if(OUTPUT&&process.env.T3_BRIDGE_UI_FIXTURES==='1') {
        await frame.evaluate(()=>location.hash='agents');await frame.waitForFunction(()=>document.body.dataset.consoleRoute==='agents');
        for(const mode of ['light','dark']) {
          await page.emulateMedia({colorScheme:mode});await frame.waitForFunction(mode=>document.documentElement.dataset.theme===mode,mode);
          await page.screenshot({path:path.join(OUTPUT,`agents-${width}-${mode}.png`),scale:width<768?'device':'css',animations:'disabled'});
        }
        await frame.locator('#page-agents [data-cmd="row.menu"]').first().click();
        await frame.getByRole('menuitem',{name:/Uninstall/}).click();
        await frame.locator('[role=alertdialog]').waitFor();
        for(const mode of ['dark','light']) {
          await page.emulateMedia({colorScheme:mode});await frame.waitForFunction(mode=>document.documentElement.dataset.theme===mode,mode);
          await page.screenshot({path:path.join(OUTPUT,`dialog-${width}-${mode}.png`),scale:width<768?'device':'css',animations:'disabled'});
        }
        await page.keyboard.press('Escape');await frame.locator('[role=alertdialog]').waitFor({state:'detached'});
        await page.emulateMedia({colorScheme:'dark'});await frame.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
      }
      if(width<768){
        const pane=await page.locator('.t3-setup-pane').boundingBox(),modal=await page.locator('[data-app-modal][aria-label=Settings]').boundingBox();
        expect(Math.abs(pane.width-modal.width)<=2,'compact Setup covers the whole native Settings surface at '+width);
        await frame.locator('#setup-pages').click();await frame.locator('.tc-pagemenu').waitFor();
        const shape=await frame.locator('.tc-pagemenu').evaluate(el=>el.classList.contains('tc-sheet--bottom'));
        expect(shape===(width===390),'the compact page switcher uses the right menu shape at '+width);
        expect(await page.locator('.t3-setup-scrim').count()===0,'compact mode needs only the child backdrop');
        if(OUTPUT)await page.screenshot({path:path.join(OUTPUT,`tab-${width}-menu-dark.png`),scale:width<768?'device':'css',animations:'disabled'});
        await frame.locator('.tc-pagemenu [role=menuitemradio]').filter({hasText:'Agents'}).click();await frame.waitForFunction(()=>document.body.dataset.consoleRoute==='agents');
      }
      await frame.locator('#main').focus();await page.keyboard.press('Escape');await page.locator('.t3-setup-pane').waitFor({state:'detached'});
    }
    // Cross-site writes and forged native sessions remain refused.
    const cookies=(await context.cookies()).filter(c=>c.name.startsWith('t3_session')).map(c=>`${c.name}=${c.value}`).join('; ');
    for(const site of ['cross-site','same-site']){
      const response=await fetch(base+'/__setup/revoke',{method:'POST',headers:{cookie:cookies,'content-type':'application/json','sec-fetch-site':site},body:JSON.stringify({kind:'link',id:'none'})});expect(response.status===403,'rejects '+site+' native-session writes');
    }
    const framing=await fetch(base+'/__setup/',{headers:{cookie:cookies}});
    expect(/frame-ancestors 'self'/.test(framing.headers.get('content-security-policy')||''),'only the same origin may frame Setup');
    expect(errors.length===0,'no browser script errors',errors.join('\n'));
    await context.close();
  }catch(error){
    if(OUTPUT&&page){await page.screenshot({path:path.join(OUTPUT,'failure.png'),animations:'disabled',timeout:5000}).catch(()=>{});fs.writeFileSync(path.join(OUTPUT,'failure.json'),JSON.stringify(await page.evaluate(()=>({path:location.pathname,host:!!document.querySelector('nav[data-workspace-area=settings-nav]'),pin:!!document.querySelector('[data-t3-setup-entry]'),pane:document.querySelector('.t3-setup-pane')?.outerHTML,nav:document.querySelector('.t3-setup-nav')?.outerHTML})).catch(()=>({})),null,2));}
    throw error;
  }finally{await browser.close();}
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
