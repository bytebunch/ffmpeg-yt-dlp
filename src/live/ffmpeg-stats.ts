/** What a live recording through ffmpeg has written so far. */
export interface FfmpegStats {
  bytes: number;
  recordedS: number;
  bytesPerSecond: number | null;
}

const UNITS: Record<string, number> = {
  B: 1,
  kB: 1000,
  KiB: 1024,
  MB: 1_000_000,
  MiB: 1024 * 1024,
  GiB: 1024 ** 3,
};
const STATS =
  /L?size=\s*(\d+(?:\.\d+)?)(B|kB|KiB|MB|MiB|GiB)\s+time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\s+bitrate=\s*(?:(\d+(?:\.\d+)?)kbits\/s|N\/A)/;

/**
 * yt-dlp hands live HLS to ffmpeg, which reports `size=… time=… bitrate=…` on stderr instead of
 * yt-dlp's progress template; lines are \r-separated, so callers split on \r first.
 */
export function parseFfmpegStats(line: string): FfmpegStats | undefined {
  const match = STATS.exec(line);
  if (!match) return undefined;
  const [, size = '0', unit = 'B', hours = '0', minutes = '0', seconds = '0', kbits] = match;
  return {
    bytes: Math.round(Number(size) * (UNITS[unit] ?? 1)),
    // ffmpeg prints centiseconds; rounding drops the float noise of the sum.
    recordedS:
      Math.round((Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 100) / 100,
    bytesPerSecond: kbits === undefined ? null : (Number(kbits) * 1000) / 8,
  };
}

/** ffmpeg's per-connection lines: noise in a job log, and they carry signed CDN URLs. */
export function isTransportNoise(line: string): boolean {
  return /^\[(?:https?|hls|tcp|tls|dash) @ 0x[0-9a-f]+\]/.test(line);
}
