import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import type { ProbeSummary, StreamSummary } from '../../../src/media/ffprobe';
import { compose } from '../../../src/recipes/compose';
import { PRESETS, presetList, presetSteps } from '../../../src/recipes/presets';
import { parseRecipe } from '../../../src/recipes/validate';

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
};
const stream = (values: Partial<StreamSummary>): StreamSummary => ({
  type: 'video',
  codec: 'h264',
  width: 1920,
  height: 1080,
  fps: 30,
  channels: null,
  sample_rate: null,
  bit_rate: null,
  language: null,
  attached_pic: false,
  color_transfer: null,
  ...values,
});
const PROBE: ProbeSummary = {
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration_s: 600,
  size_bytes: 1,
  bit_rate: 1,
  streams: [stream({}), stream({ type: 'audio', codec: 'aac', channels: 2, sample_rate: 48_000 })],
};
const SUBTITLES: ProbeSummary = {
  format: 'srt',
  duration_s: null,
  size_bytes: 1,
  bit_rate: null,
  streams: [stream({ type: 'subtitle', codec: 'subrip' })],
};
const PARAMS: Record<string, unknown> = { clip: { start: 10, end: 40 } };

describe('built-in recipes (SPEC §8k)', () => {
  it('lists every preset of the spec', () => {
    expect(presetList().map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'web_mp4_1080',
        'web_mp4_720',
        'web_mp4_480',
        'compress_to_size',
        'social_vertical',
        'clip',
        'audio_mp3_192',
        'audio_m4a_160',
        'audio_opus_96',
        'audio_flac',
        'podcast',
        'audiobook_m4b',
        'gif_preview',
        'thumbnail_set',
        'storyboard_vtt',
        'hls_ladder',
        'archive_mkv',
        'audio_waveform_video',
        'burn_subtitles',
        'loudness_report',
        'media_report',
      ]),
    );
    expect(presetList().find((entry) => entry.name === 'clip')?.params).toEqual(['start', 'end']);
  });

  it.each(Object.keys(PRESETS))('%s validates and composes for a 10-minute 1080p input', (name) => {
    const steps = presetSteps(name, PARAMS[name] ?? {}) ?? [];
    const recipe = parseRecipe({ steps }, LIMITS);
    const inputs =
      name === 'burn_subtitles'
        ? [
            { path: '/in.mp4', probe: PROBE },
            { path: '/subs.srt', probe: SUBTITLES },
          ]
        : [{ path: '/in.mp4', probe: PROBE }];
    const result = compose(recipe, inputs, {
      workDir: '/work',
      threads: 2,
      maxFileBytes: 4096 * 1024 * 1024,
      limits: {
        REVERSE_MAX_SECONDS: 60,
        INTERPOLATE_MAX_SECONDS: 120,
        GIF_MAX_SECONDS: 30,
        MAX_MEDIA_DURATION_MINUTES: 240,
      },
      measurements: {
        'loudnorm:3': {
          input_i: '-20',
          input_tp: '-3',
          input_lra: '5',
          input_thresh: '-30',
          target_offset: '0',
        },
        'loudnorm:0': {
          input_i: '-20',
          input_tp: '-3',
          input_lra: '5',
          input_thresh: '-30',
          target_offset: '0',
        },
      },
    });
    expect(result.kind).toBe('plan');
  });

  it('checks preset parameters', () => {
    expect(() => presetSteps('clip', {})).toThrow(AppError);
    expect(() => presetSteps('clip', { start: 40, end: 10 })).toThrow(/parameters are not valid/);
    expect(presetSteps('compress_to_size', { target_size_mb: 8 })).toEqual([
      expect.objectContaining({ video: { codec: 'h264', target_size_mb: 8 } }),
    ]);
    expect(presetSteps('nope')).toBeUndefined();
  });
});
