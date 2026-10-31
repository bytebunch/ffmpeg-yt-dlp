import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import type { Redis } from 'ioredis';
import type { z } from 'zod';

import { youtubeExtractorArgs } from '../access/access-args';
import { type JobAccess, JobAccessResolver } from '../access/job-access';
import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { redactText } from '../common/redact';
import { APP_CONFIG, DATABASE, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { type Job, jobs, outputs } from '../db/schema';
import { URL_RESOLVER } from '../discovery/discovery.service';
import { JobFinisher } from '../drive/job-finisher';
import { asRecord } from '../discovery/mappers';
import { formatSelectionArgs } from '../discovery/presets';
import { PROGRESS_MARKER } from '../downloads/args';
import { classifyFile } from '../downloads/classify';
import { parseProgressLine } from '../downloads/progress';
import { startWatchdog } from '../downloads/watchdog';
import { type LiveProgress, publishStatus, writeProgress } from '../jobs/job-state';
import { recordJobSchema } from '../jobs/schemas';
import { ffprobe } from '../media/ffprobe';
import { YtDlpRunner } from '../ytdlp/runner';
import { guardUrl, type Resolver } from '../ytdlp/url-guard';
import { isTransportNoise, parseFfmpegStats } from './ffmpeg-stats';
import { RECORD_CONTAINERS, remuxArgs, waitArgs } from './remux';

const MB = 1024 * 1024;
const MAX_LOG_LINES = 200;
const PROGRESS_INTERVAL_MS = 2000;
/** Finalising and remuxing get this much beyond the wait and recording caps. */
const SLACK_MS = 15 * 60_000;

const recordOptions = recordJobSchema.omit({ type: true, url: true });
type RecordOptions = z.output<typeof recordOptions>;

type StopReason = 'cancelled' | 'duration' | 'size' | 'wait';

interface Capture {
  files: string[];
  stopReason: StopReason | undefined;
}

/** Whether to wait for a scheduled start, and when it is (null if the site does not say). */
interface Schedule {
  upcoming: boolean;
  start: string | null;
}

/** Everything one recording run needs. */
interface Session {
  job: Job;
  url: string;
  extractor: string | undefined;
  options: RecordOptions;
  access: JobAccess;
  workDir: string;
  schedule: Schedule;
  signal: AbortSignal;
  log: string[];
}

/** yt-dlp's output once it records rather than waits. */
const RECORDING_LINE = /^\[(?:download|hlsnative|dashsegments|ffmpeg)\]/;

/**
 * `record` jobs (SPEC §7d): wait for a scheduled stream if asked, record it as MPEG-TS, stop
 * with SIGINT at the duration cap, the size cap or on cancel (yt-dlp finalises the file), then
 * remux to the container, optionally in segments. Status: waiting → recording → running.
 * A cancelled recording keeps what was recorded.
 */
@Injectable()
export class RecordExecutor {
  private readonly logger = new Logger(RecordExecutor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly runner: YtDlpRunner,
    @Inject(URL_RESOLVER) private readonly resolve: Resolver,
    private readonly access: JobAccessResolver,
    private readonly finisher: JobFinisher,
  ) {}

  async record(job: Job, workDir: string, signal: AbortSignal, log: string[]): Promise<void> {
    const stored = job.options as Record<string, unknown>;
    const options = recordOptions.parse(
      Object.fromEntries(Object.entries(stored).filter(([key]) => !key.startsWith('_'))),
    );
    const access = await this.access.prepare(
      { clientId: job.clientId, userId: job.userId },
      options,
      stored,
      path.join(workDir, '.access'),
    );
    try {
      const url = await guardUrl(job.url ?? '', this.resolve);
      const info = asRecord(
        await this.runner.json(
          [
            '--no-playlist',
            ...formatSelectionArgs(options.preset),
            ...access.args({ url: url.href }),
          ],
          url.href,
          {
            timeoutMs: this.config.PLAYLIST_EXPAND_TIMEOUT_SECONDS * 1000,
            signal,
            ...(options.impersonate && { impersonate: options.impersonate }),
          },
        ),
      );
      const capture = await this.capture({
        job,
        url: url.href,
        extractor: typeof info.extractor_key === 'string' ? info.extractor_key : undefined,
        options,
        access,
        workDir,
        schedule: this.schedule(info, options),
        signal,
        log,
      });
      if (capture.files.length === 0) {
        if (capture.stopReason === 'cancelled') {
          await this.setState(job.id, { status: 'cancelled', stage: null, finishedAt: new Date() });
          return;
        }
        throw new AppError(
          'EXTRACTION_FAILED',
          'The recording produced no media',
          undefined,
          {},
          false,
        );
      }
      await this.setState(job.id, { status: 'running', stage: 'postprocessing' });
      const remuxed = await this.remux(capture.files, workDir, options);
      await this.store(
        job,
        remuxed,
        workDir,
        options,
        capture.stopReason === 'cancelled' ? 'cancelled' : 'completed',
      );
    } finally {
      await access.dispose();
    }
  }

  /** Live now, or upcoming when the caller asked to wait; anything else is refused. */
  private schedule(info: Record<string, unknown>, options: RecordOptions): Schedule {
    const status =
      typeof info.live_status === 'string'
        ? info.live_status
        : info.is_live === true
          ? 'is_live'
          : 'not_live';
    if (status === 'is_live') return { upcoming: false, start: null };
    if (status !== 'is_upcoming') {
      throw new AppError(
        'VALIDATION_FAILED',
        `This stream is not live (${status}); download it with a "download" job`,
        undefined,
        {},
        false,
      );
    }
    const start =
      typeof info.release_timestamp === 'number' ? new Date(info.release_timestamp * 1000) : null;
    const details = { scheduled_start: start?.toISOString() ?? null };
    if (!options.wait) {
      throw new AppError(
        'LIVE_NOT_STARTED',
        'The stream has not started; send "wait" to record it when it does',
        details,
        {},
        false,
      );
    }
    const cap = Date.now() + this.config.LIVE_MAX_WAIT_MINUTES * 60_000;
    if (start && start.getTime() > cap) {
      throw new AppError(
        'LIVE_NOT_STARTED',
        `The stream starts after the ${this.config.LIVE_MAX_WAIT_MINUTES}-minute wait limit`,
        details,
        {},
        false,
      );
    }
    return { upcoming: true, start: details.scheduled_start };
  }

  private async capture(session: Session): Promise<Capture> {
    const { job, options, workDir, schedule, signal, log } = session;
    const tempDir = path.join(workDir, '.tmp');
    await mkdir(tempDir, { recursive: true });
    const limitS = (options.max_duration_minutes ?? this.config.LIVE_MAX_DURATION_MINUTES) * 60;
    const waitCapMs = this.config.LIVE_MAX_WAIT_MINUTES * 60_000;
    const stop = new AbortController();
    let stopReason: StopReason | undefined;
    const stopFor = (reason: StopReason) => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      stop.abort();
    };
    const onCancel = () => {
      stopFor('cancelled');
    };
    signal.addEventListener('abort', onCancel, { once: true });
    if (signal.aborted) onCancel();

    const timers: NodeJS.Timeout[] = [];
    let startedAt: number | undefined;
    const progress = (values: Partial<LiveProgress>): LiveProgress => ({
      stage: startedAt === undefined ? 'waiting' : 'recording',
      scheduled_start: schedule.start,
      recorded_s: startedAt === undefined ? null : Math.round((Date.now() - startedAt) / 1000),
      limit_s: limitS,
      bytes: null,
      speed: null,
      ...values,
    });
    const startRecording = () => {
      if (startedAt !== undefined) return;
      startedAt = Date.now();
      timers.push(
        setTimeout(() => {
          stopFor('duration');
        }, limitS * 1000),
      );
      // From a line callback: the state change must not block or throw into yt-dlp's output.
      this.setState(job.id, { status: 'recording', stage: 'recording' }).catch((error: unknown) => {
        this.logger.warn({ err: error, jobId: job.id }, 'Could not mark the job as recording');
      });
      void this.reportProgress(job.id, progress({}));
    };
    if (schedule.upcoming) {
      await this.setState(job.id, { status: 'waiting', stage: 'waiting' });
      await this.reportProgress(job.id, progress({}));
      timers.push(
        setTimeout(() => {
          if (startedAt === undefined) stopFor('wait');
        }, waitCapMs),
      );
    } else {
      startRecording();
    }
    const stopWatchdog = startWatchdog(workDir, this.config.MAX_FILE_SIZE_MB * MB, () => {
      stopFor('size');
    });
    let lastProgress = 0;
    const report = (values: Partial<LiveProgress>) => {
      const now = Date.now();
      if (now - lastProgress < PROGRESS_INTERVAL_MS) return;
      lastProgress = now;
      void this.reportProgress(job.id, progress(values));
    };
    // yt-dlp's own progress template (DASH, --live-from-start) and, for live HLS, ffmpeg's stats.
    const onLine = (line: string) => {
      const parsed = parseProgressLine(line);
      if (parsed || RECORDING_LINE.test(line)) startRecording();
      if (parsed) report({ bytes: parsed.bytes, speed: parsed.speed });
    };
    const onStderr = (line: string) => {
      for (const part of line.split('\r')) {
        const stats = parseFfmpegStats(part);
        if (stats) {
          startRecording();
          report({
            bytes: stats.bytes,
            speed: stats.bytesPerSecond,
            recorded_s: Math.round(stats.recordedS),
          });
          continue;
        }
        onLine(part);
        if (part.trim() === '' || isTransportNoise(part)) continue;
        log.push(redactText(part).slice(0, 1000));
        if (log.length > MAX_LOG_LINES) log.shift();
      }
    };
    try {
      await this.runner.run(this.recordArgs(session, tempDir), session.url, {
        timeoutMs: waitCapMs + limitS * 1000 + SLACK_MS,
        workDir,
        stopSignal: stop.signal,
        ...(options.impersonate && { impersonate: options.impersonate }),
        onStdoutLine: onLine,
        onStderrLine: onStderr,
      });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      stopWatchdog();
      signal.removeEventListener('abort', onCancel);
    }
    if (startedAt === undefined && stopReason === 'wait') {
      throw new AppError(
        'LIVE_NOT_STARTED',
        `The stream did not start within ${this.config.LIVE_MAX_WAIT_MINUTES} minutes`,
        { scheduled_start: schedule.start },
        {},
        false,
      );
    }
    return { files: await this.recordedFiles(workDir, stopReason !== undefined), stopReason };
  }

  private recordArgs({ options, access, workDir, extractor }: Session, tempDir: string): string[] {
    return [
      '--no-playlist',
      '--newline',
      '--progress',
      '--progress-template',
      `download:${PROGRESS_MARKER}%(progress)j`,
      '--no-overwrites',
      '--no-mtime',
      '--paths',
      `home:${workDir}`,
      '--paths',
      `temp:${tempDir}`,
      ...(path.isAbsolute(this.config.FFMPEG_BIN)
        ? ['--ffmpeg-location', this.config.FFMPEG_BIN]
        : []),
      '--retries',
      '3',
      '--fragment-retries',
      '10',
      '--retry-sleep',
      'exp=1:30',
      '-o',
      '%(title).150B [%(id)s].%(ext)s',
      '--trim-filenames',
      '180',
      ...formatSelectionArgs(options.preset),
      // Crash-safe while recording; remuxed to the container afterwards.
      '--hls-use-mpegts',
      ...(options.from_start ? ['--live-from-start'] : []),
      ...waitArgs(options.wait),
      ...(options.limit_rate_kbps === undefined ? [] : ['-r', `${options.limit_rate_kbps}K`]),
      ...youtubeExtractorArgs(options.extractor_args),
      ...access.args(extractor === undefined ? {} : { extractor }),
    ];
  }

  /** Media yt-dlp left in the work directory; after a stop, an unfinished `.part` is kept too. */
  private async recordedFiles(workDir: string, stopped: boolean): Promise<string[]> {
    const names = (await readdir(workDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const media = names.filter((name) => classifyFile(name)?.role === 'media');
    if (media.length > 0 || !stopped) return media.map((name) => path.join(workDir, name));
    const parts = names.filter((name) => name.endsWith('.part'));
    const salvaged: string[] = [];
    for (const part of parts) {
      const target = path.join(workDir, part.slice(0, -'.part'.length));
      if ((await stat(path.join(workDir, part))).size === 0) continue;
      await rename(path.join(workDir, part), target);
      salvaged.push(target);
    }
    return salvaged;
  }

  /** One file per recording, or numbered segments with `split_every_minutes`. */
  private async remux(files: string[], workDir: string, options: RecordOptions): Promise<string[]> {
    const outDir = path.join(workDir, '.out');
    await mkdir(outDir, { recursive: true });
    const split =
      options.split_every_minutes === undefined ? undefined : options.split_every_minutes * 60;
    for (const file of files) {
      const base = path.basename(file).replace(/\.[^.]+$/, '');
      const output = path.join(
        outDir,
        `${base}${split === undefined ? '' : ' - part %03d'}.${options.container}`,
      );
      const result = await execa(
        this.config.FFMPEG_BIN,
        remuxArgs(file, output, options.container, split),
        {
          reject: false,
          timeout: SLACK_MS,
          stdin: 'ignore',
        },
      );
      if (result.exitCode !== 0) {
        throw new AppError(
          'EXTRACTION_FAILED',
          `The recording could not be remuxed: ${redactText(result.stderr).slice(-300)}`,
          undefined,
          {},
          false,
        );
      }
      await rm(file, { force: true });
    }
    return (await readdir(outDir)).sort().map((name) => path.join(outDir, name));
  }

  private async store(
    job: Job,
    files: string[],
    workDir: string,
    options: RecordOptions,
    status: 'completed' | 'cancelled',
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + this.config.FILE_TTL_DAYS * 86_400_000);
    const rows: (typeof outputs.$inferInsert)[] = [];
    for (const file of files) {
      const id = uuidv7();
      const name = path.basename(file);
      const relative = path.join(job.id, id, name);
      const target = path.join(this.config.FILES_DIR, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(file, target);
      const probe = await ffprobe(this.config.FFPROBE_BIN, target).catch((error: unknown) => {
        this.logger.warn(
          { err: error, jobId: job.id },
          'ffprobe failed; recording stored without a probe',
        );
        return null;
      });
      rows.push({
        id,
        jobId: job.id,
        clientId: job.clientId,
        userId: job.userId,
        role: 'media',
        name,
        path: relative,
        mime: RECORD_CONTAINERS[options.container],
        sizeBytes: (await stat(target)).size,
        durationS: probe?.duration_s ?? null,
        probe,
        expiresAt,
      });
    }
    await this.db.transaction(async (tx) => {
      if (rows.length > 0) await tx.insert(outputs).values(rows);
      await tx.update(jobs).set(this.finisher.end(job, status)).where(eq(jobs.id, job.id));
    });
    await this.finisher.announce(job, status);
    await rm(path.join(workDir, '.out'), { recursive: true, force: true });
  }

  private async setState(jobId: string, values: Partial<typeof jobs.$inferInsert>): Promise<void> {
    await this.db.update(jobs).set(values).where(eq(jobs.id, jobId));
    if (values.status) await publishStatus(this.redis, jobId, values.status);
  }

  private async reportProgress(jobId: string, progress: LiveProgress): Promise<void> {
    try {
      await writeProgress(this.redis, jobId, progress);
    } catch (error) {
      this.logger.warn({ err: error, jobId }, 'Could not publish progress');
    }
  }
}
