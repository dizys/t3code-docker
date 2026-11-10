// Read-only shared dependency boundary. Callers hold the harness lock before
// removing a tool; service registration takes that same lock before pinning.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
export function serviceReferences({ env = process.env, home = env.HOME || "/home/t3" } = {}) {
  const file = path.join(env.T3CODE_HOME || path.join(home, ".t3"), "setup/services/user/state.sqlite");
  if (!existsSync(file)) return [];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (db.prepare("PRAGMA user_version").get().user_version !== 1) throw new Error("schema");
    const resources = db.prepare("SELECT value FROM resources").all().map(row => JSON.parse(row.value)).filter(row => row.kind === 'service');
    // A candidate can be activated before its startup check finishes. Keep
    // both its pins and the rollback configuration alive until it settles.
    for (const row of db.prepare("SELECT value FROM operations WHERE state IN ('committed','working','recovering')").all()) {
      const op = JSON.parse(row.value);
      if (op.plan.network) continue;
      for (const value of [op.plan.previous, op.plan.candidate]) if (value?.config) resources.push({ ...value, id: op.target });
    }
    return resources.map(row => ({ id: row.id, name: row.config.name,
      tools: row.config.tools || [], paths: [row.receipt?.executable?.path, ...(row.receipt?.installations || []).map(item => item.path)].filter(Boolean), credentials: Object.values(row.config.secrets || {}) }));
  } catch { throw new Error("Service dependencies could not be checked. Keep installed tools and credentials until Services can be read."); }
  finally { db?.close(); }
}
export const serviceUsesTool = (reference, tool, version, target = null) => reference.tools.some(item => item.tool === tool && item.version === version) || Boolean(target && reference.paths.some(file => file === target || file.startsWith(target + path.sep)));
export function assertToolUnreferenced(ctx, tool, version, target = null) {
  const refs = serviceReferences(ctx).filter(item => serviceUsesTool(item, tool, version, target));
  if (refs.length) throw new Error("Required by service " + refs.map(item => item.name).join(", ") + ". Choose another version or remove its registration in Services first. Disabled services retain their tool pins.");
}
