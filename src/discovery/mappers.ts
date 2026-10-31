import { AppError } from '../common/errors';

/**
 * Turns raw yt-dlp JSON into the API's shapes (SPEC §7i). Only listed fields leave the service:
 * internal fields are dropped, and stream URLs are never returned (they are signed for the
 * server's IP address and expire, so they are useless to clients and reveal the server).
 */

export const INFO_INCLUDES = [
  'formats',
  'subtitles',
  'thumbnails',
  'chapters',
  'heatmap',
  'description',
  'tags',
] as const;
export type InfoInclude = (typeof INFO_INCLUDES)[number];

type Raw = Record<string, unknown>;
type Mapped = Record<string, unknown>;

const VIDEO_FIELDS = [
  'id',
  'extractor',
  'title',
  'uploader',
  'uploader_id',
  'channel',
  'channel_id',
  'channel_follower_count',
  'upload_date',
  'release_timestamp',
  'timestamp',
  'duration',
  'view_count',
  'like_count',
  'comment_count',
  'age_limit',
  'availability',
  'live_status',
  'was_live',
  'is_live',
  'language',
  'categories',
  'thumbnail',
  'webpage_url',
  'original_url',
] as const;

const FORMAT_FIELDS = [
  'format_id',
  'ext',
  'resolution',
  'fps',
  'vcodec',
  'acodec',
  'tbr',
  'vbr',
  'abr',
  'asr',
  'audio_channels',
  'filesize',
  'filesize_approx',
  'dynamic_range',
  'protocol',
  'language',
  'format_note',
] as const;

const PLAYLIST_FIELDS = [
  'id',
  'extractor',
  'title',
  'uploader',
  'uploader_id',
  'channel',
  'channel_id',
  'modified_date',
  'playlist_count',
  'webpage_url',
] as const;

const COMMENT_FIELDS = [
  'id',
  'text',
  'author',
  'author_id',
  'author_is_uploader',
  'author_is_verified',
  'like_count',
  'timestamp',
  'is_pinned',
  'is_favorited',
] as const;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Raw[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Listed fields only; missing ones are null so the response shape is stable. */
export function pick(raw: Raw, fields: readonly string[]): Mapped {
  return Object.fromEntries(fields.map((field) => [field, raw[field] ?? null]));
}

/** YYYYMMDD from a Unix timestamp, for flat entries that only carry `timestamp`. */
export function uploadDate(raw: Raw): string | null {
  if (typeof raw.upload_date === 'string') return raw.upload_date;
  if (typeof raw.timestamp !== 'number') return null;
  return new Date(raw.timestamp * 1000).toISOString().slice(0, 10).replaceAll('-', '');
}

function tracks(value: unknown): Record<string, { ext: unknown; name: unknown }[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([lang, list]) => [
      lang,
      records(list).map((track) => ({ ext: track.ext ?? null, name: track.name ?? null })),
    ]),
  );
}

export function mapVideo(raw: Raw, include: ReadonlySet<InfoInclude>): Mapped {
  const mapped: Mapped = { type: 'video', ...pick(raw, VIDEO_FIELDS) };
  if (include.has('description')) mapped.description = raw.description ?? null;
  if (include.has('tags')) mapped.tags = raw.tags ?? [];
  if (include.has('thumbnails')) {
    mapped.thumbnails = records(raw.thumbnails).map((thumbnail) =>
      pick(thumbnail, ['id', 'url', 'width', 'height']),
    );
  }
  if (include.has('chapters')) {
    mapped.chapters = records(raw.chapters).map((chapter) =>
      pick(chapter, ['start_time', 'end_time', 'title']),
    );
  }
  if (include.has('heatmap')) {
    mapped.heatmap = records(raw.heatmap).map((point) =>
      pick(point, ['start_time', 'end_time', 'value']),
    );
  }
  if (include.has('subtitles')) {
    mapped.subtitles = tracks(raw.subtitles);
    mapped.automatic_captions = tracks(raw.automatic_captions);
  }
  if (include.has('formats')) {
    mapped.formats = records(raw.formats).map((format) => pick(format, FORMAT_FIELDS));
    const requested = records(raw.requested_formats);
    mapped.requested_formats =
      requested.length > 0
        ? requested.map((format) => pick(format, FORMAT_FIELDS))
        : typeof raw.format_id === 'string'
          ? [pick(raw, FORMAT_FIELDS)]
          : [];
  }
  return mapped;
}

export function mapEntry(raw: Raw, index: number): Mapped {
  return {
    index,
    ...pick(raw, ['id', 'title', 'duration', 'url', 'live_status']),
    upload_date: uploadDate(raw),
  };
}

export function mapPlaylist(
  raw: Raw,
  page: { offset: number; limit: number },
  include: ReadonlySet<InfoInclude>,
): Mapped {
  const entries = records(raw.entries);
  const mapped: Mapped = {
    type: 'playlist',
    ...pick(raw, PLAYLIST_FIELDS),
    entries: entries.slice(0, page.limit).map((entry, i) => mapEntry(entry, page.offset + i + 1)),
    // One extra entry was requested: its presence means another page exists.
    next_cursor: entries.length > page.limit ? encodeCursor(page.offset + page.limit) : null,
  };
  if (include.has('description')) mapped.description = raw.description ?? null;
  return mapped;
}

export function isPlaylist(raw: Raw): boolean {
  return raw._type === 'playlist' || Array.isArray(raw.entries);
}

export function mapSearchResult(raw: Raw): Mapped {
  const thumbnails = records(raw.thumbnails);
  return {
    ...pick(raw, [
      'id',
      'title',
      'url',
      'duration',
      'channel',
      'channel_id',
      'uploader',
      'view_count',
      'live_status',
    ]),
    upload_date: uploadDate(raw),
    thumbnail: raw.thumbnail ?? thumbnails.at(-1)?.url ?? null,
  };
}

export function mapComments(raw: Raw, max: number): Mapped {
  return {
    ...pick(raw, ['id', 'title', 'extractor', 'comment_count']),
    comments: records(raw.comments)
      .slice(0, max)
      .map((comment) => ({
        ...pick(comment, COMMENT_FIELDS),
        parent: comment.parent === 'root' || comment.parent === undefined ? null : comment.parent,
      })),
  };
}

const CURSOR_LIMIT = 1_000_000;

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const offset = isRecord(parsed) ? parsed.o : undefined;
    if (
      typeof offset === 'number' &&
      Number.isInteger(offset) &&
      offset >= 0 &&
      offset <= CURSOR_LIMIT
    ) {
      return offset;
    }
  } catch {
    // Falls through to the validation error below.
  }
  throw new AppError('VALIDATION_FAILED', 'The cursor is not valid');
}

export function asRecord(value: unknown): Raw {
  if (!isRecord(value))
    throw new AppError('EXTRACTION_FAILED', 'yt-dlp returned an unexpected document');
  return value;
}
