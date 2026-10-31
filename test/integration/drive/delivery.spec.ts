import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import type { JobView, OutputView } from '../../../src/jobs/jobs.service';
import { WatchRunner } from '../../../src/watches/watch-runner';
import { WatchProcessor } from '../../../src/watches/watch.processor';
import { poolFor, startPostgres, startRedis } from '../support/containers';
import { FakeDrive } from '../support/fake-drive';
import { ensureFakeMedia, FINISHED, type JobStack, startJobStack } from '../support/jobs';

/** Drive delivery (SPEC §11) end to end: API → workers → uploads into a fake Drive. */

const DRIVE = { type: 'google_drive' };
const idToken = [
  'e30',
  Buffer.from(JSON.stringify({ email: 'u@example.com' })).toString('base64url'),
  's',
].join('.');

describe('Drive delivery (Postgres + Redis + workers, mocked Google)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let stack: JobStack;
  let mock: MockAgent;
  let original: Dispatcher;
  let drive: FakeDrive;
  const auth: Record<string, string> = {};
  const as = (user: string) => ({ ...auth, 'x-user-id': user });

  /** The real consent flow, with Google's token endpoint answering. */
  async function connect(user: string): Promise<void> {
    const consent = (
      await stack.app.inject({ method: 'POST', url: '/v1/drive/connect', headers: as(user) })
    ).json<{ consent_url: string }>();
    const state = new URL(consent.consent_url).searchParams.get('state') ?? '';
    mock
      .get('https://oauth2.googleapis.com')
      .intercept({
        path: '/token',
        method: 'POST',
        body: (body) => body.includes('grant_type=authorization_code'),
      })
      .reply(
        200,
        {
          access_token: 'a',
          refresh_token: `1//refresh-${user}`,
          id_token: idToken,
          expires_in: 3599,
        },
        { headers: { 'content-type': 'application/json' } },
      );
    const page = await stack.app.inject({
      method: 'GET',
      url: `/oauth/google/callback?state=${state}&code=c`,
    });
    expect(page.statusCode, page.body).toBe(200);
  }
  const start = async (payload: object, user = 'alice') => {
    const response = await stack.create(payload, { 'x-user-id': user });
    expect(response.statusCode, response.body).toBe(202);
    return response.json<JobView>();
  };
  const waitAs = async (id: string, user = 'alice'): Promise<JobView> => {
    for (let i = 0; i < 300; i++) {
      const view = (
        await stack.app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: as(user) })
      ).json<JobView>();
      if (FINISHED.includes(view.status)) return view;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`job ${id} did not finish`);
  };
  const local = (output: OutputView, job: JobView) =>
    readFileSync(path.join(stack.filesDir, job.id, output.id, output.name));
  const root = () => drive.byName('Media downloads');

  beforeAll(async () => {
    await ensureFakeMedia();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const created = await new ApiKeyService(createDatabase(pool)).create({ clientName: 'drivers' });
    Object.assign(auth, { authorization: `Bearer ${created.key}`, 'x-user-id': 'alice' });
    stack = await startJobStack(
      {
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'secret',
        PUBLIC_BASE_URL: 'https://dl.example.test',
        GOOGLE_API_KEY: 'test-api-key',
      },
      auth,
    );
    // The test runs the scheduler itself: this stack's watch worker processes no ticks.
    await stack.worker.get(WatchProcessor).worker.close();
    original = getGlobalDispatcher();
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    drive = new FakeDrive(mock);
  });

  afterAll(async () => {
    setGlobalDispatcher(original);
    await mock.close();
    await stack.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('refuses Drive delivery before the user connects', async () => {
    const response = await stack.create(
      { type: 'download', url: 'https://fake.test/video', destination: DRIVE },
      { 'x-user-id': 'nobody' },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'DRIVE_NOT_CONNECTED' } });
    const batchItem = await stack.create({
      type: 'batch',
      items: [{ url: 'https://fake.test/video', destination: DRIVE }],
    });
    expect(batchItem.statusCode).toBe(400);
  });

  it('uploads a download into "Media downloads" and keeps the local file as a fallback', async () => {
    await connect('alice');
    const done = await waitAs(
      (
        await start({
          type: 'download',
          url: 'https://fake.test/video',
          preset: '360p',
          destination: DRIVE,
        })
      ).id,
    );
    expect(done.status).toBe('completed');
    const [output] = done.outputs;
    expect(output?.drive).toMatchObject({
      file_id: expect.stringMatching(/^fake/) as string,
      link: expect.stringMatching(/drive\.google\.com\/file\/d\//) as string,
    });
    expect(output?.url).toMatch(/\/d\/[0-9a-f-]{36}\?exp=/);
    const uploaded = drive.files.get(output?.drive?.file_id ?? '');
    expect(uploaded?.parents).toEqual([root()?.id]);
    if (!output) throw new Error('no output');
    expect(uploaded?.content?.equals(local(output, done))).toBe(true);
    expect(
      (
        await stack.app.inject({ method: 'GET', url: '/v1/drive/status', headers: as('alice') })
      ).json(),
    ).toMatchObject({ root_folder: { id: root()?.id } });
  });

  it('puts the files of a multi-output download into a sub-folder named after the media', async () => {
    const done = await waitAs(
      (
        await start({
          type: 'download',
          url: 'https://fake.test/video',
          preset: '480p',
          subtitles: { write: true, langs: ['en'] },
          destination: DRIVE,
        })
      ).id,
    );
    expect(done.status).toBe('completed');
    expect(done.outputs.length).toBeGreaterThan(1);
    const folders = new Set(done.outputs.map((output) => output.drive?.folder_id));
    expect(folders.size).toBe(1);
    const folder = drive.files.get([...folders][0] ?? '');
    expect(folder?.parents).toEqual([root()?.id]);
    expect(folder?.name).toBe(
      done.outputs.find((output) => output.role === 'media')?.name.replace(/\.mp4$/, ''),
    );
  });

  it('puts playlist and batch items into one sub-folder each', async () => {
    const playlist = await waitAs(
      (
        await start({
          type: 'download',
          url: 'https://fake.test/playlist',
          max_items: 2,
          preset: '720p',
          destination: DRIVE,
        })
      ).id,
    );
    expect(playlist).toMatchObject({ status: 'completed', items: { completed: 2 } });
    const { rows } = await pool.query<{ destination: { _folder: string; _name: string } }>(
      'SELECT destination FROM jobs WHERE id = $1',
      [playlist.id],
    );
    const playlistFolder = drive.files.get(rows[0]?.destination._folder ?? '');
    // Named after the playlist, inside the root folder.
    expect(playlistFolder).toMatchObject({
      name: rows[0]?.destination._name,
      parents: [root()?.id],
    });
    expect(playlistFolder?.name.length).toBeGreaterThan(0);
    expect(drive.children(rows[0]?.destination._folder ?? '').map((file) => file.mimeType)).toEqual(
      ['video/mp4', 'video/mp4'],
    );

    const batch = await waitAs(
      (
        await start({
          type: 'batch',
          destination: DRIVE,
          items: [{ url: 'https://fake.test/item/vid1' }, { url: 'https://fake.test/item/vid2' }],
        })
      ).id,
    );
    expect(batch.status).toBe('completed');
    const batchFolder = drive
      .children(root()?.id ?? '')
      .find((file) => file.name.startsWith('Batch '));
    expect(batchFolder?.name).toMatch(
      new RegExp(`^Batch \\d{4}-\\d{2}-\\d{2} ${batch.id.slice(0, 8)}$`),
    );
    expect(drive.children(batchFolder?.id ?? '')).toHaveLength(2);
  });

  it('uploads an HLS package as a folder tree', async () => {
    const recipe = {
      steps: [
        {
          op: 'hls',
          name: 'stream',
          segment_s: 2,
          variants: [{ height: 144, video_bitrate_kbps: 200 }],
        },
      ],
    };
    // Any earlier output of this user can be the input.
    const [source] = (
      await stack.app.inject({ method: 'GET', url: '/v1/outputs', headers: as('alice') })
    ).json<{ outputs: OutputView[] }>().outputs;
    const job = await waitAs(
      (
        await start({
          type: 'process',
          inputs: [{ type: 'output', outputId: source?.id }],
          recipe,
          destination: DRIVE,
        })
      ).id,
    );
    expect(job.status).toBe('completed');
    const pkg = job.outputs.find((output) => output.role === 'package');
    const folder = drive.files.get(pkg?.drive?.file_id ?? '');
    expect(folder?.mimeType).toBe('application/vnd.google-apps.folder');
    const inside = drive.children(folder?.id ?? '');
    expect(inside.map((file) => file.name)).toContain('master.m3u8');
    const variant = inside.find((file) => file.mimeType.endsWith('folder'));
    expect(drive.children(variant?.id ?? '').some((file) => file.name === 'index.m3u8')).toBe(true);
    expect(
      drive
        .children(variant?.id ?? '')
        .some((file) => file.mimeType === 'video/iso.segment' || file.mimeType === 'video/mp2t'),
    ).toBe(true);
  });

  it('honours folderId, and refuses folders the service did not create', async () => {
    const mine = drive.folder('Projects', root()?.id);
    const done = await waitAs(
      (
        await start({
          type: 'download',
          url: 'https://fake.test/item/vid3',
          destination: { ...DRIVE, folderId: mine.id },
        })
      ).id,
    );
    expect(done.status).toBe('completed');
    expect(drive.children(mine.id)).toHaveLength(1);
    const refused = await waitAs(
      (
        await start({
          type: 'download',
          url: 'https://fake.test/item/vid4',
          destination: { ...DRIVE, folderId: 'hand-made-folder-0001' },
        })
      ).id,
    );
    expect(refused).toMatchObject({
      status: 'failed',
      error: { code: 'DRIVE_FOLDER_NOT_ACCESSIBLE' },
      attempts: 0,
    });
    // The local file is still there and linked.
    expect(refused.outputs[0]).toMatchObject({
      drive: null,
      url: expect.stringMatching(/\/d\//) as string,
    });
  });

  it('fails with DRIVE_STORAGE_FULL when the Drive is full', async () => {
    drive.storageFull = true;
    const full = await waitAs(
      (await start({ type: 'download', url: 'https://fake.test/item/vid5', destination: DRIVE }))
        .id,
    );
    drive.storageFull = false;
    expect(full).toMatchObject({ status: 'failed', error: { code: 'DRIVE_STORAGE_FULL' } });
    expect(full.outputs).toHaveLength(1);
  });

  it('marks the connection revoked on invalid_grant and refuses Drive jobs until the user reconnects', async () => {
    await connect('bob');
    drive.revoked = true;
    const revoked = await waitAs(
      (
        await start(
          { type: 'download', url: 'https://fake.test/item/vid6', destination: DRIVE },
          'bob',
        )
      ).id,
      'bob',
    );
    expect(revoked).toMatchObject({
      status: 'failed',
      error: { code: 'DRIVE_RECONNECT_REQUIRED' },
    });
    expect(
      (
        await stack.app.inject({ method: 'GET', url: '/v1/drive/status', headers: as('bob') })
      ).json(),
    ).toMatchObject({ status: 'revoked' });
    const refused = await stack.create(
      { type: 'download', url: 'https://fake.test/video', destination: DRIVE },
      { 'x-user-id': 'bob' },
    );
    expect(refused.json()).toMatchObject({ error: { code: 'DRIVE_RECONNECT_REQUIRED' } });
    drive.revoked = false;
  });

  it('reads google_drive inputs: own files with the token, public ones with the API key', async () => {
    const own = [...drive.files.values()].find(
      (file) => file.mimeType === 'video/mp4' && file.foreign !== true,
    );
    const recipe = 'audio_mp3_192';
    const fromOwn = await waitAs(
      (
        await start({
          type: 'process',
          inputs: [{ type: 'google_drive', fileId: own?.id }],
          recipe,
        })
      ).id,
    );
    expect(fromOwn).toMatchObject({ status: 'completed', outputs: [{ mime: 'audio/mpeg' }] });

    const clip = readFileSync('/tmp/fake-media/clip.mp4');
    const shared = drive.foreignFile('shared.mp4', clip, { public: true });
    const secret = drive.foreignFile('secret.mp4', clip, { public: false });
    // carol has no Drive connection: the API key reads public files for her.
    const probe = await stack.app.inject({
      method: 'POST',
      url: '/v1/probe',
      headers: as('carol'),
      payload: { input: { type: 'google_drive', fileId: shared.id } },
    });
    expect(probe.statusCode, probe.body).toBe(200);
    expect(probe.json()).toMatchObject({
      input: { type: 'google_drive', size_bytes: clip.length },
    });
    const refused = async (fileId: string, user = 'alice') =>
      (
        await stack.app.inject({
          method: 'POST',
          url: '/v1/probe',
          headers: as(user),
          payload: { input: { type: 'google_drive', fileId } },
        })
      ).json<{ error: { code: string } }>().error.code;
    expect(await refused(secret.id)).toBe('INPUT_NOT_FOUND');
    expect(await refused(root()?.id ?? '')).toBe('INPUT_NOT_MEDIA');
    expect(await refused('missing-file-0000001')).toBe('INPUT_NOT_FOUND');
  });

  it('delivers a watch’s batches into one folder named after the source', async () => {
    const watch = (
      await stack.app.inject({
        method: 'POST',
        url: '/v1/watches',
        headers: as('alice'),
        // alice downloaded the first entries already: skip them rather than stop there.
        payload: {
          url: 'https://fake.test/playlist',
          interval_minutes: 30,
          break_on_existing: false,
          destination: DRIVE,
        },
      })
    ).json<{ id: string; destination: unknown }>();
    expect(watch.destination).toEqual(DRIVE);
    await pool.query("UPDATE watches SET next_run_at = now() - interval '1 second' WHERE id = $1", [
      watch.id,
    ]);
    await stack.worker.get(WatchRunner).tick();
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM jobs WHERE options->>'watch_id' = $1",
      [watch.id],
    );
    expect(rows).toHaveLength(1);
    const batch = await waitAs(rows[0]?.id ?? '');
    expect(batch.status).toBe('completed');
    const { rows: watchRows } = await pool.query<{ destination: { _folder: string } }>(
      'SELECT destination FROM watches WHERE id = $1',
      [watch.id],
    );
    const folder = drive.files.get(watchRows[0]?.destination._folder ?? '');
    expect(folder?.parents).toEqual([root()?.id]);
    expect(drive.children(folder?.id ?? '').length).toBeGreaterThan(0);
  });
});
