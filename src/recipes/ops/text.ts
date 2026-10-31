import path from 'node:path';

import { z } from 'zod';

import { type FilterContext, graphPath, type InputRef, invalid } from '../context';
import { num } from '../graph';
import { colorValue, hasControlCharacters, outputName, timeValue } from '../values';

/** Text and subtitles (SPEC §8f). Text never enters the filtergraph: it goes to a file. */

export const inputRef = z.union([
  z.number().int().min(0).max(499),
  z.strictObject({
    job_output: z.enum(['subtitles', 'thumbnail']),
    lang: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,20}$/)
      .optional(),
  }),
]);
const font = z.string().regex(/^[\p{L}\p{N} ._-]{1,100}$/u, 'a font family name');
const subtitleFormat = z.enum(['srt', 'vtt', 'ass']);
const textPosition = z.enum([
  'top_left',
  'top_center',
  'top_right',
  'center_left',
  'center',
  'center_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
]);
const language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'a BCP-47 language code');

export const textSchemas = [
  z.strictObject({
    op: z.literal('text'),
    text: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => !hasControlCharacters(value), 'must not contain control characters')
      .optional(),
    timecode: z.boolean().default(false),
    font: font.default('DejaVu Sans'),
    bold: z.boolean().default(false),
    italic: z.boolean().default(false),
    size: z.number().int().min(8).max(300).default(36),
    color: colorValue.default('white'),
    opacity: z.number().min(0).max(1).default(1),
    position: textPosition.default('bottom_center'),
    x: z.number().int().min(0).max(7680).optional(),
    y: z.number().int().min(0).max(7680).optional(),
    margin: z.number().int().min(0).max(500).default(30),
    box: z
      .strictObject({
        color: colorValue.default('black'),
        opacity: z.number().min(0).max(1).default(0.5),
        padding: z.number().int().min(0).max(100).default(10),
      })
      .optional(),
    outline: z
      .strictObject({
        color: colorValue.default('black'),
        width: z.number().int().min(1).max(20).default(2),
      })
      .optional(),
    shadow: z
      .strictObject({
        x: z.number().int().min(-20).max(20).default(2),
        y: z.number().int().min(-20).max(20).default(2),
        color: colorValue.default('black'),
      })
      .optional(),
    align: z.enum(['left', 'center', 'right']).default('center'),
    line_spacing: z.number().int().min(0).max(100).default(0),
    start: timeValue.optional(),
    end: timeValue.optional(),
  }),
  z.strictObject({
    op: z.literal('subtitles_burn'),
    input: inputRef.optional(),
    track: z.number().int().min(0).max(31).optional(),
    style: z
      .strictObject({
        font: font.optional(),
        size: z.number().int().min(8).max(200).optional(),
        color: colorValue.optional(),
        outline_color: colorValue.optional(),
        outline: z.number().min(0).max(10).optional(),
        shadow: z.number().min(0).max(10).optional(),
        position: z.enum(['bottom', 'middle', 'top']).optional(),
        margin_v: z.number().int().min(0).max(500).optional(),
        background: z.boolean().optional(),
      })
      .default({}),
    charenc: z
      .string()
      .regex(/^[A-Za-z0-9_-]{2,20}$/, 'an encoding name such as CP1252')
      .optional(),
    shift_ms: z.number().int().min(-600_000).max(600_000).default(0),
  }),
  z.strictObject({
    op: z.literal('subtitles_mux'),
    input: inputRef.optional(),
    track: z.number().int().min(0).max(31).optional(),
    language: language.optional(),
    title: z
      .string()
      .max(64)
      .refine((value) => !hasControlCharacters(value))
      .optional(),
    default: z.boolean().default(false),
    forced: z.boolean().default(false),
    format: z.enum(['mov_text', 'srt', 'ass', 'webvtt']).optional(),
  }),
  z.strictObject({
    op: z.literal('subtitles_extract'),
    name: outputName.optional(),
    tracks: z.array(z.number().int().min(0).max(31)).min(1).max(32).optional(),
    format: subtitleFormat.default('srt'),
  }),
  z.strictObject({
    op: z.literal('subtitles_convert'),
    name: outputName.optional(),
    format: subtitleFormat,
  }),
  z.strictObject({
    op: z.literal('subtitles_shift'),
    ms: z.number().int().min(-600_000).max(600_000),
  }),
  z.strictObject({ op: z.literal('subtitles_strip') }),
] as const;

export type TextStep = z.output<(typeof textSchemas)[number]>;
type Of<K extends TextStep['op']> = Extract<TextStep, { op: K }>;

export const SUBTITLE_FORMATS = {
  srt: { codec: 'srt', muxer: 'srt', ext: 'srt', mime: 'application/x-subrip' },
  vtt: { codec: 'webvtt', muxer: 'webvtt', ext: 'vtt', mime: 'text/vtt' },
  ass: { codec: 'ass', muxer: 'ass', ext: 'ass', mime: 'text/x-ssa' },
} as const;
const TEXT_CODECS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const BITMAP_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
const SUBTITLE_EXT: Record<string, string> = { srt: 'srt', webvtt: 'vtt', ass: 'ass' };

/** The font file for a family, or a refusal naming what is installed. */
export function fontFile(
  ctx: FilterContext,
  family: string,
  index: number,
  options: { bold?: boolean; italic?: boolean } = {},
): string {
  const file = ctx.fonts?.face(family, options);
  if (!file) {
    const installed = ctx.fonts?.list().slice(0, 30).join(', ') ?? 'none';
    throw invalid(index, `font "${family}" is not installed (installed: ${installed})`);
  }
  return graphPath(file);
}

/** drawtext x/y for a position menu entry. */
function textXY(position: z.output<typeof textPosition>, margin: number): { x: string; y: string } {
  const [vertical, horizontal = 'center'] =
    position === 'center' ? ['center', 'center'] : position.split('_');
  const x =
    horizontal === 'left'
      ? String(margin)
      : horizontal === 'right'
        ? `w-text_w-${margin}`
        : '(w-text_w)/2';
  const y =
    vertical === 'top'
      ? String(margin)
      : vertical === 'bottom'
        ? `h-text_h-${margin}`
        : '(h-text_h)/2';
  return { x, y };
}

/** A drawtext filter for server-chosen or file-held text (SPEC §8f `text`). */
export function drawtext(parts: string[]): string {
  return `drawtext=${parts.join(':')}`;
}

function text(ctx: FilterContext, step: Of<'text'>, index: number): void {
  ctx.video(index, 'text');
  if (!step.text && !step.timecode) throw invalid(index, 'text needs text or timecode');
  const parts = [
    `fontfile=${fontFile(ctx, step.font, index, { bold: step.bold, italic: step.italic })}`,
  ];
  if (step.timecode) {
    parts.push(`timecode='00\\:00\\:00\\:00'`, `rate=${num(ctx.state.fps ?? 25)}`);
  } else {
    const file = graphPath(path.join(ctx.workDir, `text-${index}.txt`));
    ctx.writeFile(file, step.text ?? '');
    // expansion=none: %{…} sequences in the text stay literal.
    parts.push(`textfile=${file}`, 'expansion=none');
  }
  const { x, y } =
    step.x !== undefined && step.y !== undefined
      ? { x: String(step.x), y: String(step.y) }
      : textXY(step.position, step.margin);
  parts.push(
    `fontsize=${step.size}`,
    `fontcolor=${step.color}@${num(step.opacity)}`,
    `x=${x}`,
    `y=${y}`,
  );
  parts.push(
    `text_align=${{ left: 'L', center: 'C', right: 'R' }[step.align]}`,
    `line_spacing=${step.line_spacing}`,
  );
  if (step.box)
    parts.push(
      'box=1',
      `boxcolor=${step.box.color}@${num(step.box.opacity)}`,
      `boxborderw=${step.box.padding}`,
    );
  if (step.outline)
    parts.push(`borderw=${step.outline.width}`, `bordercolor=${step.outline.color}`);
  if (step.shadow)
    parts.push(
      `shadowx=${step.shadow.x}`,
      `shadowy=${step.shadow.y}`,
      `shadowcolor=${step.shadow.color}`,
    );
  if (step.start !== undefined || step.end !== undefined)
    parts.push(`enable='between(t,${num(step.start ?? 0)},${num(step.end ?? 864_000)})'`);
  ctx.applyFilters([drawtext(parts)], null);
}

/** ASS colour &HAABBGGRR from "0xRRGGBB". */
const assColor = (color: string) =>
  `&H00${color.slice(6, 8)}${color.slice(4, 6)}${color.slice(2, 4)}`;

/** A subtitle source as a job-directory file: (file, stream index inside it, codec). */
function subtitleSource(
  ctx: FilterContext,
  step: { input?: InputRef | undefined; track?: number | undefined },
  index: number,
  op: string,
) {
  if ((step.input === undefined) === (step.track === undefined))
    throw invalid(index, `${op} takes input or track`);
  const input = step.input === undefined ? 0 : ctx.resolveInput(step.input, index, op);
  const source = ctx.inputs[input];
  const streams = source?.probe.streams.filter((stream) => stream.type === 'subtitle') ?? [];
  const position = step.track ?? 0;
  const stream = streams[position];
  if (!source || !stream)
    throw invalid(index, `${op}: input ${input} has no subtitle stream ${position}`);
  // libass reads the file by name; only plain names inside the job directory reach the graph.
  const ext =
    SUBTITLE_EXT[source.probe.format ?? ''] ??
    (path.extname(source.path).replace(/[^.A-Za-z0-9]/g, '') || '.mkv').replace(/^\./, '');
  const file = graphPath(path.join(ctx.workDir, `subtitles-${index}.${ext}`));
  ctx.link(file, source.path);
  return { input, file, position, codec: stream.codec, map: `${input}:s:${position}` };
}

function burn(ctx: FilterContext, step: Of<'subtitles_burn'>, index: number): void {
  const video = ctx.video(index, 'subtitles_burn');
  const source = subtitleSource(ctx, step, index, 'subtitles_burn');
  if (BITMAP_CODECS.has(source.codec ?? '')) {
    // Picture subtitles (PGS, DVD) are images already: laid over the picture.
    const out = ctx.graph.newPad('v');
    ctx.graph.segment(
      `[${ctx.graph.read(video)}][${source.map}]overlay=eof_action=pass[${out.label}]`,
    );
    ctx.state.video = out;
    ctx.state.filtered = true;
    return;
  }
  if (!TEXT_CODECS.has(source.codec ?? ''))
    throw invalid(index, `subtitles of type ${source.codec ?? 'unknown'} cannot be burned in`);
  let file = source.file;
  let streamIndex = source.position;
  if (step.shift_ms !== 0) {
    // libass has no time offset: a pre-pass writes a shifted copy.
    file = graphPath(path.join(ctx.workDir, `subtitles-${index}-shifted.ass`));
    ctx.addPreStage(`shift subtitles ${index}`, [
      '-itsoffset',
      num(step.shift_ms / 1000),
      '-protocol_whitelist',
      'file',
      '-i',
      source.file,
      '-map',
      `0:s:${source.position}`,
      '-c:s',
      'ass',
      '-y',
      file,
    ]);
    streamIndex = 0;
  }
  const style = step.style;
  const forced = [
    style.font && `FontName=${style.font}`,
    style.size !== undefined && `FontSize=${style.size}`,
    style.color && `PrimaryColour=${assColor(style.color)}`,
    style.outline_color && `OutlineColour=${assColor(style.outline_color)}`,
    style.outline !== undefined && `Outline=${num(style.outline)}`,
    style.shadow !== undefined && `Shadow=${num(style.shadow)}`,
    style.position && `Alignment=${{ bottom: 2, middle: 5, top: 8 }[style.position]}`,
    style.margin_v !== undefined && `MarginV=${style.margin_v}`,
    style.background && 'BorderStyle=3',
  ].filter((part): part is string => typeof part === 'string');
  if (style.font) fontFile(ctx, style.font, index);
  const options = [
    `filename=${file}`,
    ...(streamIndex > 0 ? [`si=${streamIndex}`] : []),
    ...(ctx.fontDir ? [`fontsdir=${graphPath(ctx.fontDir)}`] : []),
    ...(step.charenc ? [`charenc=${step.charenc}`] : []),
    ...(forced.length > 0 ? [`force_style='${forced.join(',')}'`] : []),
  ];
  ctx.applyFilters([`subtitles=${options.join(':')}`], null);
  ctx.filterCost(ctx.minutes, 0.3);
}

function extract(ctx: FilterContext, step: Of<'subtitles_extract'>, index: number): void {
  const name = ctx.name(index);
  const streams = ctx.inputs[0]?.probe.streams.filter((stream) => stream.type === 'subtitle') ?? [];
  const tracks = step.tracks ?? streams.map((_, i) => i);
  if (tracks.length === 0) throw invalid(index, 'the input has no subtitle tracks');
  const format = SUBTITLE_FORMATS[step.format];
  for (const track of tracks) {
    const stream = streams[track];
    if (!stream) throw invalid(index, `the input has no subtitle track ${track}`);
    if (!TEXT_CODECS.has(stream.codec ?? ''))
      throw invalid(
        index,
        `track ${track} (${stream.codec ?? 'unknown'}) is a picture subtitle; it cannot become ${step.format}`,
      );
    const label = `${name}.${stream.language ?? track}`;
    const target = ctx.outputTarget(label, format.ext);
    ctx.addOutput(
      {
        maps: [`0:s:${track}`],
        args: ['-c:s', format.codec, '-f', format.muxer],
        target,
        durationS: null,
      },
      {
        name: label,
        op: 'subtitles_extract',
        role: 'subtitles',
        pattern: path.basename(target),
        multiple: false,
        mime: format.mime,
      },
    );
  }
}

export const textHandlers: {
  [K in TextStep['op']]: (ctx: FilterContext, step: Of<K>, index: number) => void;
} = {
  text,
  subtitles_burn: burn,
  subtitles_mux(ctx, step, index) {
    const source = subtitleSource(ctx, step, index, 'subtitles_mux');
    if (!TEXT_CODECS.has(source.codec ?? '') && step.format)
      throw invalid(index, 'picture subtitles keep their format');
    ctx.state.subtitles.push({
      map: source.map,
      codec: source.codec,
      format: step.format,
      language: step.language,
      title: step.title,
      default: step.default,
      forced: step.forced,
    });
  },
  subtitles_extract: extract,
  subtitles_convert(ctx, step, index) {
    const name = ctx.name(index);
    const stream = ctx.inputs[0]?.probe.streams.find((entry) => entry.type === 'subtitle');
    if (!stream || ctx.inputs[0]?.probe.streams.some((entry) => entry.type !== 'subtitle')) {
      throw invalid(
        index,
        'subtitles_convert works on a subtitle file input; use subtitles_extract for tracks in media',
      );
    }
    const format = SUBTITLE_FORMATS[step.format];
    const target = ctx.outputTarget(name, format.ext);
    ctx.addOutput(
      {
        maps: ['0:s:0'],
        args: ['-c:s', format.codec, '-f', format.muxer],
        target,
        durationS: null,
      },
      {
        name,
        op: 'subtitles_convert',
        role: 'subtitles',
        pattern: path.basename(target),
        multiple: false,
        mime: format.mime,
      },
    );
  },
  subtitles_shift(ctx, step, index) {
    if (ctx.touched)
      throw invalid(index, 'subtitles_shift moves the input; make it the first step');
    if (ctx.inputs[0]?.probe.streams.some((entry) => entry.type !== 'subtitle')) {
      throw invalid(
        index,
        'subtitles_shift works on a subtitle file input; subtitles_burn has shift_ms',
      );
    }
    ctx.addInputArgs('-itsoffset', num(step.ms / 1000));
  },
  subtitles_strip(ctx) {
    ctx.state.stripSubtitles = true;
    ctx.state.subtitles = [];
  },
};
