// Parse and patch the complete TOML syntax tree. The vendor keeps untouched
// comments/formatting; never scan table boundaries with regular expressions.
import { parse, patch, stringify, TomlDocument } from "../vendor/toml-patch.mjs";
import { isDeepStrictEqual } from "node:util";

const problem = () => Object.assign(new Error("The native config.toml cannot be safely edited. Check its TOML syntax before changing MCP servers."), { code: "unsupported" });
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const plain = (v) => Array.isArray(v) ? v.map(plain)
  : v && Object.getPrototypeOf(v) === null ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
function document(text) {
  try {
    const value = parse(String(text ?? ""));
    if (value.mcp_servers !== undefined && !object(value.mcp_servers)) throw problem();
    return plain(value);
  } catch { throw problem(); } // Parser errors can contain credential values.
}

export function parseMcpToml(text) {
  return new Map(Object.entries(document(text).mcp_servers ?? {}));
}

export function applyMcpToml(text, name, entry) {
  const value = document(text);
  if (entry === null && !Object.hasOwn(value.mcp_servers ?? {}, name)) return text;
  const servers = { ...(value.mcp_servers ?? {}) };
  if (entry === null) delete servers[name];
  else servers[name] = entry;
  const desired = { ...value, mcp_servers: servers };
  if (!Object.keys(servers).length) delete desired.mcp_servers;
  try {
    const tree = new TomlDocument(text).cst;
    const starts = [0];
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
    const lineSpan = (node) => {
      const start = starts[node.loc.start.line - 1];
      const end = starts[node.loc.end.line] ?? text.length;
      return [start, end];
    };
    const owns = (keys) => keys[0] === "mcp_servers" && keys[1] === name;
    const edits = [];
    let inlineRoot = false;
    for (const node of tree) {
      if (node.type === "KeyValue") {
        if (owns(node.key.value)) edits.push([...lineSpan(node), ""]);
        else if (node.key.value.length === 1 && node.key.value[0] === "mcp_servers") {
          // Patch an inline root locally, never the surrounding document.
          const [start, end] = lineSpan(node);
          const updated = desired.mcp_servers ? { mcp_servers: desired.mcp_servers } : {};
          edits.push([start, end, patch(text.slice(start, end), updated)]);
          inlineRoot = true;
        }
      } else if (node.type === "Table" || node.type === "TableArray") {
        const keys = node.key.item.value;
        if (owns(keys)) {
          // The parser attaches comments before the next table to this one.
          // End at its last value, preserving those unrelated trailing notes.
          const rows = node.items.filter((item) => item.type === "KeyValue");
          edits.push([lineSpan(node.key)[0], lineSpan(rows.at(-1) ?? node.key)[1], ""]);
        } else if (keys.length === 1 && keys[0] === "mcp_servers") {
          for (const row of node.items) if (row.type === "KeyValue" && row.key.value[0] === name) edits.push([...lineSpan(row), ""]);
        }
      }
    }
    let next = text;
    for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) next = next.slice(0, start) + replacement + next.slice(end);
    if (entry !== null && !inlineRoot) {
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      // Remove only the known, generated parent marker, not user source.
      const generated = stringify({ mcp_servers: { [name]: entry } }, { inlineTableStart: 3, newLine: eol }).replace(/^\[mcp_servers\]\r?\n(?:\r?\n)?/, "");
      next += (next.endsWith("\n") || !next ? "" : eol) + eol + generated;
    }
    const actual = document(next);
    if (actual.mcp_servers && !Object.keys(actual.mcp_servers).length) delete actual.mcp_servers;
    if (!isDeepStrictEqual(actual, desired)) throw problem();
    return next;
  } catch { throw problem(); }
}
