import { z } from 'zod';

import { audioSchemas } from './ops/audio';
import { compositionSchemas } from './ops/composition';
import { analyzeSchemas } from './ops/analyze';
import { imageSchemas } from './ops/images';
import { platformSchemas } from './ops/platform';
import { packageSchemas } from './ops/package';
import { inputRef, textSchemas } from './ops/text';
import { visualSchemas } from './ops/visual';
import { aspectValue, colorValue, metadataText, outputName, timeValue } from './values';

/**
 * Recipe operations (SPEC §8). Every parameter is a number, an enum or a bounded string; the
 * composer turns them into a filtergraph, clients never send filter syntax or ffmpeg flags.
 * This file holds the milestone 5 set; LATER_OPS names the operations milestone 6 adds.
 */

const seconds = (max: number) => z.number().positive().max(max);
const name = { name: outputName.optional() };
const gravity = z.enum([
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top_left',
  'top_right',
  'bottom_left',
  'bottom_right',
]);

// --- Time (§8c) -------------------------------------------------------------------------------

const trim = z.strictObject({
  op: z.literal('trim'),
  start: timeValue.optional(),
  end: timeValue.optional(),
  duration: seconds(864_000).optional(),
  mode: z.enum(['copy', 'accurate']).default('accurate'),
});

const cutOut = z.strictObject({
  op: z.literal('cut_out'),
  ranges: z
    .array(z.strictObject({ start: timeValue, end: timeValue }))
    .min(1)
    .max(50),
});

const speed = z.strictObject({
  op: z.literal('speed'),
  factor: z.number().min(0.25).max(4),
  preserve_pitch: z.boolean().default(true),
  mute: z.boolean().default(false),
});

const reverse = z.strictObject({
  op: z.literal('reverse'),
  video: z.boolean().default(true),
  audio: z.boolean().default(true),
});

const boomerang = z.strictObject({
  op: z.literal('boomerang'),
  start: timeValue.default(0),
  duration: seconds(10),
});

const fps = z.strictObject({
  op: z.literal('fps'),
  value: z.number().min(1).max(120),
  mode: z.enum(['drop_dup', 'interpolate']).default('drop_dup'),
});

const timelapse = z.strictObject({
  op: z.literal('timelapse'),
  every_nth_frame: z.number().int().min(2).max(600),
});

const loop = z.strictObject({
  op: z.literal('loop'),
  count: z.number().int().min(1).max(20).optional(),
  to_duration_s: seconds(864_000).optional(),
});

const fade = z.strictObject({
  op: z.literal('fade'),
  in_s: z.number().min(0).max(60).default(0),
  out_s: z.number().min(0).max(60).default(0),
  color: z.enum(['black', 'white']).default('black'),
  audio: z.boolean().default(true),
});

const padDuration = z.strictObject({
  op: z.literal('pad_duration'),
  to_duration_s: seconds(864_000),
  mode: z.enum(['freeze', 'black', 'silence']).default('black'),
});

const audioOffset = z.strictObject({
  op: z.literal('audio_offset'),
  ms: z.number().int().min(-60_000).max(60_000),
});

// --- Geometry (§8e) ---------------------------------------------------------------------------

export const SCALE_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240] as const;
const dimension = z.number().int().min(16).max(7680);

const scale = z.strictObject({
  op: z.literal('scale'),
  width: dimension.optional(),
  height: dimension.optional(),
  fit: z.enum(['contain', 'cover', 'stretch', 'pad']).default('contain'),
  pad_color: colorValue.default('black'),
  pad: z.enum(['color', 'blur']).default('color'),
  algorithm: z.enum(['bicubic', 'lanczos', 'bilinear', 'neighbor', 'spline']).default('bicubic'),
  upscale: z.boolean().default(false),
});

const crop = z.strictObject({
  op: z.literal('crop'),
  x: z.number().int().min(0).max(7680).optional(),
  y: z.number().int().min(0).max(7680).optional(),
  w: dimension.optional(),
  h: dimension.optional(),
  aspect: aspectValue.optional(),
  gravity: gravity.default('center'),
  auto: z.boolean().default(false),
  limit: z.number().int().min(0).max(255).default(24),
  round: z.number().int().min(2).max(64).default(2),
});

const rotate = z.strictObject({
  op: z.literal('rotate'),
  degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]).optional(),
  flip_h: z.boolean().default(false),
  flip_v: z.boolean().default(false),
  angle_deg: z.number().min(-180).max(180).optional(),
  fill_color: colorValue.default('black'),
  metadata_only: z.boolean().default(false),
});

const pad = z.strictObject({
  op: z.literal('pad'),
  aspect: aspectValue.optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  color: colorValue.default('black'),
  blur: z.boolean().default(false),
  position: gravity.default('center'),
});

const aspect = z.strictObject({
  op: z.literal('aspect'),
  sar_1: z.boolean().default(true),
  dar: aspectValue.optional(),
});

// --- Encode (§8b) -----------------------------------------------------------------------------

export const VIDEO_CODECS = [
  'h264',
  'hevc',
  'vp9',
  'av1',
  'av1_aom',
  'prores',
  'dnxhr',
  'mjpeg',
  'png',
  'copy',
  'none',
] as const;
export const AUDIO_CODECS = [
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'flac',
  'alac',
  'pcm_s16le',
  'pcm_s24le',
  'ac3',
  'eac3',
  'copy',
  'none',
] as const;
export const CONTAINERS = [
  'mp4',
  'mov',
  'mkv',
  'webm',
  'mpegts',
  'mp3',
  'm4a',
  'm4b',
  'aac',
  'ogg',
  'opus',
  'flac',
  'wav',
  'aiff',
] as const;
export type Container = (typeof CONTAINERS)[number];
export type VideoCodec = (typeof VIDEO_CODECS)[number];
export type AudioCodec = (typeof AUDIO_CODECS)[number];

const X26X_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
] as const;

const videoSettings = z.strictObject({
  codec: z.enum(VIDEO_CODECS).optional(),
  crf: z.number().int().min(0).max(63).optional(),
  bitrate_kbps: z.number().int().min(100).max(100_000).optional(),
  maxrate_kbps: z.number().int().min(100).max(100_000).optional(),
  bufsize_kbps: z.number().int().min(100).max(200_000).optional(),
  two_pass: z.boolean().default(false),
  target_size_mb: z.number().positive().max(1_048_576).optional(),
  preset: z
    .union([
      z.enum(X26X_PRESETS),
      z.enum(['good', 'best', 'realtime']),
      z.number().int().min(0).max(13),
    ])
    .optional(),
  cpu_used: z.number().int().min(0).max(8).optional(),
  tune: z
    .enum(['film', 'animation', 'grain', 'stillimage', 'fastdecode', 'zerolatency', 'psnr', 'ssim'])
    .optional(),
  profile: z
    .enum([
      'baseline',
      'main',
      'high',
      'high10',
      'main10',
      'proxy',
      'lt',
      'standard',
      'hq',
      '4444',
      '4444xq',
      'lb',
      'sq',
      'hqx',
      '444',
    ])
    .optional(),
  level: z
    .enum(['3.0', '3.1', '4.0', '4.1', '4.2', '5.0', '5.1', '5.2', '6.0', '6.1', '6.2'])
    .optional(),
  pix_fmt: z
    .enum(['yuv420p', 'yuv420p10le', 'yuv422p', 'yuv422p10le', 'yuv444p', 'rgb24', 'rgba'])
    .optional(),
  fps: z.number().min(1).max(120).optional(),
  keyframe_interval_s: z.number().min(0.5).max(10).optional(),
  scene_cut: z.boolean().default(true),
  bframes: z.number().int().min(0).max(8).optional(),
  faststart: z.boolean().optional(),
  fragmented: z.boolean().default(false),
  hw: z.enum(['auto', 'off']).default('auto'),
  /** Colour conversion and tagging of the output (SPEC §8b `video.color`). */
  color: z
    .strictObject({
      space: z.enum(['bt709', 'bt601', 'bt2020']),
      range: z.enum(['tv', 'pc']).default('tv'),
    })
    .optional(),
});

const audioSettings = z.strictObject({
  codec: z.enum(AUDIO_CODECS).optional(),
  bitrate_kbps: z.number().int().min(32).max(512).optional(),
  vbr: z.number().int().min(0).max(10).optional(),
  sample_rate: z
    .union(
      [8000, 11_025, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000].map((rate) =>
        z.literal(rate),
      ),
    )
    .optional(),
  channels: z.union([z.literal(1), z.literal(2), z.literal(6)]).optional(),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'a BCP-47 language code')
    .optional(),
  title: metadataText(64).optional(),
});

export const METADATA_KEYS = [
  'title',
  'artist',
  'album',
  'album_artist',
  'date',
  'genre',
  'track',
  'comment',
  'description',
  'copyright',
] as const;

const metadataSettings = z.strictObject({
  ...Object.fromEntries(METADATA_KEYS.map((key) => [key, metadataText(1000).optional()])),
  strip: z.boolean().default(false),
}) as z.ZodType<Partial<Record<(typeof METADATA_KEYS)[number], string>> & { strip: boolean }>;

const chapterSettings = z.union([
  z.enum(['keep', 'strip']),
  z.strictObject({
    set: z
      .array(z.strictObject({ start: timeValue, end: timeValue, title: metadataText(200) }))
      .min(1)
      .max(500),
  }),
]);

const encodeFields = {
  container: z.enum(CONTAINERS),
  video: videoSettings.optional(),
  audio: audioSettings.optional(),
  metadata: metadataSettings.optional(),
  chapters: chapterSettings.default('keep'),
  cover: z.strictObject({ input: inputRef }).optional(),
};

const encode = z.strictObject({ op: z.literal('encode'), ...name, ...encodeFields });

const split = z.strictObject({
  op: z.literal('split'),
  ...name,
  every_seconds: z.number().min(1).max(86_400).optional(),
  at: z.array(timeValue).min(1).max(500).optional(),
  by_chapters: z.boolean().optional(),
  by_silence: z
    .strictObject({
      threshold_db: z.number().min(-90).max(-10).default(-40),
      min_silence_s: z.number().min(0.1).max(60).default(1),
    })
    .optional(),
  by_scene: z.strictObject({ threshold: z.number().min(0.05).max(1).default(0.4) }).optional(),
  mode: z.enum(['copy', 'accurate']).default('copy'),
  ...encodeFields,
  container: z.enum(CONTAINERS).optional(),
});

// --- Images and GIF (§8h) ---------------------------------------------------------------------

const imageFormat = z.enum(['jpg', 'png', 'webp']);

const thumbnail = z.strictObject({
  op: z.literal('thumbnail'),
  ...name,
  at: z
    .union([timeValue, z.literal('smart'), z.string().regex(/^\d{1,3}(\.\d)?%$/, 'e.g. 25%')])
    .default('smart'),
  count: z.number().int().min(1).max(100).default(1),
  width: dimension.optional(),
  height: dimension.optional(),
  format: imageFormat.default('jpg'),
  quality: z.number().int().min(1).max(100).default(85),
});

const contactSheet = z.strictObject({
  op: z.literal('contact_sheet'),
  ...name,
  columns: z.number().int().min(1).max(12).default(4),
  rows: z.number().int().min(1).max(20).optional(),
  interval_s: z.number().min(0.5).max(3600).optional(),
  tile_width: z.number().int().min(32).max(1920).default(320),
  padding: z.number().int().min(0).max(64).default(4),
  background: colorValue.default('black'),
  timestamps: z.boolean().default(false),
  format: imageFormat.default('jpg'),
  quality: z.number().int().min(1).max(100).default(85),
});

const gif = z.strictObject({
  op: z.literal('gif'),
  ...name,
  start: timeValue.default(0),
  end: timeValue.optional(),
  fps: z.number().int().min(1).max(30).default(12),
  width: z.number().int().min(16).max(1080).default(480),
  loop: z.boolean().default(true),
  dither: z.enum(['bayer', 'floyd_steinberg', 'sierra2_4a', 'none']).default('sierra2_4a'),
  bayer_scale: z.number().int().min(0).max(5).default(2),
  max_colors: z.number().int().min(2).max(256).default(256),
  palette: z.enum(['global', 'per_frame']).default('global'),
  diff_mode: z.boolean().default(false),
});

// --- Packaging (§8i) --------------------------------------------------------------------------

const remux = z.strictObject({
  op: z.literal('remux'),
  ...name,
  container: z.enum(['mp4', 'mov', 'mkv', 'webm', 'mpegts']),
  fix_incompatible: z.boolean().default(false),
  faststart: z.boolean().default(true),
  /** Video in this codec is copied; video in any other is converted to it. */
  video_codec: z.enum(['h264', 'hevc']).optional(),
  /** Audio in this codec is copied; audio in any other is converted to it. */
  audio_codec: z.enum(['aac']).optional(),
});

const fix = z.strictObject({
  op: z.literal('fix'),
  ...name,
  container: z.enum(['mp4', 'mov', 'mkv', 'webm', 'mpegts']).optional(),
  regen_timestamps: z.boolean().default(true),
  ignore_errors: z.boolean().default(true),
  fix_duration: z.boolean().default(true),
  fill_gaps: z.boolean().default(false),
  faststart: z.boolean().default(true),
});

// --- Analysis (§8j) ---------------------------------------------------------------------------

const probe = z.strictObject({ op: z.literal('probe'), ...name });
const keyframes = z.strictObject({
  op: z.literal('keyframes'),
  ...name,
  max: z.number().int().min(1).max(100_000).default(10_000),
});
const loudness = z.strictObject({ op: z.literal('loudness'), ...name });
const volume = z.strictObject({ op: z.literal('volume'), ...name });
const silenceDetect = z.strictObject({
  op: z.literal('silence_detect'),
  ...name,
  threshold_db: z.number().min(-90).max(0).default(-50),
  min_duration_s: z.number().min(0.05).max(60).default(0.5),
});
const blackDetect = z.strictObject({
  op: z.literal('black_detect'),
  ...name,
  min_duration_s: z.number().min(0.05).max(60).default(0.5),
  pixel_threshold: z.number().min(0).max(1).default(0.1),
  picture_threshold: z.number().min(0).max(1).default(0.98),
});
const sceneChanges = z.strictObject({
  op: z.literal('scene_changes'),
  ...name,
  threshold: z.number().min(0.01).max(1).default(0.3),
});

export const stepSchema = z.discriminatedUnion('op', [
  trim,
  cutOut,
  speed,
  reverse,
  boomerang,
  fps,
  timelapse,
  loop,
  fade,
  padDuration,
  audioOffset,
  scale,
  crop,
  rotate,
  pad,
  aspect,
  encode,
  split,
  thumbnail,
  contactSheet,
  gif,
  remux,
  fix,
  probe,
  keyframes,
  loudness,
  volume,
  silenceDetect,
  blackDetect,
  sceneChanges,
  ...visualSchemas,
  ...audioSchemas,
  ...compositionSchemas,
  ...textSchemas,
  ...imageSchemas,
  ...packageSchemas,
  ...analyzeSchemas,
  ...platformSchemas,
  scale.extend({ op: z.literal('image_resize') }),
  crop.extend({ op: z.literal('image_crop') }),
  z.strictObject({
    op: z.literal('segment'),
    ...name,
    every_seconds: z.number().min(1).max(86_400),
    container: z.enum(CONTAINERS).optional(),
  }),
]);

export type Step = z.output<typeof stepSchema>;
export type StepOf<K extends Step['op']> = Extract<Step, { op: K }>;
export type EncodeStep = StepOf<'encode'>;
export type VideoSettings = z.output<typeof videoSettings>;
export type AudioSettings = z.output<typeof audioSettings>;

export const TERMINAL_OPS = [
  'encode',
  'split',
  'thumbnail',
  'contact_sheet',
  'gif',
  'remux',
  'fix',
  'extract_streams',
  'subtitles_extract',
  'subtitles_convert',
  'thumbnails_scene',
  'storyboard',
  'animated_webp',
  'animated_avif',
  'frames',
  'image_convert',
  'images_to_video',
  'audio_visual',
  'hls',
  'dash',
  'fragmented_mp4',
  'mpegts',
  'bitstream',
  'segment',
  'transcribe',
] as const;
export const ANALYSIS_OPS = [
  'probe',
  'keyframes',
  'loudness',
  'volume',
  'silence_detect',
  'black_detect',
  'scene_changes',
  'freeze_detect',
  'crop_detect',
  'interlace_detect',
  'duplicate_frames',
  'quality_compare',
  'hash',
  'frame_hashes',
  'peaks',
  'bitrate_timeline',
] as const;
export type TerminalStep = StepOf<(typeof TERMINAL_OPS)[number]>;
export type AnalysisStep = StepOf<(typeof ANALYSIS_OPS)[number]>;
export type FilterStep = Exclude<Step, TerminalStep | AnalysisStep>;

export const isTerminal = (step: Step): step is TerminalStep =>
  (TERMINAL_OPS as readonly string[]).includes(step.op);
export const isAnalysis = (step: Step): step is AnalysisStep =>
  (ANALYSIS_OPS as readonly string[]).includes(step.op);

/** Operations specified in SPEC §8 that arrive with milestone 6. */
export const LATER_OPS: readonly string[] = [];

export const recipeSchema = z.strictObject({
  steps: z.array(z.unknown()).min(1).max(500),
  /** The named recipe the steps came from (stored on jobs for reference). */
  name: z.string().max(64).optional(),
});
