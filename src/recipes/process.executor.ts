import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { APP_CONFIG, DATABASE, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { JobFinisher } from '../drive/job-finisher';
import { clients, type Job, jobs, mediaFiles, outputs } from '../db/schema';
import { canonicalJson, type DedupKey } from '../downloads/dedup';
import { InputResolver } from '../inputs/resolver';
import { finalStatus, ItemCoordinator } from '../playlists/coordinator';
import type { Input } from '../inputs/schemas';
import { publishStatus, writeProgress } from '../jobs/job-state';
import { ffprobe, isAllowedFormat, type ProbeSummary } from '../media/ffprobe';
import { WHISPER_SETUP } from './capabilities';
import type { WhisperSetup } from './context';
import { FONT_CATALOG, type FontCatalog } from './fonts';
import type { Plan } from './compose';
import { type RecipeRunResult, runRecipe } from './run-recipe';
import { parseRecipe, type Recipe } from './validate';

const MB = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 1000;
const FINISHED = ['completed', 'completed_with_errors', 'cancelled', 'failed', 'skipped'];

interface StoredOptions {
  inputs?: Input[];
  recipe?: unknown;
  then?: unknown;
  keep_original?: boolean;
  _share_outputs?: boolean;
}

/** One file a recipe runs on. */
interface Source {
  path: string;
  probe: ProbeSummary;
  name: string;
  /** The download output it came from (then pipelines). */
  outputId?: string;
  /** Content identity of a process job's input (dedup). */
  identity?: string;
  /** Implicit pipeline inputs: the download's subtitles and thumbnail. */
  role?: 'subtitles' | 'thumbnail';
  lang?: string | undefined;
}

/** SPEC §9d: process jobs dedupe on (input content, canonical recipe). */
export function recipeKey(identity: string, recipe: Recipe): DedupKey {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  return {
    extractor: 'recipe',
    mediaId: hash(identity),
    preset: 'recipe',
    optionsHash: hash(canonicalJson(recipe.steps)),
  };
}

type OutputRow = Pick<
  typeof outputs.$inferInsert,
  | 'id'
  | 'role'
  | 'name'
  | 'path'
  | 'mime'
  | 'sizeBytes'
  | 'durationS'
  | 'probe'
  | 'isDirectory'
  | 'entry'
>;

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size;
  }
  return total;
}

/** "My Video (final).mp4" → "My Video (final)": a safe stem for output file names. */
export function outputStem(name: string): string {
  const base = path.basename(name).replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const safe = base
    .replace(/[^\p{L}\p{N} ._()[\]-]/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  return (safe === '' ? 'output' : safe).slice(0, 120);
}

/**
 * worker-ff (SPEC §9a, §9b): `process` jobs run their recipe on their input; downloads with
 * `then` run it on every media file they produced, then complete.
 */
@Injectable()
export class ProcessExecutor {
  private readonly logger = new Logger(ProcessExecutor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly inputs: InputResolver,
    @Inject(FONT_CATALOG) private readonly fonts: FontCatalog,
    @Inject(WHISPER_SETUP) private readonly whisper: WhisperSetup,
    private readonly coordinator: ItemCoordinator,
    private readonly finisher: JobFinisher,
  ) {}

  async execute(jobId: string, signal: AbortSignal): Promise<void> {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job || FINISHED.includes(job.status)) return;
    if (job.kind === 'parent') {
      await this.concatItems(job, signal);
      return;
    }
    const pipeline = job.type !== 'process';
    const options = job.options as StoredOptions;
    const workDir = path.join(this.config.FILES_DIR, '.work', job.id);
    await this.setState(
      job.id,
      pipeline
        ? { status: 'running', stage: 'processing' }
        : { status: 'running', stage: 'resolving_inputs', startedAt: new Date() },
    );
    let cancelled = false;
    try {
      const recipe = parseRecipe(pipeline ? options.then : options.recipe, this.config);
      // One recipe run per downloaded file (then), or one run over all of a process job's inputs.
      const runs = pipeline
        ? await this.pipelineRuns(job)
        : [await this.resolveInputs(job, options, signal)];
      const identities = runs[0]?.map((source) => source.identity ?? '') ?? [];
      const key =
        !pipeline && identities.every(Boolean)
          ? recipeKey(identities.join('|'), recipe)
          : undefined;
      if (key && (await this.reuse(job, key))) return;
      await rm(workDir, { recursive: true, force: true });
      await this.setState(job.id, { stage: 'processing' });
      const rows: OutputRow[] = [];
      for (const [i, sources] of runs.entries()) {
        const result = await this.run(job, recipe, sources, {
          workDir: path.join(workDir, String(i)),
          signal,
          index: i,
          count: runs.length,
        });
        rows.push(...(await this.place(job, sources[0]?.name ?? 'output', result)));
      }
      const replaced =
        pipeline && options.keep_original !== true
          ? runs.flatMap(([main]) => (main?.outputId ? [main.outputId] : []))
          : [];
      await this.complete(job, rows, replaced, key);
    } catch (error) {
      if (!signal.aborted) throw error;
      cancelled = true;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
    // Marked after cleanup, so a cancelled job never leaves its work directory behind.
    if (cancelled)
      await this.setState(job.id, { status: 'cancelled', stage: null, finishedAt: new Date() });
  }

  /**
   * concat_items (SPEC §7e): one extra output on the parent joining every item's media in
   * playlist order. A failed join leaves the items' outputs and ends the parent with errors.
   */
  private async concatItems(job: Job, signal: AbortSignal): Promise<void> {
    const workDir = path.join(this.config.FILES_DIR, '.work', job.id);
    const counts = await this.coordinator.counts(job.id);
    // The coordinator hands a parent over only when some items completed.
    const finished = finalStatus(counts) === 'completed' ? 'completed' : 'completed_with_errors';
    try {
      const rows = await this.db
        .select({ output: outputs, index: jobs.playlistIndex })
        .from(outputs)
        .innerJoin(jobs, eq(jobs.id, outputs.jobId))
        .where(
          and(
            eq(jobs.parentJobId, job.id),
            inArray(outputs.role, ['media', 'audio']),
            eq(outputs.hidden, false),
            gt(outputs.expiresAt, new Date()),
          ),
        )
        .orderBy(asc(jobs.playlistIndex), asc(outputs.createdAt));
      const firstPerItem = [...new Map(rows.map((row) => [row.output.jobId, row])).values()];
      if (firstPerItem.length > this.config.RECIPE_MAX_INPUTS) {
        throw new AppError(
          'RECIPE_INVALID',
          `concat_items joins at most ${this.config.RECIPE_MAX_INPUTS} items; this job has ${firstPerItem.length}`,
          undefined,
          {},
          false,
        );
      }
      const sources: Source[] = [];
      for (const { output } of firstPerItem) {
        const file = path.join(this.config.FILES_DIR, output.path);
        const probe =
          (output.probe as ProbeSummary | null) ?? (await ffprobe(this.config.FFPROBE_BIN, file));
        sources.push({ path: file, probe, name: output.name });
      }
      const audioOnly = firstPerItem.every(({ output }) => output.role === 'audio');
      const recipe = parseRecipe(
        {
          steps: [
            { op: 'concat' },
            { op: 'encode', name: 'joined', container: audioOnly ? 'm4a' : 'mp4' },
          ],
        },
        this.config,
      );
      await rm(workDir, { recursive: true, force: true });
      const result = await this.run(job, recipe, sources, { workDir, signal, index: 0, count: 1 });
      const placed = await this.place(job, 'playlist', result);
      await this.complete(job, placed, [], undefined, finished);
    } catch (error) {
      if (signal.aborted) {
        await this.setState(job.id, { status: 'cancelled', stage: null, finishedAt: new Date() });
        return;
      }
      const appError = error instanceof AppError ? error : undefined;
      if (!appError) this.logger.error({ err: error, jobId: job.id }, 'concat_items failed');
      await this.setState(job.id, {
        status: 'completed_with_errors',
        stage: null,
        errorCode: appError?.code ?? 'INTERNAL',
        errorMessage: `concat_items: ${appError?.message ?? 'internal error'}`,
        finishedAt: new Date(),
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Resolves every input in order; inputs[0] is the main one (SPEC §5). */
  private async resolveInputs(
    job: Job,
    options: StoredOptions,
    signal: AbortSignal,
  ): Promise<Source[]> {
    const inputs = options.inputs ?? [];
    if (inputs.length === 0)
      throw new AppError('RECIPE_INVALID', 'The job has no input', undefined, {}, false);
    const [client] = await this.db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, job.clientId));
    const owner = {
      clientId: job.clientId,
      clientName: client?.name ?? '',
      userId: job.userId,
      shareOutputsWithinClient: options._share_outputs === true,
    };
    const sources: Source[] = [];
    for (const input of inputs) {
      const resolved = await this.inputs.resolve(input, owner, { signal });
      this.checkDuration(resolved.probe);
      sources.push({
        path: resolved.path,
        probe: resolved.probe,
        name: resolved.name,
        identity: resolved.identity,
      });
    }
    return sources;
  }

  /** The media and audio files a download stored (SPEC §9b: each one gets the recipe). */
  /**
   * One run per media or audio file the download stored (SPEC §9b), each followed by the
   * download's subtitles and thumbnail as implicit inputs (`{ job_output: "subtitles", lang }`).
   */
  private async pipelineRuns(job: Job): Promise<Source[][]> {
    const rows = await this.db
      .select()
      .from(outputs)
      .where(
        and(
          eq(outputs.jobId, job.id),
          eq(outputs.hidden, false),
          gt(outputs.expiresAt, new Date()),
        ),
      );
    const media = rows.filter((row) => row.role === 'media' || row.role === 'audio');
    if (media.length === 0) {
      throw new AppError(
        'RECIPE_INVALID',
        'The download produced no media for its then recipe',
        undefined,
        {},
        false,
      );
    }
    const implicit: Source[] = [];
    for (const row of rows.filter(
      (entry) => entry.role === 'subtitles' || entry.role === 'thumbnail',
    )) {
      const file = path.join(this.config.FILES_DIR, row.path);
      const probe = await this.probe(file);
      if (!probe || !isAllowedFormat(probe.format)) continue;
      // "Title [id].en.vtt" → en
      const lang =
        row.role === 'subtitles'
          ? /\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)\.[a-z0-9]+$/.exec(row.name)?.[1]
          : undefined;
      const role = row.role === 'subtitles' ? 'subtitles' : 'thumbnail';
      implicit.push({ path: file, probe, name: row.name, role, lang });
    }
    const runs: Source[][] = [];
    for (const row of media) {
      const file = path.join(this.config.FILES_DIR, row.path);
      const probe =
        (row.probe as ProbeSummary | null) ?? (await ffprobe(this.config.FFPROBE_BIN, file));
      this.checkDuration(probe);
      runs.push([{ path: file, probe, name: row.name, outputId: row.id }, ...implicit]);
    }
    return runs;
  }

  private checkDuration(probe: ProbeSummary): void {
    if ((probe.duration_s ?? 0) > this.config.MAX_MEDIA_DURATION_MINUTES * 60) {
      throw new AppError(
        'MEDIA_TOO_LONG',
        `Inputs are limited to ${this.config.MAX_MEDIA_DURATION_MINUTES} minutes`,
        undefined,
        {},
        false,
      );
    }
  }

  private run(
    job: Job,
    recipe: Recipe,
    sources: Source[],
    context: { workDir: string; signal: AbortSignal; index: number; count: number },
  ): Promise<RecipeRunResult> {
    let lastProgress = 0;
    return runRecipe(
      recipe,
      sources.map((source) => ({
        path: source.path,
        probe: source.probe,
        role: source.role,
        lang: source.lang,
      })),
      {
        workDir: context.workDir,
        threads: this.config.FFMPEG_THREADS,
        maxFileBytes: this.config.MAX_FILE_SIZE_MB * MB,
        limits: this.config,
        ffmpegBin: this.config.FFMPEG_BIN,
        ffprobeBin: this.config.FFPROBE_BIN,
        maxCost: this.config.RECIPE_MAX_COST,
        fonts: this.fonts,
        fontDir: this.config.FONT_DIR,
        whisper: this.whisper,
        timeoutBaseMinutes: this.config.RECIPE_TIMEOUT_BASE_MINUTES,
        timeoutFactor: this.config.RECIPE_TIMEOUT_FACTOR,
        signal: context.signal,
        onPlan: (plan) => this.countMinutes(job, plan, context.index),
        onProgress: (percent, step, speed) => {
          const now = Date.now();
          if (now - lastProgress < PROGRESS_INTERVAL_MS && percent < 100) return;
          lastProgress = now;
          const overall = Math.round(((context.index + percent / 100) / context.count) * 1000) / 10;
          const label =
            context.count > 1 ? `file ${context.index + 1}/${context.count}, ${step}` : step;
          writeProgress(this.redis, job.id, {
            stage: 'processing',
            step: label,
            percent: overall,
            speed,
          }).catch((error: unknown) => {
            this.logger.warn({ err: error, jobId: job.id }, 'Could not publish progress');
          });
        },
      },
    );
  }

  /** USER_MAX_PROCESS_MINUTES_PER_DAY: input minutes, counted once per source even across retries. */
  private async countMinutes(job: Job, plan: Plan, index: number): Promise<void> {
    const minutes = Math.ceil(plan.inputSeconds / 60);
    if (minutes === 0) return;
    const counted = `media:quota:process:counted:${job.id}:${index}`;
    if ((await this.redis.set(counted, '1', 'EX', 2 * 86_400, 'NX')) !== 'OK') return;
    const day = new Date().toISOString().slice(0, 10);
    const key = `media:quota:process:${job.clientId}:${job.userId}:${day}`;
    const [[, total] = []] =
      (await this.redis
        .multi()
        .incrby(key, minutes)
        .expire(key, 2 * 86_400)
        .exec()) ?? [];
    if (Number(total) > this.config.USER_MAX_PROCESS_MINUTES_PER_DAY) {
      await this.redis.multi().decrby(key, minutes).del(counted).exec();
      throw new AppError(
        'QUOTA_EXCEEDED',
        `This user may process ${this.config.USER_MAX_PROCESS_MINUTES_PER_DAY} minutes of media per day`,
        undefined,
        {},
        false,
      );
    }
  }

  /** Moves each file to <FILES_DIR>/<jobId>/<outputId>/<stem>.<file> (SPEC §10). */
  private async place(job: Job, inputName: string, result: RecipeRunResult): Promise<OutputRow[]> {
    const stem = outputStem(inputName);
    const rows: OutputRow[] = [];
    const target = async (name: string) => {
      const id = uuidv7();
      const relative = path.join(job.id, id, name);
      await mkdir(path.dirname(path.join(this.config.FILES_DIR, relative)), { recursive: true });
      return { id, relative, absolute: path.join(this.config.FILES_DIR, relative) };
    };
    for (const file of result.files) {
      for (const produced of file.paths) {
        const name = `${stem}.${path.basename(produced)}`;
        const placed = await target(name);
        await rename(produced, placed.absolute);
        const directory = file.directory === true;
        const probe =
          !directory && (file.role === 'media' || file.role === 'audio')
            ? await this.probe(placed.absolute)
            : null;
        rows.push({
          id: placed.id,
          role: file.role,
          name,
          path: placed.relative,
          mime: file.mime,
          sizeBytes: directory
            ? await directorySize(placed.absolute)
            : (await stat(placed.absolute)).size,
          durationS: probe?.duration_s ?? null,
          probe,
          isDirectory: directory,
          entry: directory ? (file.entry ?? null) : null,
        });
      }
    }
    for (const report of result.reports) {
      const text = JSON.stringify(report.data);
      const name = `${stem}.${report.name}.json`;
      const placed = await target(name);
      await writeFile(placed.absolute, text);
      rows.push({
        id: placed.id,
        role: 'report',
        name,
        path: placed.relative,
        mime: 'application/json',
        sizeBytes: Buffer.byteLength(text),
        durationS: null,
        probe: null,
        isDirectory: false,
        entry: null,
      });
    }
    for (const warning of result.warnings) this.logger.warn({ jobId: job.id }, warning);
    return rows;
  }

  /** Records the outputs, hides replaced originals (keep_original false) and completes the job. */
  private async complete(
    job: Job,
    rows: OutputRow[],
    replaced: string[],
    key?: DedupKey,
    status: 'completed' | 'completed_with_errors' = 'completed',
  ): Promise<void> {
    await this.setState(job.id, { stage: 'finalizing' });
    const expiresAt = new Date(Date.now() + this.config.FILE_TTL_DAYS * 86_400_000);
    await this.db.transaction(async (tx) => {
      // The dedup entry points at this job's outputs, like a download's (SPEC §9d).
      const [mediaFile] = key
        ? await tx
            .insert(mediaFiles)
            .values({
              ...key,
              jobId: job.id,
              path: job.id,
              sizeBytes: rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0),
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
            .returning({ id: mediaFiles.id })
        : [];
      if (rows.length > 0) {
        await tx.insert(outputs).values(
          rows.map((row) => ({
            ...row,
            jobId: job.id,
            clientId: job.clientId,
            userId: job.userId,
            mediaFileId: mediaFile?.id ?? null,
            expiresAt,
          })),
        );
      }
      // Hidden, not deleted: dedup reuse still needs them and cleanup expires them as usual.
      if (replaced.length > 0) {
        await tx.update(outputs).set({ hidden: true }).where(inArray(outputs.id, replaced));
      }
      await tx.update(jobs).set(this.finisher.end(job, status)).where(eq(jobs.id, job.id));
    });
    await this.finisher.announce(job, status);
  }

  /** A finished identical recipe on the same content: copy its outputs instead of running ffmpeg. */
  private async reuse(job: Job, key: DedupKey): Promise<boolean> {
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
      .where(
        and(
          eq(outputs.jobId, cached.jobId),
          eq(outputs.mediaFileId, cached.id),
          gt(outputs.expiresAt, safetyMargin),
        ),
      );
    if (source.length === 0) return false;
    const expiresAt = new Date(now.getTime() + this.config.FILE_TTL_DAYS * 86_400_000);
    await this.db.transaction(async (tx) => {
      await tx.insert(outputs).values(
        source.map(({ id: _id, createdAt: _createdAt, ...output }) => ({
          ...output,
          jobId: job.id,
          clientId: job.clientId,
          userId: job.userId,
          // Delivery is per job and per user: this job uploads its own copy.
          driveFileId: null,
          driveLink: null,
          driveFolderId: null,
          expiresAt,
        })),
      );
      await tx
        .update(mediaFiles)
        .set({ expiresAt, lastUsedAt: now })
        .where(eq(mediaFiles.id, cached.id));
      await tx.update(jobs).set(this.finisher.end(job)).where(eq(jobs.id, job.id));
    });
    await this.finisher.announce(job);
    return true;
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

  private async setState(jobId: string, values: Partial<typeof jobs.$inferInsert>): Promise<void> {
    await this.db.update(jobs).set(values).where(eq(jobs.id, jobId));
    if (values.status) await publishStatus(this.redis, jobId, values.status);
  }
}
