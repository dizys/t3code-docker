// Global skill inventory and explicit local file management. No skill execution.
import path from "node:path";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { parseDocument, isMap, isScalar } from "./vendor/yaml.mjs";
import { listCodexSkills, writeCodexSkillConfig } from "./skills/codex.mjs";
import { codexConfigPath, configSnapshot, stateRevision, serializeState } from "./skills/state.mjs";
import { createSkillFileManager, skillRevision } from "./skills/files.mjs";
import { createSkillPolicies } from "./skills/policies.mjs";
import { readSkillOrigin, skillFingerprint, fingerprintInstalledDir, writeSkillOrigin, removeSkillOrigin } from "./skills/origins.mjs";
import { adapterDetection } from "./skills/adapters.mjs";
import { resolveSkillSource, parseSkillSource } from "./skills/sources.mjs";
import { createSkillImporter } from "./skills/imports.mjs";
import { skillReach } from "./skills/reach.mjs";
import { createPluginHookService } from "./skills/hooks.mjs";

const PROVIDERS = Object.freeze({ claude: "Claude Code", codex: "Codex", opencode: "OpenCode", cursor: "Cursor", grok: "Grok Build", muse: "Muse Code", antigravity: "Antigravity" });
const DEFAULT_LIMITS = { entries: 2048, skills: 256, depth: 8, bytes: 4 * 1024 * 1024, fileBytes: 64 * 1024, milliseconds: 3000 };
const problem = (code, message) => Object.assign(new Error(message), { code });
const summaryError = (error) => String(error?.message || error).slice(0, 240);
const idFor = (provider, file) => createHash("sha256").update(provider + "\0" + file).digest("hex").slice(0, 32);

export function skillProviders() { return Object.entries(PROVIDERS).map(([id, name]) => ({ id, name })); }

export function skillRoots(provider, { home, env = {} }) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw problem("invalid", "Unknown skill provider.");
  const override = (key, fallback) => path.resolve(home, String(env[key] || "").trim() || fallback);
  const claude = override("CLAUDE_CONFIG_DIR", ".claude"), codex = override("CODEX_HOME", ".codex");
  const config = override("XDG_CONFIG_HOME", ".config"), shared = path.join(home, ".agents/skills");
  const own = (directory) => ({ path: path.join(directory, "skills"), source: "Provider", scope: "user" });
  const compat = (directory, source) => ({ path: directory, source, scope: "user" });
  const common = compat(shared, "Shared .agents");
  const roots = {
    claude: [own(claude)],
    codex: [own(codex), common, { path: path.join(codex, "skills/.system"), source: "System", scope: "system" }, { path: "/etc/codex/skills", source: "Admin", scope: "admin" }],
    opencode: [own(override("OPENCODE_CONFIG_DIR", path.join(config, "opencode"))), compat(path.join(claude, "skills"), "Claude compatibility"), common],
    cursor: [own(path.join(home, ".cursor")), common, compat(path.join(claude, "skills"), "Claude compatibility"), compat(path.join(codex, "skills"), "Codex compatibility")],
    grok: [own(override("GROK_HOME", ".grok")), compat(path.join(claude, "skills"), "Claude compatibility"), common, compat(path.join(home, ".cursor/skills"), "Cursor compatibility")],
    muse: [own(path.join(config, "muse")), common, compat(path.join(claude, "skills"), "Claude compatibility"), compat(path.join(codex, "skills"), "Codex compatibility")],
    antigravity: [own(path.join(home, ".gemini/config")), compat(path.join(home, ".gemini/antigravity-cli/skills"), "Antigravity CLI")],
  }[provider];
  return roots.filter((root, index) => roots.findIndex((other) => other.path === root.path) === index);
}

// Stat before opening, stat the opened descriptor, then read at most limit + 1.
// Nonblocking open prevents a raced-in FIFO from hanging the setup service.
export async function readSkillFile(file, maxBytes = DEFAULT_LIMITS.fileBytes, io = fs) {
  const check = (stat) => {
    if (!stat.isFile()) throw problem("invalid", "The skill must be a regular Markdown file.");
    if (stat.size > maxBytes) throw problem("too_large", "This skill exceeds the 64 KiB viewer limit.");
  };
  check(await io.stat(file));
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); check(stat);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > maxBytes) throw problem("too_large", "This skill exceeds the 64 KiB viewer limit.");
    return { content: buffer.toString("utf8", 0, bytes), bytes, mode: stat.mode & 0o777, stamp: [stat.dev, stat.ino, stat.mtimeMs, stat.size].join(":") };
  } finally { await handle.close(); }
}

export function skillMetadata(content, fallback) {
  const result = { name: fallback, description: "", invocation: null, metadataError: null };
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { ...result, metadataError: "No YAML frontmatter; showing the file's directory name." };
  if (Buffer.byteLength(match[1]) > 16 * 1024) return { ...result, metadataError: "Skill frontmatter exceeds the 16 KiB metadata limit." };
  try {
    const doc = parseDocument(match[1], { schema: "core", stringKeys: true, logLevel: "silent", prettyErrors: false });
    if (doc.errors.length || !isMap(doc.contents)) throw new Error("Invalid YAML frontmatter.");
    const scalar = (key) => { const node = doc.get(key, true); return isScalar(node) ? node.value : undefined; };
    const name = scalar("name"), description = scalar("description");
    if (typeof name === "string" && name.trim()) result.name = name.trim().slice(0, 256);
    if (typeof description === "string") result.description = description.trim().slice(0, 2048);
    if (!result.description || typeof name !== "string" || !name.trim()) result.metadataError = "Name or description is missing or is not text. Provider handling may vary.";
    if (scalar("disable-model-invocation") === true) result.invocation = "manual";
    if (scalar("user-invocable") === false) result.invocation = "model-only";
    if (doc.warnings.length) result.metadataError ||= "Frontmatter includes unsupported YAML tags.";
  } catch { result.metadataError = "Could not parse YAML frontmatter. Open the file to inspect it."; }
  return result;
}

export async function scanSkillFiles(provider, options) {
  const { home, env = {}, io = fs } = options;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const roots = skillRoots(provider, { home, env }), rows = new Map(), warnings = new Set();
  const budget = { entries: 0, bytes: 0, start: Date.now() };
  const stopped = () => {
    if (budget.entries < limits.entries && rows.size < limits.skills && budget.bytes < limits.bytes && Date.now() - budget.start < limits.milliseconds) return false;
    warnings.add("The local scan reached its safety limit; some skills may be missing."); return true;
  };
  const add = async (file, root, initialError = null) => {
    if (rows.has(file) || stopped()) return;
    const fallback = path.basename(file) === "SKILL.md" ? path.basename(path.dirname(file)) : path.basename(file, ".md");
    const row = { id: idFor(provider, file), path: file, resolvedPath: null, name: fallback, description: "", source: root.source, scope: root.scope, state: "unknown", native: false, bytes: null, error: initialError, metadataError: null, invocation: null };
    rows.set(file, row);
    if (initialError) return;
    try {
      row.resolvedPath = await io.realpath(file);
      // Spend the entire possible read before opening, including malformed files.
      if (budget.bytes + limits.fileBytes + 1 > limits.bytes) { warnings.add("The local scan reached its byte limit; some metadata is unavailable."); return; }
      budget.bytes += limits.fileBytes + 1;
      const read = await readSkillFile(row.resolvedPath, limits.fileBytes, io);
      budget.bytes -= limits.fileBytes + 1 - read.bytes;
      Object.assign(row, skillMetadata(read.content, fallback), { bytes: read.bytes });
      if (path.basename(file) === "SKILL.md" && row.name !== fallback) row.metadataError ||= "Name doesn’t match folder: use " + fallback + " in the frontmatter name.";
    } catch (error) {
      row.error = error?.code === "ENOENT" ? "The skill file or its linked target is missing." : summaryError(error);
    }
  };
  const walk = async (directory, root, depth, ancestors) => {
    if (stopped()) return;
    let resolved, handle;
    try {
      resolved = await io.realpath(directory);
      if (ancestors.has(resolved)) { warnings.add("A directory link cycle was skipped."); return; }
      if (depth > limits.depth) { warnings.add("The local scan reached its directory depth limit."); return; }
      handle = await io.opendir(directory);
      const nextAncestors = new Set([...ancestors, resolved]);
      for await (const entry of handle) {
        if (stopped()) break;
        budget.entries++;
        if (entry.name.startsWith(".")) continue;
        const file = path.join(directory, entry.name);
        if (entry.name === "SKILL.md" || (provider === "opencode" && depth === 0 && entry.name.endsWith(".md") && !entry.isDirectory())) {
          await add(file, root); continue;
        }
        let directoryEntry = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try { directoryEntry = (await io.stat(file)).isDirectory(); }
          catch (error) {
            if (error?.code === "ENOENT" || error?.code === "ELOOP") await add(path.join(file, "SKILL.md"), root, "This skill directory link is broken or cyclic.");
            else warnings.add("A linked skill directory could not be inspected.");
          }
        }
        if (directoryEntry) await walk(file, root, depth + 1, nextAncestors);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") warnings.add("Could not scan " + directory + ": " + summaryError(error));
    }
  };
  for (const root of roots) await walk(root.path, root, 0, new Set());
  return { skills: [...rows.values()], roots, warnings: [...warnings] };
}

export function createSkillsService({ home, env = process.env, io = fs, nativeCodex = listCodexSkills, nativeCodexWrite = writeCodexSkillConfig, nativeCodexHooks, nativeCodexHookWrite, inspectClaude, inspectOpenCode, getHarness = async () => null, ttlMs = 15000, limits, resolveSource } = {}) {
  home = path.resolve(home || env.HOME || "/home/t3");
  const cache = new Map(), updateStates = new Map(), updateChecks = new Map();
  const policies = createSkillPolicies({ home, env, io, getHarness, inspectClaude, inspectOpenCode, invalidate: () => cache.clear() });
  const load = async (provider) => {
    const scanned = await scanSkillFiles(provider, { home, env, io, limits });
    let coverage = "files", nativeError = null, config = null;
    if (provider === "codex") {
      const settings = codexConfigPath(home, env);
      let before;
      try { before = await configSnapshot(settings, io); }
      catch (error) { scanned.warnings.push(summaryError(error)); }
      try {
        const harness = await getHarness(provider);
        if (!harness?.runnable || !harness.executable) throw new Error("A managed Codex executable is not available.");
        const native = await nativeCodex({ executable: harness.executable, home, env });
        coverage = "native";
        const byPath = new Map(scanned.skills.map((row) => [row.path, row]));
        for (const entry of native.skills) {
          if (!entry || !["user", "system", "admin"].includes(entry.scope)) continue;
          if (typeof entry.path !== "string" || !path.isAbsolute(entry.path) || typeof entry.name !== "string" || typeof entry.description !== "string" || typeof entry.enabled !== "boolean") {
            scanned.warnings.push("Codex returned an unrecognized skill entry."); continue;
          }
          if (!byPath.has(entry.path) && byPath.size >= (limits?.skills ?? DEFAULT_LIMITS.skills)) { scanned.warnings.push("The native inventory reached its skill limit."); break; }
          const previous = byPath.get(entry.path);
          const resolvedPath = await io.realpath(entry.path).catch(() => null);
          byPath.set(entry.path, { ...previous, id: idFor(provider, entry.path), path: entry.path, resolvedPath,
            name: entry.name.slice(0, 256), description: entry.description.slice(0, 2048), scope: entry.scope,
            source: entry.pluginId ? "Plugin" : entry.scope === "system" ? "System" : entry.scope === "admin" ? "Admin" : previous?.source || "Codex", pluginId: typeof entry.pluginId === "string" ? entry.pluginId.slice(0, 256) : null,
            state: entry.enabled ? "enabled" : "disabled", native: true,
            error: previous?.error || (!resolvedPath ? "This skill's local file is unavailable." : null),
          });
        }
        scanned.skills = [...byPath.values()];
        if (native.errors.length) scanned.warnings.push("Codex reported " + native.errors.length + " skill discovery error(s).");
      } catch (error) { coverage = "files"; nativeError = summaryError(error); }
      if (before) {
        try {
          const after = await configSnapshot(settings, io);
          if (before === after) config = after;
          else scanned.warnings.push("Codex settings changed during discovery. Refresh before changing availability.");
        } catch (error) { scanned.warnings.push(summaryError(error)); }
      }
    }
    if (["claude", "opencode"].includes(provider)) {
      try {
        const result = await policies.inspect(provider, scanned.skills);
        scanned.skills = result.skills; coverage = "policy";
      } catch (error) { nativeError = summaryError(error); }
    }
    const policy = await fileManager.policyFor(provider);
    const adapter = await adapterDetection(provider, { home, env, io });
    for (const row of scanned.skills) {
      const origin = await readSkillOrigin(io, row, home);
      if (origin && policy.capabilities(row).canEdit) {
        row.origin = origin;
        const checked = updateStates.get(row.resolvedPath);
        if (checked?.fingerprint === origin.fingerprint && checked.source === origin.source) row.update = checked;
      }
    }
    return { ok: true, provider, canCreate: policy.canCreate, creationTargets: policy.creationTargets, providers: skillProviders(), skills: scanned.skills.map((row) => {
      if (row.stateAuthority === "user-policy") return { ...row, ...policy.capabilities(row) };
      const reason = provider !== "codex" ? nativeError || "Native policy controls are currently supported for Claude Code and OpenCode; native availability controls for Codex."
        : !row.native ? "Codex has not verified this skill's availability."
          : row.scope !== "user" || row.source === "Plugin" ? "System, admin and plugin availability is managed through its source."
            : row.error || !row.resolvedPath ? "This skill's local file is unavailable."
              : !config ? "Refresh after checking native settings before changing availability." : null;
      return { ...row, ...policy.capabilities(row), canToggle: !reason, stateReadOnlyReason: reason,
        stateRevision: !reason ? stateRevision(config, row) : null };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
      roots: scanned.roots, coverage, nativeError, warnings: scanned.warnings, scannedAt: Date.now(), adapter,
      coverageText: coverage === "policy" ? "Known global skill folders with native user policy settings checked by the managed provider. Project/session and managed policies can further restrict availability."
        : coverage === "native" ? "Managed Codex inventory in the setup environment, with known local folders included. Project skills are excluded."
        : "Known global skill folders only. Provider availability, plugins and additional configured locations are not verified.",
    };
  };
  const setState = async (provider, id, revision, enabled, state) => {
    if (!Object.hasOwn(PROVIDERS, provider) || typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw problem("invalid", "Expected a provider and skill identifier.");
    if (["claude", "opencode"].includes(provider)) return policies.set(provider, () => load(provider), id, revision, state);
    if (typeof enabled !== "boolean") throw problem("invalid", "Expected a boolean enabled value.");
    if (provider !== "codex") throw problem("unsupported", "Native availability controls are currently supported for Codex.");
    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) throw problem("conflict", "Refresh the inventory before changing availability.");
    const settings = codexConfigPath(home, env);
    const key = await io.realpath(settings).catch(() => settings);
    return serializeState(key, async () => {
      cache.delete(provider);
      const fresh = await load(provider);
      const row = fresh.skills.find((skill) => skill.id === id);
      if (!row) throw problem("missing", "This skill is no longer in the provider inventory. Refresh the list.");
      if (!row.canToggle) throw problem("unsupported", row.stateReadOnlyReason);
      if (revision !== row.stateRevision) throw problem("conflict", "Codex settings or this skill changed. Review the refreshed inventory before trying again.");
      const harness = await getHarness(provider);
      if (!harness?.runnable || !harness.executable) throw problem("unsupported", "A managed Codex executable is not available.");
      // Check again immediately before calling the native writer. The provider has
      // no compare-and-swap API; external writers can still race this last check.
      const config = await configSnapshot(settings, io);
      if (revision !== stateRevision(config, row) || await io.realpath(row.path).catch(() => null) !== row.resolvedPath) throw problem("conflict", "Codex settings or this skill link changed. Refresh before trying again.");
      try {
        const written = await nativeCodexWrite({ executable: harness.executable, home, env, path: row.path, enabled });
        if (written?.effectiveEnabled !== enabled) throw new Error("Codex did not confirm the requested availability. Refresh to check its current state.");
        const verified = await load(provider);
        const updated = verified.skills.find((skill) => skill.id === id);
        if (verified.coverage !== "native" || !updated?.native || updated.state !== (enabled ? "enabled" : "disabled")) {
          throw new Error("Codex may have saved the setting, but its resulting availability could not be verified. Refresh to check its current state.");
        }
        return { ok: true, provider, id, enabled, inventory: verified };
      } finally { cache.delete(provider); }
    });
  };
  const list = (provider, { refresh = false } = {}) => {
    if (!Object.hasOwn(PROVIDERS, provider)) return Promise.reject(problem("invalid", "Unknown skill provider."));
    const hit = cache.get(provider);
    if (hit && (hit.pending || (!refresh && Date.now() - hit.at < ttlMs))) return hit.promise;
    const entry = { pending: true, at: Date.now() };
    entry.promise = load(provider).then((result) => { entry.pending = false; entry.at = Date.now(); return result; }, (error) => { cache.delete(provider); throw error; });
    cache.set(provider, entry); return entry.promise;
  };
  const read = async (provider, id) => {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw problem("invalid", "Invalid skill identifier.");
    const inventory = await list(provider);
    const row = inventory.skills.find((skill) => skill.id === id);
    if (!row) throw problem("missing", "This skill is not in the provider inventory. Refresh the list.");
    if (!row.resolvedPath) throw problem("missing", "The skill file or its linked target is unavailable.");
    let resolved;
    try { resolved = await io.realpath(row.path); }
    catch { throw problem("missing", "The skill file or its linked target no longer exists."); }
    if (resolved !== row.resolvedPath) throw problem("conflict", "This skill link changed. Refresh the list before opening it.");
    const file = await readSkillFile(resolved, limits?.fileBytes ?? DEFAULT_LIMITS.fileBytes, io);
    const policy = await fileManager.policyFor(provider);
    const detail = { ok: true, ...row, ...policy.capabilities(row), ...file, revision: skillRevision(row, file) };
    return { ...detail, ...await fileManager.removal(provider, detail) };
  };
  const fileManager = createSkillFileManager({ home, env, io, rootsFor: (provider) => skillRoots(provider, { home, env }), metadata: skillMetadata, read, invalidate: () => cache.clear() });
  const readersFor = async resolvedPath => {
    const inventories = await Promise.all(skillProviders().map(async ({ id }) => ({ id, data: await scanSkillFiles(id, { home, env, io, limits }) })));
    return inventories.flatMap(({ id, data }) => data.skills.filter(row => row.resolvedPath === resolvedPath).map(row => ({ provider: id, path: row.path })))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.path.localeCompare(b.path));
  };
  const importer = createSkillImporter({ home, env, io, metadata: skillMetadata, policyFor: fileManager.policyFor, invalidate: () => cache.clear(), resolveSource,
    readInstalled: async (provider, id) => { cache.delete(provider); return read(provider, id); }, readersFor,
    managedRoots: async () => [...new Set((await Promise.all(skillProviders().map(async ({ id }) => (await fileManager.policyFor(id)).creationTargets.map(target => target.path)))).flat())] });
  const checkUpdate = async (provider, id, batchSources) => {
    const sources = batchSources || new Map();
    const row = await read(provider, id);
    if (!row.origin || !row.canEdit) throw problem("unsupported", "This skill has no tracked repository source. Re-import it from its repository to enable update checks.");
    const key = row.resolvedPath;
    if (updateChecks.has(key)) return updateChecks.get(key);
    if (updateChecks.size >= 3) throw problem("conflict", "Other repository checks are still running. Try again when they finish.");
    const pending = (async () => {
      let update, sourceInfo = null;
      try {
        if (!sources.has(row.origin.source)) sources.set(row.origin.source, Promise.resolve().then(async () => {
          const snapshot = await (resolveSource || resolveSkillSource)(row.origin.source, { home, env, metadata: skillMetadata });
          // Retain small check metadata, not the downloaded source buffers.
          return { fingerprints: new Map((snapshot.skills || []).map(skill => [skill.name, skillFingerprint(skill)])), sourceInfo: snapshot.sourceInfo };
        }));
        const snapshot = await sources.get(row.origin.source);
        sourceInfo = snapshot.sourceInfo;
        const fingerprint = snapshot.fingerprints.get(row.origin.name);
        if (!fingerprint) throw new Error("The installed skill was not found in this source. It may have been renamed or removed.");
        update = { ...row.origin, status: fingerprint === row.origin.fingerprint ? "current" : "available", checkedAt: Date.now(), ref: sourceInfo?.ref ?? null, commit: sourceInfo?.commit ?? null };
      } catch (error) { update = { ...row.origin, status: "error", error: summaryError(error), checkedAt: Date.now(), ref: sourceInfo?.ref ?? null, commit: sourceInfo?.commit ?? null }; }
      // A replaced or removed installation must not inherit a stale check result.
      const current = await readSkillOrigin(io, row, home);
      if (!current || current.source !== row.origin.source || current.fingerprint !== row.origin.fingerprint) throw problem("conflict", "The installation changed while checking. Refresh and check again.");
      updateStates.delete(key); updateStates.set(key, update);
      if (updateStates.size > 1024) updateStates.delete(updateStates.keys().next().value);
      if (!batchSources) cache.clear();
      return { ok: true, id, update };
    })();
    updateChecks.set(key, pending);
    try { return await pending; } finally { updateChecks.delete(key); }
  };
  const checkUpdates = async (entries) => {
    if (!Array.isArray(entries) || !entries.length || entries.length > Object.keys(PROVIDERS).length * DEFAULT_LIMITS.skills
      || entries.some(entry => !entry || !Object.hasOwn(PROVIDERS, entry.provider) || typeof entry.id !== "string" || !/^[a-f0-9]{32}$/.test(entry.id))
      || new Set(entries.map(entry => entry.provider + ":" + entry.id)).size !== entries.length) throw problem("invalid", "Choose discovered skill installations to check for updates.");
    const sources = new Map(), results = [];
    try {
      for (const { provider, id } of entries) {
        try { results.push({ ...await checkUpdate(provider, id, sources), provider }); }
        catch (error) { results.push({ ok: false, provider, id, code: error.code || "unavailable", error: summaryError(error) }); }
      }
    } finally { cache.clear(); }
    return { ok: true, results };
  };
  const reach = ({ refresh = false } = {}) => {
    const key = "reach", hit = cache.get(key);
    if (hit && (hit.pending || (!refresh && Date.now() - hit.at < ttlMs))) return hit.promise;
    const entry = { pending: true, at: Date.now() };
    entry.promise = skillReach({ providers: skillProviders(), rootsFor: provider => skillRoots(provider, { home, env }), policyFor: fileManager.policyFor, io })
      .then(result => { entry.pending = false; entry.at = Date.now(); return { ...result, home }; }, error => { cache.delete(key); throw error; });
    cache.set(key, entry); return entry.promise;
  };
  // Link an existing local skill to a repository source so it can be checked
  // and auto-updated like an import. Stores the current on-disk fingerprint so
  // the next check correctly reports available vs current, plus an autoUpdate
  // flag the background updater honours. Manual links are editable/removable.
  const linkSource = async (provider, id, source, { autoUpdate = false, allowNameMismatch = false } = {}) => {
    if (!Object.hasOwn(PROVIDERS, provider)) throw problem("invalid", "Unknown skill provider.");
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw problem("invalid", "Invalid skill identifier.");
    if (typeof source !== "string" || !source.trim() || source.length > 2048) throw problem("invalid", "Enter a repository, skill URL or owner/repo to link.");
    let kind;
    try { kind = parseSkillSource(source.trim(), home).type; }
    catch (error) { throw problem(error.code || "invalid", summaryError(error)); }
    if (!["git", "url"].includes(kind)) throw problem("invalid", "Link a repository or skill URL so it can be checked for updates. Container folders can't auto-update; use Install from source for those.");
    const row = await read(provider, id);
    const policy = await fileManager.policyFor(provider);
    if (!policy.capabilities(row).canEdit) throw problem("unsupported", policy.capabilities(row).readOnlyReason || "This skill cannot be linked for updates.");
    if (path.basename(row.resolvedPath) !== "SKILL.md") throw problem("unsupported", "Only ordinary skill folders with a SKILL.md file can be linked.");
    const directory = path.dirname(row.resolvedPath);
    let snapshot;
    try { snapshot = await (resolveSource || resolveSkillSource)(source.trim(), { home, env, metadata: skillMetadata }); }
    catch (error) { throw problem(error.code || "unavailable", summaryError(error)); }
    if (snapshot.links) throw problem("invalid", "Choose a repository or skill link from that page, not the listing page itself.");
    if (!["git", "url"].includes(snapshot.sourceType)) throw problem("invalid", "Link a repository or skill URL so it can be checked for updates. Container folders can't auto-update; use Install from source for those.");
    const exact = (snapshot.skills || []).find(skill => skill.name === row.name);
    const single = snapshot.skills?.length === 1 ? snapshot.skills[0] : null;
    if (!exact && single && single.name !== row.name && !allowNameMismatch) throw problem("mismatch", `This source contains a single skill named "${single.name}", not "${row.name}". Confirm to track "${single.name}" from this installation anyway.`);
    const match = exact || single;
    if (!match) throw problem("missing", snapshot.skills?.length ? `This source has ${snapshot.skills.length} skills but none named ${row.name}. Use its skill folder link or pick the matching name.` : "No skills were found in this source.");
    if (match.files.some(file => file.name === ".t3-skill-source.json")) throw problem("conflict", "This source contains reserved skill tracking metadata.");
    const fingerprint = await fingerprintInstalledDir(io, directory);
    await writeSkillOrigin(io, directory, { source: snapshot.source || source.trim(), name: match.name, fingerprint, autoUpdate: autoUpdate !== false, manual: true, linkedAt: Date.now() });
    cache.clear();
    const fresh = await list(provider, { refresh: true });
    const updated = fresh.skills.find(skill => skill.id === id);
    if (!updated?.origin) throw problem("unavailable", "The source was saved but could not be verified. Refresh and check the skill.");
    return { ok: true, provider, id, origin: updated.origin };
  };
  const unlinkSource = async (provider, id) => {
    if (!Object.hasOwn(PROVIDERS, provider)) throw problem("invalid", "Unknown skill provider.");
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw problem("invalid", "Invalid skill identifier.");
    const row = await read(provider, id);
    const policy = await fileManager.policyFor(provider);
    if (!policy.capabilities(row).canEdit) throw problem("unsupported", policy.capabilities(row).readOnlyReason || "This skill cannot be unlinked.");
    await removeSkillOrigin(io, path.dirname(row.resolvedPath));
    for (const tracked of [...updateStates.keys()]) { if (tracked === row.resolvedPath) updateStates.delete(tracked); }
    cache.clear();
    return { ok: true, provider, id };
  };
  const setSourceAuto = async (provider, id, autoUpdate) => {
    if (!Object.hasOwn(PROVIDERS, provider)) throw problem("invalid", "Unknown skill provider.");
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw problem("invalid", "Invalid skill identifier.");
    if (typeof autoUpdate !== "boolean") throw problem("invalid", "Expected a boolean auto-update value.");
    const row = await read(provider, id);
    const origin = await readSkillOrigin(io, row, home);
    if (!origin) throw problem("unsupported", "This skill has no linked source. Link one before enabling auto-update.");
    const policy = await fileManager.policyFor(provider);
    if (!policy.capabilities(row).canEdit) throw problem("unsupported", policy.capabilities(row).readOnlyReason || "This skill cannot change its update settings.");
    await writeSkillOrigin(io, path.dirname(row.resolvedPath), { ...origin, autoUpdate });
    // A replaced or removed installation must not inherit a stale toggle.
    const current = await readSkillOrigin(io, row, home);
    if (!current || current.source !== origin.source || current.fingerprint !== origin.fingerprint) throw problem("conflict", "The installation changed. Refresh before changing auto-update.");
    cache.clear();
    return { ok: true, provider, id, autoUpdate };
  };
  const listTracked = async () => {
    const inventories = await Promise.all(skillProviders().map(async ({ id }) => ({ id, data: await list(id).catch(() => null) })));
    const tracked = [];
    for (const { id, data } of inventories) {
      for (const skill of data?.skills || []) {
        if (skill.origin) tracked.push({ provider: id, id: skill.id, key: skill.resolvedPath || skill.path, name: skill.name, origin: skill.origin, update: skill.update || null });
      }
    }
    // One physical folder can appear under several providers; check it once.
    const seen = new Set();
    return tracked.filter(entry => (seen.has(entry.key) ? false : (seen.add(entry.key), true)));
  };
  const hooks = createPluginHookService({ home, env, io, getHarness, nativeList: nativeCodexHooks, nativeWrite: nativeCodexHookWrite });
  return { list, read, reach, checkUpdate, checkUpdates, setState, create: fileManager.create, save: fileManager.save, remove: fileManager.remove, linkSource, unlinkSource, setSourceAuto, listTracked, ...importer, ...hooks };
}
