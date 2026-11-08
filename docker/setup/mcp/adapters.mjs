// Provider-native config translation. Inventory is read-only; explicit apply
// and unlink use revision-checked, symlink-preserving native-settings writes.
import path from "node:path";
import { parse, parseTree, modify, applyEdits } from "../vendor/jsonc.mjs";
import { parseMcpToml, applyMcpToml } from "./toml.mjs";
import { readConfig, changeConfig } from "./files.mjs";
import { validateMcpServer, SUPPORTED_MCP_PROVIDERS } from "./store.mjs";
import { agentResourcePaths } from "../agent-resources.mjs";
import { parse as parseToml, patch as patchToml } from "../vendor/toml-patch.mjs";
import { opencodeConfigRoot } from "../opencode-config.mjs";

const problem = (code, message) => Object.assign(new Error(message), { code });
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const homeOf = (home, env) => path.resolve(home || env.HOME || "/home/t3");
export const claudeMcpPath = (home, env) => env.CLAUDE_CONFIG_DIR?.trim()
  ? path.join(path.resolve(homeOf(home, env), env.CLAUDE_CONFIG_DIR), ".claude.json") : path.join(homeOf(home, env), ".claude.json");
export const codexMcpPath = (home, env) => path.join(path.resolve(homeOf(home, env), env.CODEX_HOME || ".codex"), "config.toml");
export const cursorMcpPath = (home, env) => path.join(agentResourcePaths(homeOf(home, env), env).cursor, "mcp.json");
export const openCodeConfigPath = async (io, home, env) => {
  const root = opencodeConfigRoot(homeOf(home, env), env);
  const jsonc = path.join(root, "opencode.jsonc");
  try { await io.lstat(jsonc); return { file: jsonc, jsonc: true }; }
  catch (e) { if (e.code !== "ENOENT") throw e; return { file: path.join(root, "opencode.json"), jsonc: false }; }
};

export function toClaudeEntry(s) {
  return s.type === "local" ? { command: s.command[0], args: s.command.slice(1), ...(Object.keys(s.env).length ? { env: { ...s.env } } : {}) }
    : { type: "http", url: s.url, ...(Object.keys(s.headers).length ? { headers: { ...s.headers } } : {}) };
}
export function fromClaudeEntry(name, entry) {
  if (!object(entry)) return null;
  if (entry.type && !["http", "streamable-http", "stdio"].includes(entry.type)) return null;
  if (["http", "streamable-http"].includes(entry.type) && typeof entry.url === "string" && /^https?:\/\//.test(entry.url)) return { name, type: "remote", url: entry.url, headers: { ...(entry.headers ?? {}) }, enabled: true };
  if (typeof entry.command === "string" && entry.command) return { name, type: "local", command: [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])], env: { ...(entry.env ?? {}) }, enabled: true };
  return null;
}
export function toCodexEntry(s, enabled = s.enabled !== false) {
  const entry = s.type === "local" ? { command: s.command[0], args: s.command.slice(1), ...(Object.keys(s.env).length ? { env: { ...s.env } } : {}) }
    : { url: s.url, ...(Object.keys(s.headers).length ? { http_headers: { ...s.headers } } : {}) };
  if (!enabled) entry.enabled = false;
  return entry;
}
export function fromCodexEntry(name, entry) {
  if (!object(entry)) return null;
  if (typeof entry.url === "string" && entry.url) return { name, type: "remote", url: entry.url, headers: { ...(entry.http_headers ?? {}) }, enabled: entry.enabled !== false };
  if (typeof entry.command === "string" && entry.command) return { name, type: "local", command: [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])], env: { ...(entry.env ?? {}) }, enabled: entry.enabled !== false };
  return null;
}
export function toOpenCodeEntry(s, v2 = false, enabled = s.enabled !== false) {
  const state = v2 ? { disabled: !enabled } : { enabled };
  return s.type === "local" ? { type: "local", command: [...s.command], ...(Object.keys(s.env).length ? { environment: { ...s.env } } : {}), ...state }
    : { type: "remote", url: s.url, ...(Object.keys(s.headers).length ? { headers: { ...s.headers } } : {}), ...state };
}
export function fromOpenCodeEntry(name, entry, v2 = false) {
  if (!object(entry)) return null;
  // The legacy loader can discard the other layout's state flag. It must
  // not make inventory claim that a shared disabled definition was applied.
  const enabled = v2 ? entry.disabled !== true : entry.enabled !== false;
  if (entry.type === "remote" && typeof entry.url === "string") return { name, type: "remote", url: entry.url, headers: { ...(entry.headers ?? {}) }, enabled };
  if (entry.type === "local" && Array.isArray(entry.command)) return { name, type: "local", command: [...entry.command], env: { ...(entry.environment ?? {}) }, enabled };
  return null;
}
export const toCursorEntry = toClaudeEntry;
// Cursor accepts a remote URL without an explicit transport selector.
export function fromCursorEntry(name, entry) {
  if (!object(entry) || (entry.type !== undefined && !["http", "stdio"].includes(entry.type))) return null;
  return fromClaudeEntry(name, entry.type === undefined && typeof entry.url === "string" ? { ...entry, type: "http" } : entry);
}
// These native formats infer transport from command/url and keep their own
// per-server enabled flags. Antigravity names the remote endpoint serverUrl.
export function toAdditionalEntry(provider, server, enabled = true) {
  const entry = toClaudeEntry(server);
  delete entry.type;
  if (provider === "antigravity") {
    if (entry.url) { entry.serverUrl = entry.url; delete entry.url; }
    if (!enabled) entry.disabled = true;
  } else if (!enabled) entry.enabled = false;
  return entry;
}
export function fromAdditionalEntry(provider, name, entry) {
  if (!object(entry)) return null;
  if (entry.command !== undefined && (entry.url !== undefined || entry.serverUrl !== undefined)) return null;
  if (entry.type !== undefined && !["stdio", "http", "streamable-http"].includes(entry.type)) return null;
  const url = provider === "antigravity" ? entry.serverUrl ?? entry.url : entry.url;
  const canonical = typeof url === "string" ? { name, type: "remote", url, headers: { ...(entry.headers ?? {}) }, enabled: true }
    : typeof entry.command === "string" && entry.command ? { name, type: "local", command: [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])], env: { ...(entry.env ?? {}) }, enabled: true } : null;
  if (canonical) canonical.enabled = provider === "antigravity" ? entry.disabled !== true : entry.enabled !== false;
  return canonical;
}
export const isSupportedMcpProvider = (provider) => SUPPORTED_MCP_PROVIDERS.includes(provider);

export function jsonDocument(raw, strict) {
  const errors = [];
  const tree = parseTree(raw || "{}", errors, { allowTrailingComma: !strict, disallowComments: strict });
  const check = (node) => {
    if (node.type === "object") {
      const keys = node.children.map((p) => p.children[0].value);
      if (new Set(keys).size !== keys.length) throw problem("unsupported", "Duplicate keys in the MCP configuration. Repair them before changing servers.");
    }
    for (const child of node.children ?? []) check(child);
  };
  if (errors.length || tree?.type !== "object") throw problem("unsupported", "The MCP configuration is not a valid JSON object. Repair it before changing servers.");
  check(tree);
  return parse(raw || "{}", [], { allowTrailingComma: !strict, disallowComments: strict });
}

export function containerFor(provider, value) {
  // The Antigravity loader accepts both a wrapped dictionary and the older
  // direct server map. Keep the existing format instead of shadowing it.
  if (provider === "antigravity" && value.mcpServers === undefined && Object.keys(value).length) return { v2: false, keys: [], entries: value };
  if (provider === "muse" && value.mcp_servers !== undefined && value.mcpServers !== undefined) throw problem("unsupported", "Muse has both mcpServers and mcp_servers. Keep one server section before changing servers.");
  const key = provider === "opencode" ? "mcp" : provider === "muse" && value.mcp_servers !== undefined ? "mcp_servers" : "mcpServers";
  const root = value[key];
  if (root !== undefined && !object(root)) throw problem("unsupported", "The MCP configuration has an unsupported server section.");
  // V1 may contain a real server named 'servers'. Its transport distinguishes
  // that entry from V2's server dictionary. Never rewrite V2 back to V1.
  const v2 = provider === "opencode" && ["servers", "timeout", "codemode", "protocol"].some((key) =>
    Object.hasOwn(root ?? {}, key) && !["local", "remote"].includes(root[key]?.type));
  if (v2 && root.servers !== undefined && !object(root.servers)) throw problem("unsupported", "The OpenCode V2 server dictionary must be an object.");
  if (v2 && Object.keys(root).some((k) => !["servers", "timeout", "codemode", "protocol"].includes(k))) {
    throw problem("unsupported", "OpenCode mixes V1 and V2 MCP entries. Repair its MCP section before changing servers.");
  }
  return { v2, keys: v2 ? [key, "servers"] : [key], entries: v2 ? root.servers ?? {} : root ?? {} };
}

async function fileFor(io, provider, home, env) {
  if (provider === "opencode") return (await openCodeConfigPath(io, home, env)).file;
  if (provider === "codex") return codexMcpPath(home, env);
  if (provider === "claude") return claudeMcpPath(home, env);
  if (provider === "cursor") return cursorMcpPath(home, env);
  const roots = agentResourcePaths(homeOf(home, env), env);
  if (provider === "grok") return path.join(roots.grok, "config.toml");
  if (provider === "muse") return path.join(roots.muse, "settings.json");
  if (provider === "pi") return path.join(roots.pi, "mcp.json");
  if (provider === "antigravity") return path.join(roots.antigravity, "mcp_config.json");
  throw problem("unsupported", "MCP management is not supported for this provider.");
}

// Unknown provider options must be shown as differing, rather than implying
// that cwd/auth/tool-policy differences are represented by the shared entry.
export function extraMcpOptions(provider, entry, v2 = false) {
  const remote = typeof entry?.url === "string" || typeof entry?.serverUrl === "string";
  const keys = provider === "codex" ? [...(remote ? ["url", "http_headers"] : ["command", "args", "env"]), "enabled"]
    : provider === "opencode" ? [...(remote ? ["url", "headers"] : ["command", "environment"]), "type", v2 ? "disabled" : "enabled"]
      : [...(remote ? ["url", "headers", ...(provider === "antigravity" ? ["serverUrl"] : [])] : ["command", "args", "env"]), "type", ...(["grok", "muse", "pi"].includes(provider) ? ["enabled"] : provider === "antigravity" ? ["disabled"] : [])];
  return object(entry) ? Object.keys(entry).filter((k) => !keys.includes(k)) : [];
}
export const hasExtraMcpOptions = (provider, entry, v2 = false) => !object(entry) || extraMcpOptions(provider, entry, v2).length > 0;

export async function readProviderMcp(io, provider, { home, env = {} }) {
  const file = await fileFor(io, provider, home, env);
  const snapshot = await readConfig(io, file);
  let entries, v2 = false;
  if (["codex", "grok"].includes(provider)) entries = [...parseMcpToml(snapshot.content)];
  else {
    const value = jsonDocument(snapshot.content, provider !== "opencode");
    if (provider === "muse" && value.schema_version !== undefined && value.schema_version !== 1) throw problem("unsupported", "This Muse settings schema is not supported. Existing settings were preserved.");
    const container = containerFor(provider, value);
    entries = Object.entries(container.entries); v2 = container.v2;
  }
  const from = provider === "codex" ? fromCodexEntry : provider === "opencode" ? (name, entry) => fromOpenCodeEntry(name, entry, v2) : provider === "cursor" ? fromCursorEntry : provider === "claude" ? fromClaudeEntry : (name, entry) => fromAdditionalEntry(provider, name, entry);
  // Grok keeps a personal disable list in addition to per-entry switches.
  const disabled = provider === "grok" ? parseToml(snapshot.content || "").disabled_mcp_servers ?? [] : [];
  if (!Array.isArray(disabled) || !disabled.every(name => typeof name === "string")) throw problem("unsupported", "Grok disabled_mcp_servers must be a list of names.");
  return { provider, path: file, present: snapshot.exists, revision: snapshot.revision,
    servers: entries.map(([name, entry]) => {
      const canonical = from(name, entry);
      if (canonical && disabled.includes(name)) canonical.enabled = false;
      const malformed = !object(entry)
        || ['enabled', 'disabled'].some(k => entry[k] !== undefined && typeof entry[k] !== 'boolean')
        || (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every(a => typeof a === 'string')))
        || ['env', 'environment', 'headers', 'http_headers'].some(k => entry[k] !== undefined &&
          (!object(entry[k]) || ![null, Object.prototype].includes(Object.getPrototypeOf(entry[k])) || !Object.values(entry[k]).every(v => typeof v === 'string')))
        || (['claude', 'cursor'].includes(provider) && entry.type !== undefined &&
          !(canonical?.type === 'remote' ? ['http', 'streamable-http'] : ['stdio']).includes(entry.type));
      return { name, entry, canonical: !malformed && canonical && validateMcpServer(canonical).ok ? canonical : null,
        extra: hasExtraMcpOptions(provider, entry, v2), extraOptions: extraMcpOptions(provider, entry, v2) };
    }) };
}

export async function writeProviderMcpEntry(io, provider, { home, env = {} }, name, entry, { revision } = {}) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw problem("invalid", "Invalid MCP server name.");
  const file = await fileFor(io, provider, home, env);
  return changeConfig(io, file, revision, (raw) => {
    if (["codex", "grok"].includes(provider)) {
      if (provider === "grok" && !/^[a-z]/.test(name)) throw problem("unsupported", "Grok Build server names must start with a letter.");
      let next = applyMcpToml(raw, name, entry);
      if (provider === "grok") {
        const value = parseToml(next), disabled = value.disabled_mcp_servers;
        if (disabled !== undefined) {
          if (!Array.isArray(disabled) || !disabled.every(name => typeof name === "string")) throw problem("unsupported", "Grok disabled_mcp_servers must be a list of names.");
          // An explicit on/off save owns this server's personal state only.
          next = patchToml(next, { ...value, disabled_mcp_servers: disabled.filter(item => item !== name) });
        }
      }
      return next;
    }
    if (provider === "pi" && name === "t3-code") throw problem("unsupported", "The t3-code server is owned by T3. Choose a different server name.");
    const value = jsonDocument(raw, provider !== "opencode");
    if (provider === "muse" && value.schema_version !== undefined && value.schema_version !== 1) throw problem("unsupported", "This Muse settings schema is not supported. Existing settings were preserved.");
    const container = containerFor(provider, value);
    let nextEntry = entry;
    if (entry && container.v2) {
      const { enabled, ...rest } = entry;
      nextEntry = { ...rest, disabled: enabled === false };
    }
    if (!entry && !Object.hasOwn(container.entries, name)) return raw;
    const eol = (raw || "").includes("\r\n") ? "\r\n" : "\n";
    const formattingOptions = { insertSpaces: true, tabSize: 2, eol };
    let text = raw || "{}\n";
    if (provider === "muse" && value.schema_version === undefined) text = applyEdits(text, modify(text, ["schema_version"], 1, { formattingOptions }));
    return applyEdits(text, modify(text, [...container.keys, name], nextEntry ?? undefined, { formattingOptions }));
  });
}
