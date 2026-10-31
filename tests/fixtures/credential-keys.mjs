import { randomBytes, createHash } from 'node:crypto';
export function credentialKey() {
  const type = 'ssh-ed25519', name = Buffer.from(type), length = Buffer.alloc(4), keyLength = Buffer.alloc(4);
  length.writeUInt32BE(name.length); keyLength.writeUInt32BE(32);
  const wire = Buffer.concat([length, name, keyLength, randomBytes(32)]);
  return { type, key: wire.toString('base64'), fingerprint: 'SHA256:' + createHash('sha256').update(wire).digest('base64').replace(/=+$/, '') };
}
