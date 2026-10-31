import { and, inArray, sql } from 'drizzle-orm';

import { decryptSecret, type EncryptionKeys, encryptSecret } from '../common/secrets';
import type { Database } from '../db/database';
import { jobs } from '../db/schema';
import { SEALED_FIELDS, type SealedSecrets } from './options';

/** Where a job keeps its sealed per-request secrets; "_" keys never appear in job views. */
export const SECRETS_KEY = '_secrets';

interface Owner {
  clientId: string;
  userId: string;
}

const context = (owner: Owner) => `job-secrets:${owner.clientId}:${owner.userId}`;

/**
 * Moves `video_password` and `tv_provider` out of a request's options into one encrypted
 * `_secrets` value (SPEC §7f: per request, not stored in clear). Other options are untouched.
 */
export function sealSecrets(
  keys: EncryptionKeys,
  owner: Owner,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const secrets = Object.fromEntries(
    SEALED_FIELDS.filter((field) => options[field] !== undefined).map((field) => [
      field,
      options[field],
    ]),
  );
  if (Object.keys(secrets).length === 0) return options;
  const rest = Object.fromEntries(
    Object.entries(options).filter(([key]) => !(SEALED_FIELDS as readonly string[]).includes(key)),
  );
  return { ...rest, [SECRETS_KEY]: encryptSecret(keys, context(owner), JSON.stringify(secrets)) };
}

export function unsealSecrets(
  keys: EncryptionKeys,
  owner: Owner,
  stored: Record<string, unknown>,
): SealedSecrets | undefined {
  const token = stored[SECRETS_KEY];
  if (typeof token !== 'string') return undefined;
  return JSON.parse(decryptSecret(keys, context(owner), token)) as SealedSecrets;
}

/** The sealed value of stored options, to hand on to playlist items. */
export function sealedPart(stored: Record<string, unknown>): Record<string, unknown> {
  return typeof stored[SECRETS_KEY] === 'string' ? { [SECRETS_KEY]: stored[SECRETS_KEY] } : {};
}

/** Finished jobs forget their per-request secrets; a manual retry then needs them sent again. */
export async function clearSecrets(db: Database, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await db
    .update(jobs)
    .set({ options: sql`${jobs.options} - ${SECRETS_KEY}::text` })
    .where(and(inArray(jobs.id, jobIds), sql`${jobs.options} ? ${SECRETS_KEY}::text`));
}
