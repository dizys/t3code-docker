// Docker Hub repository metadata is separate from registry manifests. Keep the
// README as its source, and never submit an empty or truncated replacement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { REPOSITORY } from './dockerhub-release.mjs';

export const DESCRIPTION = 'T3 Code server with coding agents, persistent toolchains, a browser and a web setup console.';
export const OVERVIEW_URL = `https://hub.docker.com/r/${REPOSITORY}`;
const PUBLIC_API = 'https://hub.docker.com/v2/namespaces/dizys/repositories/t3code-docker';
const UPDATE_API = `https://hub.docker.com/v2/repositories/${REPOSITORY}/`;
const AUTH_API = 'https://hub.docker.com/v2/auth/token';

function validate(content) {
  assert.equal(typeof content?.full_description, 'string', 'README content is required');
  assert.ok(content.full_description.replace(/<!--[\s\S]*?-->/g, '').trim(), 'Refusing to publish an empty Overview');
  assert.ok(Buffer.byteLength(content.full_description) <= 25_000, 'Overview exceeds Docker Hub’s 25,000-byte limit; shorten the README instead of truncating it');
  assert.ok(typeof content.description === 'string' && content.description.trim(), 'A short description is required');
  assert.ok(Buffer.byteLength(content.description) <= 100, 'Short description exceeds Docker Hub’s 100-byte limit');
}

/** Rewrite only prose, preserving fenced examples and inline code verbatim. */
function proseOnly(markdown, transform) {
  let fence = null, prose = '', result = '';
  const flush = () => {
    const code = [];
    const protectedText = prose.replace(/(`+)[\s\S]*?\1(?!`)/g, (value) => `\0${code.push(value) - 1}\0`);
    result += transform(protectedText).replace(/\0(\d+)\0/g, (_, index) => code[Number(index)]);
    prose = '';
  };
  for (const line of markdown.match(/[^\n]*(?:\n|$)/g).filter(Boolean)) {
    const marker = line.replace(/\n$/, '').match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      result += line;
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) {
      flush(); fence = marker[1]; result += line;
    } else prose += line;
  }
  flush();
  return result;
}

/** Inline links, including nested image labels and balanced URL parentheses.
 * This changes destinations, not Markdown rendering or executable examples. */
function markdownLinks(text, resolve) {
  let result = '', cursor = 0;
  for (let at = 0; at < text.length; at++) {
    const image = text[at] === '!' && text[at + 1] === '[';
    const start = at + (image ? 1 : 0);
    if (text[start] !== '[' || text[at - 1] === '\\') continue;
    let depth = 1, end = start + 1;
    for (; end < text.length && depth; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '[') depth++;
      if (text[end] === ']') depth--;
    }
    if (depth || text[end] !== '(') continue;
    let begin = end + 1;
    while (/[ \t]/.test(text[begin] ?? 'x')) begin++;
    const angled = text[begin] === '<';
    let stop = begin + (angled ? 1 : 0), parentheses = 0;
    for (; stop < text.length; stop++) {
      const char = text[stop];
      if (char === '\\') { stop++; continue; }
      if (angled ? char === '>' : /\s/.test(char) || (char === ')' && parentheses === 0)) break;
      if (char === '(') parentheses++;
      if (char === ')') parentheses--;
    }
    const after = stop + (angled ? 1 : 0);
    const closing = text.slice(after).match(/^[ \t]*(?:(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\))[ \t]*)?\)/);
    if (!closing || (angled && text[stop] !== '>')) continue;
    const url = text.slice(begin + (angled ? 1 : 0), stop);
    const label = markdownLinks(text.slice(start + 1, end - 1), resolve);
    const rewritten = resolve(url.replace(/\\([\\()[\]<> ])/g, '$1'), image);
    result += text.slice(cursor, at) + (image ? '!' : '') + '[' + label + text.slice(end - 1, begin);
    result += rewritten === url ? text.slice(begin, after) : `<${rewritten}>`;
    result += closing[0];
    cursor = after + closing[0].length;
    at = cursor - 1;
  }
  return result + text.slice(cursor);
}

export function overviewFromReadme(readme, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/, 'An exact README source commit is required');
  assert.equal(typeof readme, 'string', 'README content is required');
  assert.ok(!readme.includes('\0'), 'README contains an invalid NUL byte');
  const root = `https://github.com/${REPOSITORY}/blob/${sourceSha}/`;
  const images = `https://raw.githubusercontent.com/${REPOSITORY}/${sourceSha}/`;
  const resolve = (url, image = false) => {
    if (!url || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return url;
    if (/^[#?]/.test(url)) return root + 'README.md' + url;
    const relative = url.replace(/^\/+/, '');
    const pathname = decodeURIComponent(relative.split(/[?#]/)[0]);
    const normalized = posix.normalize(pathname);
    assert.ok(normalized !== '..' && !normalized.startsWith('../'), 'README link escapes the repository');
    return new URL(relative, image ? images : root).href;
  };
  const full_description = proseOnly(readme.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), (text) => {
    const html = text.replace(/<[a-z][^>]*>/gi, (tag) => tag.replace(/\b(href|src|srcset)\s*=\s*(["'])(.*?)\2/gi, (_, attr, quote, value) => {
      const converted = attr.toLowerCase() === 'srcset' && !/^data:/i.test(value)
        ? value.split(',').map((item) => item.trim().replace(/^(\S+)/, (url) => resolve(url, true))).join(', ')
        : resolve(value, attr.toLowerCase() !== 'href');
      return `${attr}=${quote}${converted}${quote}`;
    }));
    const imageReferences = new Set([...html.matchAll(/!\[([^\]\n]+)\](?:\[([^\]\n]*)\])?(?!\()/g)]
      .map((match) => (match[2] || match[1]).trim().replace(/\s+/g, ' ').toLowerCase()));
    const portable = html.replace(/^(>[ \t]*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/gm, (_, quote, kind) => quote + '**' + kind[0] + kind.slice(1).toLowerCase() + ':**');
    return markdownLinks(portable, resolve).replace(/^([ \t]{0,3}\[([^\]\n]+)\]:[ \t]*)(<[^>\n]+>|\S+)/gm, (original, prefix, label, destination) => {
      if (label.startsWith('^')) return original; // A footnote definition is prose, not a link destination.
      const url = destination.replace(/^<|>$/g, '');
      const image = imageReferences.has(label.trim().replace(/\s+/g, ' ').toLowerCase()) || /\.(?:png|jpe?g|gif|svg|webp|avif)(?:[?#]|$)/i.test(url);
      return prefix + '<' + resolve(url, image) + '>';
    });
  }).trim() + '\n';
  const content = { description: DESCRIPTION, full_description };
  validate(content);
  return content;
}

const sameContent = (actual, expected) => actual.description === expected.description
  && typeof actual.full_description === 'string'
  && actual.full_description.trim() === expected.full_description.trim();

/** Only fixed Docker Hub endpoints receive credentials. Public reads never do.
 * Retry transient failures, not authorization errors; repeated PATCHes are
 * idempotent and always contain the same validated, nonempty document. */
export async function syncOverview(content, {
  username = 'dizys', token, dryRun = false, check = false,
  fetcher = fetch, wait = pause,
} = {}) {
  validate(content);
  const request = async (url, options = {}) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetcher(url, { ...options, headers: { Accept: 'application/json', ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      } catch {
        if (attempt < 2) { await wait(1000 * 2 ** attempt); continue; }
        throw new Error('Docker Hub request failed or timed out. No credentials were logged; retry the Overview sync.');
      }
      if (response.ok) {
        if (options.method === 'PATCH') { await response.body?.cancel(); return null; } // Public read-back is the proof.
        try { return await response.json(); }
        catch { throw new Error('Docker Hub returned invalid metadata. Retry the Overview sync.'); }
      }
      await response.body?.cancel();
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await wait(1000 * 2 ** attempt); continue;
      }
      throw new Error(`Docker Hub ${options.method ?? 'GET'} failed (HTTP ${response.status}).${[401, 403].includes(response.status) ? ' Check DOCKERHUB_TOKEN and its repository permissions.' : ''}`);
    }
  };
  const read = async () => {
    const actual = await request(PUBLIC_API, { headers: { 'Cache-Control': 'no-cache' } });
    assert.ok(actual && actual.namespace === 'dizys' && actual.name === 't3code-docker' && actual.is_private === false, 'Expected the public dizys/t3code-docker repository');
    return actual;
  };
  const before = await read();
  const matches = sameContent(before, content);
  const evidence = {
    repository: REPOSITORY, url: OVERVIEW_URL,
    sha256: createHash('sha256').update(content.full_description).digest('hex'),
    bytes: Buffer.byteLength(content.full_description),
    dryRun, changed: false, matches, verified: matches,
  };
  if (check && !matches) throw new Error('Docker Hub Overview is empty or out of date. Run the Overview sync.');
  if (dryRun || check || matches) return evidence;
  assert.ok(typeof token === 'string' && token.trim(), 'Set the existing DOCKERHUB_TOKEN Actions secret to publish the Overview');
  assert.ok(typeof username === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(username), 'Set DOCKERHUB_USERNAME to the Docker Hub login');
  const session = await request(AUTH_API, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, secret: token }),
  });
  assert.ok(session && typeof session.access_token === 'string' && /^[A-Za-z0-9._-]+$/.test(session.access_token), 'Docker Hub did not issue a valid metadata access token');
  await request(UPDATE_API, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(content),
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    if (sameContent(await read(), content)) return { ...evidence, changed: true, matches: true, verified: true };
    if (attempt < 3) await wait(1000 * 2 ** attempt);
  }
  throw new Error('Docker Hub accepted the Overview, but the public page does not match. Retry the Overview sync.');
}
