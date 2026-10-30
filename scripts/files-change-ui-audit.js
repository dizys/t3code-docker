#!/usr/bin/env node
// Exercises the real UI against isolated, mutable in-memory Files routes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require('playwright-core'));}
const {statusFor,portsFor,routeConsole,framed,unlock}=require('./lib/console-fixtures.cjs');
const {createFilesFixtures}=require('./lib/files-fixtures.cjs');
const base=process.argv[2]||'http://127.0.0.1:23832/__setup/',key=process.argv[3]||'dev',out=process.env.T3_FILES_UI_OUTPUT||'/tmp/t3-files-change-ui';fs.mkdirSync(out,{recursive:true});
const variants=[['desktop',1440,1000],['compact',1280,800],['small-desktop',1100,1000],['tablet',834,1112],['phone',390,844],['narrow',320,740],['embedded',1198,878],['embedded-phone',390,844]],subset=process.env.T3_FILES_UI_VARIANTS?.split(',');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',args:['--no-sandbox']});let checks=0;
 try{for(const theme of (process.env.T3_FILES_UI_THEMES?.split(',')||['light','dark']))for(const [variant,width,height]of variants){if(subset&&!subset.includes(variant))continue;
  const context=await browser.newContext({viewport:{width,height},colorScheme:theme,reducedMotion:'reduce'}),page=await context.newPage(),fixture=createFilesFixtures(),errors=[],mutations=[];let hold=null,lostFinish=false,extraJobs=[];
  await context.addInitScript(()=>{
   const moved=event=>{const el=event.target===document?window:event.target;window.__fileMenuMove={type:event.type,target:el===window?'window':el.id||el.className||el.tagName,offset:el===window?[scrollX,scrollY]:[el.scrollLeft,el.scrollTop]};};
   addEventListener('scroll',moved,true);addEventListener('resize',moved);
  });
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.stack));await routeConsole(page,{status:()=>statusFor('skills'),ports:()=>portsFor('ready')});
  await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(!url.pathname.includes('/files/'))return route.fallback();const input=req.method()==='POST'?(url.pathname.endsWith('/chunk')?req.postDataBuffer():req.postDataJSON()):{};
   if(req.method()==='POST')mutations.push(url.pathname);
   if(hold&&url.pathname.endsWith(hold.route))await hold.promise;
   const result=await fixture.respond(req.method(),url,input);if(url.pathname.endsWith('/files/jobs'))result.body.jobs.push(...extraJobs);if(lostFinish&&url.pathname.endsWith('/upload/finish')){lostFinish=false;return route.abort('failed');}if(result.raw)return route.fulfill({body:result.raw,headers:result.headers});
   if(result.body.etag&&result.body.etag===req.headers()['if-none-match'])return route.fulfill({status:304,headers:{etag:result.body.etag}});
   return route.fulfill({status:result.status||200,json:result.body});});
  const target=variant.startsWith('embedded')?await framed(page,base+'?embed=t3&theme='+theme):page;if(target===page)await page.goto(base);await unlock(target,key);await target.evaluate(()=>document.fonts.ready);
  const settle=()=>target.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const shot=async name=>{await settle();await page.screenshot({path:path.join(out,variant+'-'+theme+'-'+name+'.png')});};
  const fits=async()=>{const bad=await target.evaluate(()=>[...document.querySelectorAll('.tc-layer:not([hidden]) .tc-fdlg,.tc-layer:not([hidden]) .tc-files-editor,#files-browser .tc-ftb')].filter(el=>{const r=el.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5||r.bottom>innerHeight+.5&&el.closest('.tc-layer');}).map(el=>el.className));assert.deepEqual(bad,[],variant+' '+theme+' layers fit');assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(await target.locator('#files-browser .tc-fl--projects .tc-fcell').evaluateAll(cells=>cells.filter(cell=>cell.clientWidth&&cell.scrollWidth>cell.clientWidth+1).map(cell=>cell.textContent)),[],'project names and badges stay inside their column');checks++;};
  await target.evaluate(()=>{window.__fileMenuCloses=[];const menu=Kit.menu;Kit.menu=(...args)=>{const layer=menu(...args);if(layer){const close=layer.close,openedAt=[scrollX,scrollY];layer.close=reason=>{window.__fileMenuCloses.push({reason,y:scrollY,triggerConnected:!!layer.returnTo?.isConnected,...(reason==='moved'?{openedAt,move:window.__fileMenuMove}:{})});return close(reason);};}return layer;};});
  const visit=async hash=>{await target.evaluate(value=>{location.hash=value;},hash);await target.locator('#files-search').waitFor();await target.locator('#files-browser .tc-skel-row').first().waitFor({state:'detached'});await settle();};
  // Reduced motion must not create a new visibility transition on
  // the notification host. Hiding and restoration both happen in this task.
  const ownership=await target.evaluate(()=>{
   const host=document.getElementById('toaster'),before=getComputedStyle(host).visibility;
   const layer=Kit.open({kind:'bottom',panel:{class:'tc-sheet tc-sheet--bottom tc-files-transfer-sheet',role:'dialog','aria-label':'Notification visibility probe'},render:()=>''});
   const immediate=getComputedStyle(host).visibility==='hidden';layer.close('replaced');
   return {immediate,restored:getComputedStyle(host).visibility===before};
  });
  assert.deepEqual(ownership,{immediate:true,restored:true});
  // The shared menu must communicate and enforce disabled states, including
  // synthetic child clicks and a disabled first item on desktop and touch.
  await target.evaluate(()=>{
   window.__disabledMenuRuns=0;
   Kit.menu(document.querySelector('button'),{label:'Disabled menu probe',items:[
    {label:'Unavailable action',icon:'pencil',disabled:true,run:()=>window.__disabledMenuRuns++},
    {label:'Available action',icon:'eye',run:()=>{}},
    {label:'Unavailable removal',icon:'trash-2',disabled:true,danger:true,run:()=>window.__disabledMenuRuns++},
    {label:'Another action',icon:'copy',run:()=>{}},
   ]});
  });
  assert.equal(await target.evaluate(()=>document.activeElement.textContent.trim()),'Available action','menu initially focuses its first enabled action');
  for(const label of ['Unavailable action','Unavailable removal']){
   const item=target.getByRole('menuitem',{name:label,exact:true});assert.equal(await item.isDisabled(),true);assert.equal(await item.getAttribute('aria-disabled'),'true');
   const style=await item.evaluate(el=>({opacity:Number(getComputedStyle(el).opacity),color:getComputedStyle(el).color}));
   assert(style.opacity<1&&style.opacity>=.5,'disabled menu actions remain readable but visibly muted');
   assert.notEqual(style.color,await target.getByRole('menuitem',{name:'Available action',exact:true}).evaluate(el=>getComputedStyle(el).color));
   await item.locator('.tc-menu-item-text').dispatchEvent('click');
   assert.equal(await target.evaluate(()=>window.__disabledMenuRuns),0,'disabled child clicks never run an action');
   assert.equal(await target.getByRole('menuitem',{name:'Available action',exact:true}).count(),1,'a disabled click does not dismiss the menu');
  }
  await page.keyboard.press('ArrowDown');assert.equal(await target.evaluate(()=>document.activeElement.textContent.trim()),'Another action','keyboard skips disabled items');
  await page.keyboard.press('Escape');

  if(width>=1024){
   // Breadcrumbs and inspectors scroll independently of a row menu. Only a
   // scroll that moves its anchor should dismiss it, including delayed events.
   const menuScroll=await target.evaluate(async()=>{
    const probe=document.createElement('div');
    probe.style.cssText='position:fixed;top:80px;left:20px;display:flex;gap:8px;z-index:10';
    const scroller=()=>{const el=document.createElement('div');el.style.cssText='width:100px;height:60px;overflow:auto';const content=document.createElement('div');content.style.height='200px';el.append(content);probe.append(el);return el;};
    const ancestor=scroller(),sibling=scroller(),trigger=document.createElement('button');trigger.textContent='Menu anchor';ancestor.firstChild.append(trigger);document.body.append(probe);
    let layer;
    const open=()=>layer=Kit.menu(trigger,{label:'Scroll behavior',items:Array.from({length:8},(_,i)=>({label:'Action '+i,run:()=>{}}))});
    const moved=(el,top)=>new Promise(resolve=>{el.addEventListener('scroll',resolve,{once:true});el.scrollTop=top;});
    try{
     open();await moved(sibling,20);const siblingStayed=Kit.top()===layer;
     if(layer.closed)open();
     layer.panel.style.cssText+='max-height:64px;overflow:auto';
     await moved(layer.panel,20);const internalStayed=Kit.top()===layer;
     await moved(ancestor,20);const ancestorClosed=layer.closed;
     const queued=moved(ancestor,0);open();await queued;const queuedStayed=Kit.top()===layer;
     return {siblingStayed,internalStayed,ancestorClosed,queuedStayed};
    }finally{layer?.close('probe');probe.remove();}
   });
   assert.deepEqual(menuScroll,{siblingStayed:true,internalStayed:true,ancestorClosed:true,queuedStayed:true},'menus ignore unrelated and already-applied scrolls, but close when their anchor moves');
  }

  try{await visit('files/projects/acme-web/apps/web');await target.locator('[data-path$="next.config.mjs"][data-files-row]').waitFor();await fits();
  // Only a real file drag exposes the upload target, and leaving clears it.
  const drag=await target.evaluateHandle(()=>{const value=new DataTransfer();value.items.add(new File(['fixture'],'drag-only.txt'));return value;});
  const grid=target.locator('#files-browser [role="grid"]').first();
  await grid.dispatchEvent('dragenter',{dataTransfer:drag});await grid.dispatchEvent('dragover',{dataTransfer:drag});
  await target.locator('.tc-files-drop').waitFor();await grid.dispatchEvent('dragleave',{dataTransfer:drag});
  assert.equal(await target.locator('.tc-files-drop').count(),0,'leaving a file drag clears its target');await drag.dispose();
  // Native textarea draft survives a refresh; conflict comparison never drops it.
  if(width<1024){await target.locator('[data-path$="next.config.mjs"][data-files-row]').click();await target.getByRole('button',{name:'Edit',exact:true}).click();}else await target.locator('[data-path$="next.config.mjs"][data-files-row]').dblclick();await target.locator('[data-files-editor-text]').waitFor();
  const edit=target.locator('[data-files-editor-text]');await edit.fill('// My edit\nexport default { strict: true };');
  await fixture.respond('POST',new URL('http://fixture/files/write'),{path:'/workspace/acme-web/apps/web/next.config.mjs',text:'// Outside edit\nexport default {};',mode:'overwrite'});
  await target.locator('[data-editor-save]').click();await target.getByText('next.config.mjs changed on disk while you were editing',{exact:true}).waitFor();assert.equal(await edit.inputValue(),'// My edit\nexport default { strict: true };');await fits();await shot('editor-conflict');
  await target.locator('[data-editor-compare]').click();await target.locator('.tc-files-compare .tc-dv-line code').first().waitFor();
  assert.match(await target.locator('.tc-files-compare').innerText(),/Outside edit/);await settle();
  const comparison=await target.locator('.tc-files-compare .tc-dv-line').first().evaluate(el=>{
   const line=el.getBoundingClientRect(),pane=el.closest('.tc-dv-pane').getBoundingClientRect();
   return {visible:line.height>0&&line.top>=pane.top&&line.bottom<=pane.bottom,line:line.toJSON(),pane:pane.toJSON()};
  });
  assert(comparison.visible,'comparison lines stay visible in the scroll pane: '+JSON.stringify(comparison));
  await shot('editor-compare');await target.locator('[data-editor-compare-close]').click();assert.equal(await edit.inputValue(),'// My edit\nexport default { strict: true };');
  await target.locator('[data-editor-copy]').click();await target.getByText('next.config (copy).mjs',{exact:true}).first().waitFor();await target.locator('[data-editor-close]').click();if(width<1024)await target.getByRole('button',{name:'Close details',exact:true}).click();
  // New folder and collision errors keep their field and typed draft.
  if(width<640){await target.getByRole('button',{name:'View options',exact:true}).click();await target.getByRole('menuitem',{name:'New folder',exact:true}).click();}else await target.locator('[data-cmd="files.new-folder"]').click();
  const rename=target.locator('#files-rename-name');await rename.fill('public');await page.keyboard.press('Enter');await target.locator('#files-rename-error').waitFor();assert.equal(await rename.inputValue(),'public');await fits();await shot('rename-error');
  await rename.fill('New assets');let release;hold={route:'/mkdir',promise:new Promise(resolve=>{release=resolve;})};await page.keyboard.press('Enter');await target.locator('#files-rename-name:disabled').waitFor();assert.equal(await target.locator('[data-cmd="files.rename-save"]').isDisabled(),true);release();hold=null;await rename.waitFor({state:'detached'});await target.locator('[data-files-row][data-path$="New assets"]').waitFor();
  // Context menu destinations and Trash undo.
  const row=target.locator('[data-files-row][data-path$="New assets"]');await row.click({button:'right'});await target.getByRole('menuitem',{name:'Move to…',exact:true}).click();await target.locator('.tc-files-move').waitFor();await fits();await shot('move');
  await target.locator('[data-move-row="/workspace"]').click();await target.locator('[data-move-submit]:not([disabled])').waitFor();await target.locator('[data-move-submit]').click();await target.locator('.tc-files-move').waitFor({state:'detached'});
  await visit('files');const moved=target.locator('[data-files-row][data-path="/workspace/New assets"]');await moved.waitFor();await moved.click({button:'right'});await target.getByRole('menuitem',{name:'Move to Trash',exact:true}).click();await moved.waitFor({state:'detached'});
  await visit('files/trash');await target.locator('[data-files-row]').first().waitFor();assert.equal(await target.locator('.tc-files-drop').count(),0,'Trash never shows a drop target without an active drag');await fits();await shot('trash');
  if(width<640){await target.getByRole('button',{name:'View options',exact:true}).click();await target.getByRole('menuitem',{name:'Select items',exact:true}).click();}
  await target.locator('[data-files-check]').first().check();
  const trashSelection=target.getByRole('region',{name:'Trash selection',exact:true});await trashSelection.waitFor();await settle();
  const selectionGeometry=await trashSelection.evaluate(el=>{
   const r=el.getBoundingClientRect();
   return {height:r.height,overflow:[...el.querySelectorAll('button,strong')].filter(item=>{
    const box=item.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(item);const text=range.getBoundingClientRect();
    return box.left<r.left-.5||box.right>r.right+.5||text.left<box.left-1||text.right>box.right+1;
   }).map(item=>item.textContent)};
  });
  assert.deepEqual(selectionGeometry.overflow,[],'Trash selection labels and actions fit their own controls');
  assert(selectionGeometry.height<=(width<640?128:64),'Trash selection stays compact: '+JSON.stringify(selectionGeometry));
  if(width>=640)assert.equal(await target.locator('[data-files-select-all]:checked').count(),2,'selection and column header agree');
  if(width<640){
   assert.deepEqual(await trashSelection.locator('button').evaluateAll(items=>items.filter(el=>{const r=el.getBoundingClientRect();return r.height<44||r.width<44;}).map(el=>el.ariaLabel||el.textContent)),[],'phone selection actions keep touch targets at least44px');
   assert.equal(await target.evaluate(()=>{const bar=document.querySelector('.tc-files-phone-selection').getBoundingClientRect(),notices=document.querySelector('.tc-toaster').getBoundingClientRect();return notices.bottom<=bar.top-8;}),true,'Undo notifications stay above the selection bar');
  }

  if(width<640){assert.equal(await target.locator('[data-cmd="files.restore"][data-path]').first().evaluate(el=>{const r=el.getBoundingClientRect();return r.width>=44&&r.height>=44;}),true,'per-item Restore keeps a touch target');assert.equal(await trashSelection.getByRole('button',{name:'Move',exact:true}).count(),0);assert.equal(await trashSelection.getByRole('button',{name:'Download',exact:true}).count(),0);}
  await shot('trash-selected');
  await trashSelection.getByRole('button',{name:'Remove selected…',exact:true}).click();await target.getByRole('alertdialog').waitFor();
  await target.getByRole('button',{name:'Cancel',exact:true}).click();await trashSelection.waitFor();
  await trashSelection.getByRole('button',{name:'Restore',exact:true}).click();await target.getByText('Trash is empty',{exact:true}).waitFor();assert.equal(await target.locator('.tc-files-drop').count(),0,'empty Trash has no drop target');
  if(width<640)await target.getByRole('button',{name:'Done',exact:true}).click();
  // Managed menus explain their lock and restore the same actions after consent.
  await fixture.respond('POST',new URL('http://fixture/files/write'),{path:'/home/t3/.t3/example.md',text:'# Managed example\nFixture text.',mode:'create',unlock:'/home/t3/.t3'});
  await visit('files/home/.t3');const managedRow=target.locator('[data-files-row][data-path="/home/t3/.t3/example.md"]');await managedRow.waitFor();await managedRow.click({button:'right'});
  for(const label of ['Edit','Compress','Rename','Move to…','Duplicate','Move to Trash','Delete permanently…']){
   const item=target.getByRole('menuitem',{name:label,exact:true});assert.equal(await item.isDisabled(),true,label+' is locked');assert.equal(await item.getAttribute('aria-disabled'),'true');
  }
  for(const label of ['Preview','Details','Download','Copy path','Edit anyway…'])assert.equal(await target.getByRole('menuitem',{name:label,exact:true}).isEnabled(),true,label+' remains available');
  await page.keyboard.press('Escape');await managedRow.focus();const writesBefore=mutations.length;
  await target.evaluate(()=>{window.__lockNotices=[];window.__originalToast=Kit.toast;Kit.toast=(...args)=>{const notice=window.__originalToast(...args);window.__lockNotices.push(notice);return notice;};});
  for(const shortcut of ['F2','Control+Shift+M','Control+d','Shift+Delete','Control+u'])await page.keyboard.press(shortcut);
  assert.equal(mutations.length,writesBefore,'locked shortcuts never submit a mutation');
  assert.equal(await target.locator('.tc-files-editor,#files-rename-name,.tc-files-move,.tc-files-delete').count(),0,'locked shortcuts do not open unusable editing flows');
  assert.equal(await target.evaluate(()=>window.__lockNotices.length),5,'each locked shortcut explains how to unlock');
  await target.evaluate(()=>{for(const notice of window.__lockNotices)notice.close();Kit.toast=window.__originalToast;delete window.__originalToast;delete window.__lockNotices;});
  await managedRow.click({button:'right'});

  assert.match(await target.locator('.tc-menu-foot').innerText(),/Choose Edit anyway first/);
  if(width<640){
   const menuGeometry=await target.locator('.tc-sheet--menu').evaluate(el=>{
    const panel=el.getBoundingClientRect(),cancel=el.querySelector('[data-menu-cancel]').getBoundingClientRect(),head=el.querySelector('.tc-menu-head').getBoundingClientRect(),foot=el.querySelector('.tc-menu-foot').getBoundingClientRect(),list=el.querySelector('.tc-sheet-actions');
    return {panelFits:panel.left>=0&&panel.right<=innerWidth&&panel.bottom<=innerHeight+1,cancelVisible:cancel.top>=panel.top&&cancel.bottom<=panel.bottom,contextVisible:foot.top>=panel.top&&foot.bottom<=cancel.top,headerVisible:head.top>=panel.top&&head.bottom<=foot.top,scrollable:list.scrollHeight>=list.clientHeight};
   });
   assert.deepEqual(menuGeometry,{panelFits:true,cancelVisible:true,contextVisible:true,headerVisible:true,scrollable:true},'long phone menus keep their heading, reason and Cancel visible');
  }
  await shot('managed-locked-menu');
  if(width<640){
   await target.getByRole('menuitem',{name:'Select',exact:true}).click();const bar=target.getByRole('region',{name:'Selection actions',exact:true});
   assert.equal(await bar.getByRole('button',{name:'Move',exact:true}).isDisabled(),true);assert.equal(await bar.getByRole('button',{name:'Trash',exact:true}).isDisabled(),true);assert.equal(await bar.getByRole('button',{name:'Download',exact:true}).isEnabled(),true);
   await shot('managed-locked-selection');await bar.getByRole('button',{name:'More selection actions',exact:true}).click();
   assert.equal(await target.getByRole('menuitem',{name:'Compress',exact:true}).isDisabled(),true);assert.equal(await target.getByRole('menuitem',{name:'Delete permanently…',exact:true}).isDisabled(),true);
  }
  await target.getByRole('menuitem',{name:'Edit anyway…',exact:true}).click();await target.getByRole('alertdialog').waitFor();await target.getByRole('button',{name:'Edit anyway',exact:true}).click();await target.getByRole('button',{name:'Lock again',exact:true}).waitFor();
  if(width<640)await target.getByRole('button',{name:'Done',exact:true}).click();
  await managedRow.click({button:'right'});assert.equal(await target.getByRole('menuitem',{name:'Edit',exact:true}).isEnabled(),true);assert.equal(await target.getByRole('menuitem',{name:'Move to Trash',exact:true}).isEnabled(),true);await target.getByRole('menuitem',{name:'Edit',exact:true}).click();await target.locator('[data-files-editor-text]').waitFor();assert.match(await target.locator('[data-files-editor-text]').inputValue(),/Managed example/);await target.locator('[data-editor-close]').click();
  await shot('managed-unlocked');await target.getByRole('button',{name:'Lock again',exact:true}).click();

  // Read-only locations use the same disabled appearance without offering unlock.
  await fixture.respond('POST',new URL('http://fixture/files/mkdir'),{parent:'/',name:'usr'});
  await fixture.respond('POST',new URL('http://fixture/files/write'),{path:'/usr/example.txt',text:'Read-only fixture.',mode:'create'});
  await visit('files/path/%2Fusr');const readonlyRow=target.locator('[data-files-row][data-path="/usr/example.txt"]');await readonlyRow.waitFor();await readonlyRow.click({button:'right'});
  for(const label of ['Edit','Compress','Rename','Move to…','Duplicate','Move to Trash','Delete permanently…'])assert.equal(await target.getByRole('menuitem',{name:label,exact:true}).isDisabled(),true,label+' is unavailable in a read-only folder');
  assert.equal(await target.getByRole('menuitem',{name:'Edit anyway…',exact:true}).count(),0);assert.equal(await target.locator('.tc-menu-foot').innerText(),'Read-only for t3');await page.keyboard.press('Escape');
  // Upload conflict, pause and resume, and atomic final publication.
  await visit('files/projects/acme-web/apps/web');const picker=page.waitForEvent('filechooser');await target.locator('[data-cmd="files.upload"]').first().click();await (await picker).setFiles({name:'README.md',mimeType:'text/plain',buffer:Buffer.from('Uploaded content')});
  if(width<640){await target.locator('.tc-files-transfer-pill').waitFor();await target.locator('.tc-files-transfer-pill').click();}await target.locator('[data-transfer-action="resolve"]').waitFor();await target.locator('[data-transfer-action="resolve"]').click();await target.locator('.tc-files-conflicts').waitFor();await fits();assert.deepEqual(await target.locator('.tc-files-conflicts .tc-conf small').evaluateAll(rows=>rows.filter(el=>el.clientHeight>2*parseFloat(getComputedStyle(el).lineHeight)+1).map(el=>el.textContent)),[],'short conflict summaries use the available width rather than a narrow label column');await shot('upload-conflict');await target.locator('[data-conflict-continue]').click();await target.getByText('Show in web',{exact:true}).waitFor();await target.locator('[data-files-row][data-path$="README (2).md"]').waitFor();await shot('transfer-done');
  if(width<640)await target.locator('[data-transfer-action="fold"]').click();
  let releaseChunk;hold={route:'/upload/chunk',promise:new Promise(resolve=>{releaseChunk=resolve;})};
  const secondPicker=page.waitForEvent('filechooser');await target.locator('[data-cmd="files.upload"]').first().click();await(await secondPicker).setFiles({name:'resumed.txt',mimeType:'text/plain',buffer:Buffer.alloc(128*1024,0x62)});
  if(width<640){await target.locator('.tc-files-transfer-pill').click();}await target.getByRole('button',{name:'Pause resumed.txt',exact:true}).click();await target.getByRole('button',{name:'Resume resumed.txt',exact:true}).waitFor();await shot('upload-paused');releaseChunk();hold=null;await page.waitForTimeout(100);lostFinish=true;
  await target.getByRole('button',{name:'Resume resumed.txt',exact:true}).click();await target.locator('.tc-tray-item').filter({hasText:'resumed.txt'}).getByRole('button',{name:'Show in web',exact:true}).waitFor();
  const check=await fixture.respond('GET',new URL('http://fixture/files/read?path='+encodeURIComponent('/workspace/acme-web/apps/web/resumed.txt')));assert.equal(check.body.text.length,128*1024);assert.equal(check.body.text[0],'b');
  // Long native job names must fit the tray without losing their full accessible
  // label or the destination. These also exercise the phone transfer sheet.
  if(width<640)await target.locator('[data-transfer-action="fold"]').click();
  const longFolder='project-'+('very-long-folder-name-'.repeat(10)),dest='/workspace/'+longFolder,longFile='report-'+('very-long-file-name-'.repeat(10))+'.txt',completedPath=dest+'/'+longFile;
  await fixture.respond('POST',new URL('http://fixture/files/mkdir'),{parent:'/workspace',name:longFolder});
  await fixture.respond('POST',new URL('http://fixture/files/write'),{path:completedPath,text:'Transferred content',mode:'create'});
  extraJobs=[{id:'j_long_destination',kind:'move',label:longFile,dest,path:completedPath,state:'done',result:{path:completedPath},finishedAt:new Date().toISOString()},
    {id:'j_long_failure',kind:'move',label:longFile,state:'failed',error:'Could not write '+completedPath+'. Choose another folder.',finishedAt:new Date().toISOString()}];
  await target.evaluate(()=>{location.hash='overview';});await target.locator('#page-overview:not([hidden])').waitFor();await visit('files');
  if(width<640)await target.locator('.tc-files-transfer-pill').click();
  const show=target.getByRole('button',{name:'Show in '+longFolder,exact:true});await show.waitFor();
  assert.equal(await show.getAttribute('title'),dest,'the full destination remains available');
  assert.deepEqual(await target.locator('.tc-files-transfer-list').evaluate(el=>[...el.querySelectorAll('*')].filter(item=>{const r=item.getBoundingClientRect(),style=getComputedStyle(item);return r.width>0&&r.height>0&&['visible','clip'].includes(style.overflowX)&&item.scrollWidth>item.clientWidth+1;}).map(item=>({tag:item.tagName,text:item.textContent.slice(0,50),width:item.clientWidth,content:item.scrollWidth}))),[],'transfer content must stay inside its column');
  await fits();if(width<640){await target.evaluate(()=>Kit.toast('Transfer notice',{duration:1000}));assert.equal(await target.locator('.tc-toaster').evaluate(el=>getComputedStyle(el).visibility),'hidden','notifications stay behind the modal transfer sheet');}await show.scrollIntoViewIfNeeded();await target.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await shot('transfer-long-destination');await show.click();await target.locator('[data-files-row]').filter({hasText:longFile}).waitFor();
  assert.deepEqual(errors,[]);}catch(error){await shot('failure');console.error(variant,theme,await target.evaluate(()=>({menus:window.__fileMenuCloses,hash:location.hash,route:document.body.dataset.consoleRoute,toaster:document.querySelector('.tc-toaster')&&getComputedStyle(document.querySelector('.tc-toaster')).visibility,layerClasses:[...document.querySelectorAll('.tc-layer')].map(el=>el.className),top:Kit.top()?.panel?.outerHTML?.slice(0,900),text:document.body.innerText.slice(-4000)})),errors);throw error;}await context.close();console.log(variant+' '+theme+': passed');
 }}finally{await browser.close();}console.log('Files Change audit passed ('+checks+' layout checks). Screens: '+out);
})().catch(error=>{console.error(error);process.exitCode=1;});
