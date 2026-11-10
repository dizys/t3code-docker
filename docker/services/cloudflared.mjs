import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readCatalogue, downloadVerified } from "./artifacts.mjs";
import { fileReceipt } from "./user-tools.mjs";
if (process.getuid() === 0) { console.error("Run cloudflared as t3. Managed system tunnels use Services."); process.exit(100); }
const definition = (await readCatalogue()).services.cloudflared;
// Native readiness probes must not download an optional payload on a read.
if (process.argv.length === 3 && ['--version', '-v', 'version'].includes(process.argv[2])) {
  console.log('cloudflared version ' + definition.version + ' (t3code on-demand)');
  process.exit(0);
}
const entry = definition.payloads[0];
const root = path.join(process.env.T3CODE_HOME || path.join(process.env.HOME, ".t3"), "tools/cloudflared", entry.sha256);
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const file = root + "/cloudflared";
let current = await fileReceipt(file).catch(() => null);
if (current?.digest !== entry.sha256) {
  const temporary = root + "/.download-" + randomUUID();
  try { await downloadVerified(entry, temporary); await fs.chmod(temporary, 0o700); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
  current = await fileReceipt(file);
}
if (current.digest !== entry.sha256) throw new Error("Cloudflared payload verification failed");
const child = spawn(file, process.argv.slice(2), { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { process.exitCode = 111; }); child.on("exit", code => { process.exitCode = code ?? 1; });
