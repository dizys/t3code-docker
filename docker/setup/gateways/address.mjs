// A gateway's address: what someone typed, made into the one form every agent
// can build on. Agents disagree about the path (Claude Code adds /v1/messages,
// Codex and OpenCode want a base ending in /v1), so the stored address never
// ends in a version or an endpoint. Pure, so the sentences here are testable.

const MAX_URL = 2048;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// What people paste from a gateway's own docs. Removing it is always right:
// each agent adds back the path it needs.
const ENDPOINT = /\/v1(?:beta)?(?:\/(?:models|messages|responses|chat\/completions|completions))?$/i;
const BARE_ENDPOINT = /\/(?:chat\/completions|messages|responses)$/i;
// A gateway's admin pages. Left on, every test would be a keyless request to a place
// that counts those toward locking this server out.
const MANAGEMENT = /\/(?:v\d+\/management(?:\/.*)?|management\.html)$/i;

const stripBrackets = host => host.replace(/^\[|\]$/g, '');

export function isLoopback(hostname) {
  const host = stripBrackets(String(hostname ?? '').toLowerCase());
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Addresses that stay on a machine or a private network, where plain http is ordinary. */
export function isPrivate(hostname) {
  const host = stripBrackets(String(hostname ?? '').toLowerCase());
  if (isLoopback(host)) return true;
  // A single label is a Compose service name or a LAN host.
  if (/^[a-z0-9-]+$/.test(host) || /\.(?:local|internal|lan|home|test|ts\.net)$/.test(host)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  // IPv6 unique local addresses. The colon matters: fd-proxy.example.com is a public name.
  return /^f[cd][0-9a-f]{2}:/.test(host);
}

const assumedScheme = text => {
  const host = text.split(/[/:]/)[0];
  return isPrivate(host) || /:\d+(?:\/|$)/.test(text) ? 'http://' : 'https://';
};

/**
 * Read an address. Answers `{ ok, url, host, notes, insecure, loopback }`, or
 * `{ ok: false, error }` with a sentence for the field.
 */
export function parseAddress(input) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, error: 'Enter your gateway’s address.' };
  if (text.length > MAX_URL || /[\s\0]/.test(text)) return { ok: false, error: 'Enter a single address, without spaces.' };
  let parsed;
  try { parsed = new URL(SCHEME.test(text) ? text : assumedScheme(text) + text); }
  catch { return { ok: false, error: 'That doesn’t look like an address. Try http://gateway:8317.' }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return { ok: false, error: 'Use an http:// or https:// address.' };
  if (parsed.username || parsed.password) return { ok: false, error: 'Put the key in the API key field, not in the address.' };
  if (parsed.search || parsed.hash) return { ok: false, error: 'Remove the part after ? or #. The key goes in the API key field.' };
  const notes = [];
  let pathname = parsed.pathname.replace(/\/+$/, '');
  const trimmed = pathname.replace(MANAGEMENT, '').replace(ENDPOINT, '').replace(BARE_ENDPOINT, '').replace(/\/+$/, '');
  if (trimmed !== pathname) {
    notes.push(`Removed ${pathname.slice(trimmed.length)}. Each agent adds the path it needs.`);
    pathname = trimmed;
  }
  // Codex's launch arguments are single-quoted, and URLs leave an apostrophe as it is.
  const url = parsed.origin + pathname.replaceAll("'", '%27');
  return { ok: true, url, host: parsed.host, hostname: stripBrackets(parsed.hostname), notes,
    insecure: parsed.protocol === 'http:' && !isPrivate(parsed.hostname), loopback: isLoopback(parsed.hostname) };
}

/** The same address on another host, keeping the scheme, port and path. */
export function withHost(url, host) {
  const parsed = new URL(url);
  parsed.hostname = host;
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

/** A name for a gateway nobody has named yet. */
export function suggestName(url, presetName) {
  if (presetName) return presetName;
  try {
    const { hostname } = new URL(url);
    if (isLoopback(hostname) || hostname === 'host.docker.internal') return 'Local gateway';
    const parts = hostname.split('.');
    const label = parts.length > 2 ? parts[parts.length - 2] : parts[0];
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch { return 'Gateway'; }
}
