import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq, gt } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { youtubeExtractorArgs } from '../access/access-args';
import { type JobAccess, JobAccessResolver } from '../access/job-access';
import { clearSecrets, sealedPart } from '../access/sealed';
import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { once } from '../common/once';
import { redactText } from '../common/redact';
import { APP_CONFIG, DATABASE, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database, Transaction } from '../db/database';
import {
  archive,
  clients,
  type Job,
  jobLogs,
  jobs,
  mediaFiles,
  outputs,
  playlists,
} from '../db/schema';
import { JobFinisher } from '../drive/job-finisher';
import { driveDestination } from '../drive/destination';
import { URL_RESOLVER } from '../discovery/discovery.service';
import { asRecord, isPlaylist, mapComments } from '../discovery/mappers';
import { formatSelectionArgs } from '../discovery/presets';
import { InputResolver } from '../inputs/resolver';
import type { Input } from '../inputs/schemas';
import { publishStatus, writeProgress } from '../jobs/job-state';
import { FFMPEG_QUEUE, type QueueJobData, queueJobOptions } from '../jobs/queues';
import { itemOptions, MEDIALESS_PRESETS, pipelineOptions } from '../jobs/schemas';
import { RecordExecutor } from '../live/record.executor';
import { type ItemChecks, itemJobOptions } from '../playlists/checks';
import { ItemCoordinator } from '../playlists/coordinator';
import { checkFilters, type Filters, inDateRange } from '../playlists/filters';
import { archiveKey, planItems } from '../playlists/plan';
import { channelTabUrl, parseSelection } from '../playlists/selection';
import { ffprobe, type ProbeSummary } from '../media/ffprobe';
import { YtDlpRunner } from '../ytdlp/runner';
import { guardUrl, type Resolver } from '../ytdlp/url-guard';
import { downloadArgs } from './args';
import { classifyFile } from './classify';
import { type DedupKey, lockKey, optionsHash } from './dedup';
import { type DownloadOptions, downloadOptionsSchema } from './options';
import { parseProgressLine, type Progress } from './progress';
import { startWatchdog } from './watchdog';

const MAX_LOG_LINES = 200;
const PROGRESS_INTERVAL_MS = 1000;
const LOCK_POLL_MS = 1000;
const MB = 1024 * 1024;

type Raw = Record<string, unknown>;

/** Statuses after which a queue delivery has nothing left to do. */
const FINISHED = ['completed', 'completed_with_errors', 'cancelled', 'failed', 'skipped'];

const hasPipeline = (job: Job) => (job.options as Raw).then !== undefined;

const stringField = (raw: Raw, field: string): string | undefined =>
  typeof raw[field] === 'string' ? raw[field] : undefined;

interface StoredRow {
  id: string;
  jobId: string;
  clientId: string;
  userId: string;
  role: string;
  name: string;
  path: string;
  mime: string;
  sizeBytes: number;
  durationS: number | null;
  probe: ProbeSummary | null;
  expiresAt: Date;
}

interface ProducedFile {
  name: string;
  role: string;
  mime: string;
  size: number;
}

/** Runs one single-item download job end to end (SPEC §9). */
@Injectable()
export class DownloadExecutor {
  private readonly logger = new Logger(DownloadExecutor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly runner: YtDlpRunner,
    @Inject(URL_RESOLVER) private readonly resolve: Resolver,
    private readonly coordinator: ItemCoordinator,
    private readonly inputs: InputResolver,
    private readonly access: JobAccessResolver,
    private readonly recorder: RecordExecutor,
    private readonly finisher: JobFinisher,
    @InjectQueue(FFMPEG_QUEUE) private readonly ffmpeg: Queue<QueueJobData>,
  ) {}

  /**
   * Returns normally for completed, skipped, expanded and cancelled jobs; throws an AppError (or
   * an unexpected error) for failures, which the queue processor turns into a retry or a failure.
   */
  async execute(jobId: string, signal: AbortSignal): Promise<void> {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId));
    // A job in stage "processing" belongs to worker-ff now (then pipeline).
    if (!job || FINISHED.includes(job.status) || job.stage === 'processing') return;
    const log: string[] = [];
    let cancelled = false;
    // A job reports finished only once its log is stored and its work directory is gone: the
    // executors call this right before that commit, and the finally block covers every other end.
    const finalize = once(async () => {
      await this.writeLog(job.id, log);
      await rm(this.workDir(job.id), { recursive: true, force: true });
    });

    await this.setState(job.id, {
      status: 'running',
      stage: 'resolving_inputs',
      startedAt: new Date(),
    });
    try {
      if (job.type === 'comments') await this.exportComments(job, signal);
      else if (job.type === 'probe') await this.probeInput(job, signal);
      else if (job.type === 'record')
        await this.recorder.record(job, this.workDir(job.id), signal, log, finalize);
      else await this.runDownload(job, signal, log, finalize);
    } catch (error) {
      if (!signal.aborted || (error instanceof AppError && error.code === 'FILE_TOO_LARGE')) {
        throw error;
      }
      cancelled = true;
    } finally {
      await finalize();
    }
    // Marked only after cleanup, so a cancelled job never leaves its work directory behind.
    if (cancelled) {
      await this.setState(job.id, { status: 'cancelled', stage: null, finishedAt: new Date() });
    } else if (hasPipeline(job)) {
      await this.startPipeline(job);
    }
  }

  private async runDownload(
    job: Job,
    signal: AbortSignal,
    log: string[],
    finalize: () => Promise<void>,
  ): Promise<void> {
    const stored = job.options as Raw;
    const { checks } = stored as { checks?: ItemChecks };
    const perItem = itemOptions(stored);
    const options = downloadOptionsSchema.parse(perItem);
    const access = await this.access.prepare(
      { clientId: job.clientId, userId: job.userId },
      options,
      stored,
      path.join(this.workDir(job.id), '.access'),
    );
    // The cookie copy is shredded before the work directory goes.
    const finish = once(async () => {
      await access.dispose();
      await finalize();
    });
    try {
      const info = await this.resolveInfo(job, options, stored, access, signal);
      if (isPlaylist(info)) {
        if (job.kind === 'item' || stored.mode === 'single') {
          throw new AppError(
            'VALIDATION_FAILED',
            'The URL is a playlist; use mode "auto" or "playlist"',
          );
        }
        await this.expandParent(job, stored, perItem, info);
        return;
      }
      this.checkMedia(info, options);
      if (checks && !this.itemWanted(info, checks)) {
        await finish();
        await this.setState(job.id, { status: 'skipped', stage: null, finishedAt: new Date() });
        return;
      }
      const key: DedupKey = {
        extractor:
          stringField(info, 'extractor_key') ?? stringField(info, 'extractor') ?? 'unknown',
        mediaId: stringField(info, 'id') ?? '',
        preset: options.preset,
        // SPEC §9d: media fetched with this user's access is never handed to anyone else.
        optionsHash: optionsHash({
          ...perItem,
          ...(access.privateScope !== undefined && { _scope: access.privateScope }),
        }),
      };
      if (key.mediaId === '')
        throw new AppError('EXTRACTION_FAILED', 'yt-dlp returned no media id');
      if (!(await this.reuse(job, key, finish))) {
        const lock = await this.acquireLock(job.id, key, signal, finish);
        try {
          if (lock !== 'reused' && !(await this.reuse(job, key, finish))) {
            await this.download(job, options, info, key, access, signal, log, finish);
          }
        } finally {
          await this.releaseLock(job.id, key);
        }
      }
    } finally {
      await finish();
    }
  }

  /** Part of the transaction that completes a download, so skip_downloaded sees it at once. */
  private async recordInArchive(tx: Transaction, job: Job, key: DedupKey): Promise<void> {
    await tx
      .insert(archive)
      .values({
        clientId: job.clientId,
        userId: job.userId,
        extractor: key.extractor,
        mediaId: key.mediaId,
        jobId: job.id,
      })
      .onConflictDoNothing();
  }

  private workDir(jobId: string): string {
    return path.join(this.config.FILES_DIR, '.work', jobId);
  }

  /**
   * One metadata call. Items and single-mode jobs resolve one video; other jobs expand flat and
   * bounded (SPEC §9e), so a playlist URL becomes a parent without extracting every video.
   */
  private async resolveInfo(
    job: Job,
    options: DownloadOptions,
    stored: Raw,
    access: JobAccess,
    signal: AbortSignal,
  ): Promise<Raw> {
    const single = job.kind === 'item' || stored.mode === 'single';
    const tab =
      stored.channel_tab === 'shorts' || stored.channel_tab === 'streams'
        ? stored.channel_tab
        : 'videos';
    const url = await guardUrl(
      single ? (job.url ?? '') : channelTabUrl(job.url ?? '', tab),
      this.resolve,
    );
    const args = single
      ? ['--no-playlist']
      : [
          stored.mode === 'playlist' ? '--yes-playlist' : '--no-playlist',
          '--flat-playlist',
          ...this.expansionRange(stored),
        ];
    args.push(
      ...formatSelectionArgs(options.preset),
      ...youtubeExtractorArgs(options.extractor_args),
    );

    // Access flags carry job-local paths; the scope stands in for them in the cache key.
    const cacheKey = createHash('sha256')
      .update([url.href, ...args, access.cacheScope].join('\n'))
      .digest('hex');
    if (!single) {
      const cached = await this.cachedPlaylist(cacheKey);
      if (cached) return cached;
    }
    const info = asRecord(
      await this.runner.json([...args, ...access.args({ url: url.href })], url.href, {
        timeoutMs: this.config.PLAYLIST_EXPAND_TIMEOUT_SECONDS * 1000,
        signal,
        ...(options.impersonate && { impersonate: options.impersonate }),
      }),
    );
    if (!single && isPlaylist(info)) await this.cachePlaylist(cacheKey, info);
    return info;
  }

  private expansionRange(stored: Raw): string[] {
    if (typeof stored.items === 'string') return ['-I', parseSelection(stored.items).ytdlp];
    // One more than the cap, so an oversized playlist is recognised without expanding all of it.
    return ['--playlist-end', String(this.config.PLAYLIST_MAX_ITEMS + 1)];
  }

  private async cachedPlaylist(cacheKey: string): Promise<Raw | undefined> {
    if (this.config.PLAYLIST_CACHE_TTL_MINUTES === 0) return undefined;
    const fresh = new Date(Date.now() - this.config.PLAYLIST_CACHE_TTL_MINUTES * 60_000);
    const [row] = await this.db
      .select()
      .from(playlists)
      .where(and(eq(playlists.cacheKey, cacheKey), gt(playlists.expandedAt, fresh)));
    if (!row) return undefined;
    return {
      _type: 'playlist',
      id: row.playlistId,
      title: row.title,
      extractor_key: row.extractor,
      entries: row.entries,
    };
  }

  private async cachePlaylist(cacheKey: string, info: Raw): Promise<void> {
    const values = {
      cacheKey,
      extractor: stringField(info, 'extractor_key') ?? null,
      playlistId: stringField(info, 'id') ?? null,
      title: stringField(info, 'title') ?? null,
      uploader: stringField(info, 'uploader') ?? stringField(info, 'channel') ?? null,
      itemCount: typeof info.playlist_count === 'number' ? info.playlist_count : null,
      entries: Array.isArray(info.entries) ? info.entries : [],
      expandedAt: new Date(),
    };
    await this.db
      .insert(playlists)
      .values(values)
      .onConflictDoUpdate({ target: playlists.cacheKey, set: values });
  }

  /** Turns the job into a playlist parent and creates its items (SPEC §9e). */
  private async expandParent(job: Job, stored: Raw, perItem: Raw, info: Raw): Promise<void> {
    await this.setState(job.id, { stage: 'expanding' });
    const entries = Array.isArray(info.entries) ? (info.entries as Raw[]) : [];
    const requested = Array.isArray(info.requested_entries) ? info.requested_entries : undefined;
    const plan = planItems({
      entries,
      requestedIndices: requested?.every((index) => typeof index === 'number')
        ? requested
        : undefined,
      limits: {
        maxItems: this.config.PLAYLIST_MAX_ITEMS,
        maxTotalHours: this.config.PLAYLIST_MAX_TOTAL_DURATION_HOURS,
        unknownDurationMinutes: this.config.PLAYLIST_UNKNOWN_DURATION_MINUTES,
      },
      selected: typeof stored.items === 'string',
      maxItems: typeof stored.max_items === 'number' ? stored.max_items : undefined,
      reverse: stored.reverse === true,
      random: stored.random === true,
      filters: stored.filters as Filters | undefined,
      archived: stored.skip_downloaded === true ? await this.archivedKeys(job) : undefined,
    });
    const options = itemJobOptions(stored, {
      ...perItem,
      ...pipelineOptions(stored),
      ...sealedPart(stored),
    });
    const destination = driveDestination(job.destination);
    if (destination && typeof info.title === 'string') {
      // The items' Drive sub-folder is named after the playlist (SPEC §11).
      await this.db
        .update(jobs)
        .set({ destination: { ...destination, _name: info.title } })
        .where(eq(jobs.id, job.id));
    }
    await this.coordinator.createItems(
      job,
      plan.items.map((item) => ({ ...item, options })),
    );
    // The items carry the sealed secrets from here on.
    await clearSecrets(this.db, [job.id]);
  }

  private async archivedKeys(job: Job): Promise<Set<string>> {
    const rows = await this.db
      .select({ extractor: archive.extractor, mediaId: archive.mediaId })
      .from(archive)
      .where(and(eq(archive.clientId, job.clientId), eq(archive.userId, job.userId)));
    return new Set(rows.map((row) => archiveKey(row.extractor, row.mediaId)));
  }

  /** Item-level checks on the full metadata, for fields flat playlist entries lack (dates, likes). */
  private itemWanted(info: Raw, checks: ItemChecks): boolean {
    if (!inDateRange(info.upload_date, checks.date_after, checks.date_before)) return false;
    return checks.filters === undefined || checkFilters(info, checks.filters) !== 'reject';
  }

  private checkMedia(info: Raw, options: DownloadOptions): void {
    if (info.is_live === true) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This is a live stream; record it with a "record" job',
        undefined,
        {},
        false,
      );
    }
    const duration = typeof info.duration === 'number' ? info.duration : undefined;
    const effective = options.sections
      ? options.sections.reduce((total, section) => total + (section.end - section.start), 0)
      : duration;
    if (effective !== undefined && effective > this.config.MAX_MEDIA_DURATION_MINUTES * 60) {
      throw new AppError(
        'MEDIA_TOO_LONG',
        `Media is limited to ${this.config.MAX_MEDIA_DURATION_MINUTES} minutes`,
        {
          duration_s: effective,
        },
      );
    }
  }

  /** `comments` jobs (SPEC §9a): comment exports above the synchronous cap, as a JSON output. */
  private async exportComments(job: Job, signal: AbortSignal): Promise<void> {
    const { max, sort } = job.options as { max: number; sort: string };
    const url = await guardUrl(job.url ?? '', this.resolve);
    await this.setState(job.id, { stage: 'downloading' });
    const raw = asRecord(
      await this.runner.json(
        [
          '--no-playlist',
          '--skip-download',
          '--write-comments',
          '--extractor-args',
          `youtube:max_comments=${max};comment_sort=${sort}`,
        ],
        url.href,
        { timeoutMs: this.config.JOB_TIMEOUT_MINUTES * 60_000, signal },
      ),
    );
    const name = `${(stringField(raw, 'id') ?? 'comments').replace(/[^\w.-]/g, '_')}.comments.json`;
    await this.storeJsonOutput(job, 'comments', name, mapComments(raw, max));
  }

  /** `probe` jobs: inputs too large for the synchronous /v1/probe, reported as JSON. */
  private async probeInput(job: Job, signal: AbortSignal): Promise<void> {
    const { input } = job.options as { input: Input };
    const [client] = await this.db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, job.clientId));
    const resolved = await this.inputs.resolve(
      input,
      {
        clientId: job.clientId,
        clientName: client?.name ?? '',
        userId: job.userId,
        shareOutputsWithinClient:
          (job.options as { _share_outputs?: boolean })._share_outputs === true,
      },
      { signal },
    );
    await this.storeJsonOutput(job, 'report', 'probe.json', {
      input: { type: resolved.type, size_bytes: resolved.sizeBytes },
      probe: resolved.probe,
    });
  }

  /** Writes a JSON document as the job's only output and completes the job. */
  private async storeJsonOutput(
    job: Job,
    role: string,
    name: string,
    document: unknown,
  ): Promise<void> {
    const text = JSON.stringify(document);
    const id = uuidv7();
    const relative = path.join(job.id, id, name);
    await mkdir(path.dirname(path.join(this.config.FILES_DIR, relative)), { recursive: true });
    await writeFile(path.join(this.config.FILES_DIR, relative), text);
    await this.db.transaction(async (tx) => {
      await tx.insert(outputs).values({
        id,
        jobId: job.id,
        clientId: job.clientId,
        userId: job.userId,
        role,
        name,
        path: relative,
        mime: 'application/json',
        sizeBytes: Buffer.byteLength(text),
        expiresAt: new Date(Date.now() + this.config.FILE_TTL_DAYS * 86_400_000),
      });
      await tx
        .update(jobs)
        .set({ status: 'completed', stage: null, finishedAt: new Date() })
        .where(eq(jobs.id, job.id));
    });
    await publishStatus(this.redis, job.id, 'completed');
  }

  private async download(
    job: Job,
    options: DownloadOptions,
    info: Raw,
    key: DedupKey,
    access: JobAccess,
    signal: AbortSignal,
    log: string[],
    finish: () => Promise<void>,
  ): Promise<void> {
    const workDir = this.workDir(job.id);
    const tempDir = path.join(workDir, '.tmp');
    await mkdir(tempDir, { recursive: true });
    // Reuses the extraction above instead of asking the site a second time.
    const infoFile = path.join(tempDir, 'source.info.json');
    await writeFile(infoFile, JSON.stringify(info));
    await this.setState(job.id, { stage: 'downloading' });

    const watchdog = new AbortController();
    const stopWatchdog = startWatchdog(workDir, this.config.MAX_FILE_SIZE_MB * MB, () => {
      watchdog.abort();
    });
    let lastProgress = 0;
    const onProgress = (line: string) => {
      const progress = parseProgressLine(line);
      const now = Date.now();
      if (!progress || (now - lastProgress < PROGRESS_INTERVAL_MS && progress.percent !== 100))
        return;
      lastProgress = now;
      void this.reportProgress(job.id, progress);
    };
    try {
      await this.runner.run(
        [
          ...downloadArgs(options, {
            workDir,
            tempDir,
            ffmpegLocation: path.isAbsolute(this.config.FFMPEG_BIN)
              ? this.config.FFMPEG_BIN
              : undefined,
            maxFileSizeMb: this.config.MAX_FILE_SIZE_MB,
            sponsorblockApiUrl: this.config.SPONSORBLOCK_API_URL,
          }),
          '--load-info-json',
          infoFile,
          ...access.args({ extractor: key.extractor }),
        ],
        undefined,
        {
          timeoutMs: this.config.JOB_TIMEOUT_MINUTES * 60_000,
          workDir,
          signal: AbortSignal.any([signal, watchdog.signal]),
          ...(options.impersonate && { impersonate: options.impersonate }),
          onStdoutLine: onProgress,
          onStderrLine: (line) => {
            if (line.trim() === '') return;
            log.push(redactText(line).slice(0, 1000));
            if (log.length > MAX_LOG_LINES) log.shift();
          },
        },
      );
    } catch (error) {
      if (watchdog.signal.aborted) {
        throw new AppError(
          'FILE_TOO_LARGE',
          `Files are limited to ${this.config.MAX_FILE_SIZE_MB} MB`,
        );
      }
      throw error;
    } finally {
      stopWatchdog();
    }

    await this.setState(job.id, { stage: 'finalizing' });
    const produced = await this.producedFiles(workDir);
    const medialess = MEDIALESS_PRESETS.includes(options.preset);
    if (!medialess && !produced.some((file) => file.role === 'media' || file.role === 'audio')) {
      throw new AppError(
        'EXTRACTION_FAILED',
        'yt-dlp finished without producing a media file',
        undefined,
        {},
        false,
      );
    }
    await this.store(job, info, key, produced, workDir, finish);
  }

  private async producedFiles(workDir: string): Promise<ProducedFile[]> {
    const files: ProducedFile[] = [];
    for (const entry of await readdir(workDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const classified = classifyFile(entry.name);
      if (!classified) continue;
      const { size } = await stat(path.join(workDir, entry.name));
      files.push({ name: entry.name, size, ...classified });
    }
    return files;
  }

  /** Moves each file to <FILES_DIR>/<jobId>/<outputId>/<name> (SPEC §10) and records it. */
  private async store(
    job: Job,
    info: Raw,
    key: DedupKey,
    produced: ProducedFile[],
    workDir: string,
    finish: () => Promise<void>,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + this.config.FILE_TTL_DAYS * 86_400_000);
    const rows: StoredRow[] = [];
    for (const file of produced) {
      const id = uuidv7();
      const relative = path.join(job.id, id, file.name);
      const target = path.join(this.config.FILES_DIR, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(workDir, file.name), target);
      const probe =
        file.role === 'media' || file.role === 'audio' ? await this.probe(target) : null;
      rows.push({
        id,
        jobId: job.id,
        clientId: job.clientId,
        userId: job.userId,
        role: file.role,
        name: file.name,
        path: relative,
        mime: file.mime,
        sizeBytes: file.size,
        durationS: probe?.duration_s ?? null,
        probe,
        expiresAt,
      });
    }
    const main = rows.find((row) => row.role === 'media' || row.role === 'audio') ?? rows[0];
    await finish();
    await this.db.transaction(async (tx) => {
      const [mediaFile] = await tx
        .insert(mediaFiles)
        .values({
          ...key,
          jobId: job.id,
          path: job.id,
          sizeBytes: rows.reduce((total, row) => total + row.sizeBytes, 0),
          mime: main?.mime ?? null,
          title: typeof info.title === 'string' ? info.title : null,
          durationS: main?.durationS ?? null,
          probe: main?.probe ?? null,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [
            mediaFiles.extractor,
            mediaFiles.mediaId,
            mediaFiles.preset,
            mediaFiles.optionsHash,
          ],
          set: { jobId: job.id, path: job.id, expiresAt, lastUsedAt: new Date() },
        })
        .returning({ id: mediaFiles.id });
      if (rows.length > 0) {
        await tx
          .insert(outputs)
          .values(rows.map((row) => ({ ...row, mediaFileId: mediaFile?.id ?? null })));
      }
      await this.recordInArchive(tx, job, key);
      await tx.update(jobs).set(this.completion(job)).where(eq(jobs.id, job.id));
    });
    await this.handOff(job);
  }

  /** A download with `then` stays running (stage processing) until worker-ff has run the recipe. */
  private completion(job: Job): Partial<typeof jobs.$inferInsert> {
    return hasPipeline(job) ? { status: 'running', stage: 'processing' } : this.finisher.end(job);
  }

  private async handOff(job: Job): Promise<void> {
    if (!hasPipeline(job)) await this.finisher.announce(job);
  }

  /**
   * Queues the `then` recipe once the download's work directory is gone: worker-ff uses the same
   * directory name and would otherwise lose it to this worker's cleanup.
   */
  private async startPipeline(job: Job): Promise<void> {
    const [current] = await this.db
      .select({ status: jobs.status, stage: jobs.stage })
      .from(jobs)
      .where(eq(jobs.id, job.id));
    if (current?.status !== 'running' || current.stage !== 'processing') return;
    // Its own BullMQ id: the download queue already used the job id.
    await this.ffmpeg.add(
      FFMPEG_QUEUE,
      { jobId: job.id },
      queueJobOptions(`${job.id}-then`, job.attempts),
    );
  }

  private async probe(file: string): Promise<ProbeSummary | null> {
    try {
      return await ffprobe(this.config.FFPROBE_BIN, file);
    } catch (error) {
      this.logger.warn(
        { err: error, file: path.basename(file) },
        'ffprobe failed; output stored without a probe',
      );
      return null;
    }
  }

  /**
   * SPEC §9d: a finished download with the same key is reused instantly. The new job gets its own
   * output rows pointing at the same files; cleanup deletes a file only when no output needs it.
   */
  private async reuse(job: Job, key: DedupKey, finish: () => Promise<void>): Promise<boolean> {
    const now = new Date();
    const safetyMargin = new Date(now.getTime() + 3_600_000);
    const [cached] = await this.db
      .select()
      .from(mediaFiles)
      .where(
        and(
          eq(mediaFiles.extractor, key.extractor),
          eq(mediaFiles.mediaId, key.mediaId),
          eq(mediaFiles.preset, key.preset),
          eq(mediaFiles.optionsHash, key.optionsHash),
          gt(mediaFiles.expiresAt, safetyMargin),
        ),
      );
    if (!cached?.jobId) return false;
    const source = await this.db
      .select()
      .from(outputs)
      // Only what the download produced: recipe outputs of that job (then) are not the media.
      .where(
        and(
          eq(outputs.jobId, cached.jobId),
          eq(outputs.mediaFileId, cached.id),
          gt(outputs.expiresAt, safetyMargin),
        ),
      );
    if (source.length === 0) return false;
    const expiresAt = new Date(now.getTime() + this.config.FILE_TTL_DAYS * 86_400_000);
    await finish();
    await this.db.transaction(async (tx) => {
      await tx.insert(outputs).values(
        source.map((output) => ({
          jobId: job.id,
          clientId: job.clientId,
          userId: job.userId,
          role: output.role,
          name: output.name,
          path: output.path,
          isDirectory: output.isDirectory,
          mime: output.mime,
          sizeBytes: output.sizeBytes,
          durationS: output.durationS,
          probe: output.probe,
          mediaFileId: cached.id,
          expiresAt,
        })),
      );
      await tx
        .update(mediaFiles)
        .set({ expiresAt, lastUsedAt: now })
        .where(eq(mediaFiles.id, cached.id));
      await this.recordInArchive(tx, job, key);
      await tx.update(jobs).set(this.completion(job)).where(eq(jobs.id, job.id));
    });
    await this.handOff(job);
    return true;
  }

  /**
   * In-flight dedup (SPEC §9d): the first job holds a Redis lock on the key; a concurrent job
   * with the same key waits and then reuses the result. Returns 'reused' when that happened.
   */
  private async acquireLock(
    jobId: string,
    key: DedupKey,
    signal: AbortSignal,
    finish: () => Promise<void>,
  ): Promise<'acquired' | 'reused'> {
    const name = lockKey(key);
    const ttlMs = this.config.JOB_TIMEOUT_MINUTES * 60_000 + 60_000;
    for (;;) {
      if ((await this.redis.set(name, jobId, 'PX', ttlMs, 'NX')) === 'OK') return 'acquired';
      await this.setState(jobId, { stage: 'waiting_for_duplicate' });
      while ((await this.redis.exists(name)) === 1) {
        if (signal.aborted) throw new AppError('TIMEOUT', 'The job was cancelled');
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
      const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId));
      if (job && (await this.reuse(job, key, finish))) return 'reused';
    }
  }

  private async releaseLock(jobId: string, key: DedupKey): Promise<void> {
    // Delete only our own lock (it may have expired and been taken over).
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey(key),
      jobId,
    );
  }

  private async reportProgress(jobId: string, progress: Progress): Promise<void> {
    try {
      await writeProgress(this.redis, jobId, progress);
    } catch (error) {
      this.logger.warn({ err: error, jobId }, 'Could not publish progress');
    }
  }

  private async setState(jobId: string, values: Partial<typeof jobs.$inferInsert>): Promise<void> {
    await this.db.update(jobs).set(values).where(eq(jobs.id, jobId));
    if (values.status) await publishStatus(this.redis, jobId, values.status);
  }

  private async writeLog(jobId: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    try {
      await this.db.delete(jobLogs).where(eq(jobLogs.jobId, jobId));
      await this.db.insert(jobLogs).values(lines.map((line, seq) => ({ jobId, seq, line })));
    } catch (error) {
      this.logger.warn({ err: error, jobId }, 'Could not store the job log');
    }
  }
}
