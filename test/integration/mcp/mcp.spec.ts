import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../../../src/auth/api-keys';
import { createDatabase } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import type { JobView } from '../../../src/jobs/jobs.service';
import { poolFor, startPostgres, startRedis } from '../support/containers';
import { ensureFakeMedia, FINISHED, type JobStack, startJobStack } from '../support/jobs';

/** The MCP server (SPEC §6) over Streamable HTTP with the SDK's own client. */

const SPEC_TOOLS = [
  'get_media_info',
  'search_media',
  'get_transcript',
  'get_comments',
  'probe_media',
  'list_presets',
  'start_download',
  'process_media',
  'start_batch',
  'record_live',
  'get_job_status',
  'list_jobs',
  'list_job_items',
  'retry_job',
  'cancel_job',
  'delete_job_outputs',
  'create_upload',
  'list_inbox',
  'list_outputs',
  'delete_output',
  'set_cookies',
  'list_cookies',
  'delete_cookies',
  'list_archive',
  'remove_archive_entry',
  'create_watch',
  'list_watches',
  'update_watch',
  'delete_watch',
  'connect_google_drive',
  'get_drive_status',
  'list_drive_files',
];

interface Listed {
  outputs: { id: string; job_id: string }[];
}

interface ToolResponse {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('MCP server (Postgres + Redis + workers)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let stack: JobStack;
  let url: string;
  let key: string;
  let keyWithoutUser: string;
  let client: Client;

  async function connect(apiKey: string): Promise<Client> {
    const connected = new Client({ name: 'test', version: '1.0.0' });
    await connected.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
      }),
    );
    return connected;
  }

  // T types the parsed JSON for each call site; the tool result itself is untyped text.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async function call<T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
    on = client,
  ): Promise<{ error: boolean; body: T }> {
    const result = (await on.callTool({ name, arguments: args })) as ToolResponse;
    const text = result.content[0]?.text ?? '';
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = { message: text } as T;
    }
    return { error: result.isError === true, body };
  }

  async function waitFor(jobId: string, userId: string): Promise<JobView> {
    for (let i = 0; i < 200; i++) {
      const { body } = await call<JobView>('get_job_status', { job_id: jobId, user_id: userId });
      if (FINISHED.includes(body.status)) return body;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`job ${jobId} did not finish`);
  }

  beforeAll(async () => {
    await ensureFakeMedia();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    const keys = new ApiKeyService(createDatabase(pool));
    key = (await keys.create({ clientName: 'agents', defaultUserId: 'alice' })).key;
    keyWithoutUser = (await keys.create({ clientName: 'agents' })).key;
    const inbox = mkdtempSync(path.join(tmpdir(), 'inbox-'));
    mkdirSync(path.join(inbox, 'agents'));
    writeFileSync(path.join(inbox, 'agents', 'clip.mp4'), readFileSync('/tmp/fake-media/clip.mp4'));
    stack = await startJobStack(
      {
        DATABASE_URL: postgres.getConnectionUri(),
        REDIS_URL: redis.getConnectionUrl(),
        INBOX_DIR: inbox,
      },
      { authorization: `Bearer ${key}` },
    );
    await stack.app.listen({ port: 0, host: '127.0.0.1' });
    url = await stack.app.getUrl();
    client = await connect(key);
  });

  afterAll(async () => {
    await client.close();
    await stack.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('needs an API key and answers only POST', async () => {
    const anonymous = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(anonymous.status).toBe(401);
    const get = await fetch(`${url}/mcp`, { headers: { authorization: `Bearer ${key}` } });
    expect(get.status).toBe(405);
  });

  it('lists every tool of SPEC §6 with an input schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...SPEC_TOOLS].sort());
    const download = tools.find((tool) => tool.name === 'start_download');
    expect(Object.keys(download?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['url', 'preset', 'then', 'user_id']),
    );
  });

  it('answers discovery and catalog tools', async () => {
    const info = await call('get_media_info', { url: 'https://fake.test/video' });
    expect(info.error).toBe(false);
    expect(info.body).toMatchObject({ title: expect.any(String) as string });
    const catalog = await call<{ recipe_operations: unknown[]; recipes: { name: string }[] }>(
      'list_presets',
    );
    expect(catalog.body.recipe_operations.length).toBeGreaterThan(100);
    expect(catalog.body.recipes.map((recipe) => recipe.name)).toContain('web_mp4_720');
    const probe = await call<{ probe: { format: string } }>('probe_media', {
      input: { type: 'inbox', name: 'clip.mp4' },
    });
    expect(probe.body.probe.format).toContain('mp4');
  });

  it('runs a download and a recipe for the given user, with signed links in the results', async () => {
    const started = await call<JobView>('start_download', {
      url: 'https://fake.test/video',
      preset: '360p',
      user_id: 'bob',
    });
    expect(started.error, JSON.stringify(started.body)).toBe(false);
    const done = await waitFor(started.body.id, 'bob');
    expect(done.status).toBe('completed');
    expect(done.outputs[0]?.url).toMatch(/\/d\/[0-9a-f-]{36}\?exp=\d+&sig=/);
    // Jobs belong to their end user.
    expect(
      (await call('get_job_status', { job_id: started.body.id, user_id: 'alice' })).body,
    ).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const processed = await call<JobView>('process_media', {
      inputs: [{ type: 'inbox', name: 'clip.mp4' }],
      recipe: 'audio_mp3_192',
    });
    const audio = await waitFor(processed.body.id, 'alice');
    expect(audio.outputs[0]).toMatchObject({ role: 'audio', mime: 'audio/mpeg' });
    const recorded = await call<JobView>('record_live', {
      url: 'https://fake.test/live/mcp?seconds=1',
      user_id: 'erin',
    });
    expect(recorded.error, JSON.stringify(recorded.body)).toBe(false);
    expect((await waitFor(recorded.body.id, 'erin')).outputs[0]).toMatchObject({
      mime: 'video/mp4',
    });
    const listed = await call<{ jobs: JobView[] }>('list_jobs', { user_id: 'bob' });
    expect(listed.body.jobs.map((job) => job.id)).toEqual([started.body.id]);
  });

  it('creates uploads and lists the inbox, outputs and archive', async () => {
    const upload = await call<{ tusUrl: string; uploadToken: string }>('create_upload', {
      filename: 'talk.mp4',
      size: 1000,
    });
    expect(upload.body.tusUrl).toMatch(/\/u\/[0-9a-f-]{36}$/);
    expect(
      (await call<{ files: { name: string }[] }>('list_inbox')).body.files.map(
        (entry) => entry.name,
      ),
    ).toEqual(['clip.mp4']);
    expect(
      (await call<{ outputs: unknown[] }>('list_outputs')).body.outputs.length,
    ).toBeGreaterThan(0);
    const archive = await call<{ entries: { extractor: string; media_id: string }[] }>(
      'list_archive',
      { user_id: 'bob' },
    );
    const [entry] = archive.body.entries;
    expect(entry).toBeDefined();
    expect(
      (
        await call('remove_archive_entry', {
          entry: `${entry?.extractor ?? ''}:${entry?.media_id ?? ''}`,
          user_id: 'bob',
        })
      ).body,
    ).toEqual({ removed: 1 });
  });

  it('stores, lists and deletes cookie jars without ever returning their contents', async () => {
    const jar = ['.fake.test', 'TRUE', '/', 'TRUE', '0', 'SID', 'secret-value'].join('\t');
    const saved = await call<{ id: string; is_default: boolean; domains: string[] }>(
      'set_cookies',
      {
        cookies: jar,
        label: 'main',
        user_id: 'carol',
      },
    );
    expect(saved.body).toMatchObject({ is_default: true, domains: ['fake.test'] });
    const listed = await call<{ cookies: Record<string, unknown>[] }>('list_cookies', {
      user_id: 'carol',
    });
    expect(listed.body.cookies).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain('secret-value');
    expect((await call('list_cookies', { user_id: 'dave' })).body).toEqual({ cookies: [] });
    expect((await call('delete_cookies', { id: saved.body.id, user_id: 'carol' })).body).toEqual({
      removed: 1,
    });
  });

  it("looks media up with the user's cookies", async () => {
    const jar = ['.fake.test', 'TRUE', '/', 'TRUE', '0', 'SID', 'gwen-sid'].join('\t');
    const saved = await call<{ id: string }>('set_cookies', { cookies: jar, user_id: 'gwen' });
    const refused = await call('get_media_info', {
      url: 'https://fake.test/members',
      user_id: 'gwen',
    });
    expect(refused.error).toBe(true);
    const info = await call('get_media_info', {
      url: 'https://fake.test/members',
      cookies: saved.body.id,
      user_id: 'gwen',
    });
    expect(info.error).toBe(false);
    expect(info.body).toMatchObject({ title: 'members' });
    await call('delete_cookies', { id: saved.body.id, user_id: 'gwen' });
  });

  it('creates, lists, pauses and deletes watches', async () => {
    const created = await call<{ id: string; status: string }>('create_watch', {
      url: 'https://fake.test/playlist',
      interval_minutes: 60,
      preset: '360p',
      user_id: 'frank',
    });
    expect(created.body).toMatchObject({ status: 'active' });
    expect(
      (await call<{ watches: unknown[] }>('list_watches', { user_id: 'frank' })).body.watches,
    ).toHaveLength(1);
    expect(
      (await call('update_watch', { id: created.body.id, status: 'paused', user_id: 'frank' }))
        .body,
    ).toMatchObject({
      status: 'paused',
      next_run_at: null,
    });
    expect((await call('delete_watch', { id: created.body.id, user_id: 'frank' })).body).toEqual({
      removed: 1,
    });
  });

  it('reports service errors, invalid arguments and later features as tool errors', async () => {
    const tooLong = await call('record_live', {
      url: 'https://fake.test/live/x',
      max_duration_minutes: 100_000,
    });
    expect(tooLong).toMatchObject({ error: true, body: { error: { code: 'VALIDATION_FAILED' } } });
    expect(
      (await call('create_watch', { url: 'https://fake.test/playlist', interval_minutes: 1 })).body,
    ).toMatchObject({
      error: { code: 'VALIDATION_FAILED', message: expect.stringMatching(/at least 30/) as string },
    });
    expect((await call('set_cookies', { cookies: '[{"name":"SID"}]' })).body).toMatchObject({
      error: { code: 'VALIDATION_FAILED', message: expect.stringMatching(/not JSON/) as string },
    });
    // No GOOGLE_CLIENT_ID in this stack.
    expect((await call('connect_google_drive')).body).toMatchObject({
      error: {
        code: 'FEATURE_DISABLED',
        message: expect.stringMatching(/not configured/) as string,
      },
    });
    expect((await call('get_drive_status')).body).toMatchObject({
      connected: false,
      status: 'not_connected',
    });
    const invalid = await call('get_job_status', { job_id: 'not-a-uuid' });
    expect(invalid.error).toBe(true);
    const badRecipe = await call('process_media', {
      inputs: [{ type: 'inbox', name: 'clip.mp4' }],
      recipe: { steps: [{ op: 'explode' }] },
    });
    expect(badRecipe.body).toMatchObject({ error: { code: 'RECIPE_INVALID' } });
    // A key without a default user needs user_id.
    const anonymousUser = await connect(keyWithoutUser);
    expect((await call('list_jobs', {}, anonymousUser)).body).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    await anonymousUser.close();
  });
  it('deletes one file, then the rest of its job', async () => {
    const [file] = (await call<Listed>('list_outputs')).body.outputs;
    expect(file).toBeDefined();
    const one = await call('delete_output', { output_id: file?.id });
    expect(one).toMatchObject({ error: false, body: { deleted: 1 } });
    const left = (await call<Listed>('list_outputs')).body.outputs;
    expect(left.map((output) => output.id)).not.toContain(file?.id);
    const rest = await call<{ deleted: number }>('delete_job_outputs', { job_id: file?.job_id });
    expect(rest.error).toBe(false);
    expect(
      (await call<Listed>('list_outputs')).body.outputs.map((output) => output.job_id),
    ).not.toContain(file?.job_id);
    expect((await call('delete_output', { output_id: file?.id })).body).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});
