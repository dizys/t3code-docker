// Provider package lifecycle. Sources are frozen before consent; only owned
// local provider registrations can be mutated. Other inventories remain passive.
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parse as parseToml, patch as patchToml } from './vendor/toml-patch.mjs';
import { createPluginInventory } from './plugins/inventory.mjs';
import { readPluginSource, selectPluginProvider, safePath, hash, treeDigest } from './plugins/sources.mjs';
import { pluginProviders, providerConfig, parseSettings, piEnabled, nativeRevisions, writePiSettings, opencodeModuleReason, openCodeDiscoveryDirectory, openCodeLinkState, writeOpenCodeLink } from './plugins/providers.mjs';
import { configSnapshot, codexConfigPath, serializeState } from './skills/state.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const readConfig = text => {try{return parseToml(text);}catch{throw fail('unavailable','Codex user settings are invalid. Repair them before changing plugins.');}};
const token = () => randomBytes(24).toString('hex');
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const previewText = data => { if (!data || data.length > 65536 || data.includes(0)) return null; try { return new TextDecoder('utf-8',{fatal:true}).decode(data); } catch { return null; } };
const json = value => JSON.stringify(value, null, 2) + '\n';

export function pluginCommand({ executable, home, env = process.env }, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: home, env: { PATH: env.PATH || process.env.PATH, HOME: home, CODEX_HOME: env.CODEX_HOME || path.join(home,'.codex'), CLAUDE_CONFIG_DIR:env.CLAUDE_CONFIG_DIR || path.join(home,'.claude'), ...(env.OPENCODE_CONFIG_DIR?{OPENCODE_CONFIG_DIR:env.OPENCODE_CONFIG_DIR}:{}), ...(env.XDG_CONFIG_HOME?{XDG_CONFIG_HOME:env.XDG_CONFIG_HOME}:{}), ...(env.SSL_CERT_FILE ? {SSL_CERT_FILE:env.SSL_CERT_FILE} : {}) }, detached: true, stdio: ['ignore','pipe','ignore'] });
    let output = '', bytes = 0, failure;
    const stop = message => { failure ||= fail('unavailable', message); try { process.kill(-child.pid,'SIGKILL'); } catch {} };
    const timer = setTimeout(() => stop('The plugin command timed out. Refresh its state before retrying.'), 45000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2*1024*1024) stop('The plugin command returned too much data.'); else output += chunk; });
    child.once('error', () => { clearTimeout(timer); reject(fail('unavailable','The managed agent could not start.')); });
    child.once('close', code => { clearTimeout(timer); if (failure) reject(failure); else if (code !== 0) reject(fail('unavailable','The agent refused the plugin operation. Refresh to inspect its current state.')); else resolve(output); });
  });
}

export function describePlugin(pkg) {
  const components = [], hooks = [];
  const openCodeModule=pkg.format==='local-module';
  if(openCodeModule)for(const name of pkg.entrypoints||[])components.push({type:'extensions',name});
  const fields=pkg.manifest.pi||pkg.manifest;
  for (const type of openCodeModule?[]:pkg.manifest.pi?['extensions','skills','prompts','themes']:['skills','agents','commands','rules']) {
    const refs=typeof fields[type]==='string'?[fields[type]]:Array.isArray(fields[type])?fields[type].filter(ref=>typeof ref==='string'):[type];
    for(const ref of refs){
      const directory=ref.replace(/^\.\//,'').replace(/\/$/,'');
      if(pkg.files.some(file=>file.name===directory))components.push({type,name:path.posix.basename(directory)});
      for(const name of new Set(pkg.files.filter(file=>file.name.startsWith(directory+'/')).map(file=>file.name.slice(directory.length+1).split('/')[0])))components.push({type,name});
    }
  }
  for (const type of openCodeModule||pkg.manifest.pi?[]:['mcpServers','apps']) if (pkg.manifest[type] || pkg.files.some(f => (type==='apps'?['.app.json']:['.mcp.json','mcp.json']).includes(f.name))) components.push({type,name:type === 'apps' ? 'Connected services' : 'MCP servers'});
  const hookFile = openCodeModule||pkg.manifest.pi ? null : typeof pkg.manifest.hooks === 'string' ? pkg.manifest.hooks.replace(/^\.\//,'') : 'hooks/hooks.json';
  const file = pkg.files.find(f => f.name === hookFile);
  const hookObjects = openCodeModule||pkg.manifest.pi?[]:[typeof pkg.manifest.hooks==='object'?pkg.manifest.hooks:null];
  if (file) { try {hookObjects.push(JSON.parse(file.data.toString('utf8')));} catch {throw fail('invalid','The hook definition contains invalid JSON.');} }
  const walk = (value, event='Hook') => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.command === 'string') {hooks.push({event,handlerType:'command',command:value.command.slice(0,65536)}); return;}
    if (typeof value.type === 'string' && value.type !== 'command') {hooks.push({event,handlerType:value.type,command:null});return;}
    for (const [key,item] of Object.entries(value)) if (typeof item === 'object') walk(item, key === 'hooks' || /^\d+$/.test(key) ? event : key);
  };
  for(const object of hookObjects)walk(object);
  for (const event of new Set(hooks.map(h => h.event))) components.push({type:'hooks',name:event});
  let previewBytes=0;
  const files=pkg.files.map(f=>{
    const text=previewBytes+f.data.length<=2*1024*1024?previewText(f.data):null;
    if(text!==null)previewBytes+=f.data.length;
    return {name:f.name,bytes:f.data.length,executable:Boolean(f.mode&0o100),digest:hash(f.data),text};
  });
  return {components,hooks,files};
}

export function createPluginsService({ home, env = process.env, baseDir = path.join(home,'.t3'), io = fs, getHarness = async()=>null, resolveSource=readPluginSource, command=pluginCommand, now=Date.now } = {}) {
  const inventory = createPluginInventory({home,env,io,getHarness});
  const root = path.join(baseDir,'setup','plugins'), registry = path.join(root,'installed.json');
  const previews = new Map(), jobs = new Map();
  let busy = false;
  const readRecords = async () => {
    try {
      const snapshot = await configSnapshot(registry,io,true), parsed=JSON.parse(snapshot.content);
      if (!Array.isArray(parsed.records) || parsed.records.length>128) throw Error();
      return parsed.records;
    } catch (e) {if (e.message?.includes('could not be checked')) throw e; const exists=await io.lstat(registry).catch(()=>null); if (!exists) return []; throw fail('unavailable','Plugin tracking metadata is invalid. Repair it before making changes.');}
  };
  const writeRecords = async records => {
    if(records.length>128||Buffer.byteLength(json({version:1,records}))>1024*1024)throw fail('too_large','Setup plugin tracking reached its storage limit. Remove an installation before adding more.');
    await io.mkdir(root,{recursive:true,mode:0o700});
    const temp=path.join(root,'.registry-'+token());
    await io.writeFile(temp,json({version:1,records}),{mode:0o600,flag:'wx'}); await io.rename(temp,registry);
  };
  const codex = async () => {
    const harness=await getHarness('codex');
    if (!harness?.runnable || !harness.executable) throw fail('unsupported','Install Codex on the Agents page to manage plugin snapshots.');
    const output=await command({executable:harness.executable,home,env},['--version']);
    const version=output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    if (!version || !/^0\.167\./.test(version)) throw fail('unsupported','Snapshot lifecycle is verified for Codex 0.167.x. Other releases remain read-only.');
    return {executable:harness.executable,version,home,env};
  };
  const nativeFor = async provider => {
    const capability=pluginProviders.find(p=>p.id===provider);
    if(!capability?.installSupported)throw fail('unsupported',capability?.installReason||'Choose a supported plugin provider.');
    if(provider==='codex')return codex();
    if(provider==='pi')return {provider:'pi',version:'local-package-settings',home,env};
    if(provider==='opencode'){
      const harness=await getHarness('opencode');if(!harness?.runnable||!harness.executable)throw fail('unsupported','Install managed OpenCode on the Agents page to register its plugin modules.');
      const native={provider,executable:harness.executable,home,env};
      const version=(await command(native,['--version'])).match(/(?:^|\s|v)(\d+\.\d+\.\d+)\b/)?.[1];
      if(!/^2\.2\./.test(version||''))throw fail('unsupported','Experimental module registration is verified for OpenCode 2.2.x. Other release families require native management.');
      return {...native,version};
    }
    const harness=await getHarness('claude');
    if(!harness?.runnable||!harness.executable)throw fail('unsupported','Install Claude Code on the Agents page to manage its plugins.');
    const native={provider,executable:harness.executable,home,env};
    const version=(await command(native,['--version'])).match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    if(!/^2\.1\./.test(version||'')||Number(version.split('.')[2])<287)throw fail('unsupported','Claude snapshot management requires Claude Code 2.1.287 or later in the verified 2.1 family.');
    const help=await command(native,['plugin','uninstall','--help']);
    if(!help.includes('--keep-data')||!help.includes('--json'))throw fail('unsupported','This Claude release does not expose the required data-preserving JSON lifecycle options.');
    return {...native,version};
  };
  const claudeList=async native=>{
    let result;try{result=JSON.parse(await command(native,['plugin','list','--json']));}catch{throw fail('unavailable','Claude returned an unreadable plugin inventory.');}
    if(!Array.isArray(result)||result.some(r=>typeof r.id!=='string'||typeof r.scope!=='string'))throw fail('unavailable','Claude returned an incomplete plugin inventory.');
    return result;
  };
  const claudeCall=async(native,args)=>{
    const output=await command(native,args),last=output.trim().split('\n').at(-1);
    let result;try{result=JSON.parse(last);}catch{throw fail('unavailable','Claude returned an unreadable lifecycle result.');}
    if(result.outcome!=='ok')throw fail('unavailable','Claude refused the reviewed operation. Inspect its native plugin manager.');
    return result;
  };
  const checkClaudeDependencies=async native=>{
    // Marketplace commands can retry dependencies of other installed plugins. Never approve those implicitly.
    for(const row of await claudeList(native)) {
      if(!row.installPath||!path.resolve(row.installPath).startsWith(path.resolve(home)+path.sep))throw fail('unsupported','Claude has an installation outside the inspectable home. Manage its marketplaces natively.');
      const snapshot=await resolveSource(row.installPath,{home,provider:'claude',env});
      if(snapshot.packages.some(pkg=>pkg.blocked.length))throw fail('unsupported','An existing Claude plugin declares dependencies or install behavior. Marketplace mutation could resolve it automatically; manage Claude marketplaces natively first.');
    }
  };
  const prune=()=>{for(const [id,p] of previews) if(now()>p.expiresAt&&(!p.jobId||jobs.get(p.jobId)?.state!=='running')) previews.delete(id);};
  const planPublic=p=>({ok:true,planId:p.id,expiresAt:p.expiresAt,operation:p.operation,provider:p.provider||'codex',name:p.pkg?.name||p.record?.name,description:p.pkg?.description||p.record?.description||'',source:p.snapshot?.source||p.record?.source,commit:p.snapshot?.commit,version:p.pkg?.version||p.reconcileRecord?.version||p.record?.version,digest:p.pkg?.digest||p.reconcileRecord?.digest||p.record?.digest,components:p.description?.components||[],hooks:p.description?.hooks||[],files:p.description?.files||[],changes:p.changes||null,effects:p.effects,canApply:!p.blocked?.length,blocked:p.blocked||[],activation:p.provider==='opencode'?'provider-reload':'new-session'});
  const list = async () => {
    const result=await inventory.list(), records=await readRecords(), settings={};
    for(const provider of ['codex','claude','pi'])try{
      const snap=await configSnapshot(providerConfig(provider,home,env),io,true);
      settings[provider]=snap.exists?(provider==='codex'?readConfig(snap.content):parseSettings(snap.content)):{};
    }catch{result.warnings.push(provider+' user enablement could not be read.');}
    for (const record of records) {
      const provider=record.provider||'codex',cfg=settings[provider]||{};
      const found=result.plugins.find(p=>p.provider===provider&&(['pi','opencode'].includes(provider)?p.path===record.packageDir:p.nativeId===record.nativeId&&(!record.cachePath||p.path===record.cachePath)));
      const cached=['pi','opencode'].includes(provider)?await io.stat(record.packageDir).then(s=>s.isDirectory()).catch(()=>false):Boolean(found);
      let enabled=provider==='codex'?(typeof cfg.plugins?.[record.nativeId]?.enabled==='boolean'?cfg.plugins[record.nativeId].enabled:null):provider==='claude'?(typeof cfg.enabledPlugins?.[record.nativeId]==='boolean'?cfg.enabledPlugins[record.nativeId]:null):settings.pi?piEnabled(cfg,record):null;
      if(provider==='opencode')try{enabled=(await openCodeLinkState(io,record.link)).present;}catch{enabled=null;result.warnings.push('An OpenCode discovery entry changed outside Setup. Preserve personal files before changing this installation.');}
      const row={...(found||{}),id:record.id,provider,nativeId:record.nativeId,name:record.name,version:record.version,description:record.description,scope:'user',path:found?.path||record.packageDir,source:record.source,commit:record.commit,digest:record.digest,enabled,components:record.components,coverage:'filesystem',stateCoverage:provider==='opencode'?'discovery-links':'user-settings',owned:true,status:cached?(record.state||'installed'):record.state==='installed'?'cache-missing':record.state,revision:hash(json(record)),capabilities:{update:true,remove:true,state:true},readOnlyReason:null};
      if (found) result.plugins.splice(result.plugins.indexOf(found),1,row); else result.plugins.push(row);
    }
    return {...result,providers:result.providers.map(provider=>({...provider,...pluginProviders.find(p=>p.id===provider.id)})),personalOnly:true,installProviders:pluginProviders,installProvider:'codex',installNote:'Reviewed snapshots for Codex and Claude Code; local package declarations for Pi and experimental OpenCode2.2 module registration. Other agents remain inventory-only with provider-specific reasons.'};
  };
  const read = async id => {if(!validId(id)) throw fail('invalid','Choose a discovered plugin.'); const plugin=(await list()).plugins.find(p=>p.id===id);if(!plugin) throw fail('missing','This plugin is no longer in the inventory.');return {ok:true,plugin};};
  const previewSource = async (source, owner='setup') => {
    prune(); if([...previews.values()].filter(p=>p.operation==='source').length>=3) throw fail('busy','Close another source preview before opening more.');
    const snapshot=await resolveSource(source,{home,provider:'all',env});
    const id=token(); previews.set(id,{id,snapshot,owner,expiresAt:now()+600000,operation:'source'});
    return {ok:true,previewId:id,source:snapshot.source,commit:snapshot.commit,packages:snapshot.packages.map(p=>({name:p.name,prefix:p.prefix,description:p.description,version:p.version,digest:p.digest,blocked:p.blocked,providers:pluginProviders.map(provider=>{const variant=p.variants?.[provider.id]||(!p.variants&&provider.id==='codex'?p:null),moduleReason=provider.id==='opencode'&&variant?opencodeModuleReason(variant):null;return {id:provider.id,detected:Boolean(variant),experimental:Boolean(variant?.experimental||provider.experimental),compatible:Boolean(variant&&provider.installSupported&&!moduleReason),format:variant?.manifestPath||null,reason:variant?(moduleReason||(variant.format==='claude-compatible'?'Claude-compatible package format detected; feature support needs native verification. ':!provider.installSupported?'Package integration found. ':'')+provider.installReason):'No '+provider.name+' integration was found in this package.'};}),...describePlugin(p)}))};
  };
  const verifyInstalled = async record => {
    const provider=record.provider||'codex';
    let row=['pi','opencode'].includes(provider)?{path:record.packageDir}:(await inventory.list({provider})).plugins.find(p=>p.nativeId===record.nativeId&&(!record.cachePath||p.path===record.cachePath));
    if(provider==='claude'){
      const registry=await configSnapshot(path.resolve(home,env.CLAUDE_CONFIG_DIR||'.claude','plugins/installed_plugins.json'),io,true);
      if(registry.exists){
        const parsed=parseSettings(registry.content),entries=parsed.plugins?.[record.nativeId];
        const active=Array.isArray(entries)?entries.filter(entry=>entry.scope==='user'):[];
        if(active.length!==1||typeof active[0].installPath!=='string'||!path.resolve(active[0].installPath).startsWith(path.resolve(home)+path.sep))throw fail('conflict','Claude’s personal installation record is missing or ambiguous. Inspect its native plugin manager.');
        row={path:active[0].installPath};
      }
    }
    if(!row)throw fail('conflict','The installed plugin cache is missing. Check its installation before changing it.');
    const snapshot=await resolveSource(row.path,{home,provider,env});
    const pkg=snapshot.packages.find(p=>p.prefix===''&&(provider==='opencode'||p.name===record.name));
    if(!pkg||pkg.digest!==record.digest)throw fail('conflict','Installed plugin files changed outside Setup. Preserve those edits before replacing or removing this snapshot.');
    return pkg;
  };
  const prepare = async ({previewId,prefix,id,provider='codex',operation='install',enabled,revision}={}, owner='setup') => {
    prune(); if([...previews.values()].filter(p=>!p.jobId||jobs.get(p.jobId)?.state==='running').length>=6)throw fail('busy','Close another review before opening more.'); if(busy) throw fail('busy','Another plugin operation is running.');
    const records=await readRecords();
    if(operation!=='install')provider=records.find(r=>r.id===id)?.provider||'codex';
    const config=providerConfig(provider,home,env),native=await nativeFor(provider),configRevision=await configSnapshot(config,io),nativeTracking=await nativeRevisions(provider,home,env,io);
    let snapshot,pkg,record,description,changes,installedPackage,restoreEnabled;
    if(operation==='install') {
      const preview=previews.get(previewId);
      if(preview?.owner!==owner || !preview?.snapshot||preview.operation!=='source') throw fail('conflict','The source preview expired. Read it again.');
      snapshot=preview.snapshot;pkg=snapshot.packages.find(p=>p.prefix===prefix);
      if(pkg)pkg=selectPluginProvider(pkg,provider);
      if(!pkg) throw fail('invalid','Choose a plugin from this source.');
      if(records.some(r=>(r.provider||'codex')===provider&&r.source===snapshot.source&&r.prefix===pkg.prefix)) throw fail('conflict','This source is already installed. Review its update instead.');
      description=describePlugin(pkg);
    } else {
      if(!validId(id)) throw fail('invalid','Choose an installed plugin.');
      record=records.find(r=>r.id===id);
      if(!record) throw fail('unsupported','Manage plugins installed outside Setup through their agent.');
      if(revision!==hash(json(record))) throw fail('conflict','This installation changed. Refresh before continuing.');
      if(!['update','remove','state','reconcile'].includes(operation)||operation==='state'&&typeof enabled!=='boolean') throw fail('invalid','Choose a supported plugin operation.');
      if(record.state!=='installed' && operation!=='reconcile') throw fail('conflict','This installation needs reconciliation before another change.');
      if(['update','remove'].includes(operation)||operation==='state'&&enabled&&provider!=='codex')installedPackage=await verifyInstalled(record);
      const settings=await configSnapshot(config,io,true);
      if(provider==='opencode'){if(operation!=='reconcile')restoreEnabled=(await openCodeLinkState(io,record.link)).present;}
      else if(settings.exists)restoreEnabled=provider==='codex'?readConfig(settings.content).plugins?.[record.nativeId]?.enabled:provider==='claude'?parseSettings(settings.content).enabledPlugins?.[record.nativeId]:piEnabled(parseSettings(settings.content),record);
      if(operation==='update') {
        snapshot=await resolveSource(record.source,{home,provider:provider==='opencode'?'all':provider,env});pkg=snapshot.packages.find(p=>p.prefix===record.prefix&&(provider==='opencode'||p.name===record.name));
        if(pkg&&provider==='opencode')pkg=selectPluginProvider(pkg,'opencode');
        if(!pkg||pkg.name!==record.name) throw fail('missing','The tracked plugin is missing or renamed upstream.');
        description=describePlugin(pkg);
        const old=new Map((record.files||[]).map(f=>[f.name,f]));
        changes=description.files.map(f=>({name:f.name,beforeText:previewText(installedPackage.files.find(old=>old.name===f.name)?.data),status:!old.has(f.name)?'added':old.get(f.name).digest!==f.digest||old.get(f.name).executable!==f.executable?'modified':'unchanged'}));
        for(const name of old.keys()) if(!description.files.some(f=>f.name===name)) changes.push({name,status:'removed',beforeText:previewText(installedPackage.files.find(file=>file.name===name)?.data)});
      }
    }
    if(provider==='claude'&&['install','update'].includes(operation))await checkClaudeDependencies(native);
    const effects=operation==='reconcile'?['Ask Codex whether this package is installed, then repair Setup tracking to match.','No plugin code is run. Source snapshots and data are retained.']:operation==='remove'?['Remove the native plugin registration and its cached copy.','Retain the source snapshot and Setup tracking history on this home volume.','Existing sessions may retain loaded code. Remote permissions are not revoked.']
      :operation==='state'?[`${enabled?'Enable':'Disable'} this plugin for new Codex sessions.`, 'Hook trust and tool permissions are unchanged.']
      :['Install the complete reviewed snapshot into a dedicated local Codex marketplace.','Codex enables the plugin for new sessions. Hooks still require exact-definition trust.','Plugin code can access this container’s projects, home files and network when it runs.','Repository-contained links are copied as regular files in this frozen snapshot.', 'Runtime dependencies are not installed. Review any bootstrap behavior in the hook commands.'];
    if(operation==='update'&&restoreEnabled===false)effects.push('The updated plugin will keep its disabled setting.');
    if(operation==='update')effects.push('Replace the previous registration after staging the new snapshot. Review changed hooks again.');
    if(provider!=='codex')effects.splice(0,effects.length,...(operation==='remove'?[provider==='claude'?'Uninstall the personal native registration and cache. Keep plugin data; Claude may remove saved plugin options and secrets.':'Remove only this Setup-owned local package declaration. Retain its frozen snapshot and data.', 'Existing sessions may retain loaded code. Remote permissions are not revoked.']:operation==='state'?[`${enabled?'Enable':'Disable'} the personal ${provider==='pi'?'package declaration':'plugin setting'} for new sessions.`, 'Project settings and managed policies may change effective loading.']:operation==='reconcile'?['Read personal installation settings and repair Setup tracking. No plugin code is run.']:[provider==='claude'?'Register the reviewed local marketplace and install the complete package using Claude’s native CLI.':'Register the complete frozen package in Pi’s personal packages array. Pi is not started by Setup.', 'Enabled hooks, extensions and servers can execute automatically in a new session with access to projects, home files and network. This agent has no Codex per-hook trust gate.', 'No npm install, dependency resolution or package scripts are approved. Existing sessions are not reloaded.',...(operation==='update'?['Replace the reviewed snapshot; preserve a disabled setting.']:[])]));
    if(provider!=='codex'&&operation==='state'&&enabled)effects.push('Enabled hooks, extensions and servers may execute automatically with access to this container’s projects, home files and network. This agent has no Codex per-hook trust gate.');
    const p={id:token(),owner,operation,provider,config,nativeTracking,snapshot,pkg,record,description,changes,enabled,restoreEnabled,native,configRevision,recordsRevision:hash(json(records)),expiresAt:now()+600000,effects,blocked:operation==='update'&&pkg.digest===record.digest?['The repository matches the installed snapshot. No update is needed.']:[...(pkg?.blocked||[]),...(provider==='codex'&&description?.hooks.some(h=>h.handlerType!=='command')?['This plugin has hook types that require review in Codex.']:[])]};
    if(provider==='claude'&&operation==='update'&&pkg.version===record.version)p.blocked.push('Claude requires an upstream version change to update a frozen package safely.');
    if(provider==='opencode'){
      if(pkg){const reason=opencodeModuleReason(pkg);if(reason)p.blocked.push(reason);}
      const discoveryDir=await openCodeDiscoveryDirectory({io,home,env});
      if(record?.link){if(path.dirname(record.link.path)!==discoveryDir||!/^t3-[a-f0-9]{20}\.(ts|js)$/.test(path.basename(record.link.path))||!record.packageDir.startsWith(path.join(root,'artifacts')+path.sep)||!safePath(record.link.entrypoint)||record.link.target!==path.join(record.packageDir,record.link.entrypoint))throw fail('conflict','The tracked OpenCode discovery location changed. Inspect it before continuing.');p.link=record.link;}
      else if(pkg&&!opencodeModuleReason(pkg)){const location=artifactLocation(p),entrypoint=pkg.entrypoints[0];if(!safePath(entrypoint)||!pkg.files.some(file=>file.name===entrypoint))throw fail('invalid','The OpenCode entrypoint is outside or missing from this snapshot.');p.link={path:path.join(discoveryDir,'t3-'+hash(snapshot.source+'\0'+pkg.prefix+'\0'+entrypoint).slice(0,20)+path.extname(entrypoint)),target:path.join(location.packageDir,entrypoint),entrypoint};}
      if(p.link)try{p.linkRevision=(await openCodeLinkState(io,p.link)).revision;}catch(error){
        const previous=record?.previousRecord;
        if(operation!=='reconcile'||record?.state!=='installing'||!previous||previous.id!==record.id||previous.provider!=='opencode'||previous.source!==record.source||previous.prefix!==record.prefix||previous.link?.path!==record.link.path||!safePath(previous.link.entrypoint)||!previous.packageDir?.startsWith(path.join(root,'artifacts')+path.sep)||previous.link.target!==path.join(previous.packageDir,previous.link.entrypoint))throw error;
        p.link=previous.link;p.reconcileRecord=previous;p.linkRevision=(await openCodeLinkState(io,p.link)).revision;
      }
      p.discoveryDir=discoveryDir;
      p.effects=[operation==='remove'?'Remove only this Setup-owned OpenCode discovery link. Retain the source snapshot and data.':operation==='state'?`${enabled?'Register':'Unregister'} this snapshot’s OpenCode module through its discovery link.`:operation==='reconcile'?'Check the owned discovery link and frozen snapshot, then repair Setup tracking.':'Register the complete reviewed snapshot through a dedicated local OpenCode discovery link.', 'OpenCode watches global plugin directories: registration or updates may activate code immediately and reload running sessions. Removal may unload it; restarting OpenCode can still be required.', 'Module code has this container user’s access to projects, home files and network. There is no separate per-hook trust gate. Project or managed configuration can change what actually loads.', 'Setup does not start an OpenCode service, run the module, install dependencies, or reload sessions. Runtime activation is not verified.'];
      if(p.reconcileRecord)p.effects[0]='Restore Setup tracking to the previous reviewed snapshot still registered on disk. Retain the interrupted incoming snapshot; do not change the discovery link.';
    }
    if(provider==='claude'&&record)p.catalogRevision=await configSnapshot(path.join(record.marketplaceDir,'.claude-plugin/marketplace.json'),io);
    previews.set(p.id,p);return planPublic(p);
  };
  const setEnabled = async (nativeId,enabled,expected,config=codexConfigPath(home,env)) => {
    const snap=await configSnapshot(config,io,true);
    if(snap.revision!==expected)throw fail('conflict','Codex settings changed after review.');
    const cfg=snap.exists?readConfig(snap.content):{};
    cfg.plugins ||= {};cfg.plugins[nativeId]={...(cfg.plugins[nativeId]||{}),enabled};
    const next=patchToml(snap.exists?snap.content:'',cfg), dir=path.dirname(snap.resolvedPath);
    await io.mkdir(dir,{recursive:true});const tmp=path.join(dir,'.t3-plugin-'+token());
    await io.writeFile(tmp,next,{mode:snap.mode,flag:'wx'});
    try {if(await configSnapshot(config,io)!==expected)throw fail('conflict','Codex settings changed while saving.');await io.rename(tmp,snap.resolvedPath);}finally{await io.rm(tmp,{force:true}).catch(()=>{});}
    if(readConfig((await configSnapshot(config,io,true)).content).plugins?.[nativeId]?.enabled!==enabled)throw fail('conflict','Codex enablement could not be verified.');
  };
  const artifactLocation=p=>{
    const marketplace='t3-'+hash((p.provider==='codex'?'':p.provider+'\0')+p.snapshot.source+'\0'+p.pkg.prefix).slice(0,16);
    const directory=path.join(root,'artifacts',marketplace,p.pkg.digest),packageDir=path.join(directory,'package');
    return {marketplace,directory,packageDir,marketplaceDir:path.dirname(directory)};
  };
  const stage = async p => {
    const {marketplace,directory,packageDir}=artifactLocation(p);
    // A private immutable directory is published by rename, never merged into a live package.
    const temp=path.join(root,'.stage-'+token());await io.mkdir(path.join(temp,'package'),{recursive:true,mode:0o700});
    try {
      for(const f of p.pkg.files){const target=path.join(temp,'package',f.name);await io.mkdir(path.dirname(target),{recursive:true});await io.writeFile(target,f.data,{mode:f.mode,flag:'wx'});}
      await io.mkdir(path.join(temp,'.agents/plugins'),{recursive:true});
      await io.writeFile(path.join(temp,'.agents/plugins/marketplace.json'),json({name:marketplace,owner:{name:'T3 Setup'},plugins:[{name:p.pkg.name,source:{source:'local',path:'./package'},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}]}));
      await io.mkdir(path.dirname(directory),{recursive:true});
      try{await io.rename(temp,directory);}catch(e){
        if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;
        const existing=await resolveSource(packageDir,{home,provider:p.provider,env});
        if(existing.packages.length!==1||existing.packages[0].digest!==p.pkg.digest)throw fail('conflict','The stored snapshot changed. Inspect its files before retrying.');
        const catalog=JSON.parse(await io.readFile(path.join(directory,'.agents/plugins/marketplace.json'),'utf8'));
        if(catalog.name!==marketplace||catalog.plugins?.length!==1||catalog.plugins[0].source?.path!=='./package')throw fail('conflict','The stored marketplace changed.');
      }
      const marketplaceDir=path.dirname(directory);
      return {directory,packageDir,marketplace,marketplaceDir};
    }finally{await io.rm(temp,{recursive:true,force:true});}
  };
  const applyOpenCode=async(p,records,touch)=>{
    const mutate=async args=>{if(await openCodeDiscoveryDirectory({io,home,env})!==p.discoveryDir)throw fail('conflict','OpenCode discovery directory moved after review.');return writeOpenCodeLink({io,...args});};
    const linkState=await openCodeLinkState(io,p.link);
    if(linkState.revision!==p.linkRevision)throw fail('conflict','OpenCode discovery changed after review.');
    if(p.operation==='reconcile'){
      if(p.record.state==='removing'&&!linkState.present){await writeRecords(records.filter(record=>record.id!==p.record.id));return;}
      const observed={...(p.reconcileRecord||p.record),state:'installed',enabled:linkState.present};delete observed.previousRecord;
      await verifyInstalled(observed);
      await writeRecords(records.map(record=>record.id===p.record.id?observed:record));return;
    }
    if(p.operation==='state'){
      await mutate({link:p.link,expected:p.linkRevision,enabled:p.enabled});touch();
      await writeRecords(records.map(record=>record.id===p.record.id?{...record,enabled:p.enabled}:record));return;
    }
    if(p.operation==='remove'){
      await writeRecords(records.map(record=>record.id===p.record.id?{...record,state:'removing'}:record));touch();
      await mutate({link:p.link,expected:p.linkRevision,enabled:false});
      await writeRecords(records.filter(record=>record.id!==p.record.id));return;
    }
    const staged=await stage(p),entrypoint=p.pkg.entrypoints[0],link={path:p.link.path,target:path.join(staged.packageDir,entrypoint),entrypoint};
    const previousRecord=p.record?{...p.record}:null;if(previousRecord)delete previousRecord.previousRecord;
    const record={id:p.record?.id||hash('opencode\0'+p.snapshot.source+'\0'+p.pkg.prefix).slice(0,32),provider:'opencode',nativeId:p.pkg.name,name:p.pkg.name,description:p.pkg.description,version:p.pkg.version,source:p.snapshot.source,prefix:p.pkg.prefix,commit:p.snapshot.commit,digest:p.pkg.digest,components:p.description.components,files:p.description.files.map(({text,...file})=>file),...staged,link,enabled:p.operation==='update'?linkState.present:true,state:'installing',installedAt:now(),...(previousRecord?{previousRecord}:{})};
    const next=records.filter(item=>item.id!==record.id);next.push(record);await writeRecords(next);touch();
    await mutate({link,previous:p.link,expected:p.linkRevision,enabled:record.enabled});
    await verifyInstalled(record);record.state='installed';delete record.previousRecord;await writeRecords(next);
  };
  const applyOther=async(p,native,records,touch)=>{
    const provider=p.provider,config=p.config;
    const nativePresent=async record=>provider==='pi'?piEnabled(parseSettings((await configSnapshot(config,io,true)).content),record):(await claudeList(native)).some(row=>row.id===record.nativeId&&row.scope==='user');
    if(p.operation==='reconcile'){
      const present=await nativePresent(p.record)||provider==='pi'&&p.record.enabled===false&&p.record.state!=='removing';
      if(present)await verifyInstalled(p.record);
      await writeRecords(present?records.map(r=>r.id===p.record.id?{...r,state:'installed'}:r):records.filter(r=>r.id!==p.record.id));return;
    }
    if(p.operation==='state'){
      if(provider==='pi')await writePiSettings({io,config,expected:p.configRevision,record:p.record,operation:'state',enabled:p.enabled});
      else await claudeCall(native,['plugin',p.enabled?'enable':'disable',p.record.nativeId,'--scope','user','--json']);
      const cfg=parseSettings((await configSnapshot(config,io,true)).content);
      const seen=provider==='pi'?piEnabled(cfg,p.record):cfg.enabledPlugins?.[p.record.nativeId];
      if(seen!==p.enabled)throw fail('conflict','The requested user setting could not be verified.');
      if(provider==='pi')await writeRecords(records.map(record=>record.id===p.record.id?{...record,enabled:p.enabled}:record));
      return;
    }
    if(p.operation==='remove'){
      await writeRecords(records.map(r=>r.id===p.record.id?{...r,state:'removing'}:r));touch();
      if(provider==='pi')await writePiSettings({io,config,expected:p.configRevision,record:p.record,operation:'remove'});
      else await claudeCall(native,['plugin','uninstall',p.record.nativeId,'--scope','user','--keep-data','--json']);
      if(await nativePresent(p.record))throw fail('conflict','Native removal could not be verified.');
      await writeRecords(records.filter(r=>r.id!==p.record.id));return;
    }
    const staged=await stage(p),nativeId=provider==='pi'?staged.packageDir:p.pkg.name+'@'+staged.marketplace;
    const record={id:p.record?.id||hash(provider+'\0'+p.snapshot.source+'\0'+p.pkg.prefix).slice(0,32),provider,nativeId,name:p.pkg.name,description:p.pkg.description,version:p.pkg.version,source:p.snapshot.source,prefix:p.pkg.prefix,commit:p.snapshot.commit,digest:p.pkg.digest,components:p.description.components,files:p.description.files.map(({text,...file})=>file),...staged,enabled:p.restoreEnabled!==false,state:'installing',installedAt:now()};
    const next=records.filter(r=>r.id!==record.id);next.push(record);await writeRecords(next);touch();
    if(provider==='pi')await writePiSettings({io,config,expected:p.configRevision,record:{...record,previousPackageDir:p.record?.packageDir,enabled:p.restoreEnabled},operation:p.operation});
    else {
      const catalogDir=path.join(staged.marketplaceDir,'.claude-plugin');await io.mkdir(catalogDir,{recursive:true,mode:0o700});
      const catalog=path.join(catalogDir,'marketplace.json'),temp=path.join(catalogDir,'.reviewed-'+token());
      await io.writeFile(temp,json({name:staged.marketplace,owner:{name:'T3 Setup'},plugins:[{name:p.pkg.name,source:'./'+p.pkg.digest+'/package'}]}),{mode:0o600,flag:'wx'});
      await io.rename(temp,catalog);
      if(p.operation==='update'){
        await claudeCall(native,['plugin','marketplace','update',staged.marketplace,'--json']);
        await claudeCall(native,['plugin','update',nativeId,'--scope','user','--json']);
      }else{
        await claudeCall(native,['plugin','marketplace','add',staged.marketplaceDir,'--scope','user','--json']);
        await claudeCall(native,['plugin','install',nativeId,'--scope','user','--json']);
      }
      if(p.restoreEnabled===false&&parseSettings((await configSnapshot(config,io,true)).content).enabledPlugins?.[nativeId]!==false)await claudeCall(native,['plugin','disable',nativeId,'--scope','user','--json']);
      const nativeRow=(await claudeList(native)).find(row=>row.id===record.nativeId&&row.scope==='user');
      if(!nativeRow||typeof nativeRow.installPath!=='string')throw fail('conflict','Claude installation could not be verified.');
      record.cachePath=nativeRow.installPath;
    }
    await verifyInstalled(record);
    record.state='installed';await writeRecords(next);
  };
  const apply = async (planId,owner='setup') => {
    prune();const p=previews.get(planId);
    if(!p||p.operation==='source')throw fail('conflict','This review expired. Review the operation again.');
    if(p.owner&&p.owner!==owner)throw fail('conflict','This review belongs to another session.');
    if(p.jobId)return {ok:true,jobId:p.jobId};
    if(busy)throw fail('busy','Another plugin operation is running.');
    if(p.blocked.length)throw fail('unsupported',p.blocked.join(' '));
    if(p.pkg&&treeDigest(p.pkg.files)!==p.pkg.digest)throw fail('conflict','The reviewed snapshot changed.');
    for(const [id,job] of jobs){if(jobs.size<32)break;if(job.state!=='running'){jobs.delete(id);for(const [planId,plan] of previews)if(plan.jobId===id)previews.delete(planId);}}
    busy=true;const jobId=token(),job={ok:true,jobId,state:'running',owner,operation:p.operation,name:p.pkg?.name||p.record.name,startedAt:now()};p.jobId=jobId;jobs.set(jobId,job);
    void serializeState(await io.realpath(registry).catch(()=>registry),async()=>serializeState(await io.realpath(p.config||codexConfigPath(home,env)).catch(()=>p.config||codexConfigPath(home,env)),async()=>{
      const config=p.config||codexConfigPath(home,env),provider=p.provider||'codex';
      let touched=false;
      try{
        const native=await nativeFor(provider);if(native.version!==p.native.version||native.executable!==p.native.executable)throw fail('conflict','The managed agent executable changed after review.');
        if(await configSnapshot(config,io)!==p.configRevision)throw fail('conflict','Agent user settings changed after review.');
        if(json(await nativeRevisions(provider,home,env,io))!==json(p.nativeTracking||[]))throw fail('conflict','Native plugin registrations changed after review.');
        if(provider==='opencode'&&await openCodeDiscoveryDirectory({io,home,env})!==p.discoveryDir)throw fail('conflict','OpenCode discovery directory moved after review.');
        if(p.catalogRevision&&await configSnapshot(path.join(p.record.marketplaceDir,'.claude-plugin/marketplace.json'),io)!==p.catalogRevision)throw fail('conflict','The local marketplace changed after review.');
        const records=await readRecords();if(hash(json(records))!==p.recordsRevision)throw fail('conflict','Plugin installations changed after review.');
        await io.mkdir(path.dirname(config),{recursive:true,mode:0o700});
        if(p.record&&(['update','remove'].includes(p.operation)||p.operation==='state'&&p.enabled&&provider!=='codex'))await verifyInstalled(p.record);
        if(provider==='claude'&&['install','update'].includes(p.operation))await checkClaudeDependencies(native);
        const call=args=>command(native,args);
        if(provider==='opencode'){
          await applyOpenCode(p,records,()=>{touched=true;});
        }else if(provider!=='codex'){
          await applyOther(p,native,records,()=>{touched=true;});
        }else
        if(p.operation==='reconcile'){
          const seen=JSON.parse(await call(['plugin','list','--json']));
          if(!Array.isArray(seen.installed))throw fail('unavailable','Codex returned an incomplete inventory.');
          const present=seen.installed.some(r=>r.pluginId===p.record.nativeId&&r.installed);
          await writeRecords(present?records.map(r=>r.id===p.record.id?{...r,state:'installed'}:r):records.filter(r=>r.id!==p.record.id));
        }else if(p.operation==='state')await setEnabled(p.record.nativeId,p.enabled,p.configRevision);
        else if(p.operation==='remove'){
          await writeRecords(records.map(r=>r.id===p.record.id?{...r,state:'removing'}:r));touched=true;
          await call(['plugin','remove',p.record.nativeId,'--json']);
          const seen=JSON.parse(await call(['plugin','list','--json']));
          if(!Array.isArray(seen.installed)||seen.installed.some(r=>r.pluginId===p.record.nativeId&&r.installed))throw fail('conflict','Native removal could not be verified.');
          await writeRecords(records.filter(r=>r.id!==p.record.id));
        }else{
          const staged=await stage(p),nativeId=p.pkg.name+'@'+staged.marketplace;
          const record={id:p.record?.id||hash(nativeId).slice(0,32),nativeId,name:p.pkg.name,description:p.pkg.description,version:p.pkg.version,source:p.snapshot.source,prefix:p.pkg.prefix,commit:p.snapshot.commit,digest:p.pkg.digest,components:p.description.components,files:p.description.files.map(({text,...file})=>file),marketplace:staged.marketplace,directory:staged.directory,state:'installing',installedAt:now()};
          const next=records.filter(r=>r.id!==record.id);next.push(record);await writeRecords(next);touched=true;
          if(p.operation==='update'){
            await call(['plugin','remove',p.record.nativeId,'--json']);
            await call(['plugin','marketplace','remove',p.record.marketplace,'--json']);
          }
          await call(['plugin','marketplace','add',staged.directory,'--json']);
          await call(['plugin','add',nativeId,'--json']);
          const seen=JSON.parse(await call(['plugin','list','--json']));
          if(!Array.isArray(seen.installed)||!seen.installed.some(r=>r.pluginId===nativeId&&r.installed))throw fail('conflict','Native installation could not be verified.');
          if(p.restoreEnabled===false)await setEnabled(nativeId,false,await configSnapshot(config,io),config);
          record.state='installed';await writeRecords(next);
        }
        Object.assign(job,{state:'succeeded',finishedAt:now(),message:provider==='opencode'?'Saved. OpenCode may reload watched plugins immediately; restart it if the current service retains the previous module. Runtime loading is not verified.':'Saved. Start a new '+(pluginProviders.find(row=>row.id===provider)?.name||provider)+' session to use the current plugin settings.'});
      }catch(error){Object.assign(job,{state:'failed',finishedAt:now(),partial:touched,error:String(error.message||'Plugin operation failed.').slice(0,500)});}finally{busy=false;p.pkg=null;p.snapshot=null;p.description=null;p.changes=null;}
    }));
    return {ok:true,jobId};
  };
  const job = (id,owner='setup') => {const found=jobs.get(id);if(!found || found.owner!==owner)throw fail('missing','This job is not available after a restart. Refresh the inventory to inspect persisted state.');const {owner:secret,...result}=found;return result;};
  const discard = (id,owner='setup') => {const p=previews.get(id);if(p&&p.owner!==owner)throw fail('conflict','This review belongs to another session.');if(p?.jobId)throw fail('busy','This review already started an operation.');previews.delete(id);return {ok:true};};
  return {list,read,previewSource,prepare,apply,job,discard};
}
