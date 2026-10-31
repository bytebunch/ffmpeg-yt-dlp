import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AppError } from '../common/errors';
import { guardUrl, type Resolver } from '../ytdlp/url-guard';

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; media-service)';

export interface FetchedFile {
  sizeBytes: number;
  sha256: string;
  contentType: string;
  finalUrl: string;
}

/** SPEC §5: only audio, video, image or generic binary bodies become inputs. */
export function isMediaContentType(value: string | null): boolean {
  const type = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^(audio|video|image)\//.test(type) || type === 'application/octet-stream' || type === '';
}

function tooLarge(maxBytes: number): AppError {
  return new AppError(
    'FILE_TOO_LARGE',
    `Inputs are limited to ${Math.floor(maxBytes / 1024 / 1024)} MB`,
    {
      max_bytes: maxBytes,
    },
  );
}

/**
 * Streams a URL to `target` (SPEC §5 `url` inputs): redirects followed manually (≤ 5) with the URL
 * guard re-applied on every hop, content type checked, size capped while streaming, SHA-256
 * computed on the way.
 */
export async function fetchToFile(
  url: string,
  target: string,
  options: {
    resolve: Resolver;
    maxBytes: number;
    headers?: { Referer?: string | undefined; 'User-Agent'?: string | undefined } | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<FetchedFile> {
  let current = url;
  for (let hop = 0; ; hop++) {
    await guardUrl(current, options.resolve);
    const response = await fetch(current, {
      redirect: 'manual',
      signal: options.signal ?? null,
      headers: {
        'user-agent': options.headers?.['User-Agent'] ?? DEFAULT_USER_AGENT,
        ...(options.headers?.Referer ? { referer: options.headers.Referer } : {}),
      },
    });
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (location === null || hop >= MAX_REDIRECTS) {
        throw new AppError('URL_NOT_ALLOWED', `More than ${MAX_REDIRECTS} redirects`);
      }
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new AppError(
        response.status === 404 || response.status === 410 ? 'INPUT_NOT_FOUND' : 'UNAVAILABLE',
        `The URL answered HTTP ${response.status}`,
      );
    }
    const contentType = response.headers.get('content-type');
    if (!isMediaContentType(contentType)) {
      await response.body.cancel();
      throw new AppError(
        'INPUT_NOT_MEDIA',
        `The URL serves ${contentType ?? 'unknown content'}, not media`,
      );
    }
    if (Number(response.headers.get('content-length') ?? 0) > options.maxBytes) {
      await response.body.cancel();
      throw tooLarge(options.maxBytes);
    }
    const saved = await saveBody(response, target, options.maxBytes);
    return { ...saved, contentType: contentType ?? '', finalUrl: current };
  }
}

/** Streams a response body to `target`, capped at `maxBytes` while streaming, hashing it on the way. */
export async function saveBody(
  response: Response,
  target: string,
  maxBytes: number,
): Promise<{ sizeBytes: number; sha256: string }> {
  if (!response.body) throw new AppError('UNAVAILABLE', 'The response has no body');
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(tooLarge(maxBytes));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(target));
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  return { sizeBytes: size, sha256: hash.digest('hex') };
}
