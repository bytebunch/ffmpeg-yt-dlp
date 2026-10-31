import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/** TOKEN_ENCRYPTION_KEYS, newest first (config parses and sorts them). */
export type EncryptionKeys = readonly { version: number; key: Buffer }[];

/**
 * Secrets at rest (SPEC §12: cookies, credentials, OAuth tokens): AES-256-GCM with the newest key,
 * the key version in the token so older keys keep decrypting during a rotation, and `context`
 * (client, user, purpose) as associated data so a ciphertext cannot be moved to another user.
 */
export function encryptSecret(keys: EncryptionKeys, context: string, plaintext: string): string {
  const [current] = keys;
  if (!current) throw new Error('No encryption key configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v' + String(current.version),
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url'),
  ].join('.');
}

export function decryptSecret(keys: EncryptionKeys, context: string, token: string): string {
  const [version, iv, tag, data] = token.split('.');
  const key = keys.find((entry) => `v${entry.version}` === version);
  if (!key || !iv || !tag || data === undefined)
    throw new Error('Secret encrypted with an unknown key version');
  const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** RFC 4648 base32 (TOTP seeds), case and padding insensitive. */
export function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Not a base32 string');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), the form sites use for 2FA codes. */
export function totp(seed: string, now = Date.now(), step = 30, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / step)));
  const hmac = createHmac('sha1', base32Decode(seed)).update(counter).digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
