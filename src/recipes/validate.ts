import type { z } from 'zod';

import { AppError } from '../common/errors';
import { CONTAINER_INFO, CRF, ENCODE_CODECS, PROFILES } from './codecs';
import {
  type EncodeStep,
  isAnalysis,
  isTerminal,
  LATER_OPS,
  recipeSchema,
  SCALE_HEIGHTS,
  type Step,
  stepSchema,
  type StepOf,
} from './schema';

export interface RecipeLimits {
  RECIPE_MAX_STEPS: number;
  RECIPE_MAX_OUTPUTS: number;
  RECIPE_MAX_TEXT_LAYERS?: number;
  MAX_FILE_SIZE_MB: number;
  GIF_MAX_SECONDS: number;
}

/** A parsed recipe: every terminal and analysis carries its final, unique name. */
export interface Recipe {
  steps: Step[];
  names: Map<number, string>;
}

const LATER = new Set<string>(LATER_OPS);

function invalid(index: number, message: string): AppError {
  return new AppError('RECIPE_INVALID', `steps.${index}: ${message}`, { step: index });
}

function zodIssues(index: number, error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: ['steps', index, ...issue.path].join('.'),
    message: issue.message,
  }));
}

/**
 * Validates a recipe without looking at its inputs (SPEC §8a): shapes, caps, names and every
 * rule that only depends on the parameters. Input-dependent rules live in the composer.
 */
export function parseRecipe(raw: unknown, limits: RecipeLimits): Recipe {
  if (typeof raw === 'string') {
    // Names are expanded when the job is created (RecipesService); one reaching here is unknown.
    throw new AppError('RECIPE_INVALID', `There is no recipe "${raw}"`);
  }

  const shape = recipeSchema.safeParse(raw);
  if (!shape.success) {
    throw new AppError('RECIPE_INVALID', 'The recipe must be { "steps": [ ... ] }', {
      issues: shape.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  if (shape.data.steps.length > limits.RECIPE_MAX_STEPS) {
    throw new AppError('RECIPE_INVALID', `Recipes are limited to ${limits.RECIPE_MAX_STEPS} steps`);
  }
  const steps = shape.data.steps.map((value, index) => {
    const op =
      typeof value === 'object' && value !== null ? (value as { op?: unknown }).op : undefined;
    if (op === 'crossfade') {
      throw new AppError(
        'RECIPE_INVALID',
        `steps.${index}: crossfades belong to concat: set its transition and audio_crossfade_s`,
        { step: index },
      );
    }
    if (typeof op === 'string' && LATER.has(op)) {
      throw new AppError('FEATURE_DISABLED', `steps.${index}: "${op}" arrives with milestone 6`, {
        step: index,
      });
    }
    const parsed = stepSchema.safeParse(value);
    if (!parsed.success) {
      throw new AppError('RECIPE_INVALID', `steps.${index} is not valid`, {
        issues: zodIssues(index, parsed.error),
      });
    }
    checkStep(parsed.data, index, limits);
    return parsed.data;
  });
  const textLayers = steps.filter((step) => step.op === 'text').length;
  if (limits.RECIPE_MAX_TEXT_LAYERS !== undefined && textLayers > limits.RECIPE_MAX_TEXT_LAYERS) {
    throw new AppError(
      'RECIPE_INVALID',
      `Recipes are limited to ${limits.RECIPE_MAX_TEXT_LAYERS} text layers`,
    );
  }
  return { steps, names: assignNames(steps, limits) };
}

function assignNames(steps: Step[], limits: RecipeLimits): Map<number, string> {
  const names = new Map<number, string>();
  const used = new Set<string>();
  const analyses = new Set<string>();
  steps.forEach((step, index) => {
    if (!isTerminal(step) && !isAnalysis(step)) return;
    if (isAnalysis(step)) {
      // Reports are matched to their filter by type, so each analysis appears once.
      if (analyses.has(step.op)) throw invalid(index, `only one "${step.op}" per recipe`);
      analyses.add(step.op);
    }
    if (step.name !== undefined) {
      if (used.has(step.name)) throw invalid(index, `the name "${step.name}" is used twice`);
      used.add(step.name);
      names.set(index, step.name);
    }
  });
  steps.forEach((step, index) => {
    if ((!isTerminal(step) && !isAnalysis(step)) || names.has(index)) return;
    let candidate = step.op.replace(/_/g, '-');
    for (let n = 2; used.has(candidate); n++) candidate = `${step.op.replace(/_/g, '-')}-${n}`;
    used.add(candidate);
    names.set(index, candidate);
  });
  if (names.size === 0) {
    throw new AppError(
      'RECIPE_INVALID',
      'A recipe needs at least one output (encode, thumbnail, …) or analysis',
    );
  }
  if (names.size > limits.RECIPE_MAX_OUTPUTS) {
    throw new AppError(
      'RECIPE_INVALID',
      `Recipes are limited to ${limits.RECIPE_MAX_OUTPUTS} outputs and analyses`,
    );
  }
  return names;
}

function exactlyOne(index: number, step: Record<string, unknown>, fields: string[]): void {
  const given = fields.filter((field) => step[field] !== undefined && step[field] !== false);
  if (given.length !== 1) throw invalid(index, `set exactly one of ${fields.join(', ')}`);
}

function checkStep(step: Step, index: number, limits: RecipeLimits): void {
  switch (step.op) {
    case 'trim':
      if (step.start === undefined && step.end === undefined && step.duration === undefined) {
        throw invalid(index, 'trim needs start, end or duration');
      }
      if (step.end !== undefined && step.duration !== undefined)
        throw invalid(index, 'set end or duration, not both');
      if (step.end !== undefined && step.end <= (step.start ?? 0))
        throw invalid(index, 'end must be after start');
      return;
    case 'cut_out':
      step.ranges.forEach((range, i) => {
        if (range.end <= range.start) throw invalid(index, `ranges.${i}: end must be after start`);
      });
      return;
    case 'loop':
      exactlyOne(index, step, ['count', 'to_duration_s']);
      return;
    case 'scale':
      checkScale(step, index);
      return;
    case 'crop':
      checkCrop(step, index);
      return;
    case 'rotate':
      if (step.degrees !== undefined && step.angle_deg !== undefined) {
        throw invalid(index, 'set degrees or angle_deg, not both');
      }
      if (
        step.degrees === undefined &&
        step.angle_deg === undefined &&
        !step.flip_h &&
        !step.flip_v
      ) {
        throw invalid(index, 'rotate needs degrees, angle_deg, flip_h or flip_v');
      }
      if (step.metadata_only && (step.degrees === undefined || step.flip_h || step.flip_v)) {
        throw invalid(index, 'metadata_only works with degrees only');
      }
      return;
    case 'pad':
      if ((step.aspect === undefined) === (step.width === undefined || step.height === undefined)) {
        throw invalid(index, 'set aspect, or width and height');
      }
      return;
    case 'aspect':
      if (!step.sar_1 && step.dar === undefined) throw invalid(index, 'set sar_1 or dar');
      return;
    case 'encode':
      checkEncode(step, index, limits);
      return;
    case 'split':
      checkSplit(step, index, limits);
      return;
    case 'contact_sheet':
      if (step.rows !== undefined && step.interval_s !== undefined)
        throw invalid(index, 'set rows or interval_s, not both');
      return;
    case 'gif':
      if (step.end !== undefined && step.end <= step.start)
        throw invalid(index, 'end must be after start');
      if (step.end !== undefined && step.end - step.start > limits.GIF_MAX_SECONDS) {
        throw invalid(index, `GIFs are limited to ${limits.GIF_MAX_SECONDS} seconds`);
      }
      return;
    default:
      return;
  }
}

function checkScale(step: StepOf<'scale'>, index: number): void {
  if (step.width === undefined && step.height === undefined)
    throw invalid(index, 'scale needs height or width');
  if (
    step.width === undefined &&
    step.height !== undefined &&
    !(SCALE_HEIGHTS as readonly number[]).includes(step.height)
  ) {
    throw invalid(
      index,
      `height alone must be one of ${SCALE_HEIGHTS.join(', ')}; or give width and height`,
    );
  }
  if ((step.width ?? 0) % 2 !== 0 || (step.height ?? 0) % 2 !== 0)
    throw invalid(index, 'width and height must be even');
}

function checkCrop(step: StepOf<'crop'>, index: number): void {
  const box = [step.x, step.y, step.w, step.h];
  const modes = [
    box.some((value) => value !== undefined),
    step.aspect !== undefined,
    step.auto,
  ].filter(Boolean);
  if (modes.length !== 1) throw invalid(index, 'crop takes x/y/w/h, aspect, or auto');
  if (box.some((value) => value !== undefined) && box.some((value) => value === undefined)) {
    throw invalid(index, 'crop needs all of x, y, w and h');
  }
  if ((step.w ?? 0) % 2 !== 0 || (step.h ?? 0) % 2 !== 0)
    throw invalid(index, 'w and h must be even');
}

function checkEncode(
  step: Pick<EncodeStep, 'container' | 'video' | 'audio' | 'cover'>,
  index: number,
  limits: RecipeLimits,
): void {
  const { container, video, audio } = step;
  const codecs = ENCODE_CODECS[container];
  const videoCodec = video?.codec;
  if (videoCodec !== undefined && videoCodec !== 'none' && videoCodec !== 'copy') {
    if (!codecs.video.includes(videoCodec)) {
      throw invalid(
        index,
        `${container} cannot hold ${videoCodec} video (allowed: ${codecs.video.join(', ') || 'none'})`,
      );
    }
  }
  if (!CONTAINER_INFO[container].video && videoCodec !== undefined && videoCodec !== 'none') {
    throw invalid(
      index,
      `${container} is an audio container; set video.codec to "none" or leave it out`,
    );
  }
  if (
    audio?.codec !== undefined &&
    audio.codec !== 'none' &&
    audio.codec !== 'copy' &&
    !codecs.audio.includes(audio.codec)
  ) {
    throw invalid(
      index,
      `${container} cannot hold ${audio.codec} audio (allowed: ${codecs.audio.join(', ')})`,
    );
  }
  if (!video) {
    checkAudio(audio, index);
    return;
  }
  const rateControls = [video.crf, video.bitrate_kbps, video.target_size_mb].filter(
    (value) => value !== undefined,
  );
  if (rateControls.length > 1)
    throw invalid(index, 'set one of video.crf, video.bitrate_kbps, video.target_size_mb');
  const effective = videoCodec ?? codecs.video[0];
  if (effective === undefined || effective === 'copy' || effective === 'none') {
    // Parsed settings hold only the fields that were sent, plus the flag defaults named here.
    const tuned = Object.keys(video)
      .filter(
        (key) => !['codec', 'two_pass', 'scene_cut', 'fragmented', 'hw', 'faststart'].includes(key),
      )
      .map((key) => [key]);
    if (tuned.length > 0)
      throw invalid(
        index,
        `video.${tuned[0]?.[0] ?? ''} does not apply to codec "${effective ?? 'none'}"`,
      );
  } else {
    const crf = CRF[effective];
    if (video.crf !== undefined && (!crf || video.crf > crf.max)) {
      throw invalid(
        index,
        crf ? `video.crf for ${effective} is 0–${crf.max}` : `${effective} has no crf`,
      );
    }
    if (video.profile !== undefined && !(PROFILES[effective] ?? []).includes(video.profile)) {
      throw invalid(index, `video.profile "${video.profile}" does not apply to ${effective}`);
    }
    if (video.target_size_mb !== undefined && video.target_size_mb > limits.MAX_FILE_SIZE_MB) {
      throw invalid(index, `video.target_size_mb is limited to ${limits.MAX_FILE_SIZE_MB}`);
    }
    if (
      (video.two_pass || video.target_size_mb !== undefined) &&
      !['h264', 'hevc', 'vp9', 'av1_aom'].includes(effective)
    ) {
      throw invalid(
        index,
        `two-pass encoding is available for h264, hevc, vp9 and av1_aom, not ${effective}`,
      );
    }
    if (video.two_pass && video.bitrate_kbps === undefined)
      throw invalid(index, 'video.two_pass needs video.bitrate_kbps');
    checkPreset(video.preset, effective, index);
  }
  checkAudio(audio, index);
}

function checkPreset(preset: string | number | undefined, codec: string, index: number): void {
  if (preset === undefined) return;
  const x26x =
    ['h264', 'hevc'].includes(codec) &&
    typeof preset === 'string' &&
    !['good', 'best', 'realtime'].includes(preset);
  const svt = codec === 'av1' && typeof preset === 'number';
  const vpx =
    ['vp9', 'av1_aom'].includes(codec) && ['good', 'best', 'realtime'].includes(String(preset));
  if (!x26x && !svt && !vpx)
    throw invalid(index, `video.preset "${String(preset)}" does not apply to ${codec}`);
}

function checkAudio(audio: EncodeStep['audio'], index: number): void {
  if (audio?.vbr === undefined) return;
  if (audio.codec === 'mp3' && audio.vbr > 9) throw invalid(index, 'audio.vbr for mp3 is 0–9');
  if (audio.codec !== 'mp3' && audio.codec !== 'vorbis')
    throw invalid(index, 'audio.vbr applies to mp3 and vorbis');
}

function checkSplit(step: StepOf<'split'>, index: number, limits: RecipeLimits): void {
  exactlyOne(index, step, ['every_seconds', 'at', 'by_chapters', 'by_silence', 'by_scene']);
  if (step.at) {
    const sorted = [...step.at].sort((a, b) => a - b);
    if (sorted.some((value, i) => value <= 0 || (i > 0 && value === sorted[i - 1]))) {
      throw invalid(index, 'at must hold distinct times after 0');
    }
  }
  if (
    step.mode === 'copy' &&
    ((step.video?.codec ?? 'copy') !== 'copy' || (step.audio?.codec ?? 'copy') !== 'copy')
  ) {
    throw invalid(index, 'mode "copy" keeps the codecs; use mode "accurate" to re-encode');
  }
  if (step.mode === 'accurate' && step.container !== undefined)
    checkEncode({ ...step, container: step.container }, index, limits);
}
