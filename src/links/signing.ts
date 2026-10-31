import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed links (SPEC §10): HMAC-SHA256 over the output id and the expiry, so one token covers
 * one output (and every file beneath a package output) until it expires.
 */
export function signature(secret: string, outputId: string, expires: number): string {
  return createHmac('sha256', secret).update(`${outputId}.${expires}`).digest('base64url');
}

export function signedPath(secret: string, outputId: string, expiresAt: Date): string {
  const expires = Math.floor(expiresAt.getTime() / 1000);
  return `/d/${outputId}?exp=${expires}&sig=${signature(secret, outputId, expires)}`;
}

/**
 * Packages (HLS, DASH, storyboards) put the token in the path, so the relative URLs inside a
 * playlist (segments, variants) carry it too: /d/hls/<outputId>/<exp>/<sig>/<file>.
 */
export function signedPackagePath(
  secret: string,
  outputId: string,
  expiresAt: Date,
  entry: string,
): string {
  const expires = Math.floor(expiresAt.getTime() / 1000);
  return `/d/hls/${outputId}/${expires}/${signature(secret, outputId, expires)}/${encodePath(entry)}`;
}

/** One token for a whole job's ZIP or M3U: the signature covers `job:<id>`. */
export function signedJobPath(
  secret: string,
  jobId: string,
  ext: 'zip' | 'm3u',
  expiresAt: Date,
): string {
  const expires = Math.floor(expiresAt.getTime() / 1000);
  return `/d/job/${jobId}.${ext}?exp=${expires}&sig=${signature(secret, `job:${jobId}`, expires)}`;
}

/** True when the signature matches and the link has not expired. Constant-time comparison. */
export function verifySignature(
  secret: string,
  outputId: string,
  exp: string | undefined,
  sig: string | undefined,
  now: number = Date.now(),
): boolean {
  if (exp === undefined || sig === undefined || !/^\d{1,12}$/.test(exp)) return false;
  const expires = Number(exp);
  if (expires * 1000 <= now) return false;
  const expected = Buffer.from(signature(secret, outputId, expires));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** RFC 6266 Content-Disposition with an ASCII fallback and the exact UTF-8 name. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Each path segment percent-encoded, for X-Accel-Redirect (nginx decodes it again). */
export function encodePath(relativePath: string): string {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}
