import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';

import { Public } from '../auth/request-auth';
import { AppError } from '../common/errors';
import { isUuid } from '../common/ids';
import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { jobs, outputs } from '../db/schema';
import { JobsService } from '../jobs/jobs.service';
import { contentDisposition, encodePath, verifySignature } from './signing';
import { ZipFile } from 'yazl';

const JOB_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(zip|m3u)$/;
const PACKAGE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** Content types of the files inside packages (HLS, DASH, storyboards). */
const PACKAGE_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.vtt': 'text/vtt',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
};

/** Every file under a directory, relative paths included, for package ZIPs. */
async function filesUnder(
  dir: string,
  prefix = '',
): Promise<{ absolute: string; relative: string }[]> {
  const found: { absolute: string; relative: string }[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const absolute = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await filesUnder(absolute, relative)));
    else if (entry.isFile()) found.push({ absolute, relative });
  }
  return found;
}

/** Unique names inside a ZIP: "name.mp4", "name (2).mp4", … */
export function uniqueName(name: string, taken: Set<string>): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base} (${n})${ext}`;
  taken.add(candidate);
  return candidate;
}

/**
 * Signed downloads (SPEC §10). The API checks the signature and expiry, then hands the file to
 * nginx with X-Accel-Redirect; nginx streams it with Range support.
 */
@ApiExcludeController()
@Public()
@Controller('d')
export class LinksController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobsService: JobsService,
  ) {}

  /**
   * SPEC §10: a store-only ZIP of a job's outputs, streamed (no extra disk, no Range), or an M3U
   * playlist of its media links. One token signs the whole job.
   */
  @Get('job/:file')
  async jobPackage(
    @Param('file') file: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const match = JOB_FILE.exec(file);
    const jobId = match?.[1];
    if (!jobId || !verifySignature(this.config.LINK_SIGNING_SECRET, `job:${jobId}`, exp, sig)) {
      throw new AppError('NOT_FOUND', 'This link is invalid or has expired');
    }
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job) throw new AppError('NOT_FOUND', 'This link is invalid or has expired');
    const items = await this.jobsService.jobOutputs(job);
    const indexOf = new Map<string, number | null>();
    if (job.kind === 'parent') {
      const children = await this.db
        .select({ id: jobs.id, index: jobs.playlistIndex })
        .from(jobs)
        .where(eq(jobs.parentJobId, job.id));
      for (const child of children) indexOf.set(child.id, child.index);
    }
    void reply.header('cache-control', 'private, no-store');

    if (match[2] === 'm3u') {
      const lines = ['#EXTM3U'];
      for (const output of items.filter((item) => item.role === 'media' || item.role === 'audio')) {
        const view = this.jobsService.outputView(output);
        lines.push(
          `#EXTINF:${Math.round(output.durationS ?? -1)},${output.name.replace(/[\r\n]/g, ' ')}`,
          view.url,
        );
      }
      await reply
        .header('content-type', 'audio/x-mpegurl; charset=utf-8')
        .header('content-disposition', contentDisposition(`${job.id}.m3u`))
        .send(`${lines.join('\n')}\n`);
      return;
    }

    const zip = new ZipFile();
    const taken = new Set<string>();
    for (const output of items) {
      const absolute = path.join(this.config.FILES_DIR, output.path);
      if (!existsSync(absolute)) continue;
      const index = indexOf.get(output.jobId);
      const name =
        index == null ? output.name : `${String(index).padStart(3, '0')} - ${output.name}`;
      if (!output.isDirectory) {
        zip.addFile(absolute, uniqueName(name, taken), { compress: false });
        continue;
      }
      // Packages keep their layout inside the ZIP, under the output's name.
      const folder = uniqueName(name, taken);
      for (const file of await filesUnder(absolute))
        zip.addFile(file.absolute, `${folder}/${file.relative}`, { compress: false });
    }
    zip.end();
    await reply
      .header('content-type', 'application/zip')
      .header('content-disposition', contentDisposition(`${job.id}.zip`))
      .send(zip.outputStream);
  }

  /**
   * Files inside a package output (SPEC §8i: /d/hls/:outputId/…). The token sits in the path so
   * the playlists' relative URLs keep it; nginx streams each file.
   */
  @Get('hls/:outputId/:exp/:sig/*')
  async packageFile(
    @Param('outputId') outputId: string,
    @Param('exp') exp: string,
    @Param('sig') sig: string,
    @Param('*') rest: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const invalid = new AppError('NOT_FOUND', 'This link is invalid or has expired');
    const segments = rest.split('/');
    if (
      !isUuid(outputId) ||
      !verifySignature(this.config.LINK_SIGNING_SECRET, outputId, exp, sig) ||
      segments.length > 4 ||
      !segments.every((segment) => PACKAGE_SEGMENT.test(segment))
    ) {
      throw invalid;
    }
    const [output] = await this.db
      .select()
      .from(outputs)
      .where(
        and(eq(outputs.id, outputId), eq(outputs.hidden, false), gt(outputs.expiresAt, new Date())),
      );
    if (!output?.isDirectory) throw invalid;
    const type = PACKAGE_TYPES[path.extname(rest).toLowerCase()];
    if (!type) throw invalid;
    await reply
      .status(200)
      .header(
        'x-accel-redirect',
        `${this.config.NGINX_INTERNAL_FILES_PREFIX}${encodePath(`${output.path}/${rest}`)}`,
      )
      .header('content-type', type)
      .header('cache-control', 'private, max-age=3600')
      // Players fetch segments from other origins (web apps).
      .header('access-control-allow-origin', '*')
      .send();
  }

  @Get(':outputId')
  async download(
    @Param('outputId') outputId: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const invalid = new AppError('NOT_FOUND', 'This link is invalid or has expired');
    if (
      !isUuid(outputId) ||
      !verifySignature(this.config.LINK_SIGNING_SECRET, outputId, exp, sig)
    ) {
      throw invalid;
    }
    const [output] = await this.db
      .select()
      .from(outputs)
      .where(
        and(eq(outputs.id, outputId), eq(outputs.hidden, false), gt(outputs.expiresAt, new Date())),
      );
    if (!output || output.isDirectory) throw invalid;
    await reply
      .status(200)
      .header(
        'x-accel-redirect',
        `${this.config.NGINX_INTERNAL_FILES_PREFIX}${encodePath(output.path)}`,
      )
      .header('content-type', output.mime ?? 'application/octet-stream')
      .header('content-disposition', contentDisposition(output.name))
      .header('cache-control', 'private, no-store')
      .send();
  }
}
