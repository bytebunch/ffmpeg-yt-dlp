import { open } from 'node:fs/promises';

import { AppError } from '../common/errors';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** SPEC §11: 8 MB chunks; Drive needs multiples of 256 KiB. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 6;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  webViewLink?: string;
  parents?: string[];
  trashed?: boolean;
}

export interface DriveClientOptions {
  /** A valid access token; `refresh` forces a new one after a 401. */
  token?: (refresh?: boolean) => Promise<string>;
  /** GOOGLE_API_KEY instead of a token: public ("anyone with the link") files only. */
  apiKey?: string;
  /** Backoff between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  chunkBytes?: number;
}

interface GoogleError {
  error?: { code?: number; message?: string; errors?: { reason?: string }[] };
}

const FILE_FIELDS = 'id,name,mimeType,size,createdTime,webViewLink,parents,trashed';
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A retryable answer: 429, 5xx, or a 403 rate limit (SPEC §11: exponential backoff). */
class Retryable extends Error {}

async function reasons(response: Response): Promise<{ reasons: string[]; message: string }> {
  const body = (await response.json().catch(() => ({}))) as GoogleError;
  return {
    reasons: (body.error?.errors ?? []).flatMap((entry) => (entry.reason ? [entry.reason] : [])),
    message: body.error?.message ?? response.statusText,
  };
}

/** Google's answer → an AppError, or Retryable for what backoff may fix. */
async function failure(response: Response, what: string): Promise<Error> {
  const { reasons: why, message } = await reasons(response);
  if (response.status === 429 || response.status >= 500)
    return new Retryable(`${what}: ${response.status}`);
  if (
    response.status === 403 &&
    why.some((reason) => /rateLimitExceeded|userRateLimitExceeded/.test(reason))
  ) {
    return new Retryable(`${what}: rate limited`);
  }
  if (response.status === 403 && why.includes('storageQuotaExceeded')) {
    return new AppError('DRIVE_STORAGE_FULL', 'The Google Drive is full', undefined, {}, false);
  }
  if (
    response.status === 404 ||
    (response.status === 403 &&
      why.some((reason) =>
        /insufficientFilePermissions|forbidden|appNotAuthorizedToFile/.test(reason),
      ))
  ) {
    return new AppError(
      'DRIVE_FOLDER_NOT_ACCESSIBLE',
      `${what}: not found or not created by this service`,
      undefined,
      {},
      false,
    );
  }
  return new AppError('UNAVAILABLE', `${what} failed: ${message}`);
}

/**
 * Drive v3 under the drive.file scope (SPEC §11): folders, listing, and resumable uploads in
 * 8 MB chunks with per-chunk retry and resume from the offset Drive confirms.
 */
export class DriveClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chunkBytes: number;

  constructor(private readonly options: DriveClientOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFile> {
    return this.json(`${API}/files?fields=${FILE_FIELDS}`, 'Creating a Drive folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        ...(parentId !== undefined && { parents: [parentId] }),
      }),
    });
  }

  /** A folder this service created and the user has not trashed, else DRIVE_FOLDER_NOT_ACCESSIBLE. */
  async folder(id: string): Promise<DriveFile> {
    const file = await this.file(id);
    if (file.mimeType !== FOLDER_MIME || file.trashed === true) {
      throw new AppError(
        'DRIVE_FOLDER_NOT_ACCESSIBLE',
        'folderId is not a folder this service can write to',
        undefined,
        {},
        false,
      );
    }
    return file;
  }

  /** The file's bytes, as a response to stream (SPEC §5 `google_drive` inputs). */
  async media(id: string): Promise<Response> {
    return this.withRetry('Reading a Drive file', async () => {
      const response = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media`, {});
      if (!response.ok) throw await failure(response, 'Reading a Drive file');
      return response;
    });
  }

  async file(id: string): Promise<DriveFile> {
    return this.json(
      `${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`,
      'Reading a Drive file',
    );
  }

  /** Files and folders this service created (drive.file sees nothing else), newest first. */
  async list(
    pageToken: string | undefined,
    pageSize: number,
  ): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const query = new URLSearchParams({
      q: 'trashed = false',
      orderBy: 'createdTime desc',
      pageSize: String(pageSize),
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      ...(pageToken !== undefined && { pageToken }),
    });
    return this.json(`${API}/files?${query.toString()}`, 'Listing Drive files');
  }

  /** Uploads a local file into `parentId`; returns the Drive file. */
  async upload(
    path: string,
    meta: { name: string; mime: string; parentId: string; size: number },
  ): Promise<DriveFile> {
    const session = await this.withRetry('Starting a Drive upload', async () => {
      const response = await this.request(`${UPLOAD}?uploadType=resumable&fields=${FILE_FIELDS}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-upload-content-type': meta.mime,
          'x-upload-content-length': String(meta.size),
        },
        body: JSON.stringify({ name: meta.name, parents: [meta.parentId] }),
      });
      const location = response.headers.get('location');
      if (!response.ok || location === null)
        throw await failure(response, 'Starting a Drive upload');
      return location;
    });
    if (meta.size === 0) return this.finishEmpty(session);
    const handle = await open(path, 'r');
    try {
      let offset = 0;
      for (;;) {
        const length = Math.min(this.chunkBytes, meta.size - offset);
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, offset);
        const sent = offset;
        const result = await this.withRetry('Uploading to Drive', async (attempt) => {
          if (attempt > 0) {
            // After a failed attempt Drive says what it holds; the loop re-reads from there.
            const held = await this.confirmed(session, meta.size);
            if (typeof held !== 'number') return held; // the whole file arrived
            if (held !== sent) return { offset: held };
          }
          return this.putChunk(session, chunk, sent, meta.size);
        });
        if ('id' in result) return result;
        offset = result.offset;
        if (offset >= meta.size)
          throw new AppError(
            'UNAVAILABLE',
            'Drive accepted every byte but did not finish the upload',
          );
      }
    } finally {
      await handle.close();
    }
  }

  /** One chunk: 308 with the confirmed range, or the finished file. */
  private async putChunk(
    session: string,
    chunk: Buffer,
    from: number,
    total: number,
  ): Promise<DriveFile | { offset: number }> {
    const response = await this.request(session, {
      method: 'PUT',
      headers: { 'content-range': `bytes ${from}-${from + chunk.length - 1}/${total}` },
      body: new Uint8Array(chunk),
    });
    if (response.status === 308) return { offset: nextOffset(response) };
    if (response.ok) return (await response.json()) as DriveFile;
    throw await failure(response, 'Uploading to Drive');
  }

  /** How many bytes the session holds (or the finished file). */
  private async confirmed(session: string, total: number): Promise<number | DriveFile> {
    const response = await this.request(session, {
      method: 'PUT',
      headers: { 'content-range': `bytes */${total}` },
    });
    if (response.status === 308) return nextOffset(response);
    if (response.ok) return (await response.json()) as DriveFile;
    throw await failure(response, 'Resuming a Drive upload');
  }

  private async finishEmpty(session: string): Promise<DriveFile> {
    return this.withRetry('Uploading to Drive', async () => {
      const response = await this.request(session, {
        method: 'PUT',
        headers: { 'content-range': 'bytes */0' },
      });
      if (response.ok) return (await response.json()) as DriveFile;
      throw await failure(response, 'Uploading to Drive');
    });
  }

  private async json<T>(url: string, what: string, init: RequestInit = {}): Promise<T> {
    return this.withRetry(what, async () => {
      const response = await this.request(url, init);
      if (!response.ok) throw await failure(response, what);
      return (await response.json()) as T;
    });
  }

  /** Authorised request; one token refresh on 401. Network errors are retryable. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    const { token, apiKey } = this.options;
    const send = async (refresh: boolean) => {
      const headers = new Headers(init.headers);
      let target = url;
      if (token) {
        headers.set('authorization', `Bearer ${await token(refresh)}`);
      } else if (apiKey !== undefined) {
        const keyed = new URL(url);
        keyed.searchParams.set('key', apiKey);
        target = keyed.href;
      }
      try {
        return await fetch(target, { ...init, headers });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new Retryable(`Network error: ${(error as Error).message}`);
      }
    };
    const response = await send(false);
    return response.status === 401 && token ? send(true) : response;
  }

  /** Exponential backoff with jitter (1 s, 2 s, 4 s … 32 s) for Retryable failures. */
  private async withRetry<T>(what: string, run: (attempt: number) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run(attempt);
      } catch (error) {
        if (!(error instanceof Retryable)) throw error;
        if (attempt + 1 >= MAX_ATTEMPTS)
          throw new AppError(
            'UNAVAILABLE',
            `${what}: Google Drive kept failing (${error.message})`,
          );
        await this.sleep(Math.min(32_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250));
      }
    }
  }
}

/** `Range: bytes=0-N` → N + 1; no Range means nothing was stored yet. */
function nextOffset(response: Response): number {
  const range = /bytes=0-(\d+)/.exec(response.headers.get('range') ?? '');
  return range?.[1] === undefined ? 0 : Number(range[1]) + 1;
}
