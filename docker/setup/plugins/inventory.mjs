// Passive filesystem plugin inventory for Setup's Plugins area.
//
// Safety contract: this module NEVER executes plugin code. It never spawns
// provider binaries, never imports plugin modules, never connects to MCP
// servers and never fetches the network. It only stats directories, resolves
// links, and reads small manifest/config files as bounded text. Anything it
// cannot verify (loaded/enabled state, remote sources) is reported as
// unknown with a warning, never synthesized.
import path from "node:path";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { parse as parseJsonc } from "../vendor/jsonc.mjs";
import { parse as parseToml } from "../vendor/toml-patch.mjs";
const AGENT_NAMES = {codex:"Codex",claude:"Claude Code",opencode:"OpenCode",cursor:"Cursor",grok:"Grok Build",muse:"Muse Code",pi:"Pi",antigravity:"Antigravity"};


const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const summary = (error) => String(error?.message || error).slice(0, 240);
const text = (value, limit) => typeof value === "string" && value.length <= limit;
const clean = (value, limit) => (text(value, limit) ? value.trim().slice(0, limit) || null : null);

const LIMITS = Object.freeze({
  entries: 2048, // readdir entries inspected per list() call
  plugins: 128, // plugin directories inspected per list() call
  manifestBytes: 64 * 1024, // per-manifest read cap
  configBytes: 1024 * 1024, // per-registry/config read cap
  bytes: 4 * 1024 * 1024, // total manifest/config bytes per list() call
  components: 256, // components recorded per plugin
  dirEntries: 64, // entries inspected per conventional component dir
  warnings: 30, // warnings retained per provider
});

const PROVIDER_IDS = Object.keys(AGENT_NAMES);

// Manifest locations, in priority order. The first readable manifest wins;
// its format and path are retained on the plugin record. package.json covers
// OpenCode/Pi-style JS packages; it is checked last so explicit plugin
// manifests always take precedence.
const MANIFESTS = Object.freeze([
  { file: "plugin.json", format: "plugin.json" },
  { file: ".codex-plugin/plugin.json", format: ".codex-plugin/plugin.json" },
  { file: ".claude-plugin/plugin.json", format: ".claude-plugin/plugin.json" },
  { file: ".cursor-plugin/plugin.json", format: ".cursor-plugin/plugin.json" },
  { file: ".antigravity-plugin/plugin.json", format: ".antigravity-plugin/plugin.json" },
  { file: "package.json", format: "package.json" },
]);

// Conventional component locations inspected without executing anything.
// Only names and relative paths are recorded; file bodies, hook commands,
// MCP endpoints and environment values are never read into the inventory.
const COMPONENT_DIRS = Object.freeze({
  skills: "skill", agents: "agent", hooks: "hook", commands: "command", rules: "rule", prompts: "prompt", extensions: "extension",
});
const MCP_FILES = Object.freeze(["mcp.json", ".mcp.json"]);
// Manifest keys that describe components we inspect (or benign package
// metadata). Any other object/array-valued key means the manifest declares
// behavior this filesystem pass cannot verify, which is surfaced as a
// provider warning instead of a zero-component claim.
const BENIGN_KEYS = new Set(["name", "description", "version", "author", "authors", "license", "homepage", "repository", "keywords", "marketplace", "private", "type", "main", "exports"]);
const COMPONENT_KEYS = new Set(["skills", "agents", "hooks", "commands", "rules", "prompts", "extensions", "mcp", "mcps", "pi"]);

const inside = (parent, file) => {
  const relative = path.relative(parent, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const stableId = (provider, resolved) => digest(`${provider}\0${resolved}`).slice(0, 32);

function warn(state, message) {
  if (state.warnings.length < LIMITS.warnings && !state.warnings.includes(message)) state.warnings.push(message);
}

// Stat, open without following links or blocking on FIFOs, fstat, bounded read.
async function readBoundedFile(io, file, maxBytes) {
  const check = (stat) => {
    if (!stat.isFile()) throw fail("invalid", "Not a regular file.");
    if (stat.size > maxBytes) throw fail("too_large", "File exceeds the read limit.");
  };
  check(await io.stat(file));
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    check(stat);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > maxBytes) throw fail("too_large", "File exceeds the read limit.");
    return { content: buffer.toString("utf8", 0, bytes), bytes, stamp: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs].join(":") };
  } finally {
    await handle.close();
  }
}

async function readDirEntries(io, directory) {
  try {
    const entries=[];
    for await (const entry of await io.opendir(directory)) {
      if(entries.length>=LIMITS.entries)throw fail("too_large","Directory exceeds the inspection limit.");
      entries.push(entry);
    }
    return entries;
  } catch (error) {
    if (error?.code === "ENOENT") return null; // not installed; not an error
    throw error;
  }
}

function manifestFields(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return {};
  const name = clean(manifest.name, 256);
  const description = clean(manifest.description, 2048);
  const version = clean(typeof manifest.version === "number" ? String(manifest.version) : manifest.version, 128);
  return { name, description, version };
}

async function inspectComponents(io, resolved, state) {
  const components = [];
  const push = (type, name, relative) => {
    if (components.length >= LIMITS.components) return false;
    if (!text(name, 256) || !name || name.includes("\0")) return true;
    components.push({ type, name: name.slice(0, 256), path: relative.split(path.sep).join("/") });
    return true;
  };
  for (const [directory, type] of Object.entries(COMPONENT_DIRS)) {
    if (components.length >= LIMITS.components) { warn(state, `Component listing stopped at ${LIMITS.components} entries; some components may be missing.`); break; }
    const componentRoot = await io.realpath(path.join(resolved,directory)).catch(()=>null);
    if(!componentRoot || !inside(resolved,componentRoot))continue;
    const entries = await readDirEntries(io, componentRoot).catch(() => null);
    if (!entries) continue;
    let seen = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (++seen > LIMITS.dirEntries) { warn(state, `The ${directory} directory exceeds the inspection limit; some entries were skipped.`); break; }
      const full = path.join(resolved, directory, entry.name);
      let entryStat = null;
      try {
        entryStat = await io.lstat(full);
        if (entryStat.isSymbolicLink()) {
          // Component links must stay inside their own plugin directory.
          const target = await io.realpath(full);
          if (target !== resolved && !inside(resolved, target)) continue;
          entryStat = await io.stat(full);
        }
      } catch { continue; }
      if (type === "skill") {
        if (!entryStat.isDirectory()) continue;
        try {
          const skillFile = await io.lstat(path.join(full, "SKILL.md"));
          if (!skillFile.isFile() && !skillFile.isSymbolicLink()) continue;
        } catch { continue; }
        push(type, entry.name, path.join(directory, entry.name));
      } else if (entryStat.isFile()) {
        push(type, entry.name, path.join(directory, entry.name));
      }
    }
  }
  for (const file of MCP_FILES) {
    try {
      const stat = await io.lstat(path.join(resolved, file));
      if (stat.isFile() || stat.isSymbolicLink()) push("mcp", file, file);
    } catch { /* absent; not an error */ }
  }
  return components;
}

// Inspect one plugin directory. Returns null when the directory is not a
// plugin (no known manifest) or must be skipped for safety.
async function inspectPluginDir(io, home, provider, directory, { source, state, budget, nativeId = null, version = null, enabled = null } = {}) {
  let lstat;
  try {
    lstat = await io.lstat(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") warn(state, `Could not inspect ${directory}: ${summary(error)}`);
    return null;
  }
  if (!lstat.isDirectory() && !lstat.isSymbolicLink()) return null;
  let resolved;
  try {
    resolved = await io.realpath(directory);
  } catch {
    warn(state, `A linked plugin at ${directory} is broken or cyclic and was skipped.`);
    return null;
  }
  let resolvedStat;
  try {
    resolvedStat = await io.stat(resolved);
  } catch {
    warn(state, `A linked plugin at ${directory} is unavailable and was skipped.`);
    return null;
  }
  if (!resolvedStat.isDirectory()) return null;
  // Known plugin directories may live anywhere inside the persisted home,
  // but links escaping the home directory are never followed into inventory.
  if (resolved !== home && !inside(home, resolved)) {
    warn(state, `A linked plugin at ${directory} points outside the home directory and was skipped.`);
    return null;
  }
  if (state.pluginCount >= LIMITS.plugins) {
    warn(state, `The plugin scan reached its limit of ${LIMITS.plugins} plugins; some plugins may be missing.`);
    return "limited";
  }
  let manifest = null, manifestFormat = null, manifestRelative = null, manifestText = "", manifestStamp = "none";
  for (const candidate of [...MANIFESTS].sort((a,b) => Number(b.file.startsWith("."+provider+"-plugin"))-Number(a.file.startsWith("."+provider+"-plugin")))) {
    const file = path.join(resolved, candidate.file);
    const target = await io.realpath(file).catch(()=>null);
    if(target&&!inside(resolved,target)){warn(state,"An escaping plugin manifest link was skipped.");continue;}
    let available = false;
    try {
      const stat = await io.lstat(file);
      available = stat.isFile() || stat.isSymbolicLink();
    } catch { continue; }
    if (!available) continue;
    if (budget.bytes + LIMITS.manifestBytes + 1 > LIMITS.bytes) {
      warn(state, "The plugin scan reached its byte limit; some plugin metadata is unavailable.");
      return null;
    }
    try {
      const read = await readBoundedFile(io, file, LIMITS.manifestBytes);
      budget.bytes += read.bytes;
      const parsed = JSON.parse(read.content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid manifest.");
      manifest = parsed;
      manifestFormat = candidate.format;
      manifestRelative = candidate.file;
      manifestText = read.content;
      manifestStamp = read.stamp;
    } catch (error) {
      warn(state, `The plugin manifest at ${file} could not be read (${summary(error)}); showing the folder name.`);
      manifest = {};
      manifestFormat = candidate.format;
      manifestRelative = candidate.file;
    }
    break;
  }
  if (!manifest) return null; // directory without a known manifest is not a plugin
  const fields = manifestFields(manifest);
  const fallback = path.basename(resolved);
  const name = fields.name || (text(nativeId, 256) ? String(nativeId).split("/").pop() : null) || fallback;
  const components = await inspectComponents(io, resolved, state);
  const declared = Object.entries(manifest).filter(([, value]) => value && typeof value === "object");
  const unknown = declared.map(([key]) => key).filter((key) => !BENIGN_KEYS.has(key) && !COMPONENT_KEYS.has(key));
  if (unknown.length) {
    warn(state, `Plugin "${name}" (${provider}) declares ${unknown.map((key) => `"${key}"`).join(", ")}; inventory lists filesystem components only and executed nothing.`);
  }
  const plugin = {
    id: stableId(provider, resolved),
    provider,
    nativeId: text(nativeId, 256) && nativeId ? nativeId : fallback,
    name: (name || fallback).slice(0, 256),
    description: fields.description || "",
    version: fields.version || (text(version, 128) ? String(version) : null),
    scope: "user",
    path: directory,
    source,
    enabled: typeof enabled === "boolean" ? enabled : null,
    components,
    coverage: "filesystem",
    format: manifestFormat,
    manifestPath: manifestRelative ? path.join(resolved, manifestRelative) : null,
    readOnlyReason: "Inventory is read-only; install, update, enable and remove actions are not performed here.",
    revision: digest([provider, directory, resolved, manifestStamp, digest(manifestText)].join("\0")),
  };
  return plugin;
}

async function scanRoots(io, home, provider, roots, state, budget, extra = {}) {
  const found = [];
  for (const { directory, source } of roots) {
    if (state.budgetStopped) break;
    const entries = await readDirEntries(io, directory).catch((error) => {
      warn(state, `Could not scan ${directory}: ${summary(error)}`);
      state.partial = true;
      return [];
    });
    if (!entries) continue; // absent root: not installed, not an error
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (++state.entries > LIMITS.entries) {
        warn(state, "The plugin scan reached its entry limit; some plugins may be missing.");
        state.budgetStopped = true;
        break;
      }
      const plugin = await inspectPluginDir(io, home, provider, path.join(directory, entry.name), { source, state, budget, ...extra });
      if (plugin === "limited") { state.budgetStopped = true; break; }
      if (plugin) state.pluginCount++;
      if (plugin && !found.some((other) => other.id === plugin.id) && ![...state.plugins.values()].some((other) => other.id === plugin.id)) found.push(plugin);
    }
  }
  return found;
}

function localCandidate(spec, base, home) {
  if (typeof spec !== "string" || !spec.trim() || spec.length > 1024) return null;
  let value = spec.trim().replace(/^file:/, "");
  if (value.startsWith("~/")) return path.resolve(home, value.slice(2));
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.startsWith(".")) {
    return path.resolve(base, value);
  }
  if (path.isAbsolute(value)) return path.resolve(value);
  return null; // registry/npm/git/URL spec: never resolved or fetched
}

export function createPluginInventory({ home, env = process.env, io = fs, getHarness = async () => null } = {}) {
  home = path.resolve(home || env.HOME || "/home/t3");
  void getHarness; // accepted for interface parity; passive inventory never calls providers
  const resources = {cursor:path.join(home,".cursor"),antigravity:path.join(home,".gemini","config")};
  const claudeRoot = path.resolve(home, env.CLAUDE_CONFIG_DIR || ".claude");
  const codexRoot = path.resolve(home, env.CODEX_HOME || ".codex");
  const grokRoot = path.resolve(home, env.GROK_HOME || ".grok");
  const opencodeRoot = path.resolve(home, env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || ".config", "opencode"));
  const piRoot = path.resolve(home, env.PI_CODING_AGENT_DIR || ".pi/agent");

  const newState = () => ({ warnings: [], entries: 0, pluginCount: 0, plugins: new Map(), partial: false, budgetStopped: false });

  async function scanCache(provider, root, state, budget) {
    const plugins = [];
    const walk = async (directory, parts = []) => {
      if (state.budgetStopped || parts.length > 3) return;
      const resolved = await io.realpath(directory).catch(() => null);
      if (!resolved || !inside(home, resolved)) return;
      if (++state.entries > LIMITS.entries) { state.budgetStopped = true; warn(state, "Plugin cache inspection reached its entry limit."); return; }
      const plugin = await inspectPluginDir(io, home, provider, directory, {source: provider + " cache",state,budget});
      if (plugin === "limited") { state.budgetStopped = true; return; }
      if (plugin) {
        if (parts.length >= 2) plugin.nativeId = parts[1] + "@" + parts[0];
        plugins.push(plugin); state.pluginCount++; return;
      }
      for (const entry of await readDirEntries(io,directory) || []) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(path.join(directory,entry.name),[...parts,entry.name]);
      }
    };
    await walk(root);
    return plugins;
  }

  async function scanCodex(state, budget) {
    const plugins = await scanCache("codex",path.join(codexRoot,"plugins","cache"),state,budget);
    plugins.push(...await scanRoots(io, home, "codex", [{directory:path.join(codexRoot,"plugins"),source:"Codex local plugins"}],state,budget));
    try {
      const read = await readBoundedFile(io,path.join(codexRoot,"config.toml"),LIMITS.configBytes);
      budget.bytes += read.bytes;
      const cfg = parseToml(read.content);
      for (const plugin of plugins) {
        if (typeof cfg.plugins?.[plugin.nativeId]?.enabled === "boolean") plugin.enabled = cfg.plugins[plugin.nativeId].enabled;
      }
    } catch(error) {
      if(error.code !== "ENOENT") {state.partial=true;warn(state,"Codex user settings could not be inspected; loading and enablement are unverified.");}
    }
    warn(state,"Configured sources, project settings and account policies are not a verified runtime inventory.");
    return plugins;
  }

  async function scanClaude(state, budget) {
    const plugins = await scanCache("claude",path.join(claudeRoot,"plugins","cache"),state,budget);
    plugins.push(...await scanRoots(io,home,"claude",[{directory:path.join(claudeRoot,"plugins","installed"),source:"Claude local plugins"}],state,budget));
    try {
      const read = await readBoundedFile(io,path.join(claudeRoot,"plugins","installed_plugins.json"),LIMITS.configBytes);
      budget.bytes += read.bytes;
      const parsed = JSON.parse(read.content);
      if (!parsed?.plugins || typeof parsed.plugins !== "object") throw Error("Unrecognized registry");
      const records = Array.isArray(parsed.plugins) ? parsed.plugins : Object.entries(parsed.plugins).flatMap(([nativeId,entries])=>Array.isArray(entries)?entries.map(entry=>({...entry,nativeId})):[]);
      for (const record of records) {
        if (!record || typeof record !== "object") continue;
        const found = plugins.find(plugin => plugin.nativeId === record.nativeId || plugin.path === record.installPath);
        if(found && typeof record.enabled === "boolean") found.enabled = record.enabled;
        if(!found) warn(state,"A Claude installation record has no inspected cache files. Native scope and loading are not verified.");
      }
    } catch(error) {
      if(error.code !== "ENOENT") {state.partial=true;warn(state,"Claude plugin registry is malformed or unavailable; showing cache files only.");}
    }
    return plugins;
  }

  async function scanOpenCode(state, budget) {
    const plugins = await scanRoots(io, home, "opencode", [{ directory: path.join(opencodeRoot, "plugins"), source: "OpenCode plugins" }], state, budget);
    // Config declarations (v1 `plugin`, v2 `plugins`). Local paths inside
    // the home directory are inspected; registry/npm/git specs are counted
    // in a warning and never resolved, fetched or installed.
    let configText = null;
    for (const file of [path.join(opencodeRoot, "opencode.jsonc"), path.join(opencodeRoot, "opencode.json")]) {
      try {
        const read = await readBoundedFile(io, file, LIMITS.configBytes);
        budget.bytes += read.bytes;
        configText = read.content;
        break;
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "invalid") { warn(state, `OpenCode configuration could not be read (${summary(error)}).`); state.partial = true; }
      }
    }
    if (configText !== null) {
      try {
        const errors=[];
        const parsed=parseJsonc(configText,errors,{allowTrailingComma:true});
        if(errors.length)throw fail("invalid","Invalid OpenCode configuration.");
        const specs = [...(typeof parsed?.plugin === "string" ? [parsed.plugin] : Array.isArray(parsed?.plugin) ? parsed.plugin : []),
          ...(typeof parsed?.plugins === "string" ? [parsed.plugins] : Array.isArray(parsed?.plugins) ? parsed.plugins : [])];
        let remote = 0;
        for (const spec of specs) {
          const value=typeof spec==="string"?spec:spec?.package;
          if(typeof value==="string"&&(value.startsWith("-")||value==="*"))continue;
          const candidate = localCandidate(value, opencodeRoot, home);
          if (!candidate) { remote++; continue; }
          if (candidate !== home && !inside(home, candidate)) { remote++; continue; }
          if (plugins.some((plugin) => plugin.path === candidate)) continue;
          const lstat = await io.lstat(candidate).catch(() => null);
          if (!lstat || (!lstat.isDirectory() && !lstat.isSymbolicLink())) {
            warn(state, "An OpenCode-declared local plugin path has no readable directory; showing plugin files found on disk.");
            continue;
          }
          const plugin = await inspectPluginDir(io, home, "opencode", candidate, { source: "OpenCode config", state, budget });
          if (plugin === "limited") break;
          if (plugin && !plugins.some((other) => other.id === plugin.id)) plugins.push(plugin);
        }
        if (remote) warn(state, `${remote} OpenCode plugin declaration(s) are remote or registry specs; they were counted without resolution and nothing was fetched.`);
      } catch {
        warn(state, "OpenCode configuration is malformed; showing plugin files found on disk.");
        state.partial = true;
      }
    }
    return plugins;
  }

  async function scanPi(state, budget) {
    // Pi packages are configuration declarations; Setup must not pretend the
    // files it sees equal the provider's effective loaded state.
    const candidates = [path.join(piRoot, "packages"), path.join(piRoot, "extensions"), path.join(piRoot, "plugins")];
    let plugins = [];
    for (const directory of candidates) {
      plugins.push(...await scanRoots(io, home, "pi", [{ directory, source: "Pi packages" }], state, budget));
    }
    try {
      const read = await readBoundedFile(io, path.join(piRoot, "settings.json"), LIMITS.configBytes);
      budget.bytes += read.bytes;
      const parsed = JSON.parse(read.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        let declared = 0;
        for (const [key, value] of Object.entries(parsed)) {
          if (!/package|extension/i.test(key) || !Array.isArray(value)) continue;
          for (const entry of value) {
            if (typeof entry !== "string") continue;
            declared++;
            void localCandidate(entry, piRoot, home); // resolved only to classify; never fetched
          }
        }
        if (declared) warn(state, `${declared} Pi package declaration(s) describe intent only; effective loaded state is not verified.`);
        else warn(state, "Pi package state is declared configuration only; effective loaded state is not verified.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") { warn(state, `Pi package configuration could not be read (${summary(error)}); showing package files found on disk.`); state.partial = true; }
    }
    return plugins;
  }

  const SCANNERS = {
    codex: scanCodex,
    claude: scanClaude,
    opencode: scanOpenCode,
    cursor: (state, budget) => scanRoots(io, home, "cursor", [
      { directory: path.join(resources.cursor, "plugins", "local"), source: "Cursor local" },
      { directory: path.join(resources.cursor, "plugins"), source: "Cursor plugins" },
    ], state, budget),
    grok: (state, budget) => scanRoots(io, home, "grok", [{ directory: path.join(grokRoot, "plugins"), source: "Grok plugins" }], state, budget),
    antigravity: (state, budget) => scanRoots(io, home, "antigravity", [{ directory: path.join(resources.antigravity, "plugins"), source: "Antigravity plugins" }], state, budget),
    pi: scanPi,
    muse: null, // no documented plugin manifest/lifecycle contract
  };

  async function scanProvider(provider, { shared } = {}) {
    const state = shared || newState();
    const budget = shared?.budget || { bytes: 0 };
    if (shared) shared.budget = budget;
    const label = AGENT_NAMES[provider];
    if (provider === "muse") {
      const reason = "Muse Code exposes no documented plugin manifest or lifecycle contract; its skills and MCP entries remain managed separately.";
      warn(state, reason);
      return { entry: { id: provider, name: label, coverage: "unavailable", warnings: [reason], unsupportedReason: reason }, plugins: [], budget };
    }
    let plugins = [];
    try {
      plugins = await SCANNERS[provider](state, budget);
    } catch (error) {
      warn(state, `${label} plugin discovery failed (${summary(error)}); partial results shown.`);
      state.partial = true;
    }
    for (const plugin of plugins) state.plugins.set(plugin.id, plugin);
    const coverage = state.partial && shared ? "partial" : state.partial ? "partial" : "filesystem";
    return { entry: { id: provider, name: label, coverage, warnings: [...state.warnings] }, plugins, budget };
  }

  async function list(arg = {}) {
    const filter = typeof arg === "string" ? arg : arg?.provider;
    if (filter !== undefined && filter !== null && !Object.hasOwn(AGENT_NAMES, filter)) throw fail("invalid", "Unknown plugin provider.");
    const ids = filter ? [filter] : PROVIDER_IDS;
    const providers = [], plugins = [], warnings = [];
    // Share one budget across providers so a huge home cannot amplify reads.
    const shared = newState();
    shared.budget = { bytes: 0 };
    for (const id of ids) {
      const providerState = newState();
      providerState.plugins = shared.plugins;
      providerState.budget = shared.budget;
      providerState.entries = shared.entries;
      providerState.pluginCount = shared.pluginCount;
      const { entry, plugins: found } = await scanProvider(id, { shared: providerState });
      shared.entries = providerState.entries;
      shared.pluginCount = providerState.pluginCount;
      if (providerState.budgetStopped) shared.budgetStopped = true;
      if (providerState.partial) shared.partial = true;
      providers.push(entry);
      plugins.push(...found);
      for (const warning of entry.warnings) {
        if (!warnings.includes(warning) && warnings.length < 50) warnings.push(warning);
      }
    }
    plugins.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return { ok: true, providers, plugins, warnings };
  }

  async function read(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw fail("invalid", "Invalid plugin identifier.");
    const inventory = await list();
    const plugin = inventory.plugins.find((entry) => entry.id === id);
    if (!plugin) throw fail("missing", "This plugin is not in the provider inventory. Refresh the list.");
    return { ok: true, plugin };
  }

  return { list, read };
}
