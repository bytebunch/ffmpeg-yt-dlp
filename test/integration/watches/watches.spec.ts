import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import type { JobView } from '../../../src/jobs/jobs.service';
import { WatchRunner } from '../../../src/watches/watch-runner';
import { WatchProcessor } from '../../../src/watches/watch.processor';
import { poolFor, startPostgres, startRedis } from '../support/containers';
import { ensureFakeMedia, FINISHED, type JobStack, startJobStack } from '../support/jobs';

/** Watches (SPEC §9f): REST, the runner with the fake yt-dlp's 10-entry playlist, pausing. */

const PLAYLIST = 'https://fake.test/playlist';

interface WatchView {
  id: string;
  status: string;
  failures: number;
  last_error: string | null;
  next_run_at: string | null;
  options: Record<string, unknown>;
  then: unknown;
}
interface RunView {
  new_items: number;
  job_id: string | null;
  error: string | null;
}

describe('watches (Postgres + Redis + workers)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let stack: JobStack;
  const auth: Record<string, string> = {};
  const as = (user: string) => ({ ...auth, 'x-user-id': user });

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    user = 'alice',
    payload?: object,
  ) => stack.app.inject({ method, url, headers: as(user), ...(payload && { payload }) });
  const create = async (payload: object, user = 'alice') => {
    const response = await request('POST', '/v1/watches', user, payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<WatchView>();
  };
  const runs = async (id: string, user = 'alice') =>
    (await request('GET', `/v1/watches/${id}/runs`, user)).json<{ runs: RunView[] }>().runs;
  /** Makes a watch due and runs the scheduler once (a second back: now() has microseconds, Date not). */
  const tick = async (id: string) => {
    await pool.query("UPDATE watches SET next_run_at = now() - interval '1 second' WHERE id = $1", [
      id,
    ]);
    return stack.worker.get(WatchRunner).tick();
  };
  const waitAs = async (id: string, user: string): Promise<JobView> => {
    for (let i = 0; i < 200; i++) {
      const view = (await request('GET', `/v1/jobs/${id}`, user)).json<JobView>();
      if (FINISHED.includes(view.status)) return view;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`job ${id} did not finish`);
  };
  const items = async (parentId: string) =>
    (
      await pool.query<{ url: string; options: Record<string, unknown> }>(
        'SELECT url, options FROM jobs WHERE parent_job_id = $1 ORDER BY playlist_index',
        [parentId],
      )
    ).rows;

  beforeAll(async () => {
    await ensureFakeMedia();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const created = await new ApiKeyService(createDatabase(pool)).create({
      clientName: 'watchers',
    });
    Object.assign(auth, { authorization: `Bearer ${created.key}`, 'x-user-id': 'alice' });
    stack = await startJobStack(
      {
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        WATCH_MAX_NEW_ITEMS: '3',
        WATCH_MAX_FAILURES: '2',
      },
      auth,
    );
    // The test runs the scheduler itself: this stack's watch worker processes no ticks.
    await stack.worker.get(WatchProcessor).worker.close();
  });

  afterAll(async () => {
    await stack.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('queues the newest entries as one batch, then nothing until something new appears', async () => {
    const watch = await create({ url: PLAYLIST, interval_minutes: 60, preset: '360p' });
    expect(watch).toMatchObject({
      status: 'active',
      failures: 0,
      options: { preset: '360p', break_on_existing: true },
    });
    expect(await tick(watch.id)).toBe(1);
    const [first] = await runs(watch.id);
    expect(first).toMatchObject({ new_items: 3, error: null });
    const batch = await waitAs(first?.job_id ?? '', 'alice');
    expect(batch).toMatchObject({
      type: 'batch',
      status: 'completed',
      items: { total: 3, completed: 3 },
    });
    expect(batch.options).toMatchObject({ watch_id: watch.id });
    expect((await items(batch.id)).map((item) => item.url)).toEqual(
      [1, 2, 3].map((n) => `https://fake.test/item/vid${n}`),
    );

    // Everything is in the archive now: the newest entry is known, so the run stops there.
    expect(await tick(watch.id)).toBe(1);
    expect((await runs(watch.id))[0]).toMatchObject({ new_items: 0, job_id: null });
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM jobs WHERE type = 'batch'",
    );
    expect(rows[0]?.n).toBe('1');
    const view = (await request('GET', `/v1/watches/${watch.id}`)).json<WatchView>();
    expect(Date.parse(view.next_run_at ?? '')).toBeGreaterThan(Date.now() + 59 * 60_000);
  });

  it('never queues an entry twice while its first download is still waiting', async () => {
    const watch = await create({ url: PLAYLIST, interval_minutes: 30 }, 'bob');
    await tick(watch.id);
    await tick(watch.id);
    const [second, first] = await runs(watch.id, 'bob');
    expect(first?.new_items).toBe(3);
    expect(second).toMatchObject({ new_items: 0, job_id: null });
    await waitAs(first?.job_id ?? '', 'bob');
  });

  it('stops at the first known entry, or skips known entries with break_on_existing false', async () => {
    // Two users with vid2 downloaded; one watch each, so neither sees the other's downloads.
    for (const user of ['carol', 'cora']) {
      const single = await stack.create(
        { type: 'download', url: 'https://fake.test/item/vid2' },
        { 'x-user-id': user },
      );
      await waitAs(single.json<JobView>().id, user);
    }
    const breaking = await create({ url: PLAYLIST, interval_minutes: 30 }, 'carol');
    const skipping = await create(
      { url: PLAYLIST, interval_minutes: 30, break_on_existing: false },
      'cora',
    );
    // New watches are due at once: one scheduler pass runs both.
    expect(await tick(breaking.id)).toBe(2);
    const [breakRun] = await runs(breaking.id, 'carol');
    const [skipRun] = await runs(skipping.id, 'cora');
    expect(breakRun?.job_id, JSON.stringify(breakRun)).toEqual(expect.any(String));
    expect(skipRun?.job_id, JSON.stringify(skipRun)).toEqual(expect.any(String));
    expect((await items(breakRun?.job_id ?? '')).map((item) => item.url)).toEqual([
      'https://fake.test/item/vid1',
    ]);
    expect((await items(skipRun?.job_id ?? '')).map((item) => item.url)).toEqual([
      'https://fake.test/item/vid1',
      'https://fake.test/item/vid3',
    ]);
    await waitAs(breakRun?.job_id ?? '', 'carol');
    await waitAs(skipRun?.job_id ?? '', 'cora');
  });

  it('hands download options, filters and the then recipe to every item', async () => {
    const watch = await create(
      {
        url: PLAYLIST,
        interval_minutes: 30,
        preset: '720p',
        filters: { max_duration: 150 },
        then: 'audio_mp3_192',
      },
      'dave',
    );
    expect(watch.then).toMatchObject({ steps: [expect.objectContaining({ op: 'encode' })] });
    await tick(watch.id);
    const [run] = await runs(watch.id, 'dave');
    const rows = await items(run?.job_id ?? '');
    // Durations are 60 s × position; the filter keeps vid1 and vid2.
    expect(rows.map((item) => item.url)).toEqual([
      'https://fake.test/item/vid1',
      'https://fake.test/item/vid2',
    ]);
    expect(rows[0]?.options).toMatchObject({
      preset: '720p',
      mode: 'single',
      then: { steps: expect.any(Array) as unknown[] },
    });
    const batch = await waitAs(run?.job_id ?? '', 'dave');
    expect(batch.status).toBe('completed');
  });

  it('pauses after WATCH_MAX_FAILURES failed runs and resumes with PATCH', async () => {
    const watch = await create({ url: 'https://fake.test/private', interval_minutes: 30 }, 'erin');
    await tick(watch.id);
    expect((await request('GET', `/v1/watches/${watch.id}`, 'erin')).json()).toMatchObject({
      status: 'active',
      failures: 1,
    });
    await tick(watch.id);
    const paused = (await request('GET', `/v1/watches/${watch.id}`, 'erin')).json<WatchView>();
    expect(paused).toMatchObject({
      status: 'paused',
      failures: 2,
      next_run_at: null,
      last_error: expect.stringMatching(/Private video/) as string,
    });
    // A paused watch is not claimed.
    expect(await tick(watch.id)).toBe(0);
    expect((await runs(watch.id, 'erin')).map((run) => run.error)).toEqual([
      expect.stringMatching(/Private video/) as string,
      expect.stringMatching(/Private video/) as string,
    ]);
    const resumed = (
      await request('PATCH', `/v1/watches/${watch.id}`, 'erin', { status: 'active' })
    ).json<WatchView>();
    expect(resumed).toMatchObject({ status: 'active', failures: 0, last_error: null });

    const single = await create({ url: 'https://fake.test/video', interval_minutes: 30 }, 'erin');
    await tick(single.id);
    expect((await runs(single.id, 'erin'))[0]?.error).toMatch(/channel or playlist URL/);
  });

  it('edits options with full validation and keeps watches per user', async () => {
    const watch = await create({ url: PLAYLIST, interval_minutes: 30 }, 'frank');
    const edited = await request('PATCH', `/v1/watches/${watch.id}`, 'frank', {
      preset: '480p',
      interval_minutes: 90,
    });
    expect(edited.json()).toMatchObject({ options: { preset: '480p' } });
    expect(
      (await request('PATCH', `/v1/watches/${watch.id}`, 'frank', { preset: 'nope' })).statusCode,
    ).toBe(400);
    expect(
      (await request('PATCH', `/v1/watches/${watch.id}`, 'frank', { max_items: 5 })).statusCode,
    ).toBe(400);
    expect((await request('GET', `/v1/watches/${watch.id}`, 'grace')).statusCode).toBe(404);
    expect((await request('DELETE', `/v1/watches/${watch.id}`, 'grace')).statusCode).toBe(404);
    expect(
      (await request('GET', '/v1/watches', 'frank')).json<{ watches: unknown[] }>().watches,
    ).toHaveLength(1);
    expect((await request('DELETE', `/v1/watches/${watch.id}`, 'frank')).json()).toEqual({
      removed: 1,
    });
    expect((await request('GET', `/v1/watches/${watch.id}/runs`, 'frank')).statusCode).toBe(404);
  });

  it('validates watches like download jobs, plus the fields watches do not take', async () => {
    const refusal = async (payload: object) => {
      const response = await request('POST', '/v1/watches', 'alice', {
        url: PLAYLIST,
        interval_minutes: 30,
        ...payload,
      });
      return {
        status: response.statusCode,
        error: response.json<{ error: { code: string; message: string } }>().error,
      };
    };
    expect(await refusal({ interval_minutes: 5 })).toMatchObject({
      status: 400,
      error: { message: 'interval_minutes must be at least 30' },
    });
    expect(await refusal({ max_items: 3 })).toMatchObject({
      status: 400,
      error: { message: expect.stringMatching(/max_items is not used by watches/) as string },
    });
    expect(await refusal({ video_password: 'x' })).toMatchObject({
      status: 400,
      error: { message: expect.stringMatching(/use cookies/) as string },
    });
    expect(await refusal({ preset: 'nope' })).toMatchObject({
      status: 400,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await refusal({ then: { steps: [{ op: 'explode' }] } })).toMatchObject({
      status: 400,
      error: { code: 'RECIPE_INVALID' },
    });
    expect(await refusal({ cookies: true })).toMatchObject({
      status: 400,
      error: { message: expect.stringMatching(/no cookie jar/) as string },
    });
    expect(await refusal({ url: 'http://127.0.0.1/admin' })).toMatchObject({
      status: 400,
      error: { code: 'URL_NOT_ALLOWED' },
    });
    expect(await refusal({ destination: { type: 'google_drive' } })).toMatchObject({ status: 501 });
  });
});
