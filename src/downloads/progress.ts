import { POSTPROCESS_MARKER, PROGRESS_MARKER } from './args';

export interface Progress {
  stage: 'downloading' | 'postprocessing';
  percent: number | null;
  bytes: number | null;
  total_bytes: number | null;
  speed: number | null;
  eta: number | null;
  fragment: { index: number; count: number } | null;
  postprocessor: string | null;
}

const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Reads one stdout line. yt-dlp prints `%(progress)j` after our markers (args.ts); anything
 * else on stdout is ignored.
 */
export function parseProgressLine(line: string): Progress | undefined {
  const downloading = line.startsWith(PROGRESS_MARKER);
  if (!downloading && !line.startsWith(POSTPROCESS_MARKER)) return undefined;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      line.slice((downloading ? PROGRESS_MARKER : POSTPROCESS_MARKER).length),
    );
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    data = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!downloading) {
    return {
      stage: 'postprocessing',
      percent: null,
      bytes: null,
      total_bytes: null,
      speed: null,
      eta: null,
      fragment: null,
      postprocessor: typeof data.postprocessor === 'string' ? data.postprocessor : null,
    };
  }
  const bytes = number(data.downloaded_bytes);
  const total = number(data.total_bytes) ?? number(data.total_bytes_estimate);
  const fragmentIndex = number(data.fragment_index);
  const fragmentCount = number(data.fragment_count);
  const percent =
    data.status === 'finished'
      ? 100
      : bytes !== null && total !== null && total > 0
        ? Math.min(100, Math.round((bytes / total) * 1000) / 10)
        : null;
  return {
    stage: 'downloading',
    percent,
    bytes,
    total_bytes: total,
    speed: number(data.speed),
    eta: number(data.eta),
    fragment:
      fragmentIndex !== null && fragmentCount !== null
        ? { index: fragmentIndex, count: fragmentCount }
        : null,
    postprocessor: null,
  };
}
