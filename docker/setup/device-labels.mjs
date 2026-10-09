// Names chosen in Setup for existing paired devices. T3 Code owns their
// credentials; a label is only display metadata, kept beside its state so
// changing it neither replaces the session nor depends on a browser's storage.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEVICE_LABEL_FILE = "device-labels.json";
export const DEVICE_LABEL_LIMIT = 64;
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const validLabel = (label) => typeof label === "string"
  && label.length <= DEVICE_LABEL_LIMIT && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(label);

export function createDeviceLabels({ stateDir, listSessions, isDevice = () => true }) {
  const file = path.join(stateDir, DEVICE_LABEL_FILE);
  const read = () => {
    let saved;
    try {
      saved = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return Object.create(null);
      throw error;
    }
    if (saved?.version !== 1 || !saved.labels || typeof saved.labels !== "object" || Array.isArray(saved.labels)
      || Object.entries(saved.labels).some(([id, label]) => !validId(id) || !validLabel(label) || !label.trim())) {
      throw new Error("Saved device labels could not be read.");
    }
    return Object.assign(Object.create(null), saved.labels);
  };
  const write = (labels) => {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ version: 1, labels })}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  };
  const labelled = (session, labels) => Object.hasOwn(labels, session.sessionId)
    ? { ...session, setupLabel: labels[session.sessionId] } : session;

  const apply = (sessions) => {
    const labels = read();
    return sessions.map((session) => labelled(session, labels));
  };

  const rename = async (input) => {
    const { id, label } = input ?? {};
    if (!validId(id)) return { http: 400, body: { ok: false, error: "Choose a paired device to rename." } };
    if (typeof label !== "string" || !validLabel(label.trim())) {
      return { http: 400, body: { ok: false, error: `Use a single-line label of at most ${DEVICE_LABEL_LIMIT} characters.` } };
    }
    const value = label.trim();
    let sessions;
    try {
      sessions = await listSessions();
      if (!Array.isArray(sessions)) throw new Error("No session list");
    } catch {
      return { http: 502, body: { ok: false, error: "Could not read paired devices. Try again when T3 Code is available." } };
    }
    const devices = sessions.filter(isDevice);
    const session = devices.find((candidate) => candidate.sessionId === id);
    if (!session) return { http: 404, body: { ok: false, error: "This device is no longer paired. Refresh the device list." } };
    try {
      // Read after the asynchronous session lookup. Concurrent renames of
      // different devices each keep the preceding write; reads and the small
      // atomic write run together without yielding.
      const labels = read();
      const changed = (labels[id] ?? "") !== value;
      const active = new Set(devices.map((device) => device.sessionId));
      for (const key of Object.keys(labels)) if (!active.has(key)) delete labels[key];
      if (value) labels[id] = value;
      else delete labels[id];
      write(labels);
      return { http: 200, body: { ok: true, changed, label: value || null, session: labelled(session, labels) } };
    } catch {
      return { http: 500, body: { ok: false, error: "Could not save the device label. Please try again." } };
    }
  };
  return { apply, rename };
}
