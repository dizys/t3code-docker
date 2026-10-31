// Files has the same authority as t3's terminal, never a workspace jail and
// never an elevated process. Classification supplies explicit guard rails;
// the operating system remains the source of read/write permissions.
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import guarded from './guarded-places.json' with { type: 'json' };

export class FilesError extends Error {
  constructor(code, error, fields = {}) { super(error); this.name = 'FilesError'; this.code = code; this.fields = fields; }
}
export const fail = (code, error, fields) => { throw new FilesError(code, error, fields); };
export const inside = (root, candidate) => candidate === root || candidate.startsWith(root === '/' ? '/' : root + path.sep);
export function normalizePath(value) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value.includes('\0') || !path.isAbsolute(value)) fail('invalid', 'Use an absolute path.');
  if (Buffer.byteLength(value) > 4096) fail('invalid', 'That path is too long. Open a parent folder first.');
  return path.resolve(value);
}
export function validateName(value) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value === '.' || value === '..') fail('invalid', 'Enter a name.');
  if (value.includes('/') || value.includes('\0')) fail('invalid', 'Names can’t contain / or a null character.');
  if (Buffer.byteLength(value) > 255) fail('invalid', 'That name is too long.');
  return value;
}
export const displayPath = (value, home) => inside(home, value) ? '~' + (value === home ? '' : '/' + path.relative(home, value)) : value;
export const glob = value => new RegExp('^' + value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
const secrets = guarded.secretFiles.patterns.map(glob), except = guarded.secretFiles.except.map(glob);
export const isSecret = name => !except.some(rule => rule.test(name)) && secrets.some(rule => rule.test(name));

/** Canonical parent + entry name preserves the identity of a final symlink.
 * Missing suffixes can be classified before creating them; unreadable parents
 * cannot silently become an unguarded path. */
export async function canonicalEntry(value, io = fs) {
  const absolute = normalizePath(value);
  if (absolute === '/') return '/';
  const suffix = [path.basename(absolute)];
  let parent = path.dirname(absolute);
  while (true) {
    try { return path.join(await io.realpath(parent), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (parent === '/') throw error;
      suffix.unshift(path.basename(parent)); parent = path.dirname(parent);
    }
  }
}

export function createPathPolicy({ home = os.homedir(), workspace = '/workspace', stateDir, env = process.env, io = fs, storage } = {}) {
  home = normalizePath(home); workspace = normalizePath(workspace);
  const configured = (key, fallback) => path.resolve(home, env[key] || fallback);
  const t3Root = configured('T3CODE_HOME', '.t3');
  const configHome = configured('XDG_CONFIG_HOME', '.config'), dataHome = configured('XDG_DATA_HOME', '.local/share');
  const miseData = configured('MISE_DATA_DIR', path.join(dataHome, 'mise'));
  const miseState = configured('MISE_STATE_DIR', '.local/state/mise');
  const cacheHome = configured('XDG_CACHE_HOME', '.cache');
  const definitions = [
    { root: t3Root, tag: 'T3 Code and Setup', pages: ['agents', 'updates'], title: 'Managed by T3 Code and Setup', body: guarded.managed[0].banner.body },
    { root: miseData, tag: 'Agents and toolchains', pages: ['toolchains', 'agents'], title: 'Managed by Toolchains and Agents', body: guarded.managed[1].banner.body },
    { root: miseState, tag: 'Agents and toolchains', pages: ['toolchains'], title: 'Managed by Toolchains', body: guarded.managed[2].banner.body },
    ...[...new Set([cacheHome, path.join(home, '.npm'), configured('GOMODCACHE', 'go/pkg/mod'), configured('GOCACHE', path.join(cacheHome, 'go-build')),
      configured('BUN_INSTALL', '.bun') + '/install/cache', configured('NPM_CONFIG_CACHE', env.npm_config_cache || '.npm'),
      configured('UV_CACHE_DIR', path.join(cacheHome, 'uv')), configured('DENO_DIR', path.join(cacheHome, 'deno')), configured('MISE_CACHE_DIR', path.join(cacheHome, 'mise'))])]
      .map(root => ({ root, tag: 'Caches', pages: ['storage'], title: 'Caches managed in Storage', body: guarded.managed[3].banner.body })),
  ];
  const piAgentDir = env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, () => home);
  const profileFiles = [
    ['Codex', configured('CODEX_HOME', '.codex'), 'auth.json'],
    ['Claude Code', configured('CLAUDE_CONFIG_DIR', '.claude'), '.credentials.json'],
    ['Claude Code', home, '.claude.json'],
    ['OpenCode', path.join(dataHome, 'opencode'), 'auth.json'],
    ['GitHub CLI', configured('GH_CONFIG_DIR', path.join(configHome, 'gh')), 'hosts.yml'],
    ['Grok Build', path.join(home, '.grok'), 'auth.json'],
    ['Cursor', path.join(home, '.cursor'), 'cli-config.json'],
    ['Muse Code', path.join(configHome, 'muse'), 'auth.json'],
    ['Pi', path.join(home, '.pi'), 'agent/auth.json'],
    // A custom Pi profile does not remove credentials saved in the default one.
    ...(piAgentDir ? [['Pi', path.resolve(home, piAgentDir), 'auth.json']] : []),
  ].map(([name, root, file]) => ({ name, root, file: path.join(root, file) }));
  const keyRoots = [...guarded.keys.paths.map(value => path.join(home, value.slice(2))), path.join(t3Root, 'server-credentials')];
  const location = async value => {
    try { return await io.realpath(value); }
    catch { try { return await canonicalEntry(value, io); } catch { return path.resolve(value); } }
  };
  const resolveRule = async rule => ({ ...rule, root: await location(rule.root),
    ...(rule.file ? { file: await location(rule.file) } : {}) });
  let roots, refreshedAt = 0, refreshing;
  // Resolve configured aliases once per listing, rather than once per row.
  // Mutations request a fresh policy so retargeting an alias never bypasses it.
  const refresh = (fresh = false) => {
    if (!fresh && roots && Date.now() - refreshedAt < 30_000) return Promise.resolve();
    return refreshing ??= (async () => {
      const cacheRules = (storage?.snapshot?.().categories || []).filter(row => row.kind === 'cache' && row.path && path.isAbsolute(row.path));
      const extra = cacheRules.map(row => ({ root: row.path, tag: 'Caches', pages: ['storage'], title: 'Caches managed in Storage', body: guarded.managed[3].banner.body }));
      const [managed, signIns, keys] = await Promise.all([Promise.all([...definitions, ...extra].map(resolveRule)),
        Promise.all(profileFiles.map(resolveRule)), Promise.all(keyRoots.map(location))]);
      roots = { managed, signIns, keys, stateRoot: managed[0].root }; refreshedAt = Date.now();
    })().finally(() => { refreshing = null; });
  };
  const ready = refresh();
  const classify = async value => {
    await refresh();
    const requested = normalizePath(value), entry = await canonicalEntry(requested, io);
    let target = entry, linked = false;
    try {
      linked = (await io.lstat(entry)).isSymbolicLink();
      if (linked) target = await io.realpath(entry);
    } catch (error) { if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error; }
    const managed = roots.managed
      .filter(rule => inside(rule.root, entry) || inside(rule.root, target)).sort((a, b) => b.root.length - a.root.length)[0] || null;
    const ancestor = !managed ? roots.managed.find(rule => rule.root !== entry && inside(entry, rule.root)) || null : null;
    const signIns = roots.signIns.filter(rule => [entry, target].some(candidate => candidate === rule.file || candidate === rule.root
      || (candidate !== home && inside(candidate, rule.file) && (inside(roots.stateRoot, candidate) || inside(rule.root, candidate))))).map(rule => rule.name);
    const secret = isSecret(path.basename(entry)) || isSecret(path.basename(target));
    const keys = roots.keys.some(root => [entry, target].some(candidate => inside(root, candidate))) && !except.some(rule => rule.test(path.basename(entry)));
    const child = guarded.managed[0].children.find(rule => [entry, target].some(candidate => inside(path.join(roots.stateRoot, rule.name), candidate)));
    const tags = [...(managed || ancestor ? ['managed'] : []), ...(signIns.length ? ['sign-in'] : []), ...(keys ? ['keys'] : []), ...(secret ? ['secret'] : []), ...(linked ? ['link'] : [])];
    return { path: entry, requested, target, linked, display: displayPath(entry, home), managed, ancestor,
      signIns: [...new Set(signIns)], keys, secret, tags, what: child?.what || managed?.tag || ancestor?.tag || null };
  };
  return { home, workspace, stateRoot: t3Root, stateDir: normalizePath(stateDir || path.join(t3Root, 'setup')), ready, refresh, classify,
    managedRoots: async () => { await refresh(); return roots.managed.map(({ root, tag }) => ({ root, tag })); },
    display: value => displayPath(value, home), entry: value => canonicalEntry(value, io) };
}
