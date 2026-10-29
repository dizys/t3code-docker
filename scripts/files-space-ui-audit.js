#!/usr/bin/env node
// Real Files controls; isolated mutable data and delayed/failing HTTP replies.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require('playwright-core'));}
const {statusFor,portsFor,routeConsole,framed,unlock}=require('./lib/console-fixtures.cjs');
const {createFilesFixtures}=require('./lib/files-fixtures.cjs');
const {createDownloadFixture,ZIP_BYTES}=require('./lib/console-download-fixture.cjs');
const sourceBase=process.argv[2]||'http://127.0.0.1:23836/__setup/',key=process.argv[3]||'dev',out=process.env.T3_FILES_UI_OUTPUT||'/tmp/t3-files-space-ui';fs.mkdirSync(out,{recursive:true});
const variants=[['desktop',1440,900],['compact',1280,800],['tablet',834,1112],['phone',390,844],['narrow',320,740],['embedded',1198,878],['embedded-phone',390,844]],subset=process.env.T3_FILES_UI_VARIANTS?.split(',');
(async()=>{const transport=await createDownloadFixture({base:sourceBase,key}),base=transport.base;let browser,checks=0;
 try{browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 try{for(const theme of(process.env.T3_FILES_UI_THEMES?.split(',')||['light','dark']))for(const[variant,width,height]of variants){if(subset&&!subset.includes(variant))continue;
  const context=await browser.newContext({viewport:{width,height},colorScheme:theme,reducedMotion:'reduce',acceptDownloads:true}),page=await context.newPage(),fixture=createFilesFixtures(),errors=[],writes=new Map();let hold=null,lowSpace=false,nearFull=false,activeFixture=fixture,preparedDownloadToken=null;
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.stack));await routeConsole(page,{status:()=>statusFor('skills'),ports:()=>portsFor('ready'),downloadHTTP:true});
  await page.route(url=>!url.pathname.endsWith('/files/zip'),async route=>{const req=route.request(),url=new URL(req.url());if(!url.pathname.includes('/files/'))return route.fallback();const input=req.method()==='POST'?(url.pathname.endsWith('/chunk')?req.postDataBuffer():req.postDataJSON()):{};
   const gate=hold&&url.pathname.endsWith(hold.route)?hold:null;
   if(gate?.latency)await new Promise(resolve=>setTimeout(resolve,gate.latency));
   const operation=url.pathname.slice(url.pathname.lastIndexOf('/files/'));
   if(req.method()==='POST')writes.set(operation,(writes.get(operation)||0)+1);if(gate){gate.entered?.();await gate.promise;}
   const result=await activeFixture.respond(req.method(),url,input);if(url.pathname.endsWith('/zip/start')&&result.body?.ok)preparedDownloadToken=result.body.token;if(nearFull&&url.pathname.endsWith('/places'))Object.assign(result.body.disk,{usedPercent:94,availableBytes:60e9});if(lowSpace&&url.pathname.endsWith('/extract/preview'))Object.assign(result.body,{canExtract:false,canExtractHere:false,topLevelCount:501,freeBytes:512e6});if(result.raw)return route.fulfill({body:result.raw,headers:result.headers});
   if(result.body.etag&&result.body.etag===req.headers()['if-none-match'])return route.fulfill({status:304,headers:{etag:result.body.etag}});return route.fulfill({status:result.status||200,json:result.body});});
  const target=variant.startsWith('embedded')?await framed(page,base+'?embed=t3&theme='+theme):page;if(target===page)await page.goto(base);await unlock(target,key);await target.evaluate(()=>document.fonts.ready);
  const settle=()=>target.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const shot=async name=>{await settle();await page.screenshot({path:path.join(out,variant+'-'+theme+'-'+name+'.png')});};
  const fits=async()=>{const problems=await target.evaluate(()=>{const bad=[];for(const el of document.querySelectorAll('.tc-layer:not([hidden]) .tc-fdlg,.tc-layer:not([hidden]) .tc-files-conflicts')){const r=el.getBoundingClientRect();if(r.left<-.5||r.top<-.5||r.right>innerWidth+.5||r.bottom>innerHeight+.5)bad.push(el.className);}for(const el of document.querySelectorAll('.tc-files-clean-projects,.tc-files-delete .tc-risks,.tc-files-zip .tc-opts'))if(el.scrollHeight>el.clientHeight+2)bad.push('vertically clipped '+el.className);if(document.documentElement.scrollWidth>innerWidth+1)bad.push('page overflow');for(const el of document.querySelectorAll('.tc-files-clean-project-head,.tc-files-clean-item,.tc-files-delete .tc-risk,.tc-files-zip .tc-opt'))if(el.scrollWidth>el.clientWidth+2)bad.push('content overflow '+el.className);return bad;});assert.deepEqual(problems,[],variant+' '+theme+' geometry');checks++;};
  const visit=async hash=>{await target.evaluate(value=>{location.hash=value;},hash);await target.locator('#files-search').waitFor();await target.locator('#files-browser .tc-skel-row').first().waitFor({state:'detached'});};
  const item=value=>target.locator('[data-files-row][data-path='+JSON.stringify(value)+']');
  const menu=async(value,label)=>{await item(value).click({button:'right'});await target.getByRole('menuitem',{name:label,exact:true}).click();};
  const mutate=async()=>fixture.respond('POST',new URL('http://fixture/files/mkdir'),{parent:'/workspace',name:'External '+Date.now()});
  try{
   await visit('files');await target.locator('[data-cmd="files.clean"]').first().click();await target.locator('[data-clean-item]').first().waitFor();assert(await target.locator('[data-clean-project]').first().evaluate(el=>el.indeterminate));assert.equal(await target.locator('[data-clean-item]:disabled').count(),1);await fits();await shot('clean');
   const first=target.locator('[data-clean-item]:not([disabled])').first(),id=await first.getAttribute('data-clean-item');await first.uncheck();await mutate();await target.locator('[data-clean-start]').click();await target.locator('[data-clean-review]').waitFor();await fits();await shot('clean-stale');await target.locator('[data-clean-review]').click();await target.locator('[data-clean-start]:not([disabled])').waitFor();assert.equal(await target.locator('[data-clean-item='+JSON.stringify(id)+']').isChecked(),false);
   // Observe the request at the fixture boundary, including delayed transport;
   // neither the Setup mount prefix nor a fixed sleep determines submission.
   let release,entered;
   const cleanReached=new Promise(resolve=>{entered=resolve;});
   hold={route:'/clean',latency:200,entered,promise:new Promise(resolve=>{release=resolve;})};
   const cleanBefore=writes.get('/files/clean')||0;
   await target.locator('[data-clean-start]').click();
   assert.equal(await target.locator('[data-clean-start]').isDisabled(),true);
   await target.locator('[data-clean-start]').dispatchEvent('click');
   let requestTimer;
   try{
    await Promise.race([cleanReached,new Promise((_,reject)=>{
     requestTimer=setTimeout(()=>reject(new Error('Cleanup did not reach the request gate')),10000);
    })]);
   }finally{clearTimeout(requestTimer);}
   assert.equal(writes.get('/files/clean')||0,cleanBefore+1);
   await shot('clean-pending');release();hold=null;
   await target.locator('.tc-files-review-progress').waitFor();
   await fits();await shot('clean-progress');
   if(await target.locator('[data-clean-close]').isVisible())await target.locator('[data-clean-close]').click({timeout:1000}).catch(async error=>{if(await target.locator('[data-clean-close]').count())throw error;});
   if(width<640)await target.locator('.tc-files-transfer-pill').click();
   await target.getByText('Space freed',{exact:true}).first().waitFor();
   assert.equal(writes.get('/files/clean')||0,cleanBefore+1,'cleanup submits exactly once through completion');
   if(width<640)await target.locator('[data-transfer-action="fold"]').click();checks++;
   await visit('files');await menu('/workspace/acme-web','Download as ZIP…');await target.locator('[data-zip-start]:not([disabled])').waitFor();assert.equal(await target.locator('[data-zip-option="leaveOutRebuildable"]').isChecked(),true);assert.match(await target.locator('.tc-files-zip').innerText(),/Keep this download private/);await fits();await shot('zip');
   await target.locator('[data-zip-option="includeHidden"]').uncheck();await target.locator('[data-zip-start]:not([disabled])').waitFor();assert.doesNotMatch(await target.locator('.tc-files-zip').innerText(),/Keep this download private/);await mutate();await target.locator('[data-zip-start]').click();await target.locator('[data-zip-review]').waitFor();await shot('zip-stale');await target.locator('[data-zip-review]').click();await target.locator('[data-zip-start]:not([disabled])').waitFor();const beforeDownload=transport.stats(),downloaded=page.waitForEvent('download');
   await target.locator('[data-zip-start]').click();const download=await downloaded;
   assert.equal(await download.failure(),null,'native ZIP download: '+JSON.stringify(transport.stats()));
   assert(!!preparedDownloadToken&&new URL(download.url()).searchParams.get('token')===preparedDownloadToken,'the native GET must use its prepared one-use token');
   const stream=await download.createReadStream();assert(stream);const chunks=[];let received=0;
   for await(const chunk of stream){received+=chunk.length;assert(received<=ZIP_BYTES.length);chunks.push(chunk);}
   assert.deepEqual(Buffer.concat(chunks),ZIP_BYTES,'the browser must save the complete ZIP bytes');
   const afterDownload=transport.stats();assert.equal(afterDownload.started,beforeDownload.started+1);assert.equal(afterDownload.completed,beforeDownload.completed+1);assert.equal(afterDownload.aborted,beforeDownload.aborted);
   await target.locator('.tc-files-zip').waitFor({state:'detached'});checks++;
   await visit('files/projects/acme-web/apps/web/public');await menu('/workspace/acme-web/apps/web/public/brand-kit.zip','Extract…');await target.locator('[data-extract-start]:not([disabled])').waitFor();assert.match(await target.locator('.tc-files-extract').innerText(),/312 MB/);await target.getByText('Show skipped entries',{exact:true}).click();await fits();await shot('extract');
   await target.locator('[data-extract-into][value="here"]').check();await target.locator('[data-extract-start]').click();await target.locator('.tc-files-conflicts').waitFor();await fits();await shot('extract-conflicts');await target.locator('[data-conflict-continue]').click();await target.locator('.tc-files-extract').waitFor({state:'detached'});await item('/workspace/acme-web/apps/web/public/logos (2)').waitFor();checks++;
   lowSpace=true;await menu('/workspace/acme-web/apps/web/public/brand-kit.zip','Extract…');await target.getByText('Check again',{exact:true}).waitFor();assert.equal(await target.locator('[data-extract-start]').isDisabled(),true);assert.equal(await target.locator('[data-extract-into][value="here"]').isDisabled(),true);assert.match(await target.locator('.tc-files-extract').innerText(),/312 MB/);await fits();await shot('extract-no-space');lowSpace=false;await target.getByText('Check again',{exact:true}).click();await target.locator('[data-extract-start]:not([disabled])').waitFor();await target.locator('[data-extract-cancel]').click();
   // Finished ZIPs offer an opt-in shortcut, never an automatic extraction.
   const [picker]=await Promise.all([page.waitForEvent('filechooser'),target.locator('[data-cmd="files.upload"]:visible').first().click()]);await picker.setFiles({name:'uploaded.zip',mimeType:'application/zip',buffer:Buffer.from('fixture ZIP')});if(width<640){await target.locator('.tc-files-transfer-pill').click();}const extractCheck=target.locator('[data-transfer-extract]').first();await extractCheck.waitFor();assert.equal(await extractCheck.isChecked(),false);await shot('upload-extract-opt-in');await extractCheck.click();await target.locator('.tc-files-extract').waitFor();await target.locator('[data-extract-start]:not([disabled])').waitFor();await target.locator('[data-extract-cancel]').click();if(width<640&&await target.locator('.tc-files-transfer-sheet').count())await target.locator('[data-transfer-action="fold"]').click();checks++;
   await visit('files');await menu('/workspace/acme-web','Delete permanently…');await target.locator('#files-delete-name').waitFor();assert.equal(await target.locator('[data-delete-start]').isDisabled(),true);assert.equal(await target.locator('[data-delete-trash]').getAttribute('data-key'),'files-delete-trash');await target.locator('#files-delete-name').fill('wrong');await page.keyboard.press('Enter');assert.equal(await target.locator('[data-delete-start]').isDisabled(),true);await target.locator('#files-delete-name').fill('acme-web');await fits();await shot('delete-project');await target.locator('[data-delete-close]').click();
   await menu('/workspace/old-prototype','Delete permanently…');await target.locator('#files-delete-name').waitFor();await target.locator('#files-delete-name').fill('old-prototype');await mutate();await target.locator('[data-delete-start]').click();await target.locator('[data-delete-review]').waitFor();await shot('delete-stale');await target.locator('[data-delete-review]').click();await target.locator('#files-delete-name').waitFor();assert.equal(await target.locator('#files-delete-name').inputValue(),'');await target.locator('#files-delete-name').fill('old-prototype');
   let finishDelete;hold={route:'/delete',promise:new Promise(resolve=>{finishDelete=resolve;})};await target.locator('[data-delete-start]').click();assert.equal(await target.locator('[data-delete-start]').isDisabled(),true);await fits();await shot('delete-pending');finishDelete();hold=null;await target.locator('.tc-files-delete').waitFor({state:'detached'});await item('/workspace/old-prototype').waitFor({state:'detached'});assert.equal(await target.locator('[data-files-row][tabindex="0"]').count(),1,'Deleting a focused row retains one keyboard entry point');checks++;
   // Long unbroken names must wrap in reviews, never crop the title or facts.
   const longName='long-project-'+ 'a'.repeat(190);await fixture.respond('POST',new URL('http://fixture/files/mkdir'),{parent:'/workspace',name:longName});await visit('files/home');await visit('files');await menu('/workspace/'+longName,'Delete permanently…');await target.locator('#files-delete-name').waitFor();await fits();assert.equal(await target.locator('.tc-files-delete .tc-fdlg-head').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await shot('delete-long-name');await target.locator('[data-delete-close]').click();
   await target.evaluate(()=>{location.hash='storage';});
   await target.locator('[data-cmd="storage.details"]').waitFor();
   await target.locator('[data-cmd="storage.details"]').click();
   const openFiles=target.locator('.tc-storage-data-row a[href^="#files"]').first();
   await openFiles.waitFor();await shot('storage-links');
   await fixture.respond('POST',new URL('http://fixture/files/to-trash'),{paths:['/workspace/acme-web/apps/web/README.md']});
   nearFull=true;await openFiles.click();await target.locator('#files-search').waitFor();
   await target.evaluate(()=>location.reload());await target.locator('.tc-files-disk-warning').waitFor();
   await target.evaluate(()=>document.fonts.ready);
   // History recovered after reload starts compact, so it cannot obscure the
   // low-space recovery actions. Explicitly expanding it must stay usable too.
   if(width>=640){
    const show=target.getByRole('button',{name:'Show transfers',exact:true});await show.waitFor();
    assert.equal(await target.locator('#files-transfers .tc-files-transfer-list').count(),0,'restored history starts collapsed');
    assert.equal(await show.getAttribute('aria-expanded'),'false');
    await fits();await shot('disk-full');
    await show.click();await target.locator('.tc-files-transfer-list').waitFor();
    await page.setViewportSize({width,height:480});await settle();
    const trayBounds=()=>target.locator('#files-transfers .tc-tray').evaluate(el=>{
     const r=el.getBoundingClientRect(),list=el.querySelector('.tc-files-transfer-list'),nav=document.querySelector('.tc-tabbar')?.getBoundingClientRect();
     const headerBottom=Math.max(0,...[...document.querySelectorAll('.tc-console-topbar,.tc-phonebar')].map(el=>el.getBoundingClientRect()).filter(r=>r.height>0).map(r=>r.bottom));
     return {belowHeader:r.top>=headerBottom+1,aboveNavigation:r.bottom<=(nav?.height?nav.top:innerHeight)-1,
      chromeInside:[...el.querySelectorAll('.tc-tray-head,.tc-tray-foot,[data-transfer-action="fold"]')].every(el=>{const box=el.getBoundingClientRect();return box.top>=r.top&&box.bottom<=r.bottom&&box.left>=r.left&&box.right<=r.right;}),
      historyScrolls:list.clientHeight>0&&list.scrollHeight>list.clientHeight};
    });
    const expectedTray={belowHeader:true,aboveNavigation:true,chromeInside:true,historyScrolls:true};
    assert.deepEqual(await trayBounds(),expectedTray,'expanded history keeps controls visible in short windows');
    await shot('restored-transfers-short');
    const fontSize=await target.evaluate(()=>document.documentElement.style.fontSize);
    try{
     await target.evaluate(()=>{document.documentElement.style.fontSize='20px';});await settle();
     await shot('restored-transfers-short-large-text');
     assert.deepEqual(await trayBounds(),expectedTray,'expanded history fits at the maximum native interface size');
    }finally{await target.evaluate(value=>{document.documentElement.style.fontSize=value;},fontSize);await settle();}
    const collapse=target.getByRole('button',{name:'Collapse transfers',exact:true});assert.equal(await collapse.getAttribute('aria-expanded'),'true');
    await collapse.click();await target.locator('.tc-files-transfer-list').waitFor({state:'detached'});
    await page.setViewportSize({width,height});await settle();
   }else{
    await target.locator('.tc-files-transfer-pill').waitFor();await fits();await shot('disk-full');
    await target.locator('.tc-files-transfer-pill').click();
    const transfers=target.getByRole('dialog',{name:'Transfers',exact:true});await transfers.waitFor();
    assert(await transfers.locator('.tc-tray-item').count()>0,'restored history is available on a phone');
    const collapse=transfers.getByRole('button',{name:'Collapse transfers',exact:true});assert.equal(await collapse.getAttribute('aria-expanded'),'true');
    await collapse.click();await transfers.waitFor({state:'detached'});
   }
   const emptyTrash=target.locator('.tc-files-disk-warning [data-cmd="files.empty-trash"]');
   assert.equal(await emptyTrash.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}),true,'the disk-warning recovery action is unobstructed');
   await emptyTrash.click();await target.getByRole('button',{name:'Empty Trash',exact:true}).waitFor();
   assert.match(await target.getByRole('alertdialog').innerText(),/1 item/);
   await target.getByRole('button',{name:'Empty Trash',exact:true}).click();await target.getByText('Emptied Trash',{exact:true}).waitFor();
   assert.equal((await fixture.respond('GET',new URL('http://fixture/files/trash'))).body.items.length,0);checks++;
   if(variant==='desktop'){
    activeFixture=createFilesFixtures({workspace:'/srv/projects',homeDirectory:'/srv/home',workspaceRepo:true});nearFull=false;await target.evaluate(()=>{location.hash='files';location.reload();});const workspaceRow=item('/srv/projects');await workspaceRow.waitFor();await workspaceRow.click({button:'right'});assert.equal(await target.getByRole('menuitem',{name:'Move to Trash',exact:true}).isDisabled(),true);assert.equal(await target.getByRole('menuitem',{name:'Delete permanently…',exact:true}).isDisabled(),true);await page.keyboard.press('Escape');await workspaceRow.dblclick();await item('/srv/projects/acme-web').waitFor();assert.match(await target.evaluate(()=>location.hash),/^#files\/path\/\/srv\/projects/);await fits();
    await visit('files/home');await item('/srv/home/hello.txt').waitFor();await visit('files');await item('/srv/projects').waitFor();await target.locator('[data-cmd="files.new-folder"]').click();await target.locator('#files-rename-name').waitFor();await target.locator('#files-rename-name').fill('Workspace folder');await page.keyboard.press('Enter');await item('/srv/projects/Workspace folder').waitFor();await fits();checks++;
   }
   assert.deepEqual(errors,[]);
  }catch(error){await shot('failure');console.error(variant,theme,{downloads:transport.stats()},await target.evaluate(()=>({hash:location.hash,text:document.body.innerText.slice(-3500)})),errors);throw error;}finally{if(hold)hold=null;await context.close();}console.log(variant+' '+theme+': passed');
 }}finally{await browser?.close();}}finally{await transport.close();}console.log('Files Space and archives audit passed ('+checks+' checks). Screens: '+out);
})().catch(error=>{console.error(error);process.exitCode=1;});
