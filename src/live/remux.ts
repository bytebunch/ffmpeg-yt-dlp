/** Containers a recording is remuxed to (SPEC §7d), with their output MIME types. */
export const RECORD_CONTAINERS = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
} as const;
export type RecordContainer = keyof typeof RECORD_CONTAINERS;

const MUXERS: Record<RecordContainer, string> = { mp4: 'mp4', mkv: 'matroska', mov: 'mov' };

/**
 * ffmpeg arguments that remux an MPEG-TS recording without re-encoding: video and audio only
 * (HLS carries timed ID3 data MP4 cannot hold), faststart for MP4/MOV, and with `splitSeconds`
 * one file per segment, each starting at 0. `output` is a path; when splitting it must contain
 * `%03d`.
 */
export function remuxArgs(
  input: string,
  output: string,
  container: RecordContainer,
  splitSeconds?: number,
): string[] {
  const faststart = container === 'mkv' ? [] : ['-movflags', '+faststart'];
  const muxer =
    splitSeconds === undefined
      ? ['-f', MUXERS[container], ...faststart]
      : [
          '-f',
          'segment',
          '-segment_time',
          String(splitSeconds),
          '-reset_timestamps',
          '1',
          '-segment_format',
          MUXERS[container],
          ...(container === 'mkv' ? [] : ['-segment_format_options', 'movflags=+faststart']),
        ];
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-protocol_whitelist',
    'file',
    '-i',
    input,
    '-map',
    '0:v?',
    '-map',
    '0:a?',
    '-c',
    'copy',
    ...muxer,
    output,
  ];
}

/** `--wait-for-video` takes seconds: "min" or "min-max". */
export function waitArgs(
  wait: { min_minutes: number; max_minutes?: number | undefined } | undefined,
): string[] {
  if (!wait) return [];
  const min = wait.min_minutes * 60;
  const max = (wait.max_minutes ?? wait.min_minutes) * 60;
  return ['--wait-for-video', max > min ? `${min}-${max}` : String(min)];
}
