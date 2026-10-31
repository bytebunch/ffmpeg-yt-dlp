import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt } from 'drizzle-orm';

import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { inputs, outputs, uploads } from '../db/schema';
import { URL_RESOLVER } from '../discovery/discovery.service';
import { asRecord, isPlaylist } from '../discovery/mappers';
import { formatSelectionArgs } from '../discovery/presets';
import { DriveClient, type DriveFile, FOLDER_MIME } from '../drive/drive-client';
import { DriveConnections } from '../drive/drive-connections.service';
import { downloadArgs } from '../downloads/args';
import { classifyFile } from '../downloads/classify';
import { canonicalJson } from '../downloads/dedup';
import { downloadOptionsSchema } from '../downloads/options';
import { ffprobe, isAllowedFormat, type ProbeSummary } from '../media/ffprobe';
import { YtDlpRunner } from '../ytdlp/runner';
import { guardUrl, type Resolver } from '../ytdlp/url-guard';
import { fetchToFile, saveBody } from './fetch';
import type { Input } from './schemas';

const MB = 1024 * 1024;

/** SHA-256 of a file, streamed. */
async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
const BARE_NAME = /^[^/\\\0]+$/;

export interface InputOwner {
  clientId: string;
  clientName: string;
  userId: string;
  shareOutputsWithinClient: boolean;
}

export interface ResolvedInput {
  type: Input['type'];
  /** A display name for output naming: the upload's or inbox file's name, the URL's last segment. */
  name: string;
  /** Stands for the bytes (recipe dedup, SPEC §9d): equal identity, equal content. */
  identity: string;
  /** Absolute path of a local file; ffmpeg never opens a network URL (SPEC §5). */
  path: string;
  sizeBytes: number;
  probe: ProbeSummary;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The last path segment of a URL, or "input". */
function urlName(url: string): string {
  const raw = new URL(url).pathname.split('/').pop() ?? '';
  let segment = raw;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    // Malformed escapes: keep the segment as sent.
  }
  return segment.trim() === '' ? 'input' : segment.trim();
}

/** Turns an input description into a probed local file, enforcing each type's guardrails. */
@Injectable()
export class InputResolver {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(URL_RESOLVER) private readonly resolveDns: Resolver,
    private readonly drive: DriveConnections,
    private readonly ytdlp: YtDlpRunner,
  ) {}

  async resolve(
    input: Input,
    owner: InputOwner,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<ResolvedInput> {
    const maxBytes = options.maxBytes ?? this.config.MAX_FILE_SIZE_MB * MB;
    switch (input.type) {
      case 'upload':
        return this.fromUpload(input.uploadId, owner);
      case 'inbox':
        return this.fromInbox(input.name, owner, maxBytes);
      case 'output':
        return this.fromOutput(input.outputId, owner);
      case 'url':
        return this.fromUrl(input, owner, maxBytes, options.signal);
      case 'media_url':
        return this.fromMediaUrl(input.url, owner, maxBytes, options.signal);
      case 'google_drive':
        return this.fromDrive(input.fileId, owner, maxBytes);
    }
  }

  private async fromUpload(uploadId: string, owner: InputOwner): Promise<ResolvedInput> {
    const [upload] = await this.db
      .select()
      .from(uploads)
      .where(
        and(
          eq(uploads.id, uploadId),
          eq(uploads.clientId, owner.clientId),
          eq(uploads.userId, owner.userId),
        ),
      );
    if (!upload) throw new AppError('INPUT_NOT_FOUND', 'Upload not found');
    if (upload.expiresAt <= new Date())
      throw new AppError('UPLOAD_EXPIRED', 'The upload has expired');
    if (upload.status !== 'ready') {
      throw new AppError('UPLOAD_INCOMPLETE', `The upload is ${upload.status}, not ready`);
    }
    return this.checked(
      'upload',
      `upload:${upload.id}`,
      upload.filename,
      path.join(this.config.FILES_DIR, upload.path),
      upload.receivedSize,
      upload.probe as ProbeSummary | null,
    );
  }

  /** SPEC §12 inbox rules: bare names, no symlinks, realpath inside INBOX_DIR/<client>/. */
  private async fromInbox(
    name: string,
    owner: InputOwner,
    maxBytes: number,
  ): Promise<ResolvedInput> {
    if (!BARE_NAME.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
      throw new AppError('VALIDATION_FAILED', 'Inbox inputs take a bare file name');
    }
    const folder = path.join(this.config.INBOX_DIR, owner.clientName);
    const file = path.join(folder, name);
    const stats = await lstat(file).catch(() => undefined);
    if (!stats?.isFile()) throw new AppError('INPUT_NOT_FOUND', `No file "${name}" in the inbox`);
    const [realFolder, realFile] = await Promise.all([realpath(folder), realpath(file)]);
    if (!realFile.startsWith(`${realFolder}${path.sep}`))
      throw new AppError('INPUT_NOT_FOUND', `No file "${name}" in the inbox`);
    if (stats.size > maxBytes)
      throw new AppError('FILE_TOO_LARGE', 'The inbox file is larger than allowed');
    // Inbox files can be replaced in place: size and modification time are part of the identity.
    const identity = `inbox:${realFile}:${stats.size}:${stats.mtimeMs}`;
    return this.checked('inbox', identity, name, realFile, stats.size, null);
  }

  /** Reusing an output extends its expiry to FILE_TTL_DAYS from now (SPEC §10). */
  private async fromOutput(outputId: string, owner: InputOwner): Promise<ResolvedInput> {
    const [output] = await this.db
      .select()
      .from(outputs)
      .where(
        and(
          eq(outputs.id, outputId),
          eq(outputs.clientId, owner.clientId),
          eq(outputs.hidden, false),
          gt(outputs.expiresAt, new Date()),
        ),
      );
    const allowed = output && (output.userId === owner.userId || owner.shareOutputsWithinClient);
    if (!output || !allowed) throw new AppError('INPUT_NOT_FOUND', 'Output not found or expired');
    if (output.isDirectory)
      throw new AppError('INPUT_FORMAT_NOT_ALLOWED', 'Packages cannot be used as inputs');
    const expiresAt = new Date(Date.now() + this.config.FILE_TTL_DAYS * 86_400_000);
    await this.db.update(outputs).set({ expiresAt }).where(eq(outputs.id, output.id));
    // Stored files never change, and dedup hits share one path.
    return this.checked(
      'output',
      `file:${output.path}`,
      output.name,
      path.join(this.config.FILES_DIR, output.path),
      output.sizeBytes ?? 0,
      output.probe as ProbeSummary | null,
    );
  }

  /** Fetched once per source for INPUT_CACHE_HOURS; identical content is stored once per user. */
  private async fromUrl(
    input: Extract<Input, { type: 'url' }>,
    owner: InputOwner,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<ResolvedInput> {
    const source = { url: input.url, headers: input.headers ?? {} };
    const sourceHash = sha256(canonicalJson(source));
    const cached = await this.cached('url', owner, sourceHash, maxBytes, urlName(input.url));
    if (cached) return cached;
    const relative = path.join('.inputs', uuidv7());
    const target = path.join(this.config.FILES_DIR, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const fetched = await fetchToFile(input.url, target, {
      resolve: this.resolveDns,
      maxBytes,
      headers: input.headers,
      signal,
    });
    return this.remember(
      'url',
      owner,
      { source, sourceHash, relative, ...fetched },
      urlName(fetched.finalUrl),
    );
  }

  /**
   * SPEC §5 `google_drive`: files this service created (read with the user's token) or files
   * shared "anyone with the link" (read with GOOGLE_API_KEY). Cached like URL inputs.
   */
  private async fromDrive(
    fileId: string,
    owner: InputOwner,
    maxBytes: number,
  ): Promise<ResolvedInput> {
    const sourceHash = sha256(canonicalJson({ google_drive: fileId }));
    const cached = await this.cached('google_drive', owner, sourceHash, maxBytes);
    if (cached) return cached;
    const { client, file } = await this.driveReader(fileId, owner);
    if (file.mimeType === FOLDER_MIME)
      throw new AppError('INPUT_NOT_MEDIA', 'The Drive id is a folder, not a file');
    if (Number(file.size ?? 0) > maxBytes)
      throw new AppError('FILE_TOO_LARGE', 'The input is larger than allowed');
    const relative = path.join('.inputs', uuidv7());
    const target = path.join(this.config.FILES_DIR, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const saved = await saveBody(await client.media(fileId), target, maxBytes);
    return this.remember(
      'google_drive',
      owner,
      { source: { fileId, name: file.name }, sourceHash, relative, ...saved },
      file.name,
    );
  }

  /**
   * SPEC §5 `media_url`: a yt-dlp download from any supported site (best video and audio, merged),
   * with the same guard, duration and size caps as download jobs. Cached like URL inputs.
   */
  private async fromMediaUrl(
    url: string,
    owner: InputOwner,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<ResolvedInput> {
    const guarded = await guardUrl(url, this.resolveDns);
    const sourceHash = sha256(canonicalJson({ media_url: guarded.href }));
    const cached = await this.cached('media_url', owner, sourceHash, maxBytes);
    if (cached) return cached;
    const workDir = path.join(this.config.FILES_DIR, '.work', `input-${uuidv7()}`);
    const tempDir = path.join(workDir, '.tmp');
    await mkdir(tempDir, { recursive: true });
    try {
      const info = asRecord(
        await this.ytdlp.json(['--no-playlist', ...formatSelectionArgs('best')], guarded.href, {
          timeoutMs: this.config.PLAYLIST_EXPAND_TIMEOUT_SECONDS * 1000,
          ...(signal && { signal }),
        }),
      );
      this.checkMediaInfo(info);
      const infoFile = path.join(tempDir, 'source.info.json');
      await writeFile(infoFile, JSON.stringify(info));
      const options = downloadOptionsSchema.parse({
        preset: 'best',
        container: 'mkv',
        filename: 'id',
      });
      const args = downloadArgs(options, {
        workDir,
        tempDir,
        ffmpegLocation: path.isAbsolute(this.config.FFMPEG_BIN)
          ? this.config.FFMPEG_BIN
          : undefined,
        maxFileSizeMb: Math.max(1, Math.floor(maxBytes / MB)),
        sponsorblockApiUrl: this.config.SPONSORBLOCK_API_URL,
      });
      await this.ytdlp.run([...args, '--load-info-json', infoFile], undefined, {
        timeoutMs: this.config.JOB_TIMEOUT_MINUTES * 60_000,
        workDir,
        ...(signal && { signal }),
      });
      const [file] = (await readdir(workDir)).filter(
        (name) => classifyFile(name)?.role === 'media',
      );
      if (file === undefined) {
        // yt-dlp skips files over --max-filesize instead of failing.
        throw new AppError(
          'FILE_TOO_LARGE',
          `Inputs are limited to ${Math.floor(maxBytes / MB)} MB`,
        );
      }
      const relative = path.join('.inputs', uuidv7());
      const target = path.join(this.config.FILES_DIR, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(workDir, file), target);
      const { size } = await stat(target);
      const name = typeof info.title === 'string' ? `${info.title}.mkv` : file;
      return await this.remember(
        'media_url',
        owner,
        {
          source: { url: guarded.href, name },
          sourceHash,
          relative,
          sizeBytes: size,
          sha256: await fileSha256(target),
        },
        name,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** The download job's rules for one item: no playlists, no live streams, the duration cap. */
  private checkMediaInfo(info: Record<string, unknown>): void {
    if (isPlaylist(info))
      throw new AppError('VALIDATION_FAILED', 'A media_url input is one video, not a playlist');
    if (info.is_live === true)
      throw new AppError('VALIDATION_FAILED', 'A live stream cannot be an input; record it first');
    const duration = typeof info.duration === 'number' ? info.duration : undefined;
    if (duration !== undefined && duration > this.config.MAX_MEDIA_DURATION_MINUTES * 60) {
      throw new AppError(
        'MEDIA_TOO_LONG',
        `Media is limited to ${this.config.MAX_MEDIA_DURATION_MINUTES} minutes`,
        { duration_s: duration },
      );
    }
  }

  /** The user's own Drive first, then the API key for public files. */
  private async driveReader(
    fileId: string,
    owner: InputOwner,
  ): Promise<{ client: DriveClient; file: DriveFile }> {
    const readers: DriveClient[] = [];
    if (await this.drive.isConnected(owner)) readers.push((await this.drive.client(owner)).client);
    if (this.config.GOOGLE_API_KEY !== undefined)
      readers.push(new DriveClient({ apiKey: this.config.GOOGLE_API_KEY }));
    if (readers.length === 0) {
      throw new AppError(
        'DRIVE_NOT_CONNECTED',
        'Google Drive inputs need a Drive connection (POST /v1/drive/connect)',
      );
    }
    for (const client of readers) {
      try {
        return { client, file: await client.file(fileId) };
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'DRIVE_FOLDER_NOT_ACCESSIBLE'))
          throw error;
      }
    }
    throw new AppError(
      'INPUT_NOT_FOUND',
      'The Drive file does not exist, or it is private and was not created by this service',
    );
  }

  /** A cached input of this source, still on disk. */
  private async cached(
    type: Input['type'],
    owner: InputOwner,
    sourceHash: string,
    maxBytes: number,
    fallbackName?: string,
  ): Promise<ResolvedInput | undefined> {
    const [cached] = await this.db
      .select()
      .from(inputs)
      .where(
        and(
          eq(inputs.clientId, owner.clientId),
          eq(inputs.userId, owner.userId),
          eq(inputs.sourceHash, sourceHash),
          gt(inputs.expiresAt, new Date()),
        ),
      );
    if (!cached || !existsSync(path.join(this.config.FILES_DIR, cached.path))) return undefined;
    if (cached.sizeBytes > maxBytes)
      throw new AppError('FILE_TOO_LARGE', 'The input is larger than allowed');
    const name = (cached.source as { name?: unknown }).name;
    return this.checked(
      type,
      `sha256:${cached.contentHash}`,
      typeof name === 'string' ? name : (fallbackName ?? 'input'),
      path.join(this.config.FILES_DIR, cached.path),
      cached.sizeBytes,
      cached.probe as ProbeSummary | null,
    );
  }

  /** Checks a freshly fetched file and records it in the input cache, one copy per content. */
  private async remember(
    type: 'url' | 'google_drive' | 'media_url',
    owner: InputOwner,
    fetched: {
      source: object;
      sourceHash: string;
      relative: string;
      sizeBytes: number;
      sha256: string;
    },
    name: string,
  ): Promise<ResolvedInput> {
    const target = path.join(this.config.FILES_DIR, fetched.relative);
    let resolved: ResolvedInput;
    try {
      resolved = await this.checked(
        type,
        `sha256:${fetched.sha256}`,
        name,
        target,
        fetched.sizeBytes,
        null,
      );
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    const expiresAt = new Date(Date.now() + this.config.INPUT_CACHE_HOURS * 3_600_000);
    const [row] = await this.db
      .insert(inputs)
      .values({
        clientId: owner.clientId,
        userId: owner.userId,
        type,
        source: fetched.source,
        sourceHash: fetched.sourceHash,
        contentHash: fetched.sha256,
        path: fetched.relative,
        sizeBytes: fetched.sizeBytes,
        probe: resolved.probe,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [inputs.clientId, inputs.userId, inputs.contentHash],
        set: { sourceHash: fetched.sourceHash, expiresAt },
      })
      .returning({ path: inputs.path });
    if (row && row.path !== fetched.relative) {
      // Same bytes already stored for this user under another source: keep one copy.
      await rm(target, { force: true });
      return { ...resolved, path: path.join(this.config.FILES_DIR, row.path) };
    }
    return resolved;
  }

  /** Probes (unless a probe is stored) and applies the container allow-list (SPEC §5). */
  private async checked(
    type: Input['type'],
    identity: string,
    name: string,
    file: string,
    sizeBytes: number,
    stored: ProbeSummary | null,
  ): Promise<ResolvedInput> {
    let probe = stored;
    if (!probe) {
      try {
        probe = await ffprobe(this.config.FFPROBE_BIN, file);
      } catch {
        throw new AppError('INPUT_NOT_MEDIA', 'The input is not a readable media file');
      }
    }
    if (!isAllowedFormat(probe.format)) {
      throw new AppError(
        'INPUT_FORMAT_NOT_ALLOWED',
        `Input format "${probe.format ?? 'unknown'}" is not allowed`,
      );
    }
    return { type, identity, name, path: file, sizeBytes, probe };
  }
}
