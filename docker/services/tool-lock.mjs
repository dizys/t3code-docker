import { existsSync } from "node:fs";
import path from "node:path";
import { ServiceError } from "./store.mjs";
const root = existsSync("/opt/t3-harness/lock.mjs") ? "/opt/t3-harness/" : new URL("../harness/", import.meta.url).pathname;
export async function withToolLock(fn) {
  const lock = await import(root + "lock.mjs"), { createFs, processAlive, processStartTime } = await import(root + "io.mjs");
  const stateDir = process.env.MISE_STATE_DIR || path.join(process.env.HOME, ".local/state/mise");
  const ctx = { fs: createFs(), stateDir, lockPath: lock.lockPath(stateDir), pid: process.pid, now: Date.now, isAlive: processAlive, startTimeOf: processStartTime, lockStaleMs: 60 * 60_000 };
  const held = await lock.acquireLock(ctx, { id: "services", operation: "reference" });
  if (!held.acquired) throw new ServiceError("tools-busy", "Toolchains is installing or cleaning up. Wait for it to finish, then retry.");
  try { return await fn(); } finally { await held.release(); }
}
