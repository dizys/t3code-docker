// Previewed source snapshots become local skills with repository provenance.
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveSkillSource } from "./sources.mjs";
import { ORIGIN_FILE, skillFingerprint } from "./origins.mjs";
import { removalPlan, serialized } from "./files.mjs";
import { createSkillUpdateReview } from "./update-review.mjs";

const fail = (code, message) => Object.assign(new Error(message), { code });
const token = () => randomBytes(24).toString("hex");
async function resolveMissing(io, directory) {
  try { return await io.realpath(directory); }
  catch (error) { if (error.code !== "ENOENT" || path.dirname(directory) === directory) throw error;
    // A dangling link is an unavailable destination, not a missing directory.
    if (await io.lstat(directory).then(() => true, () => false)) throw fail("unsupported", "The destination has a broken link.");
    return path.join(await resolveMissing(io, path.dirname(directory)), path.basename(directory));
  }
}

export function createSkillImporter({ home, env, io, metadata, policyFor, invalidate, readInstalled, readersFor, managedRoots, resolveSource = resolveSkillSource, now = Date.now, ttlMs = 10 * 60 * 1000 }) {
  const previews = new Map(); let resolving = false;
  const updates = createSkillUpdateReview({ home, io, policyFor, readInstalled, readersFor, managedRoots });
  const prune = () => { for (const [key, value] of previews) if (now() - value.at > ttlMs && !value.installing) previews.delete(key); };
  const get = (id) => { prune(); const hit = previews.get(id); if (!hit) throw fail("conflict", "This preview expired. Preview the source again."); return hit; };
  const previewSource = async (source) => {
    prune();
    if (resolving) throw fail("conflict", "Another source is being read. Wait for its preview to finish.");
    if (previews.size >= 3) throw fail("conflict", "Close another source preview or wait ten minutes before opening more.");
    resolving = true;
    try {
      const snapshot = await resolveSource(source, { home, env, metadata });
      if (snapshot.links) return { ok: true, ...snapshot };
      // A local copy keeps its files, but cannot inherit repository provenance.
      if (snapshot.sourceType === "local") snapshot.skills = snapshot.skills.map(skill => ({ ...skill, files: skill.files.filter(file => file.name !== ORIGIN_FILE) }));
      const previewId = token(); previews.set(previewId, { ...snapshot, at: now(), plan: null });
      const createdAt = previews.get(previewId).at;
      return { ok: true, previewId, source: snapshot.source, sourceInfo: snapshot.sourceInfo, createdAt, expiresAt: createdAt + ttlMs, warnings: snapshot.warnings,
        skills: snapshot.skills.map((skill) => ({ name: skill.name, description: skill.description, content: skill.content,
          files: skill.files.map((file) => ({ name: file.name, bytes: file.data.length, executable: Boolean(file.mode & 0o100) })), bytes: skill.files.reduce((sum, file) => sum + file.data.length, 0) })) };
    } finally { resolving = false; }
  };
  const previewUpdate = async (provider, id) => {
    prune();
    if (resolving) throw fail("conflict", "Another source is being read. Wait for its review to finish.");
    if (previews.size >= 3) throw fail("conflict", "Close another source review or wait ten minutes before opening more.");
    resolving = true;
    try {
      const initial = await updates.bind(provider, id), { binding } = initial;
      const snapshot = await resolveSource(binding.origin.source, { home, env, metadata });
      const skill = snapshot.skills?.find(skill => skill.name === binding.origin.name);
      if (!["git", "url"].includes(snapshot.sourceType) || !skill) throw fail("missing", "The tracked skill was not found in this source. It may have been renamed or removed.");
      if (skill.files.some(file => file.name === ORIGIN_FILE)) throw fail("conflict", "This source contains reserved skill tracking metadata.");
      const entry = await updates.inspect(binding);
      if (entry.revision !== initial.entry.revision) throw fail("conflict", "This skill changed while reading its repository. Review the update again.");
      const review = await updates.review(entry, skill);
      binding.readers = await readersFor(binding.resolvedPath);
      const checked = await updates.inspect(binding);
      if (checked.revision !== entry.revision) throw fail("conflict", "This skill changed while preparing its review. Review the update again.");
      const previewId = token(), planId = token(), at = now();
      // Keep only this selected skill. Neither a new provider selection nor an
      // arbitrary path can turn the update token into a different destination.
      const canUpdate = review.changes.some(file => file.status !== "unchanged") || binding.origin.fingerprint !== skillFingerprint(skill);
      previews.set(previewId, { ...snapshot, skills: [skill], at, update: true,
        plan: { planId, destinations: [entry] } });
      return { ok: true, previewId, planId, createdAt: at, expiresAt: at + ttlMs, canUpdate,
        name: skill.name, source: binding.origin.source, sourceInfo: snapshot.sourceInfo, warnings: snapshot.warnings,
        target: { provider, id, directory: path.dirname(binding.path), resolvedDirectory: entry.directory,
          linked: path.dirname(binding.path) !== entry.directory, readers: [...new Set(binding.readers.map(row => row.provider))] },
        ...review, markdown: { before: initial.content, after: skill.content } };
    } finally { resolving = false; }
  };
  const inspect = async (provider, skill) => {
    const policy = await policyFor(provider), target = policy.creationTargets.find((entry) => entry.id === "provider");
    if (!target) throw fail("unsupported", "The provider folder is unavailable. Check permissions and the skills package lock.");
    const root = await resolveMissing(io, target.path), directory = path.join(root, skill.name), file = path.join(directory, "SKILL.md");
    const row = { path: path.join(target.path, skill.name, "SKILL.md"), resolvedPath: file, name: skill.name, scope: "user", source: "Provider" };
    const caps = policy.capabilities(row);
    if (!caps.canEdit) throw fail("unsupported", caps.readOnlyReason);
    let stat;
    try { stat = await io.lstat(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!stat) return { provider, name: skill.name, rootPath: target.path, root, directory, action: "add", revision: null };
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("unsupported", "An existing file or linked skill folder is preserved. Manage it through its source.");
    const markdown = await io.lstat(file).catch(() => null);
    if (!markdown?.isFile() || markdown.isSymbolicLink()) throw fail("unsupported", "This folder is not an ordinary local skill. Its existing contents are preserved.");
    const plan = await removalPlan(io, { path: file }, { path: root });
    return { provider, name: skill.name, rootPath: target.path, root, directory, action: "replace", revision: plan.revision, files: plan.files };
  };
  const planImport = async (previewId, names, providers) => {
    const snapshot = get(previewId);
    if (snapshot.update) throw fail("invalid", "An update stays bound to its reviewed installation. Start a separate import to make another copy.");
    const partial = snapshot.result?.results.some(entry => entry.status === "failed");
    if (snapshot.installing || snapshot.planning || (snapshot.result && !partial)) throw fail("conflict", "This preview has already been installed. Preview again to make another change.");
    if (!Array.isArray(names) || !names.length || names.length > 128 || new Set(names).size !== names.length || names.some((name) => !snapshot.skills.some((skill) => skill.name === name))) throw fail("invalid", "Choose skills from this preview.");
    if (!Array.isArray(providers) || !providers.length || providers.length > 7 || new Set(providers).size !== providers.length) throw fail("invalid", "Choose at least one provider.");
    snapshot.planning = true;
    try {
      const destinations = [], physical = new Map();
      for (const provider of providers) for (const name of names) {
        try {
          const entry = await inspect(provider, snapshot.skills.find((skill) => skill.name === name));
          if (physical.has(entry.directory)) { physical.get(entry.directory).also.push(provider); continue; }
          entry.also = []; physical.set(entry.directory, entry); destinations.push(entry);
        } catch (error) { destinations.push({ provider, name, action: "blocked", error: error.message }); }
      }
      const planId = token(); snapshot.plan = { planId, destinations };
      // A partial retry reviews fresh destination revisions against the same
      // immutable source. Old plan IDs stop being usable; normal install
      // retries remain idempotent until a new review explicitly succeeds.
      snapshot.result = null;
      return { ok: true, planId, destinations: destinations.map(({ root, rootPath, revision, ...entry }) => entry), canInstall: destinations.every((entry) => entry.action !== "blocked") };
    } finally { snapshot.planning = false; }
  };
  const inspectEntry = (entry, skill, provider = entry.provider) => entry.installation ? updates.inspect(entry.installation) : inspect(provider, skill);
  const publish = async (entry, skill, snapshot) => serialized(path.join(entry.directory, "SKILL.md"), async () => {
    for (const provider of entry.also) {
      const alias = await inspect(provider, skill);
      if (alias.directory !== entry.directory || alias.action !== entry.action || alias.revision !== entry.revision) throw fail("conflict", "A shared provider folder changed after review.");
    }
    const fresh = await inspectEntry(entry, skill);
    if (fresh.directory !== entry.directory || fresh.root !== entry.root || fresh.action !== entry.action || fresh.revision !== entry.revision) throw fail("conflict", "The destination changed after review. Review the destinations again.");
    await io.mkdir(entry.rootPath, { recursive: true });
    if (await io.realpath(entry.rootPath) !== entry.root) throw fail("conflict", "The provider folder changed after review.");
    const staging = await io.mkdtemp(path.join(entry.root, ".t3-skill-import-"));
    let backup = null, reserved = false;
    try {
      if (skill.files.some((file) => file.name === ORIGIN_FILE)) throw fail("conflict", "This source contains reserved skill tracking metadata.");
      for (const file of skill.files) {
        const output = path.join(staging, file.name);
        await io.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        await io.writeFile(output, file.data, { flag: "wx", mode: file.mode });
        await io.chmod(output, file.mode);
      }
      if (snapshot.sourceType === "git" || snapshot.sourceType === "url") {
        // A source cannot supply or overwrite the console's provenance file.
        await io.writeFile(path.join(staging, ORIGIN_FILE), JSON.stringify({ version: 1, source: snapshot.source, name: skill.name, fingerprint: skillFingerprint(skill), autoUpdate: false, manual: false, linkedAt: Date.now() }) + "\n", { flag: "wx", mode: 0o600 });
      }
      // Recheck after staging too, so supporting-file edits invalidate replacement.
      for (const provider of [entry.provider, ...entry.also]) {
        const checked = await inspectEntry(entry, skill, provider);
        if (checked.root !== entry.root || checked.action !== entry.action || checked.revision !== entry.revision) throw fail("conflict", "The destination changed while preparing the import. Review again.");
      }
      if (entry.action === "replace") {
        const parked = path.join(entry.root, ".t3-skill-backup-" + token());
        await io.rename(entry.directory, parked);
        backup = parked;
        const moved = await removalPlan(io, { path: path.join(backup, "SKILL.md") }, { path: entry.root });
        if (moved.revision !== entry.revision) throw fail("conflict", "The skill changed during replacement.");
      }
      // Exclusive reservation refuses files/links/folders created by another writer.
      await io.mkdir(entry.directory, { mode: 0o700 }); reserved = true;
      await io.rename(staging, entry.directory); reserved = false;
    } catch (error) {
      if (reserved) await io.rmdir(entry.directory).catch(() => {});
      if (backup) {
        const occupied = await io.lstat(entry.directory).then(() => true, (check) => check.code !== "ENOENT");
        if (!occupied) {
          try { await io.rename(backup, entry.directory); }
          catch { throw fail("unavailable", "Restoring the previous skill failed. Its original files are preserved at " + backup); }
        }
        else throw fail("conflict", "The destination changed. The original is preserved at " + backup);
      }
      throw error;
    } finally { await io.rm(staging, { recursive: true, force: true }); invalidate(); }
    if (backup) {
      try { await io.rm(backup, { recursive: true }); }
      catch { return { ...entry, status: "installed", warning: "The previous copy remains at " + backup }; }
    }
    return { ...entry, status: "installed" };
  });
  const installImport = async (previewId, planId, replace = false) => {
    const snapshot = get(previewId), plan = snapshot.plan;
    if (snapshot.planning) throw fail("conflict", "Destination review is still running.");
    if (!plan || plan.planId !== planId) throw fail("conflict", "Review the current destinations before installing.");
    if (snapshot.result) return snapshot.result;
    if (snapshot.installing) return snapshot.installing;
    if (plan.destinations.some((entry) => entry.action === "blocked")) throw fail("unsupported", "Choose writable destinations before installing.");
    if (plan.destinations.some((entry) => entry.action === "replace") && replace !== true) throw fail("conflict", "Confirm replacement of the existing local skill folders.");
    snapshot.installing = (async () => {
      // Check all targets before the first write; individual writes check again.
      for (const entry of plan.destinations) for (const provider of [entry.provider, ...entry.also]) {
        const fresh = await inspectEntry(entry, snapshot.skills.find((skill) => skill.name === entry.name), provider);
        if (fresh.root !== entry.root || fresh.action !== entry.action || fresh.revision !== entry.revision) throw fail("conflict", "A destination changed after review. Review the destinations again.");
      }
      const results = [];
      for (const entry of plan.destinations) {
        try { results.push(await publish(entry, snapshot.skills.find((skill) => skill.name === entry.name), snapshot)); }
        catch (error) { results.push({ ...entry, status: "failed", error: error.message }); }
      }
      snapshot.result = { ok: true, results: results.map(({ root, rootPath, revision, installation, fileList, ...entry }) => entry) };
      return snapshot.result;
    })();
    try { return await snapshot.installing; } finally { snapshot.installing = null; }
  };
  const installUpdate = async (previewId, planId, replace) => {
    if (!get(previewId).update) throw fail("invalid", "Choose an update review for an installed skill.");
    return installImport(previewId, planId, replace);
  };
  const discardImport = async (previewId) => { const snapshot = previews.get(previewId); if (snapshot?.installing || snapshot?.planning) throw fail("conflict", "Installation is still running."); previews.delete(previewId); return { ok: true }; };
  return { previewSource, planImport, installImport, discardImport, previewUpdate, installUpdate };
}
