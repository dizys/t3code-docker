// Chatter-tolerant JSON parse for harness probes.
//
// Executable probes print log lines around the JSON they are asked for. The
// whole contract is: the document starts at the first "{"; anything before
// it is chatter. Returns null when there is no document or it does not
// parse, never throws. Setup and runtime keep their own identical copies:
// each image layer ships separately, so a cross-layer import would resolve
// in a checkout and break in the image.
export function chatterSlice(text) {
  const output = String(text ?? "");
  const start = output.indexOf("{");
  return start < 0 ? null : output.slice(start);
}

export function jsonFromChatter(text) {
  const slice = chatterSlice(text);
  if (slice === null) return null;
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}
