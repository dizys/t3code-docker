import { openStore } from "./store.mjs";
import { paths, containerBoot } from "./paths.mjs";
import { validId } from "./definition.mjs";
const [domain, id, exitCode, signal] = process.argv.slice(2);
if (!["user", "system"].includes(domain) || !validId(id) || domain === "user" && process.getuid() === 0) process.exit(100);
const store = openStore(paths(domain).root, { domain }), run = store.meta("run:" + id), previous = store.meta("exit:" + id);
if (run && previous?.runId !== run.runId) store.setMeta("exit:" + id, { ...run, endedAt: Date.now(), exitCode: Number(exitCode), signal: Number(signal), boot: containerBoot() });
store.close();
// The product controller alone decides whether/when the next run is allowed.
// This documented s6 finish status keeps the service down without losing s6.
process.exitCode = 125;
