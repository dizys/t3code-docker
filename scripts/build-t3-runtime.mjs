// Build the local server patch against the exact upstream release. Its verified
// CLI archive supplies the matching client, native modules and resource monitor.
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify, parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { releaseForVersion, unpackRelease, executableVersion } from "../docker/runtime/releases.mjs";
import { releaseForVersion as patchedReleaseForVersion } from "../docker/runtime/distribution.mjs";
import { exactVersion } from "../docker/runtime/state.mjs";
import { PATCH_REVISION } from "../docker/runtime/distribution-spec.mjs";
import { files, applySourcePatches } from "../docker/runtime/patches/index.mjs";

const execute = promisify(execFile);
export function executableBuildPlan(arch, { platform = process.platform, hostArch = process.arch } = {}) {
  if (!["x64", "arm64"].includes(arch)) throw new Error("Choose a supported Linux runtime architecture.");
  // Upstream's native ARM64 path injects SEA into the host binary so it works
  // on 16/64 KiB page kernels. An explicit --target bypasses that workaround.
  const nativeArm = platform === "linux" && hostArch === "arm64" && arch === "arm64";
  return {
    args: ["pnpm", "exec", "node", "apps/server/scripts/cli.ts", "build-exe", ...(nativeArm ? [] : ["--target", `linux-${arch}`])],
    output: nativeArm ? "t3" : `t3-linux-${arch}`,
  };
}

// These values are explicitly public in upstream's checked-in .env.example.
// Do not build from the operator's environment or copy unrelated env fields.
export function publicBuildEnvironment(example) {
  const parsed = parseEnv(example), result = {};
  for (const name of ["T3CODE_CLERK_PUBLISHABLE_KEY", "T3CODE_CLERK_JWT_TEMPLATE", "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID", "T3CODE_RELAY_URL"]) {
    const value = parsed[name]?.trim();
    if (!value || value.length > 2048) throw new Error(`The release's public defaults are missing or invalid: ${name}.`);
    result[name] = value;
  }
  let relay;
  try { relay = new URL(result.T3CODE_RELAY_URL); }
  catch { throw new Error("The release's public Connect defaults are invalid."); }
  if (relay.protocol !== "https:" || relay.username || relay.password || relay.pathname !== "/" || relay.search || relay.hash
    || !/^pk_(?:live|test)_[A-Za-z0-9+/=_-]+$/.test(result.T3CODE_CLERK_PUBLISHABLE_KEY)
    || !/^[A-Za-z0-9_-]+$/.test(result.T3CODE_CLERK_JWT_TEMPLATE)
    || !/^[A-Za-z0-9_-]+$/.test(result.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID)) throw new Error("The release's public Connect defaults are invalid.");
  return result;
}

export async function buildRuntime(version, arch, destination, { run = execute, fetcher = fetch, source = null } = {}) {
  if (!exactVersion(version) || !["x64", "arm64"].includes(arch) || !path.isAbsolute(destination)) throw new Error("Choose an exact T3 release, a supported architecture and an absolute output directory.");
  if (Number(process.versions.node.split(".")[0]) < 26) throw new Error("Building the patched T3 runtime requires Node 26 or newer.");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const stage = await fs.mkdtemp(path.join(path.dirname(destination), ".native-build-"));
  const options = { timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_engine_strict: "false" } };
  try {
    if (!source) {
      try {
        const published = await patchedReleaseForVersion(version, { arch, fetcher });
        const unpacked = await unpackRelease(stage, published, { fetcher, run });
        const manifest = JSON.parse(await fs.readFile(path.join(unpacked, "package.json"), "utf8"));
        await fs.rename(unpacked, destination);
        return manifest;
      } catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
    }
    console.error(`[t3-runtime] verifying upstream ${version} (${arch})`);
    const release = await releaseForVersion(version, { arch, fetcher });
    const unpacked = await unpackRelease(stage, release, { fetcher, run });
    const checkout = source ? path.resolve(source) : path.join(stage, "source");
    if (!source) {
      console.error("[t3-runtime] checking out the exact upstream source tag");
      await run("git", ["clone", "--filter=blob:none", "--depth", "1", "--sparse", "--branch", `v${version}`, "https://github.com/pingdotgg/t3code.git", checkout], options);
      await run("git", ["sparse-checkout", "set", "apps/server", "apps/web", "apps/desktop", "apps/mobile/modules", "apps/mobile/deps", "packages", "scripts", "patches", "oxlint-plugin-t3code", "infra"], { ...options, cwd: checkout });
    }
    const command = (program, args, extra = {}) => run(program, args, { ...options, cwd: checkout, ...extra });
    const commit = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
    const tag = (await command("git", ["rev-parse", `v${version}^{commit}`])).stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(commit) || commit !== tag || (await command("git", ["status", "--porcelain"])).stdout.trim()) throw new Error("Build from a clean checkout of the exact upstream release tag.");
    for (const file of [".env", ".env.local"]) {
      try { await fs.access(path.join(checkout, file)); throw new Error("Native builds require a checkout without local environment files; use the release's checked-in public defaults."); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const publicEnvironment = publicBuildEnvironment(await fs.readFile(path.join(checkout, ".env.example"), "utf8"));
    const buildEnvironment = { ...Object.fromEntries(Object.entries(options.env).filter(([name]) => !/^(?:T3CODE_|VITE_|EXPO_PUBLIC_)/.test(name))), ...publicEnvironment };
    const original = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await fs.readFile(path.join(checkout, file), "utf8")])));
    const patched = applySourcePatches(original);
    for (const [file, text] of Object.entries(patched)) await fs.writeFile(path.join(checkout, file), text);
    console.error("[t3-runtime] installing locked build dependencies");
    await command("corepack", ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]);
    for (const file of ["apps/server/package.json", "apps/web/package.json", "apps/desktop/package.json", "packages/contracts/package.json"]) {
      const name = path.join(checkout, file), pkg = JSON.parse(await fs.readFile(name, "utf8"));
      await fs.writeFile(name, JSON.stringify({ ...pkg, version }, null, 2) + "\n");
    }
    console.error("[t3-runtime] compiling the patched server");
    const build = executableBuildPlan(arch);
    await command("corepack", build.args, { env: buildEnvironment });
    await fs.copyFile(path.join(checkout, "apps/server/dist-exe", build.output), path.join(unpacked, "t3"));
    await fs.chmod(path.join(unpacked, "t3"), 0o755);
    const containerPatch = { revision: PATCH_REVISION, source: commit, upstreamIntegrity: release.integrity };
    const manifest = { name: "t3-runtime", version, distribution: release.url, integrity: release.integrity, containerPatch };
    await fs.writeFile(path.join(unpacked, "package.json"), JSON.stringify(manifest) + "\n");
    if (arch === process.arch) {
      const result = await run(path.join(unpacked, "t3"), ["--version"], options);
      if (executableVersion(result.stdout) !== version) throw new Error("The patched executable reports a different version.");
    }
    await fs.chmod(unpacked, 0o755);
    await fs.chmod(path.join(unpacked, "package.json"), 0o644);
    await fs.rename(unpacked, destination);
    return manifest;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [version, arch, destination, source] = process.argv.slice(2);
  try { console.log(JSON.stringify(await buildRuntime(version, arch, destination, { source }))); }
  catch (error) { console.error(error.stderr || error.message); process.exitCode = 1; }
}
