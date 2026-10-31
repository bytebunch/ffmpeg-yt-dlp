import { z } from 'zod';

import { languageTag } from '../discovery/schemas';
import { hasControlCharacters } from '../recipes/values';

/**
 * Access options of a download (SPEC §7f). Names only: cookie jars and site logins come from the
 * user's vault, proxies from the owner's PROXY_POOL; no raw yt-dlp syntax reaches the command.
 */

export const SITE_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const plain = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => !hasControlCharacters(value) && !value.includes('\n'),
      'must not contain control characters',
    );

/** `true` is the user's default jar. */
export const cookiesOption = z.union([z.literal(true), z.uuid()]);
export type CookiesRef = z.output<typeof cookiesOption>;

export const tvProviderSchema = z.strictObject({
  mso: z.string().regex(NAME, 'must be an Adobe Pass MSO id, e.g. Comcast_SSO'),
  username: plain(320),
  password: plain(1024),
});

/** Only these keys (SPEC §7f); composed into one `--extractor-args youtube:` value. */
export const extractorArgsSchema = z.strictObject({
  youtube: z
    .strictObject({
      player_client: z
        .array(z.string().regex(/^[a-z_]+$/))
        .min(1)
        .max(5)
        .optional(),
      lang: languageTag.optional(),
      max_comments: z.number().int().min(1).max(100_000).optional(),
      comment_sort: z.enum(['top', 'new']).optional(),
    })
    .optional(),
});
export type ExtractorArgs = z.output<typeof extractorArgsSchema>;

export const accessShape = {
  cookies: cookiesOption.optional(),
  credentials: z.string().regex(SITE_KEY, 'must be a site key from PUT /v1/credentials').optional(),
  video_password: plain(256).optional(),
  tv_provider: tvProviderSchema.optional(),
  proxy: z
    .string()
    .regex(/^[a-z0-9_-]{1,32}$/, 'must be a proxy name from the server configuration')
    .optional(),
  geo_country: z
    .string()
    .regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code, e.g. US')
    .optional(),
  extractor_args: extractorArgsSchema.optional(),
  mark_watched: z.boolean().optional(),
};

/** The access part of any request that runs yt-dlp (download items, recordings). */
export type AccessOptions = z.output<z.ZodObject<typeof accessShape>>;

/** Per-request secrets: sealed into the job (`_secrets`), never stored or shown in clear. */
export const SEALED_FIELDS = ['video_password', 'tv_provider'] as const;

export interface SealedSecrets {
  video_password?: string;
  tv_provider?: z.output<typeof tvProviderSchema>;
}

/** Fields that may unlock content only this user can see: their downloads are never shared. */
export const PRIVATE_FIELDS = ['cookies', 'credentials', ...SEALED_FIELDS] as const;
