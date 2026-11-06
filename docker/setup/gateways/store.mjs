// Gateways on the state volume. Keys are not here: they live in the Vault, and
// this file names the credential. A revision keeps two windows from overwriting
// each other, the same way the MCP library does.
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { withStore } from '../mcp/store.mjs';

const VERSION = 1;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_GATEWAYS = 16;

export const gatewayStorePath = baseDir => path.join(baseDir, 'setup', 'gateways', 'gateways.json');
export const gatewayFilesDir = baseDir => path.join(baseDir, 'setup', 'gateways', 'agents');
// A revision covers what someone decided. Health checks and model syncing write
// in the background, and must not read as a change anyone has to refresh for.
const decisions = ({ check, latest, agents = {}, ...gateway }) => ({ ...gateway, agents: Object.fromEntries(Object.entries(agents).map(([id, { on, scope }]) => [id, { on, scope }])) });
export const revisionOf = gateways => createHash('sha256').update(JSON.stringify(gateways.map(decisions))).digest('hex').slice(0, 32);
const problem = (code, message) => Object.assign(new Error(message), { code });

/** Write a private file unless it already says this. Answers whether it changed. */
export async function writePrivate(io, file, text) {
  if (await io.readFile(file, 'utf8').catch(() => null) === text) return false;
  await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await io.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await io.rename(temporary, file);
  } catch (error) { await io.rm?.(temporary, { force: true }).catch(() => {}); throw error; }
  return true;
}

export function createGatewayStore({ io, baseDir }) {
  const file = gatewayStorePath(baseDir);
  const read = async () => {
    let text;
    try { text = await io.readFile(file, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return { gateways: [], revision: revisionOf([]), present: false }; throw problem('store', 'Saved gateways could not be read. Check the state volume and its permissions.'); }
    if (Buffer.byteLength(text) > MAX_BYTES) throw problem('store', 'The saved gateways file is too large.');
    let data;
    try { data = JSON.parse(text); } catch { throw problem('store', 'The saved gateways file is damaged. Restore it before making changes.'); }
    if (data?.version !== VERSION || !Array.isArray(data.gateways)) throw problem('store', 'The saved gateways file is from a newer version of Setup.');
    return { gateways: data.gateways, revision: revisionOf(data.gateways), present: true };
  };
  const write = async gateways => {
    if (gateways.length > MAX_GATEWAYS) throw problem('invalid', `Save at most ${MAX_GATEWAYS} gateways.`);
    await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await io.writeFile(temporary, JSON.stringify({ version: VERSION, gateways }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await io.rename(temporary, file);
    } catch (error) {
      await io.rm?.(temporary, { force: true }).catch(() => {});
      throw problem('store', `Gateways could not be saved: ${String(error?.message ?? error).slice(0, 160)}`);
    }
    return revisionOf(gateways);
  };
  /** Serialize a read-change-write, refusing one that started from an old revision. */
  const update = (expected, change) => withStore(file, async () => {
    const current = await read();
    if (expected !== undefined && expected !== current.revision) throw problem('conflict', 'Gateways changed in another window. Refresh before changing them.');
    const next = await change(current.gateways);
    if (next === undefined) return { gateways: current.gateways, revision: current.revision };
    return { gateways: next, revision: await write(next) };
  });
  return { file, read, update };
}
