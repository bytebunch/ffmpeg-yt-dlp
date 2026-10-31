import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import type { ProbeSummary, StreamSummary } from '../../../src/media/ffprobe';
import {
  type ComposeOptions,
  compose,
  type Composition,
  type Stage,
} from '../../../src/recipes/compose';
import { atempoChain } from '../../../src/recipes/ops/audio';
import { parseRecipe } from '../../../src/recipes/validate';

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
};
const OPTIONS: ComposeOptions = {
  workDir: '/work/job',
  threads: 4,
  maxFileBytes: 1024 * 1024 * 1024,
  limits: {
    REVERSE_MAX_SECONDS: 60,
    INTERPOLATE_MAX_SECONDS: 120,
    GIF_MAX_SECONDS: 30,
    MAX_MEDIA_DURATION_MINUTES: 240,
  },
  measurements: {},
};
const stream = (values: Partial<StreamSummary>): StreamSummary => ({
  type: 'video',
  codec: 'h264',
  width: 1280,
  height: 720,
  fps: 25,
  channels: null,
  sample_rate: null,
  bit_rate: null,
  language: null,
  attached_pic: false,
  color_transfer: null,
  ...values,
});
const PROBE: ProbeSummary = {
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration_s: 60,
  size_bytes: 1,
  bit_rate: 1,
  streams: [stream({}), stream({ type: 'audio', codec: 'aac', channels: 2, sample_rate: 44_100 })],
};
const mp4 = { op: 'encode', container: 'mp4' };

function composeSteps(
  steps: unknown[],
  measurements: Record<string, unknown> = {},
  probe = PROBE,
): Composition {
  return compose(parseRecipe({ steps }, LIMITS), [{ path: '/in.mp4', probe }], {
    ...OPTIONS,
    measurements,
  });
}
function graph(steps: unknown[], measurements: Record<string, unknown> = {}): string {
  const result = composeSteps(steps, measurements);
  if (result.kind !== 'plan') throw new Error(`needs ${result.stage.label}`);
  const args = result.plan.stages.at(-1)?.args ?? [];
  return args[args.indexOf('-filter_complex') + 1] ?? '';
}
function measurementOf(steps: unknown[], measurements: Record<string, unknown> = {}): Stage {
  const result = composeSteps(steps, measurements);
  if (result.kind !== 'measure') throw new Error('expected a measurement');
  return result.stage;
}
function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('visual operations', () => {
  it('builds one eq filter from several colour settings, in a fixed order', () => {
    expect(
      graph([{ op: 'color', contrast: 1.2, brightness: 0.1, grayscale: true }, mp4]),
    ).toContain('eq=brightness=0.1:contrast=1.2,hue=s=0');
    expect(errorOf(() => graph([{ op: 'color' }, mp4])).message).toMatch(/at least one adjustment/);
    expect(errorOf(() => graph([{ op: 'color', lut3d: { input: 1 } }, mp4])).message).toMatch(
      /\.cube/,
    );
  });

  it('processes regions on a copy and lays them back with a time window', () => {
    const text = graph([{ op: 'region_blur', x: 0, y: 0, w: 200, h: 100, start: 2, end: 5 }, mp4]);
    expect(text).toContain('crop=200:100:0:0,boxblur=10');
    expect(text).toContain("overlay=0:0:enable='between(t,2,5)'");
    expect(
      errorOf(() => graph([{ op: 'region_pixelate', x: 1200, y: 0, w: 200, h: 100 }, mp4])).message,
    ).toMatch(/outside the 1280x720/);
  });

  it('stabilises with a detection pass writing into the job directory', () => {
    const stage = measurementOf([{ op: 'stabilize' }, mp4]);
    expect(stage.measure).toEqual({ key: 'vidstab:0', kind: 'vidstab' });
    expect(stage.args.join(' ')).toContain(
      'vidstabdetect=shakiness=5:accuracy=15:result=/work/job/stabilize-0.trf',
    );
    expect(graph([{ op: 'stabilize' }, mp4], { 'vidstab:0': true })).toContain(
      'vidstabtransform=input=/work/job/stabilize-0.trf:smoothing=15',
    );
  });

  it('refuses tonemapping SDR video', () => {
    expect(errorOf(() => graph([{ op: 'tonemap' }, mp4])).message).toMatch(/needs HDR/);
  });
});

describe('audio operations', () => {
  it('measures loudness first, then runs a linear second pass', () => {
    const steps = [{ op: 'normalize_loudness', target_lufs: -14 }, mp4];
    expect(measurementOf(steps).args.join(' ')).toContain(
      'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
    );
    const figures = {
      input_i: '-27.1',
      input_tp: '-9.2',
      input_lra: '6.1',
      input_thresh: '-37.4',
      target_offset: '0.3',
    };
    const text = graph(steps, { 'loudnorm:0': figures });
    expect(text).toContain(
      'measured_I=-27.1:measured_TP=-9.2:measured_LRA=6.1:measured_thresh=-37.4:offset=0.3:linear=true',
    );
    // Back to the input's sample rate after loudnorm's 192 kHz.
    expect(text).toContain('aresample=44100');
    expect(
      errorOf(() => graph(steps, { 'loudnorm:0': { ...figures, input_i: '-inf' } })).message,
    ).toMatch(/silent/);
  });

  it('sets gain directly or from a measured peak', () => {
    expect(graph([{ op: 'gain', db: -6 }, mp4])).toContain('volume=-6dB');
    expect(graph([{ op: 'gain', to_peak_dbfs: -1 }, mp4], { 'peak:0': -7.5 })).toContain(
      'volume=6.5dB',
    );
    expect(errorOf(() => graph([{ op: 'gain' }, mp4])).message).toMatch(/db or to_peak_dbfs/);
  });

  it('trims the measured silence at both ends', () => {
    const silences = [
      { start_s: 0, end_s: 2.5 },
      { start_s: 30, end_s: 31 },
      { start_s: 55, end_s: 60 },
    ];
    expect(graph([{ op: 'silence_trim' }, mp4], { 'silence:0': silences })).toContain(
      'atrim=start=2.5:end=55',
    );
    expect(graph([{ op: 'silence_trim', start: false }, mp4], { 'silence:0': silences })).toContain(
      'atrim=start=0:end=55',
    );
    expect(
      errorOf(() =>
        graph([{ op: 'silence_trim' }, mp4], { 'silence:0': [{ start_s: 0, end_s: 60 }] }),
      ).message,
    ).toMatch(/silent from start to end/);
  });

  it('converts compressor and limiter levels from dB to linear', () => {
    expect(graph([{ op: 'compress', threshold_db: -20, ratio: 4, makeup_db: 6 }, mp4])).toContain(
      'acompressor=threshold=0.1:ratio=4:attack=10:release=200:makeup=1.995262',
    );
    expect(graph([{ op: 'limiter', ceiling_dbtp: -6 }, mp4])).toContain('alimiter=limit=0.501187');
  });

  it('chains atempo for factors outside 0.5–2', () => {
    expect(atempoChain(4)).toEqual(['atempo=2', 'atempo=2']);
    expect(atempoChain(0.3)).toEqual(['atempo=0.5', 'atempo=0.6']);
    expect(atempoChain(1.25)).toEqual(['atempo=1.25']);
  });

  it('checks operation parameters', () => {
    expect(errorOf(() => graph([{ op: 'eq' }, mp4])).message).toMatch(/preset or bands/);
    expect(
      errorOf(() => graph([{ op: 'echo', delay_ms: [100, 200], decay: [0.5] }, mp4])).message,
    ).toMatch(/same length/);
    expect(errorOf(() => graph([{ op: 'silence_pad' }, mp4])).message).toMatch(/start_s or end_s/);
    expect(
      errorOf(() => graph([{ op: 'pitch', semitones: 2, preserve_tempo: false }, mp4])).message,
    ).toMatch(/audio-only/);
    expect(
      errorOf(() => graph([{ op: 'remove_audio' }, { op: 'remove_audio' }, mp4])).message,
    ).toMatch(/needs an audio stream/);
  });

  it('adds -shortest after trim_to_shortest', () => {
    const result = composeSteps([{ op: 'trim_to_shortest' }, mp4]);
    expect(result.kind === 'plan' && result.plan.stages[0]?.args).toContain('-shortest');
  });
});
