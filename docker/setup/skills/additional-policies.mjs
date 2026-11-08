// Native user policies for Grok, Muse and Pi. These describe saved user
// settings; project, package and managed policies may further restrict them.
import path from 'node:path';
import { parse, patch } from '../vendor/toml-patch.mjs';
import { parseSettings } from './policies.mjs';
import { readConfig, changeConfig } from '../mcp/files.mjs';
import { modify, applyEdits } from '../vendor/jsonc.mjs';
import { stateRevision } from './state.mjs';
import { agentResourcePaths } from '../agent-resources.mjs';
const fail = (code, message) => Object.assign(new Error(message), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const list = value => value === undefined ? [] : Array.isArray(value) && value.every(item => typeof item === 'string') ? value : (() => { throw fail('unsupported', 'Native skill settings must contain a list of paths or names.'); })();
const optionsFor = provider => (provider === 'muse' ? ['on', 'user-invocable-only', 'off'] : ['enabled', 'disabled']).map(value => ({ value, label: ({ on: 'On', 'user-invocable-only': 'Manual only', off: 'Off', enabled: 'On', disabled: 'Off' })[value] }));

export function createAdditionalSkillPolicies({ home, env, io, invalidate, onNativeChange = async () => {} }) {
  const roots = agentResourcePaths(home, env);
  const fileFor = provider => path.join(roots[provider], provider === 'grok' ? 'config.toml' : 'settings.json');
  // Muse persists the same symbolic display path that `skills list` returns,
  // including for linked installations. Absolute paths are different keys.
  const museKey = file => {
    const prefixes = [[roots.muse, '$CONFIG_DIR'], ...(path.isAbsolute(env.CODEX_HOME || '') ? [[env.CODEX_HOME, '$CODEX_HOME']] : []), [home, '$HOME']];
    for (const [root, label] of prefixes) {
      const relative = path.relative(root, file);
      if (relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) return label + '/' + relative.split(path.sep).join('/');
    }
    return file;
  };
  function document(provider, content) {
    if (provider === 'grok') {
      let value;
      try { value = parse(content); } catch { throw fail('unsupported', 'Grok settings are not valid TOML. Repair them before changing skill settings.'); }
      if (value.skills !== undefined && !object(value.skills)) throw fail('unsupported', 'Grok skills must be a table.');
      return value;
    }
    const value = parseSettings(content || '{}', true);
    if (provider === 'muse' && value.schema_version !== undefined && value.schema_version !== 1) throw fail('unsupported', 'This Muse settings schema is not supported.');
    if (provider === 'muse' && (value.skills !== undefined && !object(value.skills)
      || value.skills?.activation !== undefined && !object(value.skills.activation))) throw fail('unsupported', 'Muse skill activation settings must be objects.');
    return value;
  }
  function stateFor(provider, config, row) {
    if (provider === 'grok') return list(config.skills?.disabled).includes(row.name) ? 'disabled' : 'enabled';
    if (provider === 'muse') {
      const activation = config.skills?.activation?.user;
      if (activation !== undefined && !object(activation)) throw fail('unsupported', 'Muse user skill activation must be an object.');
      return activation?.[museKey(row.path)] ?? (row.invocation === 'manual' ? 'user-invocable-only' : 'on');
    }
    // Exact Pi overrides take precedence over glob/package exclusions. Keep
    // arbitrary globs untouched and call this a user setting, not effective state.
    const exact = list(config.skills).filter(value => ['+', '-'].includes(value[0]) && path.resolve(roots.pi, value.slice(1)) === row.path).at(-1);
    return exact?.startsWith('-') ? 'disabled' : 'enabled';
  }
  const inspect = async (provider, skills) => {
    const file = fileFor(provider), snapshot = await readConfig(io, file), config = document(provider, snapshot.content);
    return { skills: skills.map(row => {
      const state = stateFor(provider, config, row), options = optionsFor(provider);
      const reason = row.error || row.metadataError || (row.scope !== 'user' ? 'Manage system skills through their source.' : null)
        || (!options.some(option => option.value === state) ? 'This native skill state is not supported here.' : null);
      const result = { ...row, state, stateAuthority: 'user-policy', stateLabel: 'User setting: ' + (options.find(option => option.value === state)?.label || 'Unknown'),
        statePath: file, policyKey: provider === 'muse' ? museKey(row.path) : provider === 'pi' ? row.path : row.name,
        canSetState: !reason, canToggle: false, stateOptions: options, stateReadOnlyReason: reason,
        effectiveStateText: 'Saved user setting. Native project, package and session settings can further restrict availability.' };
      return { ...result, stateRevision: !reason ? stateRevision(snapshot.revision, result) : null };
    }) };
  };
  const set = async (provider, skillsFor, id, revision, state) => {
    if (!optionsFor(provider).some(option => option.value === state)) throw fail('invalid', 'Unknown native skill state.');
    const inventory = await skillsFor(), row = inventory.skills.find(row => row.id === id);
    if (!row) throw fail('missing', 'This skill is no longer in the inventory.');
    if (!row.canSetState) throw fail('unsupported', row.stateReadOnlyReason);
    if (!revision || row.stateRevision !== revision) throw fail('conflict', 'Native settings or this skill changed. Refresh before trying again.');
    const file = fileFor(provider), before = await readConfig(io, file);
    if (stateRevision(before.revision, row) !== revision || await io.realpath(row.path).catch(() => null) !== row.resolvedPath) throw fail('conflict', 'Native settings or the skill link changed. Refresh before trying again.');
    await changeConfig(io, file, before.revision, content => {
      const config = document(provider, content);
      if (provider === 'grok') {
        if (config.skills !== undefined && !object(config.skills)) throw fail('unsupported', 'Grok skills must be a table.');
        const disabled = list(config.skills?.disabled).filter(name => name !== row.name);
        if (state === 'disabled') disabled.push(row.name);
        return patch(content, { ...config, skills: { ...config.skills, disabled } });
      }
      let text = content || '{}\n';
      const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' };
      const edit = (keys, value) => { text = applyEdits(text, modify(text, keys, value, { formattingOptions })); };
      if (provider === 'muse') {
        if (config.schema_version === undefined) edit(['schema_version'], 1);
        edit(['skills', 'activation', 'user', museKey(row.path)], state);
      } else {
        const entries = list(config.skills).filter(value => !(['+', '-'].includes(value[0]) && path.resolve(roots.pi, value.slice(1)) === row.path));
        entries.push((state === 'disabled' ? '-' : '+') + row.path);
        edit(['skills'], entries);
      }
      return text;
    });
    invalidate();
    const propagation = await onNativeChange(provider);
    return { ok: true, provider, id, state, ...(propagation ? { propagation } : {}) };
  };
  return { inspect, set };
}
