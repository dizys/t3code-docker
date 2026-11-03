// Tells every agent that the Vault exists. T3 Code's own instructions send agents
// straight to request_secret, so without this they would ask for a secret every
// time and never look here. Shared AGENTS.md only reaches three agents, while
// these three skill folders reach all seven.
//
// It behaves like any other skill once installed: an edit or a removal sticks,
// and only an untouched copy gets updated when the image ships a new one.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('./SKILL.md', import.meta.url));
const digest = text => createHash('sha256').update(text).digest('hex');

export function vaultSkillFolders({ home, env = {} }) {
  const claude = path.resolve(home, String(env.CLAUDE_CONFIG_DIR || '').trim() || '.claude');
  return [path.join(claude, 'skills', 't3-vault'), path.join(home, '.agents/skills/t3-vault'), path.join(home, '.gemini/config/skills/t3-vault')];
}

async function writeAtomic(file, text, effects) {
  const temporary = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
  try { await effects.writeFile(temporary, text, { flag: 'wx', mode: 0o644 }); await effects.rename(temporary, file); }
  finally { await effects.rm(temporary, { force: true }); }
}

export async function installVaultSkill({ home, env = {}, stateFile, effects = fs, source = SOURCE }) {
  const content = await effects.readFile(source, 'utf8'), wanted = digest(content);
  let last = null;
  try { last = JSON.parse(await effects.readFile(stateFile, 'utf8')).digest ?? null; } catch { /* First run. */ }
  for (const folder of vaultSkillFolders({ home, env })) {
    const file = path.join(folder, 'SKILL.md');
    try {
      let existing = null;
      try { existing = await effects.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') continue; }
      if (existing === null ? last !== null : digest(existing) !== last) continue;
      if (existing === content) continue;
      await effects.mkdir(folder, { recursive: true });
      await writeAtomic(file, content, effects);
    } catch { /* One unwritable agent folder shouldn't affect the others. */ }
  }
  await effects.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  await writeAtomic(stateFile, JSON.stringify({ digest: wanted }) + '\n', effects);
}
