import { execa } from 'execa';

export interface StreamSummary {
  type: string | null;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  channels: number | null;
  sample_rate: number | null;
  bit_rate: number | null;
  language: string | null;
  /** Cover art stored as a video stream. */
  attached_pic: boolean;
  /** Transfer characteristic, e.g. smpte2084 (HDR10/PQ) or arib-std-b67 (HLG). */
  color_transfer: string | null;
}

export interface ProbeSummary {
  format: string | null;
  /** Chapters, when the container has them (split by_chapters). */
  chapters?: { start_s: number; end_s: number; title: string | null }[];
  duration_s: number | null;
  size_bytes: number | null;
  bit_rate: number | null;
  streams: StreamSummary[];
}

type Raw = Record<string, unknown>;

const num = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** `30000/1001` → 29.97 */
export function frameRate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return null;
  return Math.round((numerator / denominator) * 100) / 100;
}

/** The parts of ffprobe's JSON that clients need (SPEC §10 "probe summary"). */
export function summarizeProbe(raw: unknown): ProbeSummary {
  const document = (typeof raw === 'object' && raw !== null ? raw : {}) as Raw;
  const format = (document.format ?? {}) as Raw;
  const streams = Array.isArray(document.streams) ? (document.streams as Raw[]) : [];
  const chapters = Array.isArray(document.chapters) ? (document.chapters as Raw[]) : [];
  return {
    format: str(format.format_name),
    chapters: chapters.flatMap((chapter) => {
      const start = num(chapter.start_time);
      const end = num(chapter.end_time);
      const tags = (chapter.tags ?? {}) as Raw;
      return start === null || end === null
        ? []
        : [{ start_s: start, end_s: end, title: str(tags.title) }];
    }),
    duration_s: num(format.duration),
    size_bytes: num(format.size),
    bit_rate: num(format.bit_rate),
    streams: streams.map((stream) => {
      const tags = (stream.tags ?? {}) as Raw;
      const disposition = (stream.disposition ?? {}) as Raw;
      return {
        type: str(stream.codec_type),
        codec: str(stream.codec_name),
        width: num(stream.width),
        height: num(stream.height),
        fps: stream.codec_type === 'video' ? frameRate(stream.avg_frame_rate) : null,
        channels: num(stream.channels),
        sample_rate: num(stream.sample_rate),
        bit_rate: num(stream.bit_rate),
        language: str(tags.language),
        attached_pic: disposition.attached_pic === 1,
        color_transfer: str(stream.color_transfer),
      };
    }),
  };
}

/** Container formats accepted as inputs (SPEC §5); hls, dash, concat, lavfi, … are refused. */
const ALLOWED_FORMATS = new Set([
  'mov',
  'mp4',
  'm4a',
  '3gp',
  '3g2',
  'mj2',
  'matroska',
  'webm',
  'mp3',
  'ogg',
  'flac',
  'wav',
  'aiff',
  'aac',
  'mpegts',
  'mpeg',
  'avi',
  'flv',
  'asf',
  'image2',
  'png_pipe',
  'webp_pipe',
  'gif',
  'mjpeg',
  'jpeg_pipe',
  'srt',
  'webvtt',
  'ass',
]);

/** ffprobe reports e.g. "mov,mp4,m4a,3gp,3g2,mj2"; one allowed name is enough. */
export function isAllowedFormat(format: string | null): boolean {
  return (format ?? '').split(',').some((name) => ALLOWED_FORMATS.has(name.trim()));
}

/**
 * Probes a local file the service placed on disk; the path is absolute, never caller-supplied.
 * `-protocol_whitelist file,crypto` stops a crafted playlist inside the file from making ffprobe
 * open network or other protocols.
 */
export async function ffprobe(
  bin: string,
  file: string,
  timeoutMs = 60_000,
): Promise<ProbeSummary> {
  const { stdout } = await execa(
    bin,
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,crypto',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      '-i',
      file,
    ],
    {
      timeout: timeoutMs,
      extendEnv: false,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdin: 'ignore',
    },
  );
  return summarizeProbe(JSON.parse(stdout) as unknown);
}
