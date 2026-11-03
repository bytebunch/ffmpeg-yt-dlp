import { Inject, Injectable, Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { cookiesBody, CookiesService } from '../access/cookies.service';
import { archivePage, ArchiveService } from '../archive/archive.service';
import { type AuthContext, USER_ID_PATTERN } from '../auth/api-keys';
import { catalog } from '../catalog/catalog';
import { AppError } from '../common/errors';
import { APP_CONFIG } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import { DiscoveryService } from '../discovery/discovery.service';
import { DriveConnections } from '../drive/drive-connections.service';
import { drivePage } from '../drive/drive.controller';
import {
  commentsRequestSchema,
  infoRequestSchema,
  searchQuerySchema,
  transcriptRequestSchema,
} from '../discovery/schemas';
import { InputsService, pageSchema } from '../inputs/inputs.service';
import { inputSchema } from '../inputs/schemas';
import { JobsService } from '../jobs/jobs.service';
import {
  batchJobSchema,
  downloadJobSchema,
  listJobsQuerySchema,
  processJobSchema,
  recordJobSchema,
} from '../jobs/schemas';
import { RecipesService } from '../recipes/recipes.service';
import { UploadsService } from '../uploads/uploads.service';
import {
  watchCreateSchema,
  watchPage,
  watchPatchSchema,
  WatchesService,
} from '../watches/watches.service';

const VERSION = process.env.npm_package_version ?? '0.1.0';

/** Every tool that acts for an end user takes `user_id` (SPEC §3); the key's default applies otherwise. */
const user = {
  user_id: z
    .string()
    .regex(USER_ID_PATTERN)
    .optional()
    .describe("End-user id; defaults to the API key's default user"),
};
const jobId = { job_id: z.uuid().describe('Job id') };

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * The MCP server (SPEC §6): one tool per REST operation, with the same Zod schemas and services.
 * Results carry links and metadata, never file bytes. A server is built per request (stateless
 * Streamable HTTP), bound to the caller's API key.
 */
@Injectable()
export class McpTools {
  private readonly logger = new Logger(McpTools.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly discovery: DiscoveryService,
    private readonly jobs: JobsService,
    private readonly inputs: InputsService,
    private readonly uploads: UploadsService,
    private readonly archive: ArchiveService,
    private readonly recipes: RecipesService,
    private readonly cookies: CookiesService,
    private readonly watches: WatchesService,
    private readonly drive: DriveConnections,
  ) {}

  server(auth: AuthContext): McpServer {
    const server = new McpServer({ name: 'media-service', version: VERSION });
    const as = (userId: string | undefined): AuthContext => ({
      ...auth,
      userId: userId ?? auth.userId,
    });
    // The SDK infers callback types per schema; one narrowed signature serves every tool here.
    const register = server.registerTool.bind(server) as unknown as (
      name: string,
      config: { description: string; inputSchema: z.ZodObject },
      callback: (args: unknown) => Promise<ToolResult>,
    ) => void;
    const tool = <S extends z.ZodObject>(
      name: string,
      description: string,
      schema: S,
      run: (args: z.output<S>) => Promise<unknown>,
    ) => {
      // The SDK has already validated `args` against `schema`.
      register(name, { description, inputSchema: schema }, (args) =>
        this.result(name, () => run(args as z.output<S>)),
      );
    };

    // Discovery (synchronous yt-dlp)
    // `user_id` matters only with `cookies` or `credentials`: the lookup is then made as that user.
    tool(
      'get_media_info',
      'Metadata, formats, chapters and subtitles of a media URL (POST /v1/info)',
      infoRequestSchema.extend(user),
      (args) => this.discovery.info(as(args.user_id), args),
    );
    tool(
      'search_media',
      'Search a supported site (GET /v1/search)',
      searchQuerySchema.extend(user),
      (args) => this.discovery.search(as(args.user_id), args),
    );
    tool(
      'get_transcript',
      'Subtitles or captions as text, SRT, VTT or JSON (POST /v1/transcripts)',
      transcriptRequestSchema.extend(user),
      (args) => this.discovery.transcript(as(args.user_id), args),
    );
    tool(
      'get_comments',
      'Comments of a video, up to COMMENTS_SYNC_MAX (POST /v1/comments)',
      commentsRequestSchema.extend(user),
      (args) => this.discovery.comments(as(args.user_id), args),
    );
    tool(
      'probe_media',
      'ffprobe any input: upload, inbox file, earlier output or URL (POST /v1/probe)',
      z.object({ input: inputSchema, ...user }),
      async ({ input, user_id }) => (await this.inputs.probe(as(user_id), input)).body,
    );
    tool(
      'list_presets',
      'Every download preset, request schema, recipe operation (with JSON Schema) and named recipe',
      z.object({}),
      async () => catalog(this.config, (await this.recipes.list(auth.clientId)).recipes),
    );

    // Jobs
    const create =
      (type: string) =>
      async ({ user_id, ...body }: Record<string, unknown> & { user_id?: string | undefined }) =>
        this.jobs.create(as(user_id), { type, ...body });
    tool(
      'start_download',
      'Download a video, playlist or channel tab, optionally with a `then` recipe (POST /v1/jobs type download)',
      downloadJobSchema.omit({ type: true }).extend(user),
      create('download'),
    );
    tool(
      'process_media',
      'Run an ffmpeg recipe (steps or a recipe name) on inputs (POST /v1/jobs type process)',
      processJobSchema.omit({ type: true }).extend(user),
      create('process'),
    );
    tool(
      'start_batch',
      'Download several URLs as one job (POST /v1/jobs type batch)',
      batchJobSchema.omit({ type: true }).extend(user),
      create('batch'),
    );
    tool(
      'record_live',
      'Record a live stream, or a premiere once it starts with `wait` (POST /v1/jobs type record)',
      recordJobSchema.omit({ type: true }).extend(user),
      create('record'),
    );
    tool(
      'get_job_status',
      'A job with its status, progress, outputs and signed links (GET /v1/jobs/:id)',
      z.object({ ...jobId, ...user }),
      ({ job_id, user_id }) => this.jobs.get(as(user_id), job_id),
    );
    tool(
      'list_jobs',
      "The user's jobs, newest first (GET /v1/jobs)",
      listJobsQuerySchema.extend(user),
      ({ user_id, ...query }) => this.jobs.list(as(user_id), query),
    );
    tool(
      'list_job_items',
      'Items of a playlist or batch job (GET /v1/jobs/:id/items)',
      z.object({
        ...jobId,
        status: z.string().max(32).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(500).default(100),
        ...user,
      }),
      ({ job_id, user_id, ...query }) => this.jobs.items(as(user_id), job_id, query),
    );
    tool(
      'retry_job',
      'Retry a failed job, or the failed items of a playlist (POST /v1/jobs/:id/retry)',
      z.object({ ...jobId, ...user }),
      ({ job_id, user_id }) => this.jobs.retry(as(user_id), job_id),
    );
    tool(
      'cancel_job',
      'Cancel a job and its pending items (DELETE /v1/jobs/:id)',
      z.object({ ...jobId, ...user }),
      ({ job_id, user_id }) => this.jobs.cancel(as(user_id), job_id),
    );

    // Inputs
    tool(
      'create_upload',
      'Create a resumable upload; hand the tus URL and upload token to the user or app (POST /v1/uploads)',
      z.object({
        filename: z.string().min(1).max(1000),
        size: z.number().int().min(1),
        mime: z.string().max(100).optional(),
        ...user,
      }),
      ({ user_id, ...body }) => this.uploads.create(as(user_id), body),
    );
    tool('list_inbox', "Files in the client's server inbox (GET /v1/inbox)", pageSchema, (query) =>
      this.inputs.inbox(auth, query),
    );
    tool(
      'list_outputs',
      "The user's unexpired outputs, usable as recipe inputs (GET /v1/outputs)",
      pageSchema.extend(user),
      ({ user_id, ...query }) => this.inputs.outputs(as(user_id), query),
    );

    // Per-user settings
    tool(
      'list_archive',
      'Media ids the user already downloaded (GET /v1/archive)',
      archivePage.extend(user),
      ({ user_id, ...query }) => this.archive.list(as(user_id), query),
    );
    tool(
      'remove_archive_entry',
      'Forget one downloaded media id, "<extractor>:<media_id>" (DELETE /v1/archive/:entry)',
      z.object({ entry: z.string().min(3).max(320), ...user }),
      ({ entry, user_id }) => this.archive.remove(as(user_id), entry),
    );

    tool(
      'set_cookies',
      'Store a Netscape cookie file (cookies.txt) for the user, encrypted; jobs use it with `cookies: true` or its id (PUT /v1/cookies)',
      cookiesBody.extend(user),
      ({ user_id, ...body }) => this.cookies.put(as(user_id), body),
    );
    tool(
      'list_cookies',
      "The user's cookie jars: label, domains, expiry; never the cookies (GET /v1/cookies)",
      z.object(user),
      ({ user_id }) => this.cookies.list(as(user_id)),
    );
    tool(
      'delete_cookies',
      "Delete one cookie jar, or all of the user's jars when no id is given (DELETE /v1/cookies[/:id])",
      z.object({ id: z.uuid().optional(), ...user }),
      ({ id, user_id }) => this.cookies.remove(as(user_id), id),
    );

    tool(
      'create_watch',
      'Watch a channel or playlist: new entries are downloaded every interval_minutes, with any download options and `then` (POST /v1/watches)',
      watchCreateSchema.extend(user),
      ({ user_id, ...body }) => this.watches.create(as(user_id), body),
    );
    tool(
      'list_watches',
      "The user's watches with status, failures and next run (GET /v1/watches)",
      watchPage.extend(user),
      ({ user_id, ...page }) => this.watches.list(as(user_id), page),
    );
    tool(
      'update_watch',
      'Pause (status "paused"), resume (status "active"), change the interval or options of a watch (PATCH /v1/watches/:id)',
      watchPatchSchema.extend({ id: z.uuid(), ...user }),
      ({ id, user_id, ...patch }) => this.watches.update(as(user_id), id, patch),
    );
    tool(
      'delete_watch',
      'Delete a watch and its run history (DELETE /v1/watches/:id)',
      z.object({ id: z.uuid(), ...user }),
      ({ id, user_id }) => this.watches.remove(as(user_id), id),
    );

    tool(
      'connect_google_drive',
      'A Google consent URL for the user: hand it to them; once they accept, outputs can go to their Drive (POST /v1/drive/connect)',
      z.object(user),
      ({ user_id }) => this.drive.connect(as(user_id)),
    );
    tool(
      'get_drive_status',
      'Whether the user connected Google Drive, which account, and the root folder (GET /v1/drive/status)',
      z.object(user),
      ({ user_id }) => this.drive.status(as(user_id)),
    );

    tool(
      'list_drive_files',
      "Files and folders the service created in the user's Drive: folderId targets and google_drive inputs (GET /v1/drive/files)",
      drivePage.extend(user),
      ({ user_id, ...page }) => this.drive.files(as(user_id), page),
    );

    return server;
  }

  /** Tool results are JSON text; service errors become tool errors with the REST error body. */
  private async result(name: string, run: () => Promise<unknown>): Promise<ToolResult> {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await run()) }] };
    } catch (error) {
      if (error instanceof AppError)
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(error.toBody()) }] };
      this.logger.error({ err: error, tool: name }, 'MCP tool failed');
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }),
          },
        ],
      };
    }
  }
}
