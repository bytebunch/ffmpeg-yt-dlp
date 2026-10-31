import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';

import { AppError } from '../common/errors';
import { forEachLine } from '../common/lines';
import { classifyYtDlpError } from './errors';

export interface RunnerSettings {
  bin: string;
  denoBin: string;
  cacheDir: string;
  /** SITE_ALLOWLIST; empty means every built-in extractor except generic (SPEC §12). */
  extractors: readonly string[];
  /** 'none' disables impersonation. */
  impersonate: string;
  sleepRequestsSeconds: number;
  /** YTDLP_POT_PROVIDER_URL: the PO-token provider service for YouTube (SPEC §7f). */
  potProviderUrl?: string | undefined;
}

export interface RunOptions {
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Keep files in this directory instead of a throwaway one (e.g. downloaded subtitles). */
  workDir?: string;
  /** Overrides the extractor policy for this run (search runs name their search extractor). */
  extractors?: readonly string[];
  /** Overrides YTDLP_IMPERSONATE_DEFAULT for this run. */
  impersonate?: string;
  /**
   * Stops the run as Ctrl-C would (SIGINT): yt-dlp finalises a live recording and exits. The
   * result is returned whatever the exit code, marked `stopped` (SPEC §7d, §9c).
   */
  stopSignal?: AbortSignal;
  /** Receives every stdout line as it arrives (progress). */
  onStdoutLine?: (line: string) => void;
  /** Receives every stderr line as it arrives (job logs). */
  onStderrLine?: (line: string) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** True when `stopSignal` ended the run. */
  stopped?: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;
/** Finalising a stopped recording (yt-dlp tells ffmpeg to finish the file) may take a while. */
const STOP_GRACE_MS = 120_000;

/** Only what yt-dlp needs; secrets in the service's environment never reach the child. */
export function minimalEnv(workDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: workDir,
    TMPDIR: workDir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

export class YtDlpRunner {
  constructor(private readonly settings: RunnerSettings) {}

  /** Flags on every run (SPEC §7g); options that never reach yt-dlp are listed in §7h. */
  commonArgs(
    extractors: readonly string[] = this.settings.extractors,
    impersonate: string = this.settings.impersonate,
  ): string[] {
    const { settings } = this;
    const args = [
      '--ignore-config',
      '--no-colors',
      '--socket-timeout',
      '30',
      '--use-extractors',
      extractors.length > 0 ? extractors.join(',') : 'default,-generic',
      '--js-runtimes',
      `deno:${settings.denoBin}`,
      '--cache-dir',
      settings.cacheDir,
    ];
    if (impersonate !== 'none') args.push('--impersonate', impersonate);
    if (settings.sleepRequestsSeconds > 0) {
      args.push('--sleep-requests', String(settings.sleepRequestsSeconds));
    }
    // Read by the bgutil PO-token plugin; its own extractor key, so it never collides with youtube:.
    if (settings.potProviderUrl !== undefined) {
      args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${settings.potProviderUrl}`);
    }
    return args;
  }

  /**
   * Runs yt-dlp with the common flags, `args`, then `--` and the URL, in a throwaway working
   * directory. Failures become AppErrors with stable codes.
   */
  async run(
    args: readonly string[],
    url: string | undefined,
    options: RunOptions,
  ): Promise<RunResult> {
    const workDir = options.workDir ?? (await mkdtemp(path.join(tmpdir(), 'ytdlp-')));
    try {
      const subprocess = execa(
        this.settings.bin,
        [
          ...this.commonArgs(options.extractors, options.impersonate),
          ...args,
          ...(url === undefined ? [] : ['--', url]),
        ],
        {
          cwd: workDir,
          env: minimalEnv(workDir),
          extendEnv: false,
          stdin: 'ignore',
          timeout: options.timeoutMs,
          killSignal: 'SIGTERM',
          forceKillAfterDelay: KILL_GRACE_MS,
          maxBuffer: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          ...(options.signal ? { cancelSignal: options.signal } : {}),
          reject: false,
        },
      );
      if (options.onStdoutLine) forEachLine(subprocess.stdout, options.onStdoutLine);
      if (options.onStderrLine) forEachLine(subprocess.stderr, options.onStderrLine);
      // Set from the abort listener, so an object rather than a narrowed local.
      const stopState = { stopped: false };
      let forceKill: NodeJS.Timeout | undefined;
      const stop = () => {
        stopState.stopped = true;
        subprocess.kill('SIGINT');
        forceKill = setTimeout(() => subprocess.kill('SIGKILL'), STOP_GRACE_MS);
      };
      if (options.stopSignal?.aborted) stop();
      else options.stopSignal?.addEventListener('abort', stop, { once: true });
      const result = await subprocess.finally(() => {
        clearTimeout(forceKill);
        options.stopSignal?.removeEventListener('abort', stop);
      });
      if (stopState.stopped && result.exitCode !== undefined) {
        return { stdout: result.stdout, stderr: result.stderr, stopped: true };
      }
      if (result.timedOut) {
        throw new AppError(
          'TIMEOUT',
          `yt-dlp did not finish within ${Math.round(options.timeoutMs / 1000)}s`,
        );
      }
      if (result.isCanceled) throw new AppError('TIMEOUT', 'The request was cancelled');
      if (result.isMaxBuffer) {
        throw new AppError('EXTRACTION_FAILED', 'yt-dlp produced more output than allowed');
      }
      if (result.exitCode === undefined) {
        // Never started (missing binary, bad cwd): a server fault, not the caller's.
        throw new Error(`yt-dlp could not be started: ${result.shortMessage}`);
      }
      if (result.exitCode !== 0) throw classifyYtDlpError(result.stderr);
      return { stdout: result.stdout, stderr: result.stderr };
    } finally {
      if (options.workDir === undefined) await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Runs with `-J` (one JSON document on stdout) and parses it. */
  async json(args: readonly string[], url: string, options: RunOptions): Promise<unknown> {
    const { stdout } = await this.run([...args, '-J'], url, options);
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new AppError('EXTRACTION_FAILED', 'yt-dlp returned output that is not JSON');
    }
  }

  async version(): Promise<string> {
    return (await this.run(['--version'], undefined, { timeoutMs: 30_000 })).stdout.trim();
  }
}
