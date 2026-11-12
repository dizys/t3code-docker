// Resolve and check once, then use those exact addresses for every request in
// this probe. A second lookup inside fetch would undo the private-host check.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { isBlockedIp } from './address.mjs';

export const lookupGateway = hostname => dnsLookup(hostname, { all: true });
const dnsError = () => Object.assign(new Error('The gateway address could not be resolved.'), { code: 'ENOTFOUND' });

async function resolved(hostname, lookup, signal) {
  signal?.throwIfAborted();
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
  let abort;
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() => lookup(hostname)),
      new Promise((_, reject) => {
        if (!signal) return;
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
    const rows = (Array.isArray(answer) ? answer : [answer]).map(row => typeof row === 'string' ? { address: row } : row);
    if (!rows.length || rows.some(row => !row || !isIP(row.address))) throw dnsError();
    return [...new Map(rows.map(row => [row.address, { address: row.address, family: isIP(row.address) }])).values()];
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

export async function gatewayFetch(address, { allowPrivateHost = false, lookup = lookupGateway, signal, fetchImpl = globalThis.fetch } = {}) {
  const addresses = await resolved(address.hostname, lookup, signal);
  const blocked = addresses.find(row => isBlockedIp(row.address));
  if (blocked && allowPrivateHost !== true) throw Object.assign(new Error('The gateway resolves to a private address.'), { code: 'private-host', address: blocked.address });
  // Injected transports are for controlled adapters/tests. Production always
  // uses the pinned socket lookup below, including HTTPS hostname validation.
  if (fetchImpl !== globalThis.fetch) return fetchImpl;
  const origin = new URL(address.url).origin;
  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(input);
    if (url.origin !== origin) return reject(new Error('A gateway probe cannot change origin.'));
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: init.method ?? 'GET', headers: { 'accept-encoding': 'identity', ...init.headers }, signal: init.signal,
      agent: false,
      lookup: (_hostname, options, callback) => {
        const family = typeof options === 'number' ? options : options?.family;
        const rows = family ? addresses.filter(row => row.family === Number(family)) : addresses;
        if (!rows.length) return callback(dnsError());
        if (options?.all) callback(null, rows);
        else callback(null, rows[0].address, rows[0].family);
      },
    }, response => {
      try {
        const status = response.statusCode;
        if (status < 200 || status > 599) throw new Error('Invalid gateway HTTP status.');
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        const noBody = init.method === 'HEAD' || [204, 205, 304].includes(status);
        if (noBody) response.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(response), { status, headers }));
      } catch (error) { response.destroy(); reject(error); }
    });
    request.once('error', reject);
    request.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('Gateway protocol upgrades are unsupported.')); });
    request.end(init.body);
  });
}
