import { AppError } from '../common/errors';
import type { ProbeSummary } from '../media/ffprobe';
import type { Graph, Pad } from './graph';
import type { AudioSettings, Container, VideoSettings } from './schema';

export interface ComposeInput {
  path: string;
  probe: ProbeSummary;
  /** Implicit inputs of a then pipeline: the download's subtitles and thumbnail (SPEC §9b). */
  role?: 'subtitles' | 'thumbnail' | undefined;
  lang?: string | undefined;
}

/** A subtitle stream for encode outputs (subtitles_mux). */
export interface SubtitleTrack {
  map: string;
  codec: string | null;
  format?: 'mov_text' | 'srt' | 'ass' | 'webvtt' | undefined;
  language?: string | undefined;
  title?: string | undefined;
  default?: boolean | undefined;
  forced?: boolean | undefined;
}

/** Looks up allow-listed font files by family (fonts.ts). */
export interface FontLookup {
  face(family: string, options?: { bold?: boolean; italic?: boolean }): string | undefined;
  list(): string[];
}

/** An extra audio stream for encode outputs (add_audio_track, select_streams). */
export interface ExtraTrack {
  pad: Pad;
  language?: string | undefined;
  title?: string | undefined;
  default?: boolean | undefined;
}

/** What a terminal adds to the main pass. */
export interface ComposedOutput {
  maps: string[];
  args: string[];
  target: string;
  durationS: number | null;
}

export interface ComposedFile {
  name: string;
  op: string;
  role: 'media' | 'audio' | 'thumbnail' | 'image' | 'subtitles' | 'package' | 'report';
  pattern: string;
  multiple: boolean;
  mime: string;
  /** A folder of files served together (HLS, DASH, storyboards); `entry` is the file to open. */
  directory?: boolean;
  entry?: string;
  /** A folder delivered as one ZIP (frames). */
  zip?: boolean;
}

/** The working streams and what is known about them at the current step. */
export interface Working {
  video: Pad | null;
  audio: Pad | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  sampleRate: number | null;
  /** The input's transfer characteristic (HDR detection). */
  transfer: string | null;
  /** Timestamps no longer match the input: chapters are dropped. */
  timeAltered: boolean;
  /** A leading trim asked for frame accuracy, which stream copy cannot give. */
  accurateTrim: boolean;
  /** Rotation set as metadata only: video must be copied. */
  rotatedMetadata: boolean;
  /** Any filter applied (remux and fix need the untouched input). */
  filtered: boolean;
  /** Outputs stop with the shortest stream (trim_to_shortest). */
  shortest: boolean;
  /** Language and title for the main audio stream (replace_audio). */
  audioLabel: { language?: string | undefined; title?: string | undefined };
  /** Audio streams after the main one, in encode outputs. */
  extraAudio: ExtraTrack[];
  /** Subtitle streams for encode outputs. */
  subtitles: SubtitleTrack[];
  /** subtitles_strip: remux and fix leave subtitle streams out. */
  stripSubtitles: boolean;
  /** poster_frame: a frame of the picture that encode outputs carry as cover art. */
  poster: Pad | null;
  /** platform_format: encode defaults (profile, level, bitrate cap) for the platform. */
  platform?: {
    profile: 'baseline' | 'main' | 'high';
    level: '3.0' | '3.1' | '4.0' | '4.1' | '4.2';
    maxrateKbps: number;
    audioKbps: number;
    maxFileMb: number | null;
  };
}

/** Measurement passes a step can ask for (SPEC §8a "stages"). */
export type MeasureKind = 'crop' | 'peak' | 'loudnorm' | 'silence' | 'vidstab' | 'scenes';

export interface ComposeLimits {
  RECIPE_MAX_TEXT_LAYERS?: number;
  FRAMES_MAX_COUNT?: number;
  REVERSE_MAX_SECONDS: number;
  INTERPOLATE_MAX_SECONDS: number;
  GIF_MAX_SECONDS: number;
  MAX_MEDIA_DURATION_MINUTES: number;
}

/** What filter operations see of the composer. */
export interface FilterContext {
  readonly state: Working;
  readonly graph: Graph;
  readonly workDir: string;
  readonly limits: ComposeLimits;
  /** Minutes of media at the current step. */
  readonly minutes: number;
  video(index: number, op: string): Pad;
  audio(index: number, op: string): Pad;
  duration(index: number, op: string): number;
  /** Applies linear filters to whichever streams exist; null leaves that stream alone. */
  applyFilters(videoFilters: string[] | null, audioFilters: string[] | null): void;
  addCost(units: number): void;
  /** Cost per minute relative to a decode, scaled by the current pixel rate for video. */
  filterCost(minutes: number, weight: number, video?: boolean): void;
  /**
   * The result of a measurement pass of `filter` on `pad` (null: nothing measured). The first
   * call stops composition and asks the runner to run the pass.
   */
  measured(key: string, kind: MeasureKind, pad: Pad, filter: string): unknown;

  // --- composition (several inputs, sources, terminals) -----------------------------------------
  readonly inputs: readonly ComposeInput[];
  /** How ffmpeg opens the main input; concat copy swaps in a list file. */
  mainSource: string[];
  /** True once any step ran (input-level options only work before that). */
  readonly touched: boolean;
  /** A stream (`stream`-th of its kind) of recipe input `input`; 0 is the main input as received. */
  inputPad(input: number, kind: 'v' | 'a', index: number, op: string, stream?: number): Pad;
  /** The output canvas: working size and rate, else the first input's, else 1280x720 at 30. */
  canvas(): { width: number; height: number; fps: number };
  /** A file or symlink the runner creates in the job directory before the stage. */
  writeFile(file: string, content: string): void;
  /** A directory the runner creates before the stage (image sequences in a package). */
  makeDir(dir: string): void;
  link(file: string, target: string): void;
  /** An ffmpeg output, a planned file, or both (filters such as whisper write files themselves). */
  addOutput(output: ComposedOutput | null, file: ComposedFile | null): void;
  outputTarget(name: string, ext: string, multiple?: boolean): string;
  threadArgs(): string[];
  name(index: number): string;
  readonly maxFileBytes: number;
  /** Installed fonts and their directory (text, subtitles, timestamps). */
  readonly fonts: FontLookup | undefined;
  readonly fontDir: string | undefined;
  /** Input index for a reference: a number, or a then pipeline's download output. */
  resolveInput(ref: InputRef, index: number, op: string): number;
  /** A stage that runs before the main pass (subtitle shifting). */
  addPreStage(label: string, args: string[]): void;
  /** Input options of the main input (only before any step). */
  addInputArgs(flag: string, value: string): void;
  /** Maps and encoder arguments for a container, as encode builds them. */
  encodeStreams(
    step: {
      container: Container;
      video?: VideoSettings | undefined;
      audio?: AudioSettings | undefined;
    },
    index: number,
    name: string,
  ): { maps: string[]; args: string[]; hasVideo: boolean };
  requireUntouched(index: number, kind: 'video' | 'audio'): void;

  // --- analyses ------------------------------------------------------------------------------
  /** A report parsed from ffmpeg's log after the main pass. */
  addLogReport(name: string, op: string, kind: string): void;
  /** A report parsed from files the main pass writes (stats files, hashes, peaks). */
  addFileReport(
    name: string,
    op: string,
    kind: string,
    files: string[],
    meta?: Record<string, unknown>,
  ): void;
  /** A report from an ffprobe run on the main input; stdout lines go to the parser. */
  addProbeReport(
    name: string,
    op: string,
    kind: string,
    args: string[],
    meta?: Record<string, unknown>,
  ): void;
  /** A stage after the main pass (format conversion of an output). */
  addPostStage(label: string, args: string[]): void;
  /** whisper.cpp models and whether transcription works on this host. */
  readonly whisper: WhisperSetup | undefined;
  /** The main input's path (for analyses of the input itself). */
  readonly mainPath: string;
}

export interface WhisperSetup {
  /** Why transcription is off (no filter, no model file, no AVX2); undefined when it works. */
  disabled?: string | undefined;
  models: Record<string, string>;
  defaultModel?: string | undefined;
  vadModel?: string | undefined;
}

export type InputRef =
  number | { job_output: 'subtitles' | 'thumbnail'; lang?: string | undefined };

export function invalid(index: number, message: string): AppError {
  return new AppError('RECIPE_INVALID', `steps.${index}: ${message}`, { step: index }, {}, false);
}

/** dB → linear amplitude. */
export const linear = (db: number) => 10 ** (db / 20);

/**
 * A server-generated path inside a filter argument. Paths come from FILES_DIR and job ids only;
 * anything that would need filtergraph escaping is refused instead.
 */
export function graphPath(file: string): string {
  if (!/^[A-Za-z0-9/._-]+$/.test(file))
    throw new Error(`Path not usable in a filtergraph: ${file}`);
  return file;
}
