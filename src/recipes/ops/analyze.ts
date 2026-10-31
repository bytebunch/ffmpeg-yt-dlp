import path from 'node:path';

import { z } from 'zod';

import { AppError } from '../../common/errors';
import { type FilterContext, graphPath, invalid } from '../context';
import { num } from '../graph';
import { outputName } from '../values';

/** The rest of the analyses (SPEC §8j); each produces a JSON report, `transcribe` a file. */

const named = { name: outputName.optional() };

export const analyzeSchemas = [
  z.strictObject({
    op: z.literal('freeze_detect'),
    ...named,
    noise_db: z.number().min(-90).max(0).default(-60),
    duration_s: z.number().min(0.1).max(600).default(2),
  }),
  z.strictObject({
    op: z.literal('crop_detect'),
    ...named,
    limit: z.number().int().min(0).max(255).default(24),
    round: z.number().int().min(2).max(64).default(2),
  }),
  z.strictObject({ op: z.literal('interlace_detect'), ...named }),
  z.strictObject({
    op: z.literal('duplicate_frames'),
    ...named,
    threshold: z.enum(['low', 'medium', 'high']).default('medium'),
  }),
  z.strictObject({
    op: z.literal('quality_compare'),
    ...named,
    reference: z.number().int().min(1).max(499),
    metrics: z
      .array(z.enum(['psnr', 'ssim', 'vmaf']))
      .min(1)
      .max(3)
      .default(['vmaf', 'psnr', 'ssim']),
    model: z.enum(['vmaf_v0.6.1', 'vmaf_v0.6.1neg', 'vmaf_4k_v0.6.1']).default('vmaf_v0.6.1'),
  }),
  z.strictObject({
    op: z.literal('hash'),
    ...named,
    algorithm: z.enum(['md5', 'sha256', 'crc32']).default('sha256'),
    per_stream: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal('frame_hashes'),
    ...named,
    algorithm: z.enum(['md5', 'sha256', 'crc32']).default('md5'),
  }),
  z.strictObject({
    op: z.literal('peaks'),
    ...named,
    per_second: z.number().int().min(1).max(100).default(10),
  }),
  z.strictObject({
    op: z.literal('bitrate_timeline'),
    ...named,
    window_s: z.number().min(0.5).max(60).default(1),
  }),
  z.strictObject({
    op: z.literal('transcribe'),
    ...named,
    language: z
      .string()
      .regex(/^(auto|[a-z]{2,3})$/, 'an ISO 639-1 code or "auto"')
      .default('auto'),
    model: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .optional(),
    format: z.enum(['srt', 'vtt', 'json', 'txt']).default('srt'),
    max_line_chars: z.number().int().min(0).max(200).default(0),
    vad: z.boolean().default(true),
  }),
] as const;

export type AnalyzeStep = z.output<(typeof analyzeSchemas)[number]>;
type Of<K extends AnalyzeStep['op']> = Extract<AnalyzeStep, { op: K }>;

const MPDECIMATE = {
  low: 'mpdecimate=hi=768:lo=320:frac=0.33',
  medium: 'mpdecimate',
  high: 'mpdecimate=hi=2048:lo=1024:frac=0.5',
};
/** Work units per minute of audio by model size (SPEC §8j: transcribe is heavy). */
const WHISPER_COST: Record<string, number> = { fast: 2, balanced: 6, accurate: 15 };

/** A per-frame tag, then a print to a file: metadata=print skips frames without metadata. */
const countFrames = (file: string) => [
  `metadata=mode=add:key=media.frame:value=1`,
  `metadata=mode=print:key=media.frame:file=${file}`,
];

function logFilter(
  ctx: FilterContext,
  step: Of<'freeze_detect'> | Of<'crop_detect'> | Of<'interlace_detect'>,
  index: number,
): void {
  const name = ctx.name(index);
  const video = ctx.video(index, step.op);
  const filter =
    step.op === 'freeze_detect'
      ? `freezedetect=n=${num(step.noise_db)}dB:d=${num(step.duration_s)}`
      : step.op === 'crop_detect'
        ? `cropdetect=limit=${step.limit}:round=${step.round}:reset=0`
        : 'idet';
  ctx.graph.chain(video, [filter]);
  ctx.addLogReport(name, step.op, step.op);
  ctx.filterCost(ctx.minutes, 0.05);
}

function transcribe(ctx: FilterContext, step: Of<'transcribe'>, index: number): void {
  const name = ctx.name(index);
  const audio = ctx.audio(index, 'transcribe');
  const whisper = ctx.whisper;
  if (!whisper || whisper.disabled) {
    throw new AppError(
      'FEATURE_DISABLED',
      `steps.${index}: transcribe is not available here: ${whisper?.disabled ?? 'no whisper models configured'}`,
      { step: index },
      {},
      false,
    );
  }
  const modelName = step.model ?? whisper.defaultModel ?? Object.keys(whisper.models)[0] ?? '';
  const model = whisper.models[modelName];
  if (!model)
    throw invalid(
      index,
      `unknown model "${modelName}" (available: ${Object.keys(whisper.models).join(', ')})`,
    );
  const vad = step.vad && whisper.vadModel ? whisper.vadModel : undefined;
  // whisper.cpp writes srt, json or text; WebVTT is converted from SRT afterwards.
  const written = step.format === 'json' ? 'json' : step.format === 'txt' ? 'text' : 'srt';
  const ext = step.format === 'txt' ? 'txt' : step.format === 'json' ? 'json' : 'srt';
  const target = graphPath(ctx.outputTarget(step.format === 'vtt' ? `${name}-whisper` : name, ext));
  const options = [
    `model=${graphPath(model)}`,
    `language=${step.language}`,
    'use_gpu=0',
    `queue=${vad ? 20 : 10}`,
    `format=${written}`,
    `destination=${target}`,
    ...(vad ? [`vad_model=${graphPath(vad)}`] : []),
    ...(step.max_line_chars > 0 ? [`max_len=${step.max_line_chars}`] : []),
  ];
  ctx.graph.chain(audio, [
    'aresample=16000',
    'aformat=sample_fmts=fltp:channel_layouts=mono',
    `whisper=${options.join(':')}`,
  ]);
  let file = target;
  if (step.format === 'vtt') {
    file = ctx.outputTarget(name, 'vtt');
    ctx.addPostStage(`subtitles for ${name}`, [
      '-protocol_whitelist',
      'file',
      '-i',
      target,
      '-c:s',
      'webvtt',
      '-f',
      'webvtt',
      '-y',
      file,
    ]);
  }
  const mime = {
    srt: 'application/x-subrip',
    vtt: 'text/vtt',
    json: 'application/json',
    txt: 'text/plain',
  }[step.format];
  ctx.addOutput(null, {
    name,
    op: 'transcribe',
    role: step.format === 'srt' || step.format === 'vtt' ? 'subtitles' : 'report',
    pattern: path.basename(file),
    multiple: false,
    mime,
  });
  ctx.addCost(ctx.minutes * (WHISPER_COST[modelName] ?? 10));
}

export const analyzeHandlers: {
  [K in AnalyzeStep['op']]: (ctx: FilterContext, step: Of<K>, index: number) => void;
} = {
  freeze_detect: logFilter,
  crop_detect: logFilter,
  interlace_detect: logFilter,
  duplicate_frames(ctx, step, index) {
    const name = ctx.name(index);
    const video = ctx.video(index, 'duplicate_frames');
    const all = graphPath(path.join(ctx.workDir, `frames-${index}-all.txt`));
    const unique = graphPath(path.join(ctx.workDir, `frames-${index}-unique.txt`));
    ctx.graph.chain(video, countFrames(all));
    ctx.graph.chain(video, [MPDECIMATE[step.threshold], ...countFrames(unique)]);
    ctx.addFileReport(name, step.op, step.op, [all, unique]);
    ctx.filterCost(ctx.minutes, 0.2);
  },
  quality_compare(ctx, step, index) {
    const name = ctx.name(index);
    const main = ctx.video(index, 'quality_compare');
    const { width, height, fps } = ctx.canvas();
    // The reference is brought to the picture's size and rate, as the metrics compare frame by frame.
    const reference = ctx.graph.chain(
      ctx.inputPad(step.reference, 'v', index, 'quality_compare reference'),
      [`scale=${width}:${height}:flags=bicubic`, 'setsar=1', `fps=${fps}`, 'format=yuv420p'],
    );
    const distorted = ctx.graph.chain(main, ['setsar=1', `fps=${fps}`, 'format=yuv420p']);
    const files: string[] = [];
    for (const metric of step.metrics) {
      const file = graphPath(
        path.join(ctx.workDir, `quality-${index}-${metric}.${metric === 'vmaf' ? 'json' : 'txt'}`),
      );
      files.push(file);
      const filter =
        metric === 'vmaf'
          ? `libvmaf=model=version=${step.model}:log_fmt=json:log_path=${file}:n_threads=${ctx.threadArgs()[1] ?? '2'}`
          : `${metric}=stats_file=${file}`;
      const out = ctx.graph.newPad('v');
      ctx.graph.segment(
        `[${ctx.graph.read(distorted)}][${ctx.graph.read(reference)}]${filter}[${out.label}]`,
      );
    }
    ctx.addFileReport(name, step.op, step.op, files, { metrics: step.metrics });
    ctx.filterCost(ctx.minutes, step.metrics.includes('vmaf') ? 6 : 1);
  },
  hash(ctx, step, index) {
    const name = ctx.name(index);
    const file = path.join(ctx.workDir, `hash-${index}.txt`);
    const maps = [ctx.state.video, ctx.state.audio].flatMap((pad) =>
      pad ? [pad.raw ? pad.label : `[${ctx.graph.read(pad)}]`] : [],
    );
    if (maps.length === 0) throw invalid(index, 'nothing to hash');
    ctx.addOutput(
      {
        maps,
        args: ['-f', step.per_stream ? 'streamhash' : 'hash', '-hash', step.algorithm],
        target: file,
        durationS: ctx.state.duration,
      },
      null,
    );
    ctx.addFileReport(name, step.op, step.op, [file], { algorithm: step.algorithm });
    ctx.filterCost(ctx.minutes, 0.1);
  },
  frame_hashes(ctx, step, index) {
    const name = ctx.name(index);
    const video = ctx.video(index, 'frame_hashes');
    const file = path.join(ctx.workDir, `framehash-${index}.txt`);
    ctx.addOutput(
      {
        maps: [video.raw ? video.label : `[${ctx.graph.read(video)}]`],
        args: ['-f', 'framehash', '-hash', step.algorithm],
        target: file,
        durationS: ctx.state.duration,
      },
      null,
    );
    ctx.addFileReport(name, step.op, step.op, [file], { max: ctx.limits.FRAMES_MAX_COUNT ?? 2000 });
    ctx.filterCost(ctx.minutes, 0.1);
  },
  peaks(ctx, step, index) {
    const name = ctx.name(index);
    const audio = ctx.audio(index, 'peaks');
    const rate = ctx.state.sampleRate ?? 48_000;
    const file = graphPath(path.join(ctx.workDir, `peaks-${index}.txt`));
    ctx.graph.chain(audio, [
      'aformat=channel_layouts=mono',
      `asetnsamples=n=${Math.max(1, Math.round(rate / step.per_second))}:p=0`,
      'astats=metadata=1:reset=1:measure_overall=Peak_level:measure_perchannel=none',
      `ametadata=mode=print:key=lavfi.astats.Overall.Peak_level:file=${file}`,
    ]);
    ctx.addFileReport(name, step.op, step.op, [file], { per_second: step.per_second });
    ctx.filterCost(ctx.minutes, 0.05, false);
  },
  bitrate_timeline(ctx, step, index) {
    const name = ctx.name(index);
    ctx.video(index, 'bitrate_timeline');
    ctx.addProbeReport(
      name,
      step.op,
      step.op,
      [
        '-select_streams',
        'V:0',
        '-show_entries',
        'packet=pts_time,size',
        '-of',
        'csv=p=0',
        '-i',
        ctx.mainPath,
      ],
      { window_s: step.window_s },
    );
  },
  transcribe,
};
