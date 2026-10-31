import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import { AppError } from '../common/errors';
import { forEachLine } from '../common/lines';
import { FilterLogCollector } from './analysis';
import type { Stage } from './compose';

const KILL_GRACE_MS = 10_000;
const NICENESS = 10;
const TAIL_LINES = 40;
const MAX_STDOUT_LINES = 2_000_000;
const ERROR_HINT =
  /error|invalid|fail|not supported|cannot|unable|no such|unknown|too |mismatch|incompatible/i;

export interface StageProgress {
  seconds: number;
  speed: number | null;
}

export interface StageOptions {
  ffmpegBin: string;
  ffprobeBin: string;
  workDir: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: StageProgress) => void) | undefined;
  /** Paths replaced in error messages so clients never see server paths. */
  redact?: readonly string[] | undefined;
}

export interface StageOutcome {
  log: FilterLogCollector;
  stdout: string[];
}

function redactPaths(text: string, paths: readonly string[]): string {
  return paths.reduce((result, value) => (value ? result.split(value).join('…') : result), text);
}

/** The most telling lines of a failed run's log. */
export function failureSummary(tail: readonly string[], paths: readonly string[]): string {
  const hinted = tail.filter((line) => ERROR_HINT.test(line));
  const chosen = (hinted.length > 0 ? hinted : tail)
    .slice(-3)
    .map((line) => line.trim())
    .filter(Boolean);
  return redactPaths(chosen.join(' | '), paths).slice(0, 1000);
}

/** Reads ffmpeg's -progress key=value lines. */
function progressReader(onProgress: (progress: StageProgress) => void): (line: string) => void {
  let seconds = 0;
  let speed: number | null = null;
  return (line) => {
    const [key, value = ''] = line.split('=', 2);
    if (key === 'out_time_us') {
      const micros = Number(value);
      if (Number.isFinite(micros) && micros >= 0) seconds = micros / 1_000_000;
    } else if (key === 'speed') {
      const parsed = Number.parseFloat(value);
      speed = Number.isFinite(parsed) ? parsed : null;
    } else if (key === 'progress') {
      onProgress({ seconds, speed });
    }
  };
}

/** Runs one composed stage with a minimal environment, timeout and cancellation. */
export async function runStage(stage: Stage, options: StageOptions): Promise<StageOutcome> {
  for (const dir of stage.dirs ?? []) await mkdir(dir, { recursive: true });
  for (const file of stage.files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
  }
  for (const link of stage.links) {
    await rm(link.path, { force: true });
    await symlink(link.target, link.path);
  }
  const log = new FilterLogCollector();
  const tail: string[] = [];
  const stdout: string[] = [];
  const bin = stage.tool === 'ffmpeg' ? options.ffmpegBin : options.ffprobeBin;
  // Lower priority than the API and downloads (SPEC §12); nice execs ffmpeg in place, so the
  // timeout and cancel signals still reach it.
  const subprocess = execa('nice', ['-n', String(NICENESS), bin, ...stage.args], {
    cwd: options.workDir,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: options.workDir,
      LANG: 'C.UTF-8',
    },
    extendEnv: false,
    stdin: 'ignore',
    buffer: false,
    timeout: options.timeoutMs,
    killSignal: 'SIGTERM',
    forceKillAfterDelay: KILL_GRACE_MS,
    ...(options.signal ? { cancelSignal: options.signal } : {}),
    reject: false,
  });
  const onProgress = options.onProgress;
  const progress = stage.tool === 'ffmpeg' && onProgress ? progressReader(onProgress) : undefined;
  forEachLine(subprocess.stdout, (line) => {
    if (progress) progress(line);
    else if (stdout.length < MAX_STDOUT_LINES) stdout.push(line);
  });
  forEachLine(subprocess.stderr, (line) => {
    log.push(line);
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  });
  const result = await subprocess;
  const paths = [options.workDir, ...(options.redact ?? [])];
  if (result.timedOut) {
    throw new AppError(
      'TIMEOUT',
      `${stage.label} did not finish within ${Math.round(options.timeoutMs / 60_000)} minutes`,
      undefined,
      {},
      false,
    );
  }
  if (result.isCanceled)
    throw new AppError('TIMEOUT', 'The job was cancelled', undefined, {}, false);
  if (result.exitCode === undefined) {
    // Killed by a signal we did not send (out of memory, OOM killer): worth another try.
    if (result.signal)
      throw new AppError(
        'INTERNAL',
        `${stage.tool} was killed (${result.signal})`,
        undefined,
        {},
        true,
      );
    throw new Error(`${stage.tool} could not be started: ${result.shortMessage}`);
  }
  if (result.exitCode !== 0) {
    throw new AppError(
      'RECIPE_INVALID',
      `${stage.label}: ${failureSummary(tail, paths) || `${stage.tool} exited with ${result.exitCode}`}`,
      undefined,
      {},
      false,
    );
  }
  return { log, stdout };
}
