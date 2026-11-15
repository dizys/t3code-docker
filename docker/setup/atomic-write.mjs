// One atomic tmp+rename file writer for the setup console.
//
// The MCP store and the instruction editors each kept their own copy of this
// dance: private temp file, exact mode, rename into place, best-effort temp
// cleanup. A crash between write and rename must leave either the old file or
// the new one, never a half-written one, so both callers share this helper.
// The runtime selection (docker/runtime/state.mjs) and the harness manager
// record (docker/harness/state.mjs) keep their own variants on purpose: the
// former fsyncs for boot-critical durability and the latter writes through an
// injected filesystem seam, and neither image layer can import this one.
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Replace durably: exclusive temp file, exact mode, atomic rename. */
export async function writeFileAtomic(fs, file, text, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    const handle = await fs.open(tmp, "wx", mode);
    created = true;
    try { await handle.writeFile(text, "utf8"); await handle.chmod(mode); }
    finally { await handle.close(); }
    await fs.rename(tmp, file);
  } finally {
    if (created) await fs.rm(tmp, { force: true });
  }
}

/** Atomic JSON replace with the canonical trailing newline. */
export async function writeJsonAtomic(fs, file, value, mode = 0o600) {
  await writeFileAtomic(fs, file, JSON.stringify(value, null, 2) + "\n", mode);
}
