export function outputFilter(secret, write) {
  const values = [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), new URLSearchParams([['', secret]]).toString().slice(1), Buffer.from(secret).toString('base64')])].filter(Boolean).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const keep = Math.max(...values.map(value => value.length)) - 1;
  let pending = '';
  const flush = final => {
    let cut = final ? pending.length : Math.max(0, pending.length - keep);
    for (const match of pending.matchAll(pattern)) {
      if (match.index < cut && match.index + match[0].length > cut) cut = match.index + match[0].length;
    }
    if (cut) { write(pending.slice(0, cut).replace(pattern, '[redacted]')); pending = pending.slice(cut); }
  };
  return { write(chunk) { pending += chunk; flush(false); }, end() { flush(true); } };
}


export function redactText(text, secret) {
  if (typeof secret !== 'string' || !secret) return text;
  let result = ''; const filter = outputFilter(secret, value => { result += value; });
  filter.write(String(text)); filter.end(); return result;
}
