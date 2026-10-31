import { describe, expect, it } from 'vitest';

import { isUuid, uuidv7, uuidv7Generator } from './ids';

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 ids with the RFC variant', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const now = Date.UTC(2030, 9, 31, 12, 0, 0);
    const id = uuidv7Generator()(now);
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(now);
  });

  it('sorts ids from different milliseconds by creation time', () => {
    const next = uuidv7Generator();
    const ids = [1, 2, 3].map((offset) => next(1_700_000_000_000 + offset));
    const later = uuidv7Generator()(1_700_000_000_010);
    expect([later, ...ids].sort()).toEqual([...ids, later]);
  });

  it('increases strictly within the same millisecond', () => {
    const next = uuidv7Generator();
    const ids = Array.from({ length: 5000 }, () => next(1_800_000_000_000));
    expect([...ids].sort()).toEqual(ids);
  });

  it('does not repeat within the same millisecond', () => {
    const next = uuidv7Generator();
    const ids = new Set(Array.from({ length: 1000 }, () => next(1_700_000_000_000)));
    expect(ids.size).toBe(1000);
  });
});

describe('isUuid', () => {
  it('rejects malformed and upper-case ids', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('0192F0C4-1D2E-7ABC-8DEF-0123456789AB')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
