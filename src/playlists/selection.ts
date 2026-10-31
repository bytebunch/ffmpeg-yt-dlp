import { AppError } from '../common/errors';

/**
 * Playlist item selection (SPEC §7e): "1-20,25,-5" — ranges, single indices, and negative indices
 * counted from the end. Parsed and validated here; yt-dlp only ever sees the server-built `-I`.
 */
export interface Selection {
  /** yt-dlp `-I` value, e.g. "1:20,25,-5". */
  ytdlp: string;
  /** Highest positive index, to bound the expansion; undefined when a negative index needs all. */
  playlistEnd: number | undefined;
}

const PART = /^(-?\d{1,6})(?:-(\d{1,6}))?$/;
const MAX_PARTS = 50;

export function parseSelection(value: string): Selection {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.length > MAX_PARTS || parts.some((part) => part === '')) {
    throw new AppError(
      'VALIDATION_FAILED',
      `items must be up to ${MAX_PARTS} comma-separated indices or ranges`,
    );
  }
  const ytdlp: string[] = [];
  let playlistEnd: number | undefined = 0;
  for (const part of parts) {
    const match = PART.exec(part);
    const start = Number(match?.[1]);
    const end = match?.[2] === undefined ? undefined : Number(match[2]);
    if (!match || start === 0 || (end !== undefined && (start < 1 || end < start))) {
      throw new AppError(
        'VALIDATION_FAILED',
        `"${part}" is not a valid item index or range (e.g. 1-20, 25, -5)`,
      );
    }
    if (start < 0) {
      playlistEnd = undefined;
      ytdlp.push(String(start));
      continue;
    }
    ytdlp.push(end === undefined ? String(start) : `${start}:${end}`);
    if (playlistEnd !== undefined) playlistEnd = Math.max(playlistEnd, end ?? start);
  }
  return { ytdlp: ytdlp.join(','), playlistEnd };
}

const CHANNEL =
  /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)\/?(?:(videos|shorts|streams|playlists|featured|live)\/?)?$/i;

/** Points a YouTube channel URL at the requested tab; other URLs pass through unchanged. */
export function channelTabUrl(url: string, tab: 'videos' | 'shorts' | 'streams'): string {
  const match = CHANNEL.exec(url);
  if (!match?.[1]) return url;
  return `https://www.youtube.com/${match[1]}/${tab}`;
}
