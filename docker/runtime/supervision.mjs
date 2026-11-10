// Bind restart requests to this boot's supervisor and its actual child.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19]) || ["Z", "X"].includes(fields[0])) return null;
    return { parentPid: Number(fields[1]), startTime: fields[19] };
  } catch { return null; }
}

const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

export function supervisorRecord() {
  const identity = processIdentity(process.pid);
  if (!identity) throw new Error("The supervisor's process identity could not be read.");
  return { pid: process.pid, protocol: 3, startTime: identity.startTime, bootId: bootId(), restartRequests: true };
}

export function supervisedChild(runDir, pid) {
  let fd;
  try {
    if (!Number.isInteger(pid) || pid < 2) return false;
    fd = openSync(path.join(runDir, "supervisor.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return false;
    const saved = JSON.parse(readFileSync(fd, "utf8"));
    if (saved.protocol !== 3 || saved.restartRequests !== true || saved.bootId !== bootId()) return false;
    const supervisor = processIdentity(saved.pid), child = processIdentity(pid);
    return Boolean(supervisor && child && saved.startTime === supervisor.startTime && child.parentPid === saved.pid);
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
