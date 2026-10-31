# Development progress

Work log for the media service, newest step last. Each step lists what was built, how it was tested
(with results), and any decision or deviation from SPEC.md worth reviewing. Commands run inside the
toolbox container: `./dev pnpm check` (format, lint, types, all tests) unless noted.

Nothing is committed to git (standing rule: commits only on request). The project is not yet a git
repository.

## Status (2026-10-31)

Milestones 1–10 of SPEC §18 are built and tested on the Mac. Latest totals: `pnpm check` 724/724,
Playwright 6/6, live YouTube tests 7/7, deploy tests 64 (53 Bats, 6 real-packet firewall, 5 nginx),
ffmpeg image acceptance, e2e 68 checks. The installer was then reviewed with the user point by
point (see "Installer review" at the end).

### Open items

1. **On the VPS (Ubuntu 26.04):** `install.sh` end to end, the egress firewall unit at boot and the
   DEPLOY.md §4.5 checks from inside `worker-dl`, host nginx + certbot, GHCR pulls with a
   `read:packages` token, Google OAuth with the real client (consent screen in production), the
   first backup restore drill, the server canary cron.
2. **On GitHub:** the first runs of `ci.yml`, `rebuild.yml` and `canary.yml` (only linted with
   actionlint so far).
3. ffmpeg's TLS does not verify certificates by default (D45); pass `-tls_verify 1 -ca_file …`
   through `--downloader-args ffmpeg_i:` once it is confirmed to reach HLS segment requests.
4. Twice a whole integration file failed in `beforeAll` during a full run (milestone 8); not seen
   in any run since. Full test output is kept now, so a repeat will show the error.
5. SPEC text to update with the decisions below marked "to add to SPEC", and D42–D53.
6. Smaller follow-ups: `channel_tab` `playlists`/`all`; hardware encoding (`FFMPEG_HWACCEL`, D28);
   attachment extraction (D36); `downloads.spec` onto the shared `support/jobs.ts` helpers.

## Environment

- Toolbox: `./dev <cmd>` runs commands in `media-dev` (Node 24.22.2, pnpm 10.34.9, yt-dlp
  2026.10.26 with yt-dlp-ejs, curl_cffi and the bgutil PO-token plugin, deno 2.9.8, the
  production ffmpeg 8.1 copied from `media-ffmpeg:dev`, Chromium for Playwright 1.64.1).
  node_modules and the pnpm store live in Docker volumes; the Docker socket is shared so
  Testcontainers can start Postgres 17 and Redis 7.
- Host Node (26) is never used.

## Decisions and deviations to review

| # | Decision | Why |
|---|---|---|
| D1 | NestJS **11** (not 12) and `@nestjs/swagger` 11 | `nestjs-zod` (spec) supports Nest ≤ 11 only |
| D2 | TypeScript **6.0** (not 7) | `typescript-eslint` supports TS < 6.1 |
| D3 | `@prometheus-io/client` instead of `prom-client` | `prom-client` is deprecated on npm and renamed to this package (same project, now under the Prometheus org) |
| D4 | CommonJS build, `module: nodenext` | Nest's decorator metadata is most reliable in CJS; Node 24 `require(esm)` loads ESM-only deps (execa) — verified |
| D5 | Extra env vars `YTDLP_BIN`, `DENO_BIN`, `FFMPEG_BIN`, `FFPROBE_BIN`, `YTDLP_CACHE_DIR` | Binary paths for tests and images; defaults match the image. To add to SPEC §13 |
| D6 | `YTDLP_IMPERSONATE_DEFAULT` accepts `none` as well as empty to disable | Empty values otherwise mean "use the default" |
| D7 | libvmaf built from source in `media-ffmpeg` | Debian 13 does not package libvmaf at all (checked main, contrib, non-free) |
| D8 | Tables are added per milestone, not all of SPEC §14 at once | Keeps every migration additive and tied to the code that uses it |
| D9 | Generic error codes added: `VALIDATION_FAILED` 400, `UNAUTHORIZED` 401, `NOT_FOUND` 404, `TIMEOUT` 504, `EXTRACTION_FAILED` 502, `UNAVAILABLE` 503, `INTERNAL` 500 | SPEC §4 lists domain codes only; every response still uses the uniform shape. To add to SPEC §4 |
| D10 | Rate limiting fails open when Redis is down (logged; `/health` shows it) | A cache outage should not become a full API outage |
| D11 | `cli keys:revoke --key <key>` in addition to `<prefix>` | `install.sh` revokes its temporary smoke-test key by value |
| D15 | `media_files.job_id` column | A dedup hit must hand over every output of the source job (media, subtitles, thumbnails), not one file |
| D16 | `chapters.remove_ranges` + `sponsorblock` refused | yt-dlp 2026.10.26 crashes on that combination; regression test watches for the fix |
| D17 | `-S vcodec:h264` (no `+`) | `+` reverses yt-dlp's sort order; SPEC §7a text to be corrected |
| D18 | Playlist filters applied by the service, not `--match-filters` | Same effect, no filter syntax to escape, and the same code re-checks items on full metadata |
| D19 | `playlists.cache_key` column | The cache is looked up before yt-dlp has identified the playlist |
| D20 | Item status `skipped` (counted as completed for the parent) | Items outside a date range are only known once their full metadata is fetched |
| D21 | `inputs.source_hash` column | URL inputs are looked up by source before fetching; the content hash comes after |
| D22 | Upload status `rejected` | A finished upload that is not allowed media must not become `ready` |
| D23 | Input field names follow SPEC §5 (`uploadId`, `outputId`, `fileId`) although the rest of the API is snake_case | Kept as specified; worth unifying before clients are written |
| D24 | `_share_outputs` stored in job options (hidden from views) | Output sharing is a per-API-key setting and the worker resolves inputs later |
| D25 | Recipe `loop.count` = extra repetitions (ffmpeg's `-stream_loop` meaning) | SPEC gives only the range 1–20 |
| D26 | `probe` and `keyframes` describe the recipe input, wherever they sit in the recipe | They are ffprobe runs, not filters |
| D27 | One of each analysis per recipe | Reports are matched to their filter's log lines by filter type |
| D28 | `FFMPEG_HWACCEL` is accepted but encoding stays in software | No GPU host to test against yet |
| D29 | `encode` container `gif/webp/png/jpg/avif` refused; use `gif`/`thumbnail` (animated WebP/AVIF in M6) | Image outputs are their own terminals |
| D30 | `outputs.hidden` for originals a `then` recipe replaced | Keeps dedup and expiry working without listing them |
| D31 | `then` pipelines run on the same job row (status `running`, stage `processing`) | SPEC §9b calls it a child step; a separate job row would split the item's outputs |
| D32 | `tempo`, and `pitch` without `preserve_tempo`, refused on media with video | They change the audio length only; `speed` covers video |
| D33 | `compress` presets (light…broadcast) and `eq` presets defined by the service | SPEC names the presets but not their values |
| D34 | Input `0` in `concat`/`stack` lists means the working streams after the previous steps; other indexes are the raw inputs | Lets a recipe trim or scale the main input before joining |
| D35 | `generate` has `place: before|after|replace` | SPEC lists `generate` under composition without saying how it combines |
| D36 | `extract_streams` of attachments not offered yet | Needs `-dump_attachment` and a different output path |
| D37 | Package links carry the token in the path (`/d/hls/<id>/<exp>/<sig>/…`) | Query-string tokens are lost when players resolve relative segment URLs |
| D38 | `frames` default `zip: true` builds the ZIP on the worker (store-only) | One output instead of up to `FRAMES_MAX_COUNT` rows |
| D39 | Parameterised presets as `{ "preset": "clip", "params": {…} }` | SPEC lists presets like `clip` and `compress_to_size` that cannot work without values |
| D40 | Platform table values (sizes, caps, profiles) chosen by the service | SPEC names the platforms, not their numbers; they will need upkeep |
| D41 | Saved recipes belong to the client (all its users) | Recipes are configuration, like API keys, not personal data |
| D42 | Downloads using cookies, credentials, a video password or a TV login dedupe and cache per (client, user) | SPEC §9d shares only public media; private access must never leak to another user |
| D43 | `video_password` / `tv_provider` sealed into `_secrets`, deleted when the job finishes | SPEC §7f "per request, not stored"; the worker still needs them, and Redis only carries job ids |
| D44 | A cancelled recording keeps its outputs (status `cancelled`, outputs listed) | SPEC §9c sends SIGINT "so yt-dlp finalises the file"; stopping a recording should not lose it |
| D45 | ffmpeg built with GnuTLS | yt-dlp hands live HLS to ffmpeg as https URLs; GnuTLS is LGPL (no `--enable-nonfree`). Note: ffmpeg's TLS does not verify certificates by default (`tls_verify=0`); yt-dlp's own requests do. Follow-up: pass `-tls_verify 1 -ca_file …` through `--downloader-args ffmpeg_i:` once it is confirmed to reach HLS segment requests |
| D46 | Watches: one-minute tick claiming due rows with SKIP LOCKED, not one BullMQ scheduler per watch | The database stays the only source of truth; pause/edit/delete need no Redis bookkeeping |
| D47 | Break-on-existing is done by the service against archive + `watch_seen`, not yt-dlp's `--break-on-existing --download-archive` | Same semantics, no archive file to write per run, and entries queued but not yet downloaded count as known |
| D48 | A watch's first run queues the newest `WATCH_MAX_NEW_ITEMS` entries | SPEC bounds runs by `--playlist-end WATCH_MAX_NEW_ITEMS` and says nothing of a backfill-free start |
| D49 | `google-auth-library` for OAuth; Drive v3 over fetch, not the `googleapis` package | Chunked resumable uploads with per-chunk retry need own code anyway; `googleapis` is very large |
| D50 | Drive uploads on their own `delivery` queue (worker-dl); jobs wait in `running/uploading` | One upload path for every job type, with the existing retry and failure handling |
| D51 | Drive folder naming: playlist title, `Batch <date> <id>`, one folder per watch, media name for multi-output downloads | SPEC §11 names the groups; these are the names a user can recognise |
| D52 | A failed upload fails the job with `DRIVE_*` but keeps listing its outputs | SPEC §11 keeps the local file; the signed link is the fallback |
| D53 | Browser tests run the built app (dist/) from a server script, Google mocked there | Playwright's TS loader emits no decorator metadata, which Nest's DI needs |
| D54 | `install.sh` enforces no CPU, RAM or disk minimum; it only checks AVX2 and turns transcription off without it | User's decision: the service runs on smaller servers, only more slowly. DEPLOY.md keeps 8 vCPU / 16 GB as the recommendation. In SPEC §17 |
| D55 | The bundled nginx defaults to `127.0.0.1:8085` (was `0.0.0.0:8080`); the installer no longer looks up the server's IP | User's decision: nothing is reachable from other machines until the developer opens it, through `HTTP_BIND` in `.env` or their own nginx in front. In SPEC §17 |
| D56 | On CI (`ci.yml`, `rebuild.yml`) a YouTube `BOT_CHECK` answer skips the e2e's YouTube checks (`E2E_ALLOW_YOUTUBE_BLOCK=1`), with a warning on the run; any other failure still fails | User's decision: GitHub runners' IPs are refused by YouTube, which blocked every image push. YouTube is proven where the IP matters: the Mac e2e, the installer's smoke test and the server canary. In SPEC §17 |
| D57 | The daily canary runs only on the server (`canary.sh`); `canary.yml` runs by hand | User's decision: from a runner IP it can only report the block, and it costs Actions minutes daily. In SPEC §17 |

## Steps

### Step 0 — toolbox and project scaffold ✅

- `docker/dev/Dockerfile`, `./dev` wrapper (bash 3.2-safe), `package.json`, strict `tsconfig`,
  ESLint (typescript-eslint strict + stylistic, type-checked), Prettier, Vitest projects `unit` and
  `integration` (SWC for decorator metadata).
- `src/common/ids.ts`: UUIDv7 (time-ordered ids, used as primary keys and cursors).
- Tests: 5 unit tests (format, version/variant bits, timestamp, ordering, uniqueness).

### Step 1 — configuration ✅

- `src/config/env.schema.ts`: every SPEC §13 variable with defaults, ranges and cross-field rules
  (upload ≤ file size, proxy defaults name pool entries, whisper default is a configured model,
  Google id/secret together). Versioned AES keys decoded and sorted newest first.
- `src/config/load-config.ts`: empty values count as unset; errors name the variable, never the value.
- Tests: 18 unit tests, including "never echoes a rejected value".

### Step 2 — database ✅

- Drizzle schema `clients`, `api_keys`; migration `drizzle/0000_init.sql`; `src/migrate.ts` entry
  point; `runMigrations` holds a Postgres advisory lock so concurrent deploys serialise.
- `DATABASE_SSL_MODE` mapped to node-postgres TLS options with libpq semantics.
- Tests: 4 unit (TLS modes) + 5 integration on real Postgres 17 (tables, idempotent re-run,
  3 concurrent runs on a fresh DB → 1 migration row, unique key hash/prefix, cascade, unique names).
- Result: 32/32 passing.

### Step 3 — application skeleton, API keys, auth, rate limits ✅

- NestJS 11 on Fastify (`src/app.ts`, `src/app.module.ts`, `src/main.ts`): request ids (a
  well-formed `X-Request-Id` is kept and echoed), pino request logs with only id/method/redacted URL,
  OpenAPI at `/docs` (`/docs/json`), `/health` (Postgres + Redis, 503 when either is down),
  `/metrics` (Prometheus, labelled by route template).
- Uniform errors `{ error: { code, message, details? } }` for app errors, Zod validation, Nest and
  Fastify errors; unknown errors become a bare `INTERNAL` 500 and are logged.
- API keys `mk_` + 32 base64url chars, stored as SHA-256 with an 11-char visible prefix; clients are
  path-safe names (they become inbox folders). `X-User-Id` overrides the key's default user.
- Per-key rate limit in Redis (fixed 1-minute window, `Retry-After`, `X-RateLimit-*`). If Redis is
  down, requests are allowed and the failure is logged (health reports Redis down).
- CLI (`node dist/cli.js` → `cli` in the image): `keys:create <client> [--default-user]
  [--share-outputs] [--quiet]`, `keys:revoke <prefix> | --key <key>`, `keys:list [--client]`.
  `--quiet` and `--key` are what `deploy/install.sh` relies on.
- Fix found by tests: `/health` was 503 right after start (Redis not yet connected) and ioredis
  printed "Unhandled error event"; the Redis provider now waits for the first connect result
  (≤ 5 s) and logs connection errors (throttled).
- Tests: unit (errors, redaction, auth helpers, CLI parsing) + integration on Postgres + Redis
  (15 HTTP tests: health, request ids, metrics, docs, 401 variants, default/override user, last-used,
  rate limit 5/min → 429, validation details, malformed JSON, 404, hidden 500, degraded Redis;
  3 CLI tests end to end).
- Smoke: built `dist/`, ran `migrate`, `cli keys:create`, `main.js` against real Postgres + Redis
  containers; curl `/health` ok, `/docs` 200, metrics present, bad config exits 1, a `sig=` query
  value appears as `[REDACTED]` in the request log.
- Error codes added beyond SPEC §4's list (generic HTTP): `VALIDATION_FAILED`, `UNAUTHORIZED`,
  `NOT_FOUND`, `TIMEOUT`, `EXTRACTION_FAILED`, `UNAVAILABLE`, `INTERNAL` (D9 below).

### Step 4 — yt-dlp runner, URL guard, error classifier ✅

- `src/ytdlp/url-guard.ts`: http(s) only, no credentials, ≤ 2048 chars; every resolved address
  checked against private/loopback/link-local/metadata/CGNAT/NAT64/6to4/multicast/reserved ranges
  (IPv4-mapped IPv6 handled). Any private answer rejects the URL (mixed DNS answers).
- `src/ytdlp/runner.ts`: execa argument arrays, fixed flags (SPEC §7g), `--use-extractors
  default,-generic` (or `SITE_ALLOWLIST`), deno runtime, cache dir, impersonation, `--` before the
  URL, minimal env (PATH, HOME, TMPDIR, locale), throwaway cwd, timeout → SIGTERM → SIGKILL,
  output cap, cancellation, missing binary = server fault.
- `src/ytdlp/errors.ts`: yt-dlp ERROR lines → `UNSUPPORTED_SITE`, `BOT_CHECK`, `MEDIA_AGE_GATED`,
  `LIVE_NOT_STARTED`, `MEDIA_GEO_BLOCKED`, `MEDIA_PRIVATE`, `LOGIN_REQUIRED`, `MEDIA_UNAVAILABLE`,
  else `EXTRACTION_FAILED`; messages redacted and capped at 500 chars.
- Tests: 40 URL-guard cases, 17 classifier cases, 15 runner tests with a fake yt-dlp
  (`test/fixtures/bin/fake-yt-dlp`, echoes args/env/cwd), 5 real-yt-dlp tests against a local web
  server (version, real JSON, impersonation via curl_cffi, 404 → MEDIA_UNAVAILABLE, and the
  production policy refusing a plain media URL as `UNSUPPORTED_SITE`).
- Result: 156/156 passing (`pnpm check`).

### Step 5 — discovery endpoints ✅

- `POST /v1/info`: video metadata (SPEC §7i fields, null when missing) with `include[]` for
  formats/subtitles/thumbnails/chapters/heatmap/description/tags; optional `preset` fills
  `requested_formats`; playlists return flat entries with cursor paging (`limit` 1–200, default 50;
  one extra entry is fetched to know whether another page exists); `mode` auto/single/playlist.
  **Stream and subtitle URLs are never returned** (signed for the server's IP; they would leak it).
- `GET /v1/search`: youtube (default), soundcloud, bilibili, niconico; `sort=relevance|date`;
  `SITE_ALLOWLIST` respected (`FEATURE_DISABLED` otherwise).
- `POST /v1/transcripts`: languages in preference order, manual tracks over automatic ones,
  json3/vtt/srt parsed, YouTube's rolling automatic captions de-duplicated, output as JSON cues,
  SRT, WebVTT or plain text; `NOT_FOUND` lists the available languages.
- `POST /v1/comments`: `max` ≤ `COMMENTS_SYNC_MAX`, `sort=top|new`.
- `GET /v1/presets`: presets, includes, search sites, transcript formats and the JSON Schema of
  every request (generated from the Zod schemas). Recipe operations come with milestone 5.
- Requests are strict (unknown fields → 400); language tags exclude regex characters because yt-dlp
  treats `--sub-langs` as regular expressions; a client disconnect kills the yt-dlp run.
- Findings from capturing real yt-dlp output (fixtures in `test/fixtures/ytdlp`, IPs removed):
  `--use-extractors youtube` does **not** enable `ytsearch`, so search runs pass their search
  extractor explicitly; **`ytsearchdate` no longer exists**, so YouTube date order uses a results
  URL with the upload-date sort parameter; `requested_subtitles` is empty in the written info JSON,
  so subtitle files are found on disk.
- Bug found by tests: json3 end times summed in floating point (3.3600000000000003); now summed in
  integer milliseconds.
- Tests: unit (mappers against real captures, subtitle parsers/writers, search targets, presets,
  schemas, cursors, abort-on-disconnect) + 23 HTTP integration tests with the fake yt-dlp. Mutation
  check: removing the URL guard, auto-caption request, rolling de-duplication or stream-URL
  stripping each fails at least one test.
- Live (opt-in, `pnpm test:live`, real YouTube through the full app): 5/5 — info with formats,
  chapters and captions (no googlevideo URLs in the body), playlist page, search by relevance and by
  date, English transcript, top comments.

| # | Decision | Why |
|---|---|---|
| D12 | `/v1/info` accepts `limit` (1–200, default 50) and `preset` | Playlist page size; SPEC §7i mentions `requested_formats` for a preset |
| D13 | `/v1/comments` above `COMMENTS_SYNC_MAX` returns 400 for now | The 202 + `comments` job path needs the jobs table (milestone 2) |
| D14 | Transcript language tags are plain BCP-47 (`all` and patterns refused) | Synchronous calls return one track; patterns would be regexes inside yt-dlp |

### Step 6 — production image, compose bundle, end-to-end test, CI ✅ (milestone 1 complete)

- `Dockerfile` (media-service): built on `media-ffmpeg`; Node 24 copied from the official image,
  yt-dlp 2026.10.26 venv (default + curl-cffi extras, mutagen), deno 2.9.8, fonts (DejaVu,
  Liberation, Noto incl. CJK/Arabic), production node_modules, `dist/`, `drizzle/`, the `deploy/`
  bundle at `/app/deploy`, `cli` wrapper on PATH, UID 10001, revision label from `GIT_SHA`.
  arm64 image: 1.16 GB (Noto CJK and the Python venv are the bulk; worth trimming later).
- `deploy/docker-compose.yml`: `migrate` (one-off) → `api` (healthcheck, 127.0.0.1 port) →
  `proxy` (nginx, profile) plus `postgres`/`redis` profiles; read-only root FS, `/tmp` tmpfs,
  bounded json-file logs; networks `backend` (internal), `egress` (`br-media-egress`), `edge`.
  Workers, pot-provider and backup are added with the milestones that build them.
- `deploy/nginx/proxy.conf.template`: bundled proxy (API, MCP/events without buffering, docs, OAuth;
  health/metrics from private ranges only; everything else 404). `media.conf`/`front.conf` for the
  host nginx come with signed links (milestone 2) and milestone 10.
- `deploy/.env.example` documents every variable (comments on their own lines, because install.sh
  reads values verbatim); `deploy/smoke.sh` (hard: health, docs, auth, presets; real-site info is a
  warning unless `SMOKE_STRICT=1`).
- `scripts/e2e.sh`: builds the image, lays out an install directory like install.sh, starts the
  stack, creates a key with the in-image `cli`, runs `smoke.sh` (strict) through the proxy, then
  checks: API on 127.0.0.1 only, proxy 404s unknown paths, metrics from private addresses, UID
  10001, read-only root, writable /tmp and files volume, read-only inbox, yt-dlp/deno/ffmpeg 8.1 with
  whisper/fonts/bundle present, revision label, restart keeps data. **Result: e2e passed** (a real
  YouTube lookup through nginx → production container).
- `.github/workflows/ci.yml` (actionlint clean): `pnpm check`, installer bats/shellcheck, repo
  shellcheck on every push/PR; media-ffmpeg acceptance + `scripts/e2e.sh` on main. Image
  publishing (multi-arch, GHCR) is milestone 10. `./dev` now maps `host.docker.internal` to the
  host gateway so Testcontainers also works on Linux runners.
- Totals: `pnpm check` 215/215, installer 39/39, live 5/5, media-ffmpeg 23/23, e2e passed.

### Milestone 1 summary

Delivered: skeleton, config/env validation, database + migrations, API keys + CLI, auth and rate
limits, `info` / `search` / `transcripts` / `comments` / `presets`, health/metrics/OpenAPI,
production image, compose bundle, smoke and e2e tests, CI. Not yet: MCP (milestone 7),
`comments` jobs above the sync cap (milestone 2), Playwright E2E (there is no UI yet besides
Swagger; added when the Drive/upload pages arrive).

## Milestone 2 — single-item downloads ✅

### Step 7a — jobs data model ✅

- Migration `0001_jobs`: `jobs`, `outputs`, `media_files`, `job_logs` (SPEC §14), additive only.
  `media_files.job_id` (not in SPEC §14) points to the job whose outputs a dedup hit reuses (D15).

### Step 8 — download options and the yt-dlp argument builder ✅

- `src/downloads/options.ts`: SPEC §7a–7c plus the secret-free parts of §7f (rate limit,
  fragments, impersonation), strict Zod; timestamps normalised to seconds; sections must not
  overlap; cross-field rules (mkv-only features, keep_video with audio, bitrate vs VBR, …).
- `src/downloads/args.ts`: fixed flags (§7g: progress templates with markers, paths, retries,
  size cap, no-overwrites, single item), format/sort/container/audio extraction, sections and
  chapters (titles regex-escaped because yt-dlp treats them as regexes), SponsorBlock with a fixed
  title menu, subtitles/thumbnails/metadata/extras, filename menu, rate/fragments.
- `src/downloads/progress.ts` (marker lines → percent, bytes, speed, eta, fragments, post-processor),
  `src/downloads/classify.ts` (finished files → role + MIME; partial files skipped). The runner
  now streams stdout lines and accepts a per-run impersonation target.
- **yt-dlp bug found**: `--remove-chapters <time range>` together with any `--sponsorblock-*`
  option crashes yt-dlp 2026.10.26 (`TypeError: unhashable type: 'list'` in ModifyChapters). The
  API refuses that combination with a clear message, and a regression test asserts the crash so it
  fails (and says to lift the rule) once a yt-dlp update fixes it (D16).
- Codec preference uses `-S vcodec:<name>` with yt-dlp's names (`h265`, `av01`); SPEC §7a writes
  `+vcodec:`, but a leading `+` reverses the order in yt-dlp's sort syntax (D17).
- Tests: 34 builder/schema unit tests, 22 progress/classification tests, 2 streaming runner
  tests, and 6 real-yt-dlp downloads from a local Range-capable server: defaults (progress to 100%),
  a kitchen-sink option set, time-range removal, audio extraction with `keep_video`,
  `metadata_only`, plus the regression detector.

### Step 7b — job API ✅

- `POST /v1/jobs` (type `download`; other types and later fields — `then`, `destination`, cookies,
  proxy, … — answer `501 FEATURE_DISABLED` naming the milestone), `GET /v1/jobs` (cursor paging,
  `status`/`type` filters), `GET /v1/jobs/:id` (progress from Redis while running, outputs with
  signed links when done), `/outputs`, `/log` (redacted yt-dlp stderr, last 200 lines),
  `/events` (SSE: a snapshot whenever the job changes, ends with the final state), `POST /:id/retry`
  (failed/cancelled only), `DELETE /:id` (queued: removed from the queue; running: Redis cancel
  channel).
- `Idempotency-Key` per (client, user) for 24 h in Redis (released again if creation fails);
  `USER_MAX_ITEMS_PER_DAY` quota; disk guard (`STORAGE_FULL` 507 above `DISK_QUOTA_PERCENT`);
  `max_filesize_mb` ≤ `MAX_FILE_SIZE_MB`; `limit_rate_kbps` ≤ `JOB_RATE_LIMIT_MAX_KBPS`; URL guard at
  creation and again in the worker; jobs are private to (client, user) — others get 404.

### Step 9 — worker-dl ✅

- `src/worker.ts` (`WORKER_ROLE=download`), `@nestjs/bullmq` processor with
  `DOWNLOAD_CONCURRENCY`; up to 2 automatic retries with exponential backoff for transient codes
  (`TIMEOUT`, `EXTRACTION_FAILED`, `BOT_CHECK`, `UNAVAILABLE`, `INTERNAL`); deterministic failures
  fail at once (an `AppError` can override, e.g. "no media file produced").
- Executor: resolve info once (`-J`), refuse playlists/live (later milestones), duration limit
  (sections count, not the full video), dedup check, in-flight lock, download with
  `--load-info-json` (no second extraction from the site), progress to Redis (throttled to 1/s),
  size watchdog (every 3 s; aborts with `FILE_TOO_LARGE`), cancel via the Redis channel, files moved
  to `<FILES_DIR>/<jobId>/<outputId>/<name>`, media/audio probed with ffprobe, work dir always
  removed (before a job is marked cancelled).
- Error classifier fix found by tests: "HTTP Error 503: Service Unavailable" matched
  `MEDIA_UNAVAILABLE` via "unavailable" and was never retried; HTTP 5xx, timeouts and connection
  resets now map to a retryable `UNAVAILABLE` first.
- BullMQ 6 only accepts a client instance; its connection now lives in a module that closes it on
  shutdown (the shared one leaked and logged "Unhandled error event"). BullMQ job ids may not
  contain `:` (retry ids use `-retryN`).

### Step 10 — signed links, dedup, cleanup ✅

- `/d/:outputId?exp&sig`: HMAC-SHA256 over id + expiry, constant-time check, 404 for anything
  wrong (no reason given), then `X-Accel-Redirect: /_files/<encoded path>` with RFC 6266
  `Content-Disposition` (ASCII fallback + UTF-8 name) and the stored MIME type. nginx serves the
  bytes with Range support; `/_files/` is `internal`.
- Dedup (SPEC §9d): key = extractor + media id + preset + SHA-256 of canonical options (rate limit,
  fragments, impersonation, verify excluded); a hit copies the source job's outputs (new ids, shared
  files, fresh expiry) without running yt-dlp; concurrent identical jobs wait on a Redis lock and
  reuse the first result.
- Hourly cleanup (BullMQ job scheduler on `maintenance`, runs once per hour across workers): expired
  outputs; a file is deleted only when no unexpired output points at it; empty dirs pruned; never
  outside `FILES_DIR`; expired dedup rows; orphaned work dirs (not of running jobs); old job logs.

### Step 11 — compose and end-to-end ✅

- `worker-dl` service (read-only root, UID 10001, `stop_grace_period: 5m`); nginx `/d/` and
  internal `/_files/`; `FFMPEG_BIN`/`FFPROBE_BIN` set in the image.
- `smoke.sh` now also downloads a real video (360p) and fetches its signed link through nginx with
  `Range: bytes=0-15` → 206 and MP4 bytes (warning only, unless `SMOKE_STRICT=1`).
- `scripts/e2e.sh` adds: worker-dl running/hardened, the file on the host volume as
  `<jobId>/<outputId>/<name>`, no work dirs left, tampered links 404, `/_files/` unreachable.
- Finding: the first e2e run hit `507 STORAGE_FULL` — **this Mac's disk is 87% full**, above the
  default 80% guard. e2e now sets `DISK_QUOTA_PERCENT=99` (the guard has its own test).
- Tests this milestone: 30 pipeline integration tests (completion with media/subtitles/thumbnail,
  probe, storage layout, signed links incl. tampered/expired, redacted log, SSE, dedup, re-download on
  changed options, in-flight dedup, cancel running/queued, non-retryable vs retry, no-file failure,
  manual retry, idempotency, request validation, isolation, listing, watchdog, daily quota, disk
  guard) + 7 cleanup tests. **Totals: `pnpm check` 320/320, installer 39/39, e2e passed.**

### Milestone 2 summary

Delivered per SPEC §18: `media-ffmpeg` image (+ CI job), single-item downloads with the full §7a–7c
option set, `worker-dl`, progress (+ SSE), signed links via nginx, cleanup, dedup incl. in-flight,
cancel channel, watchdog. Still open from earlier notes: comment export jobs above the sync cap
(milestone 3), retry backoff is 30 s → 2 min (fixed, not configurable).

## Milestone 3 — playlists, channels, batches ✅

### Step 12 — selection, filters, caps (pure logic) ✅

- `items` selection `"1-20,25,-5"` → server-built `-I` plus an expansion bound; negative indices
  need the whole playlist. YouTube channel URLs normalised to the `channel_tab`.
- Filters (SPEC §7e) are applied by the service to expanded entries rather than composed into
  `--match-filters` (same effect, no yt-dlp filter syntax, literal title matching) (D18). Fields flat
  entries lack (YouTube: dates, likes) are re-checked on each item's full metadata; out-of-range
  items end `skipped`.
- Relative dates follow yt-dlp (`now-7days`, `now-1month`, …). **Bug found by tests:** "now-1month"
  from 31 Oct gave 1 Oct; months/years now clamp to the month's last day (29 Feb − 1 year =
  28 Feb).
- Plan: nested playlists skipped, filters, archive, `max_items`, `reverse`/`random`, caps
  (`PLAYLIST_MAX_ITEMS` unless narrowed; total duration with unknowns counted as
  `PLAYLIST_UNKNOWN_DURATION_MINUTES`).

### Step 13 — expansion, items, feeder, aggregate ✅

- One metadata call per job: items and `mode: single` resolve one video; other jobs expand flat
  and bounded (`--playlist-end PLAYLIST_MAX_ITEMS+1` or the selection), so a playlist URL becomes a
  parent without extracting every video. Expansions cached in `playlists` (migration `0002`, keyed by
  a hash of URL + arguments — column `cache_key`, D19) for `PLAYLIST_CACHE_TTL_MINUTES`.
- Original indices come from yt-dlp's `requested_entries` (flat entries carry no
  `playlist_index`) — confirmed live against YouTube.
- `ItemCoordinator`: items wait in the DB (`stage: waiting`); the feeder (Redis lock, per user,
  creation order so `reverse`/`random` change the download order) keeps ≤ `USER_MAX_CONCURRENT_ITEMS`
  active per user, counting single jobs too; triggered after expansion, after each job, and every
  5 s. Parent status: all done → `completed`, some failed/cancelled → `completed_with_errors`,
  all failed → `failed`; a cancelled parent stays cancelled.
- UUIDv7 is now monotonic within a millisecond (12-bit counter, RFC 9562 method 1), so creation
  order is exact; a generator factory keeps tests independent.
- Bugs found by tests: items carried a `checks` key the strict options schema rejected (ZodError
  retried as INTERNAL); re-queued items reused their BullMQ id, which BullMQ silently ignores while
  it remembers the failed run — items now use attempt-numbered ids like single jobs.

### Step 14 — batches, archive, comment exports ✅

- `type: batch` (≤ `BATCH_MAX_URLS`, else `BATCH_TOO_LARGE` 422): a parent with one item per URL,
  each with its own options; daily quota counts every URL.
- Archive (migration `0002`): every completed download is recorded per (client, user);
  `skip_downloaded` skips archived entries at expansion. `GET /v1/archive`, `POST /v1/archive`
  (import ≤ 1000), `DELETE /v1/archive/<extractor>:<media_id>`.
- `type: comments`: exports above the sync cap into a `comments` JSON output (closes D13).

### Step 15 — job packages and parent API ✅

- `archive_url` (store-only ZIP, streamed by the API with yazl, `NNN - name` per item, unique
  names) and `manifest_url` (M3U of signed media links) on parents and multi-output jobs; one
  signature covers `job:<id>`.
- `GET /v1/jobs/:id/items` (playlist order, cursor, status filter); `/outputs` aggregates a parent's
  items; items stay out of `GET /v1/jobs`; parent cancel cancels queued items (removed from the
  queue) and signals running ones; parent retry re-queues only failed/cancelled items.
- Not yet: `concat_items` (needs the ffmpeg queue, milestone 5), `channel_tab` `playlists`/`all`
  (nested playlists), `break_on_existing` (watches, milestone 8) — all answer `FEATURE_DISABLED`.
- Tests: 25 unit (selection, channel tabs, filters, dates, plan) + 23 playlist/batch integration
  (whole playlist, concurrency bound, item paging, output aggregation, ZIP verified with `unzip -t`,
  M3U, bad signatures, archive + skip + removal, expansion cache, selection, max_items/reverse order,
  filters, date skips, single-mode refusal, validation, batch partial failure, all-failed + retry,
  parent cancel, batch cap, comment export, playlist cap) + 1 live (real YouTube playlist items
  2–3 at 360p). **Totals: `pnpm check` 368/368, live 6/6, e2e passed.**
- Follow-up: `test/integration/jobs/downloads.spec.ts` predates the shared `support/jobs.ts`
  helper and still has its own copy of the setup.

## Milestone 4 — inputs ✅

- Migration `0003_uploads`: `uploads`, `inputs` (`inputs.source_hash` added as the URL cache key —
  the content hash is only known after the fetch, D21).
- **ffprobe hardening:** always `-protocol_whitelist file,crypto`, plus the SPEC §5 container
  allow-list (`isAllowedFormat`). Tested: probing a fetched HLS playlist never requests its segment
  URL.
- **Inputs** (`src/inputs`): `upload` (must be `ready`, same user), `inbox` (bare names, no dotfiles,
  `lstat` rejects symlinks, realpath must stay in `INBOX_DIR/<client>/`), `output` (same user, or
  same client when the key has `share_outputs_within_client`; each reuse extends the expiry), `url`
  (streamed with a size cap, manual redirects ≤ 5 with the URL guard on every hop, `Referer`/
  `User-Agent` only, audio/video/image/octet-stream only, cached by source for
  `INPUT_CACHE_HOURS`, identical content stored once). `media_url` and `google_drive` answer
  `FEATURE_DISABLED` until milestones 5 and 9.
- **Uploads (tus 1.0 via `@tus/server` + `FileStore` on the files volume):** `POST /v1/uploads`
  (declared size ≤ `MAX_UPLOAD_SIZE_MB`, daily byte quota, file name reduced to a base name) creates
  the upload in the store and returns `tusUrl` + a short-lived HMAC upload token; `/u/:id` accepts
  only HEAD/PATCH/OPTIONS/DELETE with that token (creation and GET closed); finished uploads are
  probed: allowed media → `ready`, anything else → `rejected` (status not in SPEC, D22).
  `GET`/`DELETE /v1/uploads/:id` (received bytes while uploading, for resuming).
- `POST /v1/probe` (sync up to `PROBE_MAX_MB`; larger URL inputs → `202` with a `probe` job whose
  output is a JSON report), `GET /v1/inbox`, `GET /v1/outputs` (reusable outputs).
- Cleanup also removes expired uploads (file + tus metadata) and cached inputs (file only when no
  cache entry still points at it). nginx `/u/` streams uploads without request buffering.
- Finding: Fastify's in-process `inject` cannot stream a PATCH body into a hijacked tus request;
  the tus tests run over a real socket (as production does), and e2e uploads through nginx.
- Tests: 21 integration (chunked upload with resume, token rules, `/u` creation closed, finished
  upload probed, private to the user, non-media rejected, size limit, delete; inbox listing and 4
  refusal cases; URL fetch + cache, 4-hop redirects ok / 6 refused / redirect to a private IP
  refused, non-media, 404, private address, HLS segment never fetched, oversized → probe job with
  report; media_url/drive refused; output reuse with expiry extension and owner check) + e2e: tus
  PATCH through nginx → 204, upload `ready`, probe 200. **Totals: `pnpm check` 389/389, installer
  39/39, e2e passed.**

## Milestone 5 — ffmpeg core ✅

### Step 16 — dev toolbox on the production ffmpeg ✅
- `docker/dev/Dockerfile` now copies ffmpeg/ffprobe **n8.1.3** from `media-ffmpeg` (and installs the
  same runtime packages, which the ffmpeg image now keeps in
  `/usr/local/share/media-ffmpeg/runtime-packages.txt`) instead of Debian's 7.1, so recipe tests run
  on the server's build. `./dev` explains how to build `media-ffmpeg:dev` when it is missing; CI's
  check job builds media-ffmpeg first (GHA cache) and passes it in. Whole suite re-run on 8.1: green.

### Step 17 — recipe schema, validator, composer, cost model ✅
- `src/recipes/`: `schema.ts` (Zod for the milestone 5 operations: trim, cut_out, speed, reverse,
  boomerang, fps, timelapse, loop, fade, pad_duration, audio_offset, scale, crop, rotate, pad,
  aspect; terminals encode, split, thumbnail, contact_sheet, gif, remux, fix; analyses probe,
  keyframes, loudness, volume, silence_detect, black_detect, scene_changes). Every milestone 6
  operation in SPEC §8 answers `FEATURE_DISABLED` naming the milestone; unknown ops and unknown
  fields are `RECIPE_INVALID` with `steps.N.field` paths.
- `validate.ts`: shape, caps (`RECIPE_MAX_STEPS`, `RECIPE_MAX_OUTPUTS`), names (default = op,
  unique), cross-field rules, container/codec compatibility, CRF ranges per codec, presets per
  encoder, two-pass availability.
- `compose.ts` builds the `-filter_complex` graph: filter outputs read several times get one
  `split`; unread branches (analyses) drain into one `-f null` output (ffmpeg refuses graphs whose
  only ends are sinks — found while testing). A leading `trim` becomes input seeking (`-ss`/`-t`,
  chapters kept and shifted by ffmpeg), later trims become filters; a leading `loop` becomes
  `-stream_loop` (no memory), a later one is capped like `reverse`. Copy terminals and
  `remux`/`fix` refuse to follow filters. Two-pass and `target_size_mb` add a pass-1 stage on the
  same graph; `crop: auto` asks for a measurement stage (cropdetect on keyframes only) and is
  recomposed with the result. Text never goes into the graph: chapter titles go to an ffmetadata
  file written by the service; metadata values are separate argv elements.
- Input: `-protocol_whitelist file` on every `-i`; outputs `-fs MAX_FILE_SIZE_MB`, `-threads`,
  `-filter_complex_threads`; ffmpeg runs under `nice -n 10`.
- Cost model (`Plan.cost`, ≈ minutes of 1080p30 x264 veryfast): decode + filters (minterpolate,
  reverse weighted) + per-output codec weight × pixel rate × preset × passes. Above
  `RECIPE_MAX_COST` → `RECIPE_TOO_EXPENSIVE` before anything runs; timeout =
  `RECIPE_TIMEOUT_BASE_MINUTES + factor × max(input minutes, cost)`.
- `analysis.ts` parses ffmpeg 8.1's real log lines (captured, anchored `[Parsed_<filter>_N @ 0x…]`;
  indented input metadata cannot spoof them); `run-stage.ts` runs a stage (minimal env, progress
  from `-progress pipe:1`, cancel, timeout, failures → `RECIPE_INVALID` with server paths removed;
  killed by a signal → retryable `INTERNAL`); `run-recipe.ts` loops measurements, checks cost, runs
  stages, collects outputs (an output at the `-fs` cap is `FILE_TOO_LARGE`, an empty one is
  `RECIPE_INVALID`).
- Tests: 73 unit (validator, composer argument building, parsers) + 12 integration on real ffmpeg
  8.1: multi-terminal single pass (webm vp9/opus, mp3, thumbnails, numbered PNGs, GIF, contact
  sheet), two-pass to a target size, every analysis with expected values (silence 2–3.5 s, black
  2–4 s, scenes at 2 and 4 s, 6 keyframes), crop auto removing letterboxing, speed/fade/cut_out/
  reverse/boomerang/loop durations, rotate pixels vs display matrix, split copy vs accurate, remux
  subtitles (refused, then converted to mov_text), fix, chapters and metadata, cost refusal, broken
  input and cancellation.

### Step 18 — process jobs and worker-ff ✅
- `POST /v1/jobs` `{ type: "process", inputs, recipe }`: static recipe validation at creation
  (400/501), input-dependent checks on the worker. Several inputs and `destination` answer
  `FEATURE_DISABLED` (milestones 6 and 9). Process jobs go to the new `ffmpeg` queue; cancel and
  retry pick the queue by job type.
- `WORKER_ROLE=ffmpeg` → `worker-ff` (`FfmpegProcessor`, `ProcessExecutor`); the queue bookkeeping
  (retry vs fail, unrecoverable errors, parent/feeder update) moved into a shared `JobProcessor`
  base used by both workers. Tests run both roles in one process.
- `ProcessExecutor`: resolves the input (output sharing per API key travels as an internal
  `_share_outputs` job option, hidden from job views, D24), `MEDIA_TOO_LONG`, daily
  `USER_MAX_PROCESS_MINUTES_PER_DAY` (counted once per job across retries), progress
  `{ stage: "processing", step, percent, speed }`, outputs stored as `<jobId>/<outputId>/<stem>.<name>.<ext>`
  (stem from the upload/inbox/output/URL name), reports as JSON outputs with role `report`.
- Compose: `worker-ff` (models read-only, `WORKER_FF_CPUS` / `WORKER_FF_MEMORY`, 0 = no limit).
- Tests: 12 integration (recipe outputs with roles, names, probes; a download output as recipe
  input; 7 refusal cases; recipe/input mismatch fails without retry; missing input; cancel while
  running cleans the work dir; daily minutes quota) + e2e: worker-ff hardening, a recipe on the tus
  upload, output downloaded through nginx and verified 80x60. **Totals: `pnpm check` 486/486,
  installer 39/39, e2e passed.**

### Step 19 — `then` pipelines ✅
- Downloads, batch items and playlist items accept `then` (an inline recipe, validated at creation
  with a `then:` / `items.N: then:` prefix) and `keep_original`. Neither is a download option, so
  the download dedup key is unchanged. Medialess presets with `then` are refused.
- A download with `then` stores its files, stays `running` with stage `processing`, and is queued on
  `ffmpeg` (BullMQ id `<job>-then[-retryN]`) **after** worker-dl removed its work directory —
  queuing earlier let that cleanup delete worker-ff's directory (race found by the tests). worker-ff
  runs the recipe on every media/audio output (progress "file i/n, stage j/m"), then completes the
  job; a playlist parent completes when its items do. worker-dl skips redelivered jobs that are
  already in `processing`.
- `keep_original: false` (the default with `then`) hides the replaced originals (new column
  `outputs.hidden`, migration `0004_output_hidden`): they leave job views, packages, `/v1/outputs`,
  output inputs and signed links, but stay for dedup and normal expiry (deleting them would leak
  the files, since cleanup works from output rows).
- **Bug fixed:** download dedup reuse copied every output of the cached job; with pipelines that
  would hand recipe outputs to a later plain download. Reuse now copies only outputs carrying the
  download's `media_file_id`. Regression test plus a mutation check (the test fails without the
  fix).
- `deploy/smoke.sh` now also runs a recipe (thumbnail of the smoke download) on worker-ff; it must
  pass whenever the download did.

### Step 20 — process dedup ✅
- SPEC §9d: process jobs dedupe on (input content, canonical recipe). Resolved inputs carry an
  identity (`upload:<id>`, `file:<stored path>`, `sha256:<content>` for URLs,
  `inbox:<realpath>:<size>:<mtime>`); the recipe hash is taken after parsing, so defaults spelled
  out or left out hash the same. Hits copy the cached job's outputs (Drive fields reset) through a
  `media_files` row (`extractor = recipe`).
- Tests: pipelines (original replaced, `keep_original`, dedup after a pipeline with a real-download
  count, every playlist item processed, 4 refusals, batch item validation, recipe failure) and dedup
  (identical/spelled-out recipe reuses files; another recipe or replaced content runs again).
  **Totals: `pnpm check` 498/498, installer 39/39, e2e passed (incl. smoke recipe).**

### Milestone 5 summary
Recipes run end to end on the production ffmpeg: schema and validation, composer with single-pass
multi-output graphs, measurements and two-pass stages, cost model and timeouts, worker-ff, process
jobs, `then` pipelines and dedup. Deferred to milestone 6 by design: every other §8 operation,
named recipes, several inputs, `split` by chapters/silence/scene, `cover`, `video.color`,
animated WebP/AVIF, contact-sheet timestamps (fonts), `concat_items`, implicit `job_output`
inputs (subtitles/thumbnail of the download for burn-in and covers).

## Milestone 6 — ffmpeg extended ✅

### Step 21 — visual filters and the audio suite ✅
- `src/recipes/ops/visual.ts` (deinterlace, denoise ×3 methods, sharpen, blur, color — eq/hue/
  temperature/vibrance/exposure/balance/curves/sepia/grayscale/invert —, vignette, grain, deband,
  deflicker, region_blur, region_pixelate, drawbox, stabilize, tonemap, dedupe_frames,
  lens_correction) and `ops/audio.ts` (gain, normalize_loudness, compress, limiter, silence_trim,
  channels, pitch, tempo, eq, bass, treble, high/low/bandpass, remove_hum, denoise_audio, deesser,
  echo, stereo_width, vocal_reduce, resample, audio_delay, silence_pad, trim_to_shortest,
  remove_audio). The composer now exposes a small `FilterContext` to these modules.
- Measurement passes are generic (`measured(key, kind, pad, filter)`): crop (keyframes only), peak
  (`gain.to_peak_dbfs` via volumedetect), loudnorm (two-pass `normalize_loudness`, linear second
  pass with the measured figures, back to the input sample rate), silence (`silence_trim` cuts
  exactly at the detected leading/trailing silences, picture and sound together), vidstab
  (`stabilize` writes its transforms file into the job directory; filtergraph paths are checked
  against a safe character set instead of escaped).
- Levels in dB are converted where ffmpeg wants linear values (acompressor, alimiter); `tempo` and
  `pitch` without `preserve_tempo` are refused on media with video (they would desync); `tonemap`
  checks the input's transfer (new `color_transfer` in the probe summary) and refuses SDR, where
  zscale has no colour path (found on real ffmpeg). `lut3d` waits for recipe assets.
- Tests: 11 unit (argument building, measurement round trips, refusals) + 51 integration on real
  ffmpeg: every operation and variant runs; two-pass normalisation lands within ±1.5 LU of the
  target; gain hits a −3 dBFS peak; silence_trim trims 1 s + 1.5 s; stabilise; mono, tempo,
  remove_audio, pitch without tempo; `-shortest`; HDR10 fixture tone-mapped to bt709.
  **Totals: `pnpm check` 560/560.**

### Step 22 — composition with several inputs ✅
- Process jobs take several inputs (the milestone 5 refusal is gone); `inputs[0]` is the main one,
  steps refer to others by index (`input`, `inputs[]`). The composer, runner and executor carry the
  whole list; recipe dedup hashes every input's identity in order.
- `ops/composition.ts`: `concat` (normalise every part onto the canvas — size, 30/25 fps, 48 kHz
  stereo, silence or black filled in for missing streams — or `xfade` + `acrossfade` transitions;
  `copy` through the concat demuxer with `-safe 1`, the inputs symlinked into the job directory
  under plain names and checked for identical codec parameters), `overlay_image` (position menu or
  x/y, margin, scale, opacity, time window, `tile` grid capped at 100), `overlay_video`
  (picture-in-picture, border, start offset, audio main/overlay/mix), `stack` (horizontal,
  vertical, grid via xstack with gaps), `chromakey` (colour or input background; still images are
  looped), `slideshow` (fit or Ken Burns, transitions, music trimmed and faded), `audio_to_video`
  (waveform, spectrum, bars, cover, none), `generate` (black, color, test pattern, tone, silence,
  noise; before/after/replace; slate waits for text), `mix_audio` (weights, normalise, ducking via
  sidechaincompress), `replace_audio`, `add_audio_track` (extra streams with language, title,
  default disposition), `select_streams`, `extract_streams` (copy or raw elementary streams:
  .h264/.hevc/.obu/.ivf/.aac; mov_text → SRT).
- `encode.cover` (attached picture: mp4, m4a, mov, mkv, mp3, flac; refused for ogg/opus).
  Language codes become ISO 639-2 for MP4/MOV/M4A, which drop anything else silently (found on
  real ffmpeg); Matroska keeps BCP-47.
- Fixed on the way: a filter chain changing media type (showwaves etc.) needs an explicit output
  kind, or the split inserted for it is an `asplit`; `showfreqs` followed by an `fps` filter
  stalls (40 s for 6 s of audio) — its own `rate` option is used.
- Tests: 17 integration on real ffmpeg (every operation, durations and sizes checked) + a process
  job joining a download output and an inbox file through the API. **Totals: `pnpm check`
  577/577.**

### Step 23 — text, fonts, subtitles ✅
- **Fonts:** `FontCatalog` scans `FONT_DIR` once per worker-ff and names every face from its own
  OpenType `name` table (TTF/OTF/TTC; typographic family/style first), so the allow-list is what
  is installed (DejaVu, Liberation, Noto in the image; the dev toolbox now installs the same, CJK
  aside). Unknown families are refused with the installed list.
- `text`: drawtext with the text in a service-written file and `expansion=none` (no `%{…}`
  evaluation), font by family + bold/italic, size, colour/opacity, position menu or x/y, box,
  outline, shadow, alignment, line spacing, time window, burnt-in `timecode`;
  `RECIPE_MAX_TEXT_LAYERS` enforced. Contact-sheet `timestamps` and `generate` slates use it too.
- Subtitles: `subtitles_burn` (file input or embedded track; libass with `fontsdir` and an ASS
  `force_style` from validated fields; picture subtitles via overlay; `shift_ms` via a pre-stage
  writing a shifted ASS copy; sources reach the graph only as symlinks under plain names in the
  job directory), `subtitles_mux` (mov_text for MP4/MOV, WebVTT for WebM, copy/SRT/ASS for MKV;
  language, title, default/forced), `subtitles_extract` (per track, named by language),
  `subtitles_convert`, `subtitles_shift` (input offset for subtitle files), `subtitles_strip`.
- Pipelines get the download's subtitles and thumbnail as implicit inputs: steps can refer to
  `{ "job_output": "subtitles", "lang": "en" }` (also for overlays, covers and audio_to_video).
- Tests: 7 integration on real ffmpeg (font scan; drawn text measured as brightness only inside
  its window; literal `%{…}`; unknown font; timecode; burn from file, styled, shifted, and from a
  track; mux into MP4/MKV; extract/convert/shift/strip; timestamps and slate) + a pipeline burning
  the downloaded English subtitles. **Totals: `pnpm check` 586/586.**

### Step 24 — images and packaging ✅
- `ops/images.ts`: `thumbnails_scene` (scene score + minimum gap), `storyboard` (sprite sheets
  plus a WebVTT index with `#xywh=` cues, written by the composer since the geometry is known),
  `animated_webp`, `animated_avif` (libaom), `frames` (every_s/fps/all, capped by
  `FRAMES_MAX_COUNT`; one ZIP by default or numbered files), `image_convert` (jpg/png/webp/avif/
  gif/bmp/tiff, alpha flattened onto a colour), `image_resize`/`image_crop` (aliases of
  scale/crop), `images_to_video`, `ken_burns`, `poster_frame` (cover art for later encodes),
  `audio_visual` (waveform/spectrogram images, waveform/spectrum/bars/vectorscope video).
- `ops/package.ts`: `hls` (automatic 1080/720/480/360 ladder capped at the source, or explicit
  variants; fMP4 or MPEG-TS segments; keyframes on segment boundaries; optional audio-only
  rendition), `dash` (one audio set, template/timeline or single file; every rendition gets the
  source's display aspect ratio — DASH refuses 426x240 next to 640x360, found on real ffmpeg),
  `fragmented_mp4`, `mpegts`, `bitstream` (annexb, adts_to_asc, remove_sei), `segment`.
- **Directory outputs:** packages are folders (`outputs.is_directory`, new `outputs.entry` —
  migration `0005_output_entry`). Their links put the token in the path —
  `/d/hls/<outputId>/<exp>/<sig>/master.m3u8` — so the playlists' relative URLs keep it; the
  route allows up to 4 plain path segments with known extensions, answers with X-Accel-Redirect
  into the package and `Access-Control-Allow-Origin: *` for web players. Job ZIPs now include
  package folders with their layout.
- Fixed on the way: execa timeouts must be integers (recipe deadlines were fractional).
- Tests: 10 integration on real ffmpeg (every operation; storyboard VTT geometry; HLS ladder with
  4 renditions; DASH init segments; fragmented MP4 `moof`; Annex B start code; segment count) + an
  API test (path-signed package links, sub-files, traversal/unknown type/tampered signature → 404,
  ZIP layout) + e2e: HLS master and variant playlists through nginx. **Totals: `pnpm check`
  597/597, e2e passed.**

### Step 25 — the full analysis set and transcribe ✅
- `ops/analyze.ts`: `freeze_detect`, `crop_detect`, `interlace_detect` (from the log; idet's
  verdict needs one field order to dominate — on synthetic motion progressive video reports both
  orders about equally, seen on real ffmpeg), `duplicate_frames` (frames tagged then counted from
  `metadata=print` files — untagged frames print nothing), `quality_compare` (reference scaled to
  the picture; VMAF via libvmaf JSON log, PSNR/SSIM stats files; identical frames' infinite PSNR
  reported as 100 dB), `hash`/`streamhash`, `frame_hashes`, `peaks` (astats per window → 0–1
  values for waveforms), `bitrate_timeline` (ffprobe packet sizes per window).
- **transcribe:** ffmpeg 8.1's whisper filter (16 kHz mono, `use_gpu=0`, queue 20 with VAD / 10
  without, `max_len`), SRT/JSON/text written by whisper.cpp, WebVTT converted in a post-stage.
  `worker-ff` probes at start (filter present, model files, AVX2 on x86-64) and reports the reason
  as `FEATURE_DISABLED` when it cannot run. Cost weights per model (fast 2, balanced 6, accurate
  15 units per minute).
- `deploy/models.sh` (the bundle's contract with install.sh): `list`, `env NAME…` (most accurate
  selected model as default, Silero VAD), `sync ENV_FILE` (downloads into ./models, keeps files of
  the right size, verifies SHA-256 pinned from the Hugging Face listings, world-readable for uid
  10001). 6 bats tests; a variable-scoping bug (`entry` overwrote the caller's `name`) found by them.
- The dev toolbox carries whisper.cpp's `jfk.wav`; the base model is cached under `.cache/models`
  (git- and docker-ignored); the transcription test skips without it.
- Tests: 6 integration on real ffmpeg (every analysis with expected values; real transcription of
  jfk.wav into SRT/WebVTT/text; refusals) + e2e: transcription through the full stack, transcript
  downloaded through nginx. **Installer + models: 45/45.**

### Step 26 — delivery: platforms, colour, split modes, named and saved recipes ✅
- `platform_format` (youtube, youtube_shorts, instagram_feed/reel/story, tiktok, x, facebook,
  linkedin, whatsapp, pinterest; crop/pad/blur, fps cap, duration cap) also sets the H.264 profile,
  level, peak bitrate and AAC bitrate for the encode that follows unless the recipe sets them.
- `video.color` (bt709/bt601/bt2020, tv/pc): swscale conversion plus frame tags via `setparams` —
  the encoder takes colour tags from the frames, `-color_*` options alone left primaries and
  transfer untagged (found on real ffmpeg). New container `m4b`.
- `split` by `by_chapters` (probe now reports chapters), `by_silence`, `by_scene` (measurement
  passes); `crossfade` points to `concat.audio_crossfade_s`. No operation of SPEC §8 is refused as
  "later" any more.
- **Built-in recipes** (SPEC §8k, all 21): `recipe: "web_mp4_720"` or `{ preset, params }`
  (clip, compress_to_size, gif_preview, burn_subtitles take parameters). **Saved recipes**
  (migration `0006_recipes`, per client): `GET/PUT/DELETE /v1/recipes/:name`, validated like job
  recipes, built-in names reserved. Names are expanded at job creation and the steps are stored on
  the job (`{ name, steps }`), so later edits never change queued jobs; works for `then` too.
- Tests: 21 presets validated and composed (unit), 4 integration on real ffmpeg (split by
  chapters/silence/scene; bt601 tags; reel 1080x1920 High@4.1, WhatsApp Main@3.1; audiobook M4B
  with chapters, social_vertical, clip, media_report) + 3 API tests (recipe CRUD and refusals,
  jobs from saved/preset/parameterised recipes, names in pipelines). **Totals: `pnpm check`
  630/630, installer + models 45/45, e2e passed (incl. transcription).**

### Step 27 — concat_items ✅
- Playlists and batches take `concat_items: true`. When the last item ends and at least two
  completed, the coordinator hands the parent to worker-ff (stage `processing`, BullMQ id
  `<parent>-concat[-retryN]`) instead of completing it; worker-ff joins each item's first media
  file in playlist order (normalised concat, MP4 — M4A when all items are audio), stores the
  result on the parent (`playlist.joined.mp4`) and completes the parent with the status the items
  earned. More items than `RECIPE_MAX_INPUTS`, or a failing join, end the parent
  `completed_with_errors` with the reason; the items keep their outputs. Parent output lists and
  ZIPs now include the parent's own outputs after the items'.
- Tests: a 3-item playlist (joined file 6 s) and a batch.

### Milestone 6 summary
Every operation of SPEC §8 is available: composition with several inputs, the visual and audio
suites, text and subtitles with an installed-font allow-list, images, HLS/DASH packages served by
path-signed links, the whole analysis set with whisper.cpp transcription and the models volume
(`models.sh`), platform formats, all 21 built-in recipes and saved recipes, `concat_items`. Found
and fixed against real ffmpeg 8.1 along the way: DASH aspect ratios, showfreqs + fps stall,
media-type changes in split insertion, MP4 language codes, colour tags on frames, tonemap on SDR,
idet on synthetic motion, metadata printing of untagged frames, fractional execa timeouts.
**Totals: `pnpm check` 631/631, installer + models 45/45, e2e passed (incl. HLS through nginx and a
real transcription).**

## Milestone 7 — MCP server ✅

### Step 28 — `/mcp` with every tool of SPEC §6 ✅
- `@modelcontextprotocol/sdk` 1.32.2 (accepts Zod 4). `/mcp` is an ordinary Nest route, so the API
  key guard and the per-key rate limit apply exactly as for REST; the request is then handed to the
  SDK's Streamable HTTP transport in stateless mode with JSON responses (GET/DELETE → 405). A
  server with all tools is built per request, bound to the caller's key.
- 30 tools as listed in SPEC §6, each calling the same service as its REST route with the same
  Zod schemas (`downloadJobSchema`, `processJobSchema`, … reused as tool input schemas), `user_id`
  per call (the key's default otherwise). Results are JSON text with links and metadata, never file
  bytes; `AppError`s become tool errors carrying the REST error body. Cookies, watches, Drive and
  `record_live` answer `FEATURE_DISABLED` naming their milestone.
- Refactors so REST and MCP share code: `InputsService` (probe, inbox, outputs), `ArchiveService`,
  and a shared catalog (`GET /v1/presets` = `list_presets`) that now carries every recipe operation
  with its JSON Schema (generated from the Zod schemas), the job and input schemas, and the
  built-in plus saved recipes.
- Tests: 6 integration with the SDK client over real HTTP (401 without key, 405 on GET, exactly the
  SPEC tool list, discovery and catalog, a download and a recipe per end user with signed links and
  per-user isolation, uploads/inbox/outputs/archive, tool errors for later features, invalid
  arguments, recipe errors and a missing user id) + e2e: tools/list and tools/call through nginx,
  401 without a key. **Totals: `pnpm check` 637/637, installer + models 45/45, e2e passed.**

## Milestone 8 — access, live recording, watches ✅

### Step 29 — cookie and credential vault ✅
- `cookie_jars` and `site_credentials` (migration `0007_access_vault`). Secrets are AES-256-GCM
  (`src/common/secrets.ts`) with the key version in the token, so every configured key decrypts and
  the newest encrypts; the associated data binds each ciphertext to client, user and jar/site, so
  a row copied to another user does not decrypt. RFC 6238 TOTP (checked against the RFC vectors).
- `PUT/GET/DELETE /v1/cookies[/:id]`: Netscape files are validated line by line (JSON exports,
  malformed rows, control characters and expired-only jars are refused with the line number),
  expired cookies are dropped, contents are never returned (lists show label, domains, count,
  expiry, default). One default jar per user (partial unique index); deleting it promotes another.
  At most 20 jars per user. MCP `set_cookies` / `list_cookies` / `delete_cookies`.
- `PUT/DELETE /v1/credentials/:site` behind `SITE_CREDENTIALS_ENABLED` (delete always works).
- `cli secrets:reencrypt` for key rotation (DEPLOY.md runbook updated).
- Tests: 4 parser, 3 crypto/TOTP, 8 vault integration (encryption at rest, replace by label,
  default handling, per-user scoping, refusals, credentials flag, TOTP, rotation and retiring the
  old key), CLI unit + integration, MCP cookie round trip.

### Step 30 — access options in downloads, PO tokens ✅
- New per-item options (SPEC §7f): `cookies`, `credentials`, `video_password`, `tv_provider`,
  `proxy`, `geo_country`, `extractor_args` (youtube.player_client/lang/max_comments/comment_sort
  only), `mark_watched` (needs cookies). All optional without defaults, so existing dedup keys
  are unchanged. Checked at creation (jar and login exist, proxy in `PROXY_POOL`, country in
  `GEO_BYPASS_ALLOWLIST`, player clients in `YTDLP_ALLOWED_PLAYER_CLIENTS`, TV provider flag) and
  again on the worker for what the owner may change meanwhile.
- Worker (`JobAccessResolver`): the jar is written to a job-local 0600 file for the run and
  overwritten then removed afterwards; logins get a fresh TOTP; proxy by name, else
  `PROXY_DEFAULT_BY_EXTRACTOR` (URL host before extraction, the real extractor for the download).
- **Privacy (D42):** media fetched with cookies, credentials, a video password or a TV login gets
  a dedup key scoped to `(client, user)`, and the playlist cache key carries the same scope.
  Without this, a members-only video or private playlist fetched by one user would be handed to
  another (SPEC §9d).
- **Per-request secrets (D43):** `video_password` and `tv_provider` are sealed into `_secrets`
  (AES-GCM, bound to the user) before the job is stored, are hidden from every view, travel to
  playlist items sealed, and are deleted when the job finishes or is cancelled (parent: right
  after expansion). A manual retry after that needs them sent again.
- One composed `--extractor-args youtube:` value (comments + whitelisted keys), so no option
  silently overrides another.
- PO tokens: plugin `bgutil-ytdlp-pot-provider==2.0.2` in both images, `pot-provider` Compose
  service (`brainicism/bgutil-ytdlp-pot-provider:2.0.2`, read-only, uid 10002, no capabilities,
  node health check), `YTDLP_POT_PROVIDER_URL=http://pot-backend:4416` (backend-only alias, step 39) by default in
  `.env.example`; every yt-dlp run passes `youtubepot-bgutilhttp:base_url`. Verified against real
  YouTube: yt-dlp lists `bgutil:http-2.0.2 (external)` as available.
- Password failures now classify as `LOGIN_REQUIRED` (were retried as `EXTRACTION_FAILED`).
- Tests: access args/proxy/sealing unit (8), runner PO-token flag, extractor-args merge, error
  classes (3 new, written failing first), 7 integration with the fake yt-dlp's new `/members`,
  `/locked`, `/login` (cookie jar required and shredded, no cross-user reuse but same-user reuse,
  proxy/geo/extractor args/mark_watched reaching yt-dlp, default proxy per extractor, sealed
  password never stored in clear and cleared after success and failure, playlist items, TOTP
  login, every refusal incl. batch prefixes); e2e: provider healthy, reachable from worker-dl,
  plugin active on a real extraction. **Totals: `pnpm check` 672/672, deploy 45/45, e2e passed.**

### Step 31 — live `record` jobs ✅
- `type: record` (SPEC §7d): `preset` (video tiers), `container` mp4/mkv/mov, `from_start`,
  `max_duration_minutes` (≤ `LIVE_MAX_DURATION_MINUTES`), `wait {min_minutes, max_minutes}`
  (`--wait-for-video`; the total wait is capped by `LIVE_MAX_WAIT_MINUTES`, enforced by the
  service because yt-dlp would retry forever), `split_every_minutes`, the access options,
  impersonation and rate limit. Status `waiting` → `recording` → `running` (remux) → `completed`.
- `RecordExecutor`: metadata first (live → record; upcoming → `LIVE_NOT_STARTED` unless `wait`,
  or when it starts after the wait cap; ended → "use a download job"), then yt-dlp with
  `--hls-use-mpegts`. Duration cap, size watchdog and cancel all stop yt-dlp with **SIGINT** via a
  new runner `stopSignal` (SIGKILL backstop after 120 s); yt-dlp tells ffmpeg to finish the file
  and exits 0. A `.part` left by a hard exit is salvaged. ffmpeg remuxes `-c copy` (video and
  audio only, faststart), or into segments with `-segment_time` and `-reset_timestamps`.
- Progress for live HLS comes from ffmpeg's own `\r`-separated stats on stderr (yt-dlp's template
  is silent there): bytes, recorded seconds, rate. ffmpeg's `[https @ …] Opening '…'` lines
  carry signed CDN URLs and the server's IP; they stay out of the job log.
- **ffmpeg rebuilt with GnuTLS (D45):** yt-dlp's ffmpeg downloader needs https; our build had
  only http and every live recording failed with "ffmpeg exited with code 8". `docker/ffmpeg/test.sh`
  now checks the https protocol.
- A download job on a live stream now fails at once ("record it with a record job") instead of
  `FEATURE_DISABLED`; job views list the outputs of cancelled recordings (D44).
- Tests: remux/wait args (3), ffmpeg stats parser and noise filter (4, from real captured lines),
  8 integration with the fake's `/live`, `/upcoming`, `/ended` (real MPEG-TS, real ffmpeg): record
  to the stream's end, cancel with SIGINT keeping an MKV, salvage, segments (3 × ~60 s), waiting
  premiere, ffmpeg-stats progress and a clean log, every refusal and creation limit; MCP
  `record_live`; e2e: a real YouTube 24/7 live stream recorded for 15 s, stopped, remuxed MP4.

### Step 32 — watches ✅
- `watches`, `watch_runs`, `watch_seen` (migration `0008_watches`). `POST/GET/PATCH/DELETE
  /v1/watches[/:id]`, `GET /v1/watches/:id/runs`; MCP `create_watch`, `list_watches`,
  `update_watch`, `delete_watch`. A watch takes the options of a download job and is validated by
  the same code (`JobsService.validateDownload`: schema, recipes, limits, access, URL guard),
  plus `interval_minutes` (≥ `WATCH_MIN_INTERVAL_MINUTES`) and `break_on_existing` (default true).
  Fields that make no sense for a watch are refused with the reason, including the per-request
  secrets (a watch is long-lived; cookies are the way). At most 100 watches per user.
- Scheduling (D46): a BullMQ job scheduler ticks once a minute on its own `watches` queue; due
  watches are claimed in one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` that also
  moves `next_run_at`, so any number of worker-dl containers run each watch once.
- A run expands flat and bounded (`--playlist-end WATCH_MAX_NEW_ITEMS`, no playlist cache),
  stops at the first entry that is in the archive **or was queued by an earlier run**
  (`watch_seen`, so a slow queue never gets an entry twice), applies the filters, checks quota
  and disk, and queues one `batch` (`options.watch_id`) whose items carry the download options,
  item checks and `then`. Nothing new: no job. `WATCH_MAX_FAILURES` consecutive failures pause
  the watch with `last_error`; `PATCH {status: "active"}` resumes and clears them.
- Refactors: `entryKey` shared by the planner and watches; item checks and item options moved to
  `src/playlists/checks.ts` (playlist expansion and watches build items the same way).
- Tests: 4 selection unit, 7 integration (newest entries as one batch then nothing; no double
  queueing while downloads wait; break vs skip against a user's archive; options, filters and
  `then` on every item; pausing after failures and resuming; single-video URL refused at run
  time; edits re-validated; per-user isolation; every refusal), MCP round trip, e2e create and
  delete through nginx. A flaky test (about 1 run in 10) was first blamed on a background
  scheduler tick; that was wrong. The real cause: `UPDATE … RETURNING` does not keep the
  subquery's order, so two watches of one user ran in either order, and the first one's
  downloads (milliseconds with the fake) were already in the archive for the second. The runner
  now sorts claimed watches by `next_run_at`; the test gives each watch its own user, and closes
  the stack's watch worker so only the test ticks.

### Milestone 8 summary
Cookies and the credentials vault, sealed per-request secrets, proxies, geo, whitelisted
extractor args, PO tokens with a provider service, live recording and watches, all over REST and
MCP. **Totals: `pnpm check` 699/699 (3 consecutive full runs), deploy 45/45, ffmpeg image
acceptance passed, e2e passed** (incl. PO-token plugin on a real extraction and a real live
recording). Open: twice a whole integration file failed in `beforeAll` during a full run
(record, access); it did not reproduce in 3 full runs and 20 single-file runs. Full test output
is now kept, so the next occurrence shows its error.

## Milestone 9 — Google Drive ✅

### Step 33 — OAuth connection ✅
- `drive_connections`, `oauth_states` (migration `0009_drive`). `POST /v1/drive/connect` returns a
  consent URL (`drive.file openid email`, `access_type=offline`, `prompt=consent`) with a 256-bit
  single-use state valid for `OAUTH_STATE_TTL_MINUTES`; `GET /oauth/google/callback` (public)
  consumes the state, exchanges the code and stores the refresh token AES-GCM encrypted (bound to
  client and user); `GET /v1/drive/status`; `DELETE /v1/drive/connection` revokes at Google (best
  effort, reported as `revoked_at_google`) and forgets the connection. `invalid_grant` on refresh
  marks the connection `revoked` (`DRIVE_RECONNECT_REQUIRED`) until the user connects again.
  Without `GOOGLE_CLIENT_ID/SECRET` everything answers `FEATURE_DISABLED`.
- The callback page is self-contained HTML (escaped values, CSP `default-src 'none'`,
  `no-store`, `no-referrer`, light/dark). `cli secrets:reencrypt` covers Drive tokens too.
- `google-auth-library` 11.3.2 runs over the global fetch (`fetchImplementation`), so undici's
  `MockAgent` (pinned to Node's bundled undici 7.30.1) intercepts it in tests (D49).

### Step 34 — Drive client ✅
- `DriveClient` (Drive v3 REST over fetch): folders (create, check reachable), listing of what
  the service created, resumable uploads in 8 MiB chunks following Drive's `308 Range`, per-chunk
  retry with exponential backoff (network errors, 5xx, 429, rate-limit 403) that first asks the
  session how much it holds, one token refresh on 401, `storageQuotaExceeded` →
  `DRIVE_STORAGE_FULL`, 404 / permission 403 → `DRIVE_FOLDER_NOT_ACCESSIBLE`; API-key mode for
  public files. `GET /v1/drive/files` and MCP `list_drive_files`, `connect_google_drive`,
  `get_drive_status` (every SPEC §6 tool is real now). The root "Media downloads" folder is made
  once under a row lock, and again if the user deleted it.
- Test detail worth knowing: MockAgent sorts query parameters before matching, so the tests
  match on pathname and parameter, not on the raw query string.

### Step 35 — delivery to Drive ✅
- `destination: "link" | { type: "google_drive", folderId? }` on download, batch (batch level
  only), process and record jobs, and on watches; checked at creation (configured, connected,
  not revoked), stored in `jobs.destination`, inherited by items.
- `JobFinisher`: every completion point (downloads, dedup reuse, recipes and their reuse,
  `then` pipelines, recordings, `concat_items` parents) ends a Drive job in `running/uploading`
  and queues it on the new `delivery` queue; `DeliveryProcessor` (worker-dl, a `JobProcessor`, so
  retries, failure codes and parent/feeder updates come for free) uploads, then sets the final
  status. Playlist items count as finished only once uploaded (D50).
- Folders (D51): `folderId` (checked) or the root; playlists into a sub-folder named after the
  playlist, batches "Batch <date> <id>", a watch's batches into one folder per watch,
  multi-output jobs into one named after the media (downloads) or the job; HLS/DASH packages
  as a folder tree. Created folders and uploaded outputs are recorded as it goes, so a retry
  continues. Outputs show `drive: { file_id, link, folder_id }`; local files stay for the TTL.
- A failed upload fails the job with its `DRIVE_*` code and still lists the outputs with their
  signed links (D52).

### Step 36 — `google_drive` inputs ✅
- Files the service created are read with the user's token, files shared "anyone with the link"
  with `GOOGLE_API_KEY`; metadata first (folders refused, size cap before downloading), then the
  bytes, cached like URL inputs. Private files of others → `INPUT_NOT_FOUND`.

### Step 37 — `media_url` inputs ✅
- The SPEC §5 input left over from milestone 4: yt-dlp metadata (playlists and live streams
  refused, duration cap), then the download with `--load-info-json` and the size cap, cached by
  URL and content. Works in recipes (worker-ff now has the yt-dlp runner too) and `/v1/probe`
  (larger than `PROBE_MAX_MB` → a probe job, as for `url`).

### Browser tests (Playwright) ✅
- `@playwright/test` 1.64.1 with Chromium in the toolbox (`PLAYWRIGHT_BROWSERS_PATH`); `pnpm
  test:e2e` builds, starts `test/e2e/server.mjs` (the built app on Testcontainers Postgres/Redis
  with Google's token endpoint mocked in that process, D53) and runs the Drive pages on desktop
  and a Pixel 7: consent link, connected page, single use, declined consent, light and dark, no
  horizontal scroll, no console errors. CI runs it after `pnpm check` and keeps traces on failure.

### Milestone 9 summary
Tests added: OAuth 7, Drive client 6 (unit), delivery 10 with an in-memory fake Drive (single,
multi-output, playlist, batch, HLS tree, folderId, inaccessible folder, storage full, revoked
grant, watch folder, Drive inputs by token and by API key), `media_url` 2, browser 6, e2e
(Drive off → 501, public callback through nginx). Fixed on the way: a stale lockfile specifier
(`pnpm install --frozen-lockfile` failed; the e2e image build caught it). **Totals: `pnpm check`
724/724, Playwright 6/6, deploy 45/45, e2e passed.**

## Milestone 10 — deployment, CI, backups, canaries ✅ (server run pending)

### Step 38 — nginx ✅
- `nginx/media.conf` (host vhost, HTTP only for certbot) and `nginx/media-zones.conf`; the
  bundled `proxy.conf.template` gets the same locations. SPEC §17's three `limit_req` zones (API,
  uploads, downloads; 429 when exceeded), `client_max_body_size` = `MAX_UPLOAD_SIZE_MB` on `/u/`.
  `nginx/front.conf`: the TLS front for the bundled proxy; the proxy trusts `X-Forwarded-For`
  only from the Docker gateway range, so behind the front its per-IP limits still see clients.
- `deploy/tests/nginx.sh`: `nginx -t` on all three with the pinned image, and a drift check that
  the host vhost and the bundled proxy keep the same locations and limits (mutation-tested). e2e:
  the real `media.conf` in front of the stack (Range download 206, API 200, `/health` 403).

### Step 39 — egress firewall ✅
- `host/egress-firewall.sh apply | check | remove` and `media-egress-firewall.service`: own chains
  from `DOCKER-USER` and `INPUT`, replies allowed, private/CGNAT/link-local/multicast/reserved
  destinations and new connections to the host dropped, `EGRESS_ALLOW` for an external DB on a
  private network (DEPLOY.md §4.5), re-applied whenever Docker starts.
- `deploy/tests/firewall.bats`: real iptables and real packets in a privileged container
  (network namespaces as container, LAN host, public host and host). It caught a bug before it
  shipped: an invalid `EGRESS_ALLOW` entry was ignored because `die` ran in a process
  substitution, and a failure half-way could leave the filter flushed. Entries are now checked
  before any rule changes.
- The PO-token provider is reached as `pot-backend`, an alias on `backend` only: on the egress
  network container-to-container traffic is dropped by design.

### Step 40 — backups ✅
- `backup` service (postgres:17-alpine, uid 10001, read-only) running `backup.sh schedule`:
  `pg_dump -Fc` daily at `BACKUP_HOUR` UTC into `backups/`, 14 days kept, partial files never
  left, `BACKUP_PING_URL` (`/fail` on errors), idle with `BACKUP_ENABLED=false`, `once` for drills.
- `deploy/tests/backup.bats` (6) with stand-ins; it found that a stopped schedule left its sleep
  behind (now killed by the TERM handler). e2e: dump, restore into a scratch database, query it.

### Step 41 — CI, images, canaries ✅
- `ci.yml`: browser tests after `pnpm check`; on main, after acceptance and e2e, both images are
  pushed to GHCR (`linux/amd64`, private): `media-ffmpeg:n8.1.3-w1.9.5-<hash of its build
  files>` and `media-service:<git-sha>` built FROM that digest.
- `rebuild.yml`: weekly with the newest yt-dlp from PyPI, monthly with media-ffmpeg uncached
  (Debian security updates), and by hand with a chosen yt-dlp ("rebuild now"); each build passes
  acceptance and e2e (which now takes `YTDLP_VERSION`) before it is pushed.
- `canary.yml`: daily live tests against YouTube (metadata, playlist, downloads, a `then` recipe
  added for this, transcripts, comments), optional `CANARY_PING_URL`. On the server,
  `canary.sh` runs `smoke.sh` strictly with healthchecks-style pings (4 Bats tests); DEPLOY.md
  §4.10 has the key, cron line and restore drill.
- The e2e now opens its bind-mounted directories for uid 10001 (Linux CI would otherwise have
  failed the "files volume is writable" check; Docker Desktop hid it).

### Milestone 10 summary and what only the server can show
Found by the e2e on the way: nginx resolves upstreams at start (attach networks first), and the
image's own default site answers requests whose Host matches no `server_name` (the e2e sends the
vhost name, as real traffic does). **Totals: `pnpm check` 724/724, Playwright 6/6, live tests
against YouTube 7/7, deploy 55 Bats + 6 real-packet firewall tests + 5 nginx checks, ffmpeg
acceptance passed, e2e 68 checks passed.**

Everything that runs on this Mac is tested. Still to verify on the Ubuntu
26.04 VPS, because it needs the real host: `install.sh` end to end, the firewall unit at boot
and the §4.5 checks from inside `worker-dl`, host nginx with certbot, GHCR pulls with the
`read:packages` token, Google OAuth with the real client (consent screen in production), and the
first backup restore. The first CI run on GitHub will exercise the workflows for real (lint
only so far: actionlint).

### Side task — `media-ffmpeg` image (milestone 2 prerequisite) ✅

- `docker/ffmpeg/Dockerfile`: FFmpeg n8.1.3 from source with whisper.cpp v1.9.5 (static, CPU,
  no OpenMP, `GGML_NATIVE=OFF`, AVX2 baseline on amd64) and libvmaf v3.0.0 (static, built from source
  — D7); runtime stage installs exactly the Debian packages that provide the linked libraries.
- Two build fixes: libvmaf missing from Debian; static libvmaf needed `-lstdc++ -lm -lpthread` on
  its pkg-config `Libs` line (ffmpeg's configure ignores `Libs.private`).
- `docker/ffmpeg/test.sh media-ffmpeg:dev`: 23/23 ok — ffmpeg 8.1, `--enable-whisper`, filters
  whisper/vidstab/zscale/libvmaf/rubberband/ass/subtitles/drawtext/loudnorm, encoders
  x264/x265/vp9/aom/svt-av1/opus/mp3/vorbis/webp, ffprobe, and a real whisper transcription of
  `jfk.wav` ("ask not what your country can do for you"). arm64 image: 298 MB.

## Installer review with the user (2026-10-31)

The user went through what `install.sh` does on a server, point by point; only the approved
changes were made.

### Size checks removed (D54) ✅
- `install.sh`: the 4 vCPU / 8 GB RAM / 40 GB disk minimums and their checks are gone.
  `check_cpu` only looks for AVX2; without it the install goes ahead with `MODELS=none`
  (transcription off) and a warning.
- `install.bats`: the 5 tests of the removed checks are deleted; the AVX2 test now stubs
  `cpu_has_avx2` (it had only passed because the Mac has no AVX2).
- DEPLOY-QUICKSTART.md and DEPLOY.md §3 say there is no enforced minimum and keep 8 vCPU / 16 GB
  as the recommendation.

### Localhost by default (D55) ✅
- The bundled nginx is published on `127.0.0.1:8085` (`docker-compose.yml`, `.env.example`,
  `install.sh` defaults on first install and as fallbacks on updates). `PUBLIC_BASE_URL`
  defaults to `http://127.0.0.1:8085`; the server's IP is only looked up with `HTTP_BIND=0.0.0.0`.
- The install summary says "this server only" with both ways to open it; it warns about plain
  HTTP only when the port is open, and says neither when `PUBLIC_BASE_URL` points at the
  developer's own nginx.
- `nginx/front.conf` proxies to `127.0.0.1:8085`; `smoke.sh`'s example uses 8085.
- DEPLOY-QUICKSTART.md: new "Opening it up" section (own nginx, or `HTTP_BIND=0.0.0.0` +
  `PUBLIC_BASE_URL` in `.env`, or an SSH tunnel for a quick look) in place of "Plain HTTP";
  DEPLOY.md and SPEC §17 updated to match.
- 3 new Bats tests: the local-only default without an IP lookup, a first install with
  `HTTP_BIND=0.0.0.0` (server address, plain-HTTP warning), and a developer's nginx in front.
- **Totals: deploy 64 (53 Bats + 6 real-packet firewall + 5 nginx checks, `nginx -t` on the new
  `front.conf`), shellcheck clean, e2e 68 checks passed.**

### Repository on GitHub ✅
- The user made the first commit; the repository is `github.com/bytebunch/ffmpeg-yt-dlp`. The
  branch is renamed `master` → `main`, because CI publishes images only from `main` and
  `install.sh` pulls the `:main` tag.
- Placeholders filled: `DEFAULT_IMAGE=ghcr.io/bytebunch/media-service` in `install.sh`, the install
  URL `raw.githubusercontent.com/bytebunch/ffmpeg-yt-dlp/main/deploy/install.sh` in
  DEPLOY-QUICKSTART.md, `ghcr.io/bytebunch` in DEPLOY.md and `.env.example`. The "placeholder
  repository is refused" check and its test are gone; a new test installs without `MEDIA_IMAGE`
  and pulls `ghcr.io/bytebunch/media-service:main`.
- **Totals: deploy 64 (53 Bats + 6 firewall + 5 nginx), shellcheck clean.**

### First CI run on GitHub: tests depended on the host's free disk ✅
- 70 integration tests failed on the runner with `507 STORAGE_FULL … used_percent: 87`: after the
  image builds the runner's disk was 87% full, above the default `DISK_QUOTA_PERCENT=80`, so the
  disk guard refused every job (the rest were knock-on failures). The Mac toolbox disk is 5% full,
  so it never showed locally.
- Reproduced without code changes: the 9 failing files in the toolbox with `/tmp` on a 1 GB tmpfs
  filled to 87% → the same 10 failures in the two files tried, same error.
- Fix (tests only): `testConfig` defaults `DISK_QUOTA_PERCENT` to 99, as `e2e.sh` and the live
  tests already did; the now redundant override in `test/live/youtube.spec.ts` is removed. The
  guard's own test still sets a quota of 1.
- **Totals: the 9 files on the 87%-full disk 142/142, the guard test alone passes there,
  `pnpm check` 724/724.**

### Second CI run: YouTube refuses the runner, and two Linux-only e2e bugs ✅ (CI run pending)
- Tests passed on GitHub (724/724, browser tests). The e2e failed 5 checks:
  - YouTube answered `BOT_CHECK` ("Sign in to confirm you're not a bot") to every request from
    the runner (media info, smoke download, live recording).
  - "the recipe output is 80x60": `ffprobe` ran in the image as UID 10001, which cannot enter the
    `mktemp -d` directory (0700) on Linux; Docker Desktop ignores that, so the Mac never showed it.
    The live recording's `ffprobe` had the same bug. Cleanup also failed on files the services
    wrote as their own users.
- `scripts/e2e.sh`: one-off containers run as the host user; cleanup deletes the install
  directory's contents with a root container first. With `E2E_ALLOW_YOUTUBE_BLOCK=1` a
  `BOT_CHECK` answer from `/v1/info` skips the YouTube checks (smoke.sh's real-site part, the smoke
  download's location, the live recording) and adds a warning to the GitHub run; nothing else is
  skipped (D56). `ci.yml` and `rebuild.yml` set it. `canary.yml` runs by hand only (D57); SPEC §17
  updated.
- **Totals: shellcheck and actionlint clean; e2e with the allowance on and YouTube reachable 68/68
  with no skips; e2e with the probe forced to "blocked" 64 passed + 4 YouTube checks skipped with
  the warning. The Linux permission fixes can only be confirmed on the next CI run.**
