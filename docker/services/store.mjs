// Each privilege domain owns one SQLite authority. Intent, idempotency and
// revisions commit together before an installer or supervisor sees an effect.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export class ServiceError extends Error {
  constructor(code, message, field = null) { super(message); this.code = code; this.field = field; }
}
export const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export function openStore(root, { now = Date.now, domain = "user" } = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "state.sqlite");
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > 1) { db.close(); throw new ServiceError("schema-newer", "This service store needs a newer container image. Core T3 remains available."); }
  db.exec(`CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version=1;`);
  const transaction = fn => { db.exec("BEGIN IMMEDIATE"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const decode = row => row ? JSON.parse(row.value) : null;
  const get = id => typeof id === 'string' ? decode(db.prepare("SELECT value FROM resources WHERE id=?").get(id)) : null;
  const list = () => db.prepare("SELECT value FROM resources ORDER BY id").all().map(decode);
  const put = value => db.prepare("INSERT INTO resources VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value").run(value.id, value.revision, JSON.stringify(value));
  const operation = id => decode(db.prepare("SELECT value FROM operations WHERE id=?").get(id));
  const saveOperation = value => db.prepare("UPDATE operations SET state=?,value=? WHERE id=?").run(value.state, JSON.stringify(value), value.id);
  const event = (op, detail) => {
    const result = db.prepare("INSERT INTO events(operation,value) VALUES (?,?)").run(op, JSON.stringify({ at: now(), ...detail }));
    db.prepare("DELETE FROM events WHERE sequence < ?").run(Number(result.lastInsertRowid) - 2000);
    return Number(result.lastInsertRowid);
  };
  const plan = input => {
    const value = { ...input, id: randomUUID(), domain, createdAt: now(), expiresAt: now() + 5 * 60_000 };
    db.prepare("DELETE FROM plans WHERE expires < ?").run(now());
    if (db.prepare("SELECT count(*) AS n FROM plans").get().n >= 128) throw new ServiceError("busy", "Too many service reviews are open. Wait a few minutes and retry.");
    db.prepare("INSERT INTO plans VALUES (?,?,?)").run(value.id, value.expiresAt, JSON.stringify(value));
    return value;
  };
  const apply = ({ planId, expectedRevision, idempotencyKey, acknowledgeAccessImpact }) => transaction(() => {
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,96}$/.test(idempotencyKey)) throw new ServiceError("invalid", "Use a stable operation key.");
    const signature = hash([planId, expectedRevision]);
    const existing = db.prepare("SELECT signature,value FROM operations WHERE key=?").get(idempotencyKey);
    if (existing) {
      if (existing.signature !== signature) throw new ServiceError("conflict", "This operation key belongs to another review.");
      return decode(existing);
    }
    const value = decode(db.prepare("SELECT value FROM plans WHERE id=?").get(planId));
    if (!value || value.expiresAt < now()) throw new ServiceError("expired", "This review has expired. Review the changes again; your draft is kept.");
    if (value.review.requiresFallback && acknowledgeAccessImpact !== true) throw new ServiceError('access-impact', 'Confirm that you have another way to reach Setup or this container before interrupting this access path.');
    const current = get(value.target);
    if (expectedRevision !== value.expectedRevision || (current?.revision ?? 0) !== expectedRevision) throw new ServiceError("conflict", "This service changed. Review the changes again; your draft is kept.");
    const pending = db.prepare("SELECT value FROM operations WHERE state IN ('committed','working','recovering')").all().map(decode);
    if (pending.some(op => op.target === value.target)) throw new ServiceError("busy", "An operation is already managing this service.");
    const op = { id: randomUUID(), domain, target: value.target, action: value.action, plan: value, state: "committed", phase: "committed", createdAt: now(), updatedAt: now(), events: [], accessImpactAcknowledged: acknowledgeAccessImpact === true };
    db.prepare("INSERT INTO operations VALUES (?,?,?,?,?)").run(op.id, idempotencyKey, signature, op.state, JSON.stringify(op));
    event(op.id, { phase: "committed" });
    return op;
  });
  const pending = () => db.prepare("SELECT value FROM operations WHERE state IN ('committed','working','recovering') ORDER BY rowid").all().map(decode);
  return { db, root, domain, now, get, list, put, remove: id => db.prepare("DELETE FROM resources WHERE id=?").run(id), transaction, plan, apply, operation, saveOperation, event, pending,
    meta: id => decode(db.prepare("SELECT value FROM meta WHERE id=?").get(id)),
    setMeta: (id, value) => db.prepare("INSERT INTO meta VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id, JSON.stringify(value)),
    operations: () => db.prepare("SELECT value FROM operations ORDER BY rowid DESC LIMIT 40").all().map(decode),
    events: after => db.prepare("SELECT sequence,operation,value FROM events WHERE sequence > ? ORDER BY sequence LIMIT 250").all(Number(after) || 0).map(row => ({ ...decode(row), sequence: row.sequence, operationId: row.operation })),
    review: id => decode(db.prepare('SELECT value FROM plans WHERE id=?').get(id)) || (() => { const op = decode(db.prepare("SELECT value FROM operations WHERE json_extract(value, '$.plan.id')=? LIMIT 1").get(id)); return op?.plan || null; })(),
    close: () => db.close() };
}
