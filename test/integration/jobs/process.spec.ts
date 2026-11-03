import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { JobFinisher } from '../../../src/drive/job-finisher';
import { runMigrations } from '../../../src/db/migrations';
import type { JobView } from '../../../src/jobs/jobs.service';
import { poolFor, startPostgres, startRedis } from '../support/containers';
import { ensureFakeMedia, fakeCalls, type JobStack, startJobStack } from '../support/jobs';

interface ErrorBody {
  error: { code: string; message: string };
}

const CLIP = '/tmp/fake-media/clip.mp4';
/** What the fake yt-dlp logs when it downloads https://fake.test/video. */
const DOWNLOAD_LINE = 'download jNQXAC9IVRw';
const running = (job: JobView) => job.status !== 'queued';

describe('process jobs: recipes on worker-ff (Postgres + Redis + ffmpeg 8.1)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let stack: JobStack;
  let clientId: string;
  const auth: Record<string, string> = {};
  /** Whether a job's work directory still existed when its final status was announced. */
  const workDirAtAnnounce = new Map<string, boolean>();

  beforeAll(async () => {
    await ensureFakeMedia();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const created = await new ApiKeyService(createDatabase(pool)).create({ clientName: 'studio' });
    clientId = created.clientId;
    Object.assign(auth, { authorization: `Bearer ${created.key}`, 'x-user-id': 'alice' });
    const inbox = mkdtempSync(path.join(tmpdir(), 'inbox-'));
    mkdirSync(path.join(inbox, 'studio'));
    writeFileSync(path.join(inbox, 'studio', 'My Clip.mp4'), readFileSync(CLIP));
    stack = await startJobStack(
      {
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        INBOX_DIR: inbox,
        USER_MAX_PROCESS_MINUTES_PER_DAY: '100',
      },
      auth,
    );
    const finisher = stack.worker.get(JobFinisher);
    const announce = finisher.announce.bind(finisher);
    vi.spyOn(finisher, 'announce').mockImplementation((job, status) => {
      workDirAtAnnounce.set(job.id, existsSync(path.join(stack.filesDir, '.work', job.id)));
      return announce(job, status);
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await stack.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  const inbox = { type: 'inbox', name: 'My Clip.mp4' };

  it('runs a recipe and stores every output with its role, name and probe', async () => {
    const response = await stack.create({
      type: 'process',
      inputs: [inbox],
      recipe: {
        steps: [
          { op: 'trim', start: 0.5, end: 1.5 },
          { op: 'scale', width: 80, height: 60 },
          { op: 'encode', name: 'web', container: 'mp4' },
          { op: 'thumbnail', name: 'poster', at: 0 },
          { op: 'loudness' },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    const created = response.json<JobView>();
    expect(created).toMatchObject({
      type: 'process',
      status: 'queued',
      options: { inputs: [inbox] },
    });
    expect(JSON.stringify(created.options)).not.toContain('_share');
    const job = await stack.waitFor(created.id);
    expect(job.status, JSON.stringify(job.error)).toBe('completed');
    expect(job.outputs.map((output) => [output.name, output.role, output.mime])).toEqual([
      ['My Clip.web.mp4', 'media', 'video/mp4'],
      ['My Clip.poster.jpg', 'thumbnail', 'image/jpeg'],
      ['My Clip.loudness.json', 'report', 'application/json'],
    ]);
    const [web, , report] = job.outputs;
    expect(web?.duration_s).toBeCloseTo(1, 0);
    expect(web?.probe).toMatchObject({
      streams: [{ type: 'video', width: 80, height: 60 }, { type: 'audio' }],
    });
    const loudness = JSON.parse(
      readFileSync(
        path.join(stack.filesDir, job.id, report?.id ?? '', 'My Clip.loudness.json'),
        'utf8',
      ),
    ) as { integrated_lufs: number };
    expect(loudness.integrated_lufs).toEqual(expect.any(Number));
    expect(job.archive_url).not.toBeNull();
    // The work directory is gone before the job reports completed.
    expect(workDirAtAnnounce.get(job.id)).toBe(false);
    expect(existsSync(path.join(stack.filesDir, '.work', job.id))).toBe(false);
  });

  it('chains jobs: a download output becomes a recipe input', async () => {
    const download = await stack.waitFor(
      (
        await stack.create({ type: 'download', url: 'https://fake.test/video', filename: 'id' })
      ).json<JobView>().id,
    );
    const media = download.outputs.find((output) => output.role === 'media');
    const job = await stack.waitFor(
      (
        await stack.create({
          type: 'process',
          inputs: [{ type: 'output', outputId: media?.id }],
          recipe: { steps: [{ op: 'encode', name: 'audio', container: 'mp3' }] },
        })
      ).json<JobView>().id,
    );
    expect(job.status, JSON.stringify(job.error)).toBe('completed');
    expect(job.outputs[0]).toMatchObject({ role: 'audio', mime: 'audio/mpeg' });
    expect(job.outputs[0]?.name).toMatch(/\.audio\.mp3$/);
  });

  it('takes several inputs: a download output and an inbox file, joined', async () => {
    const download = await stack.waitFor(
      (
        await stack.create({ type: 'download', url: 'https://fake.test/video', filename: 'id' })
      ).json<JobView>().id,
    );
    const media = download.outputs.find((output) => output.role === 'media');
    const job = await stack.waitFor(
      (
        await stack.create({
          type: 'process',
          inputs: [inbox, { type: 'output', outputId: media?.id }],
          recipe: { steps: [{ op: 'concat' }, { op: 'encode', name: 'joined', container: 'mp4' }] },
        })
      ).json<JobView>().id,
    );
    expect(job.status, JSON.stringify(job.error)).toBe('completed');
    // Two 2-second clips.
    expect(job.outputs[0]?.duration_s).toBeCloseTo(4, 0);
    expect(job.outputs[0]?.name).toBe('My Clip.joined.mp4');
  });

  it('serves package outputs (HLS) by path-signed links, and zips them with the job', async () => {
    const job = await stack.waitFor(
      (
        await stack.create({
          type: 'process',
          inputs: [inbox],
          recipe: {
            steps: [
              { op: 'hls', segment_s: 2, variants: [{ height: 144, video_bitrate_kbps: 200 }] },
              { op: 'thumbnail', name: 'poster' },
            ],
          },
        })
      ).json<JobView>().id,
    );
    expect(job.status, JSON.stringify(job.error)).toBe('completed');
    const [hls] = job.outputs;
    expect(hls).toMatchObject({
      role: 'package',
      name: 'My Clip.hls',
      mime: 'application/vnd.apple.mpegurl',
    });
    const url = new URL(hls?.url ?? '');
    expect(url.pathname).toMatch(
      new RegExp(`^/d/hls/${hls?.id ?? ''}/\\d+/[\\w-]{43}/master\\.m3u8$`),
    );
    const fetch = (pathname: string) => stack.app.inject({ method: 'GET', url: pathname });
    const master = await fetch(url.pathname);
    expect(master.statusCode).toBe(200);
    expect(master.headers['x-accel-redirect']).toMatch(/\/My%20Clip\.hls\/master\.m3u8$/);
    expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    const base = url.pathname.replace(/master\.m3u8$/, '');
    expect((await fetch(`${base}v0/index.m3u8`)).statusCode).toBe(200);
    expect((await fetch(`${base}..%2F..%2Fsecret.txt`)).statusCode).toBe(404);
    expect((await fetch(`${base}v0/notes.txt`)).statusCode).toBe(404);
    expect(
      (await fetch(url.pathname.replace(/\/[\w-]{43}\//, `/${'A'.repeat(43)}/`))).statusCode,
    ).toBe(404);
    // Two outputs make a package: the HLS folder keeps its layout inside the ZIP.
    const archive = new URL(job.archive_url ?? '');
    const zip = await stack.app.inject({
      method: 'GET',
      url: `${archive.pathname}${archive.search}`,
    });
    expect(zip.statusCode).toBe(200);
    expect(zip.rawPayload.includes(Buffer.from('My Clip.hls/v0/index.m3u8'))).toBe(true);
  });

  it.each([
    [{ recipe: { steps: [{ op: 'explode' }] } }, 400, 'RECIPE_INVALID'],
    [
      {
        recipe: { steps: [{ op: 'encode', container: 'mp4' }] },
        destination: { type: 'google_drive' },
      },
      501,
      'FEATURE_DISABLED',
    ],
    [{ recipe: undefined }, 400, 'VALIDATION_FAILED'],
    [
      { recipe: { steps: [{ op: 'encode', container: 'mp4' }] }, inputs: [] },
      400,
      'VALIDATION_FAILED',
    ],
  ])('refuses %j at creation', async (body, status, code) => {
    const response = await stack.create({ type: 'process', inputs: [inbox], ...body });
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json<ErrorBody>().error.code).toBe(code);
  });

  it('fails jobs whose recipe does not fit the input, without retrying', async () => {
    const job = await stack.waitFor(
      (
        await stack.create({
          type: 'process',
          inputs: [inbox],
          recipe: { steps: [{ op: 'thumbnail', at: 100 }] },
        })
      ).json<JobView>().id,
    );
    expect(job).toMatchObject({ status: 'failed', attempts: 0, error: { code: 'RECIPE_INVALID' } });
    expect(job.error?.message).toMatch(/after the end/);
    const missing = await stack.waitFor(
      (
        await stack.create({
          type: 'process',
          inputs: [{ type: 'inbox', name: 'nope.mp4' }],
          recipe: { steps: [{ op: 'probe' }] },
        })
      ).json<JobView>().id,
    );
    expect(missing.error?.code).toBe('INPUT_NOT_FOUND');
  });

  it('cancels a running recipe and removes its work directory', async () => {
    const created = (
      await stack.create({
        type: 'process',
        inputs: [inbox],
        recipe: {
          steps: [
            { op: 'loop', to_duration_s: 3600 },
            { op: 'encode', container: 'mp4', video: { preset: 'veryslow' } },
          ],
        },
      })
    ).json<JobView>();
    const started = await stack.waitFor(
      created.id,
      (job) => running(job) && job.progress !== null,
      30_000,
    );
    expect(started.progress).toMatchObject({ stage: 'processing', step: 'processing' });
    expect(
      (await stack.app.inject({ method: 'DELETE', url: `/v1/jobs/${created.id}`, headers: auth }))
        .statusCode,
    ).toBe(202);
    const job = await stack.waitFor(created.id);
    expect(job.status).toBe('cancelled');
    expect(existsSync(path.join(stack.filesDir, '.work', created.id))).toBe(false);
  });

  describe('named and saved recipes', () => {
    const api = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object) =>
      stack.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
    const thumbnail = { steps: [{ op: 'thumbnail', name: 'still' }] };

    it("lists the built-in recipes and saves, reads and deletes the client's own", async () => {
      const list = (await api('GET', '/v1/recipes')).json<{
        recipes: { name: string; builtin: boolean }[];
      }>();
      expect(list.recipes.filter((recipe) => recipe.builtin)).toHaveLength(22);
      expect((await api('GET', '/v1/recipes/clip')).json()).toEqual(
        expect.objectContaining({ builtin: true, params: ['start', 'end'] }),
      );
      expect((await api('GET', '/v1/recipes/web_mp4_720')).json()).toMatchObject({
        steps: expect.any(Array) as unknown[],
      });
      const saved = await api('PUT', '/v1/recipes/my-still', {
        ...thumbnail,
        description: 'One still',
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({
        name: 'my-still',
        builtin: false,
        description: 'One still',
      });
      expect(
        (await api('GET', '/v1/recipes'))
          .json<{ recipes: { name: string }[] }>()
          .recipes.map((recipe) => recipe.name),
      ).toContain('my-still');
      expect((await api('PUT', '/v1/recipes/web_mp4_720', thumbnail)).statusCode).toBe(400);
      expect((await api('PUT', '/v1/recipes/Bad Name', thumbnail)).statusCode).toBe(400);
      expect(
        (await api('PUT', '/v1/recipes/broken', { steps: [{ op: 'explode' }] })).json<ErrorBody>()
          .error.code,
      ).toBe('RECIPE_INVALID');
      expect((await api('DELETE', '/v1/recipes/my-still')).statusCode).toBe(200);
      expect((await api('GET', '/v1/recipes/my-still')).statusCode).toBe(404);
    });

    it('runs jobs from a saved recipe, a preset and a preset with parameters', async () => {
      await api('PUT', '/v1/recipes/still-frame', thumbnail);
      const saved = await stack.waitFor(
        (
          await stack.create({ type: 'process', inputs: [inbox], recipe: 'still-frame' })
        ).json<JobView>().id,
      );
      expect(saved.status, JSON.stringify(saved.error)).toBe('completed');
      expect(saved.options).toMatchObject({
        recipe: { name: 'still-frame', steps: thumbnail.steps },
      });
      const preset = await stack.waitFor(
        (
          await stack.create({ type: 'process', inputs: [inbox], recipe: 'audio_mp3_192' })
        ).json<JobView>().id,
      );
      expect(preset.outputs[0]).toMatchObject({ role: 'audio', mime: 'audio/mpeg' });
      const clip = await stack.waitFor(
        (
          await stack.create({
            type: 'process',
            inputs: [inbox],
            recipe: { preset: 'clip', params: { start: 0.2, end: 1.2 } },
          })
        ).json<JobView>().id,
      );
      expect(clip.outputs[0]?.duration_s).toBeCloseTo(1, 0);
      // Editing the saved recipe later does not change a stored job.
      await api('PUT', '/v1/recipes/still-frame', { steps: [{ op: 'thumbnail', name: 'other' }] });
      expect((await stack.get(`/v1/jobs/${saved.id}`)).json<JobView>().options).toMatchObject({
        recipe: { steps: thumbnail.steps },
      });
    });

    it('expands names in then pipelines and refuses unknown ones', async () => {
      const job = await stack.waitFor(
        (
          await stack.create({
            type: 'download',
            url: 'https://fake.test/video',
            preset: '480p',
            filename: 'id',
            then: 'audio_m4a_160',
          })
        ).json<JobView>().id,
      );
      expect(job.status, JSON.stringify(job.error)).toBe('completed');
      expect(job.outputs.map((output) => output.mime)).toContain('audio/mp4');
      const unknown = await stack.create({ type: 'process', inputs: [inbox], recipe: 'nope' });
      expect(unknown.json<ErrorBody>().error).toMatchObject({
        code: 'RECIPE_INVALID',
        message: expect.stringMatching(/no recipe "nope"/) as string,
      });
      const badParams = await stack.create({
        type: 'process',
        inputs: [inbox],
        recipe: { preset: 'clip', params: { start: 5 } },
      });
      expect(badParams.json<ErrorBody>().error.code).toBe('RECIPE_INVALID');
      const thenUnknown = await stack.create({
        type: 'download',
        url: 'https://fake.test/video',
        then: 'nope',
      });
      expect(thenUnknown.json<ErrorBody>().error.message).toMatch(/^then: /);
    });
  });

  describe('dedup (SPEC §9d)', () => {
    const recipe = {
      steps: [
        { op: 'scale', width: 64, height: 48 },
        { op: 'encode', name: 'tiny', container: 'mp4' },
      ],
    };
    const pathsOf = async (jobId: string) =>
      (
        await pool.query<{ path: string }>(
          'select path from outputs where job_id = $1 order by name',
          [jobId],
        )
      ).rows.map((row) => row.path);
    const run = async (body: object) =>
      stack.waitFor(
        (await stack.create({ type: 'process', inputs: [inbox], ...body })).json<JobView>().id,
      );

    it('reuses the outputs of an identical recipe on the same content', async () => {
      const first = await run({ recipe });
      // Defaults are part of the canonical recipe, so the spelled-out variant is the same recipe.
      const spelledOut = {
        steps: [
          { op: 'scale', width: 64, height: 48, fit: 'contain' },
          { op: 'encode', container: 'mp4', name: 'tiny' },
        ],
      };
      const again = await run({ recipe: spelledOut });
      expect([first.status, again.status]).toEqual(['completed', 'completed']);
      expect(await pathsOf(again.id)).toEqual(await pathsOf(first.id));
      expect(again.outputs[0]?.id).not.toBe(first.outputs[0]?.id);
    });

    it('runs again when the recipe or the content differs', async () => {
      const first = await run({ recipe });
      const otherSteps = [
        recipe.steps[0],
        { op: 'encode', name: 'tiny', container: 'mp4', video: { crf: 30 } },
      ];
      const otherRecipe = await run({ recipe: { steps: otherSteps } });
      expect(await pathsOf(otherRecipe.id)).not.toEqual(await pathsOf(first.id));
      // Replacing the inbox file changes its size and modification time.
      const file = path.join(stack.config.INBOX_DIR, 'studio', 'My Clip.mp4');
      writeFileSync(file, Buffer.concat([readFileSync(CLIP), Buffer.alloc(16)]));
      const newContent = await run({ recipe });
      expect(newContent.status).toBe('completed');
      expect(await pathsOf(newContent.id)).not.toEqual(await pathsOf(first.id));
    });
  });

  describe('then pipelines on downloads', () => {
    const audio = {
      steps: [
        { op: 'encode', name: 'audio', container: 'mp3' },
        { op: 'thumbnail', name: 'poster' },
      ],
    };
    const roles = (job: JobView) => job.outputs.map((output) => output.role).sort();

    it('runs the recipe on the downloaded media and replaces the original', async () => {
      const job = await stack.waitFor(
        (
          await stack.create({
            type: 'download',
            url: 'https://fake.test/video',
            preset: 'audio_m4a',
            then: audio,
          })
        ).json<JobView>().id,
      );
      expect(job.status, JSON.stringify(job.error)).toBe('completed');
      expect(job.outputs.map((output) => output.name)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/\.audio\.mp3$/),
          expect.stringMatching(/\.poster\.jpg$/),
        ]),
      );
      // keep_original defaults to false with then: the downloaded m4a is not listed.
      expect(job.outputs.some((output) => output.name.endsWith('.m4a'))).toBe(false);
      expect(job.options).toMatchObject({ then: audio });
    });

    it('burns the subtitles the download wrote (job_output)', async () => {
      const burn = {
        steps: [
          { op: 'subtitles_burn', input: { job_output: 'subtitles', lang: 'en' } },
          { op: 'encode', name: 'burned', container: 'mp4' },
        ],
      };
      const created = await stack.create({
        type: 'download',
        url: 'https://fake.test/video',
        preset: '1080p',
        subtitles: { langs: ['en'] },
        then: burn,
      });
      const job = await stack.waitFor(created.json<JobView>().id);
      expect(job.status, JSON.stringify(job.error)).toBe('completed');
      expect(job.outputs.map((output) => output.role).sort()).toEqual(['media', 'subtitles']);
      expect(job.outputs.find((output) => output.role === 'media')?.name).toMatch(/\.burned\.mp4$/);
      const process = await stack.waitFor(
        (await stack.create({ type: 'process', inputs: [inbox], recipe: burn })).json<JobView>().id,
      );
      expect(process.error?.message).toMatch(/job_output inputs exist in then pipelines/);
    });

    it('keeps the original when asked', async () => {
      const job = await stack.waitFor(
        (
          await stack.create({
            type: 'download',
            url: 'https://fake.test/video',
            preset: '360p',
            then: { steps: [{ op: 'thumbnail', name: 'still' }] },
            keep_original: true,
          })
        ).json<JobView>().id,
      );
      expect(job.status, JSON.stringify(job.error)).toBe('completed');
      expect(roles(job)).toEqual(expect.arrayContaining(['media', 'thumbnail']));
    });

    it('lets a later plain download reuse the original, not the recipe outputs', async () => {
      const downloadsBefore = fakeCalls(DOWNLOAD_LINE);
      const first = await stack.waitFor(
        (
          await stack.create({
            type: 'download',
            url: 'https://fake.test/video',
            preset: '480p',
            then: audio,
          })
        ).json<JobView>().id,
      );
      expect(first.outputs.some((output) => output.role === 'media')).toBe(false);
      // The pipeline job downloaded the file once; the plain job is a dedup hit.
      expect(fakeCalls(DOWNLOAD_LINE)).toBe(downloadsBefore + 1);
      const plain = await stack.waitFor(
        (
          await stack.create({ type: 'download', url: 'https://fake.test/video', preset: '480p' })
        ).json<JobView>().id,
      );
      expect(plain.status).toBe('completed');
      expect(fakeCalls(DOWNLOAD_LINE)).toBe(downloadsBefore + 1);
      expect(plain.outputs.map((output) => output.role)).toContain('media');
      expect(plain.outputs.some((output) => /\.(audio|poster)\./.test(output.name))).toBe(false);
    });

    it('applies the recipe to every playlist item', async () => {
      const createdParent = (
        await stack.create({
          type: 'download',
          url: 'https://fake.test/playlist',
          items: '1-2',
          preset: '360p',
          then: {
            steps: [{ op: 'encode', name: 'small', container: 'webm', video: { crf: 45 } }],
          },
        })
      ).json<JobView>();
      const parent = await stack.waitFor(createdParent.id, undefined, 60_000);
      expect(parent).toMatchObject({ status: 'completed', items: { total: 2, completed: 2 } });
      const items = (await stack.get(`/v1/jobs/${parent.id}/items`)).json<{ items: JobView[] }>()
        .items;
      for (const item of items)
        expect(item.outputs.map((output) => output.name)).toEqual(
          expect.arrayContaining([expect.stringMatching(/\.small\.webm$/)]),
        );
    });

    it("joins a playlist's items into one extra output (concat_items)", async () => {
      const parent = await stack.waitFor(
        (
          await stack.create({
            type: 'download',
            url: 'https://fake.test/playlist',
            items: '1-3',
            preset: '720p',
            concat_items: true,
          })
        ).json<JobView>().id,
        undefined,
        60_000,
      );
      expect(parent).toMatchObject({ status: 'completed', items: { total: 3, completed: 3 } });
      expect(parent.options).toMatchObject({ concat_items: true });
      const outputs = (await stack.get(`/v1/jobs/${parent.id}/outputs`)).json<{
        outputs: { name: string; job_id: string; duration_s: number | null }[];
      }>().outputs;
      const joined = outputs.find((output) => output.job_id === parent.id);
      expect(joined?.name).toBe('playlist.joined.mp4');
      // Three 2-second fake videos.
      expect(joined?.duration_s).toBeCloseTo(6, 0);
      expect(workDirAtAnnounce.get(parent.id)).toBe(false);
      const batch = await stack.waitFor(
        (
          await stack.create({
            type: 'batch',
            concat_items: true,
            items: [{ url: 'https://fake.test/item/vid7' }, { url: 'https://fake.test/item/vid8' }],
          })
        ).json<JobView>().id,
        undefined,
        60_000,
      );
      expect(batch.status).toBe('completed');
      const batchOutputs = (await stack.get(`/v1/jobs/${batch.id}/outputs`)).json<{
        outputs: { job_id: string }[];
      }>().outputs;
      expect(batchOutputs.filter((output) => output.job_id === batch.id)).toHaveLength(1);
    });

    it.each([
      [{ then: { steps: [{ op: 'explode' }] } }, 400, 'RECIPE_INVALID', /^then: /],
      [
        { then: audio, preset: 'thumbnail_only' },
        400,
        'VALIDATION_FAILED',
        /preset that downloads media/,
      ],
      [{ keep_original: true }, 400, 'VALIDATION_FAILED', /only with then/],
    ])('refuses %j at creation', async (body, status, code, message) => {
      const response = await stack.create({
        type: 'download',
        url: 'https://fake.test/video',
        ...body,
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json<ErrorBody>().error).toMatchObject({
        code,
        message: expect.stringMatching(message) as string,
      });
    });

    it('checks batch items too, and fails the download when its recipe does not fit', async () => {
      const batch = await stack.create({
        type: 'batch',
        items: [
          { url: 'https://fake.test/video' },
          { url: 'https://fake.test/video', then: { steps: [{ op: 'nope' }] } },
        ],
      });
      expect(batch.json<ErrorBody>().error.message).toMatch(/^items\.1: then: /);
      const job = await stack.waitFor(
        (
          await stack.create({
            type: 'download',
            url: 'https://fake.test/video',
            preset: '720p',
            then: { steps: [{ op: 'thumbnail', at: 500 }] },
          })
        ).json<JobView>().id,
      );
      expect(job).toMatchObject({ status: 'failed', error: { code: 'RECIPE_INVALID' } });
    });
  });

  it('counts input minutes against the daily process quota', async () => {
    const client = new Redis(redis.getConnectionUrl());
    const day = new Date().toISOString().slice(0, 10);
    await client.set(`media:quota:process:${clientId}:carol:${day}`, '100');
    await client.quit();
    const created = await stack.create(
      { type: 'process', inputs: [inbox], recipe: { steps: [{ op: 'encode', container: 'mp3' }] } },
      { 'x-user-id': 'carol' },
    );
    const carol = { ...auth, 'x-user-id': 'carol' };
    let view = created.json<JobView>();
    for (let i = 0; i < 100 && !['failed', 'completed'].includes(view.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      view = (
        await stack.app.inject({ method: 'GET', url: `/v1/jobs/${view.id}`, headers: carol })
      ).json<JobView>();
    }
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('QUOTA_EXCEEDED');
  });
});
