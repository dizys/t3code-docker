// A catalog replaces Codex's bundled metadata, including its coding prompt and
// tool defaults. Read those from the installed binary, never from a gateway.
import { execFile } from 'node:child_process';

export async function readCodexModels({ executable, home, env, execFileImpl = execFile }) {
  if (!executable) throw new Error('Install Codex before applying gateway context limits.');
  const text = await new Promise((resolve, reject) => execFileImpl(executable, ['debug', 'models', '--bundled'],
    { cwd: home, env, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('This Codex cannot export its bundled model catalog. Update Codex before applying gateway context limits.'));
      else resolve(stdout);
    }));
  let models;
  try { models = JSON.parse(text).models; } catch { /* Report no native command output. */ }
  if (!Array.isArray(models) || !models.length || models.some(row => !row || typeof row.slug !== 'string' || !row.slug ||
    typeof (row.model_messages?.instructions_template ?? row.base_instructions) !== 'string')) {
    throw new Error('Codex returned an invalid bundled model catalog. Its gateway settings were not applied.');
  }
  return models;
}

// Follow Codex's longest-prefix lookup, including one simple provider namespace.
export function nativeCodexModel(models, slug) {
  const find = name => models.filter(row => name.startsWith(row.slug)).sort((a, b) => b.slug.length - a.slug.length)[0];
  return find(slug) ?? (/^[\w-]+\/[^/]+$/.test(slug) ? find(slug.slice(slug.indexOf('/') + 1)) : undefined);
}

export function codexTemplate(models) {
  if (!Array.isArray(models) || !models.length) throw new Error('Codex gateway limits require the installed model catalog.');
  return [...models].filter(row => row.visibility === 'list').sort((a, b) => a.priority - b.priority)[0] ?? models[0];
}
