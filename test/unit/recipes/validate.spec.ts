import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import { parseTime } from '../../../src/recipes/values';
import { parseRecipe } from '../../../src/recipes/validate';

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
};
const parse = (...steps: unknown[]) => parseRecipe({ steps }, LIMITS);

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

const mp4 = { op: 'encode', container: 'mp4' };

describe('parseTime', () => {
  it.each([
    ['90', 90],
    ['1:30', 90],
    ['01:01:30.5', 3690.5],
    [12.25, 12.25],
    ['0:00:00.001', 0.001],
  ])('%s → %s', (input, seconds) => {
    expect(parseTime(input)).toBe(seconds);
  });

  it.each(['1:60', '1:2:3:4', 'abc', '-5', '10s', ''])('rejects %s', (input) => {
    expect(parseTime(input)).toBeUndefined();
  });
});

describe('parseRecipe', () => {
  it('accepts a recipe and names outputs after their op', () => {
    const recipe = parse(
      { op: 'trim', start: '00:00:05', end: 20 },
      mp4,
      { op: 'thumbnail' },
      { op: 'loudness' },
      { ...mp4, container: 'webm' },
    );
    expect(recipe.steps[0]).toMatchObject({ op: 'trim', start: 5, end: 20, mode: 'accurate' });
    expect([...recipe.names.values()]).toEqual(['encode', 'thumbnail', 'loudness', 'encode-2']);
  });

  it('keeps explicit names and refuses duplicates', () => {
    expect([
      ...parse({ ...mp4, name: 'web' }, { op: 'thumbnail', name: 'poster' }).names.values(),
    ]).toEqual(['web', 'poster']);
    expect(errorOf(() => parse({ ...mp4, name: 'a' }, { ...mp4, name: 'a' })).message).toMatch(
      /used twice/,
    );
    expect(errorOf(() => parse({ ...mp4, name: '../x' })).code).toBe('RECIPE_INVALID');
  });

  it('leaves names to the recipe service and points crossfade at concat', () => {
    // Names are expanded at job creation; an unexpanded one is unknown here.
    expect(errorOf(() => parseRecipe('web_mp4_720', LIMITS)).message).toMatch(
      /no recipe "web_mp4_720"/,
    );
    const crossfade = errorOf(() => parse({ op: 'crossfade' }, mp4));
    expect(crossfade.code).toBe('RECIPE_INVALID');
    expect(crossfade.message).toMatch(/audio_crossfade_s/);
  });

  it('refuses unknown operations and unknown fields', () => {
    expect(errorOf(() => parse({ op: 'explode' })).code).toBe('RECIPE_INVALID');
    const extra = errorOf(() => parse({ ...mp4, filter_complex: 'movie=/etc/passwd' }));
    expect(extra.code).toBe('RECIPE_INVALID');
    expect(JSON.stringify(extra.details)).toContain('steps.0');
  });

  it('needs an output, and caps steps and outputs', () => {
    expect(errorOf(() => parse({ op: 'scale', height: 720 })).message).toMatch(
      /at least one output/,
    );
    expect(
      errorOf(() => parse(...Array.from({ length: 26 }, () => ({ op: 'fps', value: 30 })))).message,
    ).toMatch(/25 steps/);
    expect(errorOf(() => parse(...Array.from({ length: 11 }, () => mp4))).message).toMatch(
      /10 outputs/,
    );
  });

  it('allows each analysis once', () => {
    expect(errorOf(() => parse({ op: 'volume' }, { op: 'volume' })).message).toMatch(
      /only one "volume"/,
    );
  });

  it.each([
    [{ op: 'trim' }, /start, end or duration/],
    [{ op: 'trim', end: 5, duration: 3 }, /not both/],
    [{ op: 'trim', start: 10, end: 5 }, /after start/],
    [{ op: 'cut_out', ranges: [{ start: 5, end: 2 }] }, /after start/],
    [{ op: 'loop' }, /exactly one of count, to_duration_s/],
    [{ op: 'scale', height: 700 }, /height alone/],
    [{ op: 'scale', width: 641, height: 360 }, /even/],
    [{ op: 'crop', x: 0, y: 0, w: 100 }, /all of x, y, w and h/],
    [{ op: 'crop', aspect: '16:9', auto: true }, /x\/y\/w\/h, aspect, or auto/],
    [{ op: 'rotate' }, /needs degrees/],
    [{ op: 'rotate', degrees: 90, angle_deg: 10 }, /not both/],
    [{ op: 'rotate', flip_h: true, metadata_only: true }, /degrees only/],
    [{ op: 'pad', aspect: '16:9', width: 1920, height: 1080 }, /aspect, or width and height/],
    [{ op: 'aspect', sar_1: false }, /sar_1 or dar/],
  ])('rejects %j', (step, message) => {
    expect(errorOf(() => parse(step, mp4)).message).toMatch(message);
  });

  it.each([
    [{ container: 'webm', video: { codec: 'h264' } }, /webm cannot hold h264/],
    [{ container: 'mp3', video: { codec: 'h264' } }, /cannot hold h264|audio container/],
    [{ container: 'mp4', audio: { codec: 'vorbis' } }, /mp4 cannot hold vorbis/],
    [{ container: 'mp4', video: { crf: 20, bitrate_kbps: 2000 } }, /one of video.crf/],
    [{ container: 'mov', video: { codec: 'vp9' } }, /mov cannot hold vp9/],
    [{ container: 'mp4', video: { crf: 60 } }, /0–51/],
    [{ container: 'mp4', video: { profile: 'main10' } }, /does not apply to h264/],
    [{ container: 'mp4', video: { codec: 'av1', two_pass: true, bitrate_kbps: 900 } }, /two-pass/],
    [{ container: 'mp4', video: { two_pass: true } }, /needs video.bitrate_kbps/],
    [{ container: 'mp4', video: { target_size_mb: 5000 } }, /limited to 4096/],
    [{ container: 'mp4', video: { preset: 7 } }, /preset "7" does not apply to h264/],
    [{ container: 'mp4', video: { codec: 'copy', crf: 20 } }, /does not apply to codec "copy"/],
    [{ container: 'mp3', audio: { codec: 'mp3', vbr: 10 } }, /0–9/],
    [{ container: 'mp4', audio: { vbr: 3 } }, /mp3 and vorbis/],
  ])('rejects encode %j', (encode, message) => {
    expect(errorOf(() => parse({ op: 'encode', ...encode })).message).toMatch(message);
  });

  it('checks cover, colour and split modes', () => {
    expect(errorOf(() => parse({ ...mp4, cover: 'poster.jpg' })).code).toBe('RECIPE_INVALID');
    expect(parse({ ...mp4, video: { color: { space: 'bt709' } } }).steps[0]).toMatchObject({
      video: { color: { space: 'bt709', range: 'tv' } },
    });
    expect(errorOf(() => parse({ ...mp4, video: { color: 'bt709' } })).code).toBe('RECIPE_INVALID');
    expect(parse({ op: 'split', by_scene: {} }).steps[0]).toMatchObject({
      by_scene: { threshold: 0.4 },
    });
    expect(
      errorOf(() => parse({ op: 'split', by_chapters: true, every_seconds: 60 })).message,
    ).toMatch(/exactly one/);
  });

  it('caps text layers', () => {
    const texts = Array.from({ length: 9 }, () => ({ op: 'text', text: 'hi' }));
    const limits = { ...LIMITS, RECIPE_MAX_TEXT_LAYERS: 8 };
    expect(errorOf(() => parseRecipe({ steps: [...texts, mp4] }, limits)).message).toMatch(
      /8 text layers/,
    );
    expect(parseRecipe({ steps: [...texts.slice(1), mp4] }, limits).steps).toHaveLength(9);
  });

  it('checks split, gif and metadata parameters', () => {
    expect(errorOf(() => parse({ op: 'split' })).message).toMatch(/every_seconds, at/);
    expect(errorOf(() => parse({ op: 'split', at: [10, 10] })).message).toMatch(/distinct/);
    expect(
      errorOf(() => parse({ op: 'split', every_seconds: 60, video: { codec: 'h264' } })).message,
    ).toMatch(/mode "accurate"/);
    expect(errorOf(() => parse({ op: 'gif', start: 0, end: 31 })).message).toMatch(/30 seconds/);
    expect(errorOf(() => parse({ ...mp4, metadata: { title: 'a\u0000b' } })).code).toBe(
      'RECIPE_INVALID',
    );
    expect(errorOf(() => parse({ ...mp4, metadata: { encoder: 'x' } })).code).toBe(
      'RECIPE_INVALID',
    );
    expect(
      parse({ ...mp4, metadata: { title: 'Line 1\nLine 2', strip: true } }).steps[0],
    ).toMatchObject({ metadata: { strip: true } });
  });

  it('normalises colours and aspect ratios', () => {
    const [scale, pad] = parse(
      { op: 'scale', width: 1280, height: 720, fit: 'pad', pad_color: '#ff8800' },
      { op: 'pad', aspect: '9:16', color: 'white' },
      mp4,
    ).steps;
    expect(scale).toMatchObject({ pad_color: '0xFF8800' });
    expect(pad).toMatchObject({ color: '0xFFFFFF', aspect: { width: 9, height: 16 } });
    expect(errorOf(() => parse({ op: 'pad', aspect: '16:9', color: 'chartreuse' }, mp4)).code).toBe(
      'RECIPE_INVALID',
    );
  });
});
