// Inspect the tar stream before root extracts any member. Official packages
// use short POSIX names. Unsupported extensions fail closed instead of being
// interpreted differently by this check and by the system extractor.
import path from 'node:path';
import { ServiceError } from './store.mjs';
const fail = () => { throw new ServiceError('archive-unsafe', 'The verified archive has an unsupported or unsafe layout. Nothing was activated.'); };
const string = bytes => bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('utf8');
export function inspectTar(bytes) {
  const members = [], seen = new Set(), links = new Set();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const octal = (from, to) => { const value = string(header.subarray(from, to)).trim(); if (!/^[0-7]+$/.test(value)) fail(); return parseInt(value, 8); };
    const checksum = octal(148, 156);
    if (header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0) !== checksum) fail();
    const size = octal(124, 136), kind = String.fromCharCode(header[156] || 48);
    const prefix = string(header.subarray(345, 500)), name = string(header.subarray(0, 100));
    const raw = (prefix ? prefix + '/' : '') + name;
    const filename = path.posix.normalize(raw).replace(/^\.\//, '').replace(/\/$/, '');
    if (!raw || raw.startsWith('/') || /[\x00-\x1f\x7f]/.test(raw) || raw.split('/').includes('..') || !['0', '2', '5'].includes(kind) || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) fail();
    if (filename !== '.') {
      if (seen.has(filename) || filename === 'receipt.json' || filename === 'manifest.json') fail();
      seen.add(filename);
      if (kind === '2') {
        const link = string(header.subarray(157, 257));
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), link));
        if (!link || link.startsWith('/') || target === '..' || target.startsWith('../') || /[\x00-\x1f\x7f]/.test(link)) fail();
        links.add(filename);
      }
      members.push({ path: filename, kind, size });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const member of members) {
    let ancestor = path.posix.dirname(member.path);
    while (ancestor !== '.') { if (links.has(ancestor)) fail(); ancestor = path.posix.dirname(ancestor); }
  }
  if (!members.length) fail();
  return members;
}
