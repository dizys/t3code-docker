// Read complete plugin packages as bytes. Preview never checks out or runs code.
import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSkillSource, runSourceGit, SOURCE_LIMITS } from '../skills/sources.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
export const hash = value => createHash('sha256').update(value).digest('hex');
export const safePath = name => typeof name === 'string' && name && !/[\\\x00-\x1f]/.test(name) && !path.posix.isAbsolute(name) && name.split('/').every(p => p && p !== '.' && p !== '..');
const manifests = { codex: ['.codex-plugin/plugin.json', 'plugin.json'], claude: ['.claude-plugin/plugin.json'], pi: ['package.json'], cursor: ['.cursor-plugin/plugin.json'], antigravity: ['.antigravity-plugin/plugin.json'], opencode: ['package.json'] };
const sourceManifests = provider => provider === 'all' ? [...new Set(Object.values(manifests).flat())] : manifests[provider];
const packageSupports = (file,agent) => {
  try { const pkg=JSON.parse(file.data.toString('utf8'));return agent==='pi'?Boolean(pkg.pi):Boolean((pkg.exports||typeof pkg.main==='string')&&['@opencode/plugin','@opencode-ai/plugin'].some(name=>pkg.dependencies?.[name]||pkg.peerDependencies?.[name])); } catch { return false; }
};
// Conventional integration files are detected as data; no module is imported.
const moduleRoot = name => /^(.*?)(?:\.opencode\/plugins\/|opencode\/)[^/]+\.(?:ts|js)$/.exec(name)?.[1];
const dependencyBlocks = files => {
  const file=files.find(f=>f.name==='package.json');if(!file)return [];
  let pkg;try{pkg=JSON.parse(file.data.toString('utf8'));}catch{throw fail('invalid','The package.json is invalid.');}
  return Object.keys(pkg.dependencies||{}).length||Object.keys(pkg.optionalDependencies||{}).length||Object.keys(pkg.scripts||{}).length?['Runtime package dependencies or install scripts require external management.']:[];
};
export const selectPluginProvider = (pkg, provider) => {
  const variant = pkg.variants?.[provider];
  if (pkg.variants && !variant) throw fail('unsupported', 'This package has no '+provider+' plugin manifest.');
  return variant ? {...pkg, ...variant} : pkg;
};
const matchesManifest = (name, manifest) => (name === manifest || name.endsWith('/' + manifest)) && (manifest !== 'plugin.json' || !name.split('/').slice(0,-1).some(part=>part.startsWith('.')));
const ignored = new Set(['.git', 'node_modules', '__pycache__', '.venv']);
export const treeDigest = files => hash(JSON.stringify(files.map(f => [f.name, f.mode, hash(f.data)]).sort((a,b) => a[0].localeCompare(b[0]))));

export async function readPluginSource(source, { home, provider = 'codex', env = process.env, run = runSourceGit } = {}) {
  if (provider !== 'all' && !Object.hasOwn(manifests, provider)) throw fail('unsupported', 'Choose a supported plugin package format.');
  if (typeof source === 'string' && /^https?:/.test(source) && /[?#]/.test(source)) throw fail('invalid', 'Use a repository URL without query parameters or fragments.');
  const parsed = parseSkillSource(source, home);
  if (parsed.filter) throw fail('invalid', 'Paste a repository or plugin folder, without a skill selector.');
  if (parsed.type !== 'local' && (parsed.type !== 'git' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(parsed.source))) throw fail('unsupported', 'Use a public GitHub repository or an absolute plugin folder in this container.');
  const files = []; let total = 0, entriesSeen = 0, cleanup = async () => {};
  const add = (name, data, mode) => {
    if (!safePath(name)) throw fail('invalid', 'The source contains an unsafe path.');
    total += data.length;
    if (files.length >= SOURCE_LIMITS.entries || data.length > SOURCE_LIMITS.fileBytes || total > SOURCE_LIMITS.bytes) throw fail('too_large', 'The plugin exceeds the source file or size limit.');
    files.push({ name, data, mode: mode & 0o100 ? 0o700 : 0o600 });
  };
  let commit = null;
  try {
    if (parsed.type === 'git') {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 't3-plugin-source-'));
      cleanup = () => fs.rm(temp, { recursive: true, force: true });
      const repo = path.join(temp, 'repo'), signal = AbortSignal.timeout(45000);
      // Public GitHub only: no inherited Git credential helpers, filters or redirects.
      const transportEnv = Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR','GIT_SSL_CAINFO'].filter(k=>env[k]).map(k=>[k,env[k]]));
      const gitEnv = { ...transportEnv, PATH: env.PATH || process.env.PATH, HOME: temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
      const git = async args => (await run('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', '-c', 'http.followRedirects=false', ...args], { env: gitEnv, directory: temp, signal, maxBuffer: SOURCE_LIMITS.fileBytes + 1 })).stdout;
      const sha = /^[a-f0-9]{40}$/.test(parsed.ref || '');
      await git(['clone', '--depth', '1', '--filter=blob:limit=4194305', '--no-checkout', ...(parsed.ref && !sha ? ['--branch', parsed.ref] : []), '--', parsed.source, repo]);
      if (sha) await git(['-C', repo, 'fetch', '--depth', '1', '--', 'origin', parsed.ref]);
      const ref = sha ? 'FETCH_HEAD' : 'HEAD';
      commit = (await git(['-C', repo, 'rev-parse', '--verify', ref + '^{commit}'])).toString().trim();
      const listing = (await git(['-C', repo, 'ls-tree', '-r', '-l', '-z', ref, ...(parsed.subpath ? ['--', parsed.subpath] : [])])).toString('utf8');
      const entries = listing.split('\0').filter(Boolean).map(line => {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(line);
        if (!match) throw fail('invalid', 'Unrecognized Git tree entry.');
        return { mode: match[1], type: match[2], object: match[3], size: Number(match[4]), name: match[5] };
      });
      const objects = new Map();
      const bytes = async e => {
        if (e.size > SOURCE_LIMITS.fileBytes) throw fail('too_large', 'A plugin file exceeds the size limit.');
        if (!objects.has(e.object)) objects.set(e.object, await git(['-C',repo,'cat-file','blob',e.object]));
        return objects.get(e.object);
      };
      // npm metadata is a Pi manifest only when it actually declares Pi resources.
      const roots = [];
      let candidates=0;
      for (const e of entries) for (const manifest of sourceManifests(provider)) {
        if (!matchesManifest(e.name,manifest)) continue;
        if (++candidates > 128) throw fail('too_large','The source has too many candidate plugin manifests.');
        if (manifest === 'package.json') {const file={data:await bytes(e)};if(!(provider==='all'?['pi','opencode'].some(agent=>packageSupports(file,agent)):packageSupports(file,provider)))continue;}
        const root=e.name.slice(0,-manifest.length); if (!roots.includes(root)) roots.push(root);
      }
      if(provider==='all'||provider==='opencode')for(const entry of entries){const root=moduleRoot(entry.name);if(root!==undefined&&!roots.includes(root))roots.push(root);}
      if (!roots.length) throw fail('missing', 'No compatible plugin manifest found. A standalone skill belongs in Skills.');
      const expand = async (e, name=e.name, chain=[]) => {
        if (!safePath(e.name) || !safePath(name) || e.type !== 'blob') throw fail('unsupported','Plugin snapshots cannot contain submodules or special files.');
        if (chain.length > 8 || chain.includes(e.name)) throw fail('unsupported','The plugin contains a cyclic or deeply nested link.');
        if (e.mode === '120000') {
          const link = (await bytes(e)).toString('utf8');
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(e.name),link));
          if (path.posix.isAbsolute(link) || !safePath(target)) throw fail('unsupported','A plugin link escapes its source repository.');
          const matches = entries.filter(item=>item.name===target || item.name.startsWith(target+'/'));
          if (!matches.length) throw fail('unsupported','A plugin link has no source files.');
          for (const item of matches) await expand(item,name+item.name.slice(target.length),[...chain,e.name]);
          return;
        }
        if (!['100644','100755'].includes(e.mode)) throw fail('unsupported','Unrecognized plugin file mode.');
        // Repository-contained links become ordinary files in the reviewed snapshot.
        add(name,await bytes(e),e.mode==='100755'?0o700:0o600);
      };
      for (const e of entries.filter(e => roots.some(root => e.name.startsWith(root)))) await expand(e);
    } else {
      const root = await fs.realpath(parsed.source);
      const walk = async (folder, relative = '', depth = 0) => {
        if (depth > SOURCE_LIMITS.depth) throw fail('too_large', 'The plugin folder is too deep.');
        for await (const e of await fs.opendir(folder)) {
          if (++entriesSeen > SOURCE_LIMITS.entries) throw fail('too_large', 'The source folder has too many entries.');
          if (ignored.has(e.name)) continue;
          const full = path.join(folder, e.name), name = relative ? relative + '/' + e.name : e.name;
          const stat = await fs.lstat(full);
          if (stat.isDirectory()) { await walk(full, name, depth + 1); continue; }
          if (!stat.isFile() || stat.isSymbolicLink()) throw fail('unsupported', 'Plugin snapshots cannot contain links or special files.');
          if (stat.size > SOURCE_LIMITS.fileBytes) throw fail('too_large', 'A plugin file exceeds the size limit.');
          const handle = await fs.open(full, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
          try {
            const before = await handle.stat();
            if (!before.isFile() || before.size > SOURCE_LIMITS.fileBytes) throw fail('conflict', 'The source changed while being read.');
            const buffer = Buffer.alloc(before.size + 1), {bytesRead} = await handle.read(buffer,0,buffer.length,0), after = await handle.stat();
            if (bytesRead !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await fs.realpath(full) !== full) throw fail('conflict', 'The source changed while being read.');
            add(name, buffer.subarray(0, bytesRead), before.mode);
          } finally { await handle.close(); }
        }
      };
      await walk(root);
    }
    const packages = [];
    for (const agent of provider === 'all' ? Object.keys(manifests) : [provider]) for (const file of files) for (const manifestName of manifests[agent]) {
      if (!matchesManifest(file.name,manifestName) || manifestName==='package.json'&&!packageSupports(file,agent)) continue;
      const prefix = file.name.slice(0, -manifestName.length);
      const existing = packages.find(p => p.prefix === prefix);
      if (existing?.variants[agent]) continue;
      let manifest;
      try { manifest = JSON.parse(file.data.toString('utf8')); } catch { throw fail('invalid', 'A plugin manifest contains invalid JSON.'); }
      const namePattern=agent==='opencode'?/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/:/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
      if (!manifest || typeof manifest !== 'object' || !namePattern.test(manifest.name || '') || manifest.name.length > (agent==='opencode'?214:64)) throw fail('invalid', 'A plugin manifest needs a valid package name.');
      const packageFiles = files.filter(f => f.name.startsWith(prefix)).map(f => ({...f,name:f.name.slice(prefix.length)}));
      const blocked = dependencyBlocks(packageFiles);
      if (manifest.version !== undefined && (typeof manifest.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$/.test(manifest.version))) blocked.push('The plugin version is not a portable release identifier.');
      if (manifest.dependencies?.length || manifest.dependencies && typeof manifest.dependencies === 'object' && Object.keys(manifest.dependencies).length) blocked.push('Plugin dependencies need native resolution outside Setup.');
      const refsFor = agent === 'pi' ? manifest.pi : manifest;
      if (!refsFor || typeof refsFor !== 'object' || Array.isArray(refsFor)) blocked.push('The Pi resource manifest must be an object.');
      for (const field of agent === 'pi' ? ['extensions','skills','prompts','themes'] : ['hooks','skills','agents','commands','mcpServers','apps','rules']) {
        const refs = typeof refsFor?.[field] === 'string' ? [refsFor[field]] : Array.isArray(refsFor?.[field]) ? refsFor[field].filter(v=>typeof v==='string') : [];
        for (const ref of refs) {
          const relative=ref.replace(/^\.\//,'').replace(/\/$/,'');
          if(!safePath(relative)||!packageFiles.some(f=>f.name===relative||f.name.startsWith(relative+'/'))) blocked.push('The '+field+' reference is outside or missing from the reviewed package. Globs require native management.');
        }
      }
      const allowed = new Set(['pi','opencode'].includes(agent) ? ['name','version','private','description','keywords','license','repository','homepage','author','pi','peerDependencies','type','main','exports','files','engines','devDependencies'] : ['name','version','description','author','repository','homepage','license','keywords','displayName','skills','hooks','mcpServers','apps','interface','commands','agents','rules']);
      if (Object.keys(manifest).some(k => !allowed.has(k))) blocked.push('This manifest has fields whose execution behavior Setup cannot yet verify.');
      if (agent === 'pi' && ['extensions','skills','prompts','themes'].some(key=>refsFor?.[key]!==undefined&&(!Array.isArray(refsFor[key])||refsFor[key].some(value=>typeof value!=='string')))) blocked.push('Pi resource declarations must be arrays of paths.');
      if (agent === 'pi' && Object.keys(refsFor || {}).some(k => !['extensions','skills','prompts','themes'].includes(k))) blocked.push('This Pi package has unknown resource fields.');
      const variant={name:manifest.name,description:String(manifest.description || '').slice(0,1500),version:String(manifest.version || 'local').slice(0,128),manifestPath:manifestName,manifest,blocked,...(['cursor','antigravity','opencode'].includes(agent)?{experimental:true}:{}),...(agent==='opencode'?{format:'npm-package',entrypoints:[]}:{} )};
      if (existing) existing.variants[agent]=variant;
      else packages.push({...variant,prefix,files:packageFiles,digest:treeDigest(packageFiles),variants:{[agent]:variant}});
    }
    if(provider==='all'||provider==='opencode'){
      const roots=new Set(files.map(f=>moduleRoot(f.name)).filter(root=>root!==undefined));
      for(const prefix of roots){
        const existing=packages.find(pkg=>pkg.prefix===prefix);
        const packageFiles=files.filter(f=>f.name.startsWith(prefix)).map(f=>({...f,name:f.name.slice(prefix.length)}));
        const entrypoints=files.filter(f=>moduleRoot(f.name)===prefix).map(f=>f.name.slice(prefix.length));
        const fallback=path.posix.basename(entrypoints[0]).replace(/\.(?:ts|js)$/,'').replace(/[^a-z0-9-]/gi,'-').toLowerCase();
        const name=existing?.name||fallback,version=existing?.version||'local',description=existing?.description||'Local OpenCode integration module.';
        if(!existing&&(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)||name.length>64))throw fail('invalid','The OpenCode module needs a portable package name.');
        const variant={name,version,description,manifestPath:entrypoints[0],manifest:{name,version,description},format:'local-module',entrypoints,experimental:true,blocked:dependencyBlocks(packageFiles)};
        if(existing)existing.variants.opencode=variant;
        else packages.push({...variant,prefix,files:packageFiles,digest:treeDigest(packageFiles),variants:{opencode:variant}});
      }
    }
    // Grok reads the Claude plugin format; this records a compatible format,
    // without claiming that every feature works or that Setup can install it.
    if(provider==='all')for(const pkg of packages)if(pkg.variants.claude)pkg.variants.grok={...pkg.variants.claude,experimental:true,format:'claude-compatible'};
    if (!packages.length) throw fail('missing', 'No compatible plugin manifest found. A standalone skill belongs in Skills.');
    return { source, provider, commit, packages };
  } finally { await cleanup(); }
}
