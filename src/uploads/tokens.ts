import { createHmac, timingSafeEqual } from 'node:crypto';

/** Short-lived upload tokens (SPEC §4, §12): bound to one upload id; the API key never reaches a browser. */
export function uploadToken(secret: string, uploadId: string, expiresAt: Date): string {
  const expires = Math.floor(expiresAt.getTime() / 1000);
  const sig = createHmac('sha256', secret)
    .update(`upload:${uploadId}:${expires}`)
    .digest('base64url');
  return `${expires}.${sig}`;
}

export function verifyUploadToken(
  secret: string,
  uploadId: string,
  token: string | undefined,
  now = Date.now(),
): boolean {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token ?? '');
  if (!match?.[1] || !match[2]) return false;
  const expires = Number(match[1]);
  if (expires * 1000 <= now) return false;
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`upload:${uploadId}:${expires}`).digest('base64url'),
  );
  const given = Buffer.from(match[2]);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
