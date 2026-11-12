// A loopback-only split resolver. Public and Docker names keep their original
// resolvers; only the tailnet's own suffix and reverse zone go to Quad100.
import dgram from 'node:dgram';
import net from 'node:net';

const MAX_PACKET = 65535;
export function question(packet) {
  if (packet.length < 17 || packet.length > MAX_PACKET || packet.readUInt16BE(4) !== 1) throw new Error('dns-question');
  const labels = [], visited = new Set();
  let offset = 12, end = null, length = 0;
  for (let steps = 0; steps < 128; steps++) {
    if (offset >= packet.length || visited.has(offset)) throw new Error('dns-name');
    visited.add(offset);
    const size = packet[offset++];
    if ((size & 0xc0) === 0xc0) {
      if (offset >= packet.length) throw new Error('dns-name');
      end ??= offset + 1;
      offset = ((size & 0x3f) << 8) | packet[offset];
      continue;
    }
    if (size & 0xc0 || size > 63 || offset + size > packet.length) throw new Error('dns-name');
    if (!size) {
      end ??= offset;
      if (end + 4 > packet.length) throw new Error('dns-question');
      return { name: labels.join('.').toLowerCase(), type: packet.readUInt16BE(end), class: packet.readUInt16BE(end + 2), end: end + 4 };
    }
    length += size + 1;
    if (length > 254) throw new Error('dns-name');
    labels.push(packet.subarray(offset, offset + size).toString('latin1'));
    offset += size;
  }
  throw new Error('dns-name');
}
export function tailnetQuestion(name, suffix) {
  if (suffix && (name === suffix || name.endsWith('.' + suffix))) return true;
  const reverse4 = /^(?:\d+\.){2}(\d+)\.100\.in-addr\.arpa$/.exec(name);
  return Boolean(reverse4 && Number(reverse4[1]) >= 64 && Number(reverse4[1]) <= 127) || name.endsWith('.0.e.1.a.c.5.1.1.a.7.d.f.ip6.arpa');
}
function failure(packet, code = 2) {
  // Never echo arbitrary additional sections or accept a recursive response
  // as a new query. Keep only the validated question and its request ID.
  let parsed;
  try { parsed = question(packet); } catch { return null; }
  const reply = Buffer.from(packet.subarray(0, parsed.end));
  reply.writeUInt16BE(0x8080 | (packet.readUInt16BE(2) & 0x0100) | code, 2);
  reply.fill(0, 6, 12);
  return reply;
}
export function exchangeDNS(packet, { address, port = 53, tcp = false, timeout = 1200, sockets = new Set() }) {
  return new Promise((resolve, reject) => {
    const query = question(packet), id = packet.readUInt16BE(0);
    const socket = tcp ? new net.Socket() : dgram.createSocket(net.isIP(address) === 6 ? 'udp6' : 'udp4');
    sockets.add(socket);
    let done = false, received = Buffer.alloc(0);
    const finish = (error, response) => {
      if (done) return; done = true; clearTimeout(timer); sockets.delete(socket);
      if (tcp) socket.destroy(); else { try { socket.close(); } catch {} }
      error ? reject(error) : resolve(response);
    };
    const timer = setTimeout(() => finish(new Error('dns-timeout')), timeout);
    const accept = response => {
      try {
        const result = question(response);
        if (!(response.readUInt16BE(2) & 0x8000) || response.readUInt16BE(0) !== id || result.name !== query.name || result.type !== query.type || result.class !== query.class) return;
        finish(null, response);
      } catch { /* Ignore malformed or unrelated replies until the deadline. */ }
    };
    socket.on('error', () => finish(new Error('dns-upstream')));
    socket.on('close', () => finish(new Error('dns-closed')));
    if (tcp) {
      socket.on('data', chunk => {
        received = Buffer.concat([received, chunk]);
        if (received.length > MAX_PACKET + 2) return finish(new Error('dns-size'));
        if (received.length >= 2) {
          const size = received.readUInt16BE(0);
          if (size < 17 || size > MAX_PACKET) return finish(new Error('dns-size'));
          if (received.length === size + 2) accept(received.subarray(2));
        }
      });
      socket.on('end', () => finish(new Error('dns-truncated')));
      socket.connect(port, address, () => { const header = Buffer.alloc(2); header.writeUInt16BE(packet.length); socket.write(Buffer.concat([header, packet])); });
    } else {
      // Connected UDP sockets reject datagrams from other upstreams.
      socket.on('message', accept);
      socket.connect(port, address, () => socket.send(packet));
    }
  });
}
export function createDNSRelay({ address = '127.0.0.54', port = 53, upstreams, suffix = null, tailnet = { address: '100.100.100.100', port: 53 }, timeout = 1200 } = {}) {
  let configuration = { upstreams, suffix }, udp = null, tcp = null, pending = 0, closed = false;
  const sockets = new Set(), clients = new Set();
  const query = async (packet, useTCP = false) => {
    let parsed;
    try {
      parsed = question(packet);
      if (packet.readUInt16BE(2) & 0xf800 || pending >= 128) return failure(packet, 5);
    } catch { return null; }
    pending++;
    try {
      const routes = tailnetQuestion(parsed.name, configuration.suffix) ? configuration.suffix ? [tailnet] : [] : configuration.upstreams;
      for (const upstream of routes || []) {
        if (closed) break;
        try { return await exchangeDNS(packet, { ...upstream, tcp: useTCP, timeout, sockets }); } catch { /* Try the next original resolver. */ }
      }
      return failure(packet);
    } finally { pending--; }
  };
  const listen = async () => {
    if (udp || tcp || closed) throw new Error('dns-lifecycle');
    udp = dgram.createSocket('udp4');
    tcp = net.createServer(client => {
      clients.add(client); client.setTimeout(5000, () => client.destroy());
      let buffer = Buffer.alloc(0), queued = 0;
      client.on('error', () => client.destroy()); client.on('close', () => clients.delete(client));
      client.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > (MAX_PACKET + 2) * 8) return client.destroy();
        while (buffer.length >= 2) {
          const size = buffer.readUInt16BE(0);
          if (size < 17 || size > MAX_PACKET || queued >= 8) return client.destroy();
          if (buffer.length < size + 2) break;
          const packet = buffer.subarray(2, size + 2); buffer = buffer.subarray(size + 2); queued++;
          void query(packet, true).then(reply => { queued--; if (reply && !client.destroyed) { const header = Buffer.alloc(2); header.writeUInt16BE(reply.length); client.write(Buffer.concat([header, reply])); } else client.destroy(); });
        }
      });
    });
    tcp.maxConnections = 32;
    udp.on('error', () => {}); tcp.on('error', () => {});
    udp.on('message', (packet, peer) => { void query(packet).then(reply => { if (reply && !closed) udp.send(reply, peer.port, peer.address, () => {}); }); });
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(port, address, resolve); });
    // A zero port is used only by disposable test fixtures.
    const bound = udp.address().port;
    await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(bound, address, resolve); });
    return { address, port: bound };
  };
  const close = async () => {
    closed = true;
    for (const client of clients) client.destroy();
    for (const socket of sockets) { if (socket instanceof net.Socket) socket.destroy(); else { try { socket.close(); } catch {} } }
    await Promise.all([udp ? new Promise(resolve => { try { udp.close(resolve); } catch { resolve(); } }) : null, tcp ? new Promise(resolve => tcp.close(resolve)) : null]);
  };
  return { listen, close, configure: value => { configuration = value; }, query };
}
