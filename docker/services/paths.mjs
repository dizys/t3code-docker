import path from "node:path";
import { readFileSync } from "node:fs";
export const IMAGE_ROOT = path.dirname(new URL(import.meta.url).pathname);
export const SYSTEM_ROOT = "/var/lib/t3code/services";
export function paths(domain, env = process.env) {
  if (domain === "system") return { root: SYSTEM_ROOT, scan: "/run/t3code-services/system", socket: "/run/t3code-services/system.sock", home: "/home/t3" };
  const home = env.HOME || "/home/t3", state = env.T3CODE_HOME || path.join(home, ".t3");
  const run = env.T3_RUN_DIR || path.join(state, "run");
  return { root: path.join(state, "setup/services/user"), scan: path.join(run, "services-user"), socket: path.join(run, "services-user.sock"), home };
}
export function containerBoot() {
  const stat = readFileSync("/proc/1/stat", "utf8");
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}
