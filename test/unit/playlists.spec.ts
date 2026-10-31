import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/common/errors';
import { checkFilters, inDateRange, resolveDate } from '../../src/playlists/filters';
import { archiveKey, planItems } from '../../src/playlists/plan';
import { channelTabUrl, parseSelection } from '../../src/playlists/selection';

describe('parseSelection', () => {
  it('turns ranges and indices into yt-dlp -I syntax and bounds the expansion', () => {
    expect(parseSelection('1-20,25')).toEqual({ ytdlp: '1:20,25', playlistEnd: 25 });
    expect(parseSelection(' 3 , 7-9 ')).toEqual({ ytdlp: '3,7:9', playlistEnd: 9 });
  });

  it('needs the whole playlist for negative indices', () => {
    expect(parseSelection('1-5,-3')).toEqual({ ytdlp: '1:5,-3', playlistEnd: undefined });
  });

  it.each([
    '',
    '0',
    '5-2',
    'a',
    '1,,2',
    '1-',
    '1:5',
    '-1-3',
    '--5',
    Array.from({ length: 51 }, (_, i) => i + 1).join(','),
  ])('rejects %j', (value) => {
    expect(() => parseSelection(value)).toThrow(AppError);
  });
});

describe('channelTabUrl', () => {
  it('points YouTube channel URLs at the tab', () => {
    expect(channelTabUrl('https://www.youtube.com/@LinusTechTips', 'shorts')).toBe(
      'https://www.youtube.com/@LinusTechTips/shorts',
    );
    expect(channelTabUrl('https://youtube.com/channel/UC123/videos/', 'streams')).toBe(
      'https://www.youtube.com/channel/UC123/streams',
    );
  });

  it('leaves other URLs alone', () => {
    const playlist = 'https://www.youtube.com/playlist?list=PL1';
    expect(channelTabUrl(playlist, 'videos')).toBe(playlist);
    expect(channelTabUrl('https://vimeo.com/channels/staffpicks', 'videos')).toBe(
      'https://vimeo.com/channels/staffpicks',
    );
  });
});

describe('checkFilters', () => {
  const entry = {
    title: 'Cooking Pasta LIVE',
    duration: 600,
    view_count: 1000,
    channel: 'Chef',
    live_status: 'was_live',
    url: 'https://www.youtube.com/watch?v=x',
  };

  it('passes and rejects on ranges', () => {
    expect(checkFilters(entry, { min_duration: 300, max_duration: 900 })).toBe('pass');
    expect(checkFilters(entry, { max_duration: 300 })).toBe('reject');
    expect(checkFilters(entry, { min_views: 5000 })).toBe('reject');
  });

  it('matches titles literally and case-insensitively', () => {
    expect(checkFilters(entry, { title_contains: ['pasta'] })).toBe('pass');
    expect(checkFilters(entry, { title_contains: ['.*'] })).toBe('reject');
    expect(checkFilters(entry, { title_excludes: ['live'] })).toBe('reject');
  });

  it('handles uploader, live, upcoming and shorts', () => {
    expect(checkFilters(entry, { uploader: 'chef' })).toBe('pass');
    expect(checkFilters(entry, { exclude_live: true })).toBe('reject');
    expect(checkFilters({ ...entry, live_status: 'is_upcoming' }, { exclude_upcoming: true })).toBe(
      'reject',
    );
    expect(
      checkFilters(
        { ...entry, url: 'https://www.youtube.com/shorts/abc' },
        { exclude_shorts: true },
      ),
    ).toBe('reject');
  });

  it('reports unknown when a needed field is missing, unless something else already rejects', () => {
    expect(checkFilters({ title: 'x' }, { min_likes: 10 })).toBe('unknown');
    expect(checkFilters({ title: 'x' }, { language: 'en' })).toBe('unknown');
    expect(checkFilters({ title: 'x', duration: 5 }, { min_likes: 10, min_duration: 60 })).toBe(
      'reject',
    );
  });
});

describe('dates', () => {
  const now = new Date(Date.UTC(2026, 9, 31));

  it('resolves relative dates', () => {
    expect(resolveDate('20250101', now)).toBe('20250101');
    expect(resolveDate('now-7days', now)).toBe('20261024');
    expect(resolveDate('now-2weeks', now)).toBe('20261017');
    expect(resolveDate('now-1month', now)).toBe('20260930');
    expect(resolveDate('now-1year', now)).toBe('20251031');
    expect(resolveDate('now-1year', new Date(Date.UTC(2028, 1, 29)))).toBe('20270228');
    expect(resolveDate('yesterday', now)).toBe('20261030');
  });

  it('checks ranges and lets unknown dates pass', () => {
    expect(inDateRange('20261020', 'now-30days', undefined, now)).toBe(true);
    expect(inDateRange('20260101', 'now-30days', undefined, now)).toBe(false);
    expect(inDateRange('20261030', undefined, '20261001', now)).toBe(false);
    expect(inDateRange(undefined, 'now-1day', undefined, now)).toBe(true);
  });
});

describe('planItems', () => {
  const limits = { maxItems: 5, maxTotalHours: 1, unknownDurationMinutes: 10 };
  const entries = Array.from({ length: 4 }, (_, i) => ({
    id: `v${i + 1}`,
    url: `https://www.youtube.com/watch?v=v${i + 1}`,
    title: `Video ${i + 1}`,
    duration: 60 * (i + 1),
    ie_key: 'Youtube',
  }));

  it('numbers items and keeps their order', () => {
    const plan = planItems({ entries, limits, selected: false });
    expect(plan.items.map((item) => [item.index, item.id])).toEqual([
      [1, 'v1'],
      [2, 'v2'],
      [3, 'v3'],
      [4, 'v4'],
    ]);
  });

  it('applies filters, the archive and max_items, then the order', () => {
    const plan = planItems({
      entries,
      limits,
      selected: false,
      filters: { min_duration: 120 },
      archived: new Set([archiveKey('Youtube', 'v3')]),
      maxItems: 1,
      reverse: true,
    });
    expect(plan.items.map((item) => item.id)).toEqual(['v2']);
    expect(plan).toMatchObject({ filtered: 1, archived: 1 });
    expect(
      planItems({
        entries,
        limits,
        selected: false,
        random: true,
        shuffle: (items) => [...items].reverse(),
      }).items[0]?.id,
    ).toBe('v4');
  });

  it('skips nested playlists and entries without a URL', () => {
    const plan = planItems({
      entries: [...entries, { _type: 'playlist', id: 'PL', url: 'x' }, { id: 'nourl' }],
      limits,
      selected: true,
    });
    expect(plan.unsupported).toBe(2);
  });

  it('refuses playlists over PLAYLIST_MAX_ITEMS unless a range or max_items narrows them', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...entries[0], id: `m${i}`, duration: 1 }));
    expect(() => planItems({ entries: many, limits, selected: false })).toThrow(
      /more than 5 items/,
    );
    expect(planItems({ entries: many, limits, selected: false, maxItems: 5 }).items).toHaveLength(
      5,
    );
    expect(planItems({ entries: many, limits, selected: true }).items).toHaveLength(6);
  });

  it('caps the total duration, counting unknown durations as PLAYLIST_UNKNOWN_DURATION_MINUTES', () => {
    const unknown = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, url: `https://x/${i}` }));
    expect(() =>
      planItems({ entries: unknown, limits: { ...limits, maxItems: 10 }, selected: false }),
    ).toThrow(AppError);
    expect(
      planItems({
        entries: unknown.slice(0, 6),
        limits: { ...limits, maxItems: 10 },
        selected: false,
      }).items,
    ).toHaveLength(6);
  });
});
