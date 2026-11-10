import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { paths, IMAGE_ROOT, containerBoot } from "./paths.mjs";
const domain = process.argv[2];
if (!["system", "user"].includes(domain) || domain === "user" && process.getuid() === 0) process.exit(100);
// No user-owned path or configuration was opened by root on the user path.
const p = paths(domain);
await fs.mkdir(p.scan, { recursive: true, mode: 0o700 });
const mark = path.join(p.scan, "boot");
const previous = await fs.readFile(mark, "utf8").catch(() => null);
if (previous !== containerBoot()) {
  await fs.rm(p.scan, { recursive: true, force: true }); await fs.mkdir(p.scan, { recursive: true, mode: 0o700 });
  await fs.writeFile(mark, containerBoot(), { mode: 0o600 });
}
const worker = path.join(p.scan, "_controller");
await fs.mkdir(worker, { recursive: true, mode: 0o700 });
// The controller's installers and resolver subprocesses need the same owned
// descendant cleanup as payloads before s6 starts a replacement controller.
await fs.writeFile(worker + "/run", `#!/bin/sh\nexec /usr/local/libexec/t3-service-process 1000 /usr/local/bin/node ${IMAGE_ROOT}/worker.mjs ${domain}\n`, { mode: 0o700 });
await fs.writeFile(worker + "/timeout-kill", "5000\n", { mode: 0o600 });
const child = spawn("/usr/bin/s6-svscan", [p.scan], { stdio: "inherit" });
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; child.kill("SIGTERM"); } };
process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", stop);
child.once("error", () => { process.exitCode = 111; });
child.once("exit", code => { process.exitCode = code || 0; });
