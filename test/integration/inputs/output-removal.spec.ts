import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { eq, inArray } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { uuidv7 } from '../../../src/common/ids';
import { createDatabase, type Database } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import { clients, jobs, mediaFiles, outputs } from '../../../src/db/schema';
import type { JobView, OutputView } from '../../../src/jobs/jobs.service';
import type { Removal } from '../../../src/outputs/output-removal';
import { poolFor, startPostgres, startRedis } from '../support/containers';
import {
  ensureFakeMedia,
  fakeCalls,
  FINISHED,
  type JobStack,
  startJobStack,
} from '../support/jobs';

interface ErrorBody {
  error: { code: string; message: string };
}

const VIDEO = 'https://fake.test/video';
/** What the fake yt-dlp logs when it downloads VIDEO. */
const DOWNLOADED = 'download jNQXAC9IVRw';
const day = 86_400_000;

/** The item at `index`, which the test has just made. */
function nth<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`no item ${String(index)}`);
  return value;
}

describe('deleting files on request (Postgres + Redis + workers)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let db: Database;
  let stack: JobStack;
  let clientId: string;
  const alice: Record<string, string> = {};

  beforeAll(async () => {
    await ensureFakeMedia();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    db = createDatabase(pool);
    const { key } = await new ApiKeyService(db).create({ clientName: 'removal' });
    const [client] = await db.select().from(clients).where(eq(clients.name, 'removal'));
    if (!client) throw new Error('the API key has no client');
    clientId = client.id;
    Object.assign(alice, { authorization: `Bearer ${key}`, 'x-user-id': 'alice' });
    stack = await startJobStack(
      { DATABASE_URL: postgres.getConnectionUri(), REDIS_URL: redis.getConnectionUrl() },
      alice,
    );
  });

  afterAll(async () => {
    await stack.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  const as = (user: string) => ({ ...alice, 'x-user-id': user });
  const request = (method: 'GET' | 'DELETE', url: string, user = 'alice') =>
    stack.app.inject({ method, url, headers: as(user) });
  /** stack.waitFor polls as alice; a job is only visible to its own user. */
  const finished = async (id: string, user: string): Promise<JobView> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const job = (await request('GET', `/v1/jobs/${id}`, user)).json<JobView>();
      if (FINISHED.includes(job.status)) return job;
      if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.status}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const download = async (payload: object, user = 'alice'): Promise<JobView> => {
    const created = await stack.create({ type: 'download', ...payload }, as(user));
    const job = await finished(created.json<JobView>().id, user);
    expect(job.status).toBe('completed');
    return job;
  };
  const media = (job: JobView): OutputView => {
    const found = job.outputs.find((output) => output.role === 'media');
    if (!found) throw new Error(`job ${job.id} has no media output`);
    return found;
  };
  const diskPath = async (outputId: string) => {
    const [row] = await db.select().from(outputs).where(eq(outputs.id, outputId));
    if (!row) throw new Error(`no output ${outputId}`);
    return path.join(stack.filesDir, row.path);
  };
  /** The signed download link, as nginx's upstream sees it. */
  const link = (output: OutputView) => {
    const url = new URL(output.url);
    return stack.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
  };
  const listed = async (user = 'alice') =>
    (await request('GET', '/v1/outputs', user))
      .json<{ outputs: OutputView[] }>()
      .outputs.map((output) => output.id);

  describe('DELETE /v1/outputs/:id', () => {
    let job: JobView;
    let file: OutputView;

    beforeAll(async () => {
      job = await download({ url: VIDEO, thumbnail: { write: true } });
      file = media(job);
    });

    it("refuses another user's file and leaves it alone", async () => {
      const refused = await request('DELETE', `/v1/outputs/${file.id}`, 'bob');
      expect(refused.statusCode).toBe(404);
      expect(refused.json<ErrorBody>().error.code).toBe('NOT_FOUND');
      expect(existsSync(await diskPath(file.id))).toBe(true);
    });

    it('deletes the file, its row and its link, and keeps the rest of the job', async () => {
      const onDisk = await diskPath(file.id);
      expect((await link(file)).statusCode).toBe(200);

      const deleted = await request('DELETE', `/v1/outputs/${file.id}`);
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json<Removal>()).toEqual({ deleted: 1, freed_bytes: file.size_bytes });

      expect(existsSync(onDisk)).toBe(false);
      expect(await listed()).not.toContain(file.id);
      expect((await link(file)).statusCode).toBe(404);
      const rest = job.outputs.filter((output) => output.id !== file.id);
      expect(rest.length).toBeGreaterThan(0);
      for (const output of rest) expect(existsSync(await diskPath(output.id))).toBe(true);
    });

    it('answers 404 the second time, and for ids that are not ids', async () => {
      expect((await request('DELETE', `/v1/outputs/${file.id}`)).statusCode).toBe(404);
      expect((await request('DELETE', '/v1/outputs/not-a-uuid')).statusCode).toBe(404);
    });

    it('downloads anew next time instead of reusing a job whose media is gone', async () => {
      const before = fakeCalls(DOWNLOADED);
      const again = await download({ url: VIDEO, thumbnail: { write: true } });
      expect(fakeCalls(DOWNLOADED)).toBe(before + 1);
      expect(existsSync(await diskPath(media(again).id))).toBe(true);
    });
  });

  it("keeps a file another user's job shares until the last one is deleted", async () => {
    // container mkv: its own dedup key, apart from the tests above.
    const payload = { url: VIDEO, container: 'mkv' };
    const before = fakeCalls(DOWNLOADED);
    const mine = media(await download(payload));
    const theirs = media(await download(payload, 'bob'));
    expect(fakeCalls(DOWNLOADED)).toBe(before + 1);
    const shared = await diskPath(mine.id);
    expect(await diskPath(theirs.id)).toBe(shared);

    const first = await request('DELETE', `/v1/outputs/${mine.id}`);
    expect(first.json<Removal>()).toEqual({ deleted: 1, freed_bytes: 0 });
    expect(existsSync(shared)).toBe(true);
    expect((await link(theirs)).statusCode).toBe(200);

    const last = await request('DELETE', `/v1/outputs/${theirs.id}`, 'bob');
    expect(last.json<Removal>()).toEqual({ deleted: 1, freed_bytes: theirs.size_bytes });
    expect(existsSync(shared)).toBe(false);
  });

  it("DELETE /v1/jobs/:id/outputs deletes every item's files of a playlist", async () => {
    const created = await stack.create({
      type: 'download',
      url: 'https://fake.test/playlist',
      max_items: 2,
    });
    const parent = await stack.waitFor(created.json<JobView>().id);
    expect(parent.status).toBe('completed');
    const files = (await request('GET', `/v1/jobs/${parent.id}/outputs`)).json<{
      outputs: OutputView[];
    }>().outputs;
    expect(files.length).toBeGreaterThanOrEqual(2);
    const paths = await Promise.all(files.map((output) => diskPath(output.id)));

    expect((await request('DELETE', `/v1/jobs/${parent.id}/outputs`, 'bob')).statusCode).toBe(404);
    const deleted = await request('DELETE', `/v1/jobs/${parent.id}/outputs`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<Removal>().deleted).toBe(files.length);

    expect(
      (await request('GET', `/v1/jobs/${parent.id}/outputs`)).json<{ outputs: unknown[] }>()
        .outputs,
    ).toEqual([]);
    for (const onDisk of paths) expect(existsSync(onDisk)).toBe(false);
    // Nothing left: a second delete is a no-op, not an error.
    expect((await request('DELETE', `/v1/jobs/${parent.id}/outputs`)).json<Removal>()).toEqual({
      deleted: 0,
      freed_bytes: 0,
    });
  });

  describe('rows written directly', () => {
    /** A job of alice's with outputs whose files exist on disk. */
    const seed = async (
      status: string,
      files: { name: string; hidden?: boolean; bytes?: number }[],
      parentJobId: string | null = null,
    ) => {
      const jobId = uuidv7();
      await db.insert(jobs).values({
        id: jobId,
        type: 'download',
        kind: 'single',
        clientId,
        userId: 'alice',
        status,
        parentJobId,
      });
      const rows = files.map((file) => {
        const id = uuidv7();
        const relative = `${jobId}/${id}/${file.name}`;
        mkdirSync(path.join(stack.filesDir, jobId, id), { recursive: true });
        writeFileSync(path.join(stack.filesDir, relative), 'x'.repeat(file.bytes ?? 10));
        return {
          id,
          jobId,
          clientId,
          userId: 'alice',
          role: 'media',
          name: file.name,
          path: relative,
          sizeBytes: file.bytes ?? 10,
          hidden: file.hidden ?? false,
          expiresAt: new Date(Date.now() + day),
        };
      });
      if (rows.length > 0) await db.insert(outputs).values(rows);
      return { jobId, ids: rows.map((row) => row.id), paths: rows.map((row) => row.path) };
    };
    const exists = (relative: string) => existsSync(path.join(stack.filesDir, relative));

    it('refuses files of a job that is still running, or of a playlist that is', async () => {
      const running = await seed('running', [{ name: 'a.mp4' }]);
      const one = await request('DELETE', `/v1/outputs/${running.ids[0]}`);
      expect(one.statusCode).toBe(409);
      expect(one.json<ErrorBody>().error.code).toBe('JOB_NOT_FINISHED');
      expect(
        (await request('DELETE', `/v1/jobs/${running.jobId}/outputs`)).json<ErrorBody>().error.code,
      ).toBe('JOB_NOT_FINISHED');

      const playlist = await seed('running', []);
      const item = await seed('completed', [{ name: 'b.mp4' }], playlist.jobId);
      expect((await request('DELETE', `/v1/outputs/${item.ids[0]}`)).statusCode).toBe(409);
      expect(exists(nth(running.paths, 0))).toBe(true);
      expect(exists(nth(item.paths, 0))).toBe(true);
    });

    it('takes the hidden original a recipe replaced with the last file the job shows', async () => {
      const job = await seed('completed', [
        { name: 'a.mp4', bytes: 100 },
        { name: 'b.mp4', bytes: 200 },
        { name: 'original.mkv', hidden: true, bytes: 5000 },
      ]);
      const [first, second] = job.ids;
      expect((await request('DELETE', `/v1/outputs/${first}`)).json<Removal>()).toEqual({
        deleted: 1,
        freed_bytes: 100,
      });
      expect(exists(nth(job.paths, 2))).toBe(true);

      expect((await request('DELETE', `/v1/outputs/${second}`)).json<Removal>()).toEqual({
        deleted: 1,
        freed_bytes: 5200,
      });
      expect(exists(nth(job.paths, 2))).toBe(false);
      expect(await db.select().from(outputs).where(eq(outputs.jobId, job.jobId))).toEqual([]);
      // The job's directory goes once it is empty.
      expect(existsSync(path.join(stack.filesDir, job.jobId))).toBe(false);
    });

    it("drops the job's own dedup entry but keeps one that points at another job", async () => {
      const own = await seed('completed', [{ name: 'own.mp4' }]);
      const other = await seed('completed', [{ name: 'other.mp4' }]);
      const entry = (jobId: string, mediaId: string) => ({
        id: uuidv7(),
        extractor: 'fake',
        mediaId,
        preset: 'best',
        optionsHash: 'h',
        jobId,
        path: jobId,
        expiresAt: new Date(Date.now() + day),
      });
      const ownEntry = entry(own.jobId, 'own');
      const otherEntry = entry(other.jobId, 'other');
      await db.insert(mediaFiles).values([ownEntry, otherEntry]);
      // The first output came from its own job's entry; the second was a dedup hit on another's.
      await db
        .update(outputs)
        .set({ mediaFileId: ownEntry.id })
        .where(eq(outputs.id, nth(own.ids, 0)));
      const reused = await seed('completed', [{ name: 'reused.mp4' }]);
      await db
        .update(outputs)
        .set({ mediaFileId: otherEntry.id })
        .where(eq(outputs.id, nth(reused.ids, 0)));

      await request('DELETE', `/v1/outputs/${own.ids[0]}`);
      await request('DELETE', `/v1/outputs/${reused.ids[0]}`);
      const left = await db
        .select({ id: mediaFiles.id })
        .from(mediaFiles)
        .where(inArray(mediaFiles.id, [ownEntry.id, otherEntry.id]));
      expect(left).toEqual([{ id: otherEntry.id }]);
    });
  });
});
