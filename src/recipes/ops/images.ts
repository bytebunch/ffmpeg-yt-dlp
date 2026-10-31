import path from 'node:path';

import { z } from 'zod';

import { type FilterContext, invalid } from '../context';
import { num, type Pad } from '../graph';
import { colorValue, outputName, timeValue } from '../values';
import { compositionHandlers, XFADE_TRANSITIONS } from './composition';

/** Images, sequences and pictures of sound (SPEC §8h, §8g audio_visual). */

const width = z.number().int().min(16).max(7680);
const stillFormat = z.enum(['jpg', 'png', 'webp']);
const named = { name: outputName.optional() };

export const imageSchemas = [
  z.strictObject({
    op: z.literal('thumbnails_scene'),
    ...named,
    threshold: z.number().min(0.1).max(0.9).default(0.4),
    max: z.number().int().min(1).max(200).default(20),
    min_gap_s: z.number().min(0).max(3600).default(1),
    width: width.optional(),
    format: stillFormat.default('jpg'),
    quality: z.number().int().min(1).max(100).default(85),
  }),
  z.strictObject({
    op: z.literal('storyboard'),
    ...named,
    interval_s: z.number().min(0.5).max(600).default(5),
    tile_width: z.number().int().min(32).max(640).default(160),
    columns: z.number().int().min(1).max(20).default(10),
    rows: z.number().int().min(1).max(20).default(10),
  }),
  z.strictObject({
    op: z.literal('animated_webp'),
    ...named,
    start: timeValue.default(0),
    end: timeValue.optional(),
    fps: z.number().int().min(1).max(30).default(12),
    width: z.number().int().min(16).max(1920).default(480),
    quality: z.number().int().min(0).max(100).default(75),
    lossless: z.boolean().default(false),
    loop: z.boolean().default(true),
  }),
  z.strictObject({
    op: z.literal('animated_avif'),
    ...named,
    start: timeValue.default(0),
    end: timeValue.optional(),
    fps: z.number().int().min(1).max(30).default(12),
    width: z.number().int().min(16).max(1920).default(480),
    quality: z.number().int().min(0).max(63).default(35),
    loop: z.boolean().default(true),
  }),
  z.strictObject({
    op: z.literal('frames'),
    ...named,
    every_s: z.number().min(0.01).max(3600).optional(),
    fps: z.number().min(0.01).max(120).optional(),
    all: z.boolean().default(false),
    format: stillFormat.default('jpg'),
    width: width.optional(),
    quality: z.number().int().min(1).max(100).default(85),
    zip: z.boolean().default(true),
  }),
  z.strictObject({
    op: z.literal('image_convert'),
    ...named,
    format: z.enum(['jpg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tiff']),
    quality: z.number().int().min(1).max(100).default(85),
    lossless: z.boolean().default(false),
    strip_metadata: z.boolean().default(true),
    background: colorValue.optional(),
  }),
  z.strictObject({
    op: z.literal('images_to_video'),
    ...named,
    duration_each_s: z.number().min(0.1).max(60).default(3),
    size: z
      .strictObject({
        width: z.number().int().min(16).max(7680),
        height: z.number().int().min(16).max(4320),
      })
      .default({ width: 1280, height: 720 }),
    fit: z.enum(['contain', 'cover']).default('contain'),
    transition: z
      .strictObject({
        type: z.enum(XFADE_TRANSITIONS).default('fade'),
        duration_s: z.number().min(0.1).max(5).default(1),
      })
      .optional(),
    audio: z.number().int().min(0).max(499).optional(),
    fps: z.number().int().min(1).max(60).default(30),
  }),
  z.strictObject({
    op: z.literal('ken_burns'),
    zoom_from: z.number().min(1).max(2).default(1),
    zoom_to: z.number().min(1).max(2).default(1.3),
    pan: z.enum(['center', 'left', 'right', 'up', 'down']).default('center'),
    duration_s: z.number().min(0.5).max(60).default(5),
    fps: z.number().int().min(1).max(60).default(30),
  }),
  z.strictObject({
    op: z.literal('poster_frame'),
    at: z.union([timeValue, z.string().regex(/^\d{1,3}(\.\d)?%$/)]).default('10%'),
  }),
  z.strictObject({
    op: z.literal('audio_visual'),
    ...named,
    kind: z.enum([
      'waveform_image',
      'spectrogram_image',
      'waveform_video',
      'spectrum_video',
      'bars_video',
      'vectorscope_video',
    ]),
    size: z
      .strictObject({
        width: z.number().int().min(64).max(7680),
        height: z.number().int().min(64).max(4320),
      })
      .default({ width: 1280, height: 360 }),
    colors: z.enum(['white', 'fire', 'ice', 'rainbow', 'green']).default('white'),
    mode: z.enum(['line', 'point', 'cline', 'p2p']).default('cline'),
    scale: z.enum(['lin', 'log', 'sqrt', 'cbrt']).default('lin'),
    split_channels: z.boolean().default(false),
  }),
] as const;

export type ImageStep = z.output<(typeof imageSchemas)[number]>;
type Of<K extends ImageStep['op']> = Extract<ImageStep, { op: K }>;

const STILL = {
  jpg: {
    args: (quality: number) => [
      '-c:v',
      'mjpeg',
      '-q:v',
      String(Math.round(2 + ((100 - quality) * 29) / 99)),
    ],
    mime: 'image/jpeg',
  },
  png: { args: () => ['-c:v', 'png'], mime: 'image/png' },
  webp: {
    args: (quality: number) => ['-c:v', 'libwebp', '-quality', String(quality)],
    mime: 'image/webp',
  },
} as const;
const WAVE = {
  white: 'white',
  fire: 'orange|red',
  ice: 'cyan|blue',
  rainbow: 'red|yellow|green|blue',
  green: 'lime',
} as const;
const SPECTRUM = {
  white: 'intensity',
  fire: 'fire',
  ice: 'cool',
  rainbow: 'rainbow',
  green: 'green',
} as const;

const map = (ctx: FilterContext, pad: Pad) => (pad.raw ? pad.label : `[${ctx.graph.read(pad)}]`);

/** WebVTT cues pointing at sprite regions (`sheet_001.jpg#xywh=…`), for player scrubbing previews. */
export function storyboardVtt(options: {
  duration: number;
  interval: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
}): string {
  const { duration, interval, tileWidth, tileHeight, columns, rows } = options;
  const stamp = (seconds: number) => {
    const ms = Math.round(seconds * 1000);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const cues = ['WEBVTT', ''];
  const count = Math.max(1, Math.ceil(duration / interval));
  for (let i = 0; i < count; i++) {
    const perSheet = columns * rows;
    const sheet = Math.floor(i / perSheet) + 1;
    const cell = i % perSheet;
    const x = (cell % columns) * tileWidth;
    const y = Math.floor(cell / columns) * tileHeight;
    cues.push(
      `${stamp(i * interval)} --> ${stamp(Math.min(duration, (i + 1) * interval))}`,
      `sheet_${String(sheet).padStart(3, '0')}.jpg#xywh=${x},${y},${tileWidth},${tileHeight}`,
      '',
    );
  }
  return cues.join('\n');
}

function animated(
  ctx: FilterContext,
  step: Of<'animated_webp'> | Of<'animated_avif'>,
  index: number,
): void {
  const name = ctx.name(index);
  const video = ctx.video(index, step.op);
  const total = ctx.state.duration;
  const max = ctx.limits.GIF_MAX_SECONDS;
  if (total !== null && step.start >= total)
    throw invalid(index, `${step.op} starts after the end of the media`);
  const end = step.end ?? Math.min(total ?? Infinity, step.start + max);
  if (end - step.start > max) throw invalid(index, `animations are limited to ${max} seconds`);
  const frames = ctx.graph.chain(video, [
    `trim=start=${num(step.start)}:end=${num(end)}`,
    'setpts=PTS-STARTPTS',
    `fps=${step.fps}`,
    `scale=w='min(${step.width},iw)':h=-2:flags=lanczos`,
  ]);
  const webp = step.op === 'animated_webp';
  const codec = webp
    ? [
        '-c:v',
        'libwebp_anim',
        '-lossless',
        step.lossless ? '1' : '0',
        '-quality',
        String(step.quality),
        '-loop',
        step.loop ? '0' : '1',
        '-f',
        'webp',
      ]
    : [
        '-c:v',
        'libaom-av1',
        '-crf',
        String(step.quality),
        '-b:v',
        '0',
        '-cpu-used',
        '8',
        '-row-mt',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-loop',
        step.loop ? '0' : '1',
        '-f',
        'avif',
      ];
  const ext = webp ? 'webp' : 'avif';
  const target = ctx.outputTarget(name, ext);
  ctx.addOutput(
    {
      maps: [map(ctx, frames)],
      args: [...codec.slice(0, -2), ...ctx.threadArgs(), ...codec.slice(-2)],
      target,
      durationS: end - step.start,
    },
    {
      name,
      op: step.op,
      role: 'image',
      pattern: path.basename(target),
      multiple: false,
      mime: `image/${ext}`,
    },
  );
  ctx.addCost(((end - step.start) / 60) * (webp ? 2 : 6));
}

export const imageHandlers: {
  [K in ImageStep['op']]: (ctx: FilterContext, step: Of<K>, index: number) => void;
} = {
  thumbnails_scene(ctx, step, index) {
    const name = ctx.name(index);
    const video = ctx.video(index, 'thumbnails_scene');
    const pick = `select='gt(scene,${num(step.threshold)})*(isnan(prev_selected_t)+gte(t-prev_selected_t,${num(step.min_gap_s)}))'`;
    const pad = ctx.graph.chain(video, [pick, ...(step.width ? [`scale=${step.width}:-2`] : [])]);
    const target = ctx.outputTarget(name, step.format, true);
    ctx.addOutput(
      {
        maps: [map(ctx, pad)],
        args: [
          ...STILL[step.format].args(step.quality),
          '-fps_mode',
          'vfr',
          '-frames:v',
          String(step.max),
          '-start_number',
          '1',
          '-f',
          'image2',
        ],
        target,
        durationS: ctx.state.duration,
      },
      {
        name,
        op: 'thumbnails_scene',
        role: 'thumbnail',
        pattern: path.basename(target),
        multiple: true,
        mime: STILL[step.format].mime,
      },
    );
    ctx.filterCost(ctx.minutes, 0.3);
  },
  storyboard(ctx, step, index) {
    const name = ctx.name(index);
    const video = ctx.video(index, 'storyboard');
    const total = ctx.duration(index, 'storyboard');
    const { width: w, height: h } = ctx.canvas();
    const tileHeight = Math.max(2, Math.round((step.tile_width * h) / w / 2) * 2);
    const dir = ctx.outputTarget(name, '').replace(/\.$/, '');
    ctx.writeFile(
      path.join(dir, 'storyboard.vtt'),
      storyboardVtt({
        duration: total,
        interval: step.interval_s,
        tileWidth: step.tile_width,
        tileHeight,
        columns: step.columns,
        rows: step.rows,
      }),
    );
    const pad = ctx.graph.chain(video, [
      `fps=fps=1/${num(step.interval_s)}`,
      `scale=${step.tile_width}:${tileHeight}`,
      `tile=${step.columns}x${step.rows}`,
    ]);
    ctx.addOutput(
      {
        maps: [map(ctx, pad)],
        args: [...STILL.jpg.args(80), '-fps_mode', 'vfr', '-start_number', '1', '-f', 'image2'],
        target: path.join(dir, 'sheet_%03d.jpg'),
        durationS: total,
      },
      {
        name,
        op: 'storyboard',
        role: 'package',
        pattern: path.basename(dir),
        multiple: false,
        mime: 'text/vtt',
        directory: true,
        entry: 'storyboard.vtt',
      },
    );
    ctx.filterCost(ctx.minutes, 0.1);
  },
  animated_webp: animated,
  animated_avif: animated,
  frames(ctx, step, index) {
    const name = ctx.name(index);
    const video = ctx.video(index, 'frames');
    const modes = [step.every_s !== undefined, step.fps !== undefined, step.all].filter(
      Boolean,
    ).length;
    if (modes !== 1) throw invalid(index, 'frames takes one of every_s, fps or all');
    const rate =
      step.every_s !== undefined
        ? [`fps=fps=1/${num(step.every_s)}`]
        : step.fps !== undefined
          ? [`fps=fps=${num(step.fps)}`]
          : [];
    const pad = ctx.graph.chain(video, [
      ...rate,
      ...(step.width ? [`scale=${step.width}:-2`] : []),
    ]);
    const dir = ctx.outputTarget(name, '').replace(/\.$/, '');
    if (step.zip) ctx.makeDir(dir);
    const pattern = step.zip
      ? path.join(dir, `frame_%05d.${step.format}`)
      : ctx.outputTarget(name, step.format, true);
    ctx.addOutput(
      {
        maps: [map(ctx, pad)],
        args: [
          ...STILL[step.format].args(step.quality),
          '-fps_mode',
          'vfr',
          '-frames:v',
          String(ctx.limits.FRAMES_MAX_COUNT ?? 2000),
          '-start_number',
          '1',
          '-f',
          'image2',
        ],
        target: pattern,
        durationS: ctx.state.duration,
      },
      step.zip
        ? {
            name,
            op: 'frames',
            role: 'image',
            pattern: path.basename(dir),
            multiple: false,
            mime: 'application/zip',
            directory: true,
            zip: true,
          }
        : {
            name,
            op: 'frames',
            role: 'image',
            pattern: path.basename(pattern),
            multiple: true,
            mime: STILL[step.format].mime,
          },
    );
    ctx.filterCost(ctx.minutes, 0.3);
  },
  image_convert(ctx, step, index) {
    const name = ctx.name(index);
    let pad = ctx.video(index, 'image_convert');
    const { width: w, height: h } = ctx.canvas();
    if (step.background) {
      // Transparency flattened onto a colour: JPEG and BMP have no alpha.
      const background = ctx.graph.newPad('v');
      ctx.graph.segment(`color=c=${step.background}:s=${w}x${h}:d=1[${background.label}]`);
      const out = ctx.graph.newPad('v');
      ctx.graph.segment(
        `[${ctx.graph.read(background)}][${ctx.graph.read(pad)}]overlay=shortest=1:format=auto[${out.label}]`,
      );
      pad = out;
    }
    const codec: Record<typeof step.format, string[]> = {
      jpg: STILL.jpg.args(step.quality),
      png: ['-c:v', 'png', '-compression_level', '9'],
      webp: [
        '-c:v',
        'libwebp',
        ...(step.lossless ? ['-lossless', '1'] : ['-quality', String(step.quality)]),
      ],
      avif: [
        '-c:v',
        'libaom-av1',
        '-still-picture',
        '1',
        '-crf',
        String(Math.round(63 - (step.quality * 63) / 100)),
        '-b:v',
        '0',
      ],
      gif: ['-c:v', 'gif'],
      bmp: ['-c:v', 'bmp'],
      tiff: ['-c:v', 'tiff'],
    };
    const muxer = step.format === 'avif' ? 'avif' : step.format === 'gif' ? 'gif' : 'image2';
    const target = ctx.outputTarget(name, step.format);
    ctx.addOutput(
      {
        maps: [map(ctx, pad)],
        args: [
          ...codec[step.format],
          ...(step.strip_metadata ? ['-map_metadata', '-1'] : []),
          '-frames:v',
          '1',
          ...(muxer === 'image2' ? ['-update', '1'] : []),
          '-f',
          muxer,
        ],
        target,
        durationS: null,
      },
      {
        name,
        op: 'image_convert',
        role: 'image',
        pattern: path.basename(target),
        multiple: false,
        mime: `image/${step.format === 'jpg' ? 'jpeg' : step.format}`,
      },
    );
  },
  images_to_video(ctx, step, index) {
    const name = ctx.name(index);
    const slideshow = {
      op: 'slideshow' as const,
      duration_each_s: step.duration_each_s,
      transition: step.transition,
      ken_burns: false,
      audio: step.audio,
      fit: step.fit,
      size: step.size,
      fps: step.fps,
    };
    compositionHandlers.slideshow(ctx, slideshow, index);
    const streams = ctx.encodeStreams({ container: 'mp4' }, index, name);
    const target = ctx.outputTarget(name, 'mp4');
    ctx.addOutput(
      {
        maps: streams.maps,
        args: [
          ...streams.args,
          '-movflags',
          '+faststart',
          ...ctx.threadArgs(),
          '-fs',
          String(ctx.maxFileBytes),
          '-f',
          'mp4',
        ],
        target,
        durationS: ctx.state.duration,
      },
      {
        name,
        op: 'images_to_video',
        role: 'media',
        pattern: path.basename(target),
        multiple: false,
        mime: 'video/mp4',
      },
    );
  },
  ken_burns(ctx, step, index) {
    ctx.video(index, 'ken_burns');
    const { width: w, height: h } = ctx.canvas();
    if (step.zoom_to === step.zoom_from && step.pan === 'center')
      throw invalid(index, 'ken_burns needs a zoom change or a pan');
    const frames = Math.round(step.duration_s * step.fps);
    const zoom = `'${num(step.zoom_from)}+(${num(step.zoom_to - step.zoom_from)})*on/${frames}'`;
    const centreX = 'iw/2-(iw/zoom/2)';
    const centreY = 'ih/2-(ih/zoom/2)';
    const x = {
      center: centreX,
      left: `(iw-iw/zoom)*on/${frames}`,
      right: `(iw-iw/zoom)*(1-on/${frames})`,
      up: centreX,
      down: centreX,
    }[step.pan];
    const y = {
      center: centreY,
      left: centreY,
      right: centreY,
      up: `(ih-ih/zoom)*(1-on/${frames})`,
      down: `(ih-ih/zoom)*on/${frames}`,
    }[step.pan];
    ctx.applyFilters(
      [
        `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase`,
        `crop=${w * 2}:${h * 2}`,
        `zoompan=z=${zoom}:x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=${step.fps}`,
        'format=yuv420p',
      ],
      null,
    );
    Object.assign(ctx.state, {
      duration: step.duration_s,
      width: w,
      height: h,
      fps: step.fps,
      timeAltered: true,
    });
    ctx.filterCost(step.duration_s / 60, 1);
  },
  poster_frame(ctx, step, index) {
    const video = ctx.video(index, 'poster_frame');
    const at =
      typeof step.at === 'number'
        ? step.at
        : (Number(step.at.slice(0, -1)) / 100) * ctx.duration(index, 'poster_frame');
    ctx.state.poster = ctx.graph.chain(video, [`trim=start=${num(at)}`, 'setpts=PTS-STARTPTS']);
  },
  audio_visual(ctx, step, index) {
    const name = ctx.name(index);
    const audio = ctx.audio(index, 'audio_visual');
    const dims = `${step.size.width}x${step.size.height}`;
    const image = step.kind.endsWith('_image');
    const filters: Record<typeof step.kind, string> = {
      waveform_image: `showwavespic=s=${dims}:colors=${WAVE[step.colors]}:scale=${step.scale}:split_channels=${step.split_channels ? 1 : 0}`,
      spectrogram_image: `showspectrumpic=s=${dims}:color=${SPECTRUM[step.colors]}:scale=${step.scale === 'lin' ? 'lin' : step.scale}`,
      waveform_video: `showwaves=s=${dims}:mode=${step.mode}:rate=25:colors=${WAVE[step.colors]}:scale=${step.scale}:split_channels=${step.split_channels ? 1 : 0}`,
      spectrum_video: `showspectrum=s=${dims}:mode=${step.split_channels ? 'separate' : 'combined'}:slide=scroll:color=${SPECTRUM[step.colors]}:scale=${step.scale}`,
      bars_video: `showfreqs=s=${dims}:mode=bar:cmode=${step.split_channels ? 'separate' : 'combined'}:overlap=0:rate=25:colors=${WAVE[step.colors]}`,
      vectorscope_video: `avectorscope=s=${dims}:rate=25:draw=line`,
    };
    const picture = ctx.graph.chain(audio, [filters[step.kind], 'format=yuv420p'], 'v');
    if (image) {
      const target = ctx.outputTarget(name, 'png');
      ctx.addOutput(
        {
          maps: [map(ctx, picture)],
          args: ['-c:v', 'png', '-frames:v', '1', '-update', '1', '-f', 'image2'],
          target,
          durationS: ctx.state.duration,
        },
        {
          name,
          op: 'audio_visual',
          role: 'image',
          pattern: path.basename(target),
          multiple: false,
          mime: 'image/png',
        },
      );
      return;
    }
    const target = ctx.outputTarget(name, 'mp4');
    ctx.addOutput(
      {
        maps: [map(ctx, picture), map(ctx, audio)],
        args: [
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-tune',
          'stillimage',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '160k',
          '-shortest',
          ...ctx.threadArgs(),
          '-fs',
          String(ctx.maxFileBytes),
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
        ],
        target,
        durationS: ctx.state.duration,
      },
      {
        name,
        op: 'audio_visual',
        role: 'media',
        pattern: path.basename(target),
        multiple: false,
        mime: 'video/mp4',
      },
    );
    ctx.filterCost(ctx.minutes, 0.5);
  },
};
