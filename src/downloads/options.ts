import { z } from 'zod';

import { accessShape } from '../access/options';
import { DOWNLOAD_PRESETS } from '../discovery/presets';

/** Download options (SPEC §7a–7c, §7f): every field is validated; none is yt-dlp syntax. */

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/;

/** Seconds, or `HH:MM:SS(.ms)` / `MM:SS(.ms)`, normalised to seconds. */
export const timestamp = z.union([
  z.number().min(0).max(1_000_000),
  z
    .string()
    .regex(TIMESTAMP, 'must be seconds or HH:MM:SS(.ms)')
    .transform((value) => {
      const [, hours = '0', minutes = '0', seconds = '0', millis = '0'] =
        TIMESTAMP.exec(value) ?? [];
      return (
        Number(hours) * 3600 +
        Number(minutes) * 60 +
        Number(seconds) +
        Number(millis.padEnd(3, '0')) / 1000
      );
    }),
]);

export const timeRange = z
  .strictObject({ start: timestamp, end: timestamp })
  .refine((range) => range.end > range.start, 'end must be after start');

const nonOverlapping = (ranges: { start: number; end: number }[]) =>
  [...ranges]
    .sort((a, b) => a.start - b.start)
    .every((range, i, sorted) => i === 0 || range.start >= (sorted[i - 1]?.end ?? 0));

const language = z
  .string()
  .regex(
    /^(?:all|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/,
    'must be a language tag such as en, pt-BR or all',
  );

export const SPONSORBLOCK_CATEGORIES = [
  'sponsor',
  'intro',
  'outro',
  'selfpromo',
  'preview',
  'filler',
  'interaction',
  'music_offtopic',
  'poi_highlight',
  'chapter',
  'all',
  'default',
] as const;

export const FILENAME_TEMPLATES = [
  'title',
  'id',
  'index_title',
  'uploader_title',
  'date_title',
  'channel_date_title',
] as const;

export const IMPERSONATE_TARGETS = [
  'chrome',
  'chrome-android',
  'safari',
  'safari-ios',
  'edge',
  'firefox',
] as const;

export const SORT_KEYS = [
  'res',
  'fps',
  'codec',
  'vcodec',
  'acodec',
  'br',
  'vbr',
  'abr',
  'asr',
  'size',
  'ext',
  'hdr',
  'channels',
  'lang',
  'proto',
  'quality',
] as const;

export const downloadOptionsShape = {
  // 7a — format selection
  preset: z.enum(DOWNLOAD_PRESETS).default('best'),
  container: z.enum(['mp4', 'mkv', 'webm', 'mov']).default('mp4'),
  recode: z.boolean().default(false),
  video_codec: z.enum(['any', 'h264', 'hevc', 'vp9', 'av1']).default('any'),
  audio_codec: z.enum(['any', 'aac', 'opus', 'mp3', 'flac']).default('any'),
  fps_max: z.union([z.literal(30), z.literal(60)]).optional(),
  hdr: z.enum(['prefer', 'avoid', 'any']).default('avoid'),
  prefer_free_formats: z.boolean().default(false),
  format_id: z
    .string()
    .regex(
      /^[A-Za-z0-9_.-]{1,64}(?:\+[A-Za-z0-9_.-]{1,64})?$/,
      'must be a format_id from /v1/info, or a+b',
    )
    .optional(),
  format_sort: z
    .array(z.string().regex(new RegExp(`^\\+?(?:${SORT_KEYS.join('|')})$`), 'unknown sort key'))
    .max(SORT_KEYS.length)
    .optional(),
  audio_bitrate_kbps: z.number().int().min(96).max(320).optional(),
  audio_vbr: z.number().int().min(0).max(9).optional(),
  max_filesize_mb: z.number().int().min(1).optional(),
  verify_formats: z.boolean().default(false),
  multistreams: z.literal('audio').optional(),
  // 7b — sections, chapters, SponsorBlock
  sections: z
    .array(timeRange)
    .min(1)
    .max(20)
    .refine(nonOverlapping, 'sections must not overlap')
    .optional(),
  sections_by_chapter: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
  force_keyframes: z.boolean().default(false),
  chapters: z
    .strictObject({
      split: z.boolean().default(false),
      remove_titles: z.array(z.string().min(1).max(200)).max(50).default([]),
      remove_ranges: z.array(timeRange).max(50).default([]),
      embed: z.boolean().optional(),
    })
    .optional(),
  sponsorblock: z
    .strictObject({
      mark: z.array(z.enum(SPONSORBLOCK_CATEGORIES)).default([]),
      remove: z.array(z.enum(SPONSORBLOCK_CATEGORIES)).default([]),
      chapter_title: z.enum(['default', 'category']).default('default'),
    })
    .optional(),
  // 7c — subtitles, thumbnails, metadata, naming
  subtitles: z
    .strictObject({
      langs: z.array(language).min(1).max(20).default(['en']),
      auto: z.boolean().default(false),
      write: z.boolean().default(true),
      format: z.enum(['srt', 'vtt', 'ass', 'lrc', 'original']).default('original'),
      embed: z.boolean().default(false),
    })
    .optional(),
  thumbnail: z
    .strictObject({
      write: z.boolean().default(false),
      all: z.boolean().default(false),
      embed: z.boolean().default(false),
      convert: z.enum(['jpg', 'png', 'webp']).optional(),
    })
    .optional(),
  metadata: z
    .strictObject({ embed: z.boolean().default(true), info_json: z.boolean().default(false) })
    .optional(),
  extras: z
    .array(z.enum(['info_json', 'description', 'comments', 'playlist_metafiles']))
    .max(4)
    .optional(),
  comments: z
    .strictObject({
      max: z.number().int().min(1).max(100_000).default(1000),
      sort: z.enum(['top', 'new']).default('top'),
    })
    .optional(),
  filename: z.enum(FILENAME_TEMPLATES).default('title'),
  ascii_filenames: z.boolean().default(false),
  windows_safe: z.boolean().default(false),
  keep_video: z.boolean().default(false),
  // 7f — access and bandwidth; all optional without defaults, so earlier dedup keys still match
  allow_missing_fragments: z.boolean().default(false),
  limit_rate_kbps: z.number().int().min(1).optional(),
  concurrent_fragments: z.number().int().min(1).max(8).optional(),
  impersonate: z.enum(IMPERSONATE_TARGETS).optional(),
  ...accessShape,
};

export const downloadOptionsSchema = z.strictObject(downloadOptionsShape);

export type DownloadOptions = z.output<typeof downloadOptionsSchema>;

/** Cross-field rules a schema cannot express field by field. Returns messages, empty when valid. */
export function optionProblems(options: DownloadOptions): string[] {
  const problems: string[] = [];
  const audio = options.preset.startsWith('audio_');
  if (options.mark_watched === true && options.cookies === undefined) {
    problems.push('mark_watched requires cookies');
  }
  if (options.multistreams === 'audio' && options.container !== 'mkv') {
    problems.push('multistreams requires container "mkv"');
  }
  if (options.metadata?.info_json === true && options.container !== 'mkv') {
    problems.push('metadata.info_json requires container "mkv"');
  }
  if (options.keep_video && !audio) problems.push('keep_video only applies to audio presets');
  if (options.audio_bitrate_kbps !== undefined && options.audio_vbr !== undefined) {
    problems.push('use either audio_bitrate_kbps or audio_vbr, not both');
  }
  if (options.recode && audio) problems.push('recode applies to video presets');
  if (options.subtitles?.embed === true && options.subtitles.format === 'lrc') {
    problems.push('lrc subtitles cannot be embedded');
  }
  const sponsorblock = options.sponsorblock;
  if (
    (options.chapters?.remove_ranges.length ?? 0) > 0 &&
    sponsorblock !== undefined &&
    sponsorblock.mark.length + sponsorblock.remove.length > 0
  ) {
    // yt-dlp 2026.10.26 crashes (TypeError in ModifyChapters) on this combination; a regression
    // test in test/integration/ytdlp/real-download.spec.ts tells us when it is fixed.
    problems.push('chapters.remove_ranges cannot be combined with sponsorblock');
  }
  return problems;
}
