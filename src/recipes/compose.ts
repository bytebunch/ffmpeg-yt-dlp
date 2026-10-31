import path from 'node:path';

import { AppError } from '../common/errors';
import type { ProbeSummary, StreamSummary } from '../media/ffprobe';
import {
  CONTAINER_INFO,
  containerForFormat,
  copyAllowed,
  ENCODE_CODECS,
  isTextSubtitle,
  PRESET_COST,
  SUBTITLE_TARGET,
  VIDEO_COST,
} from './codecs';
import {
  audioArgs,
  chaptersFile,
  containerArgs,
  DEFAULT_AUDIO_KBPS,
  streamLanguage,
  videoArgs,
} from './encode';
import {
  type ComposeInput,
  type ComposeLimits,
  type FontLookup,
  type InputRef,
  type WhisperSetup,
  type FilterContext,
  invalid,
  type MeasureKind,
  type Working,
} from './context';
import { Graph, num, type Pad } from './graph';
import { atempoChain, type AudioStep, audioHandlers } from './ops/audio';
import { type CompositionStep, compositionHandlers } from './ops/composition';
import { type AnalyzeStep, analyzeHandlers } from './ops/analyze';
import { type ImageStep, imageHandlers } from './ops/images';
import { type PackageStep, packageHandlers } from './ops/package';
import { platformHandlers, type PlatformStep } from './ops/platform';
import { drawtext, fontFile, type TextStep, textHandlers } from './ops/text';
import { type VisualStep, visualHandlers } from './ops/visual';
import type { Container, EncodeStep, Step, StepOf, VideoSettings } from './schema';
import type { Recipe } from './validate';

export type AnalysisKind =
  | 'freeze_detect'
  | 'crop_detect'
  | 'interlace_detect'
  | 'loudness'
  | 'volume'
  | 'silence_detect'
  | 'black_detect'
  | 'scene_changes';

export interface Stage {
  label: string;
  tool: 'ffmpeg' | 'ffprobe';
  args: string[];
  /** Expected media duration of the stage, for progress. */
  durationS: number | null;
  /** Files the executor writes before running the stage (chapter metadata, concat lists). */
  files: { path: string; content: string }[];
  /** Symlinks to create first (concat copy reads inputs under plain names). */
  links: { path: string; target: string }[];
  /** Directories to create first. */
  dirs?: string[];
  /** Analyses whose results are read from ffmpeg's log. */
  analyses: { name: string; kind: AnalysisKind }[];
  /** ffprobe stages produce a report from their stdout. */
  report?: { name: string; kind: string; max: number; meta?: Record<string, unknown> | undefined };
  /** Reports read from files this stage writes. */
  fileReports?: {
    name: string;
    kind: string;
    files: string[];
    meta?: Record<string, unknown> | undefined;
  }[];
  /** Measurement stages feed a value back into the composition. */
  measure?: { key: string; kind: MeasureKind };
}

export interface PlannedFile {
  name: string;
  op: string;
  role: 'media' | 'audio' | 'thumbnail' | 'image' | 'subtitles' | 'package' | 'report';
  /** File name in the output directory; `%03d` marks numbered sequences. */
  pattern: string;
  multiple: boolean;
  mime: string;
  /** target_size_mb outputs are checked against this. */
  targetBytes?: number;
  directory?: boolean;
  entry?: string;
  zip?: boolean;
}

export interface Plan {
  stages: Stage[];
  files: PlannedFile[];
  reports: { name: string; op: string }[];
  /** Work units (SPEC §8a): about one per minute of 1080p30 h264 veryfast encoding. */
  cost: number;
  inputSeconds: number;
}

export type Composition = { kind: 'measure'; stage: Stage } | { kind: 'plan'; plan: Plan };

export type { ComposeInput } from './context';

export interface ComposeOptions {
  workDir: string;
  threads: number;
  maxFileBytes: number;
  limits: ComposeLimits;
  /** Results of earlier measurement stages, by key. */
  measurements: Record<string, unknown>;
  /** whisper.cpp models and availability (transcribe). */
  whisper?: WhisperSetup | undefined;
  /** Installed fonts (text, subtitles, timestamps); without them those operations are refused. */
  fonts?: FontLookup | undefined;
  fontDir?: string | undefined;
}

interface Output {
  maps: string[];
  args: string[];
  target: string;
  durationS: number | null;
  /** First pass of a two-pass video encode. */
  pass1?: { videoMap: string; otherMaps: string[]; args: string[] };
}

/** Thrown when a step needs a measurement pass first; compose() turns it into a result. */
class NeedsMeasurement extends Error {
  constructor(readonly stage: Stage) {
    super(`needs measurement ${stage.measure?.key ?? ''}`);
  }
}

const MB = 1024 * 1024;
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const IMAGE = {
  jpg: { codec: ['-c:v', 'mjpeg'], mime: 'image/jpeg' },
  png: { codec: ['-c:v', 'png'], mime: 'image/png' },
  webp: { codec: ['-c:v', 'libwebp'], mime: 'image/webp' },
} as const;
/** Steps handled by the ops/ modules. */
type OpStep =
  | VisualStep
  | AudioStep
  | CompositionStep
  | TextStep
  | ImageStep
  | PackageStep
  | AnalyzeStep
  | PlatformStep;

/** swscale matrix and the stream tags for each output colour space (SPEC §8b `video.color`). */
const COLOR_TAGS = {
  bt709: { matrix: 'bt709', space: 'bt709', primaries: 'bt709', trc: 'bt709' },
  bt601: { matrix: 'bt601', space: 'smpte170m', primaries: 'smpte170m', trc: 'smpte170m' },
  bt2020: { matrix: 'bt2020', space: 'bt2020nc', primaries: 'bt2020', trc: 'bt2020-10' },
} as const;

const COVER_CONTAINERS = new Set(['mp4', 'm4a', 'mov', 'mkv', 'mp3', 'flac']);
const YUV420_CODECS = new Set(['h264', 'hevc', 'vp9', 'av1', 'av1_aom', 'mjpeg']);
/** Filters whose cost per minute is far above a plain decode. */
const HEAVY_FILTERS: Record<string, number> = { minterpolate: 8, reverse: 0.5, boomerang: 0.2 };

function mainVideo(probe: ProbeSummary): StreamSummary | undefined {
  return probe.streams.find((stream) => stream.type === 'video' && !stream.attached_pic);
}

function mainAudio(probe: ProbeSummary): StreamSummary | undefined {
  return probe.streams.find((stream) => stream.type === 'audio');
}

/** Turns a validated recipe into ffmpeg/ffprobe stages (SPEC §8a); inputs[0] is the main input. */
export function compose(
  recipe: Recipe,
  inputs: readonly ComposeInput[],
  options: ComposeOptions,
): Composition {
  try {
    return { kind: 'plan', plan: new Composer(recipe, inputs, options).run() };
  } catch (error) {
    if (error instanceof NeedsMeasurement) return { kind: 'measure', stage: error.stage };
    throw error;
  }
}

class Composer implements FilterContext {
  readonly graph = new Graph();
  readonly state: Working;
  private readonly inputArgs: string[] = [];
  private readonly extraInputs: string[][] = [];
  private readonly outputs: Output[] = [];
  private readonly files: PlannedFile[] = [];
  private readonly reports: { name: string; op: string }[] = [];
  private readonly analyses: Stage['analyses'] = [];
  private readonly probeStages: Stage[] = [];
  private readonly preStages: Stage[] = [];
  private readonly postStages: Stage[] = [];
  private readonly fileReports: NonNullable<Stage['fileReports']> = [];
  private readonly writeFiles: Stage['files'] = [];
  touched = false;
  private readonly links: Stage['links'] = [];
  private readonly dirs: string[] = [];
  private cost = 0;
  private readonly outDir: string;
  private readonly inputVideo: StreamSummary | undefined;
  private readonly inputAudio: StreamSummary | undefined;
  private readonly input: ComposeInput;
  /** How ffmpeg opens the main input (concat copy replaces it with a list file). */
  mainSource: string[];

  constructor(
    private readonly recipe: Recipe,
    readonly inputs: readonly ComposeInput[],
    private readonly options: ComposeOptions,
  ) {
    const [input] = inputs;
    if (!input) throw new Error('A recipe needs at least one input');
    this.input = input;
    this.mainSource = ['-protocol_whitelist', 'file', '-i', input.path];
    this.outDir = path.join(options.workDir, 'out');
    this.inputVideo = mainVideo(input.probe);
    this.inputAudio = mainAudio(input.probe);
    this.state = {
      video: this.inputVideo ? Graph.input('v') : null,
      audio: this.inputAudio ? Graph.input('a') : null,
      duration: input.probe.duration_s,
      width: this.inputVideo?.width ?? null,
      height: this.inputVideo?.height ?? null,
      fps: this.inputVideo?.fps ?? null,
      sampleRate: this.inputAudio?.sample_rate ?? null,
      transfer: this.inputVideo?.color_transfer ?? null,
      timeAltered: false,
      accurateTrim: false,
      rotatedMetadata: false,
      filtered: false,
      shortest: false,
      audioLabel: {},
      extraAudio: [],
      subtitles: [],
      stripSubtitles: false,
      poster: null,
    };
    // Raw video reads skip cover art ("V" = video streams that are not attached pictures).
    if (this.state.video) this.state.video = { ...this.state.video, label: '0:V:0' };
  }

  get minutes(): number {
    return (this.state.duration ?? 0) / 60;
  }

  /** Pixel rate relative to 1080p30, for the cost model. */
  private pixelFactor(
    width = this.state.width,
    height = this.state.height,
    fps = this.state.fps,
  ): number {
    if (!width || !height) return 1;
    return Math.max(0.05, (width * height * (fps ?? 30)) / (1920 * 1080 * 30));
  }

  run(): Plan {
    const inputMinutes = (this.input.probe.duration_s ?? 0) / 60;
    this.cost += inputMinutes * this.pixelFactor() * 0.2;
    this.recipe.steps.forEach((step, index) => {
      this.step(step, index);
      this.checkLength(index);
      if (!(step.op === 'rotate' && step.metadata_only)) this.touched = true;
    });
    return this.finish();
  }

  // --- helpers ---------------------------------------------------------------------------------

  get workDir(): string {
    return this.options.workDir;
  }

  get limits(): ComposeLimits {
    return this.options.limits;
  }

  video(index: number, op: string): Pad {
    if (!this.state.video) throw invalid(index, `${op} needs a video stream; the input has none`);
    return this.state.video;
  }

  audio(index: number, op: string): Pad {
    if (!this.state.audio) throw invalid(index, `${op} needs an audio stream; the input has none`);
    return this.state.audio;
  }

  duration(index: number, op: string): number {
    if (this.state.duration === null)
      throw invalid(index, `${op} needs the input duration, which is unknown`);
    return this.state.duration;
  }

  /** Applies filters to whichever streams exist; null drops that stream's filters. */
  applyFilters(videoFilters: string[] | null, audioFilters: string[] | null): void {
    if (this.state.video && videoFilters && videoFilters.length > 0) {
      this.state.video = this.graph.chain(this.state.video, videoFilters);
      this.state.filtered = true;
    }
    if (this.state.audio && audioFilters && audioFilters.length > 0) {
      this.state.audio = this.graph.chain(this.state.audio, audioFilters);
      this.state.filtered = true;
    }
  }

  private map(pad: Pad): string {
    return pad.raw ? pad.label : `[${this.graph.read(pad)}]`;
  }

  addCost(units: number): void {
    this.cost += units;
  }

  get maxFileBytes(): number {
    return this.options.maxFileBytes;
  }

  inputPad(input: number, kind: 'v' | 'a', index: number, op: string, stream = 0): Pad {
    const probe = this.inputs[input]?.probe;
    if (!probe)
      throw invalid(index, `${op}: there is no input ${input} (the job has ${this.inputs.length})`);
    const streams = probe.streams.filter((entry) =>
      kind === 'v' ? entry.type === 'video' && !entry.attached_pic : entry.type === 'audio',
    );
    if (!streams[stream])
      throw invalid(
        index,
        `${op}: input ${input} has no ${kind === 'v' ? 'video' : 'audio'} stream ${stream}`,
      );
    return { label: `${input}:${kind === 'v' ? 'V' : 'a'}:${stream}`, kind, raw: true };
  }

  canvas(): { width: number; height: number; fps: number } {
    const first = this.inputs
      .flatMap((input) => input.probe.streams)
      .find((entry) => entry.type === 'video' && !entry.attached_pic);
    const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
    return {
      width: even(this.state.width ?? first?.width ?? 1280),
      height: even(this.state.height ?? first?.height ?? 720),
      fps: Math.round(this.state.fps ?? first?.fps ?? 30),
    };
  }

  get fonts(): FontLookup | undefined {
    return this.options.fonts;
  }

  get fontDir(): string | undefined {
    return this.options.fontDir;
  }

  resolveInput(ref: InputRef, index: number, op: string): number {
    if (typeof ref === 'number') return ref;
    const found = this.inputs.findIndex(
      (input) =>
        input.role === ref.job_output &&
        (ref.lang === undefined || input.lang?.toLowerCase().startsWith(ref.lang.toLowerCase())),
    );
    if (found < 0) {
      throw invalid(
        index,
        `${op}: no ${ref.job_output}${ref.lang ? ` (${ref.lang})` : ''} from the download; job_output inputs exist in then pipelines`,
      );
    }
    return found;
  }

  addPreStage(label: string, args: string[]): void {
    this.preStages.push({
      label,
      tool: 'ffmpeg',
      args: ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', ...args],
      durationS: null,
      // Filled during composition; complete by the time the stage runs.
      files: this.writeFiles,
      links: this.links,
      analyses: [],
    });
  }

  writeFile(file: string, content: string): void {
    this.writeFiles.push({ path: file, content });
  }

  makeDir(dir: string): void {
    this.dirs.push(dir);
  }

  link(file: string, target: string): void {
    this.links.push({ path: file, target });
  }

  addOutput(output: Output | null, file: PlannedFile | null): void {
    if (output) this.outputs.push(output);
    if (file) this.files.push(file);
  }

  get whisper(): WhisperSetup | undefined {
    return this.options.whisper;
  }

  get mainPath(): string {
    return this.input.path;
  }

  addLogReport(name: string, op: string, kind: string): void {
    this.analyses.push({ name, kind: kind as AnalysisKind });
    this.reports.push({ name, op });
  }

  addFileReport(
    name: string,
    op: string,
    kind: string,
    files: string[],
    meta?: Record<string, unknown>,
  ): void {
    this.fileReports.push({ name, kind, files, meta });
    this.reports.push({ name, op });
  }

  addProbeReport(
    name: string,
    op: string,
    kind: string,
    args: string[],
    meta?: Record<string, unknown>,
  ): void {
    this.probeStages.push({
      label: op,
      tool: 'ffprobe',
      args: ['-v', 'error', '-protocol_whitelist', 'file', ...args],
      durationS: null,
      files: [],
      links: [],
      analyses: [],
      report: { name, kind, max: 0, meta },
    });
    this.reports.push({ name, op });
  }

  addPostStage(label: string, args: string[]): void {
    this.postStages.push({
      label,
      tool: 'ffmpeg',
      args: ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', ...args],
      durationS: null,
      files: [],
      links: [],
      analyses: [],
    });
  }

  filterCost(minutes: number, weight: number, video = true): void {
    this.cost += minutes * (video ? this.pixelFactor() : 0.05) * weight;
  }

  private checkLength(index: number): void {
    const max = this.options.limits.MAX_MEDIA_DURATION_MINUTES * 60;
    if (this.state.duration !== null && this.state.duration > max) {
      throw new AppError(
        'MEDIA_TOO_LONG',
        `steps.${index}: the result would exceed ${this.options.limits.MAX_MEDIA_DURATION_MINUTES} minutes`,
      );
    }
  }

  requireUntouched(index: number, kind: 'video' | 'audio'): void {
    const pad = this.state[kind];
    if (pad && !pad.raw) throw invalid(index, `${kind} copy cannot follow filters; encode instead`);
    if (this.state.accurateTrim) {
      throw invalid(
        index,
        'stream copy cuts at keyframes; set the leading trim to mode "copy" or encode',
      );
    }
  }

  // --- steps -----------------------------------------------------------------------------------

  private step(step: Step, index: number): void {
    switch (step.op) {
      case 'trim':
        this.trim(step, index);
        break;
      case 'cut_out':
        this.cutOut(step, index);
        break;
      case 'speed':
        this.speed(step, index);
        break;
      case 'reverse':
        this.reverse(step, index);
        break;
      case 'boomerang':
        this.boomerang(step, index);
        break;
      case 'fps':
        this.fps(step, index);
        break;
      case 'timelapse':
        this.timelapse(step, index);
        break;
      case 'loop':
        this.loop(step, index);
        break;
      case 'fade':
        this.fade(step, index);
        break;
      case 'pad_duration':
        this.padDuration(step);
        break;
      case 'audio_offset':
        this.audioOffset(step, index);
        break;
      case 'scale':
        this.scale(step, index);
        break;
      case 'image_resize':
        this.scale({ ...step, op: 'scale' }, index);
        break;
      case 'image_crop':
        this.crop({ ...step, op: 'crop' }, index);
        break;
      case 'segment':
        this.split({ ...step, op: 'split', mode: 'copy', chapters: 'keep' }, index);
        break;
      case 'crop':
        this.crop(step, index);
        break;
      case 'rotate':
        this.rotate(step, index);
        break;
      case 'pad':
        this.pad(step, index);
        break;
      case 'aspect':
        this.aspect(step, index);
        break;
      case 'encode':
        this.encode(step, index);
        break;
      case 'split':
        this.split(step, index);
        break;
      case 'thumbnail':
        this.thumbnail(step, index);
        break;
      case 'contact_sheet':
        this.contactSheet(step, index);
        break;
      case 'gif':
        this.gif(step, index);
        break;
      case 'remux':
        this.remux(step, index);
        break;
      case 'fix':
        this.fix(step, index);
        break;
      case 'probe':
      case 'keyframes':
        this.probeReport(step, index);
        break;
      case 'loudness':
      case 'volume':
      case 'silence_detect':
      case 'black_detect':
      case 'scene_changes':
        this.analysis(step, index);
        break;
      default:
        this.filter(step, index);
    }
  }

  /** Visual and audio filters from ops/ (SPEC §8f, §8g). */
  private filter(step: OpStep, index: number): void {
    const handlers = {
      ...visualHandlers,
      ...audioHandlers,
      ...compositionHandlers,
      ...textHandlers,
      ...imageHandlers,
      ...packageHandlers,
      ...analyzeHandlers,
      ...platformHandlers,
    } as Record<string, ((ctx: FilterContext, step: OpStep, index: number) => void) | undefined>;
    const handler = handlers[step.op];
    if (!handler) throw new Error(`No handler for ${step.op}`);
    handler(this, step, index);
  }

  name(index: number): string {
    const name = this.recipe.names.get(index);
    if (name === undefined) throw new Error(`No output name for step ${index}`);
    return name;
  }

  private trim(step: StepOf<'trim'>, index: number): void {
    const start = step.start ?? 0;
    const total = this.state.duration;
    if (total !== null && start >= total)
      throw invalid(index, 'trim starts after the end of the media');
    const bounded = step.end !== undefined || step.duration !== undefined;
    let length =
      step.duration ??
      (step.end !== undefined ? step.end - start : total === null ? null : total - start);
    if (length !== null && total !== null) length = Math.min(length, total - start);
    if (!this.touched) {
      // Input seeking: fast, and frame-accurate whenever the output is encoded.
      if (start > 0) this.inputArgs.push('-ss', num(start));
      if (bounded && length !== null) this.inputArgs.push('-t', num(length));
      this.state.accurateTrim = step.mode === 'accurate';
    } else {
      if (step.mode === 'copy')
        throw invalid(index, 'trim mode "copy" works only as the first step');
      const range = [
        `start=${num(start)}`,
        ...(bounded && length !== null ? [`duration=${num(length)}`] : []),
      ].join(':');
      this.applyFilters(
        [`trim=${range}`, 'setpts=PTS-STARTPTS'],
        [`atrim=${range}`, 'asetpts=PTS-STARTPTS'],
      );
      this.state.timeAltered = true;
    }
    this.state.duration = length;
  }

  private cutOut(step: StepOf<'cut_out'>, index: number): void {
    const total = this.duration(index, 'cut_out');
    const ranges = [...step.ranges].sort((a, b) => a.start - b.start);
    let removed = 0;
    let covered = 0;
    for (const range of ranges) {
      const from = Math.max(range.start, covered);
      const to = Math.min(range.end, total);
      if (to > from) removed += to - from;
      covered = Math.max(covered, range.end);
    }
    if (removed >= total) throw invalid(index, 'cut_out removes everything');
    const keep = `'not(${ranges.map((range) => `between(t,${num(range.start)},${num(range.end)})`).join('+')})'`;
    const rate = this.state.fps ? num(this.state.fps) : 'FRAME_RATE';
    this.applyFilters(
      [`select=${keep}`, `setpts=N/(${rate})/TB`],
      [`aselect=${keep}`, 'asetpts=N/SR/TB'],
    );
    this.state.duration = total - removed;
    this.state.timeAltered = true;
  }

  private speed(step: StepOf<'speed'>, index: number): void {
    const factor = step.factor;
    let audio: string[] | null = null;
    if (this.state.audio && !step.mute) {
      if (step.preserve_pitch) {
        audio = atempoChain(factor);
      } else {
        const rate = this.state.sampleRate;
        if (!rate) throw invalid(index, 'speed without preserve_pitch needs the audio sample rate');
        audio = [`asetrate=${Math.round(rate * factor)}`, `aresample=${rate}`];
      }
    }
    this.applyFilters([`setpts=PTS/${num(factor)}`], audio);
    if (step.mute) this.state.audio = null;
    if (this.state.duration !== null) this.state.duration /= factor;
    if (this.state.fps !== null) this.state.fps *= factor;
    this.state.timeAltered = true;
  }

  private reverse(step: StepOf<'reverse'>, index: number): void {
    const total = this.duration(index, 'reverse');
    const max = this.options.limits.REVERSE_MAX_SECONDS;
    if (total > max)
      throw invalid(index, `reverse buffers the whole clip; trim it to ${max} seconds first`);
    this.applyFilters(step.video ? ['reverse'] : null, step.audio ? ['areverse'] : null);
    this.filterCost(total / 60, HEAVY_FILTERS.reverse ?? 1);
    this.state.timeAltered = true;
  }

  private boomerang(step: StepOf<'boomerang'>, index: number): void {
    const total = this.duration(index, 'boomerang');
    if (step.start >= total) throw invalid(index, 'boomerang starts after the end of the media');
    const length = Math.min(step.duration, total - step.start);
    const range = `start=${num(step.start)}:duration=${num(length)}`;
    const there = (pad: Pad, kind: 'v' | 'a') => {
      const clip = this.graph.chain(
        pad,
        kind === 'v'
          ? [`trim=${range}`, 'setpts=PTS-STARTPTS']
          : [`atrim=${range}`, 'asetpts=PTS-STARTPTS'],
      );
      const back = this.graph.chain(clip, [kind === 'v' ? 'reverse' : 'areverse']);
      const out = this.graph.newPad(kind);
      this.graph.segment(
        `[${this.graph.read(clip)}][${this.graph.read(back)}]concat=n=2:v=${kind === 'v' ? 1 : 0}:a=${kind === 'a' ? 1 : 0}[${out.label}]`,
      );
      return out;
    };
    if (this.state.video) this.state.video = there(this.state.video, 'v');
    if (this.state.audio) this.state.audio = there(this.state.audio, 'a');
    this.state.filtered = true;
    this.state.duration = length * 2;
    this.state.timeAltered = true;
  }

  private fps(step: StepOf<'fps'>, index: number): void {
    this.video(index, 'fps');
    if (step.mode === 'interpolate') {
      const total = this.duration(index, 'fps interpolation');
      const max = this.options.limits.INTERPOLATE_MAX_SECONDS;
      if (total > max) throw invalid(index, `interpolation is limited to ${max} seconds of media`);
      this.applyFilters([`minterpolate=fps=${num(step.value)}:mi_mode=mci`], null);
      this.state.fps = step.value;
      this.filterCost(total / 60, HEAVY_FILTERS.minterpolate ?? 1);
      return;
    }
    this.applyFilters([`fps=${num(step.value)}`], null);
    this.state.fps = step.value;
  }

  private timelapse(step: StepOf<'timelapse'>, index: number): void {
    this.video(index, 'timelapse');
    const rate = this.state.fps ? num(this.state.fps) : 'FRAME_RATE';
    this.applyFilters(
      [`select='not(mod(n,${step.every_nth_frame}))'`, `setpts=N/(${rate})/TB`],
      null,
    );
    // A sped-up picture has no meaningful sound.
    this.state.audio = null;
    if (this.state.duration !== null) this.state.duration /= step.every_nth_frame;
    this.state.timeAltered = true;
  }

  private loop(step: StepOf<'loop'>, index: number): void {
    const total = this.state.duration;
    if (!this.touched) {
      // Looping the input file costs no memory.
      if (step.count !== undefined) {
        this.inputArgs.push('-stream_loop', String(step.count));
        this.state.duration = total === null ? null : total * (step.count + 1);
      } else {
        const target = step.to_duration_s ?? 0;
        this.inputArgs.push('-stream_loop', '-1', '-t', num(target));
        this.state.duration = target;
      }
      return;
    }
    const length = this.duration(index, 'loop');
    const max = this.options.limits.REVERSE_MAX_SECONDS;
    if (length > max)
      throw invalid(
        index,
        `loop after other steps buffers the clip; it is limited to ${max} seconds (or make loop the first step)`,
      );
    const count = step.count ?? Math.max(1, Math.ceil((step.to_duration_s ?? 0) / length) - 1);
    const frames = Math.ceil(length * (this.state.fps ?? 30)) + 1;
    const samples = Math.ceil(length * (this.state.sampleRate ?? 48_000)) + 1;
    const rate = this.state.fps ? num(this.state.fps) : 'FRAME_RATE';
    const cut = step.to_duration_s === undefined ? [] : [`duration=${num(step.to_duration_s)}`];
    this.applyFilters(
      [
        `loop=loop=${count}:size=${frames}:start=0`,
        `setpts=N/(${rate})/TB`,
        ...cut.map((range) => `trim=${range}`),
      ],
      [
        `aloop=loop=${count}:size=${samples}:start=0`,
        'asetpts=N/SR/TB',
        ...cut.map((range) => `atrim=${range}`),
      ],
    );
    this.state.duration = step.to_duration_s ?? length * (count + 1);
    this.state.timeAltered = true;
  }

  private fade(step: StepOf<'fade'>, index: number): void {
    if (step.in_s === 0 && step.out_s === 0) throw invalid(index, 'fade needs in_s or out_s');
    const video: string[] = [];
    const audio: string[] = [];
    if (step.in_s > 0) {
      video.push(`fade=t=in:st=0:d=${num(step.in_s)}:color=${step.color}`);
      audio.push(`afade=t=in:st=0:d=${num(step.in_s)}`);
    }
    if (step.out_s > 0) {
      const total = this.duration(index, 'fade out');
      if (step.in_s + step.out_s > total)
        throw invalid(index, 'the fades are longer than the media');
      const start = num(total - step.out_s);
      video.push(`fade=t=out:st=${start}:d=${num(step.out_s)}:color=${step.color}`);
      audio.push(`afade=t=out:st=${start}:d=${num(step.out_s)}`);
    }
    this.applyFilters(video, step.audio ? audio : null);
  }

  private padDuration(step: StepOf<'pad_duration'>): void {
    const total = this.state.duration;
    if (total !== null && total >= step.to_duration_s) return;
    const extra = num(step.to_duration_s - (total ?? 0));
    const video =
      step.mode === 'freeze'
        ? `tpad=stop_mode=clone:stop_duration=${extra}`
        : `tpad=stop_mode=add:stop_duration=${extra}:color=black`;
    this.applyFilters(step.mode === 'silence' && !this.state.video ? null : [video], [
      `apad=pad_dur=${extra}`,
    ]);
    this.state.duration = step.to_duration_s;
    this.state.timeAltered = true;
  }

  private audioOffset(step: StepOf<'audio_offset'>, index: number): void {
    this.audio(index, 'audio_offset');
    if (step.ms > 0) this.applyFilters(null, [`adelay=delays=${step.ms}:all=1`]);
    else if (step.ms < 0)
      this.applyFilters(null, [`atrim=start=${num(-step.ms / 1000)}`, 'asetpts=PTS-STARTPTS']);
    this.state.timeAltered = true;
  }

  private scale(step: StepOf<'scale'>, index: number): void {
    const video = this.video(index, 'scale');
    const flags = `flags=${step.algorithm}`;
    const { width: w0, height: h0 } = this.state;
    const { width, height } = step;
    if (width === undefined || height === undefined) {
      const byHeight = height !== undefined;
      const target = height ?? width ?? 0;
      const size = step.upscale
        ? String(target)
        : `'trunc(min(${target},${byHeight ? 'ih' : 'iw'})/2)*2'`;
      this.applyFilters(
        [byHeight ? `scale=w=-2:h=${size}:${flags}` : `scale=w=${size}:h=-2:${flags}`],
        null,
      );
      if (w0 && h0) {
        const factor = byHeight
          ? (step.upscale ? target : Math.min(target, h0)) / h0
          : (step.upscale ? target : Math.min(target, w0)) / w0;
        this.state.width = even(w0 * factor);
        this.state.height = even(h0 * factor);
      }
      return;
    }
    const box = step.upscale ? `${width}:${height}` : `w='min(${width},iw)':h='min(${height},ih)'`;
    const contain = `scale=${box}:force_original_aspect_ratio=decrease:force_divisible_by=2:${flags}`;
    switch (step.fit) {
      case 'stretch':
        this.applyFilters([`scale=${width}:${height}:${flags}`, 'setsar=1'], null);
        break;
      case 'cover':
        this.applyFilters(
          [
            `scale=${width}:${height}:force_original_aspect_ratio=increase:${flags}`,
            `crop=${width}:${height}`,
            'setsar=1',
          ],
          null,
        );
        break;
      case 'contain':
        this.applyFilters([contain, 'setsar=1'], null);
        if (w0 && h0) {
          const factor = Math.min(width / w0, height / h0, step.upscale ? Infinity : 1);
          this.state.width = even(w0 * factor);
          this.state.height = even(h0 * factor);
        }
        return;
      case 'pad':
        if (step.pad === 'blur') {
          const background = this.graph.chain(video, [
            `scale=${width}:${height}:${flags}`,
            'boxblur=20:2',
          ]);
          const foreground = this.graph.chain(video, [contain]);
          const out = this.graph.newPad('v');
          this.graph.segment(
            `[${this.graph.read(background)}][${this.graph.read(foreground)}]overlay=(W-w)/2:(H-h)/2[${out.label}]`,
          );
          this.state.video = this.graph.chain(out, ['setsar=1']);
          this.state.filtered = true;
        } else {
          this.applyFilters(
            [
              contain,
              `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${step.pad_color}`,
              'setsar=1',
            ],
            null,
          );
        }
        break;
    }
    this.state.width = width;
    this.state.height = height;
  }

  private crop(step: StepOf<'crop'>, index: number): void {
    const video = this.video(index, 'crop');
    const { width: w0, height: h0 } = this.state;
    if (step.auto) {
      // null: cropdetect saw nothing to remove.
      const found = this.measured(
        `crop:${index}`,
        'crop',
        video,
        `cropdetect=limit=${step.limit}:round=${step.round}:reset=0`,
      ) as { w: number; h: number; x: number; y: number } | null;
      if (!found) return;
      this.applyFilters([`crop=${found.w}:${found.h}:${found.x}:${found.y}`], null);
      this.state.width = found.w;
      this.state.height = found.h;
      return;
    }
    if (step.aspect) {
      const { width: aw, height: ah } = step.aspect;
      const g = step.gravity;
      const x = g.includes('left') ? '0' : g.includes('right') ? 'iw-ow' : '(iw-ow)/2';
      const y = g.includes('top') ? '0' : g.includes('bottom') ? 'ih-oh' : '(ih-oh)/2';
      this.applyFilters(
        [
          `crop=w='trunc(min(iw,ih*${aw}/${ah})/2)*2':h='trunc(min(ih,iw*${ah}/${aw})/2)*2':x=${x}:y=${y}`,
        ],
        null,
      );
      if (w0 && h0) {
        this.state.width = even(Math.min(w0, (h0 * aw) / ah));
        this.state.height = even(Math.min(h0, (w0 * ah) / aw));
      }
      return;
    }
    const [x, y, w, h] = [step.x ?? 0, step.y ?? 0, step.w ?? 0, step.h ?? 0];
    if (w0 && h0 && (x + w > w0 || y + h > h0)) {
      throw invalid(index, `the crop box ${w}x${h}+${x}+${y} is outside the ${w0}x${h0} picture`);
    }
    this.applyFilters([`crop=${w}:${h}:${x}:${y}`], null);
    this.state.width = w;
    this.state.height = h;
  }

  /** A cheap pass over keyframes with cropdetect (SPEC §8e crop auto). */
  measured(key: string, kind: MeasureKind, pad: Pad, filter: string): unknown {
    if (key in this.options.measurements) return this.options.measurements[key];
    throw new NeedsMeasurement(this.measurementStage(key, kind, pad, filter));
  }

  /**
   * The graph so far plus the measuring filter, every open branch drained into a null output.
   * Crop detection only needs keyframes, which makes its pass cheap.
   */
  private measurementStage(key: string, kind: MeasureKind, pad: Pad, filter: string): Stage {
    this.graph.chain(pad, [filter]);
    const { text, dangling } = this.graph.finish();
    return {
      label: `measure ${kind}`,
      tool: 'ffmpeg',
      args: [
        ...this.globalArgs(),
        ...this.inputSection(kind === 'crop' ? ['-skip_frame', 'nokey'] : []),
        '-filter_complex',
        text,
        ...dangling.flatMap((label) => ['-map', `[${label}]`]),
        '-f',
        'null',
        '-',
      ],
      durationS: this.state.duration,
      files: [],
      links: [],
      analyses: [],
      measure: { key, kind },
    };
  }

  private rotate(step: StepOf<'rotate'>, index: number): void {
    this.video(index, 'rotate');
    if (step.metadata_only) {
      // ffmpeg's display rotation is counter-clockwise; recipes speak clockwise.
      this.inputArgs.push('-display_rotation:v:0', String(-(step.degrees ?? 0)));
      this.state.rotatedMetadata = true;
      return;
    }
    const filters: string[] = [];
    if (step.degrees === 90) filters.push('transpose=clock');
    if (step.degrees === 270) filters.push('transpose=cclock');
    if (step.degrees === 180) filters.push('hflip', 'vflip');
    if (step.angle_deg !== undefined)
      filters.push(`rotate=a=${num(step.angle_deg)}*PI/180:c=${step.fill_color}`);
    if (step.flip_h) filters.push('hflip');
    if (step.flip_v) filters.push('vflip');
    this.applyFilters(filters, null);
    if (step.degrees === 90 || step.degrees === 270)
      [this.state.width, this.state.height] = [this.state.height, this.state.width];
  }

  private aspect(step: StepOf<'aspect'>, index: number): void {
    this.video(index, 'aspect');
    const dar = step.dar ? [`setdar=${step.dar.width}/${step.dar.height}`] : [];
    this.applyFilters([...(step.sar_1 ? ['setsar=1'] : []), ...dar], null);
  }

  private pad(step: StepOf<'pad'>, index: number): void {
    const video = this.video(index, 'pad');
    const { width: w0, height: h0 } = this.state;
    const g = step.position;
    let width: string;
    let height: string;
    if (step.aspect) {
      const { width: aw, height: ah } = step.aspect;
      width = `'trunc(max(iw,ih*${aw}/${ah})/2)*2'`;
      height = `'trunc(max(ih,iw*${ah}/${aw})/2)*2'`;
      if (w0 && h0)
        [this.state.width, this.state.height] = [
          even(Math.max(w0, (h0 * aw) / ah)),
          even(Math.max(h0, (w0 * ah) / aw)),
        ];
    } else {
      const [w, h] = [step.width ?? 0, step.height ?? 0];
      if (w0 && h0 && (w < w0 || h < h0))
        throw invalid(
          index,
          `pad cannot shrink ${w0}x${h0} to ${w}x${h}; scale with fit "pad" instead`,
        );
      [width, height] = [String(w), String(h)];
      [this.state.width, this.state.height] = [w, h];
    }
    if (step.blur) {
      const x = g.includes('left') ? '0' : g.includes('right') ? 'W-w' : '(W-w)/2';
      const y = g.includes('top') ? '0' : g.includes('bottom') ? 'H-h' : '(H-h)/2';
      const background = this.graph.chain(video, [`scale=w=${width}:h=${height}`, 'boxblur=20:2']);
      const out = this.graph.newPad('v');
      this.graph.segment(
        `[${this.graph.read(background)}][${this.graph.read(video)}]overlay=${x}:${y}[${out.label}]`,
      );
      this.state.video = out;
      this.state.filtered = true;
      return;
    }
    const x = g.includes('left') ? '0' : g.includes('right') ? 'ow-iw' : '(ow-iw)/2';
    const y = g.includes('top') ? '0' : g.includes('bottom') ? 'oh-ih' : '(oh-ih)/2';
    this.applyFilters([`pad=w=${width}:h=${height}:x=${x}:y=${y}:color=${step.color}`], null);
  }

  // --- terminals -------------------------------------------------------------------------------

  outputTarget(name: string, ext: string, multiple = false): string {
    return path.join(this.outDir, multiple ? `${name}_%03d.${ext}` : `${name}.${ext}`);
  }

  threadArgs(): string[] {
    return ['-threads', String(this.options.threads)];
  }

  /** The codec of an untouched input stream pad ("1:a:0"), or null for filter outputs. */
  private rawCodec(pad: Pad): string | null {
    const match = /^(\d+):([Va]):(\d+)$/.exec(pad.label);
    if (!pad.raw || !match) return null;
    const [, input, kind, n] = match;
    const streams = this.inputs[Number(input)]?.probe.streams.filter((entry) =>
      kind === 'V' ? entry.type === 'video' && !entry.attached_pic : entry.type === 'audio',
    );
    return streams?.[Number(n)]?.codec ?? null;
  }

  /** Subtitle streams added with subtitles_mux, converted to what the container takes. */
  private subtitleArgs(container: Container, index: number): { maps: string[]; args: string[] } {
    const tracks = this.state.subtitles;
    if (tracks.length === 0) return { maps: [], args: [] };
    const target = SUBTITLE_TARGET[container];
    if (!target)
      throw invalid(index, `${container} cannot carry subtitles (mp4, mov, mkv, webm can)`);
    const args: string[] = [];
    tracks.forEach((track, k) => {
      const text = isTextSubtitle(track.codec);
      let codec: string;
      if (container === 'mkv') {
        codec =
          track.format === 'webvtt'
            ? 'webvtt'
            : (track.format ??
              (text
                ? track.codec === 'subrip' || track.codec === 'ass'
                  ? 'copy'
                  : 'srt'
                : 'copy'));
        if (codec === 'srt' && track.format === undefined && !text) codec = 'copy';
      } else {
        if (!text)
          throw invalid(
            index,
            `${container} takes text subtitles only; track ${k} is a picture subtitle`,
          );
        if (track.format && track.format !== (container === 'webm' ? 'webvtt' : 'mov_text')) {
          throw invalid(index, `${container} stores subtitles as ${target}, not ${track.format}`);
        }
        codec = target;
      }
      args.push(`-c:s:${k}`, codec);
      if (track.language)
        args.push(`-metadata:s:s:${k}`, `language=${streamLanguage(track.language, container)}`);
      if (track.title) args.push(`-metadata:s:s:${k}`, `title=${track.title}`);
      const flags = [track.default && 'default', track.forced && 'forced']
        .filter(Boolean)
        .join('+');
      args.push(`-disposition:s:${k}`, flags || '0');
    });
    return { maps: tracks.map((track) => track.map), args };
  }

  /** Cover art from an image input (SPEC §8b `cover`): an attached picture after the video. */
  /** Cover art (SPEC §8b `cover`) from an image input or a poster_frame: an attached picture. */
  private coverArgs(
    step: EncodeStep,
    index: number,
    hasVideo: boolean,
  ): { maps: string[]; args: string[] } {
    const poster = this.state.poster;
    if (!step.cover && !poster) return { maps: [], args: [] };
    if (!COVER_CONTAINERS.has(step.container)) {
      throw invalid(
        index,
        `${step.container} cannot carry cover art (mp4, m4a, mov, mkv, mp3, flac can)`,
      );
    }
    const n = hasVideo ? 1 : 0;
    const cover = step.cover ? this.resolveInput(step.cover.input, index, 'cover') : undefined;
    const map =
      cover !== undefined
        ? this.inputPad(cover, 'v', index, 'cover').label
        : poster
          ? this.map(poster)
          : '';
    const mp3 =
      step.container === 'mp3'
        ? [`-metadata:s:v:${n}`, 'title=Album cover', `-metadata:s:v:${n}`, 'comment=Cover (front)']
        : [];
    return {
      maps: [map],
      args: [
        `-c:v:${n}`,
        'mjpeg',
        `-pix_fmt:v:${n}`,
        'yuvj420p',
        `-disposition:v:${n}`,
        'attached_pic',
        `-frames:v:${n}`,
        '1',
        ...mp3,
      ],
    };
  }

  /** Maps and encoder arguments shared by encode and accurate split. */
  encodeStreams(
    step: Pick<EncodeStep, 'container' | 'video' | 'audio'>,
    index: number,
    name: string,
  ) {
    const { container, video, audio } = step;
    const info = CONTAINER_INFO[container];
    const codecs = ENCODE_CODECS[container];
    let videoCodec = video?.codec ?? (info.video ? (codecs.video[0] ?? 'none') : 'none');
    let audioCodec = audio?.codec ?? codecs.audio[0] ?? 'none';
    if (!this.state.video) {
      if (video?.codec !== undefined && video.codec !== 'none')
        throw invalid(index, 'the input has no video stream');
      videoCodec = 'none';
    }
    if (!this.state.audio) audioCodec = 'none';
    if (videoCodec === 'none' && audioCodec === 'none')
      throw invalid(
        index,
        `nothing to write: the input has no ${info.video ? 'video or ' : ''}audio`,
      );

    const maps: string[] = [];
    const args: string[] = [];
    const minutes = this.minutes;
    let pass1: Output['pass1'];
    let targetBytes: number | undefined;
    if (videoCodec === 'copy') {
      this.requireUntouched(index, 'video');
      if (!copyAllowed(container, 'video', this.inputVideo?.codec ?? null)) {
        throw invalid(
          index,
          `${container} cannot hold the input's ${this.inputVideo?.codec ?? 'unknown'} video without encoding`,
        );
      }
      maps.push(this.video(index, 'encode').label);
      args.push('-c:v', 'copy');
      this.cost += minutes * 0.01;
    } else if (videoCodec !== 'none') {
      if (this.state.rotatedMetadata)
        throw invalid(index, 'rotate with metadata_only needs video.codec "copy"');
      const pad = this.video(index, 'encode');
      const filters: string[] = [];
      if (video?.fps !== undefined) filters.push(`fps=${num(video.fps)}`);
      if (video?.color) {
        const color = COLOR_TAGS[video.color.space];
        // The encoder takes colour tags from the frames, so they are set on the frames too.
        filters.push(
          `scale=out_color_matrix=${color.matrix}:out_range=${video.color.range}`,
          `setparams=colorspace=${color.space}:color_primaries=${color.primaries}:color_trc=${color.trc}:range=${video.color.range}`,
        );
        args.push(
          '-colorspace',
          color.space,
          '-color_primaries',
          color.primaries,
          '-color_trc',
          color.trc,
          '-color_range',
          video.color.range,
        );
      }
      const { width, height } = this.state;
      if (
        YUV420_CODECS.has(videoCodec) &&
        (!width || !height || width % 2 !== 0 || height % 2 !== 0)
      ) {
        filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
      }
      const videoMap = this.map(this.graph.chain(pad, filters));
      maps.push(videoMap);
      let bitrateKbps: number | undefined;
      if (video?.target_size_mb !== undefined) {
        const seconds = this.duration(index, 'target_size_mb');
        const audioKbps =
          audioCodec === 'none'
            ? 0
            : audioCodec === 'copy'
              ? (this.inputAudio?.bit_rate ?? 192_000) / 1000
              : (audio?.bitrate_kbps ?? DEFAULT_AUDIO_KBPS[audioCodec]);
        if (audioKbps === null)
          throw invalid(index, 'a lossless audio codec cannot meet target_size_mb');
        targetBytes = video.target_size_mb * MB;
        bitrateKbps = Math.floor((targetBytes * 8 * 0.97) / 1000 / seconds - audioKbps);
        if (bitrateKbps < 50)
          throw invalid(
            index,
            `${video.target_size_mb} MB is too small for ${Math.round(seconds)} seconds`,
          );
      }
      // platform_format: its profile, level and bitrate cap unless the recipe sets its own.
      const platform = videoCodec === 'h264' ? this.state.platform : undefined;
      if (platform && video?.bitrate_kbps === undefined && video?.target_size_mb === undefined) {
        args.push(
          '-maxrate',
          `${platform.maxrateKbps}k`,
          '-bufsize',
          `${platform.maxrateKbps * 2}k`,
        );
      }
      const fps = video?.fps ?? this.state.fps;
      const twoPass = video?.two_pass === true || bitrateKbps !== undefined;
      const logFile = path.join(this.options.workDir, `pass-${name}`);
      const encoded = videoCodec;
      const settings: VideoSettings | undefined = platform
        ? {
            two_pass: false,
            scene_cut: true,
            fragmented: false,
            hw: 'auto',
            ...video,
            profile: video?.profile ?? platform.profile,
            level: video?.level ?? platform.level,
          }
        : video;
      args.push(
        ...videoArgs(encoded, settings, {
          fps,
          bitrateKbps,
          pass: twoPass ? { number: 2, logFile } : undefined,
        }),
      );
      if (twoPass)
        pass1 = {
          videoMap,
          otherMaps: [],
          args: videoArgs(encoded, settings, { fps, bitrateKbps, pass: { number: 1, logFile } }),
        };
      const weight =
        VIDEO_COST[encoded] *
        (['h264', 'hevc'].includes(encoded)
          ? (PRESET_COST[String(video?.preset ?? 'veryfast')] ?? 1)
          : 1);
      this.cost += minutes * this.pixelFactor(width, height, fps) * weight * (twoPass ? 1.6 : 1);
    }
    const extras = audioCodec === 'none' ? [] : this.state.extraAudio;
    if (extras.length > 0 && !info.video)
      throw invalid(
        index,
        `${container} holds one audio stream; add_audio_track needs mp4, mov, mkv, webm or mpegts`,
      );
    if (audioCodec === 'copy') {
      this.requireUntouched(index, 'audio');
      for (const pad of [this.audio(index, 'encode'), ...extras.map((extra) => extra.pad)]) {
        const codec = this.rawCodec(pad);
        if (!pad.raw || !copyAllowed(container, 'audio', codec)) {
          throw invalid(
            index,
            `${container} cannot take the audio (${codec ?? 'filtered'}) without encoding`,
          );
        }
        maps.push(pad.label);
      }
      args.push('-c:a', 'copy');
    } else if (audioCodec !== 'none') {
      const resample = audio?.sample_rate ? [`aresample=${audio.sample_rate}:resampler=soxr`] : [];
      const audioMap = this.map(this.graph.chain(this.audio(index, 'encode'), resample));
      maps.push(
        audioMap,
        ...extras.map((extra) => this.map(this.graph.chain(extra.pad, resample))),
      );
      const label = this.state.audioLabel;
      args.push(
        ...audioArgs(
          audioCodec,
          {
            ...audio,
            // platform_format sets the AAC bitrate unless the recipe does.
            bitrate_kbps:
              audio?.bitrate_kbps ??
              (audio?.vbr === undefined && audioCodec === 'aac'
                ? this.state.platform?.audioKbps
                : undefined),
            language: audio?.language ?? label.language,
            title: audio?.title ?? label.title,
          },
          container,
        ),
      );
      if (pass1) pass1.otherMaps.push(...maps.slice(1).filter((map) => map.startsWith('[')));
      this.cost += minutes * 0.02 * (1 + extras.length);
    }
    extras.forEach((extra, i) => {
      const n = i + 1;
      if (extra.language)
        args.push(`-metadata:s:a:${n}`, `language=${streamLanguage(extra.language, container)}`);
      if (extra.title) args.push(`-metadata:s:a:${n}`, `title=${extra.title}`);
    });
    const preferred = extras.findIndex((extra) => extra.default);
    if (preferred >= 0)
      args.push('-disposition:a:0', '0', `-disposition:a:${preferred + 1}`, 'default');
    return { maps, args, pass1, targetBytes, hasVideo: videoCodec !== 'none' };
  }

  private encode(step: EncodeStep, index: number): void {
    const name = this.name(index);
    const info = CONTAINER_INFO[step.container];
    const streams = this.encodeStreams(step, index, name);
    const cover = this.coverArgs(step, index, streams.hasVideo);
    const subtitles = this.subtitleArgs(step.container, index);
    const args = [...streams.args, ...cover.args, ...subtitles.args];
    let stripChapters =
      step.chapters === 'strip' || (step.chapters === 'keep' && this.state.timeAltered);
    if (typeof step.chapters === 'object') {
      const file = path.join(this.options.workDir, `chapters-${name}.txt`);
      this.writeFiles.push({ path: file, content: chaptersFile(step.chapters.set) });
      this.extraInputs.push(['-f', 'ffmetadata', '-protocol_whitelist', 'file', '-i', file]);
      args.push('-map_chapters', String(this.inputs.length + this.extraInputs.length - 1));
      stripChapters = false;
    }
    args.push(
      ...containerArgs(step, stripChapters),
      ...(this.state.shortest ? ['-shortest'] : []),
      ...this.threadArgs(),
      '-fs',
      String(this.options.maxFileBytes),
    );
    const target = this.outputTarget(name, info.ext);
    this.outputs.push({
      maps: [...streams.maps, ...cover.maps, ...subtitles.maps],
      args,
      target,
      durationS: this.state.duration,
      ...(streams.pass1 && { pass1: streams.pass1 }),
    });
    this.files.push({
      name,
      op: 'encode',
      role: streams.hasVideo ? 'media' : 'audio',
      pattern: path.basename(target),
      multiple: false,
      mime: streams.hasVideo ? info.mime : info.mime.replace(/^video\//, 'audio/'),
      ...(streams.targetBytes !== undefined && { targetBytes: streams.targetBytes }),
    });
  }

  /** Cut points for split: given, chapter starts, or the middle of measured silences or scenes. */
  private splitTimes(step: StepOf<'split'>, index: number, total: number): number[] {
    let times: number[] = step.at ?? [];
    if (step.by_chapters) {
      if (this.touched)
        throw invalid(index, 'by_chapters uses the input chapters; make split the first step');
      times = (this.input.probe.chapters ?? []).map((chapter) => chapter.start_s);
      if (times.length < 2) throw invalid(index, 'the input has no chapters to split by');
    }
    if (step.by_silence) {
      const audio = this.audio(index, 'split by_silence');
      const silences = (this.measured(
        `split-silence:${index}`,
        'silence',
        audio,
        `silencedetect=n=${num(step.by_silence.threshold_db)}dB:d=${num(step.by_silence.min_silence_s)}`,
      ) ?? []) as { start_s: number; end_s: number }[];
      times = silences.map((silence) => (silence.start_s + silence.end_s) / 2);
    }
    if (step.by_scene) {
      const video = this.video(index, 'split by_scene');
      times = (this.measured(
        `split-scenes:${index}`,
        'scenes',
        video,
        `scdet=threshold=${num(step.by_scene.threshold * 100)}`,
      ) ?? []) as number[];
    }
    // Cuts too close to either end make empty pieces.
    return [...new Set(times)]
      .sort((a, b) => a - b)
      .filter((time) => time > 0.1 && time < total - 0.1);
  }

  private split(step: StepOf<'split'>, index: number): void {
    const name = this.name(index);
    const total = this.duration(index, 'split');
    const times = this.splitTimes(step, index, total);
    const pieces =
      step.every_seconds !== undefined ? Math.ceil(total / step.every_seconds) : times.length + 1;
    if (pieces > 500) throw invalid(index, `split would make ${pieces} pieces; the limit is 500`);
    const container =
      step.container ??
      (step.mode === 'copy' ? containerForFormat(this.input.probe.format) : 'mp4');
    const info = CONTAINER_INFO[container];
    let maps: string[];
    let args: string[];
    let hasVideo: boolean;
    if (step.mode === 'copy') {
      maps = [];
      args = [];
      for (const [kind, stream, label] of [
        ['video', this.inputVideo, '0:V:0'],
        ['audio', this.inputAudio, '0:a:0'],
      ] as const) {
        if (!stream) continue;
        this.requireUntouched(index, kind);
        if (!copyAllowed(container, kind, stream.codec))
          throw invalid(
            index,
            `${container} cannot hold the input's ${stream.codec ?? 'unknown'} ${kind}; use mode "accurate" or another container`,
          );
        maps.push(label);
      }
      args.push('-c', 'copy');
      hasVideo = this.inputVideo !== undefined;
      this.cost += this.minutes * 0.01;
    } else {
      const streams = this.encodeStreams({ ...step, container }, index, name);
      ({ maps, args, hasVideo } = streams);
      args = [
        ...args,
        '-force_key_frames',
        step.every_seconds !== undefined
          ? `expr:gte(t,n_forced*${num(step.every_seconds)})`
          : times.map(num).join(','),
      ];
    }
    args.push(
      ...this.threadArgs(),
      '-map_chapters',
      '-1',
      '-f',
      'segment',
      '-segment_format',
      info.muxer,
      ...(step.every_seconds !== undefined
        ? ['-segment_time', num(step.every_seconds)]
        : ['-segment_times', times.map(num).join(',')]),
      '-reset_timestamps',
      '1',
      '-segment_start_number',
      '1',
      ...(['mp4', 'mov'].includes(container)
        ? ['-segment_format_options', 'movflags=+faststart']
        : []),
    );
    const target = this.outputTarget(name, info.ext, true);
    this.outputs.push({ maps, args, target, durationS: this.state.duration });
    this.files.push({
      name,
      op: 'split',
      role: hasVideo ? 'media' : 'audio',
      pattern: path.basename(target),
      multiple: true,
      mime: info.mime,
    });
  }

  private imageArgs(format: 'jpg' | 'png' | 'webp', quality: number): string[] {
    if (format === 'jpg')
      return [...IMAGE.jpg.codec, '-q:v', String(Math.round(2 + ((100 - quality) * 29) / 99))];
    if (format === 'webp') return [...IMAGE.webp.codec, '-quality', String(quality)];
    return [...IMAGE.png.codec];
  }

  private thumbnail(step: StepOf<'thumbnail'>, index: number): void {
    const name = this.name(index);
    const video = this.video(index, 'thumbnail');
    const total = this.state.duration;
    const filters: string[] = [];
    if (step.count === 1 && step.at !== 'smart') {
      const at =
        typeof step.at === 'number'
          ? step.at
          : (Number(step.at.slice(0, -1)) / 100) * this.duration(index, 'a percentage');
      if (total !== null && at >= total)
        throw invalid(index, 'thumbnail time is after the end of the media');
      filters.push(`trim=start=${num(at)}`, 'setpts=PTS-STARTPTS');
    } else if (step.count === 1) {
      // Most representative of 24 frames spread over the whole media.
      const rate = total ? Math.min(this.state.fps ?? 30, 24 / total) : 1;
      filters.push(`fps=fps=${num(rate)}`, 'thumbnail=n=24');
    } else {
      const length = this.duration(index, 'several thumbnails');
      const perPick = step.at === 'smart' ? 10 : 1;
      filters.push(
        `fps=fps=${num((step.count * perPick) / length)}`,
        ...(perPick > 1 ? [`thumbnail=n=${perPick}`] : []),
      );
    }
    if (step.width !== undefined || step.height !== undefined) {
      filters.push(
        step.width !== undefined && step.height !== undefined
          ? `scale=${step.width}:${step.height}:force_original_aspect_ratio=decrease`
          : `scale=${step.width ?? -2}:${step.height ?? -2}`,
      );
    }
    const multiple = step.count > 1;
    const target = this.outputTarget(name, step.format, multiple);
    this.outputs.push({
      maps: [this.map(this.graph.chain(video, filters))],
      args: [
        ...this.imageArgs(step.format, step.quality),
        '-frames:v',
        String(step.count),
        ...(multiple ? ['-start_number', '1'] : ['-update', '1']),
        '-f',
        'image2',
      ],
      target,
      durationS: total,
    });
    this.files.push({
      name,
      op: 'thumbnail',
      role: 'thumbnail',
      pattern: path.basename(target),
      multiple,
      mime: IMAGE[step.format].mime,
    });
    this.cost += 0.05 + this.minutes * 0.02;
  }

  private contactSheet(step: StepOf<'contact_sheet'>, index: number): void {
    const name = this.name(index);
    const video = this.video(index, 'contact_sheet');
    const total = this.duration(index, 'contact_sheet');
    const rows =
      step.rows ??
      (step.interval_s !== undefined
        ? Math.min(20, Math.max(1, Math.ceil(total / step.interval_s / step.columns)))
        : step.columns);
    const interval = step.interval_s ?? total / (step.columns * rows);
    const stamp = step.timestamps
      ? [
          drawtext([
            `fontfile=${fontFile(this, 'DejaVu Sans', index)}`,
            // Server-composed: the frame time, not client text.
            `text='%{pts\\:hms}'`,
            `fontsize=${Math.max(10, Math.round(step.tile_width / 14))}`,
            'fontcolor=white',
            'box=1',
            'boxcolor=black@0.6',
            'boxborderw=3',
            'x=w-text_w-4',
            'y=h-text_h-4',
          ]),
        ]
      : [];
    const filters = [
      `fps=fps=1/${num(interval)}`,
      `scale=${step.tile_width}:-2`,
      ...stamp,
      `tile=${step.columns}x${rows}:padding=${step.padding}:margin=${step.padding}:color=${step.background}`,
    ];
    const target = this.outputTarget(name, step.format);
    this.outputs.push({
      maps: [this.map(this.graph.chain(video, filters))],
      args: [
        ...this.imageArgs(step.format, step.quality),
        '-frames:v',
        '1',
        '-update',
        '1',
        '-f',
        'image2',
      ],
      target,
      durationS: total,
    });
    this.files.push({
      name,
      op: 'contact_sheet',
      role: 'image',
      pattern: path.basename(target),
      multiple: false,
      mime: IMAGE[step.format].mime,
    });
    this.cost += 0.1;
  }

  private gif(step: StepOf<'gif'>, index: number): void {
    const name = this.name(index);
    const video = this.video(index, 'gif');
    const total = this.state.duration;
    const max = this.options.limits.GIF_MAX_SECONDS;
    if (total !== null && step.start >= total)
      throw invalid(index, 'gif starts after the end of the media');
    const end = step.end ?? Math.min(total ?? Infinity, step.start + max);
    const frames = this.graph.chain(video, [
      `trim=start=${num(step.start)}:end=${num(end)}`,
      'setpts=PTS-STARTPTS',
      `fps=${step.fps}`,
      `scale=w='min(${step.width},iw)':h=-1:flags=lanczos`,
    ]);
    const perFrame = step.palette === 'per_frame';
    const palette = this.graph.chain(frames, [
      `palettegen=max_colors=${step.max_colors}:stats_mode=${perFrame ? 'single' : 'full'}`,
    ]);
    const out = this.graph.newPad('v');
    const use = [
      `dither=${step.dither}`,
      ...(step.dither === 'bayer' ? [`bayer_scale=${step.bayer_scale}`] : []),
      `diff_mode=${step.diff_mode ? 'rectangle' : 'none'}`,
      ...(perFrame ? ['new=1'] : []),
    ].join(':');
    this.graph.segment(
      `[${this.graph.read(frames)}][${this.graph.read(palette)}]paletteuse=${use}[${out.label}]`,
    );
    const target = this.outputTarget(name, 'gif');
    this.outputs.push({
      maps: [this.map(out)],
      args: ['-loop', step.loop ? '0' : '-1', '-f', 'gif'],
      target,
      durationS: total,
    });
    this.files.push({
      name,
      op: 'gif',
      role: 'image',
      pattern: path.basename(target),
      multiple: false,
      mime: 'image/gif',
    });
    this.cost += ((end - step.start) / 60) * 2;
  }

  /** Per-stream maps for remux and fix: copy what the container takes, convert or refuse the rest. */
  private streamCopy(container: Container, index: number, convert: boolean, skipAudio = false) {
    if (this.state.filtered || this.state.accurateTrim) {
      throw invalid(index, 'remux and fix work on the untouched input; put them before any filter');
    }
    const maps: string[] = [];
    const args: string[] = [];
    const problems: string[] = [];
    const counts = { v: 0, a: 0, s: 0 };
    let hasVideo = false;
    this.input.probe.streams.forEach((stream, streamIndex) => {
      const kind =
        stream.type === 'video'
          ? 'video'
          : stream.type === 'audio'
            ? 'audio'
            : stream.type === 'subtitle'
              ? 'subtitle'
              : undefined;
      if (
        !kind ||
        (kind === 'audio' && skipAudio) ||
        (kind === 'subtitle' && this.state.stripSubtitles)
      )
        return;
      const letter = kind === 'video' ? 'v' : kind === 'audio' ? 'a' : 's';
      if (stream.attached_pic) {
        if (
          !['mp4', 'mov', 'mkv'].includes(container) ||
          !['mjpeg', 'png'].includes(stream.codec ?? '')
        )
          return;
        maps.push(`0:${streamIndex}`);
        args.push(`-c:v:${counts.v}`, 'copy', `-disposition:v:${counts.v}`, 'attached_pic');
        counts.v++;
        return;
      }
      const n = counts[letter];
      if (copyAllowed(container, kind, stream.codec)) {
        maps.push(`0:${streamIndex}`);
        args.push(`-c:${letter}:${n}`, 'copy');
      } else if (!convert) {
        problems.push(`${kind} stream ${streamIndex} (${stream.codec ?? 'unknown'})`);
        return;
      } else if (kind === 'video' && ENCODE_CODECS[container].video[0]) {
        const codec = ENCODE_CODECS[container].video[0];
        maps.push(`0:${streamIndex}`);
        args.push(
          ...videoArgs(codec, undefined, { fps: stream.fps }).map((arg) =>
            arg === '-c:v' ? `-c:v:${n}` : arg === '-pix_fmt' ? `-pix_fmt:v:${n}` : arg,
          ),
        );
        this.cost +=
          this.minutes *
          this.pixelFactor(stream.width, stream.height, stream.fps) *
          VIDEO_COST[codec];
      } else if (kind === 'audio' && ENCODE_CODECS[container].audio[0]) {
        maps.push(`0:${streamIndex}`);
        args.push(
          `-c:a:${n}`,
          ENCODE_CODECS[container].audio[0] === 'opus' ? 'libopus' : 'aac',
          `-b:a:${n}`,
          '192k',
        );
      } else if (
        kind === 'subtitle' &&
        isTextSubtitle(stream.codec) &&
        SUBTITLE_TARGET[container]
      ) {
        maps.push(`0:${streamIndex}`);
        args.push(`-c:s:${n}`, SUBTITLE_TARGET[container] ?? 'srt');
      } else {
        return;
      }
      counts[letter]++;
      if (kind === 'video') hasVideo = true;
    });
    if (problems.length > 0) {
      throw invalid(
        index,
        `${container} cannot hold ${problems.join(', ')} without converting; set fix_incompatible: true`,
      );
    }
    if (container === 'mkv') maps.push('0:t?');
    this.cost += this.minutes * 0.01;
    return { maps, args, hasVideo, counts };
  }

  private remux(step: StepOf<'remux'>, index: number): void {
    const name = this.name(index);
    const streams = this.streamCopy(step.container, index, step.fix_incompatible);
    if (streams.maps.length === 0)
      throw invalid(index, 'no stream of the input fits the container');
    this.pushCopyOutput(name, 'remux', step.container, streams, [], step.faststart);
  }

  private fix(step: StepOf<'fix'>, index: number): void {
    const name = this.name(index);
    const container = step.container ?? containerForFormat(this.input.probe.format);
    if (step.regen_timestamps) this.addInputArgs('-fflags', '+genpts+igndts');
    if (step.ignore_errors) this.addInputArgs('-err_detect', 'ignore_err');
    const streams = this.streamCopy(container, index, true, step.fill_gaps);
    const extra: string[] = [];
    if (step.fill_gaps && this.state.audio) {
      // Resampling with async fills gaps and drops overlaps in the first audio stream.
      const filled = this.graph.chain(this.state.audio, ['aresample=async=1:first_pts=0']);
      streams.maps.push(this.map(filled));
      extra.push(
        `-c:a:0`,
        ENCODE_CODECS[container].audio[0] === 'opus' ? 'libopus' : 'aac',
        '-b:a:0',
        '192k',
      );
    }
    if (step.fix_duration)
      extra.push('-avoid_negative_ts', 'make_zero', '-max_interleave_delta', '0');
    this.pushCopyOutput(name, 'fix', container, streams, extra, step.faststart);
  }

  addInputArgs(flag: string, value: string): void {
    if (!this.inputArgs.includes(flag)) this.inputArgs.push(flag, value);
  }

  private pushCopyOutput(
    name: string,
    op: string,
    container: Container,
    streams: { maps: string[]; args: string[]; hasVideo: boolean },
    extra: string[],
    faststart: boolean,
  ): void {
    const info = CONTAINER_INFO[container];
    const target = this.outputTarget(name, info.ext);
    this.outputs.push({
      maps: streams.maps,
      args: [
        ...streams.args,
        ...extra,
        ...(faststart && ['mp4', 'mov'].includes(container) ? ['-movflags', '+faststart'] : []),
        ...this.threadArgs(),
        '-fs',
        String(this.options.maxFileBytes),
        '-f',
        info.muxer,
      ],
      target,
      durationS: this.state.duration,
    });
    this.files.push({
      name,
      op,
      role: streams.hasVideo ? 'media' : 'audio',
      pattern: path.basename(target),
      multiple: false,
      mime: info.mime,
    });
  }

  // --- analyses --------------------------------------------------------------------------------

  private probeReport(step: StepOf<'probe'> | StepOf<'keyframes'>, index: number): void {
    const name = this.name(index);
    const common = ['-v', 'error', '-protocol_whitelist', 'file'];
    const args =
      step.op === 'probe'
        ? [
            ...common,
            '-print_format',
            'json',
            '-show_format',
            '-show_streams',
            '-show_chapters',
            '-show_programs',
            '-i',
            this.input.path,
          ]
        : (this.video(index, 'keyframes'),
          [
            ...common,
            '-select_streams',
            'V:0',
            '-show_entries',
            'packet=pts_time,pos,flags',
            '-of',
            'csv=p=0',
            '-i',
            this.input.path,
          ]);
    this.probeStages.push({
      label: step.op,
      tool: 'ffprobe',
      args,
      durationS: null,
      files: [],
      links: [],
      analyses: [],
      report: { name, kind: step.op, max: step.op === 'keyframes' ? step.max : 0 },
    });
    this.reports.push({ name, op: step.op });
    this.cost += 0.05;
  }

  private analysis(
    step: Extract<
      Step,
      { op: 'loudness' | 'volume' | 'silence_detect' | 'black_detect' | 'scene_changes' }
    >,
    index: number,
  ): void {
    const name = this.name(index);
    const filter = (() => {
      switch (step.op) {
        case 'loudness':
          return { pad: this.audio(index, 'loudness'), text: 'loudnorm=print_format=json' };
        case 'volume':
          return { pad: this.audio(index, 'volume'), text: 'volumedetect' };
        case 'silence_detect':
          return {
            pad: this.audio(index, 'silence_detect'),
            text: `silencedetect=n=${num(step.threshold_db)}dB:d=${num(step.min_duration_s)}`,
          };
        case 'black_detect':
          return {
            pad: this.video(index, 'black_detect'),
            text: `blackdetect=d=${num(step.min_duration_s)}:pix_th=${num(step.pixel_threshold)}:pic_th=${num(step.picture_threshold)}`,
          };
        case 'scene_changes':
          return {
            pad: this.video(index, 'scene_changes'),
            text: `scdet=threshold=${num(step.threshold * 100)}`,
          };
      }
    })();
    // The branch ends unread; finish() maps it to the null output.
    this.graph.chain(filter.pad, [filter.text]);
    this.analyses.push({ name, kind: step.op });
    this.reports.push({ name, op: step.op });
    this.filterCost(this.minutes, 0.05, filter.pad.kind === 'v');
  }

  // --- assembly --------------------------------------------------------------------------------

  private globalArgs(): string[] {
    return [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-v',
      'info',
      '-progress',
      'pipe:1',
      '-filter_complex_threads',
      String(this.options.threads),
    ];
  }

  /** Every -i in order: main input (with its options), other recipe inputs, metadata files. */
  private inputSection(mainOptions: string[] = []): string[] {
    return [
      ...this.inputArgs,
      ...mainOptions,
      ...this.mainSource,
      ...this.inputs.slice(1).flatMap((input) => ['-protocol_whitelist', 'file', '-i', input.path]),
      ...this.extraInputs.flat(),
    ];
  }

  private command(
    graphText: string,
    outputs: { maps: string[]; args: string[]; target: string }[],
    nullMaps: string[],
  ): string[] {
    return [
      ...this.globalArgs(),
      ...this.inputSection(),
      ...(graphText ? ['-filter_complex', graphText] : []),
      ...outputs.flatMap((output) => [
        ...output.maps.flatMap((map) => ['-map', map]),
        ...output.args,
        '-y',
        output.target,
      ]),
      ...(nullMaps.length > 0
        ? [...nullMaps.flatMap((map) => ['-map', map]), '-f', 'null', '-']
        : []),
    ];
  }

  private finish(): Plan {
    const { text, dangling } = this.graph.finish();
    const nullMaps = dangling.map((label) => `[${label}]`);
    if (this.outputs.length === 0 && nullMaps.length === 0)
      return this.plan([...this.probeStages, ...this.preStages]);
    const durations = this.outputs.flatMap((output) =>
      output.durationS === null ? [] : [output.durationS],
    );
    const passStages: Stage[] = this.outputs.flatMap((output, i) => {
      if (!output.pass1) return [];
      // Pass 1 runs the same graph; every other graph output is drained into the null muxer.
      const others = this.outputs
        .filter((_, j) => j !== i)
        .flatMap((other) => other.maps.filter((map) => map.startsWith('[')));
      const drained = [
        ...nullMaps,
        ...others,
        ...output.pass1.otherMaps.filter((map) => map.startsWith('[')),
      ];
      const pass1 = {
        maps: [output.pass1.videoMap],
        args: [...output.pass1.args, '-an', ...this.threadArgs(), '-f', 'null'],
        target: '/dev/null',
      };
      return [
        {
          label: `pass 1 ${path.basename(output.target)}`,
          tool: 'ffmpeg',
          args: this.command(text, [pass1], drained),
          durationS: output.durationS,
          files: this.writeFiles,
          links: this.links,
          dirs: this.dirs,
          analyses: [],
        },
      ];
    });
    const main: Stage = {
      label: 'main',
      tool: 'ffmpeg',
      args: this.command(text, this.outputs, nullMaps),
      durationS: durations.length > 0 ? Math.max(...durations) : this.state.duration,
      files: this.writeFiles,
      links: this.links,
      dirs: this.dirs,
      analyses: this.analyses,
      fileReports: this.fileReports,
    };
    return this.plan([
      ...this.probeStages,
      ...this.preStages,
      ...passStages,
      main,
      ...this.postStages,
    ]);
  }

  private plan(stages: Stage[]): Plan {
    return {
      stages,
      files: this.files,
      reports: this.reports,
      cost: Math.round(this.cost * 100) / 100,
      inputSeconds: this.inputs.reduce((sum, input) => sum + (input.probe.duration_s ?? 0), 0),
    };
  }
}
