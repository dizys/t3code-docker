// A gateway as a usage hub: T3 Code's Usage → Limits reads the quota of every
// account CLIProxyAPI pools through its management API.
//
// That key can administer the whole gateway, and the gateway locks an address out
// for 30 minutes after five failures, counting a request with no key as one. So
// nothing here runs unless someone gave a key and asked, each check is one request,
// and T3 is only ever handed a key that has passed: it polls with whatever it holds.
import { readJson, discard } from './probe.mjs';

const TIMEOUT_MS = 8000;

/** T3's own id for a hub at this address, so its Settings page and this one agree. */
export function hubIdFor(url, sources = {}) {
  const saved = Object.entries(sources).find(([, source]) => source?.url === url);
  if (saved) return saved[0];
  let host = url;
  try { host = new URL(url).host; } catch { /* the slug below still works */ }
  const slug = host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  const base = `cliproxy-${slug || 'hub'}`;
  let id = base;
  for (let suffix = 2; id in sources; suffix += 1) id = `${base}-${suffix}`;
  return id;
}

/** The hub already at an address, if T3 has one. */
export const hubAt = (url, sources = {}) => Object.entries(sources).find(([, source]) => source?.url === url)?.[0] ?? null;

const failure = (code, message, hint) => ({ ok: false, code, message, hint });
const REFUSED = {
  // Its config hashes this value on startup, so what's in the file now isn't the key.
  rejected: () => failure('rejected', 'The gateway turned this management key down.', 'Use the key you chose, not the API key, and not the hash its config file shows. Five wrong tries lock this server out for 30 minutes.'),
  off: () => failure('off', 'Remote management is off on this gateway.', 'Turn on allow-remote in its config, then try again.'),
  'no-key': () => failure('no-key', 'This gateway has no management key set.', 'Choose one as secret-key in its config, then try again.'),
  banned: wait => failure('banned', 'The gateway has locked this server out for now.', `Too many wrong management keys. ${wait ? `Try again in ${wait}.` : 'Try again in 30 minutes.'}`),
  missing: () => failure('missing', 'This gateway’s management API is off.', 'Limits need CLIProxyAPI with a secret-key in its config.'),
  unreachable: () => failure('unreachable', 'The management API couldn’t be reached.', 'Check that the address is right, then try again.'),
};

/** Why the gateway said 403. Only its fixed phrases are read, and none of its words are shown. */
const refusal = text => {
  if (/banned/i.test(text)) return REFUSED.banned(/in\s+(\d+[hms]\S*)/i.exec(text)?.[1]);
  if (/key not set/i.test(text)) return REFUSED['no-key']();
  return REFUSED.off();
};

/**
 * One request with this key. Never throws. The response can hold credentials, so
 * only each account's provider leaves this function, as a count.
 */
export async function probeHub({ url, key, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(`${url}/v0/management/auth-files`, { redirect: 'manual', headers: { accept: 'application/json', 'user-agent': 't3code-docker-setup', authorization: `Bearer ${key}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  } catch { return REFUSED.unreachable(); }
  if (response.status === 401) { await discard(response); return REFUSED.rejected(); }
  if (response.status === 403) { const body = await readJson(response); return refusal(String(body?.error ?? '')); }
  if (response.status === 404) { await discard(response); return REFUSED.missing(); }
  if (!response.ok) { await discard(response); return REFUSED.unreachable(); }
  const body = await readJson(response), files = Array.isArray(body?.files) ? body.files : null;
  if (!files) return REFUSED.missing();
  const live = files.filter(file => file?.disabled !== true), count = provider => live.filter(file => file?.provider === provider).length;
  return { ok: true, code: 'ok', accounts: { claude: count('claude'), codex: count('codex') } };
}
