import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { requireUserId } from '../auth/request-auth';
import { AppError } from '../common/errors';
import { isUuid } from '../common/ids';
import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { type Watch, type WatchRun, watchRuns, watches } from '../db/schema';
import { JobsService } from '../jobs/jobs.service';
import { storedOptions } from '../jobs/schemas';
import { requestedDestination, storedDestination } from '../drive/destination';

export const WATCHES_MAX = 100;

/** Download-job fields a watch does not take: it always expands newest first, up to WATCH_MAX_NEW_ITEMS. */
const NOT_FOR_WATCHES: Record<string, string> = {
  mode: 'a watch always expands its URL as a playlist',
  items: 'a watch takes the newest entries',
  reverse: 'a watch takes the newest entries',
  random: 'a watch takes the newest entries',
  max_items: 'a watch takes up to WATCH_MAX_NEW_ITEMS entries per run',
  skip_downloaded: 'a watch always skips entries in the archive',
  concat_items: 'a watch creates a batch per run',
  video_password: 'per-request secrets cannot be kept in a watch; use cookies',
  tv_provider: 'per-request secrets cannot be kept in a watch; use cookies',
};

const watchFields = {
  interval_minutes: z.number().int().min(1).max(10_080),
  break_on_existing: z.boolean(),
};
/** POST /v1/watches: url, interval, and the options of a download job (SPEC §4, §9f). */
export const watchCreateSchema = z
  .object({
    url: z.string(),
    interval_minutes: watchFields.interval_minutes,
    break_on_existing: watchFields.break_on_existing.default(true),
  })
  .catchall(z.unknown());
/** PATCH /v1/watches/:id: pause/resume, interval, or any option (the result is validated again). */
export const watchPatchSchema = z
  .object({
    status: z.enum(['active', 'paused']).optional(),
    interval_minutes: watchFields.interval_minutes.optional(),
    break_on_existing: watchFields.break_on_existing.optional(),
  })
  .catchall(z.unknown());
export const watchPage = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const encode = (value: string) => Buffer.from(value).toString('base64url');
const decode = (cursor: string | undefined) => {
  if (cursor === undefined) return undefined;
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!isUuid(value)) throw new AppError('VALIDATION_FAILED', 'The cursor is not valid');
  return value;
};

/** Options as stored: the download request without type, url and the `then` recipe. */
function requestOptions(request: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(storedOptions(request)).filter(([key]) => key !== 'then'),
  );
}

@Injectable()
export class WatchesService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
  ) {}

  async create(auth: AuthContext, body: z.output<typeof watchCreateSchema>) {
    const userId = requireUserId(auth);
    const { interval_minutes: interval, break_on_existing: breakOnExisting, ...rest } = body;
    this.checkInterval(interval);
    const request = await this.validate(auth, rest);
    const [existing] = await this.db
      .select({ n: count() })
      .from(watches)
      .where(this.ownedBy(auth.clientId, userId));
    if ((existing?.n ?? 0) >= WATCHES_MAX) {
      throw new AppError('VALIDATION_FAILED', `A user can keep at most ${WATCHES_MAX} watches`);
    }
    const [watch] = await this.db
      .insert(watches)
      .values({
        clientId: auth.clientId,
        userId,
        url: request.url,
        intervalMinutes: interval,
        options: { ...requestOptions(request), break_on_existing: breakOnExisting },
        recipe: request.then ?? null,
        destination: storedDestination(request.destination),
        // The first check runs on the next scheduler tick.
        nextRunAt: new Date(),
      })
      .returning();
    if (!watch) throw new Error('The watch was not saved');
    return this.view(watch);
  }

  async list(auth: AuthContext, page: z.output<typeof watchPage>) {
    const userId = requireUserId(auth);
    const before = decode(page.cursor);
    const rows = await this.db
      .select()
      .from(watches)
      .where(
        and(
          this.ownedBy(auth.clientId, userId),
          before === undefined ? undefined : lt(watches.id, before),
        ),
      )
      .orderBy(desc(watches.id))
      .limit(page.limit + 1);
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return {
      watches: shown.map((watch) => this.view(watch)),
      next_cursor: rows.length > page.limit && last ? encode(last.id) : null,
    };
  }

  async get(auth: AuthContext, id: string) {
    return this.view(await this.find(auth, id));
  }

  /** Pause, resume (clears failures and checks soon), change the interval or any option. */
  async update(auth: AuthContext, id: string, patch: z.output<typeof watchPatchSchema>) {
    const watch = await this.find(auth, id);
    const {
      status,
      interval_minutes: interval,
      break_on_existing: breakOnExisting,
      ...rest
    } = patch;
    const values: Partial<typeof watches.$inferInsert> = { updatedAt: new Date() };
    if (Object.keys(rest).length > 0) {
      const current = Object.fromEntries(
        Object.entries(watch.options).filter(
          ([key]) => key !== 'break_on_existing' && !(key in NOT_FOR_WATCHES),
        ),
      );
      const request = await this.validate(auth, {
        url: watch.url,
        ...current,
        ...(watch.recipe !== null && { then: watch.recipe }),
        ...(watch.destination !== null && { destination: requestedDestination(watch.destination) }),
        ...rest,
      });
      values.url = request.url;
      values.options = {
        ...requestOptions(request),
        break_on_existing: watch.options.break_on_existing,
      };
      values.recipe = request.then ?? null;
      values.destination = storedDestination(request.destination);
    }
    if (breakOnExisting !== undefined) {
      values.options = { ...(values.options ?? watch.options), break_on_existing: breakOnExisting };
    }
    if (interval !== undefined) {
      this.checkInterval(interval);
      values.intervalMinutes = interval;
      const base = watch.lastRunAt ?? watch.createdAt;
      values.nextRunAt = new Date(Math.max(Date.now(), base.getTime() + interval * 60_000));
    }
    if (status === 'paused') values.status = 'paused';
    if (status === 'active' && watch.status !== 'active') {
      Object.assign(values, {
        status: 'active',
        failures: 0,
        lastError: null,
        nextRunAt: new Date(),
      });
    }
    const [updated] = await this.db
      .update(watches)
      .set(values)
      .where(eq(watches.id, watch.id))
      .returning();
    if (!updated) throw new AppError('NOT_FOUND', 'Watch not found');
    return this.view(updated);
  }

  async remove(auth: AuthContext, id: string) {
    const watch = await this.find(auth, id);
    await this.db.delete(watches).where(eq(watches.id, watch.id));
    return { removed: 1 };
  }

  /** Past runs, newest first, with the batch job each created. */
  async runs(auth: AuthContext, id: string, page: z.output<typeof watchPage>) {
    const watch = await this.find(auth, id);
    const before = decode(page.cursor);
    const rows = await this.db
      .select()
      .from(watchRuns)
      .where(
        and(
          eq(watchRuns.watchId, watch.id),
          before === undefined ? undefined : lt(watchRuns.id, before),
        ),
      )
      .orderBy(desc(watchRuns.id))
      .limit(page.limit + 1);
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return {
      runs: shown.map(runView),
      next_cursor: rows.length > page.limit && last ? encode(last.id) : null,
    };
  }

  /** The checks of a download job, plus the fields watches do not take. */
  private async validate(auth: AuthContext, fields: Record<string, unknown>) {
    for (const [field, reason] of Object.entries(NOT_FOR_WATCHES)) {
      if (fields[field] !== undefined)
        throw new AppError('VALIDATION_FAILED', `${field} is not used by watches: ${reason}`);
    }
    return this.jobs.validateDownload(auth, { ...fields, mode: 'playlist' });
  }

  private checkInterval(minutes: number): void {
    if (minutes < this.config.WATCH_MIN_INTERVAL_MINUTES) {
      throw new AppError(
        'VALIDATION_FAILED',
        `interval_minutes must be at least ${this.config.WATCH_MIN_INTERVAL_MINUTES}`,
      );
    }
  }

  private async find(auth: AuthContext, id: string): Promise<Watch> {
    const userId = requireUserId(auth);
    if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Watch not found');
    const [watch] = await this.db
      .select()
      .from(watches)
      .where(and(eq(watches.id, id), this.ownedBy(auth.clientId, userId)));
    if (!watch) throw new AppError('NOT_FOUND', 'Watch not found');
    return watch;
  }

  private ownedBy(clientId: string, userId: string) {
    return and(eq(watches.clientId, clientId), eq(watches.userId, userId));
  }

  private view(watch: Watch) {
    return {
      id: watch.id,
      url: watch.url,
      interval_minutes: watch.intervalMinutes,
      status: watch.status,
      failures: watch.failures,
      last_error: watch.lastError,
      last_run_at: watch.lastRunAt?.toISOString() ?? null,
      next_run_at: watch.status === 'active' ? watch.nextRunAt.toISOString() : null,
      options: watch.options,
      then: watch.recipe,
      destination: requestedDestination(watch.destination) ?? 'link',
      created_at: watch.createdAt.toISOString(),
      updated_at: watch.updatedAt.toISOString(),
    };
  }
}

function runView(run: WatchRun) {
  return {
    id: run.id,
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt?.toISOString() ?? null,
    new_items: run.newItems,
    job_id: run.jobId,
    error: run.error,
  };
}
