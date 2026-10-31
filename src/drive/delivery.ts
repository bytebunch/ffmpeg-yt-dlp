import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { APP_CONFIG, DATABASE, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { type Job, jobs, type Output, outputs, watches } from '../db/schema';
import { publishStatus } from '../jobs/job-state';
import { driveDestination, type DriveDestination } from './destination';
import type { DriveClient } from './drive-client';
import { DriveConnections, folderLink, type Owner } from './drive-connections.service';

/** Types of the files inside HLS/DASH packages and frame sets. */
const PACKAGE_MIME: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.vtt': 'text/vtt',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

/** Drive file names: no slashes or control characters, at most 200 characters. */
const folderName = (name: string) => {
  let clean = '';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    clean += code < 0x20 || code === 0x7f || code === 0x2f || code === 0x5c ? ' ' : name.charAt(i);
  }
  return clean.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled';
};

/**
 * Puts a finished job's outputs into the user's Drive (SPEC §11): into the root folder or
 * `folderId`, playlists and batches into a sub-folder of their own, multi-output jobs into one
 * named after the job, packages as a folder tree. Local files stay for the TTL as a fallback.
 * Safe to retry: uploaded outputs and created folders are recorded as it goes.
 */
@Injectable()
export class DriveDelivery {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly connections: DriveConnections,
  ) {}

  async deliver(jobId: string, signal: AbortSignal): Promise<void> {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId));
    const destination = driveDestination(job?.destination);
    // Finished meanwhile (cancelled, retried), or not a Drive job: nothing to do.
    if (!job || !destination || job.status !== 'running' || job.stage !== 'uploading') return;
    const owner = { clientId: job.clientId, userId: job.userId };
    const { client } = await this.connections.client(owner);
    const visible = await this.db
      .select()
      .from(outputs)
      .where(
        and(
          eq(outputs.jobId, job.id),
          eq(outputs.hidden, false),
          gt(outputs.expiresAt, new Date()),
        ),
      )
      .orderBy(asc(outputs.createdAt));
    const pending = visible.filter((output) => output.driveFileId === null);
    if (pending.length > 0) {
      const folder = await this.targetFolder(job, destination, owner, client, visible);
      for (const output of pending) {
        if (signal.aborted) break;
        await this.upload(output, folder, client);
      }
    }
    const status = signal.aborted ? 'cancelled' : (destination._status ?? 'completed');
    await this.db
      .update(jobs)
      .set({ status, stage: null, finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
    await publishStatus(this.redis, job.id, status);
  }

  /** The folder this job's outputs go into. */
  private async targetFolder(
    job: Job,
    destination: DriveDestination,
    owner: Owner,
    client: DriveClient,
    visible: Output[],
  ): Promise<string> {
    const base = async () =>
      destination.folderId !== undefined
        ? (await client.folder(destination.folderId)).id
        : this.connections.ensureRoot(owner, client);
    if (job.kind === 'item' && job.parentJobId !== null)
      return this.groupFolder(job.parentJobId, base, client);
    if (job.kind === 'parent') return this.groupFolder(job.id, base, client);
    if (visible.length <= 1) return base();
    return this.groupFolder(job.id, base, client, () => this.jobFolderName(job, visible));
  }

  /**
   * A sub-folder made once per playlist, batch or multi-output job and kept on its row (locked
   * meanwhile, so items finishing together share it). A watch's batches share the watch's folder.
   */
  private async groupFolder(
    ownerJobId: string,
    base: () => Promise<string>,
    client: DriveClient,
    fallbackName?: () => string,
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(jobs).where(eq(jobs.id, ownerJobId)).for('update');
      const destination = driveDestination(row?.destination) ?? { type: 'google_drive' as const };
      if (destination._folder !== undefined) return destination._folder;
      const watchId = (row?.options as { watch_id?: string } | undefined)?.watch_id;
      const [watch] =
        watchId === undefined
          ? []
          : await tx.select().from(watches).where(eq(watches.id, watchId)).for('update');
      const watchFolder = driveDestination(watch?.destination)?._folder;
      const folder =
        watchFolder ??
        (
          await client.createFolder(
            folderName(destination._name ?? fallbackName?.() ?? `Job ${ownerJobId.slice(0, 8)}`),
            await base(),
          )
        ).id;
      await tx
        .update(jobs)
        .set({ destination: { ...destination, _folder: folder } })
        .where(eq(jobs.id, ownerJobId));
      if (watch && watchFolder === undefined) {
        const watchDestination = driveDestination(watch.destination) ?? {
          type: 'google_drive' as const,
        };
        await tx
          .update(watches)
          .set({ destination: { ...watchDestination, _folder: folder } })
          .where(eq(watches.id, watch.id));
      }
      return folder;
    });
  }

  /** A download's sub-folder takes the media file's name; a recipe's its job id. */
  private jobFolderName(job: Job, visible: Output[]): string {
    const media = visible.find((output) => output.role === 'media' || output.role === 'audio');
    return media && job.type === 'download'
      ? media.name.replace(/\.[^.]+$/, '')
      : `Job ${job.id.slice(0, 8)}`;
  }

  private async upload(output: Output, parentId: string, client: DriveClient): Promise<void> {
    const local = path.join(this.config.FILES_DIR, output.path);
    const uploaded = output.isDirectory
      ? await this.uploadTree(local, output.name, parentId, client)
      : await this.uploadFile(
          local,
          output.name,
          output.mime ?? 'application/octet-stream',
          parentId,
          client,
        );
    await this.db
      .update(outputs)
      .set({ driveFileId: uploaded.id, driveLink: uploaded.link, driveFolderId: parentId })
      .where(eq(outputs.id, output.id));
  }

  private async uploadFile(
    local: string,
    name: string,
    mime: string,
    parentId: string,
    client: DriveClient,
  ): Promise<{ id: string; link: string }> {
    const file = await client.upload(local, {
      name,
      mime,
      parentId,
      size: (await stat(local)).size,
    });
    return {
      id: file.id,
      link: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
    };
  }

  /** A package directory becomes a Drive folder with the same tree. */
  private async uploadTree(
    dir: string,
    name: string,
    parentId: string,
    client: DriveClient,
  ): Promise<{ id: string; link: string }> {
    const folder = await client.createFolder(folderName(name), parentId);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.uploadTree(full, entry.name, folder.id, client);
      } else if (entry.isFile()) {
        const mime =
          PACKAGE_MIME[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream';
        await this.uploadFile(full, entry.name, mime, folder.id, client);
      }
    }
    return { id: folder.id, link: folderLink(folder.id) };
  }
}
