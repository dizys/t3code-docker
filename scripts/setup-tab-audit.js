#!/usr/bin/env node
// Real console, disposable fixtures: host layout and frame density are independent.
// NODE_PATH=<Playwright modules> node scripts/setup-tab-audit.js [fixture URL]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { framed, routeConsole, visit, statusFor, portsFor } = require('./lib/console-fixtures.cjs');
const BASE = process.argv[2] || 'http://127.0.0.1:23920/__setup/';
const OUT = process.env.T3_TAB_UI_OUTPUT;
(async () => {
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  let checks = 0;
  try {
    for (const width of [390,480,639,640,704,1040]) for (const theme of ['light','dark']) {
      const page = await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
      const errors=[]; page.on('pageerror',error=>errors.push(error.message));
      await routeConsole(page, { status: () => statusFor('attention'), ports: () => portsFor('attention') });
      const frame = await framed(page,BASE+'?embed=t3&host=tab&layout=compact&theme='+theme);
      await page.evaluate(()=>{window.messages=[];addEventListener('message',event=>{if(event.data?.source==='t3-setup')messages.push(event.data);});});
      await visit(frame,page,'agents');
      const data=await frame.evaluate(()=>({compact:document.documentElement.hasAttribute('data-compact'),density:document.body.dataset.density,header:document.querySelector('.tc-pagebar').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth}));
      assert.equal(data.compact,width<640); assert.equal(data.density,width<640?'touch':undefined); assert.equal(data.header,48); assert.equal(data.overflow,false);
      assert.equal(await frame.locator('.tc-sidebar,.tc-phonebar,.tc-tabbar,#page-more').count(),0);
      await frame.locator('#setup-pages').click();
      const menu=frame.locator('.tc-pagemenu'); await menu.waitFor();
      assert.equal(await menu.getAttribute('role'),'menu');
      assert.equal(await menu.locator('[aria-current=page]').textContent().then(t=>t.trim().startsWith('Agents')),true);
      assert.equal(await menu.locator('[data-menu-cancel]').count(),0);
      assert.equal(await menu.locator('[role=menuitemradio]').count(),12);
      assert.equal(await menu.locator('[aria-current=page] > svg').count(),2);
      const box=await menu.boundingBox();assert(box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=900);
      const row=await menu.locator('[role=menuitemradio]').first().boundingBox();assert.equal(row.height,width<640?44:32);
      if(width<640) await page.waitForFunction(()=>messages.some(m=>m.type==='layer'&&m.open)); else assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='layer'&&m.open)),false);
      if (OUT) {fs.mkdirSync(OUT,{recursive:true}); await page.screenshot({path:path.join(OUT,`${width}-${theme}-menu.png`)});}
      if(width>=640){
        await page.keyboard.press('Tab');
        assert.equal(await menu.locator('a').first().evaluate(el=>el===document.activeElement),true,'popover footer links are keyboard reachable');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await menu.locator('[aria-current=page]').evaluate(el=>el===document.activeElement),true);
      }
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); await menu.waitFor({state:'detached'});
      assert.equal(await frame.locator('#setup-pages').evaluate(el=>el===document.activeElement),true);
      if(width===390&&theme==='light'){
        await frame.locator('#setup-pages').click();
        await frame.locator('[data-menu-drag]').evaluate(head=>{
          head.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch',pointerId:7,isPrimary:true,clientY:100}));
          head.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'touch',pointerId:7,isPrimary:true,clientY:180}));
        });
        await menu.waitFor({state:'detached'});
      }
      await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({source:'t3-code',type:'navigate',route:'storage'},location.origin));
      await frame.waitForFunction(()=>document.body.dataset.consoleRoute==='storage');
      await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({source:'t3-code',type:'navigate',route:'invalid'},location.origin));
      assert.equal(await frame.evaluate(()=>document.body.dataset.consoleRoute),'storage');
      await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({source:'t3-code',type:'host',layout:'wide'},location.origin));
      await frame.waitForFunction(()=>document.documentElement.dataset.hostLayout==='wide');
      assert.equal(await frame.locator('.tc-console-topbar').evaluate(el=>el.getBoundingClientRect().height),48);
      assert.equal(await frame.locator('#setup-pages').isVisible(),false);
      if (width === 704 && theme === 'light') {
        await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({source:'t3-code',type:'navigate',route:'instructions'},location.origin));
        await frame.locator('[data-cmd="context.edit"]').first().click();
        await frame.locator('#cx-input').fill('A draft that must survive navigation and resizing');
        await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({source:'t3-code',type:'navigate',route:'agents'},location.origin));
        await frame.locator('[role=alertdialog]').waitFor();
        await frame.locator('[role=alertdialog] [data-answer=no]').click();
        assert.equal(await frame.locator('#cx-input').inputValue(),'A draft that must survive navigation and resizing');
        assert.equal(await frame.evaluate(()=>document.body.dataset.consoleRoute),'instructions');
        await frame.evaluate(()=>window.__draftIdentity={});
        await page.setViewportSize({width:480,height:800});
        await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({source:'t3-code',type:'host',layout:'compact'},location.origin));
        assert.equal(await frame.locator('#cx-input').inputValue(),'A draft that must survive navigation and resizing');
        assert.equal(await frame.evaluate(()=>Boolean(window.__draftIdentity)),true);
        await page.keyboard.press('Escape');
        await frame.locator('[role=alertdialog]').waitFor();
        await frame.locator('[role=alertdialog] button').filter({hasText:'Discard draft'}).click();
        await frame.locator('#cx-input').waitFor({state:'detached'});
      }
      assert.deepEqual(errors,[]); checks+=14;
      await page.close();
    }
    console.log(`setup-tab-audit: ${checks} frame/header/menu/navigation checks passed`);
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
