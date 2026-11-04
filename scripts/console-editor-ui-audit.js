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
const requested = (process.env.T3_EDITOR_UI_VARIANTS || '').split(',').filter(Boolean);
const selected = variants.filter(([name])=>!requested.length||requested.includes(name));
assert(selected.length,'Select at least one editor audit layout.');
(async()=>{
  // Playwright hides scrollbars by default, masking native/mirror viewport drift.
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/chromium',args:['--no-sandbox'],ignoreDefaultArgs:['--hide-scrollbars']});
  let checks = 0;
  const alignment = async (field, label) => {
    const original = await field.inputValue();
    const lines = Array.from({length:65},(_,i)=>`${i + 1} abcdefghijklmnopqrstuvwxyz `.repeat(8)), text = lines.join('\n');
    await field.fill(text);
    for (const scrollbars of ['auto','none','auto']) {
      for (const edge of ['middle','bottom','right']) {
        const geometry = await field.evaluate(async (input,{scrollbars,edge})=>{
          input.style.scrollbarWidth = scrollbars;
          input.focus(); input.setSelectionRange(input.value.indexOf('54 abc'),input.value.indexOf('62 abc'));
          input.scrollTop = edge === 'middle' ? 550 : input.scrollHeight;
          input.scrollLeft = edge === 'right' ? input.scrollWidth : 0;
          input.dispatchEvent(new Event('scroll'));
          const mirror = input.closest('.tc-files-editor-workspace').querySelector('[data-editor-mirror]');
          // Native selection, scrolling and resize observers can queue separate paints.
          for(let frame=0;frame<20;frame++){
            await new Promise(resolve=>requestAnimationFrame(resolve));
            if(mirror.clientHeight===input.clientHeight&&mirror.clientWidth===input.clientWidth&&mirror.scrollHeight===input.scrollHeight&&Math.abs(mirror.scrollTop-input.scrollTop)<1&&Math.abs(mirror.scrollLeft-input.scrollLeft)<1)break;
          }
          return {bar:input.offsetHeight-input.clientHeight,height:input.clientHeight,width:input.clientWidth,mirrorHeight:mirror.clientHeight,mirrorWidth:mirror.clientWidth,scrollHeight:input.scrollHeight,mirrorScrollHeight:mirror.scrollHeight,top:input.scrollTop,mirrorTop:mirror.scrollTop,left:input.scrollLeft,mirrorLeft:mirror.scrollLeft,start:input.selectionStart,end:input.selectionEnd};
        },{scrollbars,edge});
        assert.equal(geometry.bar > 0,scrollbars === 'auto',label+' exercises reserved and overlay-size scrollbar viewports');
        assert.equal(geometry.mirrorHeight,geometry.height,label+' mirror excludes the horizontal scrollbar');
        assert.equal(geometry.mirrorWidth,geometry.width,label+' mirror excludes the vertical scrollbar');
        assert.equal(geometry.mirrorScrollHeight,geometry.scrollHeight,label+' virtual lines preserve the native scroll range');
        assert(Math.abs(geometry.top-geometry.mirrorTop)<1,label+' selection stays vertically aligned at '+edge+' ('+geometry.top+' / '+geometry.mirrorTop+')');
        assert(Math.abs(geometry.left-geometry.mirrorLeft)<1,label+' selection stays horizontally aligned at '+edge);
        assert.equal(geometry.start,text.indexOf('54 abc'));assert.equal(geometry.end,text.indexOf('62 abc'));checks+=8;
      }
      // Hit-test painted text against the real native caret at the bottom.
      const point = await field.evaluate(async input=>{
        input.scrollLeft=0;input.dispatchEvent(new Event('scroll'));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const row=[...input.closest('.tc-files-editor-workspace').querySelectorAll('.tc-files-editor-line')].find(line=>line.querySelector('i').textContent==='59');
        const walker=document.createTreeWalker(row.querySelector('code'),NodeFilter.SHOW_TEXT);
        let node,offset=12;while((node=walker.nextNode())&&offset>=node.length)offset-=node.length;
        const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+1);
        const glyph=range.getBoundingClientRect(),bounds=input.getBoundingClientRect();
        return {x:glyph.left-bounds.left+0.1,y:glyph.top-bounds.top+glyph.height/2};
      });
      await field.click({position:point});
      assert.equal(await field.evaluate(input=>input.selectionStart),lines.slice(0,58).join('\n').length+1+12,label+' clicking painted text places the native caret on that character');checks++;
    }
    assert.equal(await field.inputValue(),text,label+' scrolling and repainting preserve the draft');checks++;
    await field.fill(original);
    await field.evaluate(input=>{input.style.scrollbarWidth='';input.scrollTop=0;input.scrollLeft=0;input.dispatchEvent(new Event('scroll'));});
  };
  try {
    for (const theme of ['light','dark']) for (const [name,width,height,embedded] of selected) {
      const context = await browser.newContext({viewport:{width,height},colorScheme:theme,reducedMotion:process.env.T3_EDITOR_UI_MOTION || 'reduce'}), page = await context.newPage(), errors = [];
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
      await target.evaluate(()=>location.hash='files/projects/acme-web/apps/web');
      const config=target.locator('[data-path$="next.config.mjs"][data-files-row]');await config.waitFor();
      if(width<1024){await config.click();await target.getByRole('button',{name:'Edit',exact:true}).click();}else await config.dblclick();
      const file=target.locator('[data-files-editor-text]');await file.waitFor();
      await alignment(file,name+' '+theme+' Files');await target.locator('[data-editor-close]').click();
      await target.evaluate(()=>location.hash='instructions');await target.locator('[data-cmd="context.edit"]').first().click();
      const field=target.locator('#cx-input');await field.waitFor({state:'visible'});await field.waitFor({state:'attached'});
      await target.waitForFunction(()=>!document.querySelector('#cx-input').disabled);
      const draft='---\nname: careful-review\n---\n# Instructions\nUse `npm test` and **review changes**.\n\n```js\nconst safe = "<img onerror=alert(1)>";\n```\n';
      await field.fill(draft);await target.locator('[data-source-editor="cx-input"] .tc-files-editor-line .k').first().waitFor();
      assert.equal(await field.inputValue(),draft);assert.equal(await target.evaluate(()=>window.skillInjected),undefined);
      assert.equal(await target.locator('[data-source-editor="cx-input"] .tc-files-editor-line .h').textContent(),'# Instructions');checks+=3;
      // The caret belongs to the transparent input, so its text must start exactly where the painted text does.
      const caretGap=await target.evaluate(()=>{const input=document.querySelector('#cx-input'),code=document.querySelector('[data-source-editor="cx-input"] .tc-files-editor-line code'),text=document.createTreeWalker(code,NodeFilter.SHOW_TEXT).nextNode(),range=document.createRange();range.setStart(text,0);range.setEnd(text,1);const style=getComputedStyle(input);return range.getBoundingClientRect().left-(input.getBoundingClientRect().left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft)-input.scrollLeft);});
      assert(Math.abs(caretGap)<0.5,name+' typed text starts where the painted text does (off by '+caretGap+'px)');checks++;
      const nativeField=await field.evaluate(el=>{window.__editorIdentity=el;return el.id;});assert.equal(nativeField,'cx-input');
      await field.press('Control+End');await field.press('End');await field.press('x');await field.press('Control+z');assert.equal(await field.inputValue(),draft,'native undo remains available');checks++;
      await field.press('Control+f');await target.locator('#cx-input-find').fill('safe');
      assert.equal(await target.locator('[data-source-matches]').textContent(),'1 of 1');
      await target.locator('#cx-input-find').press('Escape');assert.equal(await target.locator('.tc-source-find').isVisible(),false);checks+=2;
      await target.waitForFunction(()=>{const input=document.querySelector('#cx-input'),cur=document.querySelector('[data-source-editor="cx-input"] [data-cur] i');return Number(cur?.textContent)===input.value.slice(0,input.selectionStart).split('\n').length;});
      await page.screenshot({path:path.join(output,`${name}-${theme}-instructions.png`),fullPage:false});
      await alignment(field,name+' '+theme+' Instructions');
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
      await alignment(target.locator('#skill-content'),name+' '+theme+' Skills');
      await page.screenshot({path:path.join(output,`${name}-${theme}-skill.png`),fullPage:false});
      assert.deepEqual(errors,[],name+' '+theme+' has no browser errors');checks++;
      await context.close();console.log(name+' '+theme+': editor and selection passed');
    }
    console.log(checks+' shared editor and selection checks passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
