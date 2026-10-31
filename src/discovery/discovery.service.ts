import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '../common/errors';
import { APP_CONFIG } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import { YtDlpRunner } from '../ytdlp/runner';
import { guardUrl, type Resolver } from '../ytdlp/url-guard';
import {
  asRecord,
  decodeCursor,
  isPlaylist,
  mapComments,
  mapPlaylist,
  mapSearchResult,
  mapVideo,
} from './mappers';
import { formatSelectionArgs } from './presets';
import type { CommentsRequest, InfoRequest, SearchQuery, TranscriptRequest } from './schemas';
import { searchTarget, siteAllowed } from './search';
import {
  type Cue,
  dedupeRolling,
  parseSubtitles,
  READABLE_SUBTITLE_EXTS,
  toSrt,
  toText,
  toVtt,
  type TranscriptFormat,
} from './subtitles';

export const URL_RESOLVER = Symbol('URL_RESOLVER');

const INFO_SUFFIX = '.info.json';

function keys(value: unknown): string[] {
  return typeof value === 'object' && value !== null ? Object.keys(value) : [];
}

function render(cues: Cue[], format: TranscriptFormat): { cues: Cue[] } | { content: string } {
  switch (format) {
    case 'json':
      return { cues };
    case 'srt':
      return { content: toSrt(cues) };
    case 'vtt':
      return { content: toVtt(cues) };
    case 'txt':
      return { content: toText(cues) };
  }
}

/** Synchronous yt-dlp calls behind /v1/info, /v1/search, /v1/transcripts and /v1/comments. */
@Injectable()
export class DiscoveryService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly runner: YtDlpRunner,
    @Inject(URL_RESOLVER) private readonly resolve: Resolver,
  ) {}

  private get timeoutMs(): number {
    return this.config.PLAYLIST_EXPAND_TIMEOUT_SECONDS * 1000;
  }

  async info(request: InfoRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = await guardUrl(request.url, this.resolve);
    const offset = decodeCursor(request.cursor);
    const args = [
      request.mode === 'playlist' ? '--yes-playlist' : '--no-playlist',
      '--flat-playlist',
      // One entry more than the page, to know whether another page exists.
      '-I',
      `${offset + 1}:${offset + request.limit + 1}`,
      ...(request.preset ? formatSelectionArgs(request.preset) : []),
    ];
    const raw = asRecord(
      await this.runner.json(args, url.href, {
        timeoutMs: this.timeoutMs,
        ...(signal && { signal }),
      }),
    );
    const include = new Set(request.include);
    if (!isPlaylist(raw)) return mapVideo(raw, include);
    if (request.mode === 'single') {
      throw new AppError(
        'VALIDATION_FAILED',
        'The URL is a playlist; use mode "auto" or "playlist"',
      );
    }
    return mapPlaylist(raw, { offset, limit: request.limit }, include);
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!siteAllowed(query.site, this.config.SITE_ALLOWLIST)) {
      throw new AppError(
        'FEATURE_DISABLED',
        `Search on ${query.site} is not enabled on this server`,
      );
    }
    const target = searchTarget(query.site, query.sort, query.q, query.limit);
    const raw = asRecord(
      await this.runner.json(['--flat-playlist', ...target.args], target.url, {
        timeoutMs: this.timeoutMs,
        extractors: [target.extractor],
        ...(signal && { signal }),
      }),
    );
    const entries = Array.isArray(raw.entries) ? (raw.entries as unknown[]) : [];
    return {
      site: query.site,
      sort: query.sort,
      query: query.q,
      results: entries.slice(0, query.limit).map((entry) => mapSearchResult(asRecord(entry))),
    };
  }

  async transcript(
    request: TranscriptRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = await guardUrl(request.url, this.resolve);
    const langs = request.translate_to === undefined ? request.lang : [request.translate_to];
    const acceptAuto = request.auto || request.translate_to !== undefined;
    const workDir = await mkdtemp(path.join(tmpdir(), 'transcript-'));
    try {
      await this.runner.run(
        [
          '--no-playlist',
          '--skip-download',
          '--write-subs',
          ...(acceptAuto ? ['--write-auto-subs'] : []),
          '--sub-langs',
          langs.join(','),
          '--sub-format',
          `${READABLE_SUBTITLE_EXTS.join('/')}/best`,
          '--write-info-json',
          '-o',
          '%(id)s.%(ext)s',
        ],
        url.href,
        {
          timeoutMs: this.config.TRANSCRIPT_TIMEOUT_SECONDS * 1000,
          workDir,
          ...(signal && { signal }),
        },
      );
      const files = await readdir(workDir);
      const infoFile = files.find((name) => name.endsWith(INFO_SUFFIX));
      if (infoFile === undefined)
        throw new AppError('EXTRACTION_FAILED', 'yt-dlp wrote no metadata');
      const info = asRecord(JSON.parse(await readFile(path.join(workDir, infoFile), 'utf8')));
      const base = infoFile.slice(0, -INFO_SUFFIX.length);

      for (const lang of langs) {
        const file = files.find((name) => name.startsWith(`${base}.${lang}.`) && name !== infoFile);
        if (file === undefined) continue;
        const ext = file.slice(`${base}.${lang}.`.length);
        // yt-dlp prefers a manual track over automatic captions for the same language.
        const automatic = !keys(info.subtitles).includes(lang);
        const parsed = parseSubtitles(ext, await readFile(path.join(workDir, file), 'utf8'));
        const cues = automatic ? dedupeRolling(parsed) : parsed;
        return {
          id: info.id ?? null,
          title: info.title ?? null,
          language: lang,
          automatic,
          format: request.format,
          ...render(cues, request.format),
        };
      }
      throw new AppError('NOT_FOUND', 'No subtitles in the requested languages', {
        subtitles: keys(info.subtitles),
        automatic_captions: acceptAuto ? keys(info.automatic_captions) : [],
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async comments(request: CommentsRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (request.max > this.config.COMMENTS_SYNC_MAX) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Synchronous requests return at most ${this.config.COMMENTS_SYNC_MAX} comments`,
        { max: this.config.COMMENTS_SYNC_MAX },
      );
    }
    const url = await guardUrl(request.url, this.resolve);
    const raw = asRecord(
      await this.runner.json(
        [
          '--no-playlist',
          '--skip-download',
          '--write-comments',
          '--extractor-args',
          `youtube:max_comments=${request.max};comment_sort=${request.sort}`,
        ],
        url.href,
        { timeoutMs: this.timeoutMs, ...(signal && { signal }) },
      ),
    );
    return mapComments(raw, request.max);
  }
}
