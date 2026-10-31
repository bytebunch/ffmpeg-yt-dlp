import path from 'node:path';

import { z } from 'zod';

import { type FilterContext, graphPath, invalid } from '../context';
import { num } from '../graph';
import { colorValue, timeValue } from '../values';

/** Visual filters (SPEC §8f), single input. Text and subtitles live in their own module. */

const strength = z.enum(['light', 'medium', 'strong']).default('medium');
const regionFields = {
  x: z.number().int().min(0).max(7680),
  y: z.number().int().min(0).max(7680),
  w: z.number().int().min(2).max(7680),
  h: z.number().int().min(2).max(7680),
  start: timeValue.optional(),
  end: timeValue.optional(),
};
const balance = z.strictObject({
  r: z.number().min(-1).max(1).default(0),
  g: z.number().min(-1).max(1).default(0),
  b: z.number().min(-1).max(1).default(0),
});

export const CURVES_PRESETS = [
  'vintage',
  'cross_process',
  'darker',
  'lighter',
  'increase_contrast',
  'linear_contrast',
  'medium_contrast',
  'strong_contrast',
  'negative',
  'color_negative',
] as const;

export const visualSchemas = [
  z.strictObject({
    op: z.literal('deinterlace'),
    mode: z.enum(['yadif', 'bwdif']).default('bwdif'),
    field_order: z.enum(['auto', 'tff', 'bff']).default('auto'),
    double_rate: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal('denoise'),
    strength,
    method: z.enum(['hqdn3d', 'nlmeans', 'atadenoise']).default('hqdn3d'),
  }),
  z.strictObject({ op: z.literal('sharpen'), amount: z.number().min(0.1).max(2).default(0.8) }),
  z.strictObject({ op: z.literal('blur'), radius: z.number().min(1).max(50).default(5) }),
  z.strictObject({
    op: z.literal('color'),
    brightness: z.number().min(-1).max(1).optional(),
    contrast: z.number().min(0).max(3).optional(),
    saturation: z.number().min(0).max(3).optional(),
    gamma: z.number().min(0.1).max(3).optional(),
    hue_deg: z.number().min(-180).max(180).optional(),
    temperature_k: z.number().int().min(1000).max(40_000).optional(),
    vibrance: z.number().min(-2).max(2).optional(),
    exposure: z.number().min(-3).max(3).optional(),
    grayscale: z.boolean().default(false),
    sepia: z.boolean().default(false),
    invert: z.boolean().default(false),
    balance: z
      .strictObject({
        shadows: balance.optional(),
        midtones: balance.optional(),
        highlights: balance.optional(),
      })
      .optional(),
    curves_preset: z.enum(CURVES_PRESETS).optional(),
    lut3d: z.unknown().optional(),
  }),
  z.strictObject({ op: z.literal('vignette'), strength: z.number().min(0).max(1).default(0.5) }),
  z.strictObject({ op: z.literal('grain'), strength: z.number().min(1).max(100).default(15) }),
  z.strictObject({
    op: z.literal('deband'),
    strength: z.number().min(0.003).max(0.5).default(0.02),
  }),
  z.strictObject({ op: z.literal('deflicker'), size: z.number().int().min(2).max(129).default(5) }),
  z.strictObject({
    op: z.literal('region_blur'),
    ...regionFields,
    strength: z.number().int().min(1).max(50).default(10),
  }),
  z.strictObject({
    op: z.literal('region_pixelate'),
    ...regionFields,
    strength: z.number().int().min(2).max(64).default(16),
  }),
  z.strictObject({
    op: z.literal('drawbox'),
    ...regionFields,
    color: colorValue.default('black'),
    opacity: z.number().min(0).max(1).default(1),
    thickness: z.union([z.number().int().min(1).max(100), z.literal('fill')]).default('fill'),
  }),
  z.strictObject({
    op: z.literal('stabilize'),
    shakiness: z.number().int().min(1).max(10).default(5),
    smoothing: z.number().int().min(1).max(100).default(15),
    crop: z.enum(['keep', 'black']).default('black'),
  }),
  z.strictObject({
    op: z.literal('tonemap'),
    algorithm: z.enum(['hable', 'mobius', 'reinhard', 'bt2390']).default('hable'),
    peak_nits: z.number().int().min(100).max(10_000).default(100),
  }),
  z.strictObject({
    op: z.literal('dedupe_frames'),
    threshold: z.enum(['low', 'medium', 'high']).default('medium'),
  }),
  z.strictObject({
    op: z.literal('lens_correction'),
    k1: z.number().min(-1).max(1),
    k2: z.number().min(-1).max(1).default(0),
  }),
] as const;

export type VisualStep = z.output<(typeof visualSchemas)[number]>;
type Of<K extends VisualStep['op']> = Extract<VisualStep, { op: K }>;

const enable = (step: { start?: number | undefined; end?: number | undefined }) =>
  step.start === undefined && step.end === undefined
    ? ''
    : `:enable='between(t,${num(step.start ?? 0)},${num(step.end ?? 864_000)})'`;

const DENOISE = {
  hqdn3d: { light: 'hqdn3d=1.5:1.5:6:6', medium: 'hqdn3d=4:3:6:4.5', strong: 'hqdn3d=8:6:12:9' },
  nlmeans: { light: 'nlmeans=s=1', medium: 'nlmeans=s=3', strong: 'nlmeans=s=6' },
  atadenoise: {
    light: 'atadenoise=0a=0.01:0b=0.02',
    medium: 'atadenoise',
    strong: 'atadenoise=0a=0.04:0b=0.08:s=15',
  },
} as const;

const MPDECIMATE = {
  low: 'mpdecimate=hi=768:lo=320:frac=0.33',
  medium: 'mpdecimate',
  high: 'mpdecimate=hi=2048:lo=1024:frac=0.5',
};
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
const SEPIA = 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131';

function color(ctx: FilterContext, step: Of<'color'>, index: number): void {
  ctx.video(index, 'color');
  if (step.lut3d !== undefined) {
    throw invalid(index, 'lut3d needs a .cube file input, which arrives with saved recipe assets');
  }
  const filters: string[] = [];
  const eq = [
    step.brightness !== undefined && `brightness=${num(step.brightness)}`,
    step.contrast !== undefined && `contrast=${num(step.contrast)}`,
    step.saturation !== undefined && `saturation=${num(step.saturation)}`,
    step.gamma !== undefined && `gamma=${num(step.gamma)}`,
  ].filter((part): part is string => typeof part === 'string');
  if (eq.length > 0) filters.push(`eq=${eq.join(':')}`);
  if (step.hue_deg !== undefined) filters.push(`hue=h=${num(step.hue_deg)}`);
  if (step.temperature_k !== undefined)
    filters.push(`colortemperature=temperature=${step.temperature_k}`);
  if (step.vibrance !== undefined) filters.push(`vibrance=intensity=${num(step.vibrance)}`);
  if (step.exposure !== undefined) filters.push(`exposure=exposure=${num(step.exposure)}`);
  if (step.balance) {
    const parts: string[] = [];
    for (const [range, letter] of [
      ['shadows', 's'],
      ['midtones', 'm'],
      ['highlights', 'h'],
    ] as const) {
      const values = step.balance[range];
      if (values)
        parts.push(
          `r${letter}=${num(values.r)}`,
          `g${letter}=${num(values.g)}`,
          `b${letter}=${num(values.b)}`,
        );
    }
    if (parts.length > 0) filters.push(`colorbalance=${parts.join(':')}`);
  }
  if (step.curves_preset) filters.push(`curves=preset=${step.curves_preset}`);
  if (step.sepia) filters.push(SEPIA);
  if (step.grayscale) filters.push('hue=s=0');
  if (step.invert) filters.push('negate');
  if (filters.length === 0) throw invalid(index, 'color needs at least one adjustment');
  ctx.applyFilters(filters, null);
}

/** A region processed on its own copy and laid back over the picture (blur, pixelate). */
function region(
  ctx: FilterContext,
  step: Of<'region_blur'> | Of<'region_pixelate'>,
  index: number,
): void {
  const video = ctx.video(index, step.op);
  const { width, height } = ctx.state;
  if (width && height && (step.x + step.w > width || step.y + step.h > height)) {
    throw invalid(
      index,
      `the region ${step.w}x${step.h}+${step.x}+${step.y} is outside the ${width}x${height} picture`,
    );
  }
  const effect =
    step.op === 'region_blur'
      ? `boxblur=${Math.min(step.strength, Math.floor(Math.min(step.w, step.h) / 2) - 1 || 1)}`
      : `pixelize=w=${step.strength}:h=${step.strength}`;
  const patch = ctx.graph.chain(video, [`crop=${step.w}:${step.h}:${step.x}:${step.y}`, effect]);
  const out = ctx.graph.newPad('v');
  ctx.graph.segment(
    `[${ctx.graph.read(video)}][${ctx.graph.read(patch)}]overlay=${step.x}:${step.y}${enable(step)}[${out.label}]`,
  );
  ctx.state.video = out;
  ctx.state.filtered = true;
}

/** Two passes (SPEC §8f): vidstabdetect writes the motion file, vidstabtransform applies it. */
function stabilize(ctx: FilterContext, step: Of<'stabilize'>, index: number): void {
  const video = ctx.video(index, 'stabilize');
  const transforms = graphPath(path.join(ctx.workDir, `stabilize-${index}.trf`));
  ctx.measured(
    `vidstab:${index}`,
    'vidstab',
    video,
    `vidstabdetect=shakiness=${step.shakiness}:accuracy=15:result=${transforms}`,
  );
  ctx.applyFilters(
    [
      `vidstabtransform=input=${transforms}:smoothing=${step.smoothing}:crop=${step.crop}:zoom=0`,
      'unsharp=5:5:0.8:3:3:0.4',
    ],
    null,
  );
  ctx.filterCost(ctx.minutes, 3);
}

export const visualHandlers: {
  [K in VisualStep['op']]: (ctx: FilterContext, step: Of<K>, index: number) => void;
} = {
  deinterlace(ctx, step, index) {
    ctx.video(index, 'deinterlace');
    const mode = step.double_rate ? 'send_field' : 'send_frame';
    ctx.applyFilters([`${step.mode}=mode=${mode}:parity=${step.field_order}`], null);
    if (step.double_rate && ctx.state.fps) ctx.state.fps *= 2;
  },
  denoise(ctx, step, index) {
    ctx.video(index, 'denoise');
    ctx.applyFilters([DENOISE[step.method][step.strength]], null);
    ctx.filterCost(ctx.minutes, step.method === 'nlmeans' ? 6 : 0.2);
  },
  sharpen(ctx, step, index) {
    ctx.video(index, 'sharpen');
    ctx.applyFilters([`unsharp=5:5:${num(step.amount)}:5:5:0`], null);
  },
  blur(ctx, step, index) {
    ctx.video(index, 'blur');
    ctx.applyFilters([`gblur=sigma=${num(step.radius)}`], null);
  },
  color,
  vignette(ctx, step, index) {
    ctx.video(index, 'vignette');
    ctx.applyFilters([`vignette=angle=${num(0.1 + step.strength * 1.4)}`], null);
  },
  grain(ctx, step, index) {
    ctx.video(index, 'grain');
    ctx.applyFilters([`noise=alls=${num(step.strength)}:allf=t`], null);
  },
  deband(ctx, step, index) {
    ctx.video(index, 'deband');
    ctx.applyFilters(
      [
        `deband=1thr=${num(step.strength)}:2thr=${num(step.strength)}:3thr=${num(step.strength)}:4thr=${num(step.strength)}`,
      ],
      null,
    );
  },
  deflicker(ctx, step, index) {
    ctx.video(index, 'deflicker');
    ctx.applyFilters([`deflicker=size=${step.size}`], null);
  },
  region_blur: region,
  region_pixelate: region,
  drawbox(ctx, step, index) {
    ctx.video(index, 'drawbox');
    const thickness = step.thickness === 'fill' ? 'fill' : String(step.thickness);
    ctx.applyFilters(
      [
        `drawbox=x=${step.x}:y=${step.y}:w=${step.w}:h=${step.h}:color=${step.color}@${num(step.opacity)}:t=${thickness}${enable(step)}`,
      ],
      null,
    );
  },
  stabilize,
  tonemap(ctx, step, index) {
    ctx.video(index, 'tonemap');
    // zscale reads the input's tags; SDR or untagged video has nothing to map from.
    if (!HDR_TRANSFERS.has(ctx.state.transfer ?? '')) {
      throw invalid(
        index,
        `tonemap needs HDR video (PQ or HLG); the input's transfer is ${ctx.state.transfer ?? 'unknown'}`,
      );
    }
    ctx.applyFilters(
      [
        `zscale=t=linear:npl=${step.peak_nits}`,
        'format=gbrpf32le',
        'zscale=p=bt709',
        `tonemap=tonemap=${step.algorithm}:desat=0`,
        'zscale=t=bt709:m=bt709:r=tv',
        'format=yuv420p',
      ],
      null,
    );
    ctx.filterCost(ctx.minutes, 1);
  },
  dedupe_frames(ctx, step, index) {
    ctx.video(index, 'dedupe_frames');
    ctx.applyFilters([MPDECIMATE[step.threshold], 'setpts=N/FRAME_RATE/TB'], null);
    // Duplicates are only known while running; the duration is an upper bound from here on.
    ctx.state.timeAltered = true;
  },
  lens_correction(ctx, step, index) {
    ctx.video(index, 'lens_correction');
    ctx.applyFilters([`lenscorrection=k1=${num(step.k1)}:k2=${num(step.k2)}`], null);
  },
};
