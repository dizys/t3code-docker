// Resource paths shared by Instructions, Skills and MCP. Explicit homes keep
// every operation testable without reading the operator's resources.
import path from 'node:path';
import { opencodeConfigRoot } from './opencode-config.mjs';

export const AGENT_NAMES = Object.freeze({
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor',
  grok: 'Grok Build', muse: 'Muse Code', antigravity: 'Antigravity', pi: 'Pi',
});
export function agentResourcePaths(home = '/home/t3', env = {}) {
  const at = (key, fallback) => path.resolve(home, String(env[key] || '').trim() || fallback);
  const config = at('XDG_CONFIG_HOME', '.config');
  return {
    claude: at('CLAUDE_CONFIG_DIR', '.claude'), codex: at('CODEX_HOME', '.codex'),
    opencode: opencodeConfigRoot(home, env), cursor: path.join(home, '.cursor'),
    grok: at('GROK_HOME', '.grok'), muse: path.join(config, 'muse'),
    antigravity: path.join(home, '.gemini', 'config'), pi: at('PI_CODING_AGENT_DIR', '.pi/agent'),
  };
}
