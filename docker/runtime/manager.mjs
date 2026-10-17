import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CHANNELS, channelOf, exactVersion, databaseName, validScopes, runtimePaths, readJson, writeJson, readSelection, selectedRuntime, operationBusy } from "./state.mjs";
// The checkout and image deliberately have different infrastructure prefixes.
const localHarness = new URL("../harness/", import.meta.url);
const harnessBase = existsSync(new URL("version.mjs", localHarness)) ? localHarness : new URL("file:///opt/t3-harness/");
const [{ compareVersions }, { acquireLock, liveHolder }, { createFs }] = await Promise.all([
  import(new URL("version.mjs", harnessBase)), import(new URL("lock.mjs", harnessBase)), import(new URL("io.mjs", harnessBase)),
]);
export { databaseBusy, operationBusy } from "./state.mjs";

const execute = promisify(execFile);
const REGISTRY = "https://registry.npmjs.org";
const LIMIT = 300 * 1024 * 1024;
export const platformPackage = (arch = process.arch) => {
  if (!["x64", "arm64"].includes(arch) || process.platform !== "linux") throw new Error("T3 Code updates support Linux amd64 and arm64.");
  return `@t3code/t3-linux-${arch}`;
};
const errorText = (error) => String(error?.message ?? error).slice(0, 400);
export const executableVersion = (output) => /^(?:t3\s+)?v?(\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?)$/i.exec(String(output).trim())?.[1] ?? null;

/** Ask the release's own CLI which data store it opens, in a disposable home. */
export async function discoverRuntime(binary, paths, { run = execute, env = process.env } = {}) {
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  const probe = await fs.mkdtemp(path.join(paths.root, ".database-probe-"));
  try {
    const issued = await run(binary, ["auth", "session", "issue", "--ttl", "1m", "--subject", "t3-container-probe", "--json"], { env: { ...env, T3CODE_HOME: probe }, timeout: 30_000 });
    const session = JSON.parse(issued.stdout.slice(issued.stdout.indexOf("{")));
    const scopes = session.permissions ?? session.scopes;
    if (!validScopes(scopes) || !scopes.length) throw new Error("Could not identify this release's supported device permissions safely.");
    const names = (await fs.readdir(path.join(probe, "userdata"))).filter(databaseName);
    if (names.length !== 1) throw new Error("Could not identify this release's authentication database safely.");
    return { database: names[0], scopes };
  } finally { await fs.rm(probe, { recursive: true, force: true }); }
}

export async function packageRelease(channel, { fetcher = fetch, arch = process.arch } = {}) {
  if (!CHANNELS.includes(channel)) throw new Error("Choose Stable or Nightly.");
  const name = platformPackage(arch);
  const response = await fetcher(`${REGISTRY}/${name}/${channel === "stable" ? "latest" : "nightly"}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Could not check ${channel} releases (HTTP ${response.status}).`);
  const pkg = await response.json();
  if (pkg.name !== name || !exactVersion(pkg.version) || channelOf(pkg.version) !== channel) throw new Error(`The registry did not return a valid ${channel} release.`);
  const url = new URL(pkg.dist?.tarball ?? "");
  if (url.origin !== REGISTRY || url.username || url.password || !/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.dist?.integrity ?? "")) throw new Error("The release has no supported download integrity information.");
  return { version: pkg.version, name, url: url.href, integrity: pkg.dist.integrity, bytes: pkg.dist.unpackedSize ?? null };
}

/** Only normal files/directories under npm's package root may be extracted. */
export function validateArchive(names, types) {
  for (const name of names.trim().split("\n")) {
    if (!name.startsWith("package/") || name.split("/").includes("..") || name.includes("\\")) throw new Error("The release archive contains an unsafe path.");
  }
  for (const row of types.trim().split("\n")) if (!/^[d-]/.test(row)) throw new Error("The release archive contains unsupported links or entries.");
}

export async function installRelease(paths, release, { fetcher = fetch, run = execute, env = process.env, bridge = "/usr/local/share/t3-client/setup-bridge.js", onPhase = async () => {} } = {}) {
  const destination = path.join(paths.versions, release.version);
  const preflight = async (binary) => {
    const version = await run(binary, ["--version"], { timeout: 30_000 });
    if (executableVersion(version.stdout) !== release.version) throw new Error(`The executable reports a different T3 Code version (${version.stdout.trim().slice(0, 160)}).`);
    const result = await run(binary, ["__service-preflight", "--database-path", path.join(paths.home, "userdata/statev2.sqlite"), "--launcher-protocol", "3"], { timeout: 30_000 });
    const ready = JSON.parse(result.stdout.trim());
    if (ready.status !== "ready" || ready.version !== release.version || ready.launcherProtocol !== 3) throw new Error(ready.reason || "This release requires a newer container supervisor.");
  };
  const cached = await readJson(path.join(destination, ".installed.json"));
  if (cached?.version === release.version) {
    await preflight(path.join(destination, "t3"));
    if (!cached.database || !validScopes(cached.scopes)) await writeJson(path.join(destination, ".installed.json"), { ...cached, ...await discoverRuntime(path.join(destination, "t3"), paths, { run, env }) });
    return destination;
  }
  await fs.mkdir(paths.versions, { recursive: true, mode: 0o700 });
  const stage = await fs.mkdtemp(path.join(paths.versions, ".staging-"));
  const archive = path.join(stage, "download.tgz");
  const unpacked = path.join(stage, "package");
  try {
    const space = await fs.statfs(paths.root);
    if (release.bytes && Number(space.bavail) * Number(space.bsize) < release.bytes * 2 + LIMIT) throw new Error("There is not enough free space to stage this T3 Code release.");
    await onPhase("downloading");
    const response = await fetcher(release.url, { redirect: "error", signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Could not download T3 Code (HTTP ${response.status}).`);
    const hash = createHash("sha512");
    let bytes = 0;
    const file = await fs.open(archive, "wx", 0o600);
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > LIMIT) throw new Error("The release download exceeded the supported size.");
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      await file.sync();
    } finally { await file.close(); }
    const expected = Buffer.from(release.integrity.slice(7), "base64");
    const actual = hash.digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("T3 Code's download failed its integrity check. The running version was kept.");
    await onPhase("verifying");
    const options = { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 };
    const names = await run("/usr/bin/tar", ["-tzf", archive], options);
    const types = await run("/usr/bin/tar", ["-tvzf", archive], options);
    validateArchive(names.stdout, types.stdout);
    await fs.mkdir(unpacked, { mode: 0o700 });
    await run("/usr/bin/tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "--strip-components=1", "-C", unpacked], options);
    const pkg = await readJson(path.join(unpacked, "package.json"));
    if (pkg?.name !== release.name || pkg.version !== release.version) throw new Error("The downloaded package does not match the requested release.");
    const binary = path.join(unpacked, "t3");
    await fs.chmod(binary, 0o755);
    await preflight(binary);
    const shellPath = path.join(unpacked, "client/index.html");
    const shell = await fs.readFile(shellPath, "utf8");
    const script = await fs.readFile(bridge, "utf8");
    if (!shell.includes("</body>") || !script.includes("data-t3-setup-entry") || /<\/script/i.test(script)) throw new Error("This release cannot preserve the Setup entry. The running version was kept.");
    await fs.writeFile(shellPath, shell.replace("</body>", `<script data-t3-setup-bridge>\n${script}\n</script>\n</body>`));
    const capabilities = await discoverRuntime(binary, paths, { run, env });
    await writeJson(path.join(unpacked, ".installed.json"), { version: release.version, integrity: release.integrity, package: release.name, ...capabilities });
    await fs.rename(unpacked, destination);
    return destination;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

export function createRuntimeManager({ env = process.env, fetcher = fetch, install = installRelease, supervised = () => false, restart = async () => {}, onEvent = () => {} } = {}) {
  const paths = runtimePaths(env);
  const lockContext = { fs: createFs(), lockPath: path.join(paths.root, "update.lock"), pid: process.pid, now: Date.now, lockStaleMs: 15 * 60_000 };
  let checking = null;
  let releases = null;
  let preparing = false;
  let checkErrors = {};
  let loading = null;
  const load = () => (loading ??= (async () => {
    releases = await readJson(paths.releases, { checkedAt: null, channels: {} }).catch(() => ({ checkedAt: null, channels: {} }));
    releases.channelCheckedAt ??= {};
    checkErrors = releases.errors ?? {};
  })());
  const check = async ({ channel } = {}) => {
    if (channel !== undefined && !CHANNELS.includes(channel)) throw new Error("Choose Stable or Nightly.");
    checking ??= (async () => {
      await load();
      const results = await Promise.allSettled(CHANNELS.map((channel) => packageRelease(channel, { fetcher })));
      checkErrors = {};
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          releases.channels[CHANNELS[index]] = result.value;
          releases.channelCheckedAt[CHANNELS[index]] = Date.now();
        } else checkErrors[CHANNELS[index]] = errorText(result.reason);
      });
      releases.errors = checkErrors;
      releases.checkedAt = Date.now();
      await writeJson(paths.releases, releases);
      return { ...releases, errors: checkErrors };
    })().finally(() => { checking = null; });
    const result = await checking;
    channel ??= (await readSelection(paths)).channel;
    return { ...result, error: result.errors[channel] ?? null };
  };
  const status = async () => {
    await load();
    const selection = await readSelection(paths);
    const runtime = await selectedRuntime(paths, selection);
    let operation = await readJson(paths.operation);
    if (operationBusy(operation) && !preparing && !await liveHolder(lockContext) && !await readJson(paths.request)) {
      operation = selection.updateId === operation.id
        ? { ...operation, phase: "succeeded", finishedAt: Date.now() }
        : { ...operation, phase: "interrupted", error: "Setup stopped during the download. The running version was kept; retry when ready." };
      await writeJson(paths.operation, operation);
    }
    const hasHistory = (name) => fs.access(path.join(paths.home, "userdata", name)).then(() => true, () => false);
    const separateHistory = await hasHistory("state.sqlite") && await hasHistory("statev2.sqlite");
    return { ...selection, version: runtime.version, bundled: runtime.bundled, separateHistory, releases: releases.channels, checkedAt: releases.channelCheckedAt[selection.channel] ?? null, checking: Boolean(checking), checkError: checkErrors[selection.channel] ?? null, operation, supported: supervised() };
  };
  const update = async ({ channel, version } = {}) => {
    if (!CHANNELS.includes(channel) || !exactVersion(version) || channelOf(version) !== channel) return { http: 400, body: { ok: false, error: "Choose a published Stable or Nightly release." } };
    if (!supervised()) return { http: 409, body: { ok: false, error: "This T3 Code process is not managed by the container supervisor." } };
    if (preparing) return { http: 409, body: { ok: false, error: "A T3 Code update is already in progress." } };
    // Reserve synchronously, before filesystem reads can yield to another request.
    preparing = true;
    let operation;
    let lock;
    try {
      lock = await acquireLock(lockContext, { id: "t3", operation: "update" });
      if (!lock.acquired) throw new Error(lock.error || "A T3 Code update is already in progress.");
      if (await readJson(paths.request)) throw new Error("A T3 Code update is already in progress.");
      const selection = await readSelection(paths);
      const current = await selectedRuntime(paths, selection);
      if (!exactVersion(current.version)) throw new Error("This bundled T3 Code build cannot be upgraded in place. Use a Stable or Nightly container build first.");
      if (channel === selection.channel && compareVersions(version, current.version) < 0) throw new Error("Update will not downgrade the current T3 Code version.");
      if (version === current.version && channel === selection.channel) { preparing = false; await lock.release(); return { http: 200, body: { ok: true, current: true } }; }
      operation = { id: randomUUID(), phase: "checking", channel, version, fromVersion: current.version, startedAt: Date.now() };
      await writeJson(paths.operation, operation);
      const phase = async (name) => { operation.phase = name; await writeJson(paths.operation, operation); };
      void (async () => {
        try {
          const release = await packageRelease(channel, { fetcher });
          if (release.version !== version) throw new Error("A newer release was published. Check for updates again before installing.");
          const directory = await install(paths, release, { fetcher, env, bridge: env.T3_SETUP_BRIDGE, onPhase: phase });
          const installed = await readJson(path.join(directory, ".installed.json"));
          const previous = current.database && current.scopes ? current : await discoverRuntime(current.binary, paths, { env });
          if (!databaseName(installed.database) || !validScopes(installed.scopes)) throw new Error("The staged release has no valid authentication capabilities.");
          operation = { ...operation, fromDatabase: previous.database, targetDatabase: installed.database, fromScopes: previous.scopes, targetScopes: installed.scopes };
          if (!supervised()) throw new Error("T3 Code stopped while the update was downloading. The saved selection was kept.");
          await phase("stopping");
          await writeJson(paths.request, { ...operation, previous: selection });
          await restart();
          onEvent("t3.updating", `Updating T3 Code to ${version}`);
        } catch (error) {
          await fs.rm(paths.request, { force: true });
          operation = { ...operation, phase: "failed", error: errorText(error), finishedAt: Date.now() };
          await writeJson(paths.operation, operation);
        } finally { preparing = false; await lock.release(); }
      })().catch((error) => console.error("[t3-update]", errorText(error)));
      return { http: 202, body: { ok: true, operation } };
    } catch (error) { preparing = false; await lock?.release?.(); return { http: 409, body: { ok: false, error: errorText(error) } }; }
  };
  return { paths, status, check, update };
}
