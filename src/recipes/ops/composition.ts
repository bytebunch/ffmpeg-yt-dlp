import path from 'node:path';

import { z } from 'zod';

import { type FilterContext, graphPath, invalid, linear } from '../context';
import { num, type Pad } from '../graph';
import { colorValue, metadataText, outputName, timeValue } from '../values';
import { drawtext, fontFile, inputRef } from './text';

/** Composition (SPEC §8d): several inputs, generated sources, stream selection. */

const inputIndex = z.number().int().min(0).max(499);
const position = z.enum([
  'top_left',
  'top_right',
  'bottom_left',
  'bottom_right',
  'center',
  'top_center',
  'bottom_center',
]);
const size = z.strictObject({
  width: z.number().int().min(16).max(7680),
  height: z.number().int().min(16).max(4320),
});
export const XFADE_TRANSITIONS = [
  'fade',
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'circleopen',
  'circleclose',
  'pixelize',
  'radial',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'fadeblack',
  'fadewhite',
  'zoomin',
] as const;
const transition = z.strictObject({
  type: z.enum(XFADE_TRANSITIONS).default('fade'),
  duration_s: z.number().min(0.1).max(5).default(1),
});
const language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'a BCP-47 language code');

export const compositionSchemas = [
  z.strictObject({
    op: z.literal('concat'),
    inputs: z.array(inputIndex).min(2).max(100).optional(),
    mode: z.enum(['copy', 'normalize']).default('normalize'),
    transition: transition.optional(),
    audio_crossfade_s: z.number().min(0.1).max(10).optional(),
  }),
  z.strictObject({
    op: z.literal('overlay_image'),
    input: inputRef,
    position: position.default('bottom_right'),
    x: z.number().int().min(0).max(7680).optional(),
    y: z.number().int().min(0).max(7680).optional(),
    margin: z.number().int().min(0).max(500).default(20),
    scale_pct: z.number().min(1).max(100).optional(),
    opacity: z.number().min(0).max(1).default(1),
    start: timeValue.optional(),
    end: timeValue.optional(),
    tile: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal('overlay_video'),
    input: inputIndex,
    position: position.default('bottom_right'),
    margin: z.number().int().min(0).max(500).default(20),
    size_pct: z.number().min(10).max(50).default(30),
    start: timeValue.default(0),
    end: timeValue.optional(),
    audio: z.enum(['main', 'overlay', 'mix']).default('main'),
    border: z
      .strictObject({
        width: z.number().int().min(1).max(50).default(4),
        color: colorValue.default('white'),
      })
      .optional(),
  }),
  z.strictObject({
    op: z.literal('stack'),
    layout: z.enum(['horizontal', 'vertical', 'grid']).default('horizontal'),
    columns: z.number().int().min(1).max(8).default(2),
    inputs: z.array(inputIndex).min(2).max(16).optional(),
    gap: z.number().int().min(0).max(200).default(0),
    background: colorValue.default('black'),
  }),
  z.strictObject({
    op: z.literal('chromakey'),
    color: colorValue.default('green'),
    similarity: z.number().min(0.01).max(0.5).default(0.1),
    blend: z.number().min(0).max(0.5).default(0.05),
    background: z.union([
      z.strictObject({ input: inputIndex }),
      z.strictObject({ color: colorValue }),
    ]),
  }),
  z.strictObject({
    op: z.literal('slideshow'),
    images: z.array(inputIndex).min(1).max(200).optional(),
    duration_each_s: z.number().min(0.5).max(60).default(3),
    transition: transition.optional(),
    ken_burns: z.boolean().default(false),
    audio: inputIndex.optional(),
    fit: z.enum(['contain', 'cover']).default('contain'),
    size: size.default({ width: 1280, height: 720 }),
    fps: z.number().int().min(1).max(60).default(30),
  }),
  z.strictObject({
    op: z.literal('audio_to_video'),
    visual: z.enum(['cover', 'waveform', 'spectrum', 'bars', 'none']).default('waveform'),
    cover: inputRef.optional(),
    size: size.default({ width: 1280, height: 720 }),
    colors: z.enum(['white', 'fire', 'ice', 'rainbow', 'green']).default('white'),
    background: colorValue.default('black'),
  }),
  z.strictObject({
    op: z.literal('generate'),
    kind: z.enum(['black', 'color', 'slate', 'silence', 'tone', 'test_pattern', 'noise']),
    duration_s: z.number().min(0.1).max(600),
    place: z.enum(['before', 'after', 'replace']).default('replace'),
    size: size.optional(),
    color: colorValue.default('black'),
    text: metadataText(200).optional(),
    frequency_hz: z.number().min(20).max(20_000).default(1000),
    fps: z.number().int().min(1).max(60).optional(),
    sample_rate: z.number().int().min(8000).max(96_000).default(48_000),
  }),
  z.strictObject({
    op: z.literal('mix_audio'),
    inputs: z.array(inputIndex.min(1)).min(1).max(8),
    weights: z.array(z.number().min(0).max(4)).optional(),
    duck: z
      .strictObject({
        threshold_db: z.number().min(-60).max(0).default(-30),
        ratio: z.number().min(1).max(20).default(8),
        attack_ms: z.number().min(0.01).max(2000).default(20),
        release_ms: z.number().min(0.01).max(9000).default(400),
      })
      .optional(),
    normalize: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal('replace_audio'),
    input: inputIndex.min(1),
    offset_ms: z.number().int().min(-60_000).max(60_000).default(0),
    language: language.optional(),
    title: metadataText(64).optional(),
  }),
  z.strictObject({
    op: z.literal('add_audio_track'),
    input: inputIndex.min(1),
    offset_ms: z.number().int().min(0).max(60_000).default(0),
    language: language.optional(),
    title: metadataText(64).optional(),
    default: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal('select_streams'),
    video: z.number().int().min(0).max(31).optional(),
    audio: z.array(z.number().int().min(0).max(31)).min(1).max(16).optional(),
  }),
  z.strictObject({
    op: z.literal('extract_streams'),
    name: outputName.optional(),
    stream: z.enum(['video', 'audio', 'subtitle']),
    index: z.number().int().min(0).max(31).default(0),
    raw: z.boolean().default(false),
  }),
] as const;

export type CompositionStep = z.output<(typeof compositionSchemas)[number]>;
type Of<K extends CompositionStep['op']> = Extract<CompositionStep, { op: K }>;

interface Segment {
  video: Pad | null;
  audio: Pad | null;
  duration: number | null;
}

const STILL_FORMATS = /(^|,)(image2|[a-z0-9]+_pipe|png|mjpeg|webp)($|,)/;

/** A picture rather than a clip: it has to be looped to last. */
function isStill(ctx: FilterContext, input: number): boolean {
  const probe = ctx.inputs[input]?.probe;
  return STILL_FORMATS.test(probe?.format ?? '') || (probe?.duration_s ?? 0) <= 0.1;
}

const enable = (start: number | undefined, end: number | undefined) =>
  start === undefined && end === undefined
    ? ''
    : `:enable='between(t,${num(start ?? 0)},${num(end ?? 864_000)})'`;

function place(name: z.output<typeof position>, margin: number): { x: string; y: string } {
  const m = String(margin);
  const x = name.endsWith('left') ? m : name.endsWith('right') ? `W-w-${m}` : '(W-w)/2';
  const y = name.startsWith('top') ? m : name.startsWith('bottom') ? `H-h-${m}` : '(H-h)/2';
  return { x, y };
}

/** A generated source pad (no input), e.g. "color=c=black:s=1280x720:r=30:d=5". */
function source(ctx: FilterContext, kind: 'v' | 'a', filters: string): Pad {
  const out = ctx.graph.newPad(kind);
  ctx.graph.segment(`${filters}[${out.label}]`);
  return out;
}

const fitVideo = (
  width: number,
  height: number,
  fps: number,
  fit: 'contain' | 'cover' = 'contain',
) =>
  fit === 'cover'
    ? [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        'setsar=1',
        `fps=${fps}`,
        'format=yuv420p',
      ]
    : [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'setsar=1',
        `fps=${fps}`,
        'format=yuv420p',
      ];
const fitAudio = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];

/** The working streams (index 0) or an input's own streams, as a segment. */
function segmentOf(ctx: FilterContext, input: number, index: number, op: string): Segment {
  if (input === 0)
    return { video: ctx.state.video, audio: ctx.state.audio, duration: ctx.state.duration };
  const probe = ctx.inputs[input]?.probe;
  if (!probe) throw invalid(index, `${op}: there is no input ${input}`);
  const hasVideo = probe.streams.some((stream) => stream.type === 'video' && !stream.attached_pic);
  const hasAudio = probe.streams.some((stream) => stream.type === 'audio');
  return {
    video: hasVideo ? ctx.inputPad(input, 'v', index, op) : null,
    audio: hasAudio ? ctx.inputPad(input, 'a', index, op) : null,
    duration: probe.duration_s,
  };
}

/** Normalised segments joined by concat, or chained with xfade/acrossfade (SPEC §8d concat). */
function join(
  ctx: FilterContext,
  segments: Segment[],
  index: number,
  options: {
    transition?: z.output<typeof transition> | undefined;
    crossfade?: number | undefined;
    fit?: 'contain' | 'cover';
  },
): void {
  const { width, height, fps } = ctx.canvas();
  const withVideo = segments.some((segment) => segment.video);
  const withAudio = segments.some((segment) => segment.audio);
  if (
    options.transition ||
    options.crossfade !== undefined ||
    segments.some((segment) => !segment.video || !segment.audio)
  ) {
    if (segments.some((segment) => segment.duration === null))
      throw invalid(index, 'joining needs every part to have a known duration');
  }
  const prepared = segments.map((segment) => {
    const duration = segment.duration ?? 0;
    const video = !withVideo
      ? null
      : segment.video
        ? ctx.graph.chain(segment.video, fitVideo(width, height, fps, options.fit))
        : source(
            ctx,
            'v',
            `color=c=black:s=${width}x${height}:r=${fps}:d=${num(duration)},format=yuv420p`,
          );
    const audio = !withAudio
      ? null
      : segment.audio
        ? ctx.graph.chain(segment.audio, fitAudio)
        : source(
            ctx,
            'a',
            `anullsrc=r=48000:cl=stereo:d=${num(duration)},aformat=sample_fmts=fltp:channel_layouts=stereo`,
          );
    return { video, audio, duration };
  });
  const total = prepared.reduce((sum, part) => sum + part.duration, 0);
  if (options.transition) {
    const fade = options.transition.duration_s;
    if (prepared.some((part) => part.duration <= fade))
      throw invalid(index, 'every part must be longer than the transition');
    let offset = 0;
    let video = prepared[0]?.video ?? null;
    let audio = prepared[0]?.audio ?? null;
    prepared.slice(1).forEach((part, i) => {
      offset += (prepared[i]?.duration ?? 0) - fade;
      if (video && part.video) {
        const out = ctx.graph.newPad('v');
        ctx.graph.segment(
          `[${ctx.graph.read(video)}][${ctx.graph.read(part.video)}]xfade=transition=${options.transition?.type ?? 'fade'}:duration=${num(fade)}:offset=${num(offset)}[${out.label}]`,
        );
        video = out;
      }
      if (audio && part.audio) {
        const out = ctx.graph.newPad('a');
        ctx.graph.segment(
          `[${ctx.graph.read(audio)}][${ctx.graph.read(part.audio)}]acrossfade=d=${num(options.crossfade ?? fade)}[${out.label}]`,
        );
        audio = out;
      }
    });
    ctx.state.video = video;
    ctx.state.audio = audio;
    ctx.state.duration = total - fade * (prepared.length - 1);
  } else {
    if (options.crossfade !== undefined)
      throw invalid(
        index,
        'audio_crossfade_s needs a transition, or sound and picture drift apart',
      );
    const ins = prepared
      .map((part) =>
        [part.video, part.audio]
          .filter((pad): pad is Pad => pad !== null)
          .map((pad) => `[${ctx.graph.read(pad)}]`)
          .join(''),
      )
      .join('');
    const video = withVideo ? ctx.graph.newPad('v') : null;
    const audio = withAudio ? ctx.graph.newPad('a') : null;
    const outs = [video, audio]
      .filter((pad): pad is Pad => pad !== null)
      .map((pad) => `[${pad.label}]`)
      .join('');
    ctx.graph.segment(
      `${ins}concat=n=${prepared.length}:v=${withVideo ? 1 : 0}:a=${withAudio ? 1 : 0}${outs}`,
    );
    ctx.state.video = video;
    ctx.state.audio = audio;
    ctx.state.duration = segments.every((segment) => segment.duration !== null) ? total : null;
  }
  ctx.state.width = withVideo ? width : null;
  ctx.state.height = withVideo ? height : null;
  ctx.state.fps = withVideo ? fps : null;
  ctx.state.sampleRate = withAudio ? 48_000 : null;
  ctx.state.filtered = true;
  ctx.state.timeAltered = true;
  ctx.filterCost(ctx.minutes, 0.3);
}

/** Stream copy through the concat demuxer: identical codec parameters only (SPEC §8d). */
function concatCopy(ctx: FilterContext, order: number[], index: number): void {
  if (ctx.touched) throw invalid(index, 'concat mode "copy" works only as the first step');
  const probes = order.map((i) => ctx.inputs[i]?.probe);
  const signature = (i: number) => {
    const probe = probes[i];
    if (!probe) throw invalid(index, 'concat refers to an input that does not exist');
    return JSON.stringify(
      probe.streams
        .filter(
          (stream) => !stream.attached_pic && (stream.type === 'video' || stream.type === 'audio'),
        )
        .map((stream) => [
          stream.type,
          stream.codec,
          stream.width,
          stream.height,
          stream.sample_rate,
          stream.channels,
        ]),
    );
  };
  const first = signature(0);
  order.forEach((_, i) => {
    if (signature(i) !== first)
      throw invalid(
        index,
        `input ${order[i] ?? i} differs in codecs or sizes; use mode "normalize"`,
      );
  });
  // -safe 1 accepts only plain relative names, so the inputs are linked into the job directory.
  const lines = order.map((input, i) => {
    const target = ctx.inputs[input]?.path ?? '';
    const name = `concat-${i}${path.extname(target).replace(/[^.A-Za-z0-9]/g, '')}`;
    ctx.link(path.join(ctx.workDir, name), target);
    return `file '${name}'`;
  });
  const list = graphPath(path.join(ctx.workDir, 'concat.txt'));
  ctx.writeFile(list, `ffconcat version 1.0\n${lines.join('\n')}\n`);
  ctx.mainSource = ['-f', 'concat', '-safe', '1', '-protocol_whitelist', 'file', '-i', list];
  ctx.state.duration = probes.every((probe) => probe?.duration_s != null)
    ? probes.reduce((sum, probe) => sum + (probe?.duration_s ?? 0), 0)
    : null;
  ctx.state.timeAltered = true;
}

function overlayImage(ctx: FilterContext, step: Of<'overlay_image'>, index: number): void {
  const main = ctx.video(index, 'overlay_image');
  const input = ctx.resolveInput(step.input, index, 'overlay_image');
  const logo = ctx.inputPad(input, 'v', index, 'overlay_image');
  const probe = ctx.inputs[input]?.probe.streams.find((stream) => stream.type === 'video');
  const { width } = ctx.state;
  const filters: string[] = [];
  let logoWidth = probe?.width ?? null;
  let logoHeight = probe?.height ?? null;
  if (step.scale_pct !== undefined) {
    if (!width) throw invalid(index, 'scale_pct needs the picture width');
    const target = Math.max(2, Math.round((width * step.scale_pct) / 100 / 2) * 2);
    filters.push(`scale=${target}:-1`);
    if (logoWidth && logoHeight) logoHeight = Math.round((logoHeight * target) / logoWidth);
    logoWidth = target;
  }
  if (step.opacity < 1) filters.push('format=rgba', `colorchannelmixer=aa=${num(step.opacity)}`);
  const layer = ctx.graph.chain(logo, filters);
  const when = enable(step.start, step.end);
  let current = main;
  const positions: { x: string; y: string }[] = [];
  if (step.tile) {
    const { height } = ctx.state;
    if (!width || !height || !logoWidth || !logoHeight)
      throw invalid(index, 'tile needs the sizes of picture and image');
    const stepX = logoWidth + step.margin;
    const stepY = logoHeight + step.margin;
    for (let y = 0; y < height; y += stepY)
      for (let x = 0; x < width; x += stepX) positions.push({ x: String(x), y: String(y) });
    if (positions.length > 100)
      throw invalid(index, 'tile would place more than 100 copies; scale the image up');
  } else {
    positions.push(
      step.x !== undefined && step.y !== undefined
        ? { x: String(step.x), y: String(step.y) }
        : place(step.position, step.margin),
    );
  }
  for (const { x, y } of positions) {
    const out = ctx.graph.newPad('v');
    ctx.graph.segment(
      `[${ctx.graph.read(current)}][${ctx.graph.read(layer)}]overlay=x=${x}:y=${y}:format=auto${when}[${out.label}]`,
    );
    current = out;
  }
  ctx.state.video = current;
  ctx.state.filtered = true;
}

function overlayVideo(ctx: FilterContext, step: Of<'overlay_video'>, index: number): void {
  const main = ctx.video(index, 'overlay_video');
  const { width } = ctx.state;
  if (!width) throw invalid(index, 'overlay_video needs the picture width');
  const target = Math.max(2, Math.round((width * step.size_pct) / 100 / 2) * 2);
  const filters = [`scale=${target}:-2`, `setpts=PTS-STARTPTS+${num(step.start)}/TB`];
  if (step.border)
    filters.splice(
      1,
      0,
      `pad=w=iw+${step.border.width * 2}:h=ih+${step.border.width * 2}:x=${step.border.width}:y=${step.border.width}:color=${step.border.color}`,
    );
  const pip = ctx.graph.chain(ctx.inputPad(step.input, 'v', index, 'overlay_video'), filters);
  const { x, y } = place(step.position, step.margin);
  const out = ctx.graph.newPad('v');
  ctx.graph.segment(
    `[${ctx.graph.read(main)}][${ctx.graph.read(pip)}]overlay=x=${x}:y=${y}:eof_action=pass${enable(step.start, step.end)}[${out.label}]`,
  );
  ctx.state.video = out;
  if (step.audio !== 'main') {
    const delayed = ctx.graph.chain(
      ctx.inputPad(step.input, 'a', index, 'overlay_video audio'),
      step.start > 0 ? [`adelay=delays=${Math.round(step.start * 1000)}:all=1`] : [],
    );
    if (step.audio === 'overlay') ctx.state.audio = delayed;
    else {
      const mixed = ctx.graph.newPad('a');
      ctx.graph.segment(
        `[${ctx.graph.read(ctx.audio(index, 'overlay_video mix'))}][${ctx.graph.read(delayed)}]amix=inputs=2:duration=first:normalize=0[${mixed.label}]`,
      );
      ctx.state.audio = mixed;
    }
  }
  ctx.state.filtered = true;
}

function stack(ctx: FilterContext, step: Of<'stack'>, index: number): void {
  const order = step.inputs ?? ctx.inputs.map((_, i) => i);
  if (order.length < 2) throw invalid(index, 'stack needs at least two inputs');
  const { width, height } = ctx.canvas();
  const pads = order.map((input) => {
    const segment = segmentOf(ctx, input, index, 'stack');
    if (!segment.video) throw invalid(index, `stack: input ${input} has no video`);
    return segment.video;
  });
  const gap = step.gap;
  const color = step.background;
  let filters: (i: number) => string[];
  let layout: string;
  let outWidth: number;
  let outHeight: number;
  if (step.layout === 'grid') {
    const columns = Math.min(step.columns, pads.length);
    const rows = Math.ceil(pads.length / columns);
    filters = () => fitVideo(width, height, ctx.canvas().fps).slice(0, 3);
    layout = pads
      .map((_, i) => `${(i % columns) * (width + gap)}_${Math.floor(i / columns) * (height + gap)}`)
      .join('|');
    outWidth = columns * width + (columns - 1) * gap;
    outHeight = rows * height + (rows - 1) * gap;
  } else if (step.layout === 'horizontal') {
    filters = () => [`scale=-2:${height}`, 'setsar=1'];
    layout = '';
    outWidth = 0;
    outHeight = height;
  } else {
    filters = () => [`scale=${width}:-2`, 'setsar=1'];
    layout = '';
    outWidth = width;
    outHeight = 0;
  }
  const fitted = pads.map((pad, i) => ctx.graph.chain(pad, filters(i)));
  const out = ctx.graph.newPad('v');
  const ins = fitted.map((pad) => `[${ctx.graph.read(pad)}]`).join('');
  if (step.layout === 'grid') {
    ctx.graph.segment(
      `${ins}xstack=inputs=${fitted.length}:layout=${layout}:fill=${color}:shortest=1[${out.label}]`,
    );
  } else {
    // xstack places each part after the previous one plus the gap.
    const horizontal = step.layout === 'horizontal';
    const offsets = fitted.map((_, i) =>
      horizontal
        ? `${
            i === 0
              ? '0'
              : fitted
                  .slice(0, i)
                  .map((__, j) => `w${j}`)
                  .join('+') + `+${gap * i}`
          }_0`
        : `0_${
            i === 0
              ? '0'
              : fitted
                  .slice(0, i)
                  .map((__, j) => `h${j}`)
                  .join('+') + `+${gap * i}`
          }`,
    );
    ctx.graph.segment(
      `${ins}xstack=inputs=${fitted.length}:layout=${offsets.join('|')}:fill=${color}:shortest=1[${out.label}]`,
    );
  }
  ctx.state.video = out;
  ctx.state.width = outWidth || null;
  ctx.state.height = outHeight || null;
  ctx.state.filtered = true;
  ctx.filterCost(ctx.minutes, 0.3 * pads.length);
}

function chromakey(ctx: FilterContext, step: Of<'chromakey'>, index: number): void {
  const foreground = ctx.video(index, 'chromakey');
  const { width, height, fps } = ctx.canvas();
  const keyed = ctx.graph.chain(foreground, [
    `chromakey=color=${step.color}:similarity=${num(step.similarity)}:blend=${num(step.blend)}`,
  ]);
  const background =
    'input' in step.background
      ? ctx.graph.chain(ctx.inputPad(step.background.input, 'v', index, 'chromakey background'), [
          ...(isStill(ctx, step.background.input) ? ['loop=loop=-1:size=1'] : []),
          `scale=${width}:${height}`,
          'setsar=1',
          `fps=${fps}`,
        ])
      : source(
          ctx,
          'v',
          `color=c=${step.background.color}:s=${width}x${height}:r=${fps}:d=${num(ctx.duration(index, 'chromakey'))}`,
        );
  const out = ctx.graph.newPad('v');
  ctx.graph.segment(
    `[${ctx.graph.read(background)}][${ctx.graph.read(keyed)}]overlay=shortest=1:format=auto[${out.label}]`,
  );
  ctx.state.video = ctx.graph.chain(out, ['format=yuv420p']);
  ctx.state.filtered = true;
}

/** Each image held for duration_each_s (or panned with ken_burns), joined like concat. */
function slideshow(ctx: FilterContext, step: Of<'slideshow'>, index: number): void {
  if (ctx.touched)
    throw invalid(index, 'slideshow builds the picture from images; make it the first step');
  const images = step.images ?? ctx.inputs.map((_, i) => i).filter((i) => i !== step.audio);
  const { width, height } = step.size;
  const frames = Math.round(step.duration_each_s * step.fps);
  const segments = images.map((input) => {
    const still = ctx.inputPad(input, 'v', index, 'slideshow');
    const motion = step.ken_burns
      ? [
          `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
          `crop=${width * 2}:${height * 2}`,
          `zoompan=z='min(zoom+0.0015,1.3)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${step.fps}`,
        ]
      : [
          ...fitVideo(width, height, step.fps, step.fit).slice(0, -2),
          `loop=loop=${frames}:size=1`,
          `fps=${step.fps}`,
        ];
    const video = ctx.graph.chain(still, [
      ...motion,
      `trim=duration=${num(step.duration_each_s)}`,
      'setpts=PTS-STARTPTS',
      'format=yuv420p',
    ]);
    return { video, audio: null, duration: step.duration_each_s };
  });
  ctx.state.audio = null;
  ctx.state.width = width;
  ctx.state.height = height;
  ctx.state.fps = step.fps;
  join(ctx, segments, index, { transition: step.transition });
  if (step.audio !== undefined) {
    const total = ctx.duration(index, 'slideshow');
    const music = ctx.inputPad(step.audio, 'a', index, 'slideshow audio');
    ctx.state.audio = ctx.graph.chain(music, [
      `atrim=duration=${num(total)}`,
      `afade=t=out:st=${num(Math.max(0, total - 1))}:d=1`,
      ...fitAudio,
    ]);
    ctx.state.sampleRate = 48_000;
  }
  ctx.filterCost(ctx.minutes, step.ken_burns ? 1 : 0.2);
}

const WAVE_COLORS = {
  white: 'white',
  fire: 'orange|red',
  ice: 'cyan|blue',
  rainbow: 'red|yellow|green|blue',
  green: 'lime',
} as const;
const SPECTRUM_COLORS = {
  white: 'intensity',
  fire: 'fire',
  ice: 'cool',
  rainbow: 'rainbow',
  green: 'green',
} as const;

function audioToVideo(ctx: FilterContext, step: Of<'audio_to_video'>, index: number): void {
  const audio = ctx.audio(index, 'audio_to_video');
  const total = ctx.duration(index, 'audio_to_video');
  const { width, height } = step.size;
  const dims = `${width}x${height}`;
  let video: Pad;
  switch (step.visual) {
    case 'waveform':
      video = ctx.graph.chain(
        audio,
        [
          `showwaves=s=${dims}:mode=cline:rate=25:colors=${WAVE_COLORS[step.colors]}`,
          'format=yuv420p',
        ],
        'v',
      );
      break;
    case 'spectrum':
      video = ctx.graph.chain(
        audio,
        [
          `showspectrum=s=${dims}:mode=combined:slide=scroll:color=${SPECTRUM_COLORS[step.colors]}`,
          'fps=25',
          'format=yuv420p',
        ],
        'v',
      );
      break;
    case 'bars':
      video = ctx.graph.chain(
        audio,
        [
          // Its own rate option: an fps filter after showfreqs stalls on its timestamps.
          `showfreqs=s=${dims}:mode=bar:cmode=combined:overlap=0:rate=25:colors=${WAVE_COLORS[step.colors]}`,
          'format=yuv420p',
        ],
        'v',
      );
      break;
    case 'cover': {
      if (step.cover === undefined) throw invalid(index, 'visual "cover" needs a cover input');
      const frames = Math.ceil(total * 25);
      const cover = ctx.resolveInput(step.cover, index, 'audio_to_video');
      video = ctx.graph.chain(ctx.inputPad(cover, 'v', index, 'audio_to_video cover'), [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${step.background}`,
        'setsar=1',
        `loop=loop=${frames}:size=1`,
        'fps=25',
        `trim=duration=${num(total)}`,
        'format=yuv420p',
      ]);
      break;
    }
    case 'none':
      video = source(
        ctx,
        'v',
        `color=c=${step.background}:s=${dims}:r=25:d=${num(total)},format=yuv420p`,
      );
      break;
  }
  ctx.state.video = video;
  Object.assign(ctx.state, { width, height, fps: 25, filtered: true });
  ctx.filterCost(total / 60, 0.3);
}

function generate(ctx: FilterContext, step: Of<'generate'>, index: number): void {
  if (step.kind === 'slate' && !step.text) throw invalid(index, 'a slate needs text');
  const canvas = ctx.canvas();
  const width = step.size?.width ?? canvas.width;
  const height = step.size?.height ?? canvas.height;
  const fps = step.fps ?? canvas.fps;
  const d = num(step.duration_s);
  const visual = ['black', 'color', 'test_pattern', 'slate'].includes(step.kind);
  const slate = step.kind === 'slate' ? slateText(ctx, step.text ?? '', height, index) : '';
  const video = visual
    ? source(
        ctx,
        'v',
        step.kind === 'test_pattern'
          ? `testsrc2=s=${width}x${height}:r=${fps}:d=${d},format=yuv420p`
          : `color=c=${step.kind === 'black' ? 'black' : step.color}:s=${width}x${height}:r=${fps}:d=${d},format=yuv420p${slate}`,
      )
    : null;
  const tone =
    step.kind === 'tone'
      ? `sine=f=${num(step.frequency_hz)}:r=${step.sample_rate}:d=${d}`
      : step.kind === 'noise'
        ? `anoisesrc=d=${d}:r=${step.sample_rate}:a=0.1`
        : `anullsrc=r=${step.sample_rate}:cl=stereo:d=${d}`;
  const audio = visual
    ? null
    : source(ctx, 'a', `${tone},aformat=sample_fmts=fltp:channel_layouts=stereo`);
  const clip: Segment = { video, audio, duration: step.duration_s };
  if (step.place === 'replace') {
    Object.assign(ctx.state, {
      video,
      audio,
      duration: step.duration_s,
      width: video ? width : null,
      height: video ? height : null,
      fps: video ? fps : null,
      sampleRate: audio ? step.sample_rate : null,
      filtered: true,
      timeAltered: true,
    });
    return;
  }
  const working: Segment = {
    video: ctx.state.video,
    audio: ctx.state.audio,
    duration: ctx.state.duration,
  };
  join(ctx, step.place === 'before' ? [clip, working] : [working, clip], index, {});
}

/** Centred white text for a slate, from a service-written file. */
function slateText(ctx: FilterContext, text: string, height: number, index: number): string {
  const file = graphPath(path.join(ctx.workDir, `slate-${index}.txt`));
  ctx.writeFile(file, text);
  const size = Math.max(16, Math.round(height / 12));
  const parts = [
    `fontfile=${fontFile(ctx, 'DejaVu Sans', index)}`,
    `textfile=${file}`,
    'expansion=none',
    `fontsize=${size}`,
  ];
  return `,${drawtext([...parts, 'fontcolor=white', 'x=(w-text_w)/2', 'y=(h-text_h)/2', 'text_align=C'])}`;
}

function mixAudio(ctx: FilterContext, step: Of<'mix_audio'>, index: number): void {
  const main = ctx.audio(index, 'mix_audio');
  if (step.weights && step.weights.length !== step.inputs.length + 1)
    throw invalid(index, 'weights needs one value for the main audio and one per input');
  const others = step.inputs.map((input) => {
    const pad = ctx.graph.chain(ctx.inputPad(input, 'a', index, 'mix_audio'), fitAudio);
    if (!step.duck) return pad;
    // The added audio (music) is pressed down while the main audio (voice) speaks.
    const ducked = ctx.graph.newPad('a');
    const { threshold_db, ratio, attack_ms, release_ms } = step.duck;
    ctx.graph.segment(
      `[${ctx.graph.read(pad)}][${ctx.graph.read(main)}]sidechaincompress=threshold=${num(linear(threshold_db))}:ratio=${num(ratio)}:attack=${num(attack_ms)}:release=${num(release_ms)}[${ducked.label}]`,
    );
    return ducked;
  });
  const fittedMain = ctx.graph.chain(main, fitAudio);
  const out = ctx.graph.newPad('a');
  const weights = step.weights ? `:weights='${step.weights.map(num).join(' ')}'` : '';
  ctx.graph.segment(
    `[${ctx.graph.read(fittedMain)}]${others.map((pad) => `[${ctx.graph.read(pad)}]`).join('')}amix=inputs=${others.length + 1}:duration=first:dropout_transition=0:normalize=${step.normalize ? 1 : 0}${weights}[${out.label}]`,
  );
  ctx.state.audio = out;
  ctx.state.sampleRate = 48_000;
  ctx.state.filtered = true;
}

function offsetAudio(ctx: FilterContext, pad: Pad, offsetMs: number): Pad {
  if (offsetMs > 0) return ctx.graph.chain(pad, [`adelay=delays=${offsetMs}:all=1`]);
  if (offsetMs < 0)
    return ctx.graph.chain(pad, [`atrim=start=${num(-offsetMs / 1000)}`, 'asetpts=PTS-STARTPTS']);
  return pad;
}

export const compositionHandlers: {
  [K in CompositionStep['op']]: (ctx: FilterContext, step: Of<K>, index: number) => void;
} = {
  concat(ctx, step, index) {
    const order = step.inputs ?? ctx.inputs.map((_, i) => i);
    if (order.length < 2) throw invalid(index, 'concat needs at least two inputs');
    if (step.mode === 'copy') {
      if (order[0] !== 0 || step.transition)
        throw invalid(index, 'concat mode "copy" starts with input 0 and has no transition');
      concatCopy(ctx, order, index);
      return;
    }
    join(
      ctx,
      order.map((input) => segmentOf(ctx, input, index, 'concat')),
      index,
      { transition: step.transition, crossfade: step.audio_crossfade_s },
    );
  },
  overlay_image: overlayImage,
  overlay_video: overlayVideo,
  stack,
  chromakey,
  slideshow,
  audio_to_video: audioToVideo,
  generate,
  mix_audio: mixAudio,
  replace_audio(ctx, step, index) {
    ctx.state.audio = offsetAudio(
      ctx,
      ctx.inputPad(step.input, 'a', index, 'replace_audio'),
      step.offset_ms,
    );
    ctx.state.audioLabel = { language: step.language, title: step.title };
    ctx.state.sampleRate =
      ctx.inputs[step.input]?.probe.streams.find((stream) => stream.type === 'audio')
        ?.sample_rate ?? null;
    ctx.state.filtered = true;
  },
  add_audio_track(ctx, step, index) {
    const pad = offsetAudio(
      ctx,
      ctx.inputPad(step.input, 'a', index, 'add_audio_track'),
      step.offset_ms,
    );
    ctx.state.extraAudio.push({
      pad,
      language: step.language,
      title: step.title,
      default: step.default,
    });
  },
  select_streams(ctx, step, index) {
    if (ctx.touched)
      throw invalid(index, 'select_streams picks input streams; make it the first step');
    if (step.video !== undefined)
      ctx.state.video = ctx.inputPad(0, 'v', index, 'select_streams video', step.video);
    if (step.audio) {
      const [first, ...rest] = step.audio.map((n) =>
        ctx.inputPad(0, 'a', index, 'select_streams audio', n),
      );
      ctx.state.audio = first ?? null;
      ctx.state.extraAudio.push(...rest.map((pad) => ({ pad })));
    }
  },
  extract_streams(ctx, step, index) {
    extractStream(ctx, step, index);
  },
};

/** File type for an extracted stream: [container args, extension, mime]. */
const EXTRACT: Record<
  string,
  { mux: string; ext: string; mime: string; raw?: { mux: string; ext: string; bsf?: string } }
> = {
  h264: {
    mux: 'mp4',
    ext: 'mp4',
    mime: 'video/mp4',
    raw: { mux: 'h264', ext: 'h264', bsf: 'h264_mp4toannexb' },
  },
  hevc: {
    mux: 'mp4',
    ext: 'mp4',
    mime: 'video/mp4',
    raw: { mux: 'hevc', ext: 'hevc', bsf: 'hevc_mp4toannexb' },
  },
  av1: { mux: 'mp4', ext: 'mp4', mime: 'video/mp4', raw: { mux: 'obu', ext: 'obu' } },
  vp9: { mux: 'webm', ext: 'webm', mime: 'video/webm', raw: { mux: 'ivf', ext: 'ivf' } },
  vp8: { mux: 'webm', ext: 'webm', mime: 'video/webm', raw: { mux: 'ivf', ext: 'ivf' } },
  aac: { mux: 'ipod', ext: 'm4a', mime: 'audio/mp4', raw: { mux: 'adts', ext: 'aac' } },
  mp3: { mux: 'mp3', ext: 'mp3', mime: 'audio/mpeg' },
  opus: { mux: 'opus', ext: 'opus', mime: 'audio/ogg' },
  vorbis: { mux: 'ogg', ext: 'ogg', mime: 'audio/ogg' },
  flac: { mux: 'flac', ext: 'flac', mime: 'audio/flac' },
  ac3: { mux: 'ac3', ext: 'ac3', mime: 'audio/ac3' },
  eac3: { mux: 'eac3', ext: 'eac3', mime: 'audio/eac3' },
  subrip: { mux: 'srt', ext: 'srt', mime: 'application/x-subrip' },
  ass: { mux: 'ass', ext: 'ass', mime: 'text/x-ssa' },
  webvtt: { mux: 'webvtt', ext: 'vtt', mime: 'text/vtt' },
};

function extractStream(ctx: FilterContext, step: Of<'extract_streams'>, index: number): void {
  const name = ctx.name(index);
  const type = step.stream;
  const streams =
    ctx.inputs[0]?.probe.streams.filter((stream) => stream.type === type && !stream.attached_pic) ??
    [];
  const stream = streams[step.index];
  if (!stream) throw invalid(index, `the input has no ${type} stream ${step.index}`);
  const letter = type === 'video' ? 'V' : type === 'audio' ? 'a' : 's';
  // mov_text subtitles become SRT; everything else keeps its codec.
  const convert = stream.codec === 'mov_text';
  const kind = EXTRACT[convert ? 'subrip' : (stream.codec ?? '')];
  if (!kind)
    throw invalid(index, `extracting ${stream.codec ?? 'unknown'} streams is not supported`);
  const raw = step.raw ? kind.raw : undefined;
  if (step.raw && !raw)
    throw invalid(index, `${stream.codec ?? 'this codec'} has no raw form; leave raw off`);
  const ext = raw?.ext ?? kind.ext;
  const target = ctx.outputTarget(name, ext);
  ctx.addOutput(
    {
      maps: [`0:${letter}:${step.index}`],
      args: [
        `-c`,
        convert ? 'srt' : 'copy',
        ...(raw?.bsf ? ['-bsf:v', raw.bsf] : []),
        ...ctx.threadArgs(),
        '-fs',
        String(ctx.maxFileBytes),
        '-f',
        raw?.mux ?? kind.mux,
      ],
      target,
      durationS: ctx.state.duration,
    },
    {
      name,
      op: 'extract_streams',
      role: type === 'video' ? 'media' : type === 'audio' ? 'audio' : 'subtitles',
      pattern: path.basename(target),
      multiple: false,
      mime: kind.mime,
    },
  );
}
