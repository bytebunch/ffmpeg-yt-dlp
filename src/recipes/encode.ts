import { AUDIO_ENCODERS, CONTAINER_INFO, CRF, VIDEO_ENCODERS } from './codecs';
import type {
  AudioCodec,
  AudioSettings,
  Container,
  EncodeStep,
  VideoCodec,
  VideoSettings,
} from './schema';
import { METADATA_KEYS } from './schema';

export type EncodedVideo = Exclude<VideoCodec, 'copy' | 'none'>;
export type EncodedAudio = Exclude<AudioCodec, 'copy' | 'none'>;

const PRORES_PROFILES: Record<string, string> = {
  proxy: '0',
  lt: '1',
  standard: '2',
  hq: '3',
  '4444': '4',
  '4444xq': '5',
};

/** Audio bitrate a target-size encode reserves (kbps); lossless codecs cannot meet a target. */
export const DEFAULT_AUDIO_KBPS: Record<EncodedAudio, number | null> = {
  aac: 128,
  mp3: 192,
  opus: 96,
  vorbis: 160,
  ac3: 384,
  eac3: 256,
  flac: null,
  alac: null,
  pcm_s16le: null,
  pcm_s24le: null,
};

export interface VideoEncodeContext {
  fps: number | null;
  pass?: { number: 1 | 2; logFile: string } | undefined;
  /** Overrides the bitrate (target_size_mb encodes compute it from the duration). */
  bitrateKbps?: number | undefined;
}

function defaultPixFmt(codec: EncodedVideo, video: VideoSettings | undefined): string | undefined {
  if (video?.pix_fmt) return video.pix_fmt;
  if (video?.profile === 'high10' || video?.profile === 'main10') return 'yuv420p10le';
  switch (codec) {
    case 'prores':
      return video?.profile?.startsWith('4444') ? 'yuv444p10le' : 'yuv422p10le';
    case 'dnxhr':
      return video?.profile === '444'
        ? 'yuv444p10le'
        : video?.profile === 'hqx'
          ? 'yuv422p10le'
          : 'yuv422p';
    case 'mjpeg':
      return 'yuvj420p';
    case 'png':
      return undefined;
    default:
      return 'yuv420p';
  }
}

function rateArgs(
  codec: EncodedVideo,
  video: VideoSettings | undefined,
  bitrateKbps: number | undefined,
): string[] {
  const bitrate = bitrateKbps ?? video?.bitrate_kbps;
  if (bitrate !== undefined) {
    return [
      '-b:v',
      `${bitrate}k`,
      ...(video?.maxrate_kbps ? ['-maxrate', `${video.maxrate_kbps}k`] : []),
      ...(video?.bufsize_kbps ? ['-bufsize', `${video.bufsize_kbps}k`] : []),
    ];
  }
  const crf = CRF[codec];
  if (!crf) return codec === 'mjpeg' ? ['-q:v', '3'] : [];
  const value = String(video?.crf ?? crf.fallback);
  // libvpx and libaom only honour the CRF as a constant quality with -b:v 0.
  return codec === 'vp9' || codec === 'av1_aom' ? ['-crf', value, '-b:v', '0'] : ['-crf', value];
}

function speedArgs(codec: EncodedVideo, video: VideoSettings | undefined): string[] {
  const preset = video?.preset;
  switch (codec) {
    case 'h264':
    case 'hevc':
      return [
        '-preset',
        typeof preset === 'string' ? preset : 'veryfast',
        ...(video?.tune ? ['-tune', video.tune] : []),
      ];
    case 'av1':
      return ['-preset', String(typeof preset === 'number' ? preset : 8)];
    case 'vp9':
      return [
        '-deadline',
        typeof preset === 'string' ? preset : 'good',
        '-cpu-used',
        String(video?.cpu_used ?? 4),
        '-row-mt',
        '1',
      ];
    case 'av1_aom':
      return [
        '-usage',
        preset === 'realtime' ? 'realtime' : 'good',
        '-cpu-used',
        String(video?.cpu_used ?? 6),
        '-row-mt',
        '1',
      ];
    default:
      return [];
  }
}

function profileArgs(codec: EncodedVideo, video: VideoSettings | undefined): string[] {
  const profile = video?.profile;
  if (codec === 'prores') return ['-profile:v', PRORES_PROFILES[profile ?? 'standard'] ?? '2'];
  if (codec === 'dnxhr') return ['-profile:v', `dnxhr_${profile ?? 'sq'}`];
  return [
    ...(profile ? ['-profile:v', profile] : []),
    ...(video?.level && (codec === 'h264' || codec === 'hevc') ? ['-level:v', video.level] : []),
  ];
}

function gopArgs(
  codec: EncodedVideo,
  video: VideoSettings | undefined,
  fps: number | null,
): string[] {
  const args: string[] = [];
  if (video?.keyframe_interval_s !== undefined && fps) {
    const gop = String(Math.max(1, Math.round(video.keyframe_interval_s * fps)));
    args.push('-g', gop, '-keyint_min', gop);
  }
  if (video?.scene_cut === false) {
    if (codec === 'h264') args.push('-sc_threshold', '0');
    if (codec === 'av1') args.push('-svtav1-params', 'scd=0');
  }
  if (video?.bframes !== undefined && ['h264', 'hevc'].includes(codec))
    args.push('-bf', String(video.bframes));
  return args;
}

function passArgs(codec: EncodedVideo, pass: VideoEncodeContext['pass']): string[] {
  if (!pass) return [];
  // libx265 takes its two-pass settings through x265-params rather than -pass.
  if (codec === 'hevc')
    return ['-x265-params', `pass=${pass.number}:stats=${pass.logFile}.x265:log-level=error`];
  return ['-pass', String(pass.number), '-passlogfile', pass.logFile];
}

/** Encoder arguments for one video output stream (SPEC §8b). */
export function videoArgs(
  codec: EncodedVideo,
  video: VideoSettings | undefined,
  context: VideoEncodeContext,
): string[] {
  const pixFmt = defaultPixFmt(codec, video);
  const pass = passArgs(codec, context.pass);
  return [
    '-c:v',
    VIDEO_ENCODERS[codec],
    ...speedArgs(codec, video),
    ...rateArgs(codec, video, context.bitrateKbps),
    ...profileArgs(codec, video),
    ...gopArgs(codec, video, context.fps),
    ...(pixFmt ? ['-pix_fmt', pixFmt] : []),
    ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    ...(codec === 'hevc' && pass.length === 0 ? ['-x265-params', 'log-level=error'] : []),
    ...pass,
  ];
}

/** ISO 639-1 → 639-2 for the languages MP4 and QuickTime files are most often tagged with. */
const ISO_639_2: Record<string, string> = {
  ar: 'ara',
  bg: 'bul',
  cs: 'ces',
  da: 'dan',
  de: 'deu',
  el: 'ell',
  en: 'eng',
  es: 'spa',
  fa: 'fas',
  fi: 'fin',
  fr: 'fra',
  he: 'heb',
  hi: 'hin',
  hu: 'hun',
  id: 'ind',
  it: 'ita',
  ja: 'jpn',
  ko: 'kor',
  nl: 'nld',
  no: 'nor',
  pl: 'pol',
  pt: 'por',
  ro: 'ron',
  ru: 'rus',
  sk: 'slk',
  sv: 'swe',
  th: 'tha',
  tr: 'tur',
  uk: 'ukr',
  ur: 'urd',
  vi: 'vie',
  zh: 'zho',
};

/**
 * MP4/MOV/M4A keep only three-letter ISO 639-2 codes and silently drop anything else; Matroska
 * and WebM take BCP-47 as given.
 */
export function streamLanguage(language: string, container: Container): string {
  if (!['mp4', 'mov', 'm4a', 'm4b'].includes(container)) return language;
  const primary = language.split('-')[0]?.toLowerCase() ?? language;
  return primary.length === 3 ? primary : (ISO_639_2[primary] ?? 'und');
}

/** Encoder arguments for one audio output stream; channels and labels included. */
export function audioArgs(
  codec: EncodedAudio,
  audio: AudioSettings | undefined,
  container: Container,
): string[] {
  let encoder = AUDIO_ENCODERS[codec];
  // AIFF stores big-endian PCM.
  if (container === 'aiff') encoder = codec === 'pcm_s24le' ? 'pcm_s24be' : 'pcm_s16be';
  const args = ['-c:a', encoder];
  if (audio?.vbr !== undefined) args.push('-q:a', String(audio.vbr));
  else if (audio?.bitrate_kbps !== undefined) args.push('-b:a', `${audio.bitrate_kbps}k`);
  else if (codec === 'vorbis') args.push('-q:a', '5');
  else if (DEFAULT_AUDIO_KBPS[codec] !== null)
    args.push('-b:a', `${DEFAULT_AUDIO_KBPS[codec] ?? 128}k`);
  if (audio?.channels !== undefined) args.push('-ac', String(audio.channels));
  if (audio?.language)
    args.push('-metadata:s:a:0', `language=${streamLanguage(audio.language, container)}`);
  if (audio?.title) args.push('-metadata:s:a:0', `title=${audio.title}`);
  return args;
}

/** Global metadata (allow-listed keys only) and container flags. */
export function containerArgs(
  step: Pick<EncodeStep, 'container' | 'metadata' | 'video'>,
  chaptersStripped: boolean,
): string[] {
  const args: string[] = [];
  if (step.metadata?.strip) args.push('-map_metadata', '-1');
  for (const key of METADATA_KEYS) {
    const value = step.metadata?.[key];
    if (value !== undefined) args.push('-metadata', `${key}=${value}`);
  }
  if (chaptersStripped) args.push('-map_chapters', '-1');
  if (step.container === 'mp3') args.push('-id3v2_version', '3');
  if (['mp4', 'mov', 'm4a', 'm4b'].includes(step.container)) {
    if (step.video?.fragmented)
      args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof');
    else if (step.video?.faststart !== false) args.push('-movflags', '+faststart');
  }
  args.push('-f', CONTAINER_INFO[step.container].muxer);
  return args;
}

/** ffmetadata text for chapters set by the recipe; special characters escaped per the format. */
export function chaptersFile(
  chapters: readonly { start: number; end: number; title: string }[],
): string {
  const escape = (text: string) => text.replace(/[\\=;#\n]/g, (char) => `\\${char}`);
  const lines = [';FFMETADATA1'];
  for (const chapter of chapters) {
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.round(chapter.start * 1000)}`,
      `END=${Math.round(chapter.end * 1000)}`,
      `title=${escape(chapter.title)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
