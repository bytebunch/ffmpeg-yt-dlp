import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { base32Decode, decryptSecret, encryptSecret, totp } from './secrets';

const v1 = { version: 1, key: randomBytes(32) };
const v2 = { version: 2, key: randomBytes(32) };

describe('secrets at rest', () => {
  it('round-trips with the newest key and still reads tokens from older keys', () => {
    const old = encryptSecret([v1], 'client:alice:cookies', 'session=abc');
    expect(old.startsWith('v1.')).toBe(true);
    const rotated = [v2, v1];
    expect(decryptSecret(rotated, 'client:alice:cookies', old)).toBe('session=abc');
    expect(encryptSecret(rotated, 'client:alice:cookies', 'x').startsWith('v2.')).toBe(true);
  });

  it('refuses another context, a tampered token and a retired key', () => {
    const token = encryptSecret([v1], 'client:alice:cookies', 'secret');
    expect(() => decryptSecret([v1], 'client:bob:cookies', token)).toThrow();
    const [version, iv, tag, data = ''] = token.split('.');
    const bytes = Buffer.from(data, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const flipped = [version, iv, tag, bytes.toString('base64url')].join('.');
    expect(() => decryptSecret([v1], 'client:alice:cookies', flipped)).toThrow();
    expect(() => decryptSecret([v2], 'client:alice:cookies', token)).toThrow(/unknown key version/);
  });

  it('computes RFC 6238 TOTP codes (test vectors for SHA-1)', () => {
    // RFC 6238 appendix B: secret "12345678901234567890", 8 digits.
    const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totp(seed, 59_000, 30, 8)).toBe('94287082');
    expect(totp(seed, 1_111_111_109_000, 30, 8)).toBe('07081804');
    expect(totp(seed, 2_000_000_000_000, 30, 8)).toBe('69279037');
    expect(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000)).toBe('287082');
    expect(base32Decode('MZXW6===').toString()).toBe('foo');
    expect(() => base32Decode('0189')).toThrow();
  });
});
