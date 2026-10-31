import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { AuthContext } from '../auth/api-keys';
import { requireUserId } from '../auth/request-auth';
import { assertDiskSpace } from '../common/disk';
import { CookiesService } from '../access/cookies.service';
import { CredentialsService } from '../access/credentials.service';
import { clearSecrets, sealSecrets } from '../access/sealed';
import { AppError } from '../common/errors';
import { isUuid, uuidv7 } from '../common/ids';
import { APP_CONFIG, DATABASE, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { type Job, jobLogs, jobs, type Output, outputs } from '../db/schema';
import { URL_RESOLVER } from '../discovery/discovery.service';
import { storedDestination } from '../drive/destination';
import { DriveConnections } from '../drive/drive-connections.service';
import type { DownloadOptions } from '../downloads/options';
import { signedJobPath, signedPackagePath, signedPath } from '../links/signing';
import { ItemCoordinator, type ItemCounts } from '../playlists/coordinator';
import { guardUrl, type Resolver } from '../ytdlp/url-guard';
import {
  claimIdempotencyKey,
  countDailyItem,
  type JobProgress,
  readProgress,
  requestCancel,
} from './job-state';
import { RecipesService } from '../recipes/recipes.service';
import { parseRecipe } from '../recipes/validate';
import {
  DOWNLOAD_QUEUE,
  FFMPEG_QUEUE,
  queueForType,
  type QueueJobData,
  queueJobOptions,
} from './queues';
import {
  type DownloadJobRequest,
  type JobRequest,
  type RecordJobRequest,
  type ListJobsQuery,
  MEDIALESS_PRESETS,
  parseJobRequest,
  storedOptions,
} from './schemas';

export const TERMINAL_STATUSES = [
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'expired',
  'skipped',
];
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/;

/** URLs a request will fetch, for the URL guard at creation. */
function jobUrls(request: JobRequest): string[] {
  switch (request.type) {
    case 'batch':
      return request.items.map((item) => item.url);
    case 'probe':
    case 'process':
      return ('inputs' in request ? request.inputs : [request.input]).flatMap((input) =>
        input.type === 'url' || input.type === 'media_url' ? [input.url] : [],
      );
    default:
      return [request.url];
  }
}

export interface OutputView {
  id: string;
  job_id: string;
  role: string;
  name: string;
  mime: string | null;
  size_bytes: number | null;
  duration_s: number | null;
  probe: unknown;
  expires_at: string;
  url: string;
  /** The copy in the user's Google Drive, once uploaded (SPEC §11). */
  drive: { file_id: string; link: string | null; folder_id: string | null } | null;
}

export interface JobView {
  id: string;
  type: string;
  kind: string;
  status: string;
  stage: string | null;
  url: string | null;
  options: unknown;
  progress: JobProgress | null;
  items: ItemCounts | null;
  index: number | null;
  error: { code: string; message: string | null } | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  outputs: OutputView[];
  archive_url: string | null;
  manifest_url: string | null;
}

/** Job options without internal keys (prefixed with "_"). */
function publicOptions(options: unknown): unknown {
  if (typeof options !== 'object' || options === null) return options;
  return Object.fromEntries(Object.entries(options).filter(([key]) => !key.startsWith('_')));
}

/** The access part of a download request (SPEC §7f). */
type AccessRequest = Partial<
  Pick<
    DownloadOptions,
    'cookies' | 'credentials' | 'tv_provider' | 'proxy' | 'geo_country' | 'extractor_args'
  >
>;

const encodeCursor = (value: string) => Buffer.from(value).toString('base64url');

function decodeCursor(cursor: string, check: (value: string) => boolean): string {
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!check(value)) throw new AppError('VALIDATION_FAILED', 'The cursor is not valid');
  return value;
}

@Injectable()
export class JobsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(DOWNLOAD_QUEUE) private readonly downloads: Queue<QueueJobData>,
    @InjectQueue(FFMPEG_QUEUE) private readonly ffmpeg: Queue<QueueJobData>,
    @Inject(URL_RESOLVER) private readonly resolve: Resolver,
    private readonly coordinator: ItemCoordinator,
    private readonly recipes: RecipesService,
    private readonly cookies: CookiesService,
    private readonly credentials: CredentialsService,
    private readonly drive: DriveConnections,
  ) {}

  async create(auth: AuthContext, body: unknown, idempotencyKey?: string): Promise<JobView> {
    const userId = requireUserId(auth);
    const request = parseJobRequest(body);
    await this.resolveRecipes(auth.clientId, request);
    this.checkLimits(request);
    await this.checkAccess({ clientId: auth.clientId, userId }, request);
    await this.checkDestination({ clientId: auth.clientId, userId }, request);
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Idempotency-Key must be 1-200 characters: letters, digits and . _ : -',
      );
    }
    const urls = jobUrls(request);
    for (const url of urls) await guardUrl(url, this.resolve);

    const jobId = uuidv7();
    const idemKey = `media:idem:${auth.clientId}:${userId}:${idempotencyKey ?? ''}`;
    if (idempotencyKey !== undefined) {
      const existing = await claimIdempotencyKey(
        this.redis,
        { clientId: auth.clientId, userId, key: idempotencyKey },
        jobId,
      );
      if (existing !== undefined) return this.awaitExisting(auth, existing);
    }
    try {
      await assertDiskSpace(this.config.FILES_DIR, this.config.DISK_QUOTA_PERCENT);
      const count = await countDailyItem(
        this.redis,
        auth.clientId,
        userId,
        Math.max(urls.length, 1),
      );
      if (count > this.config.USER_MAX_ITEMS_PER_DAY) {
        throw new AppError(
          'QUOTA_EXCEEDED',
          `This user is limited to ${this.config.USER_MAX_ITEMS_PER_DAY} items per day`,
        );
      }
      if (request.type === 'batch')
        await this.createBatch(jobId, auth.clientId, userId, request, idempotencyKey);
      else
        await this.createSingle(
          jobId,
          auth.clientId,
          userId,
          request,
          idempotencyKey,
          auth.shareOutputsWithinClient,
        );
    } catch (error) {
      // A failed creation must not pin the key to a job that does not exist.
      if (idempotencyKey !== undefined) await this.redis.del(idemKey);
      throw error;
    }
    return this.get(auth, jobId);
  }

  /**
   * Every check of POST /v1/jobs for a download that runs later (watches, SPEC §9f): schema,
   * recipes, limits, access and the URL guard. Returns the normalised request.
   */
  async validateDownload(
    auth: AuthContext,
    body: Record<string, unknown>,
  ): Promise<DownloadJobRequest> {
    const userId = requireUserId(auth);
    const request = parseJobRequest({ ...body, type: 'download' });
    if (request.type !== 'download') throw new Error('parseJobRequest changed the job type');
    await this.resolveRecipes(auth.clientId, request);
    this.checkLimits(request);
    await this.checkAccess({ clientId: auth.clientId, userId }, request);
    await this.checkDestination({ clientId: auth.clientId, userId }, request);
    await guardUrl(request.url, this.resolve);
    return request;
  }

  /** Named recipes (built-in or saved) become their steps before validation and storage. */
  private async resolveRecipes(clientId: string, request: JobRequest): Promise<void> {
    if (request.type === 'process') {
      request.recipe = (await this.recipes.resolve(clientId, request.recipe)).recipe;
      return;
    }
    const options =
      request.type === 'batch' ? request.items : request.type === 'download' ? [request] : [];
    for (const [i, option] of options.entries()) {
      if (option.then === undefined) continue;
      try {
        option.then = (await this.recipes.resolve(clientId, option.then)).recipe;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const prefix = request.type === 'batch' ? `items.${i}: ` : '';
        throw new AppError(error.code, `${prefix}then: ${error.message}`, error.details);
      }
    }
  }

  /**
   * SPEC §7f at creation: named jars and logins exist, and the proxy, country, player clients
   * and features are allowed here. The worker re-checks what the owner may change meanwhile.
   */
  private async checkAccess(
    owner: { clientId: string; userId: string },
    request: JobRequest,
  ): Promise<void> {
    const options =
      request.type === 'batch'
        ? request.items
        : request.type === 'download' || request.type === 'record'
          ? [request]
          : [];
    for (const [i, option] of options.entries()) {
      const prefix = request.type === 'batch' ? `items.${i}: ` : '';
      try {
        await this.checkAccessOption(owner, option);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        throw new AppError(error.code, `${prefix}${error.message}`, error.details);
      }
    }
  }

  private async checkAccessOption(
    owner: { clientId: string; userId: string },
    option: AccessRequest,
  ): Promise<void> {
    const { config } = this;
    if (option.cookies !== undefined) await this.cookies.check(owner, option.cookies);
    if (option.credentials !== undefined) await this.credentials.check(owner, option.credentials);
    if (option.tv_provider !== undefined && !config.TV_PROVIDER_ENABLED) {
      throw new AppError(
        'FEATURE_DISABLED',
        'TV provider logins are disabled on this server (TV_PROVIDER_ENABLED)',
      );
    }
    if (option.proxy !== undefined && !(option.proxy in config.PROXY_POOL)) {
      const names = Object.keys(config.PROXY_POOL);
      throw new AppError(
        'VALIDATION_FAILED',
        `proxy "${option.proxy}" is not configured${names.length > 0 ? `; available: ${names.join(', ')}` : ''}`,
      );
    }
    if (option.geo_country !== undefined) {
      if (config.GEO_BYPASS_ALLOWLIST.length === 0)
        throw new AppError(
          'FEATURE_DISABLED',
          'Geo bypass is not enabled on this server (GEO_BYPASS_ALLOWLIST)',
        );
      if (!config.GEO_BYPASS_ALLOWLIST.includes(option.geo_country))
        throw new AppError(
          'VALIDATION_FAILED',
          `geo_country must be one of ${config.GEO_BYPASS_ALLOWLIST.join(', ')}`,
        );
    }
    const clients = option.extractor_args?.youtube?.player_client ?? [];
    const refused = clients.filter(
      (client) => !config.YTDLP_ALLOWED_PLAYER_CLIENTS.includes(client),
    );
    if (refused.length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `extractor_args.youtube.player_client ${refused.join(', ')} is not allowed` +
          (config.YTDLP_ALLOWED_PLAYER_CLIENTS.length > 0
            ? `; allowed: ${config.YTDLP_ALLOWED_PLAYER_CLIENTS.join(', ')}`
            : ' on this server'),
      );
    }
  }

  /** Drive delivery (SPEC §11) needs a connected Drive now; the folder is checked at upload. */
  private async checkDestination(
    owner: { clientId: string; userId: string },
    request: JobRequest,
  ): Promise<void> {
    const destination = 'destination' in request ? request.destination : undefined;
    if (destination !== undefined && destination !== 'link')
      await this.drive.requireConnected(owner);
  }

  private queue(type: string): Queue<QueueJobData> {
    return queueForType(type) === FFMPEG_QUEUE ? this.ffmpeg : this.downloads;
  }

  private checkLimits(request: JobRequest): void {
    if (request.type === 'process') {
      this.checkProcess(request);
      return;
    }
    if (request.type === 'comments' || request.type === 'probe') return;
    if (request.type === 'record') {
      this.checkRecord(request);
      return;
    }
    if (request.type === 'batch' && request.items.length > this.config.BATCH_MAX_URLS) {
      throw new AppError(
        'BATCH_TOO_LARGE',
        `Batches are limited to ${this.config.BATCH_MAX_URLS} URLs`,
      );
    }
    if (
      request.type === 'download' &&
      request.max_items !== undefined &&
      request.max_items > this.config.PLAYLIST_MAX_ITEMS
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        `max_items is limited to ${this.config.PLAYLIST_MAX_ITEMS}`,
      );
    }
    const options = request.type === 'batch' ? request.items : [request];
    const rateCap = this.config.JOB_RATE_LIMIT_MAX_KBPS;
    options.forEach((option, i) => {
      this.checkPipeline(option, request.type === 'batch' ? `items.${i}: ` : '');
    });
    for (const option of options) {
      if (
        option.max_filesize_mb !== undefined &&
        option.max_filesize_mb > this.config.MAX_FILE_SIZE_MB
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          `max_filesize_mb is limited to ${this.config.MAX_FILE_SIZE_MB}`,
        );
      }
      if (option.limit_rate_kbps !== undefined && rateCap > 0 && option.limit_rate_kbps > rateCap) {
        throw new AppError('VALIDATION_FAILED', `limit_rate_kbps is limited to ${rateCap}`);
      }
    }
  }

  /** SPEC §7d limits: recording length, wait interval, split size and rate. */
  private checkRecord(request: RecordJobRequest): void {
    const { config } = this;
    const maxDuration = request.max_duration_minutes ?? config.LIVE_MAX_DURATION_MINUTES;
    if (maxDuration > config.LIVE_MAX_DURATION_MINUTES) {
      throw new AppError(
        'VALIDATION_FAILED',
        `max_duration_minutes is limited to ${config.LIVE_MAX_DURATION_MINUTES}`,
      );
    }
    const wait = request.wait?.max_minutes ?? request.wait?.min_minutes;
    if (wait !== undefined && wait > config.LIVE_MAX_WAIT_MINUTES) {
      throw new AppError(
        'VALIDATION_FAILED',
        `wait is limited to ${config.LIVE_MAX_WAIT_MINUTES} minutes`,
      );
    }
    if (request.split_every_minutes !== undefined && request.split_every_minutes >= maxDuration) {
      throw new AppError(
        'VALIDATION_FAILED',
        'split_every_minutes must be shorter than the recording',
      );
    }
    const rateCap = config.JOB_RATE_LIMIT_MAX_KBPS;
    if (request.limit_rate_kbps !== undefined && rateCap > 0 && request.limit_rate_kbps > rateCap) {
      throw new AppError('VALIDATION_FAILED', `limit_rate_kbps is limited to ${rateCap}`);
    }
  }

  /** `then` (SPEC §9b): validated like a process recipe; needs a preset that produces media. */
  private checkPipeline(
    option: { then?: unknown; keep_original?: boolean | undefined; preset: string },
    prefix: string,
  ): void {
    if (option.then === undefined) {
      if (option.keep_original !== undefined) {
        throw new AppError('VALIDATION_FAILED', `${prefix}keep_original applies only with then`);
      }
      return;
    }
    if (MEDIALESS_PRESETS.includes(option.preset)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${prefix}then needs a preset that downloads media, not ${option.preset}`,
      );
    }
    try {
      parseRecipe(option.then, this.config);
    } catch (error) {
      if (error instanceof AppError)
        throw new AppError(error.code, `${prefix}then: ${error.message}`, error.details);
      throw error;
    }
  }

  /** Static recipe checks at creation; input-dependent ones run on the worker (SPEC §8a). */
  private checkProcess(request: Extract<JobRequest, { type: 'process' }>): void {
    if (request.inputs.length > this.config.RECIPE_MAX_INPUTS) {
      throw new AppError(
        'RECIPE_INVALID',
        `Recipes take at most ${this.config.RECIPE_MAX_INPUTS} inputs`,
      );
    }
    parseRecipe(request.recipe, this.config);
  }

  private async createSingle(
    id: string,
    clientId: string,
    userId: string,
    request: Exclude<JobRequest, { type: 'batch' }>,
    idempotencyKey: string | undefined,
    shareOutputs: boolean,
  ): Promise<void> {
    await this.db.insert(jobs).values({
      id,
      type: request.type,
      kind: 'single',
      clientId,
      userId,
      url: jobUrls(request)[0] ?? null,
      options: sealSecrets(
        this.config.TOKEN_ENCRYPTION_KEYS,
        { clientId, userId },
        {
          ...storedOptions(request),
          // Internal (hidden from views): output inputs may come from the whole client.
          ...(request.type === 'process' || request.type === 'probe'
            ? { _share_outputs: shareOutputs }
            : {}),
        },
      ),
      destination: storedDestination('destination' in request ? request.destination : undefined),
      status: 'queued',
      idempotencyKey: idempotencyKey ?? null,
    });
    await this.queue(request.type).add(
      queueForType(request.type),
      { jobId: id },
      queueJobOptions(id),
    );
  }

  /** A batch is a parent whose items are known up front (SPEC §9a). */
  private async createBatch(
    id: string,
    clientId: string,
    userId: string,
    request: Extract<JobRequest, { type: 'batch' }>,
    idempotencyKey: string | undefined,
  ): Promise<void> {
    const requested = storedDestination(request.destination);
    // Its items go into one Drive sub-folder named after the batch.
    const destination = requested && {
      ...requested,
      _name: `Batch ${new Date().toISOString().slice(0, 10)} ${id.slice(0, 8)}`,
    };
    await this.db.insert(jobs).values({
      id,
      type: 'batch',
      kind: 'parent',
      clientId,
      userId,
      options: { concat_items: request.concat_items },
      destination,
      status: 'running',
      stage: 'items',
      startedAt: new Date(),
      idempotencyKey: idempotencyKey ?? null,
    });
    await this.coordinator.createItems(
      { id, clientId, userId, destination },
      request.items.map((item, i) => ({
        index: i + 1,
        id: String(i + 1),
        url: item.url,
        title: null,
        duration: null,
        options: sealSecrets(
          this.config.TOKEN_ENCRYPTION_KEYS,
          { clientId, userId },
          {
            ...storedOptions(item),
            mode: 'single',
          },
        ),
      })),
    );
  }

  /** A repeated Idempotency-Key may arrive before the first request has inserted its job. */
  private async awaitExisting(auth: AuthContext, jobId: string): Promise<JobView> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const job = await this.find(auth, jobId).catch(() => undefined);
      if (job) return this.view(job);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.get(auth, jobId);
  }

  async list(
    auth: AuthContext,
    query: ListJobsQuery,
  ): Promise<{ jobs: JobView[]; next_cursor: string | null }> {
    const userId = requireUserId(auth);
    const rows = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.clientId, auth.clientId),
          eq(jobs.userId, userId),
          // Items appear under their parent (GET /v1/jobs/:id/items), not in the main list.
          inArray(jobs.kind, ['single', 'parent']),
          query.status === undefined ? undefined : eq(jobs.status, query.status),
          query.type === undefined ? undefined : eq(jobs.type, query.type),
          query.cursor === undefined ? undefined : lt(jobs.id, decodeCursor(query.cursor, isUuid)),
        ),
      )
      .orderBy(desc(jobs.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      jobs: await Promise.all(page.map((job) => this.view(job))),
      next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
    };
  }

  async items(
    auth: AuthContext,
    id: string,
    query: { status?: string | undefined; cursor?: string | undefined; limit: number },
  ): Promise<{ items: JobView[]; next_cursor: string | null }> {
    const parent = await this.find(auth, id);
    const after =
      query.cursor === undefined
        ? 0
        : Number(decodeCursor(query.cursor, (value) => /^\d{1,7}$/.test(value)));
    const rows = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.parentJobId, parent.id),
          query.status === undefined ? undefined : eq(jobs.status, query.status),
          gt(jobs.playlistIndex, after),
        ),
      )
      .orderBy(asc(jobs.playlistIndex))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: await Promise.all(page.map((job) => this.view(job))),
      next_cursor:
        rows.length > query.limit && last?.playlistIndex != null
          ? encodeCursor(String(last.playlistIndex))
          : null,
    };
  }

  async get(auth: AuthContext, id: string): Promise<JobView> {
    return this.view(await this.find(auth, id));
  }

  async outputs(auth: AuthContext, id: string): Promise<{ outputs: OutputView[] }> {
    const job = await this.find(auth, id);
    return { outputs: (await this.jobOutputs(job)).map((output) => this.outputView(output)) };
  }

  /** The unexpired outputs of a job, or of all items of a parent, in item order. */
  async jobOutputs(job: Job): Promise<Output[]> {
    const now = new Date();
    if (job.kind !== 'parent') {
      return this.db
        .select()
        .from(outputs)
        .where(
          and(eq(outputs.jobId, job.id), eq(outputs.hidden, false), gt(outputs.expiresAt, now)),
        )
        .orderBy(asc(outputs.createdAt), asc(outputs.id));
    }
    // The parent's own outputs (concat_items) follow its items' outputs.
    const own = await this.db
      .select()
      .from(outputs)
      .where(and(eq(outputs.jobId, job.id), eq(outputs.hidden, false), gt(outputs.expiresAt, now)))
      .orderBy(asc(outputs.createdAt), asc(outputs.id));
    const rows = await this.db
      .select({ output: outputs })
      .from(outputs)
      .innerJoin(jobs, eq(jobs.id, outputs.jobId))
      .where(
        and(eq(jobs.parentJobId, job.id), eq(outputs.hidden, false), gt(outputs.expiresAt, now)),
      )
      .orderBy(asc(jobs.playlistIndex), asc(outputs.createdAt), asc(outputs.id));
    return [...rows.map((row) => row.output), ...own];
  }

  async cancel(auth: AuthContext, id: string): Promise<JobView> {
    const job = await this.find(auth, id);
    if (TERMINAL_STATUSES.includes(job.status)) return this.view(job);
    if (job.kind === 'parent') {
      await this.cancelParent(job);
      return this.get(auth, id);
    }
    if (job.status === 'queued' && (await this.cancelQueued(job))) {
      await clearSecrets(this.db, [id]);
      return this.get(auth, id);
    }
    await requestCancel(this.redis, id);
    return this.get(auth, id);
  }

  /** Removes a queued job from the queue and marks it cancelled; false if a worker has it. */
  private async cancelQueued({ id, type }: Pick<Job, 'id' | 'type'>): Promise<boolean> {
    const queued = await this.queue(type).getJob(id);
    await queued?.remove().catch(() => undefined); // Already taken by a worker: cancel via channel.
    const updated = await this.db
      .update(jobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(jobs.id, id), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id });
    return updated.length > 0;
  }

  /** Cancels pending and running items; completed items keep their outputs (SPEC §9c). */
  private async cancelParent(parent: Job): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: 'cancelled', stage: null, finishedAt: new Date() })
      .where(eq(jobs.id, parent.id));
    const open = await this.db
      .select({ id: jobs.id, type: jobs.type, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.parentJobId, parent.id), inArray(jobs.status, ['queued', 'running'])));
    const cancelled = [parent.id];
    for (const item of open) {
      if (item.status === 'queued' && (await this.cancelQueued(item))) {
        cancelled.push(item.id);
        continue;
      }
      await requestCancel(this.redis, item.id);
    }
    // Running items forget theirs when their worker finishes.
    await clearSecrets(this.db, cancelled);
  }

  async retry(auth: AuthContext, id: string): Promise<JobView> {
    const job = await this.find(auth, id);
    if (job.kind === 'parent') return this.retryParent(auth, job);
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new AppError('VALIDATION_FAILED', 'Only failed or cancelled jobs can be retried');
    }
    const [updated] = await this.db
      .update(jobs)
      .set({
        status: 'queued',
        stage: null,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        attempts: job.attempts + 1,
      })
      .where(and(eq(jobs.id, id), inArray(jobs.status, ['failed', 'cancelled'])))
      .returning();
    if (updated) {
      await this.queue(job.type).add(
        queueForType(job.type),
        { jobId: id },
        queueJobOptions(id, updated.attempts),
      );
    }
    return this.get(auth, id);
  }

  /** Re-queues only the failed items of a playlist or batch (SPEC §4). */
  private async retryParent(auth: AuthContext, parent: Job): Promise<JobView> {
    if (!['failed', 'completed_with_errors', 'cancelled'].includes(parent.status)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Only finished playlists or batches with failed items can be retried',
      );
    }
    const retried = await this.db
      .update(jobs)
      .set({
        status: 'queued',
        stage: 'waiting',
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(and(eq(jobs.parentJobId, parent.id), inArray(jobs.status, ['failed', 'cancelled'])))
      .returning({ id: jobs.id });
    if (retried.length === 0) throw new AppError('VALIDATION_FAILED', 'No failed items to retry');
    await this.db
      .update(jobs)
      .set({ status: 'running', stage: 'items', finishedAt: null, attempts: parent.attempts + 1 })
      .where(eq(jobs.id, parent.id));
    await this.coordinator.feed();
    return this.get(auth, parent.id);
  }

  async log(auth: AuthContext, id: string): Promise<{ lines: string[] }> {
    const job = await this.find(auth, id);
    const rows = await this.db
      .select({ line: jobLogs.line })
      .from(jobLogs)
      .where(eq(jobLogs.jobId, job.id))
      .orderBy(asc(jobLogs.seq));
    return { lines: rows.map((row) => row.line) };
  }

  /** The job, if it belongs to this client and user; NOT_FOUND otherwise (no existence leak). */
  async find(auth: AuthContext, id: string): Promise<Job> {
    const userId = requireUserId(auth);
    if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Job not found');
    const [job] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.clientId, auth.clientId), eq(jobs.userId, userId)));
    if (!job) throw new AppError('NOT_FOUND', 'Job not found');
    return job;
  }

  async view(job: Job): Promise<JobView> {
    const running = !TERMINAL_STATUSES.includes(job.status) && job.status !== 'queued';
    const parent = job.kind === 'parent';
    const finished = TERMINAL_STATUSES.includes(job.status);
    // A stopped recording keeps what it recorded (SPEC §9c: SIGINT so yt-dlp finalises the file).
    // A failed Drive upload keeps the local files as the fallback (SPEC §11).
    const delivered =
      job.status === 'completed' ||
      (job.type === 'record' && job.status === 'cancelled') ||
      (job.status === 'failed' && job.errorCode?.startsWith('DRIVE_') === true);
    const ownOutputs = !parent && delivered ? await this.jobOutputs(job) : [];
    const packaged = parent ? finished : ownOutputs.length > 1;
    const linkExpiry = new Date(Date.now() + this.config.FILE_TTL_DAYS * 86_400_000);
    const secret = this.config.LINK_SIGNING_SECRET;
    return {
      id: job.id,
      type: job.type,
      kind: job.kind,
      status: job.status,
      stage: job.stage,
      url: job.url,
      options: publicOptions(job.options),
      progress: running && !parent ? await readProgress(this.redis, job.id) : null,
      items: parent ? await this.coordinator.counts(job.id) : null,
      index: job.playlistIndex,
      error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
      attempts: job.attempts,
      created_at: job.createdAt.toISOString(),
      started_at: job.startedAt?.toISOString() ?? null,
      finished_at: job.finishedAt?.toISOString() ?? null,
      outputs: ownOutputs.map((output) => this.outputView(output)),
      archive_url: packaged
        ? `${this.config.PUBLIC_BASE_URL}${signedJobPath(secret, job.id, 'zip', linkExpiry)}`
        : null,
      manifest_url: packaged
        ? `${this.config.PUBLIC_BASE_URL}${signedJobPath(secret, job.id, 'm3u', linkExpiry)}`
        : null,
    };
  }

  outputView(output: Output): OutputView {
    return {
      drive:
        output.driveFileId === null
          ? null
          : {
              file_id: output.driveFileId,
              link: output.driveLink,
              folder_id: output.driveFolderId,
            },
      id: output.id,
      job_id: output.jobId,
      role: output.role,
      name: output.name,
      mime: output.mime,
      size_bytes: output.sizeBytes,
      duration_s: output.durationS,
      probe: output.probe,
      expires_at: output.expiresAt.toISOString(),
      url: `${this.config.PUBLIC_BASE_URL}${
        output.isDirectory && output.entry
          ? signedPackagePath(
              this.config.LINK_SIGNING_SECRET,
              output.id,
              output.expiresAt,
              output.entry,
            )
          : signedPath(this.config.LINK_SIGNING_SECRET, output.id, output.expiresAt)
      }`,
    };
  }
}
