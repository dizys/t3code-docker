import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IMAGE_ROOT } from "./paths.mjs";
import { validId } from "./definition.mjs";
const exec = promisify(execFile);
// Every run/finish file in the system tree is written by the root controller.
// The independent user scan tree is only opened after the privilege drop.
export function createSupervision({ scan, domain, node = "/usr/local/bin/node", bin = "/usr/bin", helper = "/usr/local/libexec/t3-service-process", run = exec }) {
  const directory = id => { if (!validId(id)) throw new Error("Invalid service ID"); return path.join(scan, id); };
  const control = (command, args, options = {}) => run(path.join(bin, command), args, { timeout: 40000, maxBuffer: 65536, ...options });
  const prepare = async (id, grace = 10000) => {
    if (!Number.isInteger(grace) || grace < 100 || grace > 30000) throw new Error("Invalid shutdown grace");
    const dir = directory(id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const [name, text] of Object.entries({ down: "", "timeout-kill": "32000\n", "timeout-finish": "5000\n",
      run: `#!/bin/sh\nexec ${helper} ${grace} ${node} ${IMAGE_ROOT}/execute.mjs ${domain} ${id}\n`,
      finish: `#!/bin/sh\nexec ${node} ${IMAGE_ROOT}/finish.mjs ${domain} ${id} "$1" "$2"\n` })) {
      await fs.writeFile(path.join(dir, name), text, { mode: name === "run" || name === "finish" ? 0o700 : 0o600 });
    }
    await control("s6-svscanctl", ["-a", scan]);
  };
  const observe = async id => {
    try {
      const { stdout } = await control("s6-svstat", ["-o", "up,pid,exitcode,signal", directory(id)]);
      const [up, pid, exitCode, signal] = stdout.trim().split(/\s+/);
      return { up: up === "true", pid: Number(pid) || null, exitCode: Number(exitCode), signal, observedAt: Date.now() };
    } catch {
      // A scan directory that was never prepared (fresh boot, removed
      // registration) is simply down. Only a prepared service the scan
      // cannot report is unavailable.
      try { await fs.access(path.join(directory(id), "run")); }
      catch { return { up: false, observedAt: Date.now() }; }
      return { up: false, unavailable: true, observedAt: Date.now() };
    }
  };
  const start = async (id, grace) => {
    await prepare(id, grace);
    // s6 scan acknowledgement is asynchronous; wait for its control FIFO,
    // never spawn a second owner to work around a slow scan.
    for (let i = 0; i < 100; i++) {
      try { await control("s6-svc", ["-u", directory(id)]); return; }
      catch (error) { if (i === 99) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
  };
  const stop = async (id, grace = 10000) => {
    const status = await observe(id);
    if (status.unavailable) return;
    await control("s6-svc", ["-d", directory(id)]);
    // Wait for finish too. Its documented status 125 changes the desired
    // s6 state; starting before that acknowledgement can lose the new start.
    await control("s6-svwait", ["-D", "-t", String(grace + 7000), directory(id)]);
  };
  return { prepare, start, stop, observe, directory };
}
