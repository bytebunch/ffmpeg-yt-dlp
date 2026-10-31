import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import {
  decodeCursor,
  encodeCursor,
  INFO_INCLUDES,
  isPlaylist,
  mapComments,
  mapPlaylist,
  mapSearchResult,
  mapVideo,
  uploadDate,
} from '../../../src/discovery/mappers';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(path.resolve(__dirname, `../../fixtures/ytdlp/${name}.json`), 'utf8'),
  ) as Record<string, unknown>;

describe('mapVideo (real yt-dlp capture of jNQXAC9IVRw)', () => {
  const raw = fixture('video');

  it('returns the base fields, with null for missing ones, and nothing heavy by default', () => {
    const video = mapVideo(raw, new Set());
    expect(video).toMatchObject({
      type: 'video',
      id: 'jNQXAC9IVRw',
      extractor: 'youtube',
      title: 'Me at the zoo',
      duration: 19,
      live_status: 'not_live',
      webpage_url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    });
    expect(video).toHaveProperty('release_timestamp');
    for (const heavy of ['formats', 'subtitles', 'thumbnails', 'chapters', 'description', 'tags']) {
      expect(video).not.toHaveProperty(heavy);
    }
  });

  it('adds every requested part', () => {
    const video = mapVideo(raw, new Set(INFO_INCLUDES));
    expect(video.chapters).toEqual([
      { start_time: 0, end_time: 5, title: 'Intro' },
      { start_time: 5, end_time: 17, title: 'The cool thing' },
      { start_time: 17, end_time: 19, title: 'End' },
    ]);
    expect(video.formats).toHaveLength(6);
    expect(video.requested_formats).toHaveLength(2);
    expect(Object.keys(video.subtitles as object)).toEqual(['en']);
    expect(Object.keys(video.automatic_captions as object)).toEqual(['en', 'es']);
    expect(typeof video.description).toBe('string');
    expect(Array.isArray(video.tags)).toBe(true);
    expect((video.thumbnails as { url: string }[])[0]?.url).toMatch(/^https:\/\/i\.ytimg\.com\//);
  });

  it('never returns stream or subtitle URLs', () => {
    const json = JSON.stringify(mapVideo(raw, new Set(INFO_INCLUDES)));
    expect(json).not.toContain('media.invalid');
    const format = (mapVideo(raw, new Set(['formats'])).formats as Record<string, unknown>[])[0];
    expect(Object.keys(format ?? {})).not.toContain('url');
  });

  it('is a video, not a playlist', () => {
    expect(isPlaylist(raw)).toBe(false);
  });
});

describe('mapPlaylist', () => {
  const raw = fixture('playlist');

  it('numbers entries from the page offset and derives upload dates from timestamps', () => {
    const page = mapPlaylist(raw, { offset: 10, limit: 2 }, new Set());
    const entries = page.entries as Record<string, unknown>[];
    expect(entries.map((entry) => entry.index)).toEqual([11, 12]);
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(
      ['duration', 'id', 'index', 'live_status', 'title', 'upload_date', 'url'].sort(),
    );
    expect(entries[0]?.upload_date).toBeNull(); // YouTube flat playlist entries carry no date
    expect(page).toMatchObject({ type: 'playlist', playlist_count: 182 });
  });

  it('offers a next cursor only when an extra entry came back', () => {
    expect(mapPlaylist(raw, { offset: 0, limit: 3 }, new Set()).next_cursor).toBe(encodeCursor(3));
    expect(mapPlaylist(raw, { offset: 0, limit: 4 }, new Set()).next_cursor).toBeNull();
  });

  it('drops internal fields', () => {
    expect(JSON.stringify(mapPlaylist(raw, { offset: 0, limit: 4 }, new Set()))).not.toContain(
      '__',
    );
  });

  it('is recognised as a playlist', () => {
    expect(isPlaylist(raw)).toBe(true);
  });
});

describe('mapSearchResult and mapComments', () => {
  it('maps search entries with a thumbnail', () => {
    const [first] = (fixture('search').entries as Record<string, unknown>[]).map(mapSearchResult);
    expect(first).toMatchObject({ id: 'jNQXAC9IVRw', title: 'Me at the zoo' });
    expect(first?.thumbnail).toMatch(/^https:/);
  });

  it('maps comments, turns root parents into null and honours the maximum', () => {
    const result = mapComments(fixture('comments'), 2);
    const comments = result.comments as Record<string, unknown>[];
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ parent: null });
    expect(Object.keys(comments[0] ?? {})).not.toContain('author_thumbnail');
  });
});

describe('uploadDate', () => {
  it('prefers upload_date and falls back to the UTC date of timestamp', () => {
    expect(uploadDate({ upload_date: '20050424' })).toBe('20050424');
    expect(uploadDate({ timestamp: 1114370000 })).toBe('20050424');
    expect(uploadDate({})).toBeNull();
  });
});

describe('cursors', () => {
  it('round-trip offsets', () => {
    expect(decodeCursor(encodeCursor(150))).toBe(150);
    expect(decodeCursor(undefined)).toBe(0);
  });

  it.each([
    'garbage!',
    encodeCursor(-1),
    Buffer.from('{"o":1.5}').toString('base64url'),
    Buffer.from('[]').toString('base64url'),
  ])('rejects %s', (cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(AppError);
  });
});
