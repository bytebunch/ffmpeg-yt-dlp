import { rm } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FileStore } from '@tus/file-store';
import { Server } from '@tus/server';
import { Upload as TusUpload } from '@tus/utils';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

import type { AuthContext } from '../auth/api-keys';
import { bearerToken, requireUserId } from '../auth/request-auth';
import { AppError } from '../common/errors';
import { isUuid, uuidv7 } from '../common/ids';
import { APP_CONFIG, DATABASE, REDIS } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { type Upload, uploads } from '../db/schema';
import { ffprobe, isAllowedFormat } from '../media/ffprobe';
import { uploadToken, verifyUploadToken } from './tokens';

const MB = 1024 * 1024;
const TUS_METHODS = new Set(['HEAD', 'PATCH', 'OPTIONS', 'DELETE']);

export interface UploadView {
  uploadId: string;
  filename: string;
  status: string;
  declared_size: number;
  received_size: number;
  probe: unknown;
  expiresAt: string;
}

/** tus answers a hook that throws a plain `{ status_code, body }` object with that status. */
function tusError(statusCode: number, body: string): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- the shape @tus/server expects
  throw { status_code: statusCode, body: `${body}\n` };
}

/** Control characters are single UTF-16 code units, so surrogate pairs pass through intact. */
function withoutControlCharacters(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) result += text.charAt(i);
  }
  return result;
}

/** A plain file name: no directories, no control characters, at most 255 bytes. */
export function cleanFilename(name: string): string {
  const base = withoutControlCharacters(path.basename(name.replace(/\\/g, '/'))).trim();
  if (base === '' || base === '.' || base === '..')
    throw new AppError('VALIDATION_FAILED', 'filename is not valid');
  return Buffer.from(base).length > 255 ? base.slice(0, 200) : base;
}

/**
 * Resumable uploads (SPEC §4 Inputs): POST /v1/uploads creates the upload in the tus file store;
 * the client then sends the bytes to /u/:id (tus 1.0 HEAD/PATCH) with its upload token.
 */
@Injectable()
export class UploadsService implements OnModuleInit {
  private readonly logger = new Logger(UploadsService.name);
  private store!: FileStore;
  private tus!: Server;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.store = new FileStore({ directory: path.join(this.config.FILES_DIR, '.uploads') });
    this.tus = new Server({
      path: '/u',
      datastore: this.store,
      maxSize: this.config.MAX_UPLOAD_SIZE_MB * MB,
      respectForwardedHeaders: true,
      onIncomingRequest: async (request, uploadId) => this.authorize(request, uploadId),
      onUploadFinish: async (_request, upload) => {
        await this.finish(upload.id);
        return {};
      },
    });
  }

  /** Mounts /u/:id on Fastify; creation (POST) and download (GET) stay closed. */
  mount(fastify: FastifyInstance): void {
    fastify.addContentTypeParser('application/offset+octet-stream', (_request, _payload, done) => {
      done(null);
    });
    fastify.route({
      method: ['HEAD', 'PATCH', 'OPTIONS', 'DELETE', 'GET', 'POST'],
      url: '/u/:id',
      handler: async (request, reply) => {
        if (!TUS_METHODS.has(request.method)) {
          await reply.status(405).send({
            error: { code: 'NOT_FOUND', message: 'Uploads are created with POST /v1/uploads' },
          });
          return;
        }
        reply.hijack();
        await this.tus.handle(request.raw, reply.raw);
      },
    });
  }

  private async authorize(request: Request, uploadId: string): Promise<void> {
    if (!isUuid(uploadId)) tusError(404, 'Upload not found');
    if (request.method === 'OPTIONS') return;
    const token = bearerToken(request.headers.get('authorization') ?? undefined);
    if (!verifyUploadToken(this.config.LINK_SIGNING_SECRET, uploadId, token)) {
      tusError(401, 'A valid upload token is required');
    }
    const [upload] = await this.db.select().from(uploads).where(eq(uploads.id, uploadId));
    if (!upload || upload.expiresAt <= new Date()) tusError(410, 'Upload expired');
    if (request.method === 'PATCH' && upload.status !== 'uploading')
      tusError(409, 'Upload already finished');
  }

  /** Probes the finished file; only allowed containers become usable inputs. */
  private async finish(uploadId: string): Promise<void> {
    const [upload] = await this.db.select().from(uploads).where(eq(uploads.id, uploadId));
    if (!upload) return;
    const file = path.join(this.config.FILES_DIR, upload.path);
    let status = 'rejected';
    let probe = null;
    try {
      probe = await ffprobe(this.config.FFPROBE_BIN, file);
      if (isAllowedFormat(probe.format)) status = 'ready';
    } catch (error) {
      this.logger.warn({ err: error, uploadId }, 'Uploaded file is not readable media');
    }
    await this.db
      .update(uploads)
      .set({ status, probe, receivedSize: upload.declaredSize })
      .where(eq(uploads.id, uploadId));
  }

  async create(
    auth: AuthContext,
    body: { filename: string; size: number; mime?: string | undefined },
  ): Promise<UploadView & { tusUrl: string; uploadToken: string }> {
    const userId = requireUserId(auth);
    const filename = cleanFilename(body.filename);
    if (body.size > this.config.MAX_UPLOAD_SIZE_MB * MB) {
      throw new AppError(
        'FILE_TOO_LARGE',
        `Uploads are limited to ${this.config.MAX_UPLOAD_SIZE_MB} MB`,
      );
    }
    const day = new Date().toISOString().slice(0, 10);
    const quotaKey = `media:quota:upload:${auth.clientId}:${userId}:${day}`;
    const [[, total] = []] =
      (await this.redis
        .multi()
        .incrby(quotaKey, body.size)
        .expire(quotaKey, 2 * 86_400)
        .exec()) ?? [];
    if (Number(total) > this.config.USER_MAX_UPLOAD_MB_PER_DAY * MB) {
      await this.redis.decrby(quotaKey, body.size);
      throw new AppError(
        'QUOTA_EXCEEDED',
        `This user may upload ${this.config.USER_MAX_UPLOAD_MB_PER_DAY} MB per day`,
      );
    }
    const id = uuidv7();
    const expiresAt = new Date(Date.now() + this.config.UPLOAD_TTL_HOURS * 3_600_000);
    await this.store.create(
      new TusUpload({ id, size: body.size, offset: 0, metadata: { filename } }),
    );
    await this.db.insert(uploads).values({
      id,
      clientId: auth.clientId,
      userId,
      filename,
      mime: body.mime ?? null,
      declaredSize: body.size,
      path: path.join('.uploads', id),
      status: 'uploading',
      expiresAt,
    });
    return {
      ...(await this.get(auth, id)),
      tusUrl: `${this.config.PUBLIC_BASE_URL}/u/${id}`,
      uploadToken: uploadToken(this.config.LINK_SIGNING_SECRET, id, expiresAt),
    };
  }

  async get(auth: AuthContext, id: string): Promise<UploadView> {
    const upload = await this.find(auth, id);
    let received = upload.receivedSize;
    if (upload.status === 'uploading') {
      received = (await this.store.getUpload(id).catch(() => ({ offset: 0 }))).offset;
    }
    const expired = upload.expiresAt <= new Date();
    return {
      uploadId: upload.id,
      filename: upload.filename,
      status: expired && upload.status !== 'ready' ? 'expired' : upload.status,
      declared_size: upload.declaredSize,
      received_size: received,
      probe: upload.probe,
      expiresAt: upload.expiresAt.toISOString(),
    };
  }

  async remove(auth: AuthContext, id: string): Promise<{ deleted: true }> {
    const upload = await this.find(auth, id);
    await this.deleteFiles(upload);
    await this.db.delete(uploads).where(eq(uploads.id, upload.id));
    return { deleted: true };
  }

  async deleteFiles(upload: Pick<Upload, 'path'>): Promise<void> {
    const file = path.join(this.config.FILES_DIR, upload.path);
    await Promise.all([rm(file, { force: true }), rm(`${file}.json`, { force: true })]);
  }

  private async find(auth: AuthContext, id: string): Promise<Upload> {
    const userId = requireUserId(auth);
    if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Upload not found');
    const [upload] = await this.db
      .select()
      .from(uploads)
      .where(
        and(eq(uploads.id, id), eq(uploads.clientId, auth.clientId), eq(uploads.userId, userId)),
      );
    if (!upload) throw new AppError('NOT_FOUND', 'Upload not found');
    return upload;
  }
}
