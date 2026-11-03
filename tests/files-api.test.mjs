import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { FILES_POST_ROUTES, FILES_ROUTES } from '../docker/setup/files.mjs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function filesHTTP(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-files-api-')),home=path.join(root,'home'),workspace=path.join(root,'workspace'),outside=path.join(root,'outside');
 await Promise.all([home,workspace,outside].map(file=>fs.mkdir(file,{recursive:true})));
 await fs.writeFile(path.join(outside,'hello.html'),'<script>window.mustNotRun=true</script>');
 await fs.symlink(outside,path.join(workspace,'link'));
 const module=path.join(root,'harness.mjs');
 await fs.writeFile(module,`export * from ${JSON.stringify(new URL('../docker/harness/index.mjs',import.meta.url).href)};
 export const processSnapshot=async()=>({complete:true,processes:[]});
 export const createStorageManager=()=>({ready:Promise.resolve(),snapshot:()=>({categories:[]}),sizes:()=>({at:'2026-10-25T00:00:00Z',partial:false,bytesOf:()=>4096,childrenOf:()=>[],entries:()=>new Map().entries()}),refresh:async()=>({}),status:async()=>({categories:[],disk:{totalBytes:1000,availableBytes:500}}),stop(){}});`);
 const reservation=createServer().listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../docker/setup/server.mjs',import.meta.url))],{env:{...process.env,HOME:home,T3CODE_HOME:path.join(home,'.t3'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),T3_WORKSPACE:workspace,MISE_DATA_DIR:path.join(home,'.local/share/mise'),MISE_STATE_DIR:path.join(home,'.local/state/mise'),MISE_CONFIG_DIR:path.join(home,'.config/mise'),T3_HARNESS_MODULE:module,T3_SETUP_PORT:String(port),T3_SETUP_KEY:'files-fixture-key',T3_SETUP_KEY_SOURCE:'env',T3_INFRA_LAUNCHER:'/bin/false',T3CODE_PORT:'1'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});
 t.after(async()=>{if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}await fs.rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(logs);try{if((await fetch(base+'/hello')).ok)break;}catch{}await pause(20);}
 const request=(route,{body,headers={},method}={})=>fetch(base+route,{method:method||(body===undefined?'GET':'POST'),headers:{'x-t3-setup-key':'files-fixture-key',...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
 return {root,home,workspace,outside,base,request};
}

test('Files HTTP enforces authentication, same-origin POST, method and body limits; streams sandboxed downloads and honors etags',{timeout:20_000},async t=>{
 const {root,home,workspace,outside,base,request}=await filesHTTP(t);
 await Promise.all(FILES_ROUTES.map(async route=>assert.equal((await fetch(base+route)).status,401,route+' requires authentication')));
 for(const route of FILES_ROUTES)assert.equal((await request(route,{method:FILES_POST_ROUTES.includes(route)?'GET':'POST',...(FILES_POST_ROUTES.includes(route)?{}:{body:{}})})).status,405,route+' checks the method');
 for(const route of FILES_POST_ROUTES)assert.equal((await request(route,{body:{},headers:{'sec-fetch-site':'cross-site'}})).status,403,route+' rejects cross-site writes');
 const locked=await request('/files/mkdir',{body:{parent:path.join(home,'.t3'),name:'locked'}});assert.equal(locked.status,423);assert.equal((await locked.json()).managed.root,path.join(home,'.t3'));
 const created=await request('/files/write',{body:{path:path.join(workspace,'large.txt'),text:'a'.repeat(100_000),mode:'create'}});assert.equal(created.status,200);const saved=await created.json();assert.equal((await fs.stat(saved.path)).size,100_000);
 assert.equal((await request('/files/read?'+new URLSearchParams({path:saved.path,edit:'1'}),{headers:{'if-none-match':saved.etag}})).status,304);
 const tooLarge=await request('/files/write',{body:{path:saved.path,text:'a'.repeat(5*1024*1024+1),mode:'overwrite'}});assert.equal(tooLarge.status,413);assert.equal((await fs.stat(saved.path)).size,100_000);
 const start=await request('/files/upload/start',{body:{dest:workspace,items:[{path:'chunk.txt',size:5,lastModified:1700000000000}]}});assert.equal(start.status,200);const id=(await start.json()).uploads[0].id;
 const chunk=await fetch(base+'/files/upload/chunk?'+new URLSearchParams({id,offset:0}),{method:'POST',headers:{'x-t3-setup-key':'files-fixture-key','content-type':'application/octet-stream'},body:Buffer.from('hello')});assert.equal(chunk.status,200);assert.equal((await chunk.json()).received,5);
 assert.equal(await fs.stat(path.join(workspace,'chunk.txt')).then(()=>true,()=>false),false);const finish=await request('/files/upload/finish',{body:{id}});assert.equal(finish.status,200);assert.equal(await fs.readFile(path.join(workspace,'chunk.txt'),'utf8'),'hello');

 const places=await request('/proxy/__setup/files/places');assert.equal(places.status,200);assert.equal((await places.json()).projects.path,workspace);
 assert.equal((await request('/files/measure',{body:{path:workspace},headers:{'sec-fetch-site':'cross-site'}})).status,403);
 assert.equal((await request('/files/places',{body:{}})).status,405);
 assert.equal((await request('/files/measure',{body:'{bad'})).status,400);
 assert.equal((await request('/files/measure',{body:' '.repeat(65537)})).status,413);
 const url='/files/list?'+new URLSearchParams({path:outside,sort:'name'});
 let listing=await request(url);assert.equal(listing.status,200);await listing.json();await pause(100);
 listing=await request(url);const data=await listing.json();assert.equal(data.entries[0].name,'hello.html');assert(listing.headers.get('etag'));
 assert.equal((await request(url,{headers:{'if-none-match':listing.headers.get('etag')}})).status,304);
 const raw=await request('/files/raw?'+new URLSearchParams({path:path.join(outside,'hello.html')}));assert.equal(raw.status,200);assert.equal(raw.headers.get('content-type'),'application/octet-stream');assert.equal(raw.headers.get('x-content-type-options'),'nosniff');assert.match(raw.headers.get('content-disposition'),/^attachment;/);assert.equal(raw.headers.get('content-security-policy'),"sandbox; default-src 'none'");assert.match(await raw.text(),/mustNotRun/);
 const range=await request('/files/raw?'+new URLSearchParams({path:path.join(outside,'hello.html')}),{headers:{range:'bytes=1-3'}});assert.equal(range.status,206);assert.equal(await range.text(),'scr');
 assert.equal((await request('/files/raw?'+new URLSearchParams({path:path.join(outside,'hello.html')}),{headers:{range:'bytes=999999-'}})).status,416);
 const broken=await request('/files/list?'+new URLSearchParams({path:path.join(root,'missing')}));assert.equal(broken.status,404);assert.equal((await broken.json()).code,'missing');
 const page=await request('/');const csp=page.headers.get('content-security-policy');assert.match(csp,/img-src data: blob:/);assert.match(csp,/frame-src blob:/);assert.doesNotMatch(csp,/script-src[^;]*blob:|connect-src[^;]*blob:/);
});

test('Files HTTP archive and space jobs use single-use reviews and publish verified results',{timeout:40000},async t=>{
 const {workspace,outside,request}=await filesHTTP(t);
 // The real server exposes review-first archives and destructive jobs, too.
 const reviewed=await (await request('/files/zip/preview',{body:{paths:[path.join(outside,'hello.html')]}})).json();assert(reviewed.token);
 const prepared=await request('/files/zip/start',{body:{token:reviewed.token}});assert.equal(prepared.status,200);const downloadInfo=await prepared.json();
 const zip=await request('/files/zip?'+new URLSearchParams({token:downloadInfo.token}));assert.equal(zip.status,200);assert.equal(zip.headers.get('content-length'),null);assert.equal(zip.headers.get('content-type'),'application/zip');assert.match(zip.headers.get('content-disposition'),/^attachment;/);assert.equal(zip.headers.get('content-security-policy'),"sandbox; default-src 'none'");const archive=path.join(outside,'download.zip');await fs.writeFile(archive,Buffer.from(await zip.arrayBuffer()));assert.equal((await request('/files/zip?'+new URLSearchParams({token:downloadInfo.token}))).status,409);
 const extraction=await (await request('/files/extract/preview',{body:{path:archive}})).json();assert.equal(extraction.canExtract,true);assert.deepEqual(extraction.topLevel,['hello.html']);const action=await (await request('/files/extract',{body:{token:extraction.token,name:'extracted'}})).json();assert(action.job);
 const settled=async id=>{assert.equal(typeof id,'string','The action must return a job');for(let attempt=0;attempt<200;attempt++){const job=(await (await request('/files/jobs')).json()).jobs.find(row=>row.id===id);if(job&&!['queued','running'].includes(job.state)){assert.equal(job.state,'done',job.error);return job;}await pause(20);}assert.fail('File job did not complete');};await settled(action.job);assert.match(await fs.readFile(path.join(outside,'extracted/hello.html'),'utf8'),/mustNotRun/);
 const cleanupProject=path.join(workspace,'cleanup-project');await fs.mkdir(path.join(cleanupProject,'node_modules'),{recursive:true});await fs.writeFile(path.join(cleanupProject,'package.json'),'{}');await fs.writeFile(path.join(cleanupProject,'node_modules/cache'),'output');
 const cleanReview=await (await request('/files/clean/preview',{body:{path:cleanupProject}})).json();assert.equal(cleanReview.projects.length,1);const cleaned=await (await request('/files/clean',{body:{token:cleanReview.token,ids:cleanReview.projects[0].items.map(row=>row.id)}})).json();assert.equal(cleaned.ok,true,JSON.stringify(cleaned));await settled(cleaned.job);assert.equal(await fs.stat(path.join(cleanupProject,'node_modules')).then(()=>true,()=>false),false);
 const deleteReview=await (await request('/files/delete/preview',{body:{paths:[cleanupProject]}})).json();assert.equal(deleteReview.confirmName,'cleanup-project');assert.equal((await request('/files/delete',{body:{token:deleteReview.token,confirmName:'wrong'}})).status,400);const deleted=await (await request('/files/delete',{body:{token:deleteReview.token,confirmName:deleteReview.confirmName,confirmed:true}})).json();await settled(deleted.job);assert.equal(await fs.stat(cleanupProject).then(()=>true,()=>false),false);assert.equal((await request('/files/delete',{body:{token:deleteReview.token,confirmName:deleteReview.confirmName,confirmed:true}})).status,409);
});
