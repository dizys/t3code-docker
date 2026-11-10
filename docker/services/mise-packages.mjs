// Mise owns every installed package. The image-owned adapter only verifies
// inputs and unpacks Debian packages without running their maintainer scripts.
// No user/project configuration, plugin, hook or environment enters root Mise.
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ServiceError, hash } from './store.mjs';
import { protectedDirectory, protectedPath, protectedWrite, downloadVerified, manifest } from './storage.mjs';
import { inspectTar } from './archive.mjs';
const exec = promisify(execFile);
const inside = (parent, file) => typeof file === 'string' && file.startsWith(parent + path.sep) && path.resolve(file) === file;
export function packageSpec(item, version, arch) {
  version = item.version || version;
  if (!/^[a-z0-9][a-z0-9.+-]{0,63}$/.test(item.name) || !/^[a-f0-9]{64}$/.test(item.sha256) || !/^[A-Za-z0-9][A-Za-z0-9_.:+~\-]{0,150}$/.test(version) || !['deb', 'tgz', 'binary'].includes(item.format) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || !['amd64', 'arm64'].includes(arch) || !/^https:\/\//.test(item.url)) throw new ServiceError('catalogue', 'This image has an invalid service package definition.');
  const key = `t3-service-${item.name}-${hash([version, arch, item.sha256])}`;
  // Mise interprets ':' as a version-request type and '~' as a selector.
  // Keep the exact Debian version in the receipt and expose an exact, safe
  // manager ID. The content-addressed tool name prevents alias collisions.
  const miseVersion = version.replaceAll(':', '-epoch-').replaceAll('~', '-pre-');
  return { ...item, version, miseVersion, arch, key, tool: 'http:' + key };
}
export function miseEnvironment(base, recipe) {
  return {
    PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: base + '/home', USER: 'root', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    MISE_DATA_DIR: base + '/data', MISE_CONFIG_DIR: base + '/config', MISE_STATE_DIR: base + '/state', MISE_CACHE_DIR: base + '/cache',
    MISE_GLOBAL_CONFIG_FILE: recipe, MISE_SYSTEM_CONFIG_FILE: base + '/empty.toml',
    MISE_OVERRIDE_CONFIG_FILENAMES: '.t3-services-unused.toml', MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: '.t3-services-unused-versions',
    MISE_CEILING_PATHS: base, MISE_TRUSTED_CONFIG_PATHS: base, MISE_NO_HOOKS: 'true', MISE_NO_ENV: 'true', MISE_ENV_SHELL_EXPAND: 'false',
    MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS: '', MISE_YES: 'true', MISE_COLOR: '0', MISE_ALWAYS_KEEP_DOWNLOAD: 'false',
  };
}
export function createMisePackages({ root, run = exec, fetchImpl = fetch, signal, storage = { directory: protectedDirectory, path: protectedPath, write: protectedWrite, manifest } }) {
  const base = path.join(root, 'mise');
  const recipeFor = spec => path.join(base, 'recipes', spec.key, 'mise.toml');
  const recipeText = (spec, url = spec.url) => `[tools.${JSON.stringify(spec.tool)}]\nversion = ${JSON.stringify(spec.miseVersion)}\nurl = ${JSON.stringify(url)}\nchecksum = ${JSON.stringify('sha256:' + spec.sha256)}\nshared_extraction = false\n`;
  const prepare = async spec => {
    for (const name of ['', 'home', 'data', 'config', 'state', 'cache', 'recipes', 'staging']) await storage.directory(path.join(base, name));
    for (const name of await fs.readdir(base + '/staging')) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      const abandoned = path.join(base, 'staging', name); await storage.path(abandoned);
      await fs.rm(abandoned, { recursive: true, force: true });
    }
    await storage.write(base + '/empty.toml', '');
    await storage.directory(path.dirname(recipeFor(spec)));
    await storage.write(recipeFor(spec), recipeText(spec));
  };
  const mise = async (spec, args) => {
    try { return await run('/usr/local/bin/mise', ['-C', base, ...args], { env: miseEnvironment(base, recipeFor(spec)), cwd: base, signal, timeout: 5 * 60_000, maxBuffer: 1024 * 1024 }); }
    catch (error) { if (signal?.aborted) throw error; throw new ServiceError('package-manager', 'Mise could not finish the service package operation. Saved settings and identities were kept. Check storage and connectivity before retrying.'); }
  };
  const location = async spec => {
    const { stdout } = await mise(spec, ['ls', '--installed', '--json']);
    const entry = JSON.parse(stdout)[spec.tool]?.find(item => item.version === spec.miseVersion && item.installed);
    if (!entry) return null;
    const directory = entry.install_path;
    if (!inside(base + '/data/installs', directory)) throw new ServiceError('artifact-unsafe', 'Mise returned a package outside protected service storage.');
    await storage.path(directory); return directory;
  };
  const verify = async component => {
    if (!inside(base + '/data/installs', component.path)) throw new ServiceError('artifact-unsafe', 'A service package leaves protected Mise storage.');
    await storage.path(component.path);
    await storage.path(component.path + '/receipt.json', { directory: false });
    const receipt = JSON.parse(await fs.readFile(component.path + '/receipt.json', 'utf8'));
    if (receipt.tool !== component.tool || receipt.version !== component.version || receipt.miseVersion !== component.miseVersion || receipt.sha256 !== component.sha256 || receipt.arch !== component.arch || receipt.manifest !== hash(await storage.manifest(component.path))) throw new ServiceError('artifact-unsafe', 'An installed Mise service package failed verification. It was kept for inspection.');
    return { ...receipt, path: component.path };
  };
  const remove = async component => {
    const spec = packageSpec(component, component.version, component.arch);
    await prepare(spec);
    if (!component.path) component = { ...component, path: await location(spec) };
    if (component.path && !inside(base + '/data/installs', component.path)) throw new ServiceError('artifact-unsafe', 'A service package leaves protected Mise storage.');
    // Repeating an interrupted uninstall is safe, including after Mise already
    // removed its installation but before the controller committed its result.
    try { if (component.path) { await storage.path(component.path); await mise(spec, ['uninstall', spec.tool + '@' + spec.miseVersion]); } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { if (component.path) { await fs.lstat(component.path); throw new ServiceError('package-manager', 'Mise did not remove the installed service package. Retry uninstall to finish cleanup.'); } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const parent of ['data/downloads', 'cache']) {
      for (const name of [spec.key, 'http-' + spec.key]) {
        const cached = path.join(base, parent, name);
        try { await storage.path(cached); await fs.rm(cached, { recursive: true, force: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    await fs.rm(path.dirname(recipeFor(spec)), { recursive: true, force: true });
  };
  const install = async (spec, { keepIncomplete = false } = {}) => {
    await prepare(spec);
    let directory = await location(spec);
    if (directory) {
      try { return await verify({ ...spec, path: directory }); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (keepIncomplete) throw new ServiceError('artifact-unsafe', 'An installed service still references this package. Its incomplete files were kept for inspection.');
        // No receipt means a staged package was interrupted before publication.
        await remove({ ...spec, path: directory }); await prepare(spec);
      }
    }
    const stage = path.join(base, 'staging', randomUUID());
    await storage.directory(stage);
    let server;
    try {
      const input = path.join(stage, 'download');
      await downloadVerified(spec, input, { fetchImpl, signal });
      // The bounded, checksum-verified input is served only on loopback. Mise
      // verifies it again and owns the installation, inventory and uninstall.
      // A suffix-free loopback URL keeps Mise in raw mode so root can inspect
      // archives before extraction (no MIME or redirect format inference).
      server = createServer((req, res) => {
        if (req.url !== '/download' || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-length': spec.bytes, 'content-type': 'application/octet-stream' });
        if (req.method === 'HEAD') res.end(); else createReadStream(input).on('error', () => res.destroy()).pipe(res);
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      await storage.write(recipeFor(spec), recipeText(spec, 'http://127.0.0.1:' + server.address().port + '/download'));
      await mise(spec, ['install', spec.tool + '@' + spec.miseVersion]);
      directory = await location(spec);
      if (!directory) throw new ServiceError('package-manager', 'Mise did not record the installed service package.');
      const payload = directory + '/download';
      await storage.path(payload, { directory: false });
      if (spec.format === 'deb') {
        const { stdout } = await run('/usr/bin/dpkg-deb', ['--fsys-tarfile', payload], { signal, timeout: 30000, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
        const members = inspectTar(stdout);
        if (members.some(member => member.path === 'download')) throw new ServiceError('archive-unsafe', 'The service package contains a reserved member.');
        await run('/usr/bin/dpkg-deb', ['-x', payload, directory], { signal, timeout: 30000 });
      } else if (spec.format === 'tgz') {
        const { stdout } = await run('/usr/bin/gzip', ['-dc', payload], { signal, timeout: 30000, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
        const members = inspectTar(stdout);
        for (const name of ['tailscale', 'tailscaled']) if (!members.some(member => member.path === spec.prefix + '/' + name && member.kind === '0')) throw new ServiceError('archive-unsafe', 'The connector archive is incomplete.');
        await run('/usr/bin/tar', ['-xzf', payload, '--strip-components=1', '--no-same-owner', '--no-same-permissions', '-C', directory, '--', spec.prefix + '/tailscale', spec.prefix + '/tailscaled'], { signal, timeout: 30000 });
      } else {
        await fs.rename(payload, path.join(directory, spec.name)); await fs.chmod(path.join(directory, spec.name), 0o755);
      }
      await fs.rm(payload, { force: true });
      const receipt = { ...spec, manager: 'mise', manifest: hash(await storage.manifest(directory, { durable: true })), installedAt: Date.now() };
      await storage.write(directory + '/receipt.json', JSON.stringify(receipt) + '\n', 0o644);
      return { ...receipt, path: directory };
    } finally {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      await storage.write(recipeFor(spec), recipeText(spec));
      await fs.rm(stage, { recursive: true, force: true });
    }
  };
  return { install, verify, remove };
}
