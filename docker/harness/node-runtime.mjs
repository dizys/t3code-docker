// Keep the image's Node tools usable when an installed but unselected mise
// runtime has left shims behind. Declared global/project versions still belong
// entirely to mise, including its missing-version and trust failures.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRunner} from './io.mjs';

export async function nodeRuntimeMode({command,env=process.env,cwd=process.cwd(),run=createRunner()}={}) {
  if (!['node','npm','npx'].includes(command)) throw new Error('Unknown Node runtime command');
  const tools=command==='node'?['node']:['node','npm'];
  const result=await run([env.T3_MISE_BIN||'/usr/local/bin/mise','-C',cwd,'ls','--json',...tools],{
    env:{...env,MISE_AUTO_INSTALL:'false',MISE_NOT_FOUND_SYSTEM_FALLBACK:'false'},cwd,timeoutMs:10_000,
  });
  if (result.error||result.code!==0) throw new Error('Could not read the selected Mise Node runtime');
  const listing=JSON.parse(result.stdout.trim());
  if (!listing||typeof listing!=='object') throw new Error('Invalid Mise Node runtime metadata');
  // Filtered `mise ls` returns a flat array in the pinned release. Accept the
  // keyed form too, used by its unfiltered listing and older releases.
  const groups=Array.isArray(listing)?[listing]:Object.values(listing);
  for (const entries of groups) {
    if (!Array.isArray(entries)) throw new Error('Invalid Mise Node runtime metadata');
    if (entries.some(entry=>!entry||typeof entry!=='object'||Array.isArray(entry))) throw new Error('Invalid Mise Node runtime metadata');
    // An explicit "system" selector requests the image tool too. Merely
    // having another Node installed must not turn it into a global selection.
    if (entries.some(entry=>entry.source&&entry.version!=='system'&&entry.requested_version!=='system')) return 'mise';
  }
  return 'system';
}

if (process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { console.log(await nodeRuntimeMode({command:process.argv[2]})); }
  catch {
    console.error('Could not read the selected Mise Node runtime. The configured runtime was not replaced.');
    process.exitCode=1;
  }
}
