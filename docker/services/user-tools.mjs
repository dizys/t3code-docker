// All calls happen in the already unprivileged worker, from an empty scratch
// directory, with the pinned mise's documented configuration overrides. No
// project/home config or hook is evaluated to inspect or run a service.
import { promises as fs, constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { ServiceError, hash } from "./store.mjs";
const exec = promisify(execFile);
export const baseEnvironment = (home, user = "t3") => ({ HOME: home, USER: user, LOGNAME: user, SHELL: "/bin/bash", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin" });
export async function fileReceipt(file) {
  const target = await fs.realpath(file).catch(() => { throw new ServiceError("tool-unavailable", "The selected executable is unavailable. Choose an installed version in Toolchains.", "executable"); });
  await fs.access(target, constants.X_OK);
  const info = await fs.stat(target);
  if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new ServiceError("invalid", "Choose a regular executable smaller than 512 MiB.", "executable");
  const digest = createHash("sha256");
  for await (const data of createReadStream(target)) digest.update(data);
  return { path: target, digest: digest.digest("hex"), size: info.size };
}
export function createUserTools({ home, stateHome, dataDir = path.join(home, ".local/share/mise"), mise = "/usr/local/bin/mise", run = exec } = {}) {
  const scratch = path.join(stateHome, "resolution");
  const env = () => ({ ...baseEnvironment(home), MISE_DATA_DIR: dataDir,
    MISE_GLOBAL_CONFIG_FILE: path.join(scratch, "global.toml"), MISE_SYSTEM_CONFIG_FILE: path.join(scratch, "system.toml"),
    MISE_OVERRIDE_CONFIG_FILENAMES: ".t3-services-isolated.toml", MISE_CEILING_PATHS: scratch,
    MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: "none", MISE_NO_ENV: "true",
    MISE_CONFIG_DIR: scratch, MISE_STATE_DIR: path.join(scratch, "state"), MISE_CACHE_DIR: path.join(scratch, "cache"),
    MISE_AUTO_INSTALL: "false", MISE_EXEC_AUTO_INSTALL: "false", MISE_NOT_FOUND_SYSTEM_FALLBACK: "false", MISE_NO_HOOKS: "true",
    MISE_ENV_SHELL_EXPAND: "false", MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS: "", MISE_YES: "false", MISE_COLOR: "0", MISE_QUIET: "true" });
  const prepare = async () => {
    await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
    for (const file of ["global.toml", "system.toml"]) await fs.writeFile(path.join(scratch, file), "# Isolated service resolution\n", { mode: 0o600 });
  };
  const call = async args => {
    await prepare();
    try { const result = await run(mise, ["-C", scratch, ...args], { env: env(), cwd: scratch, timeout: 20000, maxBuffer: 2 * 1024 * 1024 }); return JSON.parse(result.stdout); }
    catch { throw new ServiceError("tools-unavailable", "Installed tools could not be read safely. Check Toolchains, then retry.", "tools"); }
  };
  const inventory = async () => {
    const listing = await call(["ls", "--installed", "--json"]);
    return Object.entries(listing).flatMap(([tool, entries]) => entries.filter(item => item.installed && /^\d+\.[0-9A-Za-z._+-]{1,62}$/.test(item.version)).map(item => ({ tool, version: item.version, path: item.install_path }))).sort((a, b) => a.tool.localeCompare(b.tool) || a.version.localeCompare(b.version));
  };
  const resolve = async definition => {
    const dir = await fs.stat(definition.cwd).catch(() => null);
    if (!dir?.isDirectory()) throw new ServiceError("invalid", "The working directory is unavailable.", "cwd");
    await fs.access(definition.cwd, constants.R_OK | constants.X_OK);
    let environment = baseEnvironment(home), installations = [];
    if (definition.tools.length) {
      const installed = await inventory();
      installations = await Promise.all(definition.tools.map(async item => {
        const found = installed.find(entry => entry.tool === item.tool && entry.version === item.version);
        if (!found || !path.isAbsolute(found.path ?? "")) throw new ServiceError("tool-unavailable", `${item.tool}@${item.version} is not installed. Choose a version in Toolchains.`, "tools");
        const canonical = await fs.realpath(found.path).catch(() => null);
        if (!canonical || !(await fs.stat(canonical)).isDirectory()) throw new ServiceError('tool-unavailable', 'The selected installation is unavailable. Choose an installed version in Toolchains.', 'tools');
        return { ...found, path: canonical, installPath: found.path };
      }));
      const output = await call(["env", "--json", ...installations.map(item => `${item.tool}@${item.version}`)]);
      for (const [name, value] of Object.entries(output)) {
        if (typeof value === "string" && !/^(?:T3_|MISE_|__MISE|LD_PRELOAD$|NODE_OPTIONS$|BASH_ENV$|ENV$)/.test(name)) environment[name] = value;
      }
    }
    let executable = definition.executable;
    if (definition.mode === "mise") {
      executable = null;
      for (const directory of environment.PATH.split(path.delimiter)) {
        if (!path.isAbsolute(directory)) continue;
        const candidate = path.join(directory, definition.executable);
        const real = await fs.realpath(candidate).catch(() => null);
        // A requested tool command must come from an explicitly selected
        // installation, never a system fallback or another active default.
        if (!real || !installations.some(item => real.startsWith(path.resolve(item.path) + path.sep))) continue;
        try { await fs.access(real, constants.X_OK); executable = real; break; } catch { /* next path */ }
      }
      if (!executable) throw new ServiceError("tool-unavailable", "That executable is not provided by the selected installations.", "executable");
    }
    const receipt = await fileReceipt(executable);
    return { executable: receipt.path, env: { ...environment, ...definition.env }, argv: definition.mode === "script" ? ["-c", definition.script] : [...definition.argv],
      receipt: { executable: receipt, installations, environment: hash(environment) } };
  };
  return { inventory, resolve, environment: env };
}
