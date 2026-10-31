import { describe, expect, it } from 'vitest';

import { newEntries } from './select';

const entry = (id: string) => ({ id, ie_key: 'Youtube', url: `https://fake.test/item/${id}` });
const entries = ['v5', 'v4', 'v3', 'v2', 'v1'].map(entry);

describe('newEntries (SPEC §9f)', () => {
  it('stops at the first known entry with break_on_existing, newest first', () => {
    const known = new Set(['youtube:v3']);
    expect(newEntries(entries, known, true).map((e) => e.id)).toEqual(['v5', 'v4']);
  });

  it('skips known entries but keeps looking without break_on_existing', () => {
    const known = new Set(['youtube:v4', 'youtube:v2']);
    expect(newEntries(entries, known, false).map((e) => e.id)).toEqual(['v5', 'v3', 'v1']);
  });

  it('returns everything on a first run and nothing when the newest is known', () => {
    expect(newEntries(entries, new Set(), true)).toHaveLength(5);
    expect(newEntries(entries, new Set(['youtube:v5']), true)).toEqual([]);
  });

  it('passes entries without an id through for the planner to count as unsupported', () => {
    const odd = [{ _type: 'playlist', title: 'nested' }, entry('v9')];
    expect(newEntries(odd, new Set(['youtube:v9']), true)).toEqual([
      { _type: 'playlist', title: 'nested' },
    ]);
  });
});
