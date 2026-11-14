// Reading the setup key and mount prefix off a request.
//
// The cookie carries encodeURIComponent(KEY) so any key validKey allows -
// printable ASCII, so `@`, `#`, `%`, even `=` and `;` - survives as one
// cookie value. Comparing the raw cookie against the raw key locked those
// keys out after the first login, and splitting on every `=` dropped a
// value containing one outright. Splitting on the first `=` and decoding
// makes the round-trip work for every valid key. A value that is not valid
// percent-encoding cannot be the cookie /login set, but falls back to the
// raw text so a hand-set cookie carrying the key itself still works.
//
// `forwardedPrefix` is the mount a path-rewriting proxy declares in
// X-Forwarded-Prefix. `mount` becomes the cookie Path, redirect targets and
// the page's own links, so a prefix that is not a plain path on this origin
// - dot segments, empty segments (which make it protocol-relative), a
// backslash - is refused rather than echoed, as the router already refuses
// them in T3_SETUP_BASE_PATH.

/** The decoded value of one named cookie, or undefined when it is absent. */
export function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * The prefix a proxy says it rewrote away, or "" when it said nothing
 * usable. A proxy that rewrites the path is supposed to say so: nginx and
 * Traefik send X-Forwarded-Prefix, and when the path itself no longer
 * carries the prefix, that header is the only thing left that knows it.
 *
 * Only believed when `trusted` - from a direct peer the header is the
 * visitor's own words, and must not become the cookie path or where
 * redirects point. Callers pass whether the socket peer is loopback
 * (client-address.mjs); the default keeps existing callers' behavior.
 */
export function forwardedPrefix(headers, { trusted = true } = {}) {
  if (!trusted) return "";
  const raw = headers?.["x-forwarded-prefix"];
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^\/[\w\-./~]*$/.test(trimmed)) return "";
  // One non-empty segment at a time, none of them "." or "..": "//host"
  // would turn the next redirect into an absolute URL for that host.
  if (trimmed.split("/").slice(1).some((segment) => segment === "" || segment === "." || segment === "..")) return "";
  return trimmed;
}

/**
 * The scheme a proxy says the visitor used, lowercased, or "" when it said
 * nothing. Only believed when `trusted`: from a direct peer the header is
 * the visitor's own words, and must not decide the session cookie's Secure
 * flag - a forged `https` over plain HTTP would set a cookie the browser
 * then never sends back, and every login silently "fails".
 */
export function forwardedProto(headers, { trusted = true } = {}) {
  if (!trusted) return "";
  const raw = headers?.["x-forwarded-proto"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first ?? "").split(",")[0].trim().toLowerCase();
}

/**
 * The host to show: what a proxy says the visitor asked for, else the Host
 * the client sent here. Only believed when `trusted`: from a direct peer
 * the header is the visitor's own words.
 */
export function forwardedHost(headers, { trusted = true } = {}) {
  const direct = headers?.host;
  const fallback = Array.isArray(direct) ? direct[0] : direct;
  if (!trusted) return fallback;
  const forwarded = headers?.["x-forwarded-host"];
  const value = forwarded ?? fallback;
  return Array.isArray(value) ? value[0] : value;
}
