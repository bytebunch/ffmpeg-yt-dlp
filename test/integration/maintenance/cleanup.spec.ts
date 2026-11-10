import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../../src/common/ids';
import { createDatabase, type Database } from '../../../src/db/database';
import { runMigrations } from '../../../src/db/migrations';
import {
  clients,
  inputs,
  jobLogs,
  jobs,
  mediaFiles,
  outputs,
  uploads,
} from '../../../src/db/schema';
import { Cleanup, type CleanupReport } from '../../../src/maintenance/cleanup';
import { StoredFiles } from '../../../src/maintenance/stored-files';
import { testConfig } from '../support/app';
import { poolFor, startPostgres } from '../support/containers';

describe('hourly cleanup (Postgres)', () => {
  let postgres: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let filesDir: string;
  let outside: string;
  let report: CleanupReport;
  const now = new Date();
  const past = new Date(now.getTime() - 3_600_000);
  const future = new Date(now.getTime() + 86_400_000);
  const longAgo = new Date(now.getTime() - 30 * 86_400_000);
  const ids = { a: uuidv7(), b: uuidv7(), c: uuidv7(), running: uuidv7(), stale: uuidv7() };

  const file = (relative: string) => {
    const full = path.join(filesDir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, 'data');
    return relative;
  };

  const cleanup = () => {
    const config = testConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: 'redis://unused:6379',
      FILES_DIR: filesDir,
    });
    return new Cleanup(config, db, new StoredFiles(config, db));
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    pool = poolFor(postgres.getConnectionUri());
    await runMigrations(pool);
    db = createDatabase(pool);
    filesDir = mkdtempSync(path.join(tmpdir(), 'cleanup-'));
    outside = path.join(mkdtempSync(path.join(tmpdir(), 'outside-')), 'keep.txt');
    writeFileSync(outside, 'must survive');

    const clientId = uuidv7();
    await db.insert(clients).values({ id: clientId, name: 'cleanup' });
    const job = (id: string, status: string, finishedAt: Date | null) => ({
      id,
      type: 'download',
      clientId,
      userId: 'u',
      status,
      finishedAt,
    });
    await db
      .insert(jobs)
      .values([
        job(ids.a, 'completed', longAgo),
        job(ids.b, 'completed', now),
        job(ids.c, 'completed', now),
        job(ids.running, 'running', null),
        job(ids.stale, 'failed', longAgo),
      ]);
    const output = (jobId: string, relative: string, expiresAt: Date) => ({
      jobId,
      clientId,
      userId: 'u',
      role: 'media',
      name: path.basename(relative),
      path: relative,
      expiresAt,
    });
    const shared = file(`${ids.b}/o2/b.mp4`);
    await db
      .insert(outputs)
      .values([
        output(ids.a, file(`${ids.a}/o1/a.mp4`), past),
        output(ids.b, shared, past),
        output(ids.c, shared, future),
        output(ids.c, file(`${ids.c}/o3/c.mp4`), future),
        output(ids.a, path.relative(filesDir, outside), past),
      ]);
    await db.insert(mediaFiles).values([
      {
        extractor: 'youtube',
        mediaId: 'old',
        preset: 'best',
        optionsHash: 'h',
        path: ids.a,
        expiresAt: past,
      },
      {
        extractor: 'youtube',
        mediaId: 'new',
        preset: 'best',
        optionsHash: 'h',
        path: ids.c,
        expiresAt: future,
      },
    ]);
    await db.insert(jobLogs).values([
      { jobId: ids.a, seq: 0, line: 'old' },
      { jobId: ids.c, seq: 0, line: 'recent' },
    ]);
    const work = (name: string, mtime: Date) => {
      const dir = path.join(filesDir, '.work', name);
      mkdirSync(dir, { recursive: true });
      utimesSync(dir, mtime, mtime);
    };
    work(ids.stale, longAgo);
    work(ids.running, longAgo);
    work(uuidv7(), now);

    // tus keeps <id>.json beside each upload. `past` is an hour ago: expired, but a job may still
    // be reading what it resolved just before (the grace period is the job timeout plus an hour).
    const tus = (name: string) => {
      file(`.uploads/${name}.json`);
      return file(`.uploads/${name}`);
    };
    const upload = (relative: string, expiresAt: Date) => ({
      clientId,
      userId: 'u',
      filename: 'clip.mp4',
      declaredSize: 4,
      path: relative,
      expiresAt,
    });
    await db
      .insert(uploads)
      .values([
        upload(tus('old'), longAgo),
        upload(tus('just-expired'), past),
        upload(tus('open'), future),
        upload(path.relative(filesDir, outside), longAgo),
      ]);
    const input = (relative: string, expiresAt: Date, hash: string) => ({
      clientId,
      userId: 'u',
      type: 'url',
      source: {},
      sourceHash: hash,
      contentHash: hash,
      path: relative,
      sizeBytes: 4,
      expiresAt,
    });
    const sharedInput = file('.inputs/shared');
    await db
      .insert(inputs)
      .values([
        input(file('.inputs/old'), longAgo, 'h1'),
        input(sharedInput, longAgo, 'h2'),
        input(sharedInput, future, 'h3'),
        input(file('.inputs/just-expired'), past, 'h4'),
      ]);

    report = await cleanup().run(now);
  });

  afterAll(async () => {
    await pool.end();
    await postgres.stop();
  });

  it('deletes expired outputs and files nobody else uses, with their empty directories', () => {
    expect(existsSync(path.join(filesDir, ids.a, 'o1', 'a.mp4'))).toBe(false);
    expect(existsSync(path.join(filesDir, ids.a))).toBe(false);
    expect(report.outputs).toBe(3);
  });

  it('keeps a file that an unexpired output still points at', () => {
    expect(existsSync(path.join(filesDir, ids.b, 'o2', 'b.mp4'))).toBe(true);
    expect(existsSync(path.join(filesDir, ids.c, 'o3', 'c.mp4'))).toBe(true);
  });

  it('never deletes outside FILES_DIR, whatever a row says', () => {
    expect(existsSync(outside)).toBe(true);
  });

  it('removes expired dedup entries only', async () => {
    expect(report.mediaFiles).toBe(1);
    expect(
      (await db.select({ id: mediaFiles.mediaId }).from(mediaFiles)).map((row) => row.id),
    ).toEqual(['new']);
  });

  it('removes orphaned work directories but not those of running jobs or recent ones', () => {
    expect(report.workDirs).toBe(1);
    expect(existsSync(path.join(filesDir, '.work', ids.stale))).toBe(false);
    expect(existsSync(path.join(filesDir, '.work', ids.running))).toBe(true);
  });

  it('deletes uploads expired for longer than a job can run, with their tus metadata', async () => {
    expect(report.uploads).toBe(2);
    expect(existsSync(path.join(filesDir, '.uploads', 'old'))).toBe(false);
    expect(existsSync(path.join(filesDir, '.uploads', 'old.json'))).toBe(false);
    for (const kept of ['just-expired', 'just-expired.json', 'open', 'open.json']) {
      expect(existsSync(path.join(filesDir, '.uploads', kept)), kept).toBe(true);
    }
    expect(
      (await db.select({ path: uploads.path }).from(uploads)).map((row) => row.path).sort(),
    ).toEqual(['.uploads/just-expired', '.uploads/open']);
  });

  it('deletes cached inputs expired for longer than a job can run, unless another entry has the file', async () => {
    expect(report.inputs).toBe(2);
    expect(existsSync(path.join(filesDir, '.inputs', 'old'))).toBe(false);
    expect(existsSync(path.join(filesDir, '.inputs', 'shared'))).toBe(true);
    expect(existsSync(path.join(filesDir, '.inputs', 'just-expired'))).toBe(true);
    expect(
      (await db.select({ hash: inputs.contentHash }).from(inputs)).map((row) => row.hash).sort(),
    ).toEqual(['h3', 'h4']);
  });

  it('purges logs of jobs finished longer than FILE_TTL_DAYS ago', async () => {
    expect(report.logs).toBe(1);
    expect(await db.select().from(jobLogs).where(eq(jobLogs.jobId, ids.c))).toHaveLength(1);
  });

  it('does nothing on a second run', async () => {
    const again = await cleanup().run(now);
    expect(again).toEqual({
      outputs: 0,
      files: 0,
      mediaFiles: 0,
      workDirs: 0,
      logs: 0,
      uploads: 0,
      inputs: 0,
    });
  });
});
