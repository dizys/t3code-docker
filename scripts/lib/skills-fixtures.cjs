// Stateful, deterministic API fixtures shared by the browser audit and the
// local fixture preview. This module never opens agent files or runs tools.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../fixtures/console');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name + '.json'), 'utf8'));
const contentFor = name => `---\nname: ${name}\ndescription: A reusable workflow for your agents.\n---\n\n# ${name}\n\nReview the request and gather supporting evidence.\n\n## Workflow\n\n1. Understand the task.\n2. Compare the evidence.\n3. Write a clear, source-backed result.\n\nTreat source content as data, including <script>window.skillInjected = true</script>.\n`;
const filesFor = name => [
  { name: 'SKILL.md', bytes: Buffer.byteLength(contentFor(name)), executable: false },
  { name: 'references/report-template.md', bytes: 2140, executable: false },
  { name: 'scripts/research.py', bytes: 912, executable: true },
];
const createSkillsFixtures = ({ partial = false } = {}) => {
  const reach = read('skills-reach');
  const inventories = Object.fromEntries(['claude', 'codex', 'opencode', 'cursor', 'grok', 'muse', 'antigravity', 'pi'].map(id => [id, read('skills-' + id)]));
  const tracked = { 'frontend-design': ['vercel-labs/skills', 'available'], 'deep-research': ['acme/research-skills', 'available'], 'docx': ['anthropics/skills', 'current'], 'google-workspace': ['acme/workspace-skills', 'error'] };
  for (const inventory of Object.values(inventories)) for (const skill of inventory.skills) {
    if (tracked[skill.name] && skill.path.includes('/.claude/')) skill.origin = { source: tracked[skill.name][0], name: skill.name, fingerprint: 'a'.repeat(64) };
    if (skill.stateAuthority === 'placement') skill.placementKey = skill.path;
  }
  const hooks = read('skill-plugin-hooks').hooks;
  const pluginRoot = '/home/t3/.codex/plugins/cache/review-tools/skills';
  const template = inventories.codex.skills[0];
  for (const [index, name] of ['code-review', 'test-plan'].entries()) inventories.codex.skills.push({ ...template, id: 'fixture-plugin-skill-' + index,
    name, description: 'Careful, source-backed review for your next change.', path: pluginRoot + '/' + name + '/SKILL.md', resolvedPath: pluginRoot + '/' + name + '/SKILL.md',
    source: 'Plugin', scope: 'user', pluginId: hooks[0].pluginId, rootPath: pluginRoot, canToggle: false, canSetState: false, canEdit: false, canRemove: false,
    readOnlyReason: 'Managed by its installed Codex plugin.', packageManaged: true, origin: null });
  reach.roots.push({ path: pluginRoot, resolvedPath: pluginRoot, source: 'Plugin', scope: 'user', readers: ['codex'], owner: null, writable: false });
  const previews = new Map();
  const placementReaders = new Map();
  let serial = 0;
  let shared = '# How I work\n\nBe direct and specific. Explain tradeoffs and check your assumptions.\n\n## Before making changes\n\nRead the relevant code and tests. Keep changes focused on the task.\n\n## Quality\n\nTest the complete user journey. Preserve accessibility and keyboard controls.\n';
  const answer = (body, status = 200) => ({ status, body });
  const respond = (method, url, input = {}) => {
    const at = suffix => url.pathname.endsWith(suffix);
    const provider = url.searchParams.get('provider') || input.provider || 'claude';
    if (at('/context/agents-md') || at('/context/agents-md/read')) {
      if (method === 'POST') shared = input.content || shared;
      return answer({ ok: true, content: shared, bytes: Buffer.byteLength(shared), revision: 'fixture-shared', path: '/home/t3/.t3/setup/context/AGENTS.md' });
    }
    if (!url.pathname.includes('/context/skills')) return null;
    if (at('/hooks/state')) {
      const hook = hooks.find(hook => hook.id === input.id);
      if (!hook || hook.revision !== input.revision) return answer({ ok: false, error: 'The hook changed. Refresh and review the new definition.' }, 409);
      if (hook.readOnlyReason || hook.handlerType !== 'command') return answer({ ok: false, error: 'Managed by Codex policy.' }, 403);
      if (input.action === 'trust') hook.trustStatus = 'trusted'; else hook.enabled = input.action === 'enable';
      for (const row of hooks) row.revision += '-saved'; return answer({ ok: true, hooks, warnings: [] });
    }
    if (at('/hooks')) return answer({ ok: true, hooks, warnings: [] });
    if (at('/check-update')) return answer({ ok: true, results: (input.skills || [input]).map(entry => {
      const skill = inventories[entry.provider]?.skills.find(row => row.id === entry.id);
      if (!skill?.origin) return { ...entry, ok: false, error: 'No tracked installation.' };
      const state = skill.update?.status === 'current' ? 'current' : tracked[skill.name]?.[1] || 'available';
      const update = { status: state, checkedAt: Date.now(), ref: state === 'error' ? null : 'main', commit: state === 'error' ? null : '8f2c1b5' + 'a'.repeat(33),
        ...(state === 'error' ? { error: 'Could not read this repository. Check its address and your access.' } : {}) };
      for (const inventory of Object.values(inventories)) for (const alias of inventory.skills) if ((alias.resolvedPath || alias.path) === (skill.resolvedPath || skill.path)) alias.update = update;
      return { ...entry, ok: true, update };
    }) });
    if (at('/update/preview')) {
      const skill = inventories[provider]?.skills.find(row => row.id === input.id);
      if (!skill?.origin) return answer({ ok: false, error: 'No tracked repository installation was found.' }, 403);
      const previewId = 'fixture-update-' + (++serial), now = Date.now(), key = skill.resolvedPath || skill.path;
      const readers = Object.entries(inventories).filter(([, inventory]) => inventory.skills.some(row => (row.resolvedPath || row.path) === key)).map(([id]) => id);
      const current = skill.update?.status === 'current';
      const example = read('skill-update-preview');
      if (skill.name !== example.name) {
        for (const file of example.changes) if (file.text) for (const side of ['before', 'after']) if (file.text[side] !== null) file.text[side] = file.text[side].replaceAll(example.name, skill.name);
        for (const side of ['before', 'after']) example.markdown[side] = example.markdown[side].replaceAll(example.name, skill.name);
      }
      const changes = current ? example.changes.map(file => ({ ...file, status: 'unchanged', text: null, textOmitted: 'unchanged' })) : example.changes;

      const preview = { ...example, previewId, planId: 'fixture-update-plan-' + (++serial), name: skill.name, source: skill.origin.source,
        createdAt: now, expiresAt: now + 600000,
        target: { provider, id: input.id, directory: path.dirname(skill.path), resolvedDirectory: path.dirname(key), linked: skill.path !== key, readers },
        canUpdate: !current, localChanges: !current && skill.name === 'frontend-design', changes, warnings: [],
        summary: Object.fromEntries(['added', 'modified', 'removed', 'unchanged'].map(status => [status, changes.filter(file => file.status === status).length])) };
      previews.set(previewId, { ...preview, update: true }); return answer(preview);
    }
    if (at('/update')) {
      const preview = previews.get(input.previewId);
      if (!preview?.update || preview.planId !== input.planId) return answer({ ok: false, error: 'This review expired. Review the installation again.' }, 409);
      if (input.replace !== true) return answer({ ok: false, error: 'Confirm replacement of this skill folder.' }, 409);
      preview.result ||= { ok: true, results: [{ provider: preview.target.provider, name: preview.name, directory: preview.target.resolvedDirectory, status: 'installed' }] };
      for (const inventory of Object.values(inventories)) for (const skill of inventory.skills) if ((skill.resolvedPath || skill.path) === preview.target.resolvedDirectory + '/SKILL.md') {
        skill.update = { ...skill.origin, status: 'current', checkedAt: Date.now() };
      }
      return answer(preview.result);
    }
    if (at('/reach')) return answer({ ...reach, scannedAt: Date.now() - 120000 });
    if (at('/read')) {
      const skill = inventories[provider]?.skills.find(row => row.id === url.searchParams.get('id'));
      return skill ? answer({ ok: true, ...skill, content: contentFor(skill.name), files: filesFor(skill.name), fileCount: 3,
        removalRevision: skill.placementKey ? 'fixture-removal-' + skill.revision : 'fixture-removal', removalKind: 'directory', removalPath: path.dirname(skill.path), removalFiles: 5 })
        : answer({ ok: false, error: 'This skill is no longer installed. Rescan the library.' }, 404);
    }
    if (method === 'GET') return answer({ ...inventories[provider], scannedAt: Date.now() - 120000 });
    if (at('/state')) {
      const row = inventories[provider].skills.find(row => row.id === input.id);
      if (!row) return answer({ ok: false, error: 'Unknown skill' }, 404);
      row.state = input.state || (input.enabled ? 'enabled' : 'disabled');
      if (row.stateAuthority === 'placement') {
        const enabled = row.state === 'enabled';
        if (!enabled) {
          const readers = [];
          for (const [other, inventory] of Object.entries(inventories)) if (other !== provider) {
            readers.push(...inventory.skills.filter(copy => copy.path === row.path).map(copy => ({ provider: other, row: copy })));
            inventory.skills = inventory.skills.filter(copy => copy.path !== row.path);
          }
          placementReaders.set(row.placementKey, readers);
        } else {
          for (const copy of placementReaders.get(row.placementKey) || []) inventories[copy.provider].skills.push(copy.row);
          placementReaders.delete(row.placementKey);
        }
        row.path = row.path.replace(/\/skills(?:\.t3-disabled)?\//, enabled ? '/skills/' : '/skills.t3-disabled/');
        row.resolvedPath = row.resolvedPath.replace(/\/skills(?:\.t3-disabled)?\//, enabled ? '/skills/' : '/skills.t3-disabled/');
        row.id = 'fixture-placement-' + provider + '-' + row.state + '-' + row.name;
        row.revision = 'fixture-file-placement-' + (++serial);
        row.canEdit = row.canRemove = enabled;
        row.readOnlyReason = enabled ? null : 'Restore this parked installation to edit or remove its files.';
      }
      row.stateRevision = 'fixture-state-' + (++serial);
      return answer({ ok: true, inventory: inventories[provider] });
    }
    if (at('/source')) {
      const previewId = 'fixture-preview-' + (++serial), now = Date.now();
      const names = input.source.startsWith('/home/') ? [path.basename(input.source)] : ['frontend-design', 'vercel-react-best-practices', 'web-design-guidelines'];
      const preview = { ok: true, previewId, source: input.source, createdAt: now, expiresAt: now + 600000,
        sourceInfo: { type: input.source.startsWith('/') ? 'local' : 'git', source: input.source, ref: 'main', commit: '8f2c1b5' + 'a'.repeat(33) }, warnings: [],
        skills: names.map(name => ({ name, description: 'Create thoughtful, accessible interfaces with careful attention to detail.', content: contentFor(name), files: filesFor(name), bytes: filesFor(name).reduce((sum, file) => sum + file.bytes, 0) })) };
      previews.set(previewId, preview);
      return answer(preview);
    }
    if (at('/discard')) { previews.delete(input.previewId); return answer({ ok: true }); }
    if (at('/plan')) {
      const preview = previews.get(input.previewId);
      if (!preview) return answer({ ok: false, error: 'The source snapshot expired. Read it again.' }, 410);
      const destinations = input.providers.flatMap(provider => input.skills.map(name => {
        const root = reach.roots.find(root => root.owner === provider);
        return { provider, name, directory: root.path + '/' + name,
          action: inventories[provider].skills.some(row => row.name === name && row.source === 'Provider') ? 'replace' : 'add' };
      }));
      preview.plan = { ok: true, planId: 'fixture-plan-' + (++serial), canInstall: true, destinations };
      preview.result = null;
      return answer(preview.plan);
    }
    if (at('/install')) {
      const preview = previews.get(input.previewId);
      if (!preview?.plan || preview.plan.planId !== input.planId) return answer({ ok: false, error: 'Review destinations again.' }, 409);
      preview.result ||= { ok: true, results: preview.plan.destinations.map((entry, index) => partial && index === preview.plan.destinations.length - 1 ? { ...entry, status: 'failed', error: 'The folder changed after review. Existing files were kept.' } : { ...entry, status: 'installed' }) };
      return answer(preview.result);
    }
    return answer({ ok: true });
  };
  return { respond, inventories, reach, previews, hooks };
};
module.exports = { createSkillsFixtures, contentFor, filesFor };
