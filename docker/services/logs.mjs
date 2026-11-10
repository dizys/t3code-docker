import { mkdirSync, statSync, renameSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ServiceError } from './store.mjs';
const LIMIT = 256 * 1024;
export function logWriter(root, id, runId, stream, masks = []) {
  const dir = path.join(root, "logs", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, stream + ".jsonl"), decoder = new StringDecoder("utf8");
  let buffered = "", pending = '', sequence = 0;
  const redact = value => masks.filter(Boolean).sort((a, b) => b.length - a.length).reduce((result, mask) => result.split(mask).join("[redacted]"), value);
  const line = text => {
    const record = JSON.stringify({ at: Date.now(), runId, stream, sequence: ++sequence, text: text.slice(0, 8192) }) + "\n";
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size || 0) + Buffer.byteLength(record) > LIMIT) { renameSync(file, file + ".previous"); writeFileSync(file, "", { mode: 0o600 }); }
      appendFileSync(file, record, { mode: 0o600 });
    } catch { /* Bounded logging must not block or take down the payload. */ }
  };
  const drain = final => {
    // Redact before splitting lines, including multiline values and values
    // split across writes. Keep enough raw suffix for the next chunk.
    const overlap = Math.max(1, ...masks.map(mask => mask.length));
    let cut = final ? pending.length : Math.max(0, pending.length - overlap + 1);
    let changed;
    do {
      changed = false;
      for (const mask of masks.filter(Boolean)) {
        const at = pending.lastIndexOf(mask, cut - 1);
        if (at >= 0 && at < cut && at + mask.length > cut) { cut = at; changed = true; }
      }
    } while (changed);
    buffered += redact(pending.slice(0, cut)); pending = pending.slice(cut);
    let at;
    while ((at = buffered.indexOf("\n")) >= 0) { line(buffered.slice(0, at)); buffered = buffered.slice(at + 1); }
    while (buffered.length > 16384) { line(buffered.slice(0, 8192)); buffered = buffered.slice(8192); }
    if (final && buffered) { line(buffered); buffered = ""; }
  };
  return { write: buffer => { pending += decoder.write(buffer); drain(false); }, end: () => { pending += decoder.end(); drain(true); } };
}
export function readLogs(root, id, after = 0) {
  let cursor = {}, gap = false;
  if (typeof after === 'string' && after) {
    try { cursor = JSON.parse(Buffer.from(after, 'base64url')); if (Object.keys(cursor).some(key => !['stdout', 'stderr'].includes(key)) || Object.values(cursor).some(value => typeof value !== 'string')) throw new Error(); }
    catch { throw new ServiceError('invalid', 'Use the cursor returned by the previous log read.'); }
  }
  const all = [], key = entry => entry.runId + ':' + entry.sequence;
  for (const stream of ['stdout', 'stderr']) {
    const records = [];
    for (const suffix of ['.previous', '']) {
      try { for (const line of readFileSync(path.join(root, 'logs', id, stream + '.jsonl' + suffix), 'utf8').split('\n')) { try { records.push(JSON.parse(line)); } catch { /* Partial tail */ } } } catch { /* No log yet */ }
    }
    const index = cursor[stream] ? records.findIndex(entry => key(entry) === cursor[stream]) : -1;
    if (cursor[stream] && index < 0) gap = true;
    all.push(...records.slice(index + 1).filter(entry => typeof after !== 'number' || entry.at > after));
  }
  const entries = all.sort((a, b) => a.at - b.at).slice(-250);
  for (const entry of entries) cursor[entry.stream] = key(entry);
  return { entries, cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url'), bounded: true, limitBytesPerStream: LIMIT * 2, gap: gap || all.length > 250 };
}
