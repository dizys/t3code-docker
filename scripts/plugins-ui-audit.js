#!/usr/bin/env node
// Real Setup rendering with fixture APIs; never mutates an installed provider.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require('playwright-core'));}
const {statusFor}=require('./lib/console-fixtures.cjs');
const base=process.argv[2]||'http://127.0.0.1:23785/__setup/';
const output=process.env.T3_PLUGINS_UI_OUTPUT||'/tmp/t3-plugins-ui-audit';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 try{
  for(const theme of ['light','dark'])for(const width of [1440,390]){
   const page=await browser.newPage({viewport:{width,height:900},colorScheme:theme,reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const rows=[{id:'a'.repeat(32),nativeId:'tokeneconomizer@fixture',provider:'codex',name:'tokeneconomizer',description:'Experience-driven black-box cost control for coding agents: micro-skills (short repository facts learned from earlier sessions) injected at session start, tool pruning that turns off capabilities a repository never uses, and a guard that retires a turn stuck in a failing loop.',version:'0.1.0',source:'https://github.com/microsoft/TokenEconomizer',enabled:true,owned:true,status:'installed',revision:'fixture',capabilities:{state:true},components:[{type:'hooks',name:'SessionStart'}]}];
   const providers=[{id:'codex',name:'Codex',coverage:'filesystem',warnings:[]},{id:'claude',name:'Claude Code',coverage:'filesystem',warnings:[]},{id:'pi',name:'Pi',coverage:'filesystem',warnings:[]}];
   const compatible=[...providers.map(p=>({id:p.id,compatible:true,format:p.id,reason:'Native '+p.name+' package'})),{id:'opencode',detected:true,compatible:true,experimental:true,format:'local-module',reason:'Experimental local module. May reload in running sessions.'},...['cursor','grok','antigravity'].map(id=>({id,detected:true,compatible:false,experimental:true,reason:'Integration found; native setup required.'}))];
   const plan={ok:true,planId:'review',operation:'install',provider:'codex',name:'tokeneconomizer',description:rows[0].description,source:rows[0].source,version:'0.1.0',commit:'b'.repeat(40),components:rows[0].components,hooks:[{event:'SessionStart',command:'<script>window.pluginInjected=true</script> --safe-text'}],files:[{name:'.codex-plugin/plugin.json',bytes:300,text:'{"name":"tokeneconomizer"}'},{name:'scripts/run.py',bytes:400,executable:true}],effects:['Install this complete package for new sessions.','Native permissions remain separate.'],blocked:[],canApply:true};
   const posts=[];let applyAttempts=0;
   await page.addInitScript(t=>localStorage.setItem('t3-console-theme',t),theme);
   await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),suffix=url.pathname.replace(/^.*\/context\/plugins/,'');
    if(url.pathname.endsWith('/status'))return route.fulfill({json:statusFor('skills')});
    if(url.pathname.includes('/context/plugins')){
     let result;
     if(req.method()==='POST')posts.push({suffix,input:req.postDataJSON()});
     if(suffix==='')result={ok:true,plugins:rows,providers,warnings:[],installNote:'Reviewed native packages. Other integrations are read-only.'};
     else if(suffix==='/source')result={ok:true,previewId:'source',source:plan.source,commit:plan.commit,packages:[{...plan,prefix:'plugin/',providers:compatible},{...plan,name:'companion-tools',prefix:'companion/',providers:compatible}]};
     else if(suffix==='/plan')result={...plan,provider:req.postDataJSON().provider||'codex',operation:req.postDataJSON().operation||'install',...(req.postDataJSON().operation==='update'?{changes:[{name:'removed.txt',status:'removed',beforeText:'Old file being deleted.'}]}:{})};
     else if(suffix==='/apply'){if(++applyAttempts===1)return route.fulfill({status:503,json:{ok:false,error:'Response interrupted. Retry this reviewed operation.'}});result={ok:true,jobId:'job'};}
     else if(suffix==='/job')result={ok:true,state:'succeeded',message:'Saved. Start a new session.'};
     else result={ok:true};
     return route.fulfill({json:result});
    }
    return route.continue();
   });
   await page.goto(base+'#instructions/plugins');
   if(await page.locator('input[type=password]').count()){await page.locator('input[type=password]').fill('dev');await page.locator('button[type=submit]').click();}
   const library=page.locator('#plugin-library');
   const visibleName=()=>library.getByRole('button',{name:'tokeneconomizer',exact:true}).filter({visible:true});
   await visibleName().waitFor();
   assert.equal(await page.getByRole('tab',{name:'Plugins',exact:true}).getAttribute('aria-selected'),'true');
   await page.locator('#plugin-search').fill('nothing-matches');await page.getByText('No plugins match these filters',{exact:true}).waitFor();
   await page.locator('#plugin-search').fill('');
   if(width>800){
    await library.getByRole('button',{name:'Cards',exact:true}).click();await library.getByRole('listitem').first().waitFor();
    await library.getByRole('button',{name:'Table',exact:true}).click();await library.getByRole('table',{name:'Plugins and agent settings'}).waitFor();
    await library.getByRole('button',{name:'View',exact:true}).click();await page.getByRole('menuitemradio',{name:'All agents',exact:false}).click();
    await library.getByRole('columnheader').filter({hasText:'Muse Code'}).waitFor();
   }
   await page.screenshot({path:path.join(output,theme+'-'+width+'-library.png')});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'library fits viewport');
   await visibleName().click();
   let dialog=page.getByRole('dialog');
   await dialog.getByRole('button',{name:'Disable',exact:true}).click();
   await dialog.getByRole('button',{name:'Save plugin setting',exact:true}).waitFor();
   assert.equal(posts.at(-1).input.enabled,false);
   await dialog.getByRole('button',{name:'Back',exact:true}).click();
   await dialog.getByRole('button',{name:'Review update',exact:true}).click();
   await dialog.getByRole('button',{name:'Update for Codex',exact:true}).waitFor();
   await dialog.locator('details > summary').first().click();
   await dialog.locator('summary').filter({hasText:'removed.txt'}).click();
   await dialog.locator('pre').filter({hasText:'Old file being deleted.'}).waitFor();
   await page.getByRole('button',{name:'Close plugin inspector',exact:true}).click();
   await library.getByRole('button',{name:'Install from source',exact:true}).filter({visible:true}).click();
   dialog=page.getByRole('dialog');await dialog.getByLabel('Repository or container folder').fill(plan.source);
   await dialog.getByRole('button',{name:'Read',exact:true}).click();
   await dialog.getByLabel('tokeneconomizer',{exact:true}).check();
   await dialog.getByLabel('companion-tools',{exact:true}).check();
   await dialog.locator('.tc-plugin-pick').first().getByText('OpenCode · Experimental',{exact:true}).waitFor();
   await dialog.locator('.tc-plugin-pick').first().getByText('Cursor · Experimental',{exact:true}).waitFor();
   await dialog.locator('.tc-plugin-pick').first().getByText('Grok Build · Experimental',{exact:true}).waitFor();
   await dialog.locator('.tc-plugin-pick').first().getByText('Antigravity · Experimental',{exact:true}).waitFor();
   assert(await dialog.locator('.tc-plugin-pick').first().evaluate(el=>el.scrollWidth<=el.clientWidth+1),'long package description fits');
   assert(await dialog.getByRole('button',{name:'Choose agents',exact:true}).evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom<=innerHeight&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el;}),'long package lists keep the next-step button visible and clickable');
   await page.screenshot({path:path.join(output,theme+'-'+width+'-packages.png')});
   await dialog.getByRole('button',{name:'Choose agents',exact:true}).click();
   await dialog.locator('[data-plugin-agent="codex"]').uncheck();
   await dialog.locator('[data-plugin-agent="opencode"]').check();
   await dialog.getByRole('button',{name:'Review installation',exact:true}).click();
   assert.equal(posts.filter(p=>p.suffix==='/plan').at(-1).input.provider,'opencode');
   await dialog.getByText('OpenCode may immediately load or reload this module',{exact:false}).waitFor();
   assert(await dialog.getByRole('button',{name:'Install for OpenCode',exact:true}).isDisabled());
   await dialog.locator('[data-plugin-agent="opencode"]').uncheck();
   await dialog.locator('[data-plugin-agent="claude"]').check();
   await dialog.locator('[data-plugin-agent="pi"]').check();
   assert(await dialog.locator('[data-plugin-agent="cursor"]').isDisabled(),'detected integrations without a Setup adapter require native setup');
   await dialog.getByRole('button',{name:'Review installation',exact:true}).click();
   await dialog.getByText('Destination 1 of 4:',{exact:false}).waitFor();
   await dialog.getByText('Automatic commands',{exact:true}).waitFor();
   assert.equal(posts.filter(p=>p.suffix==='/plan').at(-1).input.provider,'claude');
   assert.equal(await page.evaluate(()=>window.pluginInjected),undefined);
   assert.equal(posts.filter(p=>p.suffix==='/apply').length,0,'source preview never installs');
   await dialog.locator('details > summary').first().click();
   await dialog.locator('summary').filter({hasText:'.codex-plugin/plugin.json'}).click();
   await dialog.locator('pre').filter({hasText:'{"name":"tokeneconomizer"}'}).waitFor();
   assert(await dialog.getByRole('button',{name:'Install for Claude Code',exact:true}).isDisabled(),'code access requires consent');
   await dialog.locator('[data-plugin-consent]').check();
   await page.screenshot({path:path.join(output,theme+'-'+width+'-review.png')});
   assert(await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1;}),'installer fits viewport');
   await dialog.getByRole('button',{name:'Install for Claude Code',exact:true}).click();
   await dialog.getByRole('button',{name:'Retry installation',exact:true}).waitFor();
   assert(await dialog.locator('[data-plugin-agent="claude"]').isDisabled(),'uncertain apply keeps the same destination');
   await dialog.getByRole('button',{name:'Retry installation',exact:true}).click();
   await dialog.getByText('Installed for Claude Code',{exact:true}).waitFor();
   assert.equal(posts.filter(p=>p.suffix==='/apply').length,2);
   assert.deepEqual(posts.filter(p=>p.suffix==='/apply').map(p=>p.input.planId),['review','review'],'retry uses the same plan');
   await dialog.getByRole('button',{name:'Review next installation',exact:true}).click();
   await dialog.getByRole('button',{name:'Review installation',exact:true}).click();
   assert.equal(posts.filter(p=>p.suffix==='/plan').at(-1).input.provider,'pi');
   assert(await dialog.getByRole('button',{name:'Install for Pi',exact:true}).isDisabled(),'agent change resets consent');
   await dialog.getByRole('button',{name:'Close plugin installation',exact:true}).click();
   rows.push({...rows[0],id:'c'.repeat(32),provider:'claude',nativeId:'tokeneconomizer@claude-fixture',enabled:false,path:'/home/fixture/.claude/plugins/cache/tokeneconomizer'});
   await library.getByRole('button',{name:'Rescan',exact:true}).click();
   await library.getByRole('button',{name:width>800?'View':'View options',exact:true}).click();
   await page.getByRole('menuitemcheckbox',{name:'Unified view · one row per plugin name',exact:false}).click();
   await visibleName().click();
   dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'Choose an installation',exact:true}).waitFor();
   await dialog.locator('[data-plugin-location]').filter({hasText:'Claude Code'}).click();
   await page.getByRole('dialog').locator('dd').getByText('Claude Code',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Close plugin inspector',exact:true}).click();
   rows.push(
    {...rows[0],id:'d'.repeat(32),owned:false,nativeId:'tokeneconomizer@openai-curated-remote'},
    {...rows[0],id:'e'.repeat(32),name:'curated-default',owned:false,nativeId:'curated-default@openai-curated-remote'},
    {...rows[0],id:'f'.repeat(32),name:'system-default',owned:false,provider:'claude',scope:'system'},
    {...rows[0],id:'1'.repeat(32),name:'native-custom',owned:false,nativeId:'native-custom@personal'},
    {...rows[0],id:'2'.repeat(32),name:'owned-curated',nativeId:'owned-curated@openai-curated-remote'}
   );
   await library.getByRole('button',{name:'Rescan',exact:true}).click();
   await library.getByRole('button',{name:width>800?'View':'View options',exact:true}).click();
   await page.getByRole('menuitemcheckbox',{name:'Show bundled and curated plugins',exact:false}).click();
   assert.equal(await library.getByRole('button',{name:'curated-default',exact:true}).count(),0);
   assert.equal(await library.getByRole('button',{name:'system-default',exact:true}).count(),0);
   await library.getByRole('button',{name:'native-custom',exact:true}).filter({visible:true}).waitFor();
   await library.getByRole('button',{name:'owned-curated',exact:true}).filter({visible:true}).waitFor();
   await visibleName().click();
   assert.equal(await page.getByRole('dialog').locator('[data-plugin-location]').count(),2,'unified view keeps visible physical locations only');
   await page.getByRole('button',{name:'Close installation choices',exact:true}).click();
   await page.reload();await visibleName().waitFor();
   assert.equal(await library.getByRole('button',{name:'curated-default',exact:true}).count(),0,'hidden preference survives reload');
   await library.locator('.tc-mx-hidden').getByRole('button',{name:'Show',exact:true}).click();
   await library.getByRole('button',{name:'curated-default',exact:true}).filter({visible:true}).waitFor();
   const defaultOnly=rows.find(row=>row.name==='curated-default');rows.splice(0,rows.length,defaultOnly);
   await library.getByRole('button',{name:'Rescan',exact:true}).click();
   await library.getByRole('button',{name:width>800?'View':'View options',exact:true}).click();
   await page.getByRole('menuitemcheckbox',{name:'Show bundled and curated plugins',exact:false}).click();
   await library.getByText('No plugins to show',{exact:true}).waitFor();
   await library.getByRole('button',{name:'Clear filters',exact:true}).click();
   await library.getByRole('button',{name:'curated-default',exact:true}).filter({visible:true}).waitFor();
   assert.equal(posts.filter(p=>p.suffix==='/apply').length,2,'hiding and showing never change plugin settings');
   assert.deepEqual(errors,[]);console.log('Passed Plugins',theme,width);await page.close();
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
