// Agents without a native per-skill switch can stop discovering an ordinary
// local installation by parking its whole directory outside the skills root.
// Supporting files and directory links move intact; shared/package skills do
// not get an inferred per-agent policy.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { serialized, skillRevision } from './files.mjs';
const fail = (code, message) => Object.assign(new Error(message), { code });
export const placementProviders = ['cursor', 'antigravity'];
export const disabledSkillRoot = root => root + '.t3-disabled';
export function placementPaths(root, row) {
  const parked = disabledSkillRoot(root), disabled = row.path.startsWith(parked + path.sep);
  const base = disabled ? parked : root;
  const relative = path.relative(base, row.path), parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[1] !== 'SKILL.md' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parts[0])) return null;
  return { disabled, source: path.join(base, parts[0]), target: path.join(disabled ? root : parked, parts[0]) };
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createSkillPlacement({ io, readSkillFile, invalidate }) {
  const revisionFor = async (root, row) => {
    const paths = placementPaths(root, row);
    if (!paths) return null;
    const file = await readSkillFile(row.resolvedPath, 65536, io), stat = await io.lstat(paths.source);
    const occupied = await io.lstat(paths.target).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
    return digest([skillRevision(row, file), stat.dev, stat.ino, stat.mtimeMs, occupied]);
  };
  const inspect = async (root, skills, policy) => Promise.all(skills.map(async row => {
    const paths = placementPaths(root, row);
    if (!paths) return row;
    // Disabled files are intentionally outside the normal editable roots.
    const active = paths.disabled ? { ...row, path: path.join(root, path.basename(paths.source), 'SKILL.md') } : row;
    let reason = policy.capabilities(active).readOnlyReason;
    if (skills.some(other => other.id !== row.id && other.name === row.name && !other.path.startsWith(disabledSkillRoot(root) + path.sep))) reason ||= 'Another installation has this name. Resolve the duplicate before moving this installation.';
    const result = { ...row, placementKey: path.join(root, path.basename(paths.source), 'SKILL.md'),
      state: paths.disabled ? 'disabled' : 'enabled', stateAuthority: 'placement', canToggle: !reason, canSetState: false,
      stateReadOnlyReason: reason, stateLabel: paths.disabled ? 'Parked outside discovery' : 'In provider folder',
      effectiveStateText: 'On/off moves this local installation, with its supporting files, into or out of the provider folder. Other agents reading this folder see the same move.' };
    return { ...result, stateRevision: !reason ? await revisionFor(root, row) : null };
  }));
  const set = async (provider, skillsFor, id, revision, enabled) => {
    if (typeof enabled !== 'boolean') throw fail('invalid', 'Expected a boolean availability choice.');
    const first = await skillsFor(), root = first.roots[0].path;
    return serialized(root, async () => {
      const inventory = await skillsFor(), row = inventory.skills.find(row => row.id === id);
      if (!row) throw fail('missing', 'This installation is no longer in the inventory.');
      if (!row.canToggle) throw fail('unsupported', row.stateReadOnlyReason || 'This installation cannot be moved.');
      if (!revision || row.stateRevision !== revision || await revisionFor(root, row) !== revision) throw fail('conflict', 'This skill or its destination changed. Refresh before trying again.');
      const locations = placementPaths(root, row);
      if (enabled === !locations.disabled) return { ok: true, provider, id, enabled };
      try { await io.lstat(locations.target); throw fail('conflict', 'The destination already exists. Resolve it before moving this skill.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await io.mkdir(path.dirname(locations.target), { recursive: true });
      if (await revisionFor(root, row) !== revision) throw fail('conflict', 'This skill changed before it could be moved. Refresh before trying again.');
      const sourceStat = await io.lstat(locations.source);
      if (sourceStat.isSymbolicLink()) {
        // Publish exclusively and keep relative links pointing at the same
        // installation when their parent changes to the parked root.
        const link = await io.readlink(locations.source);
        const target = path.isAbsolute(link) ? link : path.relative(path.dirname(locations.target), path.resolve(path.dirname(locations.source), link));
        try { await io.symlink(target, locations.target); }
        catch (error) { if (error.code === 'EEXIST') throw fail('conflict', 'The destination already exists. Refresh before moving this skill.'); throw error; }
        try {
          const current = await io.lstat(locations.source);
          if (!current.isSymbolicLink() || current.ino !== sourceStat.ino || current.dev !== sourceStat.dev || await io.readlink(locations.source) !== link) throw fail('conflict', 'The skill link changed before it could be moved.');
          await io.unlink(locations.source);
        } catch (error) { await io.unlink(locations.target); throw error; }
      } else await io.rename(locations.source, locations.target);
      invalidate();
      return { ok: true, provider, id, enabled };
    });
  };
  return { inspect, set };
}
