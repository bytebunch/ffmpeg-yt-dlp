import path from 'node:path';

export type OutputRole =
  'media' | 'audio' | 'thumbnail' | 'subtitles' | 'info_json' | 'description' | 'archive';

export interface Classified {
  role: OutputRole;
  mime: string;
}

const VIDEO: Record<string, string> = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ts: 'video/mp2t',
  flv: 'video/x-flv',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
};

const AUDIO: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  aac: 'audio/aac',
  weba: 'audio/webm',
  alac: 'audio/mp4',
};

const IMAGE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

const SUBTITLE: Record<string, string> = {
  vtt: 'text/vtt',
  srt: 'application/x-subrip',
  ass: 'text/x-ssa',
  ssa: 'text/x-ssa',
  lrc: 'text/plain',
  ttml: 'application/ttml+xml',
  json3: 'application/json',
  srv3: 'application/xml',
};

/** Files yt-dlp leaves while working; never delivered. */
const TEMPORARY = /\.(part|ytdl|temp|tmp)$|\.part-Frag\d+|\.f\d+\.\w+$/;

/** The role and MIME type of a finished file, or undefined for files that are not deliverable. */
export function classifyFile(name: string): Classified | undefined {
  const lower = name.toLowerCase();
  if (TEMPORARY.test(lower) || lower.startsWith('.')) return undefined;
  if (lower.endsWith('.info.json')) return { role: 'info_json', mime: 'application/json' };
  if (lower.endsWith('.description'))
    return { role: 'description', mime: 'text/plain; charset=utf-8' };
  const ext = path.extname(lower).slice(1);
  const video = VIDEO[ext];
  if (video) return { role: 'media', mime: video };
  const audio = AUDIO[ext];
  if (audio) return { role: 'audio', mime: audio };
  const image = IMAGE[ext];
  if (image) return { role: 'thumbnail', mime: image };
  const subtitle = SUBTITLE[ext];
  if (subtitle) return { role: 'subtitles', mime: subtitle };
  return undefined;
}
