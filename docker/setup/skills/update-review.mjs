// An update is bound to one discovered installation, including its physical
// folder and aliases. Browser-supplied paths never become write destinations.
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { removalPlan } from "./files.mjs";
import { readSkillOrigin, ORIGIN_FILE, fingerprintEntries } from "./origins.mjs";
import { SOURCE_LIMITS } from "./sources.mjs";

const fail = (code, message) => Object.assign(new Error(message), { code });
const inside = (root, file) => { const relative = path.relative(root, file); return relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep); };
const originKey = origin => JSON.stringify([origin?.source, origin?.name, origin?.fingerprint]);
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs].join(":");
const PREVIEW_BYTES = 1024 * 1024;
const utf8 = data => {
  if (data.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { return null; }
};

export function createSkillUpdateReview({ home, io, policyFor, readInstalled, readersFor, managedRoots }) {
  const inspect = async binding => {
    if (await io.realpath(binding.path).catch(() => null) !== binding.resolvedPath) throw fail("conflict", "This skill or its link changed. Review the update again.");
    const policy = await policyFor(binding.provider), caps = policy.capabilities(binding);
    if (!caps.canEdit) throw fail("unsupported", caps.readOnlyReason);
    if (originKey(await readSkillOrigin(io, binding, home)) !== originKey(binding.origin)) throw fail("conflict", "This skill’s repository tracking changed. Review the update again.");
    const file = await io.lstat(binding.resolvedPath), directory = path.dirname(binding.resolvedPath);
    if (!file.isFile() || path.basename(binding.resolvedPath) !== "SKILL.md") throw fail("unsupported", "Update an ordinary skill folder with a SKILL.md file.");
    // Folder links into another managed global root are preserved. A link into
    // an unrelated directory cannot authorize replacing that entire directory.
    const targets = managedRoots ? await managedRoots() : policy.creationTargets.map(target => target.path);
    const roots = await Promise.all(targets.map(directory => io.realpath(directory).catch(() => null)));
    if (!roots.some(root => root && inside(root, directory))) throw fail("unsupported", "This linked skill is outside the managed skill folders. Update it through its source or copy it into a managed folder first.");
    const root = path.dirname(directory), plan = await removalPlan(io, { path: binding.resolvedPath }, { path: root });
    if (plan.kind !== "directory") throw fail("unsupported", "This installation cannot be replaced as a complete skill folder.");
    if (binding.readers && JSON.stringify(await readersFor(binding.resolvedPath)) !== JSON.stringify(binding.readers)) throw fail("conflict", "The agents reading this folder changed. Review the affected agents again.");
    return { provider: binding.provider, name: binding.origin.name, rootPath: root, root, directory, action: "replace", revision: plan.revision,
      files: plan.files, fileList: plan.fileList, also: [], installation: binding };
  };
  const bind = async (provider, id) => {
    const row = await readInstalled(provider, id);
    if (!row.canEdit || !row.origin) throw fail("unsupported", "This skill has no editable repository installation. Re-import it from its repository to enable updates.");
    const binding = { provider, id, path: row.path, resolvedPath: row.resolvedPath, name: row.name, scope: row.scope, source: row.source, origin: row.origin };
    return { binding, entry: await inspect(binding), content: row.content };
  };
  const review = async (entry, incoming) => {
    const source = new Map(incoming.files.map(file => [file.name, { bytes: file.data.length, executable: Boolean(file.mode & 0o100), hash: createHash("sha256").update(file.data).digest("hex"), data: file.data }]));
    const installed = new Map(), fingerprints = [];
    let bytesRead = 0, completeFingerprint = true;
    // Reserve room for the compatible markdown.before/after fields too. Text
    // retention is independent of hashing: exhausting the preview budget must
    // never change fingerprints, conflict detection or replacement contents.
    let previewBytes = (entry.fileList.find(file => file.name === "SKILL.md")?.bytes || 0) + (source.get("SKILL.md")?.bytes || 0);
    const textPreview = (before, after, data) => {
      const omitted = textOmitted => ({ text: null, textOmitted });
      if (before?.linked) return omitted("linked");
      if ([before, after].some(file => file && file.bytes > SOURCE_LIMITS.markdownBytes)) return omitted("large");
      const incomingText = after ? utf8(after.data) : null;
      if (after && incomingText === null) return omitted("binary");
      const bytes = (before?.bytes || 0) + (after?.bytes || 0);
      if ((before && !data) || previewBytes + bytes > PREVIEW_BYTES) return omitted("budget");
      const installedText = before ? utf8(data) : null;
      if (before && installedText === null) return omitted("binary");
      previewBytes += bytes;
      return { text: { before: installedText, after: incomingText } };
    };
    const files = entry.fileList.filter(file => file.name !== ORIGIN_FILE).sort((a, b) =>
      Number(b.name === "SKILL.md") - Number(a.name === "SKILL.md") || a.name.localeCompare(b.name));
    for (const file of files) {
      let hash = null, data = null;
      if (!file.linked && file.bytes <= SOURCE_LIMITS.fileBytes && bytesRead + file.bytes <= SOURCE_LIMITS.bytes) {
        const filePath = path.join(entry.directory, file.name);
        if (await io.realpath(filePath) !== filePath) throw fail("conflict", "A supporting file link changed. Review the update again.");
        const handle = await io.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const before = await handle.stat();
          if (!before.isFile()) throw fail("unsupported", "This skill contains a special file. Manage that file directly before updating through Setup.");
          if (before.size !== file.bytes) throw fail("conflict", "A skill file changed while preparing the review. Review again.");
          const incoming = source.get(file.name);
          if (file.bytes <= SOURCE_LIMITS.markdownBytes && (!incoming || incoming.bytes <= SOURCE_LIMITS.markdownBytes)
            && previewBytes + file.bytes + (incoming?.bytes || 0) <= PREVIEW_BYTES) data = Buffer.alloc(file.bytes);
          const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let size = 0;
          while (true) {
            const read = await handle.read(buffer, 0, Math.min(buffer.length, file.bytes + 1 - size), size);
            if (!read.bytesRead) break;
            size += read.bytesRead;
            if (size > file.bytes) throw fail("conflict", "A skill file grew while preparing the review. Review again.");
            digest.update(buffer.subarray(0, read.bytesRead));
            if (data) buffer.copy(data, size - read.bytesRead, 0, read.bytesRead);
          }
          if (size !== before.size || stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await io.stat(filePath)) || await io.realpath(filePath) !== filePath) throw fail("conflict", "A skill file changed while preparing the review. Review again.");
          hash = digest.digest("hex"); bytesRead += size;
          fingerprints.push([file.name, Boolean(before.mode & 0o100), hash]);
        } finally { await handle.close(); }
      } else completeFingerprint = false;
      const before = { bytes: file.bytes, executable: file.executable, linked: file.linked, hash }, after = source.get(file.name);
      const unchanged = after && !before.linked && hash === after.hash && before.executable === after.executable;
      before.preview = unchanged ? { text: null, textOmitted: "unchanged" } : textPreview(before, after, data);
      installed.set(file.name, before);
    }
    const changes = [...new Set([...installed.keys(), ...source.keys()])].sort().map(name => {
      const before = installed.get(name), after = source.get(name);
      const status = !before ? "added" : !after ? "removed" : !before.linked && before.hash === after.hash && before.executable === after.executable ? "unchanged" : "modified";
      return { name, status, before: before ? { bytes: before.bytes, executable: before.executable, linked: before.linked } : null,
        after: after ? { bytes: after.bytes, executable: after.executable } : null,
        ...(before ? before.preview : textPreview(null, after, null)) };
    });
    const summary = Object.fromEntries(["added", "modified", "removed", "unchanged"].map(status => [status, changes.filter(file => file.status === status).length]));
    return { changes, summary, localChanges: !completeFingerprint || fingerprintEntries(fingerprints) !== entry.installation.origin.fingerprint };
  };
  return { bind, inspect, review };
}

// The idle pass installs only what a scheduled check already found, for a
// skill that opted in. A skill linked from a copy that already differed from
// its source waits for one reviewed update: Setup can't tell an older copy
// from a customized one, so it never guesses.
export const autoUpdateCandidate = entry => entry?.origin?.autoUpdate === true && entry.origin.reviewFirst !== true
  && entry.update?.status === "available";

// Idle auto-installs must never silently overwrite local edits the way an
// explicit "Replace my local edits" confirmation does. The update stays
// available and flagged in Updates for a manual review instead. Both review
// fields are always present; anything else is not installable.
export const autoInstallable = preview => preview?.canUpdate === true && preview?.localChanges === false;
