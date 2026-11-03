// Hides saved values in command output. This catches accidents, such as a tool
// echoing its own token. It can't stop a command that sets out to reveal one.
export const REDACTED = '[redacted]';
const MIN_LENGTH = 4;
const MIN_LINE = 16;

// The forms a value commonly takes in output. A file's long lines count as well,
// so printing part of a private key is caught too.
export function maskValues(secrets) {
  const values = new Set();
  for (const secret of [secrets].flat()) {
    if (typeof secret !== 'string' || secret.length < MIN_LENGTH) continue;
    values.add(secret); values.add(secret.trim());
    values.add(JSON.stringify(secret).slice(1, -1));
    values.add(encodeURIComponent(secret));
    values.add(new URLSearchParams([['', secret]]).toString().slice(1));
    values.add(Buffer.from(secret).toString('base64'));
    if (secret.includes('\n')) for (const line of secret.split(/\r?\n/)) if (line.trim().length >= MIN_LINE) values.add(line.trim());
  }
  return [...values].filter(value => value.length >= MIN_LENGTH).sort((a, b) => b.length - a.length);
}

function filterValues(values, write) {
  if (!values.length) return { write: chunk => write(chunk), end() {} };
  const pattern = new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const longest = values[0].length, firsts = new Set(values.map(value => value[0]));
  let pending = '';
  // Only text that could still become a value waits for the next chunk, so
  // ordinary output and prompts come through straight away.
  const held = rest => {
    for (let at = Math.max(0, rest.length - longest + 1); at < rest.length; at++) {
      if (!firsts.has(rest[at])) continue;
      const tail = rest.slice(at);
      if (values.some(value => value.startsWith(tail))) return rest.length - at;
    }
    return 0;
  };
  const flush = final => {
    let out = '', from = 0;
    for (const match of pending.matchAll(pattern)) {
      out += pending.slice(from, match.index) + REDACTED;
      from = match.index + match[0].length;
    }
    const rest = pending.slice(from), keep = final ? 0 : held(rest);
    out += rest.slice(0, rest.length - keep);
    pending = keep ? rest.slice(-keep) : '';
    if (out) write(out);
  };
  return { write(chunk) { pending += chunk; flush(false); }, end() { flush(true); } };
}

/** Text in, text out. */
export const outputFilter = (secrets, write) => filterValues(maskValues(secrets), write);

/**
 * Bytes in, bytes out. Latin-1 maps each byte to one character and back, so
 * binary output such as an image or an archive passes through unchanged.
 */
export function byteFilter(secrets, write) {
  const values = maskValues(secrets).map(value => Buffer.from(value).toString('latin1')).sort((a, b) => b.length - a.length);
  const filter = filterValues(values, text => write(Buffer.from(text, 'latin1')));
  return { write: chunk => filter.write(Buffer.from(chunk).toString('latin1')), end: () => filter.end() };
}

export function redactText(text, secrets) {
  let result = '';
  const filter = outputFilter(secrets, value => { result += value; });
  filter.write(String(text)); filter.end();
  return result;
}
