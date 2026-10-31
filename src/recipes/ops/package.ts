import path from 'node:path';

import { z } from 'zod';

import { type FilterContext, invalid } from '../context';
import { num, type Pad } from '../graph';
import { outputName } from '../values';

/** Packaging and streaming (SPEC §8i). Packages are directory outputs served by path. */

const variant = z.strictObject({
  height: z.number().int().min(144).max(2160),
  video_bitrate_kbps: z.number().int().min(100).max(50_000),
  audio_bitrate_kbps: z.number().int().min(32).max(320).default(128),
});

export const packageSchemas = [
  z.strictObject({
    op: z.literal('hls'),
    name: outputName.optional(),
    segment_s: z.number().min(2).max(10).default(6),
    variants: z.array(variant).min(1).max(8).optional(),
    ladder: z.literal('auto').optional(),
    segment_type: z.enum(['mpegts', 'fmp4']).default('fmp4'),
    playlist_type: z.literal('vod').default('vod'),
    independent_segments: z.boolean().default(true),
    audio_only_variant: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal('dash'),
    name: outputName.optional(),
    segment_s: z.number().min(1).max(10).default(4),
    variants: z.array(variant).min(1).max(8).optional(),
    single_file: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal('fragmented_mp4'),
    name: outputName.optional(),
    fragment_s: z.number().min(0.5).max(10).default(2),
  }),
  z.strictObject({
    op: z.literal('mpegts'),
    name: outputName.optional(),
    muxrate_kbps: z.number().int().min(100).max(100_000).optional(),
  }),
  z.strictObject({
    op: z.literal('bitstream'),
    name: outputName.optional(),
    filter: z.enum(['annexb', 'adts_to_asc', 'remove_sei']),
  }),
] as const;

export type PackageStep = z.output<(typeof packageSchemas)[number]>;
type Of<K extends PackageStep['op']> = Extract<PackageStep, { op: K }>;
type Variant = z.output<typeof variant>;

/** SPEC §8i `ladder: auto`: 1080/720/480/360, never above the source. */
const LADDER: Variant[] = [
  { height: 1080, video_bitrate_kbps: 5000, audio_bitrate_kbps: 128 },
  { height: 720, video_bitrate_kbps: 2800, audio_bitrate_kbps: 128 },
  { height: 480, video_bitrate_kbps: 1400, audio_bitrate_kbps: 96 },
  { height: 360, video_bitrate_kbps: 800, audio_bitrate_kbps: 96 },
];

function variants(ctx: FilterContext, given: Variant[] | undefined): Variant[] {
  if (given) return [...given].sort((a, b) => b.height - a.height);
  const source = ctx.state.height ?? 1080;
  const fitting = LADDER.filter((entry) => entry.height <= source);
  return fitting.length > 0
    ? fitting
    : [{ height: source - (source % 2), video_bitrate_kbps: 600, audio_bitrate_kbps: 96 }];
}

/** One scaled, rate-controlled H.264 stream per variant, keyframes on segment boundaries. */
function ladderStreams(ctx: FilterContext, index: number, list: Variant[], segment: number) {
  const video = ctx.state.video;
  const audio = ctx.state.audio;
  const maps: string[] = [];
  const args: string[] = [];
  const fps = ctx.state.fps ?? 30;
  const gop = String(Math.max(1, Math.round(fps * segment)));
  const { width, height } = ctx.state;
  const dar = width && height ? `setdar=${width}/${height}` : 'setsar=1';
  const map = (pad: Pad) => (pad.raw ? pad.label : `[${ctx.graph.read(pad)}]`);
  list.forEach((entry, i) => {
    if (video) {
      // Same display aspect ratio in every rendition: DASH refuses mixed ones (426x240 vs 640x360).
      maps.push(map(ctx.graph.chain(video, [`scale=-2:${entry.height}`, dar])));
      args.push(
        `-b:v:${i}`,
        `${entry.video_bitrate_kbps}k`,
        `-maxrate:v:${i}`,
        `${Math.round(entry.video_bitrate_kbps * 1.07)}k`,
        `-bufsize:v:${i}`,
        `${entry.video_bitrate_kbps * 1.5}k`,
      );
    }
    if (audio) {
      maps.push(map(audio));
      args.push(`-b:a:${i}`, `${entry.audio_bitrate_kbps}k`);
    }
  });
  if (!video && !audio) throw invalid(index, 'the media has no streams to package');
  const codecs = [
    ...(video
      ? [
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-pix_fmt',
          'yuv420p',
          '-g',
          gop,
          '-keyint_min',
          gop,
          '-sc_threshold',
          '0',
        ]
      : []),
    ...(audio ? ['-c:a', 'aac', '-ac', '2'] : []),
  ];
  ctx.filterCost(ctx.minutes, list.length * (video ? 1 : 0.02));
  return { maps, args: [...codecs, ...args] };
}

function hls(ctx: FilterContext, step: Of<'hls'>, index: number): void {
  if (step.variants && step.ladder) throw invalid(index, 'set variants or ladder, not both');
  const name = ctx.name(index);
  const list = ctx.state.video
    ? variants(ctx, step.variants)
    : [{ height: 0, video_bitrate_kbps: 0, audio_bitrate_kbps: 128 }];
  const { maps, args } = ladderStreams(ctx, index, list, step.segment_s);
  const hasVideo = ctx.state.video !== null;
  const hasAudio = ctx.state.audio !== null;
  const streamMap = list.map((_, i) =>
    [hasVideo && `v:${i}`, hasAudio && `a:${i}`].filter(Boolean).join(','),
  );
  if (step.audio_only_variant && hasVideo && hasAudio) {
    const audio = ctx.state.audio;
    if (audio) maps.push(audio.raw ? audio.label : `[${ctx.graph.read(audio)}]`);
    args.push(`-b:a:${list.length}`, '96k');
    streamMap.push(`a:${list.length}`);
  }
  const dir = ctx.outputTarget(name, '').replace(/\.$/, '');
  ctx.makeDir(dir);
  const ext = step.segment_type === 'fmp4' ? 'm4s' : 'ts';
  ctx.addOutput(
    {
      maps,
      args: [
        ...args,
        ...ctx.threadArgs(),
        '-f',
        'hls',
        '-hls_time',
        num(step.segment_s),
        '-hls_playlist_type',
        step.playlist_type,
        '-hls_segment_type',
        step.segment_type,
        ...(step.independent_segments ? ['-hls_flags', 'independent_segments'] : []),
        ...(step.segment_type === 'fmp4' ? ['-hls_fmp4_init_filename', 'init.mp4'] : []),
        '-master_pl_name',
        'master.m3u8',
        '-var_stream_map',
        streamMap.join(' '),
        '-hls_segment_filename',
        path.join(dir, `v%v/segment_%05d.${ext}`),
      ],
      target: path.join(dir, 'v%v/index.m3u8'),
      durationS: ctx.state.duration,
    },
    {
      name,
      op: 'hls',
      role: 'package',
      pattern: path.basename(dir),
      multiple: false,
      mime: 'application/vnd.apple.mpegurl',
      directory: true,
      entry: 'master.m3u8',
    },
  );
}

function dash(ctx: FilterContext, step: Of<'dash'>, index: number): void {
  const name = ctx.name(index);
  const list = ctx.state.video
    ? variants(ctx, step.variants)
    : [{ height: 0, video_bitrate_kbps: 0, audio_bitrate_kbps: 128 }];
  // One audio rendition is enough for DASH: the adaptation sets keep video and audio apart.
  const audio = ctx.state.audio;
  ctx.state.audio = null;
  const { maps, args } = ctx.state.video
    ? ladderStreams(ctx, index, list, step.segment_s)
    : { maps: [], args: [] };
  ctx.state.audio = audio;
  if (audio) {
    maps.push(audio.raw ? audio.label : `[${ctx.graph.read(audio)}]`);
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', `${list[0]?.audio_bitrate_kbps ?? 128}k`);
  }
  if (maps.length === 0) throw invalid(index, 'the media has no streams to package');
  const dir = ctx.outputTarget(name, '').replace(/\.$/, '');
  ctx.makeDir(dir);
  const sets = [
    ctx.state.video && 'id=0,streams=v',
    audio && `id=${ctx.state.video ? 1 : 0},streams=a`,
  ]
    .filter(Boolean)
    .join(' ');
  ctx.addOutput(
    {
      maps,
      args: [
        ...args,
        ...ctx.threadArgs(),
        '-f',
        'dash',
        '-seg_duration',
        num(step.segment_s),
        '-use_template',
        '1',
        '-use_timeline',
        '1',
        '-adaptation_sets',
        sets,
        ...(step.single_file
          ? ['-single_file', '1']
          : [
              '-init_seg_name',
              'init-$RepresentationID$.$ext$',
              '-media_seg_name',
              'chunk-$RepresentationID$-$Number%05d$.$ext$',
            ]),
      ],
      target: path.join(dir, 'manifest.mpd'),
      durationS: ctx.state.duration,
    },
    {
      name,
      op: 'dash',
      role: 'package',
      pattern: path.basename(dir),
      multiple: false,
      mime: 'application/dash+xml',
      directory: true,
      entry: 'manifest.mpd',
    },
  );
}

export const packageHandlers: {
  [K in PackageStep['op']]: (ctx: FilterContext, step: Of<K>, index: number) => void;
} = {
  hls,
  dash,
  fragmented_mp4(ctx, step, index) {
    const name = ctx.name(index);
    const streams = ctx.encodeStreams({ container: 'mp4' }, index, name);
    const target = ctx.outputTarget(name, 'mp4');
    ctx.addOutput(
      {
        maps: streams.maps,
        args: [
          ...streams.args,
          '-movflags',
          '+frag_keyframe+empty_moov+default_base_moof',
          '-frag_duration',
          String(Math.round(step.fragment_s * 1_000_000)),
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
        op: 'fragmented_mp4',
        role: streams.hasVideo ? 'media' : 'audio',
        pattern: path.basename(target),
        multiple: false,
        mime: 'video/mp4',
      },
    );
  },
  mpegts(ctx, step, index) {
    const name = ctx.name(index);
    const streams = ctx.encodeStreams({ container: 'mpegts' }, index, name);
    const target = ctx.outputTarget(name, 'ts');
    ctx.addOutput(
      {
        maps: streams.maps,
        args: [
          ...streams.args,
          '-mpegts_flags',
          '+resend_headers',
          ...(step.muxrate_kbps ? ['-muxrate', `${step.muxrate_kbps}k`] : []),
          ...ctx.threadArgs(),
          '-fs',
          String(ctx.maxFileBytes),
          '-f',
          'mpegts',
        ],
        target,
        durationS: ctx.state.duration,
      },
      {
        name,
        op: 'mpegts',
        role: streams.hasVideo ? 'media' : 'audio',
        pattern: path.basename(target),
        multiple: false,
        mime: 'video/mp2t',
      },
    );
  },
  bitstream(ctx, step, index) {
    const name = ctx.name(index);
    const videoStream = ctx.inputs[0]?.probe.streams.find(
      (stream) => stream.type === 'video' && !stream.attached_pic,
    );
    const audioStream = ctx.inputs[0]?.probe.streams.find((stream) => stream.type === 'audio');
    let target: string;
    let args: string[];
    let maps: string[];
    let mime: string;
    switch (step.filter) {
      case 'annexb': {
        ctx.requireUntouched(index, 'video');
        const codec = videoStream?.codec;
        if (codec !== 'h264' && codec !== 'hevc')
          throw invalid(index, 'annexb needs H.264 or HEVC video');
        target = ctx.outputTarget(name, codec === 'h264' ? 'h264' : 'hevc');
        maps = ['0:V:0'];
        args = ['-c:v', 'copy', '-bsf:v', `${codec}_mp4toannexb`, '-f', codec];
        mime = 'video/h264';
        break;
      }
      case 'adts_to_asc':
        ctx.requireUntouched(index, 'audio');
        if (audioStream?.codec !== 'aac') throw invalid(index, 'adts_to_asc needs AAC audio');
        target = ctx.outputTarget(name, 'm4a');
        maps = ['0:a:0'];
        args = ['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'ipod'];
        mime = 'audio/mp4';
        break;
      case 'remove_sei': {
        ctx.requireUntouched(index, 'video');
        const codec = videoStream?.codec;
        if (codec !== 'h264' && codec !== 'hevc')
          throw invalid(index, 'remove_sei needs H.264 or HEVC video');
        target = ctx.outputTarget(name, 'mp4');
        maps = ['0:V:0', '0:a?'];
        args = [
          '-c',
          'copy',
          '-bsf:v',
          `filter_units=remove_types=${codec === 'h264' ? '6' : '39|40'}`,
          '-f',
          'mp4',
        ];
        mime = 'video/mp4';
        break;
      }
    }
    ctx.addOutput(
      {
        maps,
        args: [
          ...args.slice(0, -2),
          ...ctx.threadArgs(),
          '-fs',
          String(ctx.maxFileBytes),
          ...args.slice(-2),
        ],
        target,
        durationS: ctx.state.duration,
      },
      {
        name,
        op: 'bitstream',
        role: step.filter === 'adts_to_asc' ? 'audio' : 'media',
        pattern: path.basename(target),
        multiple: false,
        mime,
      },
    );
  },
};
