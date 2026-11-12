import { promises as fs, constants } from 'node:fs';
import net from 'node:net';
import { ServiceError } from './store.mjs';
import { createDNSRelay } from './dns-relay.mjs';

const KEY = 'network:tailscale:dns', ADDRESS = '127.0.0.54';
const MARKER = '# Managed by t3code Services: Tailscale split DNS';
export function dnsSuffix(value) {
  const suffix = typeof value === 'string' ? value.replace(/\.$/, '').toLowerCase() : '';
  return suffix.length <= 253 && suffix.includes('.') && suffix.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? suffix : null;
}
export function resolverConfiguration(text, suffix, address = ADDRESS) {
  if (typeof text !== 'string' || text.length > 65536 || text.includes('\0')) throw new ServiceError('dns-configuration', 'The container DNS configuration cannot be safely managed.', 'networkMode');
  const upstreams = [], search = [], retained = [];
  for (const line of text.split('\n')) {
    const tokens = line.replace(/[#;].*$/, '').trim().split(/\s+/);
    if (tokens[0] === 'nameserver') {
      if (tokens.length !== 2 || !net.isIP(tokens[1]) || [address, '100.100.100.100', 'fd7a:115c:a1e0::53'].includes(tokens[1])) throw new ServiceError('dns-conflict', 'Another resolver already owns Tailscale DNS. Restore your deployment DNS before enabling full networking.', 'networkMode');
      if (!upstreams.some(item => item.address === tokens[1])) upstreams.push({ address: tokens[1], port: 53 });
    } else if (tokens[0] === 'search' || tokens[0] === 'domain') {
      // resolv.conf uses the last search/domain directive.
      search.splice(0, search.length, ...tokens.slice(1));
    } else if (tokens[0] === 'options') {
      // libc rotation could bypass the split resolver on every second query.
      const options = tokens.slice(1).filter(value => value !== 'rotate');
      if (options.length) retained.push('options ' + options.join(' '));
    } else retained.push(line);
  }
  if (!upstreams.length || upstreams.length > 3) throw new ServiceError('dns-configuration', 'Full networking needs between one and three existing DNS resolvers. Check this container’s deployment DNS.', 'networkMode');
  const domains = [...new Set([...search, suffix].filter(Boolean))];
  return { upstreams, applied: [MARKER, 'nameserver ' + address, ...upstreams.slice(0, 2).map(item => 'nameserver ' + item.address), ...(domains.length ? ['search ' + domains.join(' ')] : []), ...retained].join('\n') };
}
// Docker bind-mounts resolv.conf, so rename cannot replace it. Journal first,
// then write through one verified descriptor and fsync, retaining recovery for
// an interrupted write/truncate as well as a completed write.
function overlay(current, previous, next) {
  if (current === previous || current === next) return true;
  if (current.length !== previous.length) return false;
  let at = 0;
  while (at < Math.min(current.length, next.length) && current[at] === next[at]) at++;
  return current.slice(at) === previous.slice(at);
}
export function createManagedDNS({ store, boot, file = '/etc/resolv.conf', address = ADDRESS, relayFactory = createDNSRelay } = {}) {
  let relay = null;
  const read = async () => {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536 || stat.mode & 0o022) throw new ServiceError('dns-configuration', 'Full networking needs a regular, protected container resolv.conf.', 'networkMode');
      // Latin-1 is a lossless byte mapping for the private journal, including
      // comments that are not UTF-8 and partially overwritten UTF-8 sequences.
      return await handle.readFile('latin1');
    } finally { await handle.close(); }
  };
  const write = async (expected, next) => {
    const handle = await fs.open(file, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if (await handle.readFile('latin1') !== expected) throw new ServiceError('dns-conflict', 'DNS changed during this operation. The new configuration was preserved; review it before retrying.', 'networkMode');
      const content = Buffer.from(next, 'latin1');
      let offset = 0;
      while (offset < content.length) { const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset); if (!bytesWritten) throw new Error('dns-write'); offset += bytesWritten; }
      await handle.truncate(content.length); await handle.sync();
    } finally { await handle.close(); }
    if (await read() !== next) throw new ServiceError('dns-conflict', 'DNS could not be verified after writing. The saved original is retained for recovery.', 'networkMode');
  };
  const ensureRelay = async (original, suffix) => {
    const { upstreams } = resolverConfiguration(original, suffix, address);
    if (relay) { relay.configure({ upstreams, suffix }); return; }
    const candidate = relayFactory({ address, upstreams, suffix });
    try { await candidate.listen(); relay = candidate; }
    catch { await candidate.close(); throw new ServiceError('dns-listener', 'The managed DNS listener could not start on 127.0.0.54:53. Check for another local resolver; ordinary DNS was preserved.', 'networkMode'); }
  };
  const closeRelay = async () => { if (relay) { const previous = relay; relay = null; await previous.close(); } };
  const journal = async () => {
    const saved = store.meta(KEY);
    if (saved && saved.boot !== boot) {
      const current = await read();
      if (!current.includes(MARKER) && !current.split('\n').some(line => line.trim() === 'nameserver ' + address)) { store.setMeta(KEY, null); return null; }
    }
    return saved;
  };
  const restore = async () => {
    const saved = await journal();
    if (!saved) { await closeRelay(); return; }
    const current = await read();
    if (current !== saved.original) {
      const expected = current === saved.applied || saved.phase === 'installing' && overlay(current, saved.original, saved.applied) || saved.phase === 'restoring' && overlay(current, saved.applied, saved.original);
      if (!expected) {
        if (current.includes(address) || current.includes(MARKER)) {
          // Keep ordinary DNS alive while an external edit needs review.
          await ensureRelay(saved.original, null);
          throw new ServiceError('dns-conflict', 'DNS was edited outside Services and still refers to its listener. Your edit and the original backup are preserved. Restore deployment DNS, then retry cleanup.', 'networkMode');
        }
        store.setMeta(KEY, null); await closeRelay(); return;
      }
      store.setMeta(KEY, { ...saved, phase: 'restoring' });
      await write(current, saved.original);
    }
    store.setMeta(KEY, null); await closeRelay();
  };
  const activate = async suffix => {
    if (!dnsSuffix(suffix)) throw new ServiceError('dns-configuration', 'Tailscale has not provided a valid MagicDNS suffix.', 'networkMode');
    let saved = await journal();
    if (saved && (saved.suffix !== suffix || saved.phase === 'restoring')) { await restore(); saved = null; }
    if (saved) {
      await ensureRelay(saved.original, suffix);
      const current = await read();
      if (current !== saved.applied) {
        if (saved.phase === 'installing' && overlay(current, saved.original, saved.applied)) await write(current, saved.applied);
        else throw new ServiceError('dns-conflict', 'DNS was edited outside Services. Your edit and the saved original are preserved; review DNS before retrying.', 'networkMode');
      }
      if (saved.phase !== 'active') store.setMeta(KEY, { ...saved, phase: 'active' });
      return;
    }
    const original = await read(), { applied } = resolverConfiguration(original, suffix, address);
    await ensureRelay(original, suffix);
    saved = { schema: 1, boot, original, applied, suffix, phase: 'installing' };
    store.setMeta(KEY, saved);
    await write(original, applied);
    store.setMeta(KEY, { ...saved, phase: 'active' });
  };
  const preflight = async () => {
    const saved = await journal(), current = await read();
    if (saved?.phase === 'active' && current !== saved.applied && current !== saved.original) throw new ServiceError('dns-conflict', 'DNS was edited outside Services. Stop Tailscale and review deployment DNS before enabling full networking again.', 'networkMode');
    resolverConfiguration(saved?.original || current, null, address); await fs.access(file, constants.W_OK);
  };
  return { activate, restore, preflight, owned: () => Boolean(store.meta(KEY)), close: closeRelay };
}
