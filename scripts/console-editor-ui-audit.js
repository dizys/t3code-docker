#!/usr/bin/env node
// Shared source editing and selection geometry, using only in-memory APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
let chromium; try { ({chromium} = require('playwright')); } catch { ({chromium} = require('playwright-core')); }
const {routeConsole, statusFor, portsFor, framed, unlock} = require('./lib/console-fixtures.cjs');
const {createFilesFixtures} = require('./lib/files-fixtures.cjs');
const {createSkillsFixtures} = require('./lib/skills-fixtures.cjs');
const base = process.argv[2] || 'http://127.0.0.1:23785/__setup/';
const key = process.argv[3] || 'dev';
const output = process.env.T3_EDITOR_UI_OUTPUT || '/tmp/t3-editor-ui-audit';
fs.mkdirSync(output,{recursive:true});
const variants = [['desktop',1440,900],['laptop',1280,800],['tablet',820,900],['phone',390,844],['tab-narrow',480,900,true],['tab-medium',704,900,true],['tab-wide',1040,900,true]];
(async()=>{
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/chromium',args:['--no-sandbox']});
  let checks = 0;
  try {
    for (const theme of ['light','dark']) for (const [name,width,height,embedded] of variants) {
      const context = await browser.newContext({viewport:{width,height},colorScheme:theme,reducedMotion:'reduce'}), page = await context.newPage(), errors = [];
      const files = createFilesFixtures(), skills = createSkillsFixtures();
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(theme=>localStorage.setItem('t3-console-theme',theme),theme);
      await routeConsole(page,{status:()=>statusFor('skills'),ports:()=>portsFor('ready')});
      await page.route('**/*', async route=>{
        const request = route.request(), url = new URL(request.url());
        if (!url.pathname.includes('/files/') && !url.pathname.includes('/context/')) return route.fallback();
        const result = await files.respond(request.method(),url,request.method()==='POST'?request.postDataJSON():{}) || await skills.respond(request.method(),url,request.method()==='POST'?request.postDataJSON():{});
        if (!result) return route.fallback();
        await route.fulfill({status:result.status||200,json:result.body,headers:result.headers});
      });
      const target = embedded ? await framed(page,base+'?embed=t3&host=tab&layout='+(width<640?'compact':'wide')+'&theme='+theme) : page;
      if (!embedded) await page.goto(base);
      await unlock(target,key);
      await target.evaluate(()=>location.hash='files');
      const rows=target.locator('#files-browser [data-files-row]');await rows.first().waitFor();
      if (!await rows.first().locator('[data-files-check]').count()) { await target.getByRole('button',{name:'View options',exact:true}).click(); await target.getByRole('menuitem',{name:'Select items',exact:true}).click(); }
      for(let i=0;i<3;i++) { await rows.nth(i).hover();await rows.nth(i).locator('[data-files-check]').check(); }
      const bar=target.locator('.tc-fl-selbar').filter({visible:true});
      if(await bar.count()) {
        const collisions=await bar.evaluate(bar=>{
          const parts=[...bar.querySelectorAll('.tc-files-selection-summary, .tc-files-selection-actions button')].map(el=>({name:el.textContent||el.getAttribute('aria-label'),rect:el.getBoundingClientRect()})).filter(part=>part.rect.width>0&&part.rect.height>0),bounds=bar.getBoundingClientRect(),bad=[];
          for(let i=0;i<parts.length;i++)for(let j=i+1;j<parts.length;j++){const a=parts[i].rect,b=parts[j].rect;if(Math.min(a.right,b.right)>Math.max(a.left,b.left)+1&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+1)bad.push(parts[i].name+' / '+parts[j].name);}
          for(const part of parts)if(part.rect.left<bounds.left-1||part.rect.right>bounds.right+1)bad.push(part.name+' outside selection bar');
          return bad;
        });
        assert.deepEqual(collisions,[],name+' selection summary and actions never overlap');checks++;
        if (!await bar.locator('[data-cmd="files.move"]').isVisible()) {
          await bar.getByRole('button',{name:'More selection actions',exact:true}).click();
          await target.getByRole('menuitem',{name:'Move to…',exact:true}).waitFor();
          await target.getByRole('menuitem',{name:'Compress',exact:true}).waitFor();
          await page.keyboard.press('Escape');checks++;
        }
      }
      await page.screenshot({path:path.join(output,`${name}-${theme}-selection.png`),fullPage:!embedded});
      await target.evaluate(()=>location.hash='instructions');await target.locator('[data-cmd="context.edit"]').first().click();
      const field=target.locator('#cx-input');await field.waitFor({state:'visible'});await field.waitFor({state:'attached'});
      await target.waitForFunction(()=>!document.querySelector('#cx-input').disabled);
      const draft='---\nname: careful-review\n---\n# Instructions\nUse `npm test` and **review changes**.\n\n```js\nconst safe = "<img onerror=alert(1)>";\n```\n';
      await field.fill(draft);await target.locator('[data-source-editor="cx-input"] .tc-files-editor-line .k').first().waitFor();
      assert.equal(await field.inputValue(),draft);assert.equal(await target.evaluate(()=>window.skillInjected),undefined);
      assert.equal(await target.locator('[data-source-editor="cx-input"] .tc-files-editor-line .h').textContent(),'# Instructions');checks+=3;
      const nativeField=await field.evaluate(el=>{window.__editorIdentity=el;return el.id;});assert.equal(nativeField,'cx-input');
      await field.press('Control+End');await field.press('End');await field.press('x');await field.press('Control+z');assert.equal(await field.inputValue(),draft,'native undo remains available');checks++;
      await field.press('Control+f');await target.locator('#cx-input-find').fill('safe');
      assert.equal(await target.locator('[data-source-matches]').textContent(),'1 of 1');
      await target.locator('#cx-input-find').press('Escape');assert.equal(await target.locator('.tc-source-find').isVisible(),false);checks+=2;
      await target.waitForFunction(()=>{const input=document.querySelector('#cx-input'),cur=document.querySelector('[data-source-editor="cx-input"] [data-cur] i');return Number(cur?.textContent)===input.value.slice(0,input.selectionStart).split('\n').length;});
      await page.screenshot({path:path.join(output,`${name}-${theme}-instructions.png`),fullPage:false});
      // Large documents and long lines remain scrollable without an enormous DOM.
      const huge=Array.from({length:4000},(_,i)=>i===3990?'const last = "'+ 'x'.repeat(12000)+'";':'# Line '+i).join('\n');
      // Native Chromium's automated insertText is pathological for thousands
      // of newlines even in a bare textarea. Exercise the real upload/load path.
      await target.locator('#cx-file').setInputFiles({name:'large.md',mimeType:'text/markdown',buffer:Buffer.from(huge)});
      await target.waitForFunction(length=>document.querySelector('#cx-input').value.length===length,huge.length);
      await field.evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
      await target.waitForFunction(()=>document.querySelector('[data-source-editor="cx-input"] .tc-files-editor-line i')?.textContent>3900);
      assert(await target.locator('[data-source-editor="cx-input"] .tc-files-editor-line').count()<100,'only viewport lines are painted');
      assert(await target.locator('[data-source-editor="cx-input"] .tc-files-editor-line i').first().evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getBoundingClientRect().left>=el.getBoundingClientRect().left;}),'large line numbers fit their gutter');
      assert.equal(await field.evaluate(el=>window.__editorIdentity===el),true,'highlighting never replaces the native input');checks+=2;
      await target.locator('#cx-file').setInputFiles({name:'draft.md',mimeType:'text/markdown',buffer:Buffer.from(draft)});
      await target.waitForFunction(text=>document.querySelector('#cx-input').value===text,draft);
      await target.locator('[data-sheet="close"]').first().click();await target.getByRole('button',{name:'Discard draft',exact:true}).click();
      await target.evaluate(()=>location.hash='instructions/skills');
      const skill=target.locator('button[data-cmd="skills.view"]').filter({hasText:'deep-research'}).filter({visible:true}).first();await skill.click();
      await target.locator('#skill-content[readonly]').waitFor();assert.equal(await target.locator('#skill-content').getAttribute('aria-label'),'SKILL.md contents');checks++;
      await target.locator('[data-inspect-edit]').click();await target.locator('#skill-content').fill(draft);
      await target.locator('[data-source-editor="skill-content"] .h').filter({hasText:'# Instructions'}).waitFor();
      await page.screenshot({path:path.join(output,`${name}-${theme}-skill.png`),fullPage:false});
      assert.deepEqual(errors,[],name+' '+theme+' has no browser errors');checks++;
      await context.close();console.log(name+' '+theme+': editor and selection passed');
    }
    console.log(checks+' shared editor and selection checks passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
