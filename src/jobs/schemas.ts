import { z } from 'zod';

import { AppError } from '../common/errors';
import { accessShape } from '../access/options';
import { destinationSchema } from '../drive/destination';
import { downloadOptionsSchema, downloadOptionsShape, optionProblems } from '../downloads/options';
import { inputSchema } from '../inputs/schemas';
import { dateFilter, filtersSchema } from '../playlists/filters';
import { parseSelection } from '../playlists/selection';

const mediaUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).max(2048);

/** Fields that arrive with later milestones; accepted by the schema, refused with a clear message. */
const LATER_FIELDS = {
  break_on_existing: 'break_on_existing applies to watches (POST /v1/watches)',
} as const;

const LATER_TYPES: Record<string, string> = {};

/**
 * SPEC §9b: a recipe applied to every media file a download produces. Not part of the download
 * options, so it never changes the download's dedup key.
 */
export const pipelineShape = {
  then: z.unknown().optional(),
  keep_original: z.boolean().optional(),
};
export const PIPELINE_FIELDS = Object.keys(pipelineShape);

/** Medialess presets produce nothing a recipe could take. */
export const MEDIALESS_PRESETS = ['thumbnail_only', 'subtitles_only', 'metadata_only'];

const laterFields = Object.fromEntries(
  Object.keys(LATER_FIELDS).map((field) => [field, z.unknown().optional()]),
);

/** Playlist and channel controls (SPEC §7e); they shape the expansion, not each item. */
export const playlistShape = {
  items: z.string().max(500).optional(),
  reverse: z.boolean().default(false),
  random: z.boolean().default(false),
  max_items: z.number().int().min(1).optional(),
  date_after: dateFilter.optional(),
  date_before: dateFilter.optional(),
  filters: filtersSchema.optional(),
  skip_downloaded: z.boolean().default(false),
  channel_tab: z.enum(['videos', 'shorts', 'streams', 'playlists', 'all']).default('videos'),
  /** SPEC §7e: one extra output joining every item's media once the items are done. */
  concat_items: z.boolean().default(false),
};

export const PLAYLIST_FIELDS = Object.keys(playlistShape);

export const downloadJobSchema = z.strictObject({
  type: z.literal('download'),
  url: mediaUrl,
  mode: z.enum(['auto', 'single', 'playlist']).default('auto'),
  ...downloadOptionsShape,
  ...playlistShape,
  ...pipelineShape,
  destination: destinationSchema.optional(),
  ...laterFields,
});

export const batchJobSchema = z.strictObject({
  type: z.literal('batch'),
  concat_items: z.boolean().default(false),
  /** One destination for the batch: its items go into one sub-folder (SPEC §11). */
  destination: destinationSchema.optional(),
  items: z
    .array(
      z.strictObject({ url: mediaUrl, ...downloadOptionsShape, ...pipelineShape, ...laterFields }),
    )
    .min(1),
});

/** Presets a live stream can be recorded with: video tiers (audio extraction needs the VOD). */
export const RECORD_PRESETS = ['best', '2160p', '1440p', '1080p', '720p', '480p', '360p'] as const;

/**
 * SPEC §7d: live streams and premieres. Recorded as MPEG-TS (crash-safe), remuxed to `container`
 * at the end. Limits (LIVE_MAX_DURATION_MINUTES, LIVE_MAX_WAIT_MINUTES) are checked on creation.
 */
export const recordJobSchema = z.strictObject({
  type: z.literal('record'),
  url: mediaUrl,
  preset: z.enum(RECORD_PRESETS).default('best'),
  container: z.enum(['mp4', 'mkv', 'mov']).default('mp4'),
  from_start: z.boolean().default(false),
  max_duration_minutes: z.number().int().min(1).optional(),
  wait: z
    .strictObject({
      min_minutes: z.number().int().min(1),
      max_minutes: z.number().int().min(1).optional(),
    })
    .refine(
      (wait) => (wait.max_minutes ?? wait.min_minutes) >= wait.min_minutes,
      'max_minutes must not be less than min_minutes',
    )
    .optional()
    .describe(
      'Wait for a scheduled stream: retry every min–max minutes, up to LIVE_MAX_WAIT_MINUTES',
    ),
  split_every_minutes: z.number().int().min(1).optional(),
  impersonate: downloadOptionsShape.impersonate,
  limit_rate_kbps: downloadOptionsShape.limit_rate_kbps,
  ...accessShape,
  destination: destinationSchema.optional(),
});

export const commentsJobSchema = z.strictObject({
  type: z.literal('comments'),
  url: mediaUrl,
  max: z.number().int().min(1).max(100_000).default(1000),
  sort: z.enum(['top', 'new']).default('top'),
});

export const probeJobSchema = z.strictObject({ type: z.literal('probe'), input: inputSchema });

/** SPEC §8a: inputs plus a recipe; the recipe itself is validated by parseRecipe (limits apply). */
export const processJobSchema = z.strictObject({
  type: z.literal('process'),
  inputs: z.array(inputSchema).min(1).max(500),
  recipe: z.unknown(),
  destination: destinationSchema.optional(),
});

export type DownloadJobRequest = z.output<typeof downloadJobSchema>;
export type BatchJobRequest = z.output<typeof batchJobSchema>;
export type CommentsJobRequest = z.output<typeof commentsJobSchema>;
export type ProbeJobRequest = z.output<typeof probeJobSchema>;
export type ProcessJobRequest = z.output<typeof processJobSchema>;
export type RecordJobRequest = z.output<typeof recordJobSchema>;
export type JobRequest =
  | DownloadJobRequest
  | BatchJobRequest
  | CommentsJobRequest
  | ProbeJobRequest
  | ProcessJobRequest
  | RecordJobRequest;

function validationError(error: z.ZodError): AppError {
  return new AppError('VALIDATION_FAILED', 'The request is not valid', {
    issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

function refuseLaterFields(request: Record<string, unknown>, prefix = ''): void {
  for (const [field, message] of Object.entries(LATER_FIELDS)) {
    if (request[field] !== undefined) throw new AppError('FEATURE_DISABLED', `${prefix}${message}`);
  }
}

function checkOptions(options: z.output<typeof downloadOptionsSchema>, prefix = ''): void {
  const problems = optionProblems(options);
  if (problems.length > 0) {
    throw new AppError('VALIDATION_FAILED', `${prefix}${problems.join('; ')}`, { problems });
  }
}

/** Validates a POST /v1/jobs body; refuses job types and fields that later milestones add. */
export function parseJobRequest(body: unknown): JobRequest {
  const type =
    typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined;
  if (typeof type === 'string' && type in LATER_TYPES) {
    throw new AppError('FEATURE_DISABLED', LATER_TYPES[type] ?? 'Not available yet');
  }
  if (type === 'process') {
    const parsed = processJobSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    if (parsed.data.recipe === undefined)
      throw new AppError('RECIPE_INVALID', 'recipe is required');
    return parsed.data;
  }
  if (type === 'record') {
    const parsed = recordJobSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    if (parsed.data.mark_watched === true && parsed.data.cookies === undefined) {
      throw new AppError('VALIDATION_FAILED', 'mark_watched requires cookies');
    }
    return parsed.data;
  }
  if (type === 'probe') {
    const parsed = probeJobSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    return parsed.data;
  }
  if (type === 'comments') {
    const parsed = commentsJobSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    return parsed.data;
  }
  if (type === 'batch') {
    const parsed = batchJobSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    parsed.data.items.forEach((item, i) => {
      refuseLaterFields(item, `items.${i}: `);
      checkOptions(downloadOptionsSchema.parse(itemOptions(item)), `items.${i}: `);
    });
    return parsed.data;
  }
  const parsed = downloadJobSchema.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error);
  const request = parsed.data;
  refuseLaterFields(request);
  if (request.channel_tab === 'playlists' || request.channel_tab === 'all') {
    throw new AppError(
      'FEATURE_DISABLED',
      'channel_tab "playlists" and "all" are not available yet',
    );
  }
  if (request.items !== undefined) parseSelection(request.items);
  checkOptions(downloadOptionsSchema.parse(itemOptions(request)));
  return request;
}

/** The per-item download options: everything except type, url, mode and playlist controls. */
export function itemOptions(request: Record<string, unknown>): Record<string, unknown> {
  const excluded = new Set([
    'type',
    'url',
    'mode',
    'checks',
    'destination',
    ...PLAYLIST_FIELDS,
    ...PIPELINE_FIELDS,
    ...Object.keys(LATER_FIELDS),
  ]);
  // "_" keys are internal (sealed secrets, sharing flags), never download options.
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => !excluded.has(key) && !key.startsWith('_')),
  );
}

/** The pipeline fields of a stored request, to hand on to playlist items. */
export function pipelineOptions(stored: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(stored).filter(([key]) => PIPELINE_FIELDS.includes(key)),
  );
}

/** What a job row stores as options: the request without type, URL and destination (a column). */
export function storedOptions(request: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => !['type', 'url', 'destination'].includes(key)),
  );
}

export const listJobsQuerySchema = z.strictObject({
  status: z
    .enum([
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
      'completed_with_errors',
      'expired',
      'skipped',
      'waiting',
      'recording',
    ])
    .optional(),
  type: z.enum(['download', 'batch', 'record', 'process', 'comments', 'probe']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListJobsQuery = z.output<typeof listJobsQuerySchema>;
