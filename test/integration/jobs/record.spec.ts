import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import type { JobView } from '../../../src/jobs/jobs.service';
import { ffprobe } from '../../../src/media/ffprobe';
import { poolFor, startPostgres, startRedis } from '../support/containers';
import { CALLS_LOG, ensureFakeMedia, type JobStack, startJobStack } from '../support/jobs';

/** `record` jobs (SPEC §7d) with the fake yt-dlp's live streams and real ffmpeg remuxing. */

interface RecordLine {
  fromStart: boolean;
  mpegts: boolean;
  wait: string | null;
  format: string | null;
}

function recordLog(id: string): RecordLine[] {
  if (!existsSync(CALLS_LOG)) return [];
  const prefix = `record ${id} `;
  return readFileSync(CALLS_LOG, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as RecordLine);
}

describe('record jobs (Postgres + Redis + workers)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let stack: JobStack;
  const auth: Record<string, string> = {};

  const start = async (payload: object) => {
    const response = await stack.create({ type: 'record', ...payload });
    expect(response.statusCode, response.body).toBe(202);
    return response.json<JobView>();
  };
  /** Recording with bytes on disk (the first progress line is reported at once). */
  const recording = (view: JobView) =>
    view.status === 'recording' && ((view.progress as { bytes?: number } | null)?.bytes ?? 0) > 0;
  const outputFile = (job: JobView, index = 0) => {
    const output = job.outputs[index];
    if (!output) throw new Error('no output');
    return path.join(stack.filesDir, job.id, output.id, output.name);
  };

  beforeAll(async () => {
    await ensureFakeMedia();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const created = await new ApiKeyService(createDatabase(pool)).create({ clientName: 'live' });
    Object.assign(auth, { authorization: `Bearer ${created.key}`, 'x-user-id': 'alice' });
    stack = await startJobStack(
      {
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        LIVE_MAX_DURATION_MINUTES: '120',
      },
      auth,
    );
  });

  beforeEach(() => {
    rmSync(CALLS_LOG, { force: true });
  });

  afterAll(async () => {
    await stack.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('records a live stream to its end and remuxes the MPEG-TS to MP4', async () => {
    const job = await start({
      url: 'https://fake.test/live/show?seconds=1',
      preset: '720p',
      from_start: true,
    });
    const done = await stack.waitFor(job.id);
    expect(done).toMatchObject({ status: 'completed', type: 'record' });
    expect(done.outputs).toHaveLength(1);
    expect(done.outputs[0]).toMatchObject({
      role: 'media',
      mime: 'video/mp4',
      name: 'show [show].mp4',
    });
    const probe = await ffprobe('ffprobe', outputFile(done));
    expect(probe.format).toContain('mp4');
    expect(probe.duration_s).toBeGreaterThan(120);
    expect(recordLog('show')).toEqual([
      { fromStart: true, mpegts: true, wait: null, format: 'bv*+ba/b' },
    ]);
  });

  it('stops on cancel with SIGINT, keeps what was recorded and marks the job cancelled', async () => {
    const job = await start({ url: 'https://fake.test/live/marathon', container: 'mkv' });
    await stack.waitFor(job.id, recording);
    const cancel = await stack.app.inject({
      method: 'DELETE',
      url: `/v1/jobs/${job.id}`,
      headers: auth,
    });
    expect(cancel.statusCode).toBe(202);
    const done = await stack.waitFor(job.id);
    expect(done.status).toBe('cancelled');
    expect(done.outputs[0]).toMatchObject({
      mime: 'video/x-matroska',
      name: 'marathon [marathon].mkv',
    });
    expect((await ffprobe('ffprobe', outputFile(done))).format).toContain('matroska');
  });

  it('reports ffmpeg’s stats as progress and keeps its connection lines out of the job log', async () => {
    const job = await start({ url: 'https://fake.test/live/hls?ffmpeg=1' });
    const live = await stack.waitFor(job.id, recording);
    expect(live.progress).toMatchObject({ stage: 'recording', speed: 37_500 });
    expect((live.progress as { bytes: number }).bytes % (100 * 1024)).toBe(0);
    await stack.app.inject({ method: 'DELETE', url: `/v1/jobs/${job.id}`, headers: auth });
    expect((await stack.waitFor(job.id)).status).toBe('cancelled');
    const { rows } = await pool.query<{ line: string }>(
      'SELECT line FROM job_logs WHERE job_id = $1',
      [job.id],
    );
    expect(rows.map((row) => row.line).join('\n')).not.toMatch(
      /https @|SECRET|203\.0\.113\.9|frame=/,
    );
  });

  it('salvages the unfinished file when yt-dlp exits without finalising it', async () => {
    const job = await start({ url: 'https://fake.test/live/flaky?crash=1' });
    await stack.waitFor(job.id, recording);
    await stack.app.inject({ method: 'DELETE', url: `/v1/jobs/${job.id}`, headers: auth });
    const done = await stack.waitFor(job.id);
    expect(done.status).toBe('cancelled');
    expect(done.outputs.map((output) => output.name)).toEqual(['flaky [flaky].mp4']);
  });

  it('splits long recordings into segments', async () => {
    const job = await start({
      url: 'https://fake.test/live/talk?seconds=1',
      split_every_minutes: 1,
    });
    const done = await stack.waitFor(job.id);
    expect(done.status).toBe('completed');
    expect(done.outputs.map((output) => output.name)).toEqual([
      'talk [talk] - part 000.mp4',
      'talk [talk] - part 001.mp4',
      'talk [talk] - part 002.mp4',
    ]);
    const first = await ffprobe('ffprobe', outputFile(done, 0));
    expect(first.duration_s).toBeGreaterThan(55);
    expect(first.duration_s).toBeLessThan(65);
  });

  it('waits for a premiere: waiting, then recording, then completed', async () => {
    const job = await start({
      url: 'https://fake.test/upcoming/premiere?wait_ms=1500&seconds=1',
      wait: { min_minutes: 1, max_minutes: 5 },
    });
    const waiting = await stack.waitFor(job.id, (view) => view.status === 'waiting');
    expect(waiting.progress).toMatchObject({
      stage: 'waiting',
      scheduled_start: expect.stringMatching(/^\d{4}-/) as string,
    });
    await stack.waitFor(job.id, (view) => view.status !== 'waiting');
    const done = await stack.waitFor(job.id);
    expect(done.status).toBe('completed');
    expect(recordLog('premiere')[0]).toMatchObject({ wait: '60-300' });
  });

  it('refuses streams that are not live, have not started or start too late', async () => {
    const upcoming = await stack.waitFor(
      (await start({ url: 'https://fake.test/upcoming/later' })).id,
    );
    expect(upcoming).toMatchObject({ status: 'failed', error: { code: 'LIVE_NOT_STARTED' } });
    const far = await stack.waitFor(
      (await start({ url: 'https://fake.test/upcoming/far?far=1', wait: { min_minutes: 5 } })).id,
    );
    expect(far).toMatchObject({
      status: 'failed',
      error: {
        code: 'LIVE_NOT_STARTED',
        message: expect.stringMatching(/720-minute wait limit/) as string,
      },
    });
    const ended = await stack.waitFor((await start({ url: 'https://fake.test/ended/vod' })).id);
    expect(ended).toMatchObject({
      status: 'failed',
      error: {
        code: 'VALIDATION_FAILED',
        message: expect.stringMatching(/not live \(was_live\)/) as string,
      },
    });
    // And a download job on a live stream points at record.
    const download = await stack.create({ type: 'download', url: 'https://fake.test/live/now' });
    const failed = await stack.waitFor(download.json<JobView>().id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/record it with a "record" job/) as string },
    });
    expect(failed.attempts).toBe(0);
  });

  it('validates record requests at creation', async () => {
    const refusal = async (payload: object) => {
      const response = await stack.create({
        type: 'record',
        url: 'https://fake.test/live/x',
        ...payload,
      });
      return {
        status: response.statusCode,
        message: response.json<{ error: { message: string } }>().error.message,
      };
    };
    expect(await refusal({ max_duration_minutes: 121 })).toEqual({
      status: 400,
      message: 'max_duration_minutes is limited to 120',
    });
    expect(await refusal({ wait: { min_minutes: 5, max_minutes: 721 } })).toEqual({
      status: 400,
      message: 'wait is limited to 720 minutes',
    });
    expect(await refusal({ wait: { min_minutes: 5, max_minutes: 2 } })).toMatchObject({
      status: 400,
    });
    expect(await refusal({ split_every_minutes: 120 })).toEqual({
      status: 400,
      message: 'split_every_minutes must be shorter than the recording',
    });
    expect(await refusal({ container: 'webm' })).toMatchObject({ status: 400 });
    expect(await refusal({ preset: 'audio_mp3' })).toMatchObject({ status: 400 });
    expect(await refusal({ mark_watched: true })).toEqual({
      status: 400,
      message: 'mark_watched requires cookies',
    });
    expect(await refusal({ proxy: 'none' })).toMatchObject({ status: 400 });
    expect(await refusal({ destination: { type: 'google_drive' } })).toMatchObject({ status: 501 });
  });
});
