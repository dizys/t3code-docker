// One capped file reader for the setup console.
//
// Skill files, shared instructions and native settings snapshots each read a
// bounded prefix of a file that may be a symlink, may grow between stat and
// read, or may be a raced-in FIFO. The shape is always the same: reject
// non-regular or oversized targets before opening, open without following
// links and without blocking, re-check the opened descriptor, then read at
// most the limit plus one byte (including across short reads) so polling can
// never load a file whole. Callers keep their own messages; this module owns
// the flags and the read loop.
import { constants } from "node:fs";

// Never follow a raced-in symlink, and never block on a raced-in FIFO.
export const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/** Read at most maxBytes + 1 from an open handle, tolerating short reads. */
export async function readHandleCapped(handle, maxBytes) {
  const buffer = Buffer.alloc(maxBytes + 1);
  let bytes = 0;
  while (bytes < buffer.length) {
    const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
    if (!result.bytesRead) break;
    bytes += result.bytesRead;
  }
  // `raw` is the exact bytes read: revision hashes must not depend on how
  // invalid UTF-8 decodes, so hash this, not the decoded content.
  return { content: buffer.toString("utf8", 0, bytes), bytes, raw: buffer.subarray(0, bytes) };
}

/**
 * Bounded read of a regular file. Throws the caller's `invalid` error for a
 * non-regular target and the caller's `tooLarge` error (given the byte count)
 * for an oversized one, so messages stay identical at every call site.
 * `flags` defaults to non-following and non-blocking; the shared instruction
 * file keeps its plain "r" open so a manually symlinked AGENTS.md still reads.
 */
export async function readCappedFile(io, file, maxBytes, { tooLarge, invalid, flags = READ_FLAGS } = {}) {
  const failLarge = tooLarge ?? ((bytes) => Object.assign(new Error(`File exceeds the ${maxBytes}-byte read limit.`), { code: "too_large", bytes }));
  const failInvalid = invalid ?? (() => Object.assign(new Error("Expected a regular file."), { code: "invalid" }));
  const check = (stat) => {
    if (!stat.isFile()) throw failInvalid();
    if (stat.size > maxBytes) throw failLarge(stat.size);
  };
  // Reject oversized targets before opening them, including through symlinks.
  check(await io.stat(file));
  const handle = await io.open(file, flags);
  try {
    const stat = await handle.stat();
    check(stat);
    // A file may grow after stat. Read at most the limit plus one byte,
    // including across short reads, so polling can never load it all.
    const read = await readHandleCapped(handle, maxBytes);
    if (read.bytes > maxBytes) throw failLarge(read.bytes);
    return { ...read, mode: stat.mode & 0o777, stat };
  } finally {
    await handle.close();
  }
}
