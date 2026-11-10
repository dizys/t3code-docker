// Tini remains PID 1. This fixed, image-owned coordinator preserves the core
// child's exit status, then tears down both optional s6 supervision domains.
import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { IMAGE_ROOT } from "./paths.mjs";
import { constants } from "node:os";
const root = process.getuid() === 0;
const uid = root ? Number(execFileSync("/usr/bin/id", ["-u", "t3"], { encoding: "utf8" }).trim()) : process.getuid();
const gid = root ? Number(execFileSync("/usr/bin/id", ["-g", "t3"], { encoding: "utf8" }).trim()) : process.getgid();
const inherited = { ...process.env, T3_SERVICES_WRAPPED: "1" };
inherited.T3_SERVICES_SYSTEM_MODE = root && uid > 0 ? 'managed' : 'rootless';
const ports = [inherited.T3CODE_PORT || "3773", inherited.T3_SETUP_PORT || "3774", inherited.T3_SINGLE_PORT || ""].filter(value => /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) < 65536).join(",");
const clean = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", T3_SERVICES_RESERVED_PORTS: ports };
const userEnv = { ...clean, HOME: "/home/t3", USER: "t3", LOGNAME: "t3", SHELL: "/bin/bash", T3_SERVICES_SYSTEM_MODE: inherited.T3_SERVICES_SYSTEM_MODE, T3CODE_HOME: inherited.T3CODE_HOME || "/home/t3/.t3", T3_RUN_DIR: inherited.T3_RUN_DIR || "/home/t3/.t3/run", ...(inherited.MISE_DATA_DIR ? { MISE_DATA_DIR: inherited.MISE_DATA_DIR } : {}), ...(inherited.MISE_STATE_DIR ? { MISE_STATE_DIR: inherited.MISE_STATE_DIR } : {}) };
const domains = [];
let stopping = false;
const launch = (file, args, env) => spawn(file, args, { env, stdio: "inherit" });
if (root && uid > 0) {
  await fs.mkdir("/run/t3code-services", { recursive: true, mode: 0o755 });
  domains.push(launch("/usr/local/bin/node", [IMAGE_ROOT + "/bootstrap.mjs", "system"], { ...clean, HOME: userEnv.HOME, T3CODE_HOME: userEnv.T3CODE_HOME, T3_RUN_DIR: userEnv.T3_RUN_DIR, T3_SERVICES_GID: String(gid) }));
}
if (uid > 0) {
  const drop = root ? [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--bounding-set=-all"] : [];
  domains.push(launch("/usr/bin/setpriv", [...drop, "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "/usr/local/bin/node", IMAGE_ROOT + "/bootstrap.mjs", "user"], userEnv));
}
for (const child of domains) {
  child.on("error", () => console.error("[services] Optional supervision is unavailable. Core T3 continues."));
  child.on("exit", () => { if (!stopping) console.error("[services] Optional supervision stopped. Core T3 continues; recreate or restart to recover."); });
}
// gosu drops all account groups/capabilities before the user's entrypoint
// reads paths or shell state. Custom workers additionally use no_new_privs.
const core = root ? launch("/usr/sbin/gosu", ["t3", "/usr/local/bin/entrypoint.sh", ...process.argv.slice(2)], inherited) : launch("/usr/local/bin/entrypoint.sh", process.argv.slice(2), inherited);
const stop = () => { if (stopping) return; stopping = true; core.kill("SIGTERM"); for (const child of domains) child.kill("SIGTERM"); };
process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", stop);
const code = await new Promise(resolve => { core.once("error", () => resolve(111)); core.once("exit", (status, signal) => resolve(status ?? (signal ? 128 + (constants.signals[signal] || 0) : 1))); });
stopping = true;
await Promise.all(domains.map(child => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 40000);
  child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
})));
process.exitCode = code;
