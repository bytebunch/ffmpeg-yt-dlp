import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { ZipFile } from 'yazl';

import { AppError } from '../common/errors';
import {
  analysisReport,
  bitrateReport,
  fileReport,
  keyframesReport,
  measurement,
  probeReport,
} from './analysis';
import {
  type ComposeInput,
  type ComposeOptions,
  compose,
  type Plan,
  type PlannedFile,
} from './compose';
import { runStage, type StageProgress } from './run-stage';
import type { Recipe } from './validate';

const MAX_MEASUREMENTS = 5;

export interface RecipeRunOptions extends Omit<ComposeOptions, 'measurements'> {
  ffmpegBin: string;
  ffprobeBin: string;
  maxCost: number;
  timeoutBaseMinutes: number;
  timeoutFactor: number;
  signal?: AbortSignal | undefined;
  /** Overall progress 0–100 and the running stage ("stage i/n"). */
  onProgress?: ((percent: number, stage: string, speed: number | null) => void) | undefined;
  /** Called before the stages run, e.g. to check quotas against the plan. */
  onPlan?: ((plan: Plan) => Promise<void>) | undefined;
}

export interface ProducedOutput extends PlannedFile {
  /** Absolute paths, in sequence order for numbered outputs. */
  paths: string[];
}

export interface RecipeRunResult {
  plan: Plan;
  files: ProducedOutput[];
  reports: { name: string; op: string; data: unknown }[];
  warnings: string[];
}

const totalSeconds = (inputs: readonly ComposeInput[]) =>
  inputs.reduce((sum, input) => sum + (input.probe.duration_s ?? 0), 0);

/** SPEC §9c: base + factor × max(input minutes, estimated cost). */
export function recipeTimeoutMs(plan: Plan, baseMinutes: number, factor: number): number {
  return (baseMinutes + factor * Math.max(plan.inputSeconds / 60, plan.cost)) * 60_000;
}

/** Composes a recipe for one input, runs measurements and stages, and collects what it made. */
export async function runRecipe(
  recipe: Recipe,
  inputs: readonly ComposeInput[],
  options: RecipeRunOptions,
): Promise<RecipeRunResult> {
  await mkdir(path.join(options.workDir, 'out'), { recursive: true });
  const measurements: Record<string, unknown> = {};
  const stageOptions = {
    ffmpegBin: options.ffmpegBin,
    ffprobeBin: options.ffprobeBin,
    workDir: options.workDir,
    signal: options.signal,
    redact: inputs.flatMap((input) => [input.path, path.dirname(input.path)]),
  };
  let plan: Plan | undefined;
  for (let round = 0; round <= MAX_MEASUREMENTS && !plan; round++) {
    const composition = compose(recipe, inputs, { ...options, measurements });
    if (composition.kind === 'plan') {
      plan = composition.plan;
      break;
    }
    const { stage } = composition;
    options.onProgress?.(0, stage.label, null);
    const outcome = await runStage(stage, {
      ...stageOptions,
      timeoutMs: Math.floor(options.timeoutBaseMinutes * 60_000 + totalSeconds(inputs) * 1000),
    });
    if (stage.measure)
      measurements[stage.measure.key] = measurement(
        stage.measure.kind,
        outcome.log,
        stage.durationS,
      );
  }
  if (!plan) throw new Error('The recipe needed more measurements than allowed');
  if (plan.cost > options.maxCost) {
    throw new AppError(
      'RECIPE_TOO_EXPENSIVE',
      `The recipe is estimated at ${Math.ceil(plan.cost)} work units; the limit is ${options.maxCost}`,
      { cost: plan.cost, max_cost: options.maxCost },
      {},
      false,
    );
  }
  await options.onPlan?.(plan);

  const deadline =
    Date.now() + recipeTimeoutMs(plan, options.timeoutBaseMinutes, options.timeoutFactor);
  const reports: RecipeRunResult['reports'] = [];
  const total = plan.stages.length;
  for (const [i, stage] of plan.stages.entries()) {
    const label = total > 1 ? `stage ${i + 1}/${total}` : 'processing';
    const onProgress = ({ seconds, speed }: StageProgress) => {
      const within = stage.durationS ? Math.min(1, seconds / stage.durationS) : 0;
      options.onProgress?.(Math.round(((i + within) / total) * 1000) / 10, label, speed);
    };
    options.onProgress?.(Math.round((i / total) * 1000) / 10, label, null);
    const outcome = await runStage(stage, {
      ...stageOptions,
      timeoutMs: Math.floor(Math.max(1000, deadline - Date.now())),
      onProgress,
    });
    for (const analysis of stage.analyses) {
      reports.push({
        name: analysis.name,
        op: analysis.kind,
        data: analysisReport(analysis.kind, outcome.log, stage.durationS),
      });
    }
    if (stage.report) {
      const { kind, max, meta } = stage.report;
      const data =
        kind === 'probe'
          ? probeReport(outcome.stdout.join('\n'))
          : kind === 'bitrate_timeline'
            ? bitrateReport(outcome.stdout, Number(meta?.window_s ?? 1))
            : keyframesReport(outcome.stdout, max);
      reports.push({ name: stage.report.name, op: kind, data });
    }
    for (const report of stage.fileReports ?? []) {
      const contents = await Promise.all(
        report.files.map((file) => readFile(file, 'utf8').catch(() => '')),
      );
      reports.push({
        name: report.name,
        op: report.kind,
        data: fileReport(report.kind, contents, report.meta),
      });
    }
  }
  const { files, warnings } = await collectFiles(plan, options);
  return { plan, files, reports, warnings };
}

/** Sum of file sizes under a directory, and the files themselves. */
async function walk(dir: string): Promise<{ files: string[]; bytes: number }> {
  const found: string[] = [];
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await walk(full);
      found.push(...inner.files);
      bytes += inner.bytes;
    } else if (entry.isFile()) {
      found.push(full);
      bytes += (await stat(full)).size;
    }
  }
  return { files: found, bytes };
}

/** A package folder (HLS, DASH, storyboard), or a folder of frames delivered as one ZIP. */
async function collectDirectory(
  dir: string,
  file: PlannedFile,
  options: RecipeRunOptions,
): Promise<Pick<ProducedOutput, 'paths' | 'directory'>> {
  const contents = await walk(dir).catch(() => ({ files: [], bytes: 0 }));
  const media = contents.files.filter((entry) => !entry.endsWith('.vtt'));
  if (media.length === 0) {
    throw new AppError(
      'RECIPE_INVALID',
      `"${file.name}" produced no output (is its time range inside the media?)`,
      undefined,
      {},
      false,
    );
  }
  if (contents.bytes >= options.maxFileBytes) {
    throw new AppError(
      'FILE_TOO_LARGE',
      `"${file.name}" is larger than the ${Math.round(options.maxFileBytes / 1024 / 1024)} MB output limit`,
      undefined,
      {},
      false,
    );
  }
  if (!file.zip) return { paths: [dir], directory: true };
  const zipPath = `${dir}.zip`;
  const zip = new ZipFile();
  for (const entry of contents.files.sort())
    zip.addFile(entry, path.relative(dir, entry), { compress: false });
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(zipPath));
  return { paths: [zipPath], directory: false };
}

async function collectFiles(
  plan: Plan,
  options: RecipeRunOptions,
): Promise<{ files: ProducedOutput[]; warnings: string[] }> {
  const outDir = path.join(options.workDir, 'out');
  const present = await readdir(outDir);
  const files: ProducedOutput[] = [];
  const warnings: string[] = [];
  for (const file of plan.files) {
    if (file.directory) {
      files.push({
        ...file,
        ...(await collectDirectory(path.join(outDir, file.pattern), file, options)),
      });
      continue;
    }
    const [prefix = '', suffix = ''] = file.pattern.split('%03d');
    const names = file.multiple
      ? present
          .filter(
            (name) =>
              name.startsWith(prefix) &&
              name.endsWith(suffix) &&
              /^\d{3,}$/.test(name.slice(prefix.length, name.length - suffix.length)),
          )
          .sort()
      : present.filter((name) => name === file.pattern);
    const paths: string[] = [];
    for (const name of names) {
      const full = path.join(outDir, name);
      const { size } = await stat(full);
      // ffmpeg's -fs stops writing at the limit and still exits 0.
      if (size >= options.maxFileBytes * 0.999) {
        throw new AppError(
          'FILE_TOO_LARGE',
          `"${file.name}" reached the ${Math.round(options.maxFileBytes / 1024 / 1024)} MB output limit`,
          undefined,
          {},
          false,
        );
      }
      if (size > 0) paths.push(full);
    }
    if (paths.length === 0) {
      throw new AppError(
        'RECIPE_INVALID',
        `"${file.name}" produced no output (is its time range inside the media?)`,
        undefined,
        {},
        false,
      );
    }
    if (file.targetBytes !== undefined) {
      const size = (await stat(paths[0] ?? '')).size;
      if (size > file.targetBytes * 1.05)
        warnings.push(
          `"${file.name}" is ${Math.round(size / 1024 / 1024)} MB, above its ${Math.round(file.targetBytes / 1024 / 1024)} MB target`,
        );
    }
    files.push({ ...file, paths });
  }
  return { files, warnings };
}
