import { z } from 'zod';

/**
 * References into the user's vault (SPEC §7f), shared by jobs and the discovery endpoints. Kept
 * apart from `options.ts`, which imports the discovery schemas, so both can use them.
 */

export const SITE_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** `true` is the user's default jar. */
export const cookiesOption = z.union([z.literal(true), z.uuid()]);
export type CookiesRef = z.output<typeof cookiesOption>;

export const credentialsOption = z
  .string()
  .regex(SITE_KEY, 'must be a site key from PUT /v1/credentials');
