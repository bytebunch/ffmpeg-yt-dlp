import { z } from 'zod';

import { INFO_INCLUDES } from './mappers';
import { DOWNLOAD_PRESETS } from './presets';
import { SEARCH_SITE_NAMES, type SearchSiteName } from './search';
import { TRANSCRIPT_FORMATS } from './subtitles';

/** Request schemas shared by REST and (milestone 7) MCP. Unknown fields are rejected. */

/** Control characters are all single UTF-16 code units, so a code-unit scan is exact. */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const mediaUrl = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .max(2048)
  .describe('Media page URL on a supported site');

/** Language tags only: yt-dlp treats --sub-langs entries as regular expressions. */
export const languageTag = z
  .string()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'must be a language tag such as en or pt-BR');

export const infoRequestSchema = z.strictObject({
  url: mediaUrl,
  include: z.array(z.enum(INFO_INCLUDES)).max(INFO_INCLUDES.length).default([]),
  mode: z.enum(['auto', 'single', 'playlist']).default('auto'),
  cursor: z.string().max(200).optional().describe('next_cursor from the previous playlist page'),
  limit: z.number().int().min(1).max(200).default(50).describe('Playlist entries per page'),
  preset: z.enum(DOWNLOAD_PRESETS).optional().describe('Fills requested_formats for this preset'),
});

export const searchQuerySchema = z.strictObject({
  q: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !hasControlCharacters(value), 'must not contain control characters'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  site: z.enum(SEARCH_SITE_NAMES as [SearchSiteName, ...SearchSiteName[]]).default('youtube'),
  sort: z.enum(['relevance', 'date']).default('relevance'),
});

export const transcriptRequestSchema = z.strictObject({
  url: mediaUrl,
  lang: z
    .array(languageTag)
    .min(1)
    .max(10)
    .default(['en'])
    .describe('Preferred languages, in order'),
  auto: z.boolean().default(true).describe('Accept automatically generated captions'),
  translate_to: languageTag.optional().describe('Auto-translated track, where the site offers one'),
  format: z.enum(TRANSCRIPT_FORMATS).default('json'),
});

export const commentsRequestSchema = z.strictObject({
  url: mediaUrl,
  max: z.number().int().min(1).max(10_000).default(50),
  sort: z.enum(['top', 'new']).default('top'),
});

export type InfoRequest = z.output<typeof infoRequestSchema>;
export type SearchQuery = z.output<typeof searchQuerySchema>;
export type TranscriptRequest = z.output<typeof transcriptRequestSchema>;
export type CommentsRequest = z.output<typeof commentsRequestSchema>;
