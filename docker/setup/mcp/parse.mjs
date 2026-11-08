// Import data, never shell code. All formats converge on the same validator.
import Command from '../client/mcp-command.js';
import { parseMcpToml } from './toml.mjs';
import { jsonDocument, containerFor, fromCursorEntry, fromCodexEntry, fromOpenCodeEntry, fromAdditionalEntry, extraMcpOptions } from './adapters.mjs';
import { validateMcpServer } from './store.mjs';

export const SSE_MESSAGE = 'SSE-only servers aren’t portable. Use the server’s Streamable HTTP address.';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const stripState = ({ enabled, ...server }) => server;
const fail = message => { throw new Error(message); };
export function suggestMcpName(argvOrUrl) {
  let name;
  if (typeof argvOrUrl === 'string') {
    const labels = new URL(argvOrUrl).hostname.split('.').slice(0, -1);
    name = labels.find(label => !['www', 'mcp', 'api'].includes(label)) || 'server';
  } else {
    const argv = argvOrUrl, exe = argv[0]?.split('/').at(-1) || '';
    if (['npx', 'bunx', 'uvx'].includes(exe) || (exe === 'pnpm' && argv[1] === 'dlx')) {
      const args = argv.slice(exe === 'pnpm' ? 2 : 1);
      name = args.find(arg => !arg.startsWith('-'));
    } else if (exe === 'docker' && argv[1] === 'run') {
      const valued = new Set(['-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '--network', '-w', '--workdir']);
      for (let at = 2; at < argv.length; at++) {
        if (valued.has(argv[at])) { at++; continue; }
        if (argv[at].startsWith('-')) continue;
        name = argv[at].split('/').at(-1); break;
      }
    } else name = exe;
  }
  return (name || 'server').toLowerCase().replace(/^@[^/]+\//, '').replace(/[@:].*$/, '')
    .replace(/^(mcp-server-|server-)/, '').replace(/(-mcp-server|-mcp|-server)$/, '')
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '') || 'server';
}

function claudeCommand(words) {
  let transport = 'stdio', name, target, command = [], env = {}, headers = {};
  for (let at = 3; at < words.length; at++) {
    const word = words[at];
    if (word === '--') { command = words.slice(at + 1); break; }
    if (['--transport', '-t', '--scope', '-s', '--env', '-e', '--header', '-H'].includes(word)) {
      const value = words[++at]; if (value === undefined) fail('An option is missing its value.');
      if (['--transport', '-t'].includes(word)) transport = value;
      if (['--env', '-e'].includes(word)) {
        const split = value.indexOf('='); if (split < 1) fail('Use NAME=value for each environment variable.');
        const key = value.slice(0, split); if (Object.hasOwn(env, key)) fail('Environment names must be unique.');
        Object.defineProperty(env, key, { value: value.slice(split + 1), enumerable: true, configurable: true });
      }
      if (['--header', '-H'].includes(word)) {
        const split = value.indexOf(':'); if (split < 1) fail('Use Name: value for each header.');
        const key = value.slice(0, split).trim(); if (Object.hasOwn(headers, key)) fail('Header names must be unique.');
        Object.defineProperty(headers, key, { value: value.slice(split + 1).trimStart(), enumerable: true, configurable: true });
      }
    } else if (word.startsWith('-') && !name) fail('That claude mcp add option isn’t supported here.');
    else if (!name) name = word;
    else if (transport === 'http' || transport === 'sse') { if (target) fail('Use one server URL.'); target = word; }
    else { command = words.slice(at); break; }
  }
  if (transport === 'sse') fail(SSE_MESSAGE);
  if (!['http', 'stdio'].includes(transport)) fail('Choose stdio or HTTP transport.');
  if (!name) fail('Include a name after claude mcp add.');
  return transport === 'http' ? { name, type: 'remote', url: target, headers } : { name, type: 'local', command, env };
}

export function parseMcpSnippet(text) {
  const result = { ok: true, format: 'command', servers: [], placeholders: [], notes: [], errors: [] };
  if (typeof text !== 'string') return { ...result, errors: ['Paste a server snippet as text.'] };
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) return { ...result, errors: ['That’s too long to be a server snippet.'] };
  text = text.trim(); if (!text) return result;
  const add = (server, label = '', nativeEntry, provider, v2 = false) => {
    try {
      if (nativeEntry?.type === 'sse' || (server?.url && new URL(server.url).pathname.replace(/\/$/, '').endsWith('/sse'))) fail(SSE_MESSAGE);
      if (server?.url) { const u = new URL(server.url); if (u.username || u.password) fail('Put credentials in a header, not in the URL.'); }
      if (!server) fail('This entry’s format isn’t supported here.');
      if (nativeEntry && (['args'].some(key => nativeEntry[key] !== undefined && (!Array.isArray(nativeEntry[key]) || !nativeEntry[key].every(v => typeof v === 'string')))
        || ['env', 'environment', 'headers', 'http_headers'].some(key => nativeEntry[key] !== undefined && (!object(nativeEntry[key]) || !Object.values(nativeEntry[key]).every(v => typeof v === 'string'))))) fail('This entry’s format isn’t supported here.');
      const checked = validateMcpServer(server); if (!checked.ok) fail(checked.error);
      result.servers.push(stripState(checked.server));
      for (const [prop, prefix] of [['env', 'env'], ['headers', 'header']]) for (const [key, value] of Object.entries(server[prop] || {})) {
        if (Command.placeholder(value)) result.placeholders.push(prefix + '.' + key);
        if (/\$\{[^}]+\}/.test(value)) result.notes.push('Variable references are resolved differently by each agent. Check them before starting a session.');
      }
      if (nativeEntry && provider) {
        const extra = extraMcpOptions(provider, nativeEntry, v2);
        if (extra.length) result.notes.push('Native options not included: ' + extra.join(', ') + '.');
      }
    } catch (error) { result.errors.push((label ? label + ': ' : '') + (error instanceof TypeError ? 'Use a valid HTTP server URL.' : error.message)); }
  };
  const jsonEntry = (name, entry, provider) => {
    provider ||= entry?.serverUrl !== undefined || entry?.disabled !== undefined ? 'antigravity'
      : entry?.enabled !== undefined || entry?.type === 'streamable-http' ? 'pi' : 'cursor';
    add(provider === 'cursor' ? fromCursorEntry(name, entry) : fromAdditionalEntry(provider, name, entry), name, entry, provider);
  };
  try {
    if (/^\s*\[\s*mcp_servers[.\s]/m.test(text)) {
      result.format = 'codex-toml';
      let entries; try { entries = parseMcpToml(text); } catch { fail('Couldn’t read that as Codex TOML. Check that it’s complete.'); }
      if (entries.size > 128) fail('Import at most 128 servers at a time.');
      for (const [name, entry] of entries) {
        const grok = entry.headers !== undefined;
        add(grok ? fromAdditionalEntry('grok', name, entry) : fromCodexEntry(name, entry), name, entry, grok ? 'grok' : 'codex');
      }
    } else if (/^[{[]/.test(text)) {
      result.format = 'json';
      let value; try { value = jsonDocument(text, false); } catch { fail('Couldn’t read that as JSON. Check that it’s complete.'); }
      if (value.mcpServers !== undefined || value.mcp_servers !== undefined) {
        const muse = value.mcp_servers !== undefined;
        result.format = muse ? 'muse-json' : 'claude-json';
        const { entries } = containerFor('muse', value);
        if (Object.keys(entries).length > 128) fail('Import at most 128 servers at a time.');
        for (const [name, entry] of Object.entries(entries)) jsonEntry(name, entry, muse ? 'muse' : undefined);
      } else if (object(value.mcp)) {
        result.format = 'opencode-json';
        const { entries, v2 } = containerFor('opencode', value);
        if (Object.keys(entries).length > 128) fail('Import at most 128 servers at a time.');
        for (const [name, entry] of Object.entries(entries)) add(fromOpenCodeEntry(name, entry, v2), name, entry, 'opencode', v2);
      } else if (Object.keys(value).length && Object.values(value).every(object)) {
        if (Object.keys(value).length > 128) fail('Import at most 128 servers at a time.');
        for (const [name, entry] of Object.entries(value)) jsonEntry(name, entry);
      } else {
        const name = suggestMcpName(value.serverUrl || value.url || [value.command || 'server', ...(Array.isArray(value.args) ? value.args : [])]);
        jsonEntry(name, value);
      }
    } else if (/^https?:\/\/\S+$/.test(text)) {
      result.format = 'url'; add({ name: suggestMcpName(text), type: 'remote', url: text, headers: {} });
    } else {
      const words = Command.lex(text);
      if (words.slice(0, 3).join(' ') === 'claude mcp add') { result.format = 'claude-mcp-add'; add(claudeCommand(words)); }
      else {
        add({ name: suggestMcpName(words), type: 'local', command: words, env: {} });
        if (words[0] === 'docker' && words[1] === 'run') for (let at = 2; at < words.length - 1; at++)
          if (['-e', '--env'].includes(words[at]) && !words[at + 1].includes('=')) result.notes.push('Add ' + words[++at] + ' as an environment variable if it isn’t already set in the container.');
      }
    }
  } catch (error) { result.errors.push(error.message); }
  result.placeholders = [...new Set(result.placeholders)]; result.notes = [...new Set(result.notes)];
  return result;
}
