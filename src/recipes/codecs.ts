import type { AudioCodec, Container, VideoCodec } from './schema';

/** ffmpeg muxer, file extension and MIME type per container (SPEC §8b). */
export const CONTAINER_INFO: Record<
  Container,
  { muxer: string; ext: string; mime: string; video: boolean }
> = {
  mp4: { muxer: 'mp4', ext: 'mp4', mime: 'video/mp4', video: true },
  mov: { muxer: 'mov', ext: 'mov', mime: 'video/quicktime', video: true },
  mkv: { muxer: 'matroska', ext: 'mkv', mime: 'video/x-matroska', video: true },
  webm: { muxer: 'webm', ext: 'webm', mime: 'video/webm', video: true },
  mpegts: { muxer: 'mpegts', ext: 'ts', mime: 'video/mp2t', video: true },
  mp3: { muxer: 'mp3', ext: 'mp3', mime: 'audio/mpeg', video: false },
  m4a: { muxer: 'ipod', ext: 'm4a', mime: 'audio/mp4', video: false },
  m4b: { muxer: 'ipod', ext: 'm4b', mime: 'audio/mp4', video: false },
  aac: { muxer: 'adts', ext: 'aac', mime: 'audio/aac', video: false },
  ogg: { muxer: 'ogg', ext: 'ogg', mime: 'audio/ogg', video: false },
  opus: { muxer: 'opus', ext: 'opus', mime: 'audio/ogg', video: false },
  flac: { muxer: 'flac', ext: 'flac', mime: 'audio/flac', video: false },
  wav: { muxer: 'wav', ext: 'wav', mime: 'audio/wav', video: false },
  aiff: { muxer: 'aiff', ext: 'aiff', mime: 'audio/aiff', video: false },
};

type EncodedVideo = Exclude<VideoCodec, 'copy' | 'none'>;
type EncodedAudio = Exclude<AudioCodec, 'copy' | 'none'>;

export const VIDEO_ENCODERS: Record<EncodedVideo, string> = {
  h264: 'libx264',
  hevc: 'libx265',
  vp9: 'libvpx-vp9',
  av1: 'libsvtav1',
  av1_aom: 'libaom-av1',
  prores: 'prores_ks',
  dnxhr: 'dnxhd',
  mjpeg: 'mjpeg',
  png: 'png',
};

export const AUDIO_ENCODERS: Record<EncodedAudio, string> = {
  aac: 'aac',
  mp3: 'libmp3lame',
  opus: 'libopus',
  vorbis: 'libvorbis',
  flac: 'flac',
  alac: 'alac',
  pcm_s16le: 'pcm_s16le',
  pcm_s24le: 'pcm_s24le',
  ac3: 'ac3',
  eac3: 'eac3',
};

/** Codecs each container accepts when encoding; the first is the default. */
export const ENCODE_CODECS: Record<
  Container,
  { video: readonly EncodedVideo[]; audio: readonly EncodedAudio[] }
> = {
  mp4: {
    video: ['h264', 'hevc', 'av1', 'av1_aom', 'vp9', 'mjpeg'],
    audio: ['aac', 'mp3', 'opus', 'flac', 'alac', 'ac3', 'eac3'],
  },
  mov: {
    video: ['h264', 'hevc', 'prores', 'dnxhr', 'mjpeg', 'png', 'av1', 'av1_aom'],
    audio: ['aac', 'alac', 'pcm_s16le', 'pcm_s24le', 'mp3', 'ac3', 'eac3'],
  },
  mkv: {
    video: ['h264', 'hevc', 'vp9', 'av1', 'av1_aom', 'prores', 'dnxhr', 'mjpeg', 'png'],
    audio: [
      'aac',
      'opus',
      'vorbis',
      'flac',
      'mp3',
      'alac',
      'pcm_s16le',
      'pcm_s24le',
      'ac3',
      'eac3',
    ],
  },
  webm: { video: ['vp9', 'av1', 'av1_aom'], audio: ['opus', 'vorbis'] },
  mpegts: { video: ['h264', 'hevc'], audio: ['aac', 'mp3', 'ac3', 'eac3', 'opus'] },
  mp3: { video: [], audio: ['mp3'] },
  m4a: { video: [], audio: ['aac', 'alac'] },
  m4b: { video: [], audio: ['aac', 'alac'] },
  aac: { video: [], audio: ['aac'] },
  ogg: { video: [], audio: ['vorbis', 'opus', 'flac'] },
  opus: { video: [], audio: ['opus'] },
  flac: { video: [], audio: ['flac'] },
  wav: { video: [], audio: ['pcm_s16le', 'pcm_s24le'] },
  aiff: { video: [], audio: ['pcm_s16le', 'pcm_s24le'] },
};

/** Stream codecs (ffprobe names) a container accepts as-is, for copy, remux and fix. */
export const COPY_CODECS: Record<
  Container,
  { video: string[]; audio: string[]; subtitle: string[] }
> = {
  mp4: {
    video: ['h264', 'hevc', 'av1', 'vp9', 'mpeg4', 'mjpeg'],
    audio: ['aac', 'mp3', 'opus', 'flac', 'alac', 'ac3', 'eac3'],
    subtitle: ['mov_text'],
  },
  mov: {
    video: ['h264', 'hevc', 'prores', 'dnxhd', 'mjpeg', 'png', 'mpeg4', 'av1'],
    audio: [
      'aac',
      'mp3',
      'alac',
      'ac3',
      'eac3',
      'pcm_s16le',
      'pcm_s24le',
      'pcm_s16be',
      'pcm_s24be',
    ],
    subtitle: ['mov_text'],
  },
  mkv: {
    video: ['*'],
    audio: ['*'],
    subtitle: ['subrip', 'ass', 'ssa', 'webvtt', 'hdmv_pgs_subtitle', 'dvd_subtitle'],
  },
  webm: { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'], subtitle: ['webvtt'] },
  mpegts: {
    video: ['h264', 'hevc', 'mpeg2video', 'mpeg1video'],
    audio: ['aac', 'mp3', 'mp2', 'ac3', 'eac3', 'opus'],
    subtitle: ['dvb_subtitle'],
  },
  mp3: { video: [], audio: ['mp3'], subtitle: [] },
  m4a: { video: [], audio: ['aac', 'alac'], subtitle: [] },
  m4b: { video: [], audio: ['aac', 'alac'], subtitle: [] },
  aac: { video: [], audio: ['aac'], subtitle: [] },
  ogg: { video: [], audio: ['vorbis', 'opus', 'flac'], subtitle: [] },
  opus: { video: [], audio: ['opus'], subtitle: [] },
  flac: { video: [], audio: ['flac'], subtitle: [] },
  wav: { video: [], audio: ['pcm_s16le', 'pcm_s24le', 'pcm_u8', 'pcm_f32le'], subtitle: [] },
  aiff: { video: [], audio: ['pcm_s16be', 'pcm_s24be'], subtitle: [] },
};

export function copyAllowed(
  container: Container,
  kind: 'video' | 'audio' | 'subtitle',
  codec: string | null,
): boolean {
  const allowed = COPY_CODECS[container][kind];
  return codec !== null && (allowed.includes('*') || allowed.includes(codec));
}

/** The subtitle codec to convert text subtitles to when a container rejects the original. */
export const SUBTITLE_TARGET: Partial<Record<Container, string>> = {
  mp4: 'mov_text',
  mov: 'mov_text',
  mkv: 'srt',
  webm: 'webvtt',
};

const TEXT_SUBTITLES = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
export const isTextSubtitle = (codec: string | null) => codec !== null && TEXT_SUBTITLES.has(codec);

/** ffprobe format_name → the container a repaired file keeps. */
export function containerForFormat(format: string | null): Container {
  const names = (format ?? '').split(',');
  if (names.includes('mp4') || names.includes('mov')) return names.includes('mp4') ? 'mp4' : 'mov';
  if (names.includes('webm') && !names.includes('matroska')) return 'webm';
  if (names.includes('mpegts')) return 'mpegts';
  return 'mkv';
}

/** CRF ranges and defaults (SPEC §8b). */
export const CRF: Partial<Record<EncodedVideo, { max: number; fallback: number }>> = {
  h264: { max: 51, fallback: 23 },
  hevc: { max: 51, fallback: 28 },
  vp9: { max: 63, fallback: 33 },
  av1: { max: 63, fallback: 35 },
  av1_aom: { max: 63, fallback: 32 },
};

export const PROFILES: Partial<Record<EncodedVideo, readonly string[]>> = {
  h264: ['baseline', 'main', 'high', 'high10'],
  hevc: ['main', 'main10'],
  prores: ['proxy', 'lt', 'standard', 'hq', '4444', '4444xq'],
  dnxhr: ['lb', 'sq', 'hq', 'hqx', '444'],
};

/** Cost weight of encoding one minute at 1080p30 relative to x264 veryfast (SPEC §8a). */
export const VIDEO_COST: Record<EncodedVideo, number> = {
  h264: 1,
  hevc: 3,
  vp9: 3,
  av1: 3,
  av1_aom: 8,
  prores: 0.5,
  dnxhr: 0.5,
  mjpeg: 0.3,
  png: 0.5,
};

export const PRESET_COST: Record<string, number> = {
  ultrafast: 0.3,
  superfast: 0.4,
  veryfast: 1,
  faster: 1.3,
  fast: 1.6,
  medium: 2,
  slow: 3,
  slower: 5,
  veryslow: 8,
};
