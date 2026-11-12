import { promises as fs, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import { ServiceError } from './store.mjs';
import { createManagedDNS, dnsSuffix } from './managed-dns.mjs';
import { protectedPath } from './storage.mjs';

const exec = promisify(execFile), TABLE = 't3code_tailscale', OWNER = 't3code-services-tailscale-v1';
const INTERFACE = 'tailscale0', KEY = 'network:tailscale:firewall';
export const TAILSCALE_COMPOSE = `# Merge into your existing t3code service; keep its volumes and ports.
services:
  t3code:
    environment:
      T3_TAILSCALE_NETWORKING: "1"
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
`;
const matchInterface = { match: { op: '==', left: { meta: { key: 'iifname' } }, right: INTERFACE } };
const expectedRules = [
  [matchInterface, { match: { op: 'in', left: { ct: { key: 'state' } }, right: { set: ['established', 'related'] } } }, { accept: null }],
  [matchInterface, { drop: null }],
];
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    // nftables emits unbraced state flags as a list, and braced states as a
    // set. Only positive conntrack membership has these equivalent forms.
    // In particular, never normalize a negated predicate into an allow rule.
    if (value.left?.ct?.key === 'state') {
      if (value.op === 'in' && Array.isArray(value.right)) value = { ...value, right: { set: [...value.right].sort() } };
      else if (['==', 'in'].includes(value.op) && Array.isArray(value.right?.set)) value = { ...value, op: 'in', right: { ...value.right, set: [...value.right.set].sort() } };
    }
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  }
  return value;
};
export function ownedFirewall(value) {
  const rows = value?.nftables;
  if (!Array.isArray(rows)) return false;
  const tables = rows.filter(item => item.table).map(item => item.table);
  const chains = rows.filter(item => item.chain).map(item => item.chain);
  const rules = rows.filter(item => item.rule).map(item => item.rule);
  const inTable = item => item.family === 'inet' && item.table === TABLE;
  if (tables.length !== 1 || tables[0].family !== 'inet' || tables[0].name !== TABLE || tables[0].comment !== OWNER) return false;
  if (tables[0].flags !== undefined && (!Array.isArray(tables[0].flags) || tables[0].flags.length !== 0)) return false;
  if (chains.length !== 1 || !inTable(chains[0]) || chains[0].name !== 'input' || chains[0].type !== 'filter' || chains[0].hook !== 'input' || chains[0].prio !== -10 || chains[0].policy !== 'accept') return false;
  return rules.length === 2 && rules.every((rule, index) => inTable(rule) && rule.chain === 'input' && JSON.stringify(normalize(rule.expr)) === JSON.stringify(normalize(expectedRules[index])))
    && rows.every(item => item.metainfo || item.table || item.chain || item.rule);
}
const firewallScript = `add table inet ${TABLE} { comment "${OWNER}"; }
add chain inet ${TABLE} input { type filter hook input priority -10; policy accept; }
add rule inet ${TABLE} input iifname "${INTERFACE}" ct state established,related accept
add rule inet ${TABLE} input iifname "${INTERFACE}" drop
`;
async function dnsProbe(connection) {
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  resolver.setServers(['127.0.0.54']);
  try {
    const ipv4 = connection.ips.filter(ip => net.isIP(ip) === 4);
    const result = ipv4.length ? await resolver.resolve4(connection.dnsName) : await resolver.resolve6(connection.dnsName);
    if (!result.some(ip => connection.ips.includes(ip))) throw new Error('dns-identity');
  } finally { resolver.cancel(); }
}
export function createTailscaleNetworking({ store, boot, env = process.env, io = fs, run = (file, args) => exec(file, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/', LANG: 'C.UTF-8' }, timeout: 5000, maxBuffer: 65536 }), dns = createManagedDNS({ store, boot }), probeDNS = dnsProbe, verifyExecutable = protectedPath, now = Date.now } = {}) {
  let cached = null, preferencesRun = null, dnsChecked = null;
  const requirements = async ({ fresh = false } = {}) => {
    if (!fresh && cached && now() - cached.at < 5000) return cached.value;
    const checks = [{ id: 'deployment', label: 'Deployment opt-in', ok: env.T3_TAILSCALE_NETWORKING === '1' }];
    if (!checks[0].ok) {
      const value = { ready: false, checks, compose: TAILSCALE_COMPOSE, message: 'Apply the optional Tailscale Compose override, recreate this container, then check again.' };
      cached = { at: now(), value }; return value;
    }
    const add = async (id, label, check) => { let ok = false, detail = null; try { ok = Boolean(await check()); } catch (error) { if (error instanceof ServiceError) detail = error.message; } checks.push({ id, label, ok, ...(detail ? { detail } : {}) }); };
    await add('tun', 'TUN device', async () => { const stat = await io.stat('/dev/net/tun'); await io.access('/dev/net/tun', constants.R_OK | constants.W_OK); return stat.isCharacterDevice(); });
    await add('capability', 'NET_ADMIN capability', async () => { const value = /^CapEff:\s+([a-f0-9]+)$/im.exec(await io.readFile('/proc/self/status', 'utf8')); return value && Boolean(BigInt('0x' + value[1]) & (1n << 12n)); });
    await add('dns', 'Writable deployment DNS', async () => { await dns.preflight(); return true; });
    await add('firewall', 'Kernel firewall', async () => { if (!checks.find(item => item.id === 'capability').ok) return false; await run('/usr/sbin/nft', ['-j', 'list', 'tables']); return true; });
    const ready = checks.every(check => check.ok), value = { ready, checks, compose: TAILSCALE_COMPOSE, message: ready ? 'This deployment supports full networking.' : 'This deployment is missing full-networking requirements. Merge the override, check host TUN support and recreate through your deployment manager.' };
    cached = { at: now(), value }; return value;
  };
  const assertRequirements = async () => { const result = await requirements({ fresh: true }); if (!result.ready) throw new ServiceError('deployment-required', result.message, 'networkMode'); };
  const readFirewall = async () => {
    const { stdout } = await run('/usr/sbin/nft', ['-j', 'list', 'tables']);
    if (!JSON.parse(stdout).nftables?.some(item => item.table?.family === 'inet' && item.table.name === TABLE)) return null;
    return JSON.parse((await run('/usr/sbin/nft', ['-j', 'list', 'table', 'inet', TABLE])).stdout);
  };
  const ensureFirewall = async () => {
    const existing = await readFirewall();
    if (existing && !ownedFirewall(existing)) throw new ServiceError('network-conflict', 'The Tailscale inbound filter was changed outside Services. It was preserved. Review the conflicting firewall before restarting full networking.', 'networkMode');
    // Record ownership before the atomic nft transaction, so controller loss
    // after creation can reattach or clean up the same table.
    const namespace = await io.readlink('/proc/self/ns/net'), saved = store.meta(KEY);
    if (!saved || saved.boot !== boot || saved.namespace !== namespace) store.setMeta(KEY, { schema: 1, boot, namespace });
    if (!existing) await run('/usr/sbin/nft', [firewallScript]);
    if (!ownedFirewall(await readFirewall())) throw new ServiceError('network-firewall', 'The Tailscale inbound filter could not be verified. Full networking was not activated.', 'networkMode');
  };
  const removeFirewall = async () => {
    const saved = store.meta(KEY);
    if (!saved) return;
    // Recreation can remove both the capability and the old network namespace.
    // Its firewall belongs to that namespace and needs no privileged cleanup
    // in the replacement container.
    if (saved.namespace && saved.namespace !== await io.readlink('/proc/self/ns/net')) { store.setMeta(KEY, null); return; }
    const existing = await readFirewall();
    if (existing) {
      if (!ownedFirewall(existing)) throw new ServiceError('network-conflict', 'The Tailscale firewall was edited outside Services. Your rules were preserved; review them before retrying cleanup.', 'networkMode');
      await run('/usr/sbin/nft', ['delete', 'table', 'inet', TABLE]);
      if (await readFirewall()) throw new ServiceError('network-firewall', 'The owned Tailscale firewall could not be removed. Retry cleanup.');
    }
    store.setMeta(KEY, null);
  };
  const validate = async config => { if (config.networkMode === 'kernel') await assertRequirements(); };
  const prepare = async resource => {
    if (resource.config.networkMode !== 'kernel') return;
    await assertRequirements();
    let interfaceExists = true;
    try { await io.stat('/sys/class/net/' + INTERFACE); } catch (error) { if (error.code === 'ENOENT') interfaceExists = false; else throw error; }
    if (interfaceExists) throw new ServiceError('network-conflict', 'A tailscale0 interface already exists outside this managed run. It was preserved. Stop the other owner before enabling full networking.', 'networkMode');
    await ensureFirewall();
    preferencesRun = null; dnsChecked = null;
  };
  const stopped = async () => { dnsChecked = null; await dns.restore(); await removeFirewall(); };
  const failClosed = async message => {
    try { await dns.restore(); } catch { message += ' DNS cleanup also needs attention; its original backup was retained.'; }
    return { mode: 'kernel', state: 'error', fatal: true, dns: 'deployment', message };
  };
  const observe = async (resource, process, connection, runId) => {
    const kernel = resource?.config.networkMode === 'kernel';
    if (!kernel || !resource.enabled || resource.uninstalled || resource.stoppedBoot === boot || !process.up) {
      await dns.restore(); dnsChecked = null;
      // An unavailable supervisor is not proof that the daemon has stopped.
      if (!process.up && !process.unavailable) await removeFirewall();
      return { mode: kernel ? 'kernel' : 'userspace', state: kernel ? 'inactive' : 'userspace', dns: 'deployment', message: kernel ? 'Full networking is stopped. Deployment DNS is in use.' : 'Published TCP routes only. Ordinary programs use deployment networking.' };
    }
    if (!(await requirements()).ready) return failClosed('Full networking requirements are no longer available. Review the deployment requirements.');
    try { await ensureFirewall(); }
    catch (error) { return failClosed(error instanceof ServiceError ? error.message : 'The inbound filter could not be checked. Full networking needs to stop.'); }
    if (!connection || connection.state !== 'Running') {
      await dns.restore(); dnsChecked = null;
      return { mode: 'kernel', state: connection?.state === 'NeedsLogin' ? 'needs-login' : connection?.state === 'NeedsMachineAuth' ? 'needs-approval' : 'connecting', dns: 'deployment', message: connection?.state === 'NeedsLogin' ? 'Sign in to connect this container to your tailnet.' : connection?.state === 'NeedsMachineAuth' ? 'Approve this device in the Tailscale admin console.' : 'Waiting for Tailscale to connect. Deployment DNS is in use.' };
    }
    if (preferencesRun !== runId) {
      const cli = resource.artifact.path + '/tailscale'; await verifyExecutable(cli, { directory: false });
      await run(cli, ['--socket=/run/t3code-services/tailscale.sock', 'set', '--accept-dns=false', '--accept-routes=false', '--hostname=' + resource.config.hostname]);
      preferencesRun = runId;
    }
    const links = JSON.parse((await run('/usr/sbin/ip', ['-j', 'link', 'show', 'dev', INTERFACE])).stdout);
    const routes = JSON.parse((await run('/usr/sbin/ip', ['-j', 'route', 'get', '100.100.100.100'])).stdout);
    if (!links.some(item => item.ifname === INTERFACE && item.flags?.includes('UP')) || !routes.some(item => item.dev === INTERFACE)) { await dns.restore(); dnsChecked = null; return { mode: 'kernel', state: 'connecting', dns: 'deployment', message: 'Tailscale is signed in; waiting for the container interface and tailnet route.' }; }
    const suffix = dnsSuffix(connection.dnsSuffix);
    if (!connection.magicDNSEnabled || !suffix) { await dns.restore(); dnsChecked = null; return { mode: 'kernel', state: 'ready', dns: 'disabled', inbound: 'published-routes', interface: INTERFACE, message: 'Tailnet IP connectivity is ready. Enable MagicDNS in your Tailscale admin console to use device names.' }; }
    if (!connection.dnsName || !connection.dnsName.replace(/\.$/, '').toLowerCase().endsWith('.' + suffix)) throw new ServiceError('dns-identity', 'Tailscale’s device name does not match its MagicDNS suffix. Deployment DNS was preserved.');
    await dns.activate(suffix);
    const stamp = JSON.stringify([runId, connection.dnsName, connection.ips, suffix]);
    if (dnsChecked?.stamp !== stamp || now() - dnsChecked.at > 15000) {
      try { await probeDNS(connection); dnsChecked = { stamp, at: now() }; }
      catch { await dns.restore(); dnsChecked = null; return { mode: 'kernel', state: 'error', dns: 'error', message: 'MagicDNS did not resolve this device to its Tailscale address. Deployment DNS was restored. Check tailnet DNS settings and retry.' }; }
    }
    return { mode: 'kernel', state: 'ready', dns: 'ready', suffix, inbound: 'published-routes', interface: INTERFACE, message: 'All programs can reach tailnet peers. MagicDNS is verified; incoming access uses published Services routes.' };
  };
  return { requirements, validate, prepare, stopped, observe, needsStopConfirmation: () => Boolean(store.meta(KEY) || dns.owned()), disconnected: () => dns.restore(), orphaned: async () => { if (!store.get('tailscale') && (store.meta(KEY) || dns.owned())) await stopped(); }, close: async () => { await dns.restore(); await dns.close(); } };
}
