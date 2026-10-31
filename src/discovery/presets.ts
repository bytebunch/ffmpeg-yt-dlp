/** Download presets (SPEC §7a). The argument mapping is shared by /v1/info and download jobs. */
export const DOWNLOAD_PRESETS = [
  'best',
  '2160p',
  '1440p',
  '1080p',
  '720p',
  '480p',
  '360p',
  'audio_best',
  'audio_mp3',
  'audio_m4a',
  'audio_opus',
  'audio_flac',
  'audio_wav',
  'video_only',
  'thumbnail_only',
  'subtitles_only',
  'metadata_only',
] as const;

export type DownloadPreset = (typeof DOWNLOAD_PRESETS)[number];

export const PRESET_DESCRIPTIONS: Record<DownloadPreset, string> = {
  best: 'Best video and audio, merged',
  '2160p': 'Best quality up to 2160p',
  '1440p': 'Best quality up to 1440p',
  '1080p': 'Best quality up to 1080p',
  '720p': 'Best quality up to 720p',
  '480p': 'Best quality up to 480p',
  '360p': 'Best quality up to 360p',
  audio_best: 'Best audio, original codec',
  audio_mp3: 'Best audio converted to MP3',
  audio_m4a: 'Best audio converted to M4A (AAC)',
  audio_opus: 'Best audio converted to Opus',
  audio_flac: 'Best audio converted to FLAC',
  audio_wav: 'Best audio converted to WAV',
  video_only: 'Best video stream without audio',
  thumbnail_only: 'Thumbnails only, no media',
  subtitles_only: 'Subtitles only, no media',
  metadata_only: 'Metadata (info JSON) only, no media',
};

const HEIGHTS: Partial<Record<DownloadPreset, number>> = {
  '2160p': 2160,
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
  '360p': 360,
};

/** `-f`/`-S` arguments for a preset; empty for presets that download no media stream. */
export function formatSelectionArgs(preset: DownloadPreset): string[] {
  const height = HEIGHTS[preset];
  if (height !== undefined) return ['-f', 'bv*+ba/b', '-S', `res:${height}`];
  if (preset === 'best') return ['-f', 'bv*+ba/b'];
  if (preset.startsWith('audio_')) return ['-f', 'ba/b'];
  if (preset === 'video_only') return ['-f', 'bv'];
  return [];
}
