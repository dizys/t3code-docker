// Retiring the agent processes behind an instance.
//
// T3 Code keeps an agent process past any change to its instance. Codex and
// OpenCode share one per instance, and it lives until it has been idle for 30
// minutes, so a new key or address wouldn't reach it, and a turn resets the
// clock. T3 has no call to end one: its detach only unloads a thread. Ending the
// process is the same thing as a crash, which T3 already recovers from, and the
// next turn starts one with the instance's current settings.
//
// Each gateway instance carries a marker, so nothing else can match. Marked
// processes include whatever an agent started (a dev server, a test run), and
// those belong to the person, so the command line must be the agent's own too.
import * as defaultFs from 'node:fs/promises';
import path from 'node:path';
import { GATEWAY_INSTANCE_ENV } from './catalog.mjs';

const GRACE_MS = 1500;

/** Whether a command line is this agent itself, and not something it launched. */
const IS_AGENT = Object.freeze({
  claude: argv => path.basename(argv[0] ?? '') === 'claude',
  codex: argv => /^codex/.test(path.basename(argv[0] ?? '')) && argv.includes('app-server'),
  opencode: argv => /^opencode/.test(path.basename(argv[0] ?? '')) && argv.includes('serve'),
});

const split = text => text.split('\0').filter(Boolean);

export function createGatewayProcesses({ proc = '/proc', io = defaultFs, kill = process.kill.bind(process), wait = ms => new Promise(resolve => setTimeout(resolve, ms)), self = process.pid } = {}) {
  const find = async (agentId, instanceId) => {
    const marker = `${GATEWAY_INSTANCE_ENV}=${instanceId}`, isAgent = IS_AGENT[agentId], found = [];
    for (const entry of await io.readdir(proc).catch(() => [])) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid === self) continue;
      // A process can exit, or belong to someone else, between listing and reading.
      try {
        if (!split(await io.readFile(path.join(proc, entry, 'environ'), 'utf8')).includes(marker)) continue;
        if (isAgent(split(await io.readFile(path.join(proc, entry, 'cmdline'), 'utf8')))) found.push(pid);
      } catch { /* gone, or not ours */ }
    }
    return found;
  };
  const signal = (pid, name) => { try { kill(pid, name); return true; } catch { return false; } };
  /** End this instance's agent processes. Answers how many were asked to stop. */
  const stop = async (agentId, instanceId) => {
    const pids = await find(agentId, instanceId);
    for (const pid of pids) signal(pid, 'SIGTERM');
    if (!pids.length) return 0;
    await wait(GRACE_MS);
    for (const pid of await find(agentId, instanceId)) if (pids.includes(pid)) signal(pid, 'SIGKILL');
    return pids.length;
  };
  return { find, stop };
}
