import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { uuidv7 } from '../common/ids';

// SPEC §14. Tables arrive with the milestone that first uses them; migrations only add
// (expand/contract, SPEC §17).

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  name: text('name').notNull().unique(),
  createdAt: createdAt(),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull().unique(),
    prefix: text('prefix').notNull().unique(),
    defaultUserId: text('default_user_id'),
    shareOutputsWithinClient: boolean('share_outputs_within_client').notNull().default(false),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index('api_keys_client_id_idx').on(table.clientId)],
);

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    type: text('type').notNull(),
    kind: text('kind').notNull().default('single'),
    parentJobId: uuid('parent_job_id'),
    playlistIndex: integer('playlist_index'),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    url: text('url'),
    options: jsonb('options').notNull().default({}),
    recipe: jsonb('recipe'),
    inputs: jsonb('inputs'),
    destination: jsonb('destination'),
    status: text('status').notNull().default('queued'),
    stage: text('stage'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    totalItems: integer('total_items').notNull().default(0),
    completedItems: integer('completed_items').notNull().default(0),
    failedItems: integer('failed_items').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    costEstimate: integer('cost_estimate'),
    idempotencyKey: text('idempotency_key'),
    createdAt: createdAt(),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
  },
  (table) => [
    index('jobs_owner_created_idx').on(table.clientId, table.userId, table.createdAt),
    index('jobs_parent_idx').on(table.parentJobId),
    index('jobs_status_idx').on(table.status),
  ],
);

/** Deduplicated downloads (SPEC §9d): a hit reuses every output of the job that made the files. */
export const mediaFiles = pgTable(
  'media_files',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    extractor: text('extractor').notNull(),
    mediaId: text('media_id').notNull(),
    preset: text('preset').notNull(),
    optionsHash: text('options_hash').notNull(),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    mime: text('mime'),
    title: text('title'),
    durationS: real('duration_s'),
    probe: jsonb('probe'),
    lastUsedAt: timestamptz('last_used_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [
    uniqueIndex('media_files_key_idx').on(
      table.extractor,
      table.mediaId,
      table.preset,
      table.optionsHash,
    ),
    index('media_files_expires_idx').on(table.expiresAt),
  ],
);

export const outputs = pgTable(
  'outputs',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    name: text('name').notNull(),
    /** Relative to FILES_DIR. Reused outputs (dedup, reuse as input) share a path. */
    path: text('path').notNull(),
    isDirectory: boolean('is_directory').notNull().default(false),
    mime: text('mime'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    durationS: real('duration_s'),
    probe: jsonb('probe'),
    mediaFileId: uuid('media_file_id').references(() => mediaFiles.id, { onDelete: 'set null' }),
    /**
     * A download original a `then` recipe replaced (keep_original false): kept for dedup and the
     * normal expiry, never listed or served.
     */
    hidden: boolean('hidden').notNull().default(false),
    /** Package outputs (is_directory): the file a player opens first, e.g. master.m3u8. */
    entry: text('entry'),
    driveFileId: text('drive_file_id'),
    driveLink: text('drive_link'),
    driveFolderId: text('drive_folder_id'),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('outputs_job_idx').on(table.jobId),
    index('outputs_owner_created_idx').on(table.clientId, table.userId, table.createdAt),
    index('outputs_expires_idx').on(table.expiresAt),
    index('outputs_path_idx').on(table.path),
  ],
);

export const jobLogs = pgTable(
  'job_logs',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    line: text('line').notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.seq] })],
);

/** Playlist expansions, reused for PLAYLIST_CACHE_TTL_MINUTES (SPEC §9e). */
export const playlists = pgTable(
  'playlists',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    /** SHA-256 of the URL and the expansion arguments: looked up before yt-dlp runs. */
    cacheKey: text('cache_key').notNull(),
    extractor: text('extractor'),
    playlistId: text('playlist_id'),
    title: text('title'),
    uploader: text('uploader'),
    itemCount: integer('item_count'),
    entries: jsonb('entries').notNull(),
    expandedAt: timestamptz('expanded_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('playlists_cache_key_idx').on(table.cacheKey)],
);

/** Each user's download archive (SPEC §7e skip_downloaded, §4 /v1/archive). */
export const archive = pgTable(
  'archive',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    extractor: text('extractor').notNull(),
    mediaId: text('media_id').notNull(),
    jobId: uuid('job_id'),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.userId, table.extractor, table.mediaId] }),
  ],
);

/** tus uploads (SPEC §5, §14): created by POST /v1/uploads, filled through /u/:id. */
export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime'),
    declaredSize: bigint('declared_size', { mode: 'number' }).notNull(),
    receivedSize: bigint('received_size', { mode: 'number' }).notNull().default(0),
    /** Relative to FILES_DIR. */
    path: text('path').notNull(),
    status: text('status').notNull().default('uploading'),
    probe: jsonb('probe'),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('uploads_owner_idx').on(table.clientId, table.userId),
    index('uploads_expires_idx').on(table.expiresAt),
  ],
);

/** Fetched inputs (URL downloads), reused for INPUT_CACHE_HOURS (SPEC §5). */
export const inputs = pgTable(
  'inputs',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    type: text('type').notNull(),
    source: jsonb('source').notNull(),
    /** SHA-256 of the source description (URL + headers), the cache key. */
    sourceHash: text('source_hash').notNull(),
    contentHash: text('content_hash').notNull(),
    path: text('path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    probe: jsonb('probe'),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('inputs_owner_content_idx').on(table.clientId, table.userId, table.contentHash),
    index('inputs_source_idx').on(table.clientId, table.userId, table.sourceHash),
    index('inputs_expires_idx').on(table.expiresAt),
  ],
);

export type Client = typeof clients.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Output = typeof outputs.$inferSelect;
export type MediaFile = typeof mediaFiles.$inferSelect;
export type Upload = typeof uploads.$inferSelect;

/** Saved recipes (SPEC §4 /v1/recipes): named step lists shared by a client's users. */
export const recipes = pgTable(
  'recipes',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    steps: jsonb('steps').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('recipes_client_name_idx').on(table.clientId, table.name)],
);

export type SavedRecipe = typeof recipes.$inferSelect;

/** Users' cookie jars (SPEC §7f, §12): Netscape cookie files, AES-256-GCM at rest. */
export const cookieJars = pgTable(
  'cookie_jars',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    label: text('label').notNull(),
    /** Cookie domains without the leading dot, sorted. */
    domains: jsonb('domains').$type<string[]>().notNull(),
    cookieCount: integer('cookie_count').notNull(),
    jarEnc: text('jar_enc').notNull(),
    keyVersion: integer('key_version').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    /** The earliest expiry among persistent cookies; null when all are session cookies. */
    expiresAt: timestamptz('expires_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('cookie_jars_owner_label_idx').on(table.clientId, table.userId, table.label),
    // At most one default jar per user.
    uniqueIndex('cookie_jars_owner_default_idx')
      .on(table.clientId, table.userId)
      .where(sql`${table.isDefault}`),
  ],
);

/** Site logins (SPEC §7f), only used when SITE_CREDENTIALS_ENABLED=true. */
export const siteCredentials = pgTable(
  'site_credentials',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    siteKey: text('site_key').notNull(),
    username: text('username').notNull(),
    secretEnc: text('secret_enc').notNull(),
    totpSeedEnc: text('totp_seed_enc'),
    keyVersion: integer('key_version').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('site_credentials_owner_site_idx').on(table.clientId, table.userId, table.siteKey),
  ],
);

export type CookieJar = typeof cookieJars.$inferSelect;
export type SiteCredential = typeof siteCredentials.$inferSelect;

/** Channel and playlist watches (SPEC §9f): checked every interval, new entries become a batch. */
export const watches = pgTable(
  'watches',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    url: text('url').notNull(),
    intervalMinutes: integer('interval_minutes').notNull(),
    /** The validated download request without type, url and `then`. */
    options: jsonb('options').$type<Record<string, unknown>>().notNull(),
    /** The `then` recipe, as steps. */
    recipe: jsonb('recipe'),
    destination: jsonb('destination'),
    status: text('status').notNull().default('active'),
    failures: integer('failures').notNull().default(0),
    lastError: text('last_error'),
    lastRunAt: timestamptz('last_run_at'),
    nextRunAt: timestamptz('next_run_at').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('watches_owner_idx').on(table.clientId, table.userId),
    index('watches_due_idx')
      .on(table.nextRunAt)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const watchRuns = pgTable(
  'watch_runs',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    watchId: uuid('watch_id')
      .notNull()
      .references(() => watches.id, { onDelete: 'cascade' }),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
    newItems: integer('new_items').notNull().default(0),
    jobId: uuid('job_id'),
    error: text('error'),
  },
  (table) => [index('watch_runs_watch_idx').on(table.watchId, table.startedAt)],
);

/**
 * Entries a watch has already queued: an item counts as known from the run that queued it,
 * not only once its download reaches the archive, so a slow queue never queues it twice.
 */
export const watchSeen = pgTable(
  'watch_seen',
  {
    watchId: uuid('watch_id')
      .notNull()
      .references(() => watches.id, { onDelete: 'cascade' }),
    /** `<extractor>:<id>`, as in the archive. */
    entryKey: text('entry_key').notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.watchId, table.entryKey] })],
);

export type Watch = typeof watches.$inferSelect;
export type WatchRun = typeof watchRuns.$inferSelect;

/** Per-user Google Drive connections (SPEC §11): the refresh token, AES-256-GCM at rest. */
export const driveConnections = pgTable(
  'drive_connections',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    googleEmail: text('google_email'),
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    keyVersion: integer('key_version').notNull(),
    /** "Media downloads", created on the first upload. */
    rootFolderId: text('root_folder_id'),
    /** `connected`, or `revoked` once Google answers invalid_grant. */
    status: text('status').notNull().default('connected'),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('drive_connections_owner_idx').on(table.clientId, table.userId)],
);

/** Single-use OAuth `state` values of pending consent links. */
export const oauthStates = pgTable(
  'oauth_states',
  {
    state: text('state').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('oauth_states_expires_idx').on(table.expiresAt)],
);

export type DriveConnection = typeof driveConnections.$inferSelect;
