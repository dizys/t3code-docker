// Settings that would quietly defeat a gateway. Claude Code applies the `env`
// block of settings.json over its own environment, so a base URL there (which
// is what most gateway guides suggest) overrides every Claude instance, direct
// ones included, and `apiKeyHelper` sends a second credential beside the
// gateway's. Neither shows up as an error: requests just go somewhere else.
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const ENV_KEYS = Object.freeze(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);
const MAX_BYTES = 1024 * 1024;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const claudeSettingsPath = (home, env = {}) => path.join(path.resolve(home, String(env.CLAUDE_CONFIG_DIR ?? '').trim() || '.claude'), 'settings.json');

const readSettings = async (io, file) => {
  let text;
  try { text = await io.readFile(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (Buffer.byteLength(text) > MAX_BYTES) return null;
  try { const value = JSON.parse(text); return isObject(value) ? value : null; } catch { return null; }
};

const hostOf = value => { try { return new URL(String(value)).host; } catch { return null; } };

/** The conflict in Claude Code's settings file, or null. Values never leave this function. */
export async function scanClaudeSettings({ io, home, env }) {
  const file = claudeSettingsPath(home, env), settings = await readSettings(io, file).catch(() => null);
  if (!settings) return null;
  const keys = isObject(settings.env) ? ENV_KEYS.filter(key => settings.env[key] !== undefined && settings.env[key] !== '') : [];
  const helper = typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.trim() !== '';
  if (!keys.length && !helper) return null;
  return {
    id: 'claude-settings', agent: 'claude', file, keys: [...keys, ...(helper ? ['apiKeyHelper'] : [])],
    host: keys.includes('ANTHROPIC_BASE_URL') ? hostOf(settings.env.ANTHROPIC_BASE_URL) : null,
  };
}

/** Remove exactly the conflicting keys, leaving the rest of the file as it was parsed. */
export async function clearClaudeSettings({ io, home, env }) {
  const file = claudeSettingsPath(home, env), settings = await readSettings(io, file);
  if (!settings) return { changed: false };
  const next = { ...settings };
  if (isObject(next.env)) {
    next.env = Object.fromEntries(Object.entries(next.env).filter(([key]) => !ENV_KEYS.includes(key)));
    if (!Object.keys(next.env).length) delete next.env;
  }
  delete next.apiKeyHelper;
  if (JSON.stringify(next) === JSON.stringify(settings)) return { changed: false };
  // ~/.claude is a link into the state volume here; write through it, keeping its mode.
  const target = await io.realpath(file), stat = await io.stat(target);
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await io.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: stat.mode & 0o777 });
    await io.rename(temporary, target);
  } catch (error) { await io.rm?.(temporary, { force: true }).catch(() => {}); throw error; }
  return { changed: true };
}
