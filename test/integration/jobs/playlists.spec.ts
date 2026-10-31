import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { execa } from 'execa';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import type { JobView, OutputView } from '../../../src/jobs/jobs.service';
import { poolFor, startPostgres, startRedis } from '../support/containers';
import { ensureFakeMedia, fakeCalls, type JobStack, startJobStack } from '../support/jobs';

interface ErrorBody {
  error: { code: string; message: string };
}

const PLAYLIST = 'https://fake.test/playlist';

describe('playlists, batches, archive, ZIP and comment jobs (fake yt-dlp, Postgres + Redis)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let stack: JobStack;
  let auth: Record<string, string>;
  let user = 0;
  /** Each test gets a fresh end user, so archives and quotas do not leak between tests. */
  const nextUser = () => ({ 'x-user-id': `user-${++user}` });

  beforeAll(async () => {
    await ensureFakeMedia();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const { key } = await new ApiKeyService(createDatabase(pool)).create({
      clientName: 'playlists',
    });
    auth = { authorization: `Bearer ${key}` };
    stack = await startJobStack(
      { DATABASE_URL: postgres.getConnectionUri(), REDIS_URL: redis.getConnectionUrl() },
      auth,
    );
  });

  afterAll(async () => {
    await stack.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  const as = (headers: Record<string, string>) => ({
    create: (payload: object) => stack.create(payload, headers),
    get: (url: string) =>
      stack.app.inject({ method: 'GET', url, headers: { ...auth, ...headers } }),
    del: (url: string) =>
      stack.app.inject({ method: 'DELETE', url, headers: { ...auth, ...headers } }),
    post: (url: string, payload: object = {}) =>
      stack.app.inject({ method: 'POST', url, headers: { ...auth, ...headers }, payload }),
  });

  async function run(headers: Record<string, string>, payload: object, timeoutMs = 60_000) {
    const client = as(headers);
    const created = await client.create(payload);
    expect(created.statusCode, created.body).toBe(202);
    const id = created.json<JobView>().id;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = (await client.get(`/v1/jobs/${id}`)).json<JobView>();
      if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(job.status))
        return { job, client };
      if (Date.now() > deadline)
        throw new Error(`job ${id} stuck in ${job.status}/${String(job.stage)}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async function items(client: ReturnType<typeof as>, id: string, query = 'limit=200') {
    return (await client.get(`/v1/jobs/${id}/items?${query}`)).json<{
      items: JobView[];
      next_cursor: string | null;
    }>();
  }

  describe('a whole playlist', () => {
    const headers = nextUser();
    let job: JobView;
    let maxActive = 0;

    beforeAll(async () => {
      const client = as(headers);
      const { id } = (await client.create({ type: 'download', url: PLAYLIST })).json<JobView>();
      for (;;) {
        const current = (await client.get(`/v1/jobs/${id}`)).json<JobView>();
        if (current.items) maxActive = Math.max(maxActive, current.items.running);
        if (['completed', 'completed_with_errors', 'failed'].includes(current.status)) {
          job = current;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    });

    it('becomes a parent and completes every item', () => {
      expect(job).toMatchObject({
        kind: 'parent',
        status: 'completed',
        items: { total: 10, completed: 10, failed: 0 },
      });
    });

    it('never runs more than USER_MAX_CONCURRENT_ITEMS items at once for the user', () => {
      expect(maxActive).toBeLessThanOrEqual(2);
    });

    it('lists its items in playlist order, paged', async () => {
      const client = as(headers);
      const page = await items(client, job.id, 'limit=4');
      expect(page.items.map((item) => item.index)).toEqual([1, 2, 3, 4]);
      const next = await items(client, job.id, `limit=4&cursor=${page.next_cursor ?? ''}`);
      expect(next.items.map((item) => item.index)).toEqual([5, 6, 7, 8]);
      expect(page.items.every((item) => item.status === 'completed' && item.kind === 'item')).toBe(
        true,
      );
    });

    it('aggregates every item output, in order', async () => {
      const { outputs } = (await as(headers).get(`/v1/jobs/${job.id}/outputs`)).json<{
        outputs: OutputView[];
      }>();
      expect(outputs.map((output) => output.name)).toEqual(
        Array.from({ length: 10 }, (_, i) => `Video ${i + 1} [vid${i + 1}].mp4`),
      );
    });

    it('keeps items out of the main job list', async () => {
      const { jobs } = (await as(headers).get('/v1/jobs')).json<{ jobs: JobView[] }>();
      expect(jobs.map((entry) => entry.id)).toEqual([job.id]);
    });

    it('streams a store-only ZIP of all outputs through one signed link', async () => {
      expect(job.archive_url).not.toBeNull();
      const link = new URL(job.archive_url ?? '');
      const response = await stack.app.inject({
        method: 'GET',
        url: `${link.pathname}${link.search}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/zip');
      const file = path.join(mkdtempSync(path.join(tmpdir(), 'zip-')), 'job.zip');
      writeFileSync(file, response.rawPayload);
      const listing = (await execa('unzip', ['-v', file])).stdout;
      expect(listing).toContain('001 - Video 1 [vid1].mp4');
      expect(listing).toContain('010 - Video 10 [vid10].mp4');
      expect(listing).toMatch(/Stored/);
      expect((await execa('unzip', ['-t', file])).stdout).toContain('No errors detected');
    });

    it('serves an M3U playlist with a signed link per media file', async () => {
      const link = new URL(job.manifest_url ?? '');
      const response = await stack.app.inject({
        method: 'GET',
        url: `${link.pathname}${link.search}`,
      });
      expect(
        response.body.startsWith('#EXTM3U\n#EXTINF:2,Video 1 [vid1].mp4\nhttp://localhost:3000/d/'),
      ).toBe(true);
      expect(response.body.match(/\/d\/[0-9a-f-]{36}\?exp=\d+&sig=/g)).toHaveLength(10);
    });

    it('refuses job package links with a bad signature', async () => {
      const link = new URL(job.archive_url ?? '');
      const response = await stack.app.inject({
        method: 'GET',
        url: `${link.pathname}?exp=${link.searchParams.get('exp') ?? ''}&sig=nope`,
      });
      expect(response.statusCode).toBe(404);
    });

    it('records every download in the archive, so skip_downloaded skips them next time', async () => {
      const archive = (await as(headers).get('/v1/archive?limit=100')).json<{
        entries: { media_id: string }[];
      }>();
      expect(archive.entries.map((entry) => entry.media_id).sort()).toEqual(
        Array.from({ length: 10 }, (_, i) => `vid${i + 1}`).sort(),
      );
      const { job: again } = await run(headers, {
        type: 'download',
        url: PLAYLIST,
        skip_downloaded: true,
      });
      expect(again).toMatchObject({ status: 'completed', items: { total: 0 } });
    });

    it('lets the user remove an archive entry, which is then downloaded again', async () => {
      const client = as(headers);
      expect((await client.del('/v1/archive/Youtube:vid3')).json()).toEqual({ removed: 1 });
      expect((await client.del('/v1/archive/Youtube:vid3')).statusCode).toBe(404);
      const { job: again } = await run(headers, {
        type: 'download',
        url: PLAYLIST,
        skip_downloaded: true,
      });
      expect(again.items).toMatchObject({ total: 1, completed: 1 });
    });

    it('reuses the cached expansion within PLAYLIST_CACHE_TTL_MINUTES', async () => {
      const before = fakeCalls(`expand ${PLAYLIST}`);
      await run(nextUser(), { type: 'download', url: PLAYLIST });
      expect(fakeCalls(`expand ${PLAYLIST}`)).toBe(before);
    });
  });

  describe('selection, order, filters and limits', () => {
    const indices = async (payload: object) => {
      const headers = nextUser();
      const { job, client } = await run(headers, { type: 'download', url: PLAYLIST, ...payload });
      return {
        job,
        indices: (await items(client, job.id)).items.map((item) => item.index),
        items: (await items(client, job.id)).items,
      };
    };

    it('takes an items selection', async () => {
      expect((await indices({ items: '2-3,9' })).indices).toEqual([2, 3, 9]);
    });

    it('applies max_items, and reverse changes the download order (not the indices)', async () => {
      const result = await indices({ max_items: 3, reverse: true });
      expect(result.items.map((item) => item.index)).toEqual([1, 2, 3]);
      // Items are released in creation order (time-ordered ids, item-feeder.spec.ts); their start
      // times would race between the user's concurrent slots.
      const byCreation = [...result.items].sort((a, b) => a.id.localeCompare(b.id));
      expect(byCreation.map((item) => item.index)).toEqual([3, 2, 1]);
    });

    it('filters on metadata from the expansion', async () => {
      expect((await indices({ filters: { min_duration: 300 } })).indices).toEqual([
        5, 6, 7, 8, 9, 10,
      ]);
      expect((await indices({ filters: { title_contains: ['video 1'] } })).indices).toEqual([
        1, 10,
      ]);
    });

    it('skips items outside the date range once their full metadata is known', async () => {
      const { job, items: list } = await indices({ date_after: '20261005' });
      expect(job).toMatchObject({
        status: 'completed',
        items: { total: 10, skipped: 4, completed: 6 },
      });
      expect(list.filter((item) => item.status === 'skipped').map((item) => item.index)).toEqual([
        1, 2, 3, 4,
      ]);
    });

    it('fails the parent when a single-mode request points at a playlist', async () => {
      const { job } = await run(nextUser(), { type: 'download', url: PLAYLIST, mode: 'single' });
      expect(job.error?.code).toBe('VALIDATION_FAILED');
    });

    it('validates the selection and max_items when the job is created', async () => {
      for (const payload of [
        { items: '0' },
        { items: '3-1' },
        { max_items: 999_999 },
        { channel_tab: 'playlists' },
        { concat_items: 'yes' },
      ]) {
        const response = await as(nextUser()).create({
          type: 'download',
          url: PLAYLIST,
          ...payload,
        });
        expect([400, 501]).toContain(response.statusCode);
      }
    });
  });

  describe('batches', () => {
    it('runs one item per URL and ends completed_with_errors when some fail', async () => {
      const headers = nextUser();
      const { job, client } = await run(headers, {
        type: 'batch',
        items: [
          { url: 'https://fake.test/item/vid2' },
          { url: 'https://fake.test/item/vid4', preset: '360p' },
          { url: 'https://fake.test/privatedl' },
        ],
      });
      expect(job).toMatchObject({
        type: 'batch',
        kind: 'parent',
        status: 'completed_with_errors',
        items: { total: 3, completed: 2, failed: 1 },
      });
      const failed = (await items(client, job.id, 'status=failed')).items;
      expect(failed.map((item) => [item.index, item.error?.code])).toEqual([[3, 'MEDIA_PRIVATE']]);
    });

    it('fails when every item fails, and retries only the failed items', async () => {
      const headers = nextUser();
      const { job, client } = await run(headers, {
        type: 'batch',
        items: [{ url: 'https://fake.test/privatedl' }],
      });
      expect(job.status).toBe('failed');
      const retried = await client.post(`/v1/jobs/${job.id}/retry`);
      expect(retried.statusCode).toBe(202);
      expect(retried.json<JobView>().status).toBe('running');
      const deadline = Date.now() + 20_000;
      let after: JobView;
      do {
        await new Promise((resolve) => setTimeout(resolve, 150));
        after = (await client.get(`/v1/jobs/${job.id}`)).json<JobView>();
      } while (after.status === 'running' && Date.now() < deadline);
      expect(after).toMatchObject({ status: 'failed', attempts: 1 });
    });

    it('cancels pending and running items with the parent', async () => {
      const headers = nextUser();
      const client = as(headers);
      const { id } = (
        await client.create({
          type: 'batch',
          items: Array.from({ length: 3 }, () => ({ url: 'https://fake.test/slowdl' })),
        })
      ).json<JobView>();
      await stack.waitFor(id, (job) => (job.items?.running ?? 0) > 0).catch(() => undefined);
      const cancelled = (await client.del(`/v1/jobs/${id}`)).json<JobView>();
      expect(cancelled.status).toBe('cancelled');
      const deadline = Date.now() + 20_000;
      let list: JobView[];
      do {
        await new Promise((resolve) => setTimeout(resolve, 200));
        list = (await items(client, id)).items;
      } while (list.some((item) => item.status !== 'cancelled') && Date.now() < deadline);
      expect(list.map((item) => item.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
      expect((await client.get(`/v1/jobs/${id}`)).json<JobView>().status).toBe('cancelled');
    });

    it('refuses batches over BATCH_MAX_URLS', async () => {
      const response = await as(nextUser()).create({
        type: 'batch',
        items: Array.from({ length: 51 }, () => ({ url: 'https://fake.test/video' })),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json<ErrorBody>().error.code).toBe('BATCH_TOO_LARGE');
    });
  });

  describe('comment exports', () => {
    it('writes the comments to a JSON output', async () => {
      const { job } = await run(nextUser(), {
        type: 'comments',
        url: 'https://fake.test/video',
        max: 3,
      });
      expect(job.status).toBe('completed');
      const [output] = job.outputs;
      expect(output).toMatchObject({
        role: 'comments',
        mime: 'application/json',
        name: 'jNQXAC9IVRw.comments.json',
      });
      const document = JSON.parse(
        (
          await execa('cat', [
            path.join(stack.filesDir, job.id, output?.id ?? '', output?.name ?? ''),
          ])
        ).stdout,
      ) as { comments: unknown[] };
      expect(document.comments).toHaveLength(3);
    });
  });

  describe('caps', () => {
    it('fails playlists over PLAYLIST_MAX_ITEMS unless narrowed', async () => {
      const headers = nextUser();
      const capped = await startJobStack(
        {
          DATABASE_URL: postgres.getConnectionUri(),
          REDIS_URL: `${redis.getConnectionUrl()}/4`,
          PLAYLIST_MAX_ITEMS: '5',
        },
        { ...auth, ...headers },
      );
      try {
        const tooLarge = (
          await capped.create({ type: 'download', url: PLAYLIST }, headers)
        ).json<JobView>();
        const failed = await capped.waitFor(tooLarge.id);
        expect(failed.error?.code).toBe('PLAYLIST_TOO_LARGE');
        const narrowed = (
          await capped.create({ type: 'download', url: PLAYLIST, max_items: 2 }, headers)
        ).json<JobView>();
        expect((await capped.waitFor(narrowed.id)).items?.total).toBe(2);
      } finally {
        await capped.close();
      }
    });
  });
});
