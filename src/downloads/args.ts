import { youtubeExtractorArgs } from '../access/access-args';
import { formatSelectionArgs } from '../discovery/presets';
import type { DownloadOptions } from './options';

/** Server-side settings that shape every download (SPEC §7g). */
export interface DownloadContext {
  /** yt-dlp's home path: finished files land here. */
  workDir: string;
  /** yt-dlp's temp path: fragments and partial files. */
  tempDir: string;
  /** Path of the bundled ffmpeg; undefined lets yt-dlp find ffmpeg on PATH. */
  ffmpegLocation?: string | undefined;
  maxFileSizeMb: number;
  sponsorblockApiUrl: string;
}

/** Marks progress lines on stdout so they cannot be confused with anything yt-dlp prints. */
export const PROGRESS_MARKER = 'MEDIA-PROGRESS ';
export const POSTPROCESS_MARKER = 'MEDIA-POSTPROCESS ';

const FILENAME_TEMPLATES: Record<DownloadOptions['filename'], string> = {
  title: '%(title).150B [%(id)s].%(ext)s',
  id: '%(id)s.%(ext)s',
  index_title: '%(playlist_index|0)03d - %(title).150B [%(id)s].%(ext)s',
  uploader_title: '%(uploader|Unknown).80B - %(title).150B [%(id)s].%(ext)s',
  date_title: '%(upload_date>%Y-%m-%d|0000-00-00)s - %(title).150B [%(id)s].%(ext)s',
  channel_date_title:
    '%(channel|Unknown).80B - %(upload_date>%Y-%m-%d|0000-00-00)s - %(title).150B [%(id)s].%(ext)s',
};

const CHAPTER_TEMPLATE =
  'chapter:%(title).100B - %(section_number)03d %(section_title).100B [%(id)s].%(ext)s';

/** yt-dlp's names in -S: a bare `vcodec:h264` prefers H.264 (a leading + would reverse the order). */
const VIDEO_CODEC_SORT: Record<Exclude<DownloadOptions['video_codec'], 'any'>, string> = {
  h264: 'h264',
  hevc: 'h265',
  vp9: 'vp9',
  av1: 'av01',
};

const SPONSORBLOCK_TITLES: Record<'default' | 'category', string> = {
  default: '[SponsorBlock]: %(category_names)l',
  category: '%(category_names)l',
};

/** `90.5` → `00:01:30.500`, the form yt-dlp accepts in section ranges. */
export function formatTime(seconds: number): string {
  const millis = Math.round(seconds * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const secs = Math.floor((millis % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis % 1000, 3)}`;
}

/** Chapter titles are literal; yt-dlp treats these arguments as regular expressions. */
export function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

const range = (r: { start: number; end: number }) => `*${formatTime(r.start)}-${formatTime(r.end)}`;

function formatArgs(options: DownloadOptions): string[] {
  const args: string[] = [];
  const audio = options.preset.startsWith('audio_');
  const selection = formatSelectionArgs(options.preset);
  const sort = [...(selection[2] === '-S' && selection[3] ? [selection[3]] : [])];

  if (options.multistreams === 'audio') {
    args.push('--audio-multistreams', '-f', 'bv+mergeall[vcodec=none]');
  } else if (options.format_id !== undefined) {
    args.push('-f', options.format_id);
  } else if (selection[0] === '-f' && selection[1]) {
    args.push('-f', selection[1]);
  }

  if (options.video_codec !== 'any') sort.push(`vcodec:${VIDEO_CODEC_SORT[options.video_codec]}`);
  if (options.audio_codec !== 'any') sort.push(`acodec:${options.audio_codec}`);
  if (options.fps_max !== undefined) sort.push(`fps:${options.fps_max}`);
  if (options.hdr === 'prefer') sort.push('hdr');
  if (options.hdr === 'avoid') sort.push('hdr:sdr');
  sort.push(...(options.format_sort ?? []));
  if (sort.length > 0) args.push('-S', sort.join(','));

  if (audio) {
    args.push(
      '-x',
      '--audio-format',
      options.preset === 'audio_best' ? 'best' : options.preset.slice(6),
    );
    if (options.audio_bitrate_kbps !== undefined)
      args.push('--audio-quality', `${options.audio_bitrate_kbps}K`);
    if (options.audio_vbr !== undefined) args.push('--audio-quality', String(options.audio_vbr));
    if (options.keep_video) args.push('-k');
  } else if (selection.length > 0 || options.format_id !== undefined) {
    args.push('--merge-output-format', options.container);
    args.push(options.recode ? '--recode-video' : '--remux-video', options.container);
  }
  if (options.prefer_free_formats) args.push('--prefer-free-formats');
  if (options.verify_formats) args.push('--check-formats');
  return args;
}

function onlyArgs(options: DownloadOptions): string[] {
  switch (options.preset) {
    case 'thumbnail_only':
      return ['--skip-download', '--write-thumbnail'];
    case 'subtitles_only':
      return [
        '--skip-download',
        ...(options.subtitles ? [] : ['--write-subs', '--sub-langs', 'en']),
      ];
    case 'metadata_only':
      return ['--skip-download', '--write-info-json', '--clean-info-json'];
    default:
      return [];
  }
}

function sectionArgs(options: DownloadOptions): string[] {
  const args: string[] = [];
  for (const section of options.sections ?? []) args.push('--download-sections', range(section));
  for (const title of options.sections_by_chapter ?? []) {
    args.push('--download-sections', `^${escapeRegex(title)}$`);
  }
  if (options.force_keyframes) args.push('--force-keyframes-at-cuts');

  const chapters = options.chapters;
  if (chapters?.split) args.push('--split-chapters', '-o', CHAPTER_TEMPLATE);
  for (const title of chapters?.remove_titles ?? []) {
    args.push('--remove-chapters', `^${escapeRegex(title)}$`);
  }
  for (const removed of chapters?.remove_ranges ?? [])
    args.push('--remove-chapters', range(removed));
  const embedByDefault =
    ['mp4', 'mkv'].includes(options.container) || options.preset === 'audio_m4a';
  if (chapters?.embed ?? embedByDefault) args.push('--embed-chapters');

  const sponsorblock = options.sponsorblock;
  if (sponsorblock && (sponsorblock.mark.length > 0 || sponsorblock.remove.length > 0)) {
    if (sponsorblock.mark.length > 0) args.push('--sponsorblock-mark', sponsorblock.mark.join(','));
    if (sponsorblock.remove.length > 0)
      args.push('--sponsorblock-remove', sponsorblock.remove.join(','));
    args.push('--sponsorblock-chapter-title', SPONSORBLOCK_TITLES[sponsorblock.chapter_title]);
  }
  return args;
}

function sidecarArgs(options: DownloadOptions): string[] {
  const args: string[] = [];
  const subtitles = options.subtitles;
  if (subtitles) {
    if (subtitles.write) args.push('--write-subs');
    if (subtitles.auto) args.push('--write-auto-subs');
    args.push('--sub-langs', subtitles.langs.join(','));
    if (subtitles.format !== 'original') {
      args.push('--sub-format', `${subtitles.format}/best`, '--convert-subs', subtitles.format);
    }
    if (subtitles.embed) args.push('--embed-subs');
  }
  const thumbnail = options.thumbnail;
  if (thumbnail?.write) args.push('--write-thumbnail');
  if (thumbnail?.all) args.push('--write-all-thumbnails');
  if (thumbnail?.embed) args.push('--embed-thumbnail');
  if (thumbnail?.convert) args.push('--convert-thumbnails', thumbnail.convert);

  args.push((options.metadata?.embed ?? true) ? '--embed-metadata' : '--no-embed-metadata');
  if (options.metadata?.info_json) args.push('--embed-info-json');

  const extras = new Set(options.extras ?? []);
  if (extras.has('info_json')) args.push('--write-info-json', '--clean-info-json');
  if (extras.has('description')) args.push('--write-description');
  if (extras.has('playlist_metafiles')) args.push('--write-playlist-metafiles');
  const comments = extras.has('comments')
    ? (options.comments ?? { max: 1000, sort: 'top' })
    : undefined;
  if (comments) args.push('--write-comments');
  args.push(...youtubeExtractorArgs(options.extractor_args, comments));
  return args;
}

function namingArgs(options: DownloadOptions): string[] {
  const args = ['-o', FILENAME_TEMPLATES[options.filename], '--trim-filenames', '180'];
  if (options.ascii_filenames) args.push('--restrict-filenames');
  if (options.windows_safe) args.push('--windows-filenames');
  return args;
}

/** Every flag for one single-item download, except the common ones the runner adds. */
export function downloadArgs(options: DownloadOptions, context: DownloadContext): string[] {
  const maxFileSizeMb = Math.min(
    options.max_filesize_mb ?? context.maxFileSizeMb,
    context.maxFileSizeMb,
  );
  return [
    '--no-playlist',
    '--newline',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_MARKER}%(progress)j`,
    '--progress-template',
    `postprocess:${POSTPROCESS_MARKER}%(progress)j`,
    '--no-overwrites',
    '--no-mtime',
    '--paths',
    `home:${context.workDir}`,
    '--paths',
    `temp:${context.tempDir}`,
    ...(context.ffmpegLocation === undefined ? [] : ['--ffmpeg-location', context.ffmpegLocation]),
    '--retries',
    '3',
    '--fragment-retries',
    '10',
    '--retry-sleep',
    'exp=1:30',
    ...(options.allow_missing_fragments ? [] : ['--abort-on-unavailable-fragments']),
    '--max-filesize',
    `${maxFileSizeMb}M`,
    '--sponsorblock-api',
    context.sponsorblockApiUrl,
    ...onlyArgs(options),
    ...formatArgs(options),
    ...sectionArgs(options),
    ...sidecarArgs(options),
    ...namingArgs(options),
    ...(options.limit_rate_kbps === undefined ? [] : ['-r', `${options.limit_rate_kbps}K`]),
    ...(options.concurrent_fragments === undefined
      ? []
      : ['-N', String(options.concurrent_fragments)]),
  ];
}
