import { describe, expect, it } from 'vitest';

import { AppError } from '../common/errors';
import {
  API_KEY_PATTERN,
  CLIENT_NAME_PATTERN,
  generateApiKey,
  hashApiKey,
  keyPrefix,
} from './api-keys';
import { rateWindow } from './guards';
import { bearerToken, requireUserId, resolveUserId } from './request-auth';

describe('API keys', () => {
  it('generates mk_ keys with 32 base64url characters and no repeats', () => {
    const keys = Array.from({ length: 200 }, generateApiKey);
    expect(keys.every((key) => API_KEY_PATTERN.test(key))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('hashes keys with SHA-256 and exposes an 11-character prefix', () => {
    const key = 'mk_abcdefghABCDEFGH0123456789_-xyzQ';
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(keyPrefix(key)).toBe('mk_abcdefgh');
  });

  it('accepts only path-safe client names', () => {
    for (const name of ['app', 'my-app_2', '0x']) expect(CLIENT_NAME_PATTERN.test(name)).toBe(true);
    for (const name of ['', 'App', '-x', '../etc', 'a b', 'a'.repeat(65)]) {
      expect(CLIENT_NAME_PATTERN.test(name)).toBe(false);
    }
  });
});

describe('bearerToken', () => {
  it('extracts the token from a Bearer header in any case', () => {
    expect(bearerToken('Bearer mk_abc')).toBe('mk_abc');
    expect(bearerToken('bearer   mk_abc ')).toBe('mk_abc');
  });

  it('returns undefined for missing or other schemes', () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Basic dXNlcjpwdw==')).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
    expect(bearerToken('Bearer a b')).toBeUndefined();
  });
});

describe('resolveUserId', () => {
  it('prefers the X-User-Id header over the key default', () => {
    expect(resolveUserId('user-7', 'default-user')).toBe('user-7');
    expect(resolveUserId(undefined, 'default-user')).toBe('default-user');
    expect(resolveUserId(undefined, null)).toBeUndefined();
    expect(resolveUserId(['first', 'second'], null)).toBe('first');
  });

  it('rejects malformed user ids', () => {
    for (const value of ['', 'a b', 'x'.repeat(129), 'semi;colon']) {
      expect(() => resolveUserId(value, null)).toThrow(AppError);
    }
  });

  it('requires a user id where one is needed', () => {
    const auth = {
      keyId: 'k',
      clientId: 'c',
      clientName: 'app',
      userId: undefined,
      shareOutputsWithinClient: false,
    };
    expect(() => requireUserId(auth)).toThrow(/X-User-Id/);
    expect(requireUserId({ ...auth, userId: 'u1' })).toBe('u1');
  });
});

describe('rateWindow', () => {
  it('uses one-minute windows and reports the seconds until the next one', () => {
    const start = Date.UTC(2026, 9, 31, 12, 0, 0);
    expect(rateWindow(start)).toEqual({ window: start / 60_000, resetSeconds: 60 });
    expect(rateWindow(start + 59_500)).toEqual({ window: start / 60_000, resetSeconds: 1 });
    expect(rateWindow(start + 60_000).window).toBe(start / 60_000 + 1);
  });
});
