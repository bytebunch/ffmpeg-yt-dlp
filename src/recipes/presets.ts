import { z } from 'zod';

import { AppError } from '../common/errors';
import { timeValue } from './values';

/**
 * Built-in recipes (SPEC §8k), used as `recipe: "web_mp4_720"` or, for those with parameters,
 * `recipe: { preset: "clip", params: { start: 60, end: 90 } }`. They expand to ordinary steps, so
 * they validate, cost and run like any recipe.
 */

interface Preset {
  description: string;
  params: z.ZodType;
  steps: (params: never) => unknown[];
}

const none = z.strictObject({});
const web = (height: number) => [
  { op: 'scale', height },
  {
    op: 'encode',
    name: 'web',
    container: 'mp4',
    video: { codec: 'h264', crf: 23, preset: 'veryfast' },
    audio: { codec: 'aac', bitrate_kbps: 128 },
  },
];
const audioOnly = (container: string, codec: string, bitrate?: number) => [
  {
    op: 'encode',
    name: 'audio',
    container,
    video: { codec: 'none' },
    audio: { codec, ...(bitrate ? { bitrate_kbps: bitrate } : {}) },
  },
];

function preset<P extends z.ZodType>(
  description: string,
  params: P,
  steps: (params: z.output<P>) => unknown[],
): Preset {
  return { description, params, steps: steps };
}

export const PRESETS: Record<string, Preset> = {
  web_mp4_1080: preset('1080p H.264/AAC MP4 for the web', none, () => web(1080)),
  web_mp4_720: preset('720p H.264/AAC MP4 for the web', none, () => web(720)),
  web_mp4_480: preset('480p H.264/AAC MP4 for the web', none, () => web(480)),
  compress_to_size: preset(
    'Two-pass MP4 that fits a size (default 25 MB)',
    z.strictObject({ target_size_mb: z.number().positive().max(100_000).default(25) }),
    ({ target_size_mb }) => [
      {
        op: 'encode',
        name: 'compressed',
        container: 'mp4',
        video: { codec: 'h264', target_size_mb },
        audio: { codec: 'aac', bitrate_kbps: 96 },
      },
    ],
  ),
  social_vertical: preset('9:16 1080x1920 with a blurred background, H.264 high 4.1', none, () => [
    { op: 'platform_format', platform: 'tiktok', strategy: 'blur', max_duration: false },
    {
      op: 'encode',
      name: 'vertical',
      container: 'mp4',
      video: { codec: 'h264', profile: 'high', level: '4.1' },
      audio: { codec: 'aac', bitrate_kbps: 128 },
    },
  ]),
  clip: preset(
    'A cut between start and end with short fades, 720p MP4',
    z
      .strictObject({ start: timeValue, end: timeValue })
      .refine((p) => p.end > p.start, 'end must be after start'),
    ({ start, end }) => [
      { op: 'trim', start, end, mode: 'accurate' },
      { op: 'fade', in_s: 0.3, out_s: 0.3 },
      ...web(720),
    ],
  ),
  audio_mp3_192: preset('MP3 192 kbps', none, () => audioOnly('mp3', 'mp3', 192)),
  audio_m4a_160: preset('AAC 160 kbps in M4A', none, () => audioOnly('m4a', 'aac', 160)),
  audio_opus_96: preset('Opus 96 kbps', none, () => audioOnly('opus', 'opus', 96)),
  audio_flac: preset('Lossless FLAC', none, () => audioOnly('flac', 'flac')),
  podcast: preset('Voice cleaned up and levelled to -16 LUFS, MP3 128 kbps', none, () => [
    { op: 'channels', layout: 'stereo' },
    { op: 'highpass', freq_hz: 80 },
    { op: 'compress', preset: 'voice' },
    { op: 'normalize_loudness', target_lufs: -16 },
    ...audioOnly('mp3', 'mp3', 128),
  ]),
  audiobook_m4b: preset('Levelled to -18 LUFS, mono AAC 64 kbps M4B with chapters', none, () => [
    { op: 'normalize_loudness', target_lufs: -18 },
    {
      op: 'encode',
      name: 'audiobook',
      container: 'm4b',
      video: { codec: 'none' },
      audio: { codec: 'aac', bitrate_kbps: 64, channels: 1 },
      chapters: 'keep',
    },
  ]),
  gif_preview: preset(
    '6-second 480 px GIF',
    z.strictObject({ start: timeValue.default(0) }),
    ({ start }) => [
      {
        op: 'gif',
        name: 'preview',
        start,
        end: start + 6,
        width: 480,
        fps: 12,
        dither: 'sierra2_4a',
      },
    ],
  ),
  thumbnail_set: preset('Five thumbnails and a 4x4 contact sheet', none, () => [
    { op: 'thumbnail', name: 'thumbnails', count: 5 },
    { op: 'contact_sheet', name: 'sheet', columns: 4, rows: 4 },
  ]),
  storyboard_vtt: preset('Sprite sheets and WebVTT every 5 seconds', none, () => [
    { op: 'storyboard', interval_s: 5 },
  ]),
  hls_ladder: preset('HLS with the automatic ladder, 6-second fMP4 segments', none, () => [
    { op: 'hls', ladder: 'auto', segment_s: 6, segment_type: 'fmp4' },
  ]),
  archive_mkv: preset('Every stream remuxed into MKV', none, () => [
    { op: 'remux', name: 'archive', container: 'mkv' },
  ]),
  audio_waveform_video: preset('Waveform video (1920x1080) for audio', none, () => [
    { op: 'audio_to_video', visual: 'waveform', size: { width: 1920, height: 1080 } },
    {
      op: 'encode',
      name: 'waveform',
      container: 'mp4',
      video: { codec: 'h264', tune: 'stillimage' },
      audio: { codec: 'aac', bitrate_kbps: 160 },
    },
  ]),
  burn_subtitles: preset(
    'Subtitles from an input burned in, 1080p MP4',
    z.strictObject({ input: z.number().int().min(1).max(499).default(1) }),
    ({ input }) => [{ op: 'subtitles_burn', input }, ...web(1080)],
  ),
  loudness_report: preset('Loudness, volume and silences', none, () => [
    { op: 'loudness' },
    { op: 'volume' },
    { op: 'silence_detect' },
  ]),
  media_report: preset('Probe, keyframes, bitrate, scenes, black frames, interlacing', none, () => [
    { op: 'probe' },
    { op: 'keyframes' },
    { op: 'bitrate_timeline' },
    { op: 'scene_changes' },
    { op: 'black_detect' },
    { op: 'interlace_detect' },
  ]),
};

export const RECIPE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** What a job may send as `recipe` (or `then`). */
export type RecipeRef = { steps: unknown[] } | string | { preset: string; params?: unknown };

/** The steps of a built-in preset, with its parameters checked; undefined if not a preset. */
export function presetSteps(name: string, params: unknown = {}): unknown[] | undefined {
  const found = PRESETS[name];
  if (!found) return undefined;
  const parsed = found.params.safeParse(params);
  if (!parsed.success) {
    throw new AppError('RECIPE_INVALID', `Recipe "${name}" parameters are not valid`, {
      issues: parsed.error.issues.map((issue) => ({
        path: ['params', ...issue.path].join('.'),
        message: issue.message,
      })),
    });
  }
  return found.steps(parsed.data as never);
}

/** Built-ins as listed by GET /v1/recipes. */
export function presetList() {
  return Object.entries(PRESETS).map(([name, entry]) => ({
    name,
    builtin: true,
    description: entry.description,
    params: Object.keys(entry.params instanceof z.ZodObject ? entry.params.shape : {}),
  }));
}
