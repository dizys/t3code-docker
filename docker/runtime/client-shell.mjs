// The Setup bridge belongs to the image, even when the native runtime is kept
// on a volume. Refresh only our marked script; leave upstream assets untouched.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function injectSetupBridge(shell, bridge) {
  if (!shell.includes('</body>') || !bridge.includes('data-t3-setup-entry') || /<\/script/i.test(bridge)) throw new Error('This runtime cannot preserve the Setup entry.');
  const scripts = /<script\b[^>]*\bdata-t3-setup-bridge(?:\s[^>]*)?>[\s\S]*?<\/script>\n?/gi;
  const clean = shell.replace(scripts, '');
  // Refuse a malformed or differently owned marker instead of duplicating it.
  if (clean.includes('data-t3-setup-bridge')) throw new Error('The native client has an unrecognized Setup bridge marker.');
  return clean.replace('</body>', `<script data-t3-setup-bridge>\n${bridge}\n</script>\n</body>`);
}

export async function refreshSetupBridge(runtime, bridge) {
  if (runtime.bundled || !bridge) return false; // The bundled shell is patched at image build time.
  const file = path.join(path.dirname(runtime.binary), 'client/index.html');
  const [shell, script] = await Promise.all([fs.readFile(file, 'utf8'), fs.readFile(bridge, 'utf8')]);
  const next = injectSetupBridge(shell, script);
  if (next === shell) return false;
  const temporary = file + '.setup-' + randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, next, { mode: (await fs.stat(file)).mode, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
  return true;
}
