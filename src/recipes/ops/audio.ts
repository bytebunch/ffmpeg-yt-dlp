import { z } from 'zod';

import { type FilterContext, invalid, linear } from '../context';
import { num } from '../graph';

/** Audio operations (SPEC §8g) on the working audio stream. */

const frequency = z.number().min(10).max(20_000);
const level = (min: number, max: number) => z.number().min(min).max(max);

export const COMPRESS_PRESETS = {
  light: { threshold_db: -18, ratio: 2, attack_ms: 20, release_ms: 250, makeup_db: 2 },
  medium: { threshold_db: -20, ratio: 4, attack_ms: 10, release_ms: 200, makeup_db: 4 },
  heavy: { threshold_db: -24, ratio: 8, attack_ms: 5, release_ms: 150, makeup_db: 6 },
  voice: { threshold_db: -21, ratio: 3, attack_ms: 5, release_ms: 120, makeup_db: 4 },
  broadcast: { threshold_db: -16, ratio: 6, attack_ms: 2, release_ms: 100, makeup_db: 3 },
} as const;

const EQ_PRESETS = {
  bass_boost: ['bass=g=6:f=100'],
  treble_boost: ['treble=g=4:f=4000'],
  voice: ['highpass=f=100', 'equalizer=f=3000:t=q:w=1:g=3'],
  podcast: ['highpass=f=80', 'equalizer=f=200:t=q:w=1:g=-2', 'equalizer=f=3000:t=q:w=1.2:g=3'],
  loudness: ['bass=g=4:f=100', 'treble=g=3:f=6000'],
  flat: ['anull'],
} as const;

const CHANNELS = {
  mono: ['pan=mono|c0=0.5*c0+0.5*c1'],
  stereo: ['aformat=channel_layouts=stereo'],
  downmix_surround: ['pan=stereo|FL=FC+0.30*FL+0.30*BL|FR=FC+0.30*FR+0.30*BR'],
  swap: ['pan=stereo|c0=c1|c1=c0'],
  left_only: ['pan=stereo|c0=c0|c1=c0'],
  right_only: ['pan=stereo|c0=c1|c1=c1'],
  surround_5_1: ['surround=chl_out=5.1'],
} as const;

export const audioSchemas = [
  z.strictObject({
    op: z.literal('gain'),
    db: level(-60, 30).optional(),
    to_peak_dbfs: level(-30, 0).optional(),
  }),
  z.strictObject({
    op: z.literal('normalize_loudness'),
    target_lufs: level(-30, -5).default(-16),
    true_peak_dbtp: level(-9, 0).default(-1.5),
    lra: level(1, 20).default(11),
    mode: z.enum(['two_pass', 'dynamic']).default('two_pass'),
  }),
  z.strictObject({
    op: z.literal('compress'),
    preset: z.enum(Object.keys(COMPRESS_PRESETS) as [keyof typeof COMPRESS_PRESETS]).optional(),
    threshold_db: level(-60, 0).optional(),
    ratio: level(1, 20).optional(),
    attack_ms: level(0.01, 2000).optional(),
    release_ms: level(0.01, 9000).optional(),
    makeup_db: level(0, 36).optional(),
  }),
  z.strictObject({ op: z.literal('limiter'), ceiling_dbtp: level(-24, 0).default(-1) }),
  z.strictObject({
    op: z.literal('silence_trim'),
    start: z.boolean().default(true),
    end: z.boolean().default(true),
    threshold_db: level(-90, -10).default(-50),
    min_silence_s: level(0.05, 30).default(0.5),
  }),
  z.strictObject({
    op: z.literal('channels'),
    layout: z.enum(Object.keys(CHANNELS) as [keyof typeof CHANNELS]),
  }),
  z.strictObject({
    op: z.literal('pitch'),
    semitones: level(-12, 12),
    preserve_tempo: z.boolean().default(true),
  }),
  z.strictObject({ op: z.literal('tempo'), factor: level(0.5, 2) }),
  z.strictObject({
    op: z.literal('eq'),
    preset: z.enum(Object.keys(EQ_PRESETS) as [keyof typeof EQ_PRESETS]).optional(),
    bands: z
      .array(
        z.strictObject({
          freq_hz: frequency,
          width_hz: z.number().min(1).max(10_000),
          gain_db: level(-30, 30),
        }),
      )
      .min(1)
      .max(10)
      .optional(),
  }),
  z.strictObject({
    op: z.literal('bass'),
    gain_db: level(-20, 20),
    freq_hz: frequency.default(100),
  }),
  z.strictObject({
    op: z.literal('treble'),
    gain_db: level(-20, 20),
    freq_hz: frequency.default(3000),
  }),
  z.strictObject({
    op: z.literal('highpass'),
    freq_hz: frequency,
    poles: z.union([z.literal(1), z.literal(2)]).default(2),
  }),
  z.strictObject({
    op: z.literal('lowpass'),
    freq_hz: frequency,
    poles: z.union([z.literal(1), z.literal(2)]).default(2),
  }),
  z.strictObject({
    op: z.literal('bandpass'),
    freq_hz: frequency,
    width_hz: z.number().min(1).max(10_000).default(1000),
  }),
  z.strictObject({
    op: z.literal('remove_hum'),
    freq_hz: z.union([z.literal(50), z.literal(60)]),
    harmonics: z.number().int().min(1).max(4).default(3),
  }),
  z.strictObject({
    op: z.literal('denoise_audio'),
    strength: z.enum(['light', 'medium', 'strong']).default('medium'),
    method: z.enum(['afftdn', 'anlmdn']).default('afftdn'),
  }),
  z.strictObject({ op: z.literal('deesser'), intensity: level(0, 1).default(0.5) }),
  z.strictObject({
    op: z.literal('echo'),
    delay_ms: z.array(z.number().min(1).max(5000)).min(1).max(4),
    decay: z.array(z.number().min(0.01).max(1)).min(1).max(4),
  }),
  z.strictObject({ op: z.literal('stereo_width'), amount: level(0, 2) }),
  z.strictObject({ op: z.literal('vocal_reduce'), strength: level(0, 1).default(1) }),
  z.strictObject({
    op: z.literal('resample'),
    rate: z.union(
      [8000, 11_025, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000].map((rate) =>
        z.literal(rate),
      ),
    ),
    precision: z.number().int().min(15).max(33).default(28),
  }),
  z.strictObject({
    op: z.literal('audio_delay'),
    left_ms: z.number().int().min(0).max(60_000).default(0),
    right_ms: z.number().int().min(0).max(60_000).default(0),
  }),
  z.strictObject({
    op: z.literal('silence_pad'),
    start_s: level(0, 600).default(0),
    end_s: level(0, 600).default(0),
  }),
  z.strictObject({ op: z.literal('trim_to_shortest') }),
  z.strictObject({ op: z.literal('remove_audio') }),
] as const;

export type AudioStep = z.output<(typeof audioSchemas)[number]>;
type Of<K extends AudioStep['op']> = Extract<AudioStep, { op: K }>;

/** loudnorm's first-pass figures (print_format=json). */
export interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** atempo works best in 0.5–2; larger changes are chained. */
export function atempoChain(factor: number): string[] {
  const filters: string[] = [];
  let rest = factor;
  while (rest > 2) {
    filters.push('atempo=2');
    rest /= 2;
  }
  while (rest < 0.5) {
    filters.push('atempo=0.5');
    rest /= 0.5;
  }
  filters.push(`atempo=${num(rest)}`);
  return filters;
}

function normalize(ctx: FilterContext, step: Of<'normalize_loudness'>, index: number): void {
  const audio = ctx.audio(index, 'normalize_loudness');
  const target = `I=${num(step.target_lufs)}:TP=${num(step.true_peak_dbtp)}:LRA=${num(step.lra)}`;
  // loudnorm works at 192 kHz; the stream returns to its rate afterwards.
  const back = `aresample=${ctx.state.sampleRate ?? 48_000}`;
  if (step.mode === 'dynamic') {
    ctx.applyFilters(null, ['dynaudnorm=f=250:g=15', `loudnorm=${target}`, back]);
    return;
  }
  const measured = ctx.measured(
    `loudnorm:${index}`,
    'loudnorm',
    audio,
    `loudnorm=${target}:print_format=json`,
  ) as LoudnormMeasurement | null;
  if (!measured) throw invalid(index, 'the loudness measurement found no audio');
  const values = [
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
  ];
  // Silence measures as -inf; a linear second pass then has nothing to work with.
  if (values.some((value) => /inf|nan/i.test(value)))
    throw invalid(index, 'the audio is silent; nothing to normalize');
  ctx.applyFilters(null, [
    `loudnorm=${target}:${values.join(':')}:linear=true:print_format=summary`,
    back,
  ]);
  ctx.filterCost(ctx.minutes, 0.1, false);
}

function silenceTrim(ctx: FilterContext, step: Of<'silence_trim'>, index: number): void {
  const audio = ctx.audio(index, 'silence_trim');
  const total = ctx.duration(index, 'silence_trim');
  if (!step.start && !step.end) throw invalid(index, 'silence_trim needs start or end');
  const silences =
    (ctx.measured(
      `silence:${index}`,
      'silence',
      audio,
      `silencedetect=n=${num(step.threshold_db)}dB:d=${num(step.min_silence_s)}`,
    ) as { start_s: number; end_s: number }[] | null) ?? [];
  const edge = 0.05;
  const leading = step.start
    ? (silences.find((silence) => silence.start_s <= edge)?.end_s ?? 0)
    : 0;
  const trailing = step.end
    ? (silences.find((silence) => silence.end_s >= total - edge)?.start_s ?? total)
    : total;
  if (trailing <= leading) throw invalid(index, 'the media is silent from start to end');
  if (leading === 0 && trailing === total) return;
  const range = `start=${num(leading)}:end=${num(trailing)}`;
  ctx.applyFilters(
    [`trim=${range}`, 'setpts=PTS-STARTPTS'],
    [`atrim=${range}`, 'asetpts=PTS-STARTPTS'],
  );
  ctx.state.duration = trailing - leading;
  ctx.state.timeAltered = true;
}

function gain(ctx: FilterContext, step: Of<'gain'>, index: number): void {
  const audio = ctx.audio(index, 'gain');
  if ((step.db === undefined) === (step.to_peak_dbfs === undefined))
    throw invalid(index, 'set db or to_peak_dbfs');
  if (step.db !== undefined) {
    ctx.applyFilters(null, [`volume=${num(step.db)}dB`]);
    return;
  }
  const peak = ctx.measured(`peak:${index}`, 'peak', audio, 'volumedetect') as number | null;
  if (peak === null) throw invalid(index, 'the peak measurement found no audio');
  ctx.applyFilters(null, [`volume=${num((step.to_peak_dbfs ?? 0) - peak)}dB`]);
}

export const audioHandlers: {
  [K in AudioStep['op']]: (ctx: FilterContext, step: Of<K>, index: number) => void;
} = {
  gain,
  normalize_loudness: normalize,
  compress(ctx, step, index) {
    ctx.audio(index, 'compress');
    const preset = COMPRESS_PRESETS[step.preset ?? 'medium'];
    const values = {
      threshold: linear(step.threshold_db ?? preset.threshold_db),
      ratio: step.ratio ?? preset.ratio,
      attack: step.attack_ms ?? preset.attack_ms,
      release: step.release_ms ?? preset.release_ms,
      makeup: linear(step.makeup_db ?? preset.makeup_db),
    };
    ctx.applyFilters(null, [
      `acompressor=threshold=${num(values.threshold)}:ratio=${num(values.ratio)}:attack=${num(values.attack)}:release=${num(values.release)}:makeup=${num(values.makeup)}`,
    ]);
  },
  limiter(ctx, step, index) {
    ctx.audio(index, 'limiter');
    ctx.applyFilters(null, [
      `alimiter=limit=${num(Math.max(0.0625, linear(step.ceiling_dbtp)))}:level=disabled`,
    ]);
  },
  silence_trim: silenceTrim,
  channels(ctx, step, index) {
    ctx.audio(index, 'channels');
    ctx.applyFilters(null, [...CHANNELS[step.layout]]);
  },
  pitch(ctx, step, index) {
    ctx.audio(index, 'pitch');
    const ratio = 2 ** (step.semitones / 12);
    if (step.preserve_tempo) {
      ctx.applyFilters(null, [`rubberband=pitch=${num(ratio)}`]);
      return;
    }
    if (ctx.state.video)
      throw invalid(
        index,
        'pitch without preserve_tempo changes the audio length; use it on audio-only media',
      );
    const rate = ctx.state.sampleRate;
    if (!rate) throw invalid(index, 'pitch without preserve_tempo needs the sample rate');
    ctx.applyFilters(null, [`asetrate=${Math.round(rate * ratio)}`, `aresample=${rate}`]);
    if (ctx.state.duration !== null) ctx.state.duration /= ratio;
    ctx.state.timeAltered = true;
  },
  tempo(ctx, step, index) {
    ctx.audio(index, 'tempo');
    if (ctx.state.video)
      throw invalid(index, 'tempo changes audio only; use speed for media with video');
    ctx.applyFilters(null, atempoChain(step.factor));
    if (ctx.state.duration !== null) ctx.state.duration /= step.factor;
    ctx.state.timeAltered = true;
  },
  eq(ctx, step, index) {
    ctx.audio(index, 'eq');
    if ((step.preset === undefined) === (step.bands === undefined))
      throw invalid(index, 'set preset or bands');
    const filters = step.bands
      ? step.bands.map(
          (band) =>
            `equalizer=f=${num(band.freq_hz)}:t=h:w=${num(band.width_hz)}:g=${num(band.gain_db)}`,
        )
      : [...EQ_PRESETS[step.preset ?? 'flat']];
    ctx.applyFilters(null, filters);
  },
  bass(ctx, step, index) {
    ctx.audio(index, 'bass');
    ctx.applyFilters(null, [`bass=g=${num(step.gain_db)}:f=${num(step.freq_hz)}`]);
  },
  treble(ctx, step, index) {
    ctx.audio(index, 'treble');
    ctx.applyFilters(null, [`treble=g=${num(step.gain_db)}:f=${num(step.freq_hz)}`]);
  },
  highpass(ctx, step, index) {
    ctx.audio(index, 'highpass');
    ctx.applyFilters(null, [`highpass=f=${num(step.freq_hz)}:p=${step.poles}`]);
  },
  lowpass(ctx, step, index) {
    ctx.audio(index, 'lowpass');
    ctx.applyFilters(null, [`lowpass=f=${num(step.freq_hz)}:p=${step.poles}`]);
  },
  bandpass(ctx, step, index) {
    ctx.audio(index, 'bandpass');
    ctx.applyFilters(null, [
      `bandpass=f=${num(step.freq_hz)}:width_type=h:w=${num(step.width_hz)}`,
    ]);
  },
  remove_hum(ctx, step, index) {
    ctx.audio(index, 'remove_hum');
    const notches = Array.from(
      { length: step.harmonics },
      (_, i) => `bandreject=f=${step.freq_hz * (i + 1)}:width_type=q:w=30`,
    );
    ctx.applyFilters(null, notches);
  },
  denoise_audio(ctx, step, index) {
    ctx.audio(index, 'denoise_audio');
    const filter =
      step.method === 'afftdn'
        ? `afftdn=nr=${{ light: 6, medium: 12, strong: 20 }[step.strength]}`
        : `anlmdn=s=${{ light: 0.0001, medium: 0.001, strong: 0.01 }[step.strength]}`;
    ctx.applyFilters(null, [filter]);
    ctx.filterCost(ctx.minutes, step.method === 'anlmdn' ? 2 : 0.2, false);
  },
  deesser(ctx, step, index) {
    ctx.audio(index, 'deesser');
    ctx.applyFilters(null, [`deesser=i=${num(step.intensity)}`]);
  },
  echo(ctx, step, index) {
    ctx.audio(index, 'echo');
    if (step.delay_ms.length !== step.decay.length)
      throw invalid(index, 'delay_ms and decay need the same length');
    ctx.applyFilters(null, [
      `aecho=0.8:0.9:${step.delay_ms.map(num).join('|')}:${step.decay.map(num).join('|')}`,
    ]);
  },
  stereo_width(ctx, step, index) {
    ctx.audio(index, 'stereo_width');
    ctx.applyFilters(null, [`extrastereo=m=${num(step.amount)}`]);
  },
  vocal_reduce(ctx, step, index) {
    ctx.audio(index, 'vocal_reduce');
    const s = num(step.strength);
    ctx.applyFilters(null, [`pan=stereo|c0=c0-${s}*c1|c1=c1-${s}*c0`]);
  },
  resample(ctx, step, index) {
    ctx.audio(index, 'resample');
    ctx.applyFilters(null, [`aresample=${step.rate}:resampler=soxr:precision=${step.precision}`]);
    ctx.state.sampleRate = step.rate;
  },
  audio_delay(ctx, step, index) {
    ctx.audio(index, 'audio_delay');
    ctx.applyFilters(null, [`adelay=delays=${step.left_ms}|${step.right_ms}`]);
  },
  silence_pad(ctx, step, index) {
    ctx.audio(index, 'silence_pad');
    if (step.start_s === 0 && step.end_s === 0)
      throw invalid(index, 'silence_pad needs start_s or end_s');
    const video = [
      ...(step.start_s > 0
        ? [`tpad=start_mode=add:start_duration=${num(step.start_s)}:color=black`]
        : []),
      ...(step.end_s > 0
        ? [`tpad=stop_mode=add:stop_duration=${num(step.end_s)}:color=black`]
        : []),
    ];
    const audio = [
      ...(step.start_s > 0 ? [`adelay=delays=${Math.round(step.start_s * 1000)}:all=1`] : []),
      ...(step.end_s > 0 ? [`apad=pad_dur=${num(step.end_s)}`] : []),
    ];
    // The picture is padded too, so sound and picture stay in step.
    ctx.applyFilters(video, audio);
    if (ctx.state.duration !== null) ctx.state.duration += step.start_s + step.end_s;
    ctx.state.timeAltered = true;
  },
  trim_to_shortest(ctx) {
    ctx.state.shortest = true;
  },
  remove_audio(ctx, _step, index) {
    ctx.audio(index, 'remove_audio');
    ctx.state.audio = null;
  },
};
