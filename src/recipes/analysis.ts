import type { AnalysisKind } from './compose';
import type { MeasureKind } from './context';

/**
 * A filter's log line: "[Parsed_silencedetect_6 @ 0x55d0] silence_start: 2.02", or with an
 * instance name, "[showinfo@all @ 0x55d0] …".
 */
const FILTER_LINE =
  /^\[(?:Parsed_([a-z0-9_]+?)_\d+|([a-z0-9_]+)@[a-z0-9_]+) @ 0x[0-9a-f]+\] ?(.*)$/;

export interface FilterLog {
  filter: string;
  text: string;
}

/**
 * Collects filter log lines from ffmpeg's stderr. loudnorm prints its JSON on the lines after its
 * prefixed line, so those lines are attached to it until the closing brace.
 */
export class FilterLogCollector {
  readonly lines: FilterLog[] = [];
  private block: { filter: string; text: string[] } | undefined;

  push(line: string): void {
    if (this.block) {
      this.block.text.push(line);
      if (line.trim() === '}') {
        this.lines.push({ filter: this.block.filter, text: this.block.text.join('\n') });
        this.block = undefined;
      }
      return;
    }
    const match = FILTER_LINE.exec(line);
    const filter = match?.[1] ?? match?.[2];
    if (!match || !filter) return;
    const text = match[3] ?? '';
    if (filter === 'loudnorm' && text.trim() === '') this.block = { filter, text: [] };
    else this.lines.push({ filter, text });
  }

  of(filter: string): string[] {
    return this.lines.filter((line) => line.filter === filter).map((line) => line.text);
  }
}

const number = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function field(text: string, name: string): number | null {
  return number(new RegExp(`${name}:\\s*(-?[\\d.]+|-?inf)`).exec(text)?.[1]);
}

/** loudnorm's JSON block as printed (all values are strings). */
export function loudnormFigures(log: FilterLogCollector): Record<string, string> | null {
  const block = log.of('loudnorm').at(-1);
  return block ? (JSON.parse(block) as Record<string, string>) : null;
}

export function loudnessReport(log: FilterLogCollector) {
  const json = loudnormFigures(log);
  if (!json) return null;
  return {
    integrated_lufs: number(json.input_i),
    true_peak_dbtp: number(json.input_tp),
    lra_lu: number(json.input_lra),
    threshold_lufs: number(json.input_thresh),
  };
}

export function volumeReport(log: FilterLogCollector) {
  // An early graph probe logs "n_samples: 0"; the real figures come last.
  const lines = log.of('volumedetect');
  const last = (name: string) =>
    [...lines]
      .reverse()
      .map((text) => field(text, name))
      .find((value) => value !== null) ?? null;
  const histogram: Record<string, number> = {};
  for (const text of lines) {
    const match = /^histogram_(\d+)db:\s*(\d+)/.exec(text);
    if (match?.[1] && match[2]) histogram[`-${match[1]}`] = Number(match[2]);
  }
  return {
    mean_volume_db: last('mean_volume'),
    max_volume_db: last('max_volume'),
    samples: last('n_samples'),
    histogram_db: histogram,
  };
}

export function silenceReport(log: FilterLogCollector, durationS: number | null) {
  const silences: { start_s: number; end_s: number | null; duration_s: number | null }[] = [];
  for (const text of log.of('silencedetect')) {
    const start = field(text, 'silence_start');
    if (start !== null) silences.push({ start_s: start, end_s: null, duration_s: null });
    const end = field(text, 'silence_end');
    const open = silences.at(-1);
    if (end !== null && open?.end_s === null) {
      open.end_s = end;
      open.duration_s = field(text, 'silence_duration');
    }
  }
  // Silence running to the end is reported without an end line.
  for (const silence of silences) {
    if (silence.end_s === null && durationS !== null) {
      silence.end_s = durationS;
      silence.duration_s = Math.round((durationS - silence.start_s) * 1000) / 1000;
    }
  }
  return {
    silences,
    total_silence_s:
      Math.round(silences.reduce((sum, item) => sum + (item.duration_s ?? 0), 0) * 1000) / 1000,
  };
}

export function blackReport(log: FilterLogCollector) {
  const intervals = log.of('blackdetect').flatMap((text) => {
    const start = field(text, 'black_start');
    const end = field(text, 'black_end');
    return start === null || end === null
      ? []
      : [{ start_s: start, end_s: end, duration_s: field(text, 'black_duration') }];
  });
  return { intervals };
}

export function sceneReport(log: FilterLogCollector) {
  const scenes = log.of('scdet').flatMap((text) => {
    const score = number(/lavfi\.scd\.score:\s*([\d.]+)/.exec(text)?.[1]);
    const time = number(/lavfi\.scd\.time:\s*([\d.]+)/.exec(text)?.[1]);
    return score === null || time === null
      ? []
      : [{ time_s: time, score: Math.round(score * 10) / 1000 }];
  });
  return { scenes };
}

/** cropdetect's last line holds the crop that covers every frame seen ("crop=1920:800:0:140"). */
export function cropMeasurement(
  log: FilterLogCollector,
): { w: number; h: number; x: number; y: number } | null {
  const text = log.of('cropdetect').at(-1);
  const match = text ? /crop=(\d+):(\d+):(\d+):(\d+)/.exec(text) : null;
  if (!match) return null;
  const [w, h, x, y] = match.slice(1).map(Number);
  if (!w || !h || x === undefined || y === undefined) return null;
  return { w, h, x, y };
}

/** The value a measurement stage hands back to the composer (null: nothing found). */
export function measurement(
  kind: MeasureKind,
  log: FilterLogCollector,
  durationS: number | null,
): unknown {
  switch (kind) {
    case 'crop':
      return cropMeasurement(log);
    case 'peak':
      return volumeReport(log).max_volume_db;
    case 'loudnorm':
      return loudnormFigures(log);
    case 'silence':
      return silenceReport(log, durationS).silences;
    case 'scenes':
      return sceneReport(log).scenes.map((scene) => scene.time_s);
    case 'vidstab':
      // The transforms file is the result; it sits in the job directory.
      return true;
  }
}

export function freezeReport(log: FilterLogCollector) {
  const freezes: { start_s: number; end_s: number | null; duration_s: number | null }[] = [];
  for (const text of log.of('freezedetect')) {
    const start = number(/freeze_start:\s*([\d.]+)/.exec(text)?.[1]);
    if (start !== null) freezes.push({ start_s: start, end_s: null, duration_s: null });
    const open = freezes.at(-1);
    const duration = number(/freeze_duration:\s*([\d.]+)/.exec(text)?.[1]);
    const end = number(/freeze_end:\s*([\d.]+)/.exec(text)?.[1]);
    if (open && duration !== null) open.duration_s = duration;
    if (open && end !== null) open.end_s = end;
  }
  return { freezes };
}

export function interlaceReport(log: FilterLogCollector) {
  const line =
    log
      .of('idet')
      .filter((text) => text.startsWith('Multi frame detection'))
      .at(-1) ?? '';
  const count = (name: string) => number(new RegExp(`${name}:\\s*(\\d+)`).exec(line)?.[1]) ?? 0;
  const counts = {
    tff: count('TFF'),
    bff: count('BFF'),
    progressive: count('Progressive'),
    undetermined: count('Undetermined'),
  };
  // Interlaced material keeps one field order; motion in progressive video makes idet report
  // both orders about equally (seen on real ffmpeg), so one order has to dominate.
  const dominant = Math.max(counts.tff, counts.bff);
  const other = Math.min(counts.tff, counts.bff);
  const verdict =
    dominant === 0 && counts.progressive === 0
      ? 'unknown'
      : dominant > counts.progressive && dominant >= 3 * other
        ? counts.tff >= counts.bff
          ? 'interlaced_tff'
          : 'interlaced_bff'
        : 'progressive';
  return { verdict, frames: counts };
}

export function analysisReport(
  kind: AnalysisKind,
  log: FilterLogCollector,
  durationS: number | null,
): unknown {
  switch (kind) {
    case 'freeze_detect':
      return freezeReport(log);
    case 'crop_detect': {
      const crop = cropMeasurement(log);
      return { crop, filter: crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` : null };
    }
    case 'interlace_detect':
      return interlaceReport(log);
    case 'loudness':
      return loudnessReport(log);
    case 'volume':
      return volumeReport(log);
    case 'silence_detect':
      return silenceReport(log, durationS);
    case 'black_detect':
      return blackReport(log);
    case 'scene_changes':
      return sceneReport(log);
  }
}

/** keyframes report from ffprobe packet CSV lines "pts_time,pos,flags". */
export function keyframesReport(lines: readonly string[], max: number) {
  const keyframes: { time_s: number; pos: number | null }[] = [];
  let truncated = false;
  for (const line of lines) {
    const [time, pos, flags] = line.split(',');
    if (!flags?.includes('K')) continue;
    const timeS = number(time);
    if (timeS === null) continue;
    if (keyframes.length >= max) {
      truncated = true;
      break;
    }
    keyframes.push({ time_s: timeS, pos: number(pos) });
  }
  const gaps = keyframes.slice(1).map((frame, i) => frame.time_s - (keyframes[i]?.time_s ?? 0));
  return {
    count: keyframes.length,
    truncated,
    max_interval_s: gaps.length > 0 ? Math.round(Math.max(...gaps) * 1000) / 1000 : null,
    keyframes,
  };
}

/** The full ffprobe document without the server-side file path. */
export function probeReport(stdout: string): unknown {
  const document = JSON.parse(stdout) as { format?: Record<string, unknown> };
  if (document.format) delete document.format.filename;
  return document;
}

const lines = (text: string) => text.split('\n').filter((line) => line.trim() !== '');
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const average = (values: number[]) =>
  values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);

/** psnr stats_file: "n:1 mse_avg:… psnr_avg:42.1 …"; ssim: "n:1 Y:… All:0.987 (18.9)". */
function statsSeries(text: string, key: RegExp): number[] {
  return lines(text).flatMap((line) => {
    const match = key.exec(line)?.[1];
    if (match === undefined) return [];
    // Identical frames have infinite PSNR; 100 dB stands in for it.
    return [match === 'inf' ? 100 : Number(match)].filter((value) => Number.isFinite(value));
  });
}

function qualityReport(contents: string[], metrics: string[]) {
  const report: Record<string, unknown> = {};
  metrics.forEach((metric, i) => {
    const text = contents[i] ?? '';
    if (metric === 'vmaf') {
      const json = JSON.parse(text || '{}') as {
        pooled_metrics?: { vmaf?: Record<string, number> };
        frames?: { metrics?: { vmaf?: number } }[];
      };
      const pooled = json.pooled_metrics?.vmaf ?? {};
      const pick = (key: string) => (pooled[key] === undefined ? null : round(pooled[key]));
      report.vmaf = {
        mean: pick('mean'),
        min: pick('min'),
        max: pick('max'),
        harmonic_mean: pick('harmonic_mean'),
        frames: (json.frames ?? [])
          .slice(0, 10_000)
          .map((frame) => round(frame.metrics?.vmaf ?? 0)),
      };
      return;
    }
    const series = statsSeries(
      text,
      metric === 'psnr' ? /psnr_avg:(-?[\d.]+|inf)/ : /All:([\d.]+)/,
    );
    report[metric] = {
      mean: average(series),
      min: series.length > 0 ? round(Math.min(...series)) : null,
      frames: series.slice(0, 10_000).map((value) => round(value)),
    };
  });
  return report;
}

/** "SHA256=…" (hash) or "0,v,SHA256=…" per stream (streamhash). */
function hashReport(text: string, algorithm: string) {
  const entries = lines(text).map((line) => {
    const [first = '', second, third] = line.split(',');
    const value = (third ?? first).split('=')[1] ?? '';
    return third === undefined
      ? { stream: null, type: null, hash: value }
      : { stream: Number(first), type: second ?? null, hash: value };
  });
  const [single] = entries;
  return entries.length === 1 && single?.stream === null
    ? { algorithm, hash: single.hash }
    : { algorithm, streams: entries };
}

/** framehash: "#…" header lines, then "stream, dts, pts, duration, size, hash". */
function frameHashesReport(text: string, max: number) {
  const frames = lines(text)
    .filter((line) => !line.startsWith('#'))
    .slice(0, max)
    .map((line) => {
      const parts = line.split(',').map((part) => part.trim());
      return { stream: Number(parts[0]), pts: Number(parts[2]), hash: parts[5] ?? '' };
    });
  return { count: frames.length, frames };
}

/** ametadata print: "lavfi.astats.Overall.Peak_level=-12.3" per window → 0–1 linear peaks. */
function peaksReport(text: string, perSecond: number) {
  const peaks = lines(text).flatMap((line) => {
    const match = /Peak_level=(-?[\d.]+|-inf)/.exec(line)?.[1];
    if (match === undefined) return [];
    const db = Number(match);
    return [Number.isFinite(db) ? round(Math.min(1, 10 ** (db / 20))) : 0];
  });
  return { per_second: perSecond, peaks };
}

const framesIn = (text: string) => lines(text).filter((line) => line.startsWith('frame:')).length;

/** Reports read from files written during the main pass. */
export function fileReport(
  kind: string,
  contents: string[],
  meta: Record<string, unknown> = {},
): unknown {
  switch (kind) {
    case 'duplicate_frames': {
      const total = framesIn(contents[0] ?? '');
      const unique = framesIn(contents[1] ?? '');
      return {
        total_frames: total,
        unique_frames: unique,
        duplicate_frames: total - unique,
        duplicate_ratio: total > 0 ? round((total - unique) / total) : 0,
      };
    }
    case 'quality_compare':
      return qualityReport(contents, (meta.metrics as string[] | undefined) ?? []);
    case 'hash':
      return hashReport(
        contents[0] ?? '',
        typeof meta.algorithm === 'string' ? meta.algorithm : '',
      );
    case 'frame_hashes':
      return frameHashesReport(contents[0] ?? '', Number(meta.max ?? 2000));
    case 'peaks':
      return peaksReport(contents[0] ?? '', Number(meta.per_second ?? 10));
    default:
      throw new Error(`Unknown file report ${kind}`);
  }
}

/** Packet sizes "pts_time,size" summed per window → kbps over time. */
export function bitrateReport(packetLines: readonly string[], windowS: number) {
  const buckets = new Map<number, number>();
  for (const line of packetLines) {
    const [time, size] = line.split(',').map(Number);
    if (
      time === undefined ||
      size === undefined ||
      !Number.isFinite(time) ||
      !Number.isFinite(size)
    )
      continue;
    const bucket = Math.floor(time / windowS);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + size);
  }
  const points = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucket, bytes]) => ({
      time_s: round(bucket * windowS),
      kbps: round((bytes * 8) / 1000 / windowS, 1),
    }));
  const values = points.map((point) => point.kbps);
  return {
    window_s: windowS,
    average_kbps: average(values),
    peak_kbps: values.length > 0 ? Math.max(...values) : null,
    points: points.slice(0, 100_000),
  };
}
