// Provider contracts are deliberately explicit: package formats are not interchangeable.
import path from 'node:path';
import { configSnapshot } from '../skills/state.mjs';
import { randomBytes } from 'node:crypto';

const fail=(code,message)=>Object.assign(new Error(message),{code});
export const pluginProviders = [
  {id:'codex',name:'Codex',installSupported:true,installReason:'Native local marketplace; requires managed Codex 0.167.x.'},
  {id:'claude',name:'Claude Code',installSupported:true,installReason:'Native local marketplace; requires Claude Code 2.1.287 or later in the 2.1 release family.'},
  {id:'opencode',name:'OpenCode',installSupported:true,experimental:true,installReason:'Experimental complete-snapshot TS/JS module registration on managed OpenCode 2.2.x; watched directories may reload running sessions.'},
  {id:'cursor',name:'Cursor',installSupported:false,installReason:'Inventory only. Persistent plugin loading by T3’s Cursor runtime is not verified.'},
  {id:'grok',name:'Grok Build',installSupported:false,installReason:'Inventory only. A noninteractive native installation contract is not verified.'},
  {id:'muse',name:'Muse Code',installSupported:false,installReason:'No verified plugin installation contract is available.'},
  {id:'pi',name:'Pi',installSupported:true,installReason:'Personal local package declaration. Pi loads reviewed resources in a new session; runtime loading is not verified by Setup.'},
  {id:'antigravity',name:'Antigravity',installSupported:false,installReason:'Inventory only. T3’s Antigravity runtime does not have a verified persistent plugin installation interface.'},
];
export const providerConfig=(provider,home,env)=>provider==='codex'?path.resolve(home,env.CODEX_HOME||'.codex','config.toml'):provider==='claude'?path.resolve(home,env.CLAUDE_CONFIG_DIR||'.claude','settings.json'):provider==='opencode'?path.join(opencodeRoot(home,env),'opencode.json'):path.resolve(home,env.PI_CODING_AGENT_DIR||'.pi/agent','settings.json');
export const parseSettings=text=>{try {const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw fail('unavailable','Native user settings contain invalid JSON. Repair them before changing plugins.');}};
export const piSource=entry=>typeof entry==='string'?entry:entry?.source;
export const piEnabled=(settings,record)=>Array.isArray(settings.packages)&&settings.packages.some(entry=>piSource(entry)===record.packageDir);
export const nativeRevisionFiles=(provider,home,env)=>provider==='claude'?['plugins/installed_plugins.json','plugins/known_marketplaces.json'].map(file=>path.resolve(home,env.CLAUDE_CONFIG_DIR||'.claude',file)):provider==='opencode'?['opencode.json','opencode.jsonc'].map(file=>path.join(opencodeRoot(home,env),file)):[];
export async function nativeRevisions(provider,home,env,io){return Promise.all(nativeRevisionFiles(provider,home,env).map(file=>configSnapshot(file,io)));}
export async function writePiSettings({io,config,expected,record,operation,enabled}) {
  const snap=await configSnapshot(config,io,true);
  if(snap.revision!==expected)throw fail('conflict','Pi user settings changed after review.');
  const settings=parseSettings(snap.content);
  if(settings.packages!==undefined&&!Array.isArray(settings.packages))throw fail('unavailable','Pi packages must be an array.');
  const packages=settings.packages||[];
  // Only Setup-owned exact absolute declarations are edited; filtered native entries remain untouched.
  const matches=packages.filter(entry=>piSource(entry)===record.packageDir||record.previousPackageDir&&piSource(entry)===record.previousPackageDir);
  if(matches.some(entry=>typeof entry!=='string'))throw fail('conflict','This Pi package has native resource filters. Preserve or manage them in Pi before changing it in Setup.');
  settings.packages=packages.filter(entry=>!matches.includes(entry));
  if(operation!=='remove'&&(operation==='state'?enabled:record.enabled!==false))settings.packages.push(record.packageDir);
  const dir=path.dirname(snap.resolvedPath),temp=path.join(dir,'.t3-plugin-'+randomBytes(12).toString('hex'));
  await io.mkdir(dir,{recursive:true,mode:0o700});
  await io.writeFile(temp,JSON.stringify(settings,null,2)+'\n',{mode:snap.mode,flag:'wx'});
  try{if(await configSnapshot(config,io)!==expected)throw fail('conflict','Pi user settings changed while saving.');await io.rename(temp,snap.resolvedPath);}finally{await io.rm(temp,{force:true}).catch(()=>{});}
}

export const opencodeRoot=(home,env)=>path.resolve(home,env.OPENCODE_CONFIG_DIR||path.join(env.XDG_CONFIG_HOME||'.config','opencode'));
export function opencodeModuleReason(variant) {
  if(variant?.format!=='local-module')return 'This source exposes an OpenCode package integration. Setup currently manages one local TS/JS module with its complete supporting snapshot; use native package management for other formats.';
  if(!Array.isArray(variant.entrypoints)||variant.entrypoints.length!==1||! /\.(ts|js)$/.test(variant.entrypoints[0]))return 'Setup needs one unambiguous .ts or .js OpenCode entrypoint. Multiple modules and other extensions require native management.';
  return null;
}
export async function openCodeDiscoveryDirectory({io,home,env}) {
  const directory=path.join(opencodeRoot(home,env),'plugins');
  let ancestor=directory;const missing=[];
  for(let depth=0;depth<100;depth++){
    try{
      const resolved=await io.realpath(ancestor),stat=await io.stat(ancestor);
      if(!stat.isDirectory())throw fail('conflict','OpenCode discovery parent is not a directory.');
      const result=path.join(resolved,...[...missing].reverse()),root=await io.realpath(home);
      if(result!==root&&!result.startsWith(root+path.sep))throw fail('unsupported','OpenCode discovery must resolve inside this container home.');
      return result;
    }catch(error){
      if(error.code!=='ENOENT')throw error;
      // A dangling ancestor link must not become a new discovery directory.
      const entry=await io.lstat(ancestor).catch(()=>null);if(entry)throw fail('conflict','OpenCode discovery has a dangling path link. Repair it before installing plugins.');
      if(path.dirname(ancestor)===ancestor)throw fail('conflict','OpenCode discovery directory cannot be resolved.');
      missing.push(path.basename(ancestor));ancestor=path.dirname(ancestor);
    }
  }
  throw fail('unsupported','OpenCode discovery path is too deep.');
}
export async function openCodeLinkState(io,link) {
  let stat;try{stat=await io.lstat(link.path);}catch(error){if(error.code==='ENOENT')return {present:false,revision:'missing'};throw error;}
  if(!stat.isSymbolicLink())throw fail('conflict','An OpenCode discovery entry was replaced by a personal file. Preserve it before continuing.');
  const value=await io.readlink(link.path),after=await io.lstat(link.path);
  if([stat.dev,stat.ino,stat.mtimeMs,stat.ctimeMs].join(':')!==[after.dev,after.ino,after.mtimeMs,after.ctimeMs].join(':'))throw fail('conflict','OpenCode discovery changed while being checked.');
  if(path.resolve(path.dirname(link.path),value)!==link.target)throw fail('conflict','An OpenCode discovery link points somewhere else. Setup will not change it.');
  return {present:true,revision:[stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeMs,stat.ctimeMs,value].join(':')};
}
export async function writeOpenCodeLink({io,link,previous=link,expected,enabled}) {
  if((await openCodeLinkState(io,previous)).revision!==expected)throw fail('conflict','OpenCode discovery changed after review.');
  if(!enabled){if(expected!=='missing'){if(await io.realpath(path.dirname(link.path))!==path.dirname(link.path))throw fail('conflict','OpenCode discovery directory moved while saving.');await io.unlink(link.path);}return;}
  if(expected!=='missing'&&previous.target===link.target)return;
  const dir=path.dirname(link.path);await io.mkdir(dir,{recursive:true,mode:0o700});
  if(await io.realpath(dir)!==dir)throw fail('conflict','OpenCode discovery directory moved while saving.');
  if(expected==='missing'){try{await io.symlink(link.target,link.path);}catch(error){if(error.code==='EEXIST')throw fail('conflict','OpenCode discovery changed while saving.');throw error;}return;}
  const temporary=path.join(dir,'.t3-plugin-'+randomBytes(12).toString('hex'));
  await io.symlink(link.target,temporary);
  try{if((await openCodeLinkState(io,previous)).revision!==expected)throw fail('conflict','OpenCode discovery changed while saving.');await io.rename(temporary,link.path);}finally{await io.rm(temporary,{force:true}).catch(()=>{});}
}
