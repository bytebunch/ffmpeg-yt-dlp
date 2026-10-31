import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { abortOnDisconnect } from '../../../src/common/abort';
import { AppError } from '../../../src/common/errors';
import { DOWNLOAD_PRESETS, formatSelectionArgs } from '../../../src/discovery/presets';
import {
  commentsRequestSchema,
  infoRequestSchema,
  searchQuerySchema,
  transcriptRequestSchema,
} from '../../../src/discovery/schemas';
import { searchTarget, siteAllowed } from '../../../src/discovery/search';

describe('searchTarget', () => {
  it('builds search pseudo-URLs with the search extractor', () => {
    expect(searchTarget('youtube', 'relevance', 'me at the zoo', 5)).toEqual({
      url: 'ytsearch5:me at the zoo',
      extractor: 'youtube:search',
      args: [],
    });
    expect(searchTarget('soundcloud', 'relevance', 'lofi', 3).url).toBe('scsearch3:lofi');
    expect(searchTarget('niconico', 'date', 'x', 2)).toMatchObject({
      url: 'nicosearchdate2:x',
      extractor: 'nicovideo:search:date',
    });
  });

  it('sorts YouTube by upload date through a results URL', () => {
    expect(searchTarget('youtube', 'date', 'cats & dogs', 7)).toEqual({
      url: 'https://www.youtube.com/results?search_query=cats%20%26%20dogs&sp=CAI%3D',
      extractor: 'youtube:search_url',
      args: ['-I', '1:7'],
    });
  });

  it('refuses date order where the site has none', () => {
    expect(() => searchTarget('bilibili', 'date', 'x', 1)).toThrow(AppError);
  });

  it('keeps a query that looks like a flag as part of the pseudo-URL', () => {
    expect(searchTarget('youtube', 'relevance', '--exec rm', 1).url).toBe('ytsearch1:--exec rm');
  });
});

describe('siteAllowed', () => {
  it('allows everything without an allowlist and matches extractor names case-insensitively', () => {
    expect(siteAllowed('youtube', [])).toBe(true);
    expect(siteAllowed('youtube', ['YouTube'])).toBe(true);
    expect(siteAllowed('bilibili', ['bilibili'])).toBe(true);
    expect(siteAllowed('youtube', ['vimeo'])).toBe(false);
  });
});

describe('formatSelectionArgs (SPEC §7a)', () => {
  it('maps every preset', () => {
    expect(formatSelectionArgs('best')).toEqual(['-f', 'bv*+ba/b']);
    expect(formatSelectionArgs('1080p')).toEqual(['-f', 'bv*+ba/b', '-S', 'res:1080']);
    expect(formatSelectionArgs('audio_mp3')).toEqual(['-f', 'ba/b']);
    expect(formatSelectionArgs('video_only')).toEqual(['-f', 'bv']);
    expect(formatSelectionArgs('metadata_only')).toEqual([]);
    expect(DOWNLOAD_PRESETS.every((preset) => Array.isArray(formatSelectionArgs(preset)))).toBe(
      true,
    );
  });
});

describe('request schemas', () => {
  it('apply defaults', () => {
    expect(infoRequestSchema.parse({ url: 'https://youtu.be/x' })).toEqual({
      url: 'https://youtu.be/x',
      include: [],
      mode: 'auto',
      limit: 50,
    });
    expect(transcriptRequestSchema.parse({ url: 'https://youtu.be/x' })).toMatchObject({
      lang: ['en'],
      auto: true,
      format: 'json',
    });
    expect(commentsRequestSchema.parse({ url: 'https://youtu.be/x' })).toMatchObject({
      max: 50,
      sort: 'top',
    });
    expect(searchQuerySchema.parse({ q: ' cats ', limit: '3' })).toEqual({
      q: 'cats',
      limit: 3,
      site: 'youtube',
      sort: 'relevance',
    });
  });

  it('reject unknown fields, non-http URLs, regex language tags and control characters', () => {
    expect(infoRequestSchema.safeParse({ url: 'https://x.com/v', extra: 1 }).success).toBe(false);
    expect(infoRequestSchema.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(
      transcriptRequestSchema.safeParse({ url: 'https://x.com/v', lang: ['en.*'] }).success,
    ).toBe(false);
    expect(
      transcriptRequestSchema.safeParse({ url: 'https://x.com/v', lang: ['pt-BR'] }).success,
    ).toBe(true);
    expect(searchQuerySchema.safeParse({ q: 'a\nb' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });
});

describe('abortOnDisconnect', () => {
  const reply = (writableFinished: boolean) => {
    const raw = Object.assign(new EventEmitter(), { writableFinished });
    return { raw } as never;
  };

  it('aborts when the connection closes before the response was written', () => {
    const r = reply(false);
    const signal = abortOnDisconnect(r);
    (r as { raw: EventEmitter }).raw.emit('close');
    expect(signal.aborted).toBe(true);
  });

  it('does not abort after a completed response', () => {
    const r = reply(true);
    const signal = abortOnDisconnect(r);
    (r as { raw: EventEmitter }).raw.emit('close');
    expect(signal.aborted).toBe(false);
  });
});
