# Media Service — Spec v2 (yt-dlp + ffmpeg)

Status: **v2 approved 2026-10-31 — in development** · Last updated: 2026-10-31 · Supersedes Spec v1 (yt-dlp only) · Deployment runbook: `DEPLOY.md`

A private media service over **yt-dlp** and **ffmpeg** that exposes a **REST API** and an **MCP server** to the owner's own apps and agents. It downloads media from supported sites, processes media from several input sources (URLs, uploads, a server inbox, previous outputs, Google Drive), and delivers results as **7-day signed links** served from the server or **uploads to the end user's own Google Drive** (per-user OAuth).

Design rule for the whole surface: **callers choose from validated options; the service composes every yt-dlp and ffmpeg command line.** No raw arguments, format strings, output templates or filtergraphs are ever accepted from a client.

---

## 0. Changes from v1

- **ffmpeg processing** added as a first-class job type (`process`) with a composable **recipe** model (§8).
- **Pipelines**: a download job can carry a `then` recipe that runs on each produced file (§9).
- **Input sources** added: direct HTTPS URL, resumable **upload**, read-only server **inbox**, previous **output file**, **Google Drive** file (§5).
- **Full yt-dlp surface** exposed through validated options: formats, sections, chapters, SponsorBlock, subtitles, thumbnails, metadata embedding, comments, live streams, archive, cookies, impersonation, proxies, batch and channel watches (§7).
- **Full ffmpeg surface** exposed as operations: transcode, cut, resize, filters, audio, subtitles, images, packaging, analysis, generation (§8).
- Review fixes folded in: Drive `folderId` scope constraint, bounded playlist expansion, egress filtering for SSRF, file-size watchdog, cross-container cancel, in-flight dedup, idempotency scoping, per-item disk guard, minimal subprocess environment, PO-token/cookies in v1.
- Separate **ffmpeg queue and worker** so CPU-bound work never starves downloads (§2).
- Jobs can produce **multiple outputs**; outputs are the unit of delivery (§10).

**Revision 2026-10-31**
- `transcribe` is a standard operation: ffmpeg 8.1 is built in-house with whisper.cpp (BtbN releases ship whisper disabled), models live in a read-only volume (§2, §8j, §13, §17).
- `api` also sits behind egress filtering, because it runs the synchronous yt-dlp/ffprobe calls; `backend` network is internal (§2).
- Images tagged by git SHA, rollback by tag, expand/contract migrations (§17).
- One-command installer (`install.sh`) with working defaults, and a bundled nginx `proxy` compose profile used for development and the quick deploy (§17, `DEPLOY-QUICKSTART.md`).

---

## 1. Scope

**In v2**
- Everything in v1: single items, playlists and channel tabs, info, search, transcripts, signed links, Drive delivery, REST + MCP over one core.
- yt-dlp: format selection by tier or listed `format_id`, time sections, chapter split/remove, SponsorBlock, subtitles (download, convert, embed), thumbnails (download, convert, embed), metadata/chapters/info-json embedding, comments, live recording and waiting for premieres, download archive, per-user cookies, browser impersonation, owner-managed proxy pool, geo bypass, batch requests, channel/playlist watches.
- ffmpeg: probe and analysis, transcode and remux, cut/trim/split/concat, resize/crop/rotate/pad, frame-rate and speed, visual filters, overlays and text, subtitles (burn-in, mux, extract, convert), audio processing (loudness, gain, channels, effects, visualisations), images (thumbnails, sheets, GIF, sequences, slideshows), packaging (MP4 faststart, fragmented MP4, HLS, DASH, segments), metadata and chapters, stream mapping, generation (slates, silence, tones), quality metrics, optional hardware acceleration.
- Recipes with multiple operations and multiple outputs; download-then-process pipelines; per-item processing for playlists.
- Launch size ~10 users; scale-out without a rewrite (§15).

**Not in v2**
- Third-party clients, billing, admin UI, object storage (S3/R2), a web UI for end users, AI transcription beyond the ffmpeg whisper filter, DRM-protected content.

---

## 2. Architecture

```
your apps ─REST─┐                                              ┌─▶ Postgres (records)
                ├─▶ nginx (dl.<domain>) ─▶ api ───────────────┤
agents ───MCP───┘   ▲  │ tus uploads (/u)                      └─▶ Redis (BullMQ queues, progress, rate limits, locks)
                    │  ▼                                                    │
            X-Accel │ files volume ◀── worker-dl (yt-dlp + ffmpeg + deno) ◀──┤  queue: download
            Redirect│       ▲      ◀── worker-ff (ffmpeg + ffprobe)      ◀──┘  queue: ffmpeg
                    │       │                                  │
                    │  inbox volume (read-only)                └──▶ Google Drive (per-user OAuth)
```

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 LTS, TypeScript (strict), pnpm |
| Framework | NestJS on the Fastify adapter |
| Validation | Zod — one schema per input, shared by REST and MCP (`nestjs-zod`) |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP transport, stateless mode, mounted at `/mcp` |
| Database | PostgreSQL 17 + Drizzle ORM / drizzle-kit migrations |
| Queue | Redis + BullMQ (`@nestjs/bullmq`), two queues: `download`, `ffmpeg` |
| yt-dlp execution | `execa`, argument arrays only, one subprocess per item, minimal environment |
| ffmpeg execution | `execa`, argument arrays only, filtergraphs composed by the service, minimal environment |
| Uploads | tus protocol (`@tus/server`, file store on the files volume) mounted at `/u` |
| Google | `google-auth-library` (OAuth) + `googleapis` Drive v3 (resumable upload, public-file read with API key) |
| Crypto | `node:crypto` — AES-256-GCM (tokens, cookies, site credentials), HMAC-SHA256 (links), SHA-256 (API keys, dedup keys) |
| Logging / metrics | pino (JSON, redaction) / prom-client |
| API docs | OpenAPI via `@nestjs/swagger`, served at `/docs` |
| Reverse proxy | Existing nginx on the server + certbot |

- **One codebase, three entry points:** `api` (REST, MCP, OAuth callback, tus), `worker-dl` (download queue; runs yt-dlp and the ffmpeg steps yt-dlp itself needs), `worker-ff` (ffmpeg queue; recipes). Both workers come from the same image with different `WORKER_ROLE`.
- **Docker Compose services:** `api`, `worker-dl`, `worker-ff`, `pot-provider`, `migrate` (one-off), `backup` (cron), plus bundled `postgres` and `redis` behind the `local-db` / `local-redis` profiles (§17a) and a bundled nginx container behind the `proxy` profile, used for development and the quick deploy (§17).
- `api` binds to `127.0.0.1:<port>` only; nginx terminates TLS. Bundled Postgres and Redis are not exposed on the host.
- Connections come only from `DATABASE_URL` / `REDIS_URL`.
- The image pins its own **yt-dlp** (pip, in a venv, with the `default` and `curl-cffi` extras and mutagen so thumbnails embed into mp3/m4a/opus/flac), **ffmpeg/ffprobe** (FFmpeg 8.1 built in-house from a pinned source tag in a separate `media-ffmpeg` base image, GPL, with **whisper.cpp** (`--enable-whisper`, CPU only, AVX2 baseline) and libx264, libx265, libvpx, libaom, libsvt-av1, libopus, libmp3lame, libvorbis, libass, libfreetype/harfbuzz/fontconfig, libvidstab, libzimg, libvmaf, libwebp, libsoxr, librubberband), **deno** for YouTube challenge solving with the solver components vendored, a small **font set** (DejaVu, Liberation, Noto Sans incl. CJK and Arabic) for text overlays, and any yt-dlp plugins (PO-token provider).
- Whisper models are **not in the image**: they sit in a read-only `models` volume mounted into `worker-ff` (§13 `FFMPEG_WHISPER_*`), so yt-dlp rebuilds do not re-ship them and models can be added without a rebuild.
- Every container that fetches caller-supplied URLs (`api`, `worker-dl`, `worker-ff`, `pot-provider`) reaches the internet only through an **egress-filtered** Docker network: RFC1918, CGNAT, loopback, link-local, multicast and cloud-metadata ranges, and new connections to the host itself, are blocked at the network layer in addition to the application URL guard (§12). `api` is included because it runs the synchronous yt-dlp/ffprobe calls. Container-to-container traffic uses a separate `internal` network. Host rules: `DEPLOY.md` §4.5.

---

## 3. Identity and auth

- **Clients** — each of the owner's apps/agents is a client with one or more API keys.
  - Sent as `Authorization: Bearer <key>`; stored as SHA-256 hashes with a visible prefix.
  - Created/revoked with a CLI (`pnpm cli keys:create <client>` / `keys:revoke <prefix>`).
- **End users** — opaque ids supplied by the client: `X-User-Id` header (REST) or `user_id` parameter (MCP). The client vouches for them.
  - Drive connections, cookies, site credentials, download archive, watches, uploads, quotas and job history are scoped to `(client, user_id)`.
  - An API key may carry a **default user id**.
- The same keys work for REST, MCP and the tus upload endpoint. Browser uploads use a short-lived **upload token** minted by `POST /v1/uploads`, so the API key never reaches a browser.

---
## 4. REST API (`/v1`, OpenAPI at `/docs`)

### Discovery (yt-dlp, synchronous)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/info` | Metadata for a URL. Body: `url`, `include[]` (`formats`, `subtitles`, `thumbnails`, `chapters`, `heatmap`, `description`, `tags`), `mode`, `cursor`, and the user's `cookies` and `credentials` (§7f). Playlists return title, uploader, item count and paginated `entries` (index, id, title, duration, url, upload date, live status) |
| `GET` | `/v1/search?q=&limit=&site=&sort=&cookies=` | Search. `site` = `youtube` (default; `sort=date` uses `ytsearchdate`) or any allow-listed extractor that exposes a yt-dlp search key (SoundCloud, Bilibili, Niconico, …). `cookies` = `true` or a jar id (§7f) |
| `POST` | `/v1/transcripts` | Subtitles for one item as `txt`, `srt`, `vtt` or `json` (cues with timestamps). Body: `url`, `lang[]`, `auto` (accept auto-generated), `translate_to` (auto-translated tracks where the site offers them), `format`, `cookies`, `credentials` (§7f). Timeout `TRANSCRIPT_TIMEOUT_SECONDS` |
| `POST` | `/v1/comments` | Comments for one item: `max` (≤ `COMMENTS_SYNC_MAX`), `sort` (`top`/`new`), `cookies`, `credentials` (§7f). Above the cap the request returns `202` with a `comments` job whose output is a JSON file |
| `POST` | `/v1/probe` | ffprobe of any **input** (§5): format, streams, chapters, tags, duration, bitrate. Remote inputs are fetched up to `PROBE_MAX_MB`; larger ones return `202` with a `probe` job |
| `GET` | `/v1/presets` | Download presets, recipe operations and their parameter schemas (JSON Schema generated from the Zod schemas) — lets agents discover options |

### Jobs

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/jobs` | Create a job → `202`. Body is a discriminated union on `type`: `download`, `process`, `batch`, `record`, `comments`, `probe` (§9) |
| `GET` | `/v1/jobs?status=&type=&cursor=` | The user's jobs |
| `GET` | `/v1/jobs/:id` | Status, stage, progress, outputs, error. Playlist/batch jobs add `{ total, completed, failed, running, items }` |
| `GET` | `/v1/jobs/:id/items?status=&cursor=` | Paginated child items of a playlist or batch job |
| `GET` | `/v1/jobs/:id/outputs` | Outputs with signed links, Drive links, sizes, probe summary |
| `GET` | `/v1/jobs/:id/events` | SSE progress stream (stage, percent, speed, eta; aggregate + current items for playlists) |
| `GET` | `/v1/jobs/:id/log` | Sanitised tail of the yt-dlp/ffmpeg log for the job (secrets and signed URLs redacted) |
| `POST` | `/v1/jobs/:id/retry` | Re-queue a failed job, or only the failed items of a playlist/batch |
| `DELETE` | `/v1/jobs/:id` | Cancel (playlist/batch: cancels all pending/running items; completed items stay) |
| `DELETE` | `/v1/jobs/:id/outputs` | Delete every file of a finished job now (playlist/batch: every item's) → `{ deleted, freed_bytes }`; `409 JOB_NOT_FINISHED` while it runs |

### Inputs

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/uploads` | Create an upload session: declared size, filename, mime → `{ uploadId, tusUrl, uploadToken, expiresAt }` |
| `*` | `/u/:uploadId` | tus 1.0 endpoint (`HEAD`, `PATCH`, `OPTIONS`, `DELETE`) for resumable, chunked uploads; authenticated by the upload token |
| `GET` | `/v1/uploads/:id` | Upload state (`uploading`, `ready`, `expired`), bytes received, probe summary once complete |
| `DELETE` | `/v1/uploads/:id` | Discard an upload |
| `GET` | `/v1/inbox?cursor=` | Files in the client's read-only inbox folder (name, size, mtime); the inbox is `INBOX_DIR/<client>/` on the host |
| `GET` | `/v1/outputs?cursor=` | The user's unexpired output files (reusable as inputs) |
| `DELETE` | `/v1/outputs/:id` | Delete one of the user's files now, before it expires → `{ deleted, freed_bytes }` |

### Per-user settings

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/v1/cookies` | Store a Netscape cookie file for this user (encrypted); body: `cookies` text, `label` |
| `GET` / `DELETE` | `/v1/cookies[/:id]` | List (domains, expiry, label) / delete |
| `PUT` / `DELETE` | `/v1/credentials/:site` | Username/password (+ optional 2FA seed) for a site that needs login; encrypted; enabled only with `SITE_CREDENTIALS_ENABLED=true` |
| `GET` / `POST` / `DELETE` | `/v1/archive[/:entry]` | The user's download archive (`extractor id` entries): list, import, remove |
| `PUT` / `GET` / `DELETE` | `/v1/recipes[/:name]` | Saved recipes per client (validated on save); a job may reference `recipe: "name"` instead of inline steps |
| `POST` | `/v1/watches` | Watch a channel/playlist: `url`, `interval_minutes`, `filters`, download options, `then` recipe, `destination` → new items are downloaded automatically |
| `GET` / `PATCH` / `DELETE` | `/v1/watches[/:id]` | List, pause/resume/edit, delete; `GET /v1/watches/:id/runs` lists past runs and the jobs they created |

### Google Drive

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/drive/connect` | Returns a Google consent URL for this user |
| `GET` | `/v1/drive/status` | Connected? Which Google email? Root folder link |
| `GET` | `/v1/drive/files?cursor=` | Files and folders this app created in the user's Drive (usable as `folderId` targets and as inputs) |
| `DELETE` | `/v1/drive/connection` | Disconnect and revoke the token at Google |
| `GET` | `/oauth/google/callback` | Google redirect target (public) |

### Public, signed

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/d/:outputId?exp=&sig=` | Signed file download; nginx serves the bytes with Range support |
| `GET` | `/d/job/:jobId.zip?exp=&sig=` | Signed, streamed store-only ZIP of all outputs of a job (playlist, batch or multi-output recipe) |
| `GET` | `/d/job/:jobId.m3u?exp=&sig=` | Signed playlist manifest of a job's media outputs |
| `GET` | `/d/hls/:outputId/*?exp=&sig=` | Signed HLS/DASH package: the signature covers the output id, so every playlist and segment under it shares one token |
| `GET` | `/health`, `/metrics` | Liveness/readiness; Prometheus metrics (internal only) |

### Errors

Uniform shape `{ "error": { "code", "message", "details?" } }`. Stable codes: `UNSUPPORTED_SITE`, `URL_NOT_ALLOWED`, `INPUT_NOT_FOUND`, `INPUT_NOT_MEDIA`, `INPUT_FORMAT_NOT_ALLOWED`, `MEDIA_TOO_LONG`, `FILE_TOO_LARGE`, `PLAYLIST_TOO_LARGE`, `BATCH_TOO_LARGE`, `RECIPE_INVALID`, `RECIPE_TOO_EXPENSIVE`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `STORAGE_FULL`, `UPLOAD_INCOMPLETE`, `UPLOAD_EXPIRED`, `DRIVE_NOT_CONNECTED`, `DRIVE_RECONNECT_REQUIRED`, `DRIVE_STORAGE_FULL`, `DRIVE_FOLDER_NOT_ACCESSIBLE`, `MEDIA_UNAVAILABLE`, `MEDIA_PRIVATE`, `MEDIA_GEO_BLOCKED`, `MEDIA_AGE_GATED`, `LOGIN_REQUIRED`, `BOT_CHECK`, `LIVE_NOT_STARTED`, `FEATURE_DISABLED`, `JOB_NOT_FINISHED`.

Every `POST /v1/jobs` supports an `Idempotency-Key` header, scoped to `(client, user_id)` and unique for 24 h.

---

## 5. Inputs

An **input** is where a job's media comes from. Every input ends up as a local file on the files volume before yt-dlp's post-processing or ffmpeg touches it; ffmpeg never opens a network URL.

| `type` | Fields | Resolution | Guardrails |
|---|---|---|---|
| `media_url` | `url` | yt-dlp download (any supported extractor) | URL guard, extractor allowlist, duration/size caps |
| `url` | `url`, `headers?` (allow-listed names: `Referer`, `User-Agent`) | Streamed to disk with undici; content type must be audio/video/image or octet-stream; then ffprobe allowlist | URL guard + egress filter, `MAX_FILE_SIZE_MB`, redirect limit 5 with the guard re-applied per hop |
| `upload` | `uploadId` | Completed tus upload on the volume | Must be `ready`; belongs to the same `(client, user_id)`; ffprobe allowlist; `MAX_UPLOAD_SIZE_MB`; unused uploads expire after `UPLOAD_TTL_HOURS` |
| `inbox` | `name` | File in `INBOX_DIR/<client>/` mounted read-only into the workers | Bare file name only; resolved with realpath and required to stay inside the client's inbox folder; symlinks rejected |
| `output` | `outputId` | An unexpired output of a previous job | Same `(client, user_id)` unless the output belongs to the same client and `share_outputs_within_client=true` on the API key |
| `google_drive` | `fileId` | Drive v3 `files.get?alt=media` with the user's token for files this app created, or with `GOOGLE_API_KEY` for files shared "anyone with the link" | Private files the app did not create are not readable under the `drive.file` scope (`DRIVE_FOLDER_NOT_ACCESSIBLE`/`INPUT_NOT_FOUND`); size cap applies |

- A job that needs several inputs (concat, overlay, replace audio, side-by-side, slideshow) takes an `inputs[]` array; the cap is `RECIPE_MAX_INPUTS`.
- Resolved inputs are cached by content hash for `INPUT_CACHE_HOURS` so repeated recipes on the same upload or URL skip the fetch.
- Inputs are ffprobed before any processing. Allowed container formats: `mov,mp4,m4a,3gp,3g2,mj2`, `matroska,webm`, `mp3`, `ogg`, `flac`, `wav`, `aiff`, `aac`, `mpegts`, `mpeg`, `avi`, `flv`, `asf`, `image2`/`png_pipe`/`webp_pipe`/`gif`/`mjpeg` for images, `srt`/`webvtt`/`ass` for subtitle inputs. Everything else, notably `hls`, `dash`, `concat`, `lavfi`, `ffmetadata`, `data`, is rejected with `INPUT_FORMAT_NOT_ALLOWED`.

---

## 6. MCP tools (`/mcp`, Streamable HTTP, stateless)

Inputs use the same Zod schemas as REST; results contain links and metadata only, never file bytes.

| Tool | Maps to |
|---|---|
| `get_media_info` | `POST /v1/info` |
| `search_media` | `GET /v1/search` |
| `get_transcript` | `POST /v1/transcripts` |
| `get_comments` | `POST /v1/comments` |
| `probe_media` | `POST /v1/probe` |
| `list_presets` | `GET /v1/presets` (operations catalog with parameter schemas) |
| `start_download` | `POST /v1/jobs` with `type: download` (all options incl. `then` recipe) |
| `process_media` | `POST /v1/jobs` with `type: process` (inputs + recipe) |
| `start_batch` | `POST /v1/jobs` with `type: batch` |
| `record_live` | `POST /v1/jobs` with `type: record` |
| `get_job_status` | `GET /v1/jobs/:id` (+ outputs) |
| `list_jobs` | `GET /v1/jobs` |
| `list_job_items` | `GET /v1/jobs/:id/items` |
| `retry_job` | `POST /v1/jobs/:id/retry` |
| `cancel_job` | `DELETE /v1/jobs/:id` |
| `delete_job_outputs` | `DELETE /v1/jobs/:id/outputs` |
| `create_upload` | `POST /v1/uploads` — the agent hands the tus URL and token to the user or client app |
| `list_inbox` | `GET /v1/inbox` |
| `list_outputs` | `GET /v1/outputs` |
| `delete_output` | `DELETE /v1/outputs/:id` |
| `set_cookies` / `list_cookies` / `delete_cookies` | `/v1/cookies` |
| `list_archive` / `remove_archive_entry` | `/v1/archive` |
| `create_watch` / `list_watches` / `update_watch` / `delete_watch` | `/v1/watches` |
| `connect_google_drive` | `POST /v1/drive/connect` (agent hands the URL to the user) |
| `get_drive_status` / `list_drive_files` | `/v1/drive/status`, `/v1/drive/files` |

---
## 7. yt-dlp capabilities (download jobs)

Every option below is a validated field on `POST /v1/jobs` (`type: download`, `batch`, `record`) or on `/v1/info`. The right-hand column is how the service turns it into a yt-dlp argument. Clients never see or send yt-dlp syntax.

### 7a. Format selection

| Option | Values | yt-dlp mechanism |
|---|---|---|
| `preset` | `best`, `2160p`, `1440p`, `1080p`, `720p`, `480p`, `360p`, `audio_best`, `audio_mp3`, `audio_m4a`, `audio_opus`, `audio_flac`, `audio_wav`, `video_only`, `thumbnail_only`, `subtitles_only`, `metadata_only` | `-f bv*+ba/b` with `-S res:<h>` for tiers; `-x --audio-format <fmt>` for audio; `--skip-download` plus the relevant `--write-*` flags for the `*_only` presets |
| `container` | `mp4` (default), `mkv`, `webm`, `mov` | `--merge-output-format` and, when a stream cannot be muxed as-is, `--remux-video` |
| `recode` | `false` (default) / `true` | `--recode-video <container>` re-encodes instead of remuxing when codecs do not fit the container |
| `video_codec` | `any` (default), `h264`, `hevc`, `vp9`, `av1` | `-S +vcodec:<codec>` sort preference (never a hard filter, so a download still succeeds when the codec is missing) |
| `audio_codec` | `any`, `aac`, `opus`, `mp3`, `flac` | `-S +acodec:<codec>` |
| `fps_max` | `30`, `60`, unset | `-S fps:<n>` |
| `hdr` | `prefer`, `avoid` (default), `any` | `-S hdr` / `-S hdr:sdr` |
| `prefer_free_formats` | bool | `--prefer-free-formats` |
| `format_id` | a `format_id` (or `a+b` pair) taken from `/v1/info` formats; pattern `^[A-Za-z0-9_.+-]{1,64}$` | `-f <id>`; the id is also checked against the fresh info result |
| `format_sort` | ordered list from the curated key set `res`, `fps`, `codec`, `vcodec`, `acodec`, `br`, `vbr`, `abr`, `asr`, `size`, `ext`, `hdr`, `channels`, `lang`, `proto`, `quality`, each optionally `+`-prefixed | `-S <keys>` |
| `audio_bitrate_kbps` / `audio_vbr` | `96`–`320` or VBR quality `0`–`9` | `--audio-quality` |
| `max_filesize_mb` | ≤ `MAX_FILE_SIZE_MB` | `--max-filesize` plus the service's own partial-file watchdog (§12) |
| `verify_formats` | bool (slower) | `--check-formats` |
| `multistreams` | `audio` to keep all audio languages in mkv | `--audio-multistreams -f bv+mergeall[vcodec=none]` restricted to the mkv container |

### 7b. Sections, chapters and SponsorBlock

| Option | Values | yt-dlp mechanism |
|---|---|---|
| `sections[]` | `{ start, end }` timestamps (`HH:MM:SS(.ms)` or seconds), non-overlapping, within duration | `--download-sections "*start-end"` (one per section; each becomes an output) |
| `sections_by_chapter[]` | chapter titles (literal, escaped) | `--download-sections "<escaped title>"` |
| `force_keyframes` | bool | `--force-keyframes-at-cuts` (re-encodes around cuts for frame accuracy) |
| `chapters.split` | bool | `--split-chapters`; each chapter becomes an output with chapter metadata |
| `chapters.remove_titles[]` / `chapters.remove_ranges[]` | literal titles / `{ start, end }` | `--remove-chapters` with the title regex-escaped, or `"*start-end"` |
| `chapters.embed` | bool (default true for mp4/mkv/m4a) | `--embed-chapters` |
| `sponsorblock.mark[]` / `sponsorblock.remove[]` | `sponsor`, `intro`, `outro`, `selfpromo`, `preview`, `filler`, `interaction`, `music_offtopic`, `poi_highlight`, `chapter`, `all`, `default` | `--sponsorblock-mark` / `--sponsorblock-remove`; `--sponsorblock-api` from `SPONSORBLOCK_API_URL` |
| `sponsorblock.chapter_title` | `default` or `category` | `--sponsorblock-chapter-title` from a fixed menu of templates |

### 7c. Subtitles, thumbnails, metadata, naming

| Option | Values | yt-dlp mechanism |
|---|---|---|
| `subtitles.langs[]` | BCP-47 tags (`en`, `en-US`, `pt-BR`), `all`, or `<src>-<dst>` auto-translation pairs where the site offers them | `--sub-langs` built from the validated list |
| `subtitles.auto` | bool | `--write-auto-subs` |
| `subtitles.write` | bool | `--write-subs`; each track is an output |
| `subtitles.format` | `srt`, `vtt`, `ass`, `lrc`, `original` | `--sub-format` preference and `--convert-subs` |
| `subtitles.embed` | bool | `--embed-subs` (mp4 as `mov_text`, mkv/webm as-is) |
| `thumbnail.write` / `thumbnail.all` | bool | `--write-thumbnail` / `--write-all-thumbnails` (outputs) |
| `thumbnail.embed` | bool | `--embed-thumbnail` (ffmpeg for mp4/mkv, mutagen for mp3/m4a/opus/flac) |
| `thumbnail.convert` | `jpg`, `png`, `webp` | `--convert-thumbnails` |
| `metadata.embed` | bool (default true) | `--embed-metadata` (title, artist/uploader, date, description, URL) |
| `metadata.info_json` | bool | `--embed-info-json` (mkv only) |
| `extras[]` | `info_json`, `description`, `comments`, `playlist_metafiles` | `--write-info-json --clean-info-json`, `--write-description`, `--write-comments`, `--write-playlist-metafiles`; each becomes an output. `comments` honours `comments.max`/`comments.sort` via the curated `youtube:max_comments` / `comment_sort` extractor args |
| `filename` | `title` (default), `id`, `index_title`, `uploader_title`, `date_title`, `channel_date_title` | A server-side `-o` template per menu entry; `--trim-filenames 180` always; `--restrict-filenames` when `ascii_filenames=true`; `--windows-filenames` when `windows_safe=true` |
| `keep_video` | bool (with audio presets) | `-k` keeps the source video as a second output |
| `mark_watched` | bool (requires cookies) | `--mark-watched` |

### 7d. Live streams and premieres (`type: record`)

| Option | Values | yt-dlp mechanism / behaviour |
|---|---|---|
| `from_start` | bool | `--live-from-start` where the extractor supports it |
| `max_duration_minutes` | ≤ `LIVE_MAX_DURATION_MINUTES` | Service stops the recording with SIGINT at the limit; yt-dlp finalises the file |
| `wait` | `{ min_minutes, max_minutes }` | `--wait-for-video min[-max]`; job status `waiting` with the scheduled start time from metadata |
| `record_format` | `mpegts` while recording (crash-safe), remuxed to `container` on completion | `--hls-use-mpegts` then an ffmpeg remux step |
| `split_every_minutes` | optional | ffmpeg segment post-step so long recordings become several outputs |

Finished live streams and premieres download through the normal `download` path.

### 7e. Playlists, channels, batches and filters

| Option | Values | yt-dlp mechanism |
|---|---|---|
| `mode` | `auto` (default), `single`, `playlist` | `--no-playlist` / `--yes-playlist`; `auto` treats a video URL with `&list=` as the single video |
| `items` | selection `"1-20,25,-5"`, parsed and validated by the service | Server-computed `-I` ranges; also bounds the expansion (`--playlist-end`) |
| `reverse` / `random` | bool | `-I ::-1` / `--playlist-random` |
| `max_items` | ≤ `PLAYLIST_MAX_ITEMS` | `--playlist-end`, `--max-downloads` |
| `date_after` / `date_before` | `YYYYMMDD` or relative (`now-7days`) | `--dateafter` / `--datebefore` |
| `filters` | `min_duration`, `max_duration`, `min_views`, `max_views`, `min_likes`, `title_contains[]`, `title_excludes[]`, `uploader`, `exclude_live`, `exclude_upcoming`, `exclude_shorts`, `language` | `--match-filters` composed server-side from literal operators only (`*=`, `!*=`, `>=`, `<=`, `!is_live`, `!was_live`); never regex from clients |
| `skip_downloaded` | bool | `--download-archive <per-user archive file>` materialised from the `archive` table before the run and read back after |
| `break_on_existing` | bool (for watches) | `--break-on-existing` |
| `channel_tab` | `videos` (default), `shorts`, `streams`, `playlists`, `all` | URL normalised to the matching channel tab |
| `concat_items` | bool | After all items complete, an ffmpeg concat step (§8d) produces one extra output |
| `type: batch` | `items[]` of `{ url, ...download options }`, ≤ `BATCH_MAX_URLS` | One child job per URL, same fairness and aggregate status as playlists |

Expansion runs `--flat-playlist -J` with `--playlist-end` set from the selection or cap, under `PLAYLIST_EXPAND_TIMEOUT_SECONDS`, so infinite sources (YouTube Mix, huge channels) stop early. Entries without a duration count as `PLAYLIST_UNKNOWN_DURATION_MINUTES` for the total-duration cap.

### 7f. Access: cookies, credentials, impersonation, proxies, geo, bandwidth

| Option | Values | Mechanism |
|---|---|---|
| `cookies` | `true` (user's default jar) or a `cookieId` | Jar decrypted to a temp file inside the job dir (for `/v1/info`, `/v1/search`, `/v1/transcripts` and `/v1/comments`, a private temp dir for that call), passed with `--cookies`, deleted after the run. Enables age-gated, member-only, private and subscription content the user can access |
| `credentials` | `siteKey` from the user's vault | `-u`/`-p` (and `-2` with a TOTP generated from the stored seed) only when `SITE_CREDENTIALS_ENABLED=true`; cookies are the recommended path |
| `video_password` | string, per request, not stored | `--video-password` |
| `tv_provider` | `{ mso, username, password }` per request | `--ap-mso --ap-username --ap-password` when `TV_PROVIDER_ENABLED=true` |
| `impersonate` | `chrome`, `chrome-android`, `safari`, `safari-ios`, `edge`, `firefox`, or unset | `--impersonate <target>` via curl_cffi; default `YTDLP_IMPERSONATE_DEFAULT` |
| `proxy` | a **name** from the owner's `PROXY_POOL` | `--proxy <url>` resolved server-side; `PROXY_DEFAULT_BY_EXTRACTOR` applies when unset; raw proxy URLs are never accepted from clients |
| `geo_country` | ISO 3166-1 alpha-2 from `GEO_BYPASS_ALLOWLIST` | `--xff <CC>` |
| `limit_rate_kbps` | ≤ `JOB_RATE_LIMIT_MAX_KBPS` | `-r` |
| `concurrent_fragments` | `1`–`8` | `-N` |
| `extractor_args` | only whitelisted keys: `youtube.player_client` (from `YTDLP_ALLOWED_PLAYER_CLIENTS`), `youtube.lang`, `youtube.max_comments`, `youtube.comment_sort` | `--extractor-args` composed server-side |
| PO tokens | automatic | PO-token provider plugin configured with `YTDLP_POT_PROVIDER_URL` (the provider runs as its own Compose service) |

### 7g. Fixed server-side flags on every yt-dlp run

`--ignore-config`, `--no-colors`, `--newline --progress-template <json>`, `--no-overwrites`, `--no-mtime`, `--paths` into the job directory, `--cache-dir` on the files volume, `--ffmpeg-location` to the bundled binary, `--socket-timeout 30`, `--retries 3 --fragment-retries 10 --retry-sleep exp=1:30`, `--abort-on-unavailable-fragments` unless `allow_missing_fragments=true`, `--max-filesize`, duration enforced from metadata before download, `--no-playlist` or `--yes-playlist` from `mode`, `--` before the URL, the JS runtime pointed at the bundled deno, a minimal environment (`PATH`, `HOME` inside the job dir, `TMPDIR`), the job's temp dir as cwd, a per-run timeout (`JOB_TIMEOUT_MINUTES`, scaled up for `record`).

### 7h. Never exposed

`--exec`, `--downloader-args`, `--postprocessor-args`, `--parse-metadata`, `--replace-in-metadata`, `--load-info-json`, `--batch-file`, `--enable-file-urls`, `--cookies-from-browser`, `--no-check-certificates`, `--netrc*`, `--config-locations`, raw `-o` templates, raw `-f` strings, raw `--match-filters`, raw `--extractor-args`, `--use-postprocessor` plugins, `--write-link/url/webloc/lnk/desktop`, `--xattrs`, external downloaders (`aria2c` may be enabled later at owner level only).

### 7i. Info fields surfaced by `/v1/info`

`id`, `extractor`, `title`, `description`, `uploader`, `uploader_id`, `channel`, `channel_id`, `channel_follower_count`, `upload_date`, `release_timestamp`, `timestamp`, `duration`, `view_count`, `like_count`, `comment_count`, `age_limit`, `availability`, `live_status`, `was_live`, `is_live`, `language`, `categories`, `tags`, `thumbnails[]`, `thumbnail`, `chapters[]`, `heatmap[]`, `subtitles{}`, `automatic_captions{}`, `formats[]` (`format_id`, `ext`, `resolution`, `fps`, `vcodec`, `acodec`, `tbr`, `vbr`, `abr`, `asr`, `audio_channels`, `filesize`/`filesize_approx`, `dynamic_range`, `protocol`, `language`, `format_note`), `requested_formats` for the chosen preset, `webpage_url`, `original_url`, and for playlists `playlist_count`, `uploader`, `modified_date`, paginated `entries[]`.

---
## 8. ffmpeg capabilities (process jobs and recipes)

### 8a. Recipe model

```json
{
  "type": "process",
  "inputs": [{ "type": "output", "outputId": "…" }, { "type": "upload", "uploadId": "…" }],
  "recipe": {
    "steps": [
      { "op": "trim", "start": "00:01:00", "end": "00:02:30", "mode": "accurate" },
      { "op": "scale", "height": 720 },
      { "op": "text", "text": "Episode 12", "position": "bottom_center", "font": "Noto Sans", "size": 48 },
      { "op": "normalize_loudness", "target_lufs": -16 },
      { "op": "encode", "name": "web", "container": "mp4", "video": { "codec": "h264", "crf": 23 }, "audio": { "codec": "aac", "bitrate_kbps": 128 } },
      { "op": "encode", "name": "audio", "container": "mp3", "video": { "codec": "none" }, "audio": { "codec": "mp3", "bitrate_kbps": 192 } },
      { "op": "thumbnail", "name": "poster", "at": "25%", "format": "jpg" }
    ]
  },
  "destination": "link"
}
```

- A **recipe** is an ordered list of **operations**. Three kinds: **filters** (change the working video/audio streams), **terminals** (`encode`, `thumbnail`, `gif`, `hls`, … produce outputs), **analyses** (produce JSON report outputs). A recipe may contain several terminals; the composer splits the filtered streams once and feeds every encoder in a single ffmpeg pass.
- Operations that need a measurement first (`normalize_loudness` two-pass, `gif` palette, `target_size_mb`, `stabilize`, `crop: auto`, `encode.two_pass`) become **stages**; stage outputs chain through temp files in the job directory.
- `recipe` may be a **name**: a built-in preset (§8k) or a saved client recipe (`/v1/recipes`).
- Every parameter is a validated number, enum or bounded string. **The service composes the filtergraph**; clients never send filter syntax, expressions, file paths or ffmpeg flags. Time ranges become `enable='between(t,a,b)'` from validated numbers; positions come from a menu or validated integers plus margins.
- Cost control: the composer estimates work units from input duration, output pixel rate, codec weight and filter weight (`nlmeans`, `minterpolate`, `vidstab`, `libaom`, `whisper`, `vmaf` are heavy). Recipes above `RECIPE_MAX_COST` fail with `RECIPE_TOO_EXPENSIVE`; the timeout scales with the estimate.
- Limits: `RECIPE_MAX_STEPS`, `RECIPE_MAX_INPUTS`, `RECIPE_MAX_OUTPUTS`, `RECIPE_MAX_TEXT_LAYERS`, input duration ≤ `MAX_MEDIA_DURATION_MINUTES`, every output ≤ `MAX_FILE_SIZE_MB` (enforced with `-fs`).

### 8b. `encode` (terminal) — containers, codecs, quality

| Parameter | Values | ffmpeg mechanism |
|---|---|---|
| `container` | `mp4`, `mov`, `mkv`, `webm`, `mpegts`, `mp3`, `m4a`, `aac`, `ogg`, `opus`, `flac`, `wav`, `aiff`, `gif`, `webp`, `png`, `jpg`, `avif` | `-f` / extension; codec defaults per container |
| `video.codec` | `h264` (libx264), `hevc` (libx265), `vp9` (libvpx-vp9), `av1` (libsvtav1; `av1_aom` for libaom), `prores` (prores_ks; `profile` proxy/lt/standard/hq/4444/4444xq), `dnxhr` (dnxhd; `profile` lb/sq/hq/hqx/444), `mjpeg`, `png`, `gif`, `copy`, `none` | `-c:v` |
| `video.crf` | codec range (x264/x265 0–51, vp9 0–63, svt-av1 0–63) | `-crf` (`-qp` for prores/dnx handled by profile) |
| `video.bitrate_kbps` | 100–100000, optional `maxrate_kbps`, `bufsize_kbps` | `-b:v -maxrate -bufsize`; `two_pass: true` adds `-pass 1/2` |
| `video.target_size_mb` | ≤ `MAX_FILE_SIZE_MB` | Bitrate computed from duration minus audio budget, two-pass encode, final size verified |
| `video.preset` | `ultrafast` … `veryslow` (x264/x265), `0`–`13` (svt-av1), `good`/`best`/`realtime` + `cpu-used` (vp9) | `-preset` / `-cpu-used` |
| `video.tune` | `film`, `animation`, `grain`, `stillimage`, `fastdecode`, `zerolatency`, `psnr`, `ssim` | `-tune` |
| `video.profile` / `video.level` | h264 `baseline`/`main`/`high`/`high10`; hevc `main`/`main10`; level `3.0`–`6.2` | `-profile:v -level` |
| `video.pix_fmt` | `yuv420p` (default), `yuv420p10le`, `yuv422p`, `yuv444p`, `rgb24`, `rgba` (webp/png/gif) | `-pix_fmt` |
| `video.fps` | 1–120 | `fps` filter |
| `video.keyframe_interval_s` | 0.5–10 | `-g`, `-keyint_min`, `-sc_threshold 0` when `scene_cut=false` |
| `video.bframes` | 0–8 | `-bf` |
| `video.color` | `bt709`, `bt601`, `bt2020` (+ `range: tv|pc`) | `-colorspace -color_primaries -color_trc -color_range` and `colorspace` filter when converting |
| `video.faststart` | bool (default true for mp4/mov/m4a) | `-movflags +faststart` |
| `video.fragmented` | bool | `-movflags +frag_keyframe+empty_moov+default_base_moof` |
| `video.hw` | `auto` (default), `off` | Uses `FFMPEG_HWACCEL` (`vaapi`, `nvenc`, `qsv`) when the host has it: `-hwaccel`, `h264_vaapi` / `hevc_nvenc` / … with software fallback |
| `audio.codec` | `aac`, `mp3` (libmp3lame), `opus` (libopus), `vorbis` (libvorbis), `flac`, `alac`, `pcm_s16le`, `pcm_s24le`, `ac3`, `eac3`, `copy`, `none` | `-c:a` |
| `audio.bitrate_kbps` / `audio.vbr` | 32–512 / codec VBR quality | `-b:a` / `-q:a`, `-vbr on` (opus) |
| `audio.sample_rate` | `8000`–`96000` | `aresample` with soxr |
| `audio.channels` | `1`, `2`, `6` | `-ac` (downmix via `pan` when needed) |
| `audio.language` / `audio.title` | BCP-47 / string ≤ 64 | `-metadata:s:a:0 language=…` |
| `metadata` | `title`, `artist`, `album`, `album_artist`, `date`, `genre`, `track`, `comment`, `description`, `copyright`, `strip: true` | `-metadata k=v` per allowed key; `-map_metadata -1` for strip; `-id3v2_version 3` for mp3 |
| `cover` | an image input | `-map <img> -disposition:v:1 attached_pic` (mp4/m4a/mkv), ID3 APIC (mp3), METADATA_BLOCK_PICTURE (flac/ogg) |
| `chapters` | `keep` (default), `strip`, or `set[]` of `{ start, end, title }` | ffmetadata file written by the service, `-map_metadata`/`-map_chapters` |
| `fs_limit` | always | `-fs <MAX_FILE_SIZE_MB>` |

### 8c. Time: trim, cut, split, speed, loop, fade

| Operation | Parameters | ffmpeg mechanism |
|---|---|---|
| `trim` | `start`, `end` or `duration`; `mode: copy` (keyframe-aligned, instant) / `accurate` (re-encode) | `-ss` before `-i`, `-to`/`-t`; `-c copy -avoid_negative_ts make_zero` for copy mode |
| `cut_out` | `ranges[]` to remove | `select`/`aselect` with `setpts`/`asetpts`, or per-range trims + concat |
| `split` | `every_seconds`, `at[]` timestamps, `by_chapters`, `by_silence { threshold_db, min_silence_s }`, `by_scene { threshold }`; `mode: copy|accurate` | `-f segment -segment_times … -reset_timestamps 1` (copy) or trims per piece; each piece is an output |
| `speed` | `factor` 0.25–4.0, `preserve_pitch` (default true), `mute` | `setpts=PTS/f`, `atempo` chained for factors outside 0.5–2, `rubberband=tempo=` when pitch must be preserved precisely |
| `reverse` | `video`, `audio` bools; input ≤ `REVERSE_MAX_SECONDS` | `reverse`, `areverse` |
| `boomerang` | `start`, `duration` ≤ 10 s | trim + reverse + concat |
| `fps` | `value`, `mode: drop_dup` (default) / `interpolate` (≤ `INTERPOLATE_MAX_SECONDS`) | `fps=` / `minterpolate=fps=…:mi_mode=mci` |
| `timelapse` | `every_nth_frame` 2–600 | `select='not(mod(n,N))',setpts=N/FRAME_RATE/TB` |
| `loop` | `count` 1–20 or `to_duration_s` | `-stream_loop` or `loop`/`aloop` |
| `fade` | `in_s`, `out_s`, `color`, `audio: bool` | `fade=t=in/out`, `afade` |
| `pad_duration` | `to_duration_s`, `mode: freeze|black|silence` | `tpad`, `apad`, `-shortest` |
| `audio_offset` | `ms` −60000–60000 | `adelay` / `-itsoffset` on the audio input |

### 8d. Composition: concat, overlays, layouts, generation

| Operation | Parameters | ffmpeg mechanism |
|---|---|---|
| `concat` | `inputs[]` order; `mode: copy` (identical codec params, checked by probe) / `normalize` (target size/fps/sample rate/pix_fmt then concat filter); `transition { type, duration_s }` from the xfade list (`fade`, `dissolve`, `wipeleft/right/up/down`, `slideleft/…`, `circleopen/close`, `pixelize`, `radial`, `smoothleft/…`, `fadeblack`, `fadewhite`, `zoomin`); `audio_crossfade_s` | concat demuxer with a server-written list file inside the job dir (`-safe 1`), or `scale,pad,fps,setsar` per input + `concat=n:v:a`, `xfade`, `acrossfade` |
| `overlay_image` | `input` (image), `position` (`top_left`, `top_right`, `bottom_left`, `bottom_right`, `center`, `top_center`, `bottom_center`) or `x`,`y`, `margin`, `scale_pct` 1–100, `opacity` 0–1, `start`, `end`, `tile: bool` | `scale`, `format=rgba,colorchannelmixer=aa=`, `overlay=…:enable=`; `tile` for repeated watermarks |
| `overlay_video` | `input`, `position`, `size_pct` 10–50, `start`, `end`, `audio: main|overlay|mix`, `border` | `scale` + `overlay` (picture-in-picture), `amix` |
| `stack` | `layout: horizontal|vertical|grid`, `columns`, `inputs[]`, `gap`, `background` | `hstack`, `vstack`, `xstack` after normalising sizes |
| `chromakey` | `color` (hex), `similarity` 0.01–0.5, `blend` 0–0.5, `background` input or color | `chromakey`/`colorkey` + `overlay` |
| `slideshow` | `images[]` or image inputs, `duration_each_s`, `transition`, `ken_burns: bool`, `audio` input, `fit` | `-loop 1 -t`, `zoompan`, `xfade`, `-shortest` |
| `audio_to_video` | `visual: cover|waveform|spectrum|bars|none`, `cover` input, `size`, `colors` palette name, `background` | `showwaves`, `showspectrum`, `showcqt`/`showfreqs`, `-loop 1` cover, `-shortest` |
| `generate` | `kind: black|color|slate|silence|tone|test_pattern|noise`, `duration_s` ≤ 600, `size`, `color`, `text` (slate), `frequency_hz` (tone), `fps`, `sample_rate` | `-f lavfi -i color=…`, `anullsrc`, `sine`, `testsrc2`, `anoisesrc`; definitions are composed server-side from numbers only |
| `mix_audio` | `inputs[]`, `weights[]`, `duck { threshold_db, ratio, attack_ms, release_ms }`, `normalize: bool` | `amix`, `sidechaincompress` |
| `replace_audio` / `add_audio_track` / `remove_audio` | `input`, `language`, `title`, `default: bool`, `offset_ms` | `-map` selection, `-disposition`, `adelay` |
| `select_streams` | `video`, `audio[]`, `subtitles[]` indexes; `keep_attachments` | `-map 0:v:N -map 0:a:N …` |
| `extract_streams` | `stream: video|audio|subtitle|attachment`, `index`, `raw: bool` | `-c copy -map`; `-bsf:v h264_mp4toannexb`/`hevc_mp4toannexb` for raw elementary streams; `-dump_attachment:t` |

### 8e. Geometry: scale, crop, rotate, pad, aspect, platform formats

| Operation | Parameters | ffmpeg mechanism |
|---|---|---|
| `scale` | `height` (`2160`,`1440`,`1080`,`720`,`480`,`360`,`240`) or `width`/`height`; `fit: contain|cover|stretch|pad`; `pad_color` or `pad: blur`; `algorithm: bicubic|lanczos|bilinear|neighbor|spline`; `upscale: bool` (default false) | `scale=w:h:force_original_aspect_ratio=decrease|increase:flags=…`, `crop`, `pad`, blurred background via `split,scale,boxblur,overlay`; even dimensions enforced |
| `crop` | `x`,`y`,`w`,`h`; or `aspect` (`16:9`,`9:16`,`1:1`,`4:5`,`4:3`,`3:2`,`21:9`,`2.39:1`) with `gravity` (`center`, `top`, `bottom`, `left`, `right`, corners); or `auto` (letterbox/pillarbox removal, `limit`, `round`) | `crop=…`; `auto` runs a `cropdetect` stage first |
| `rotate` | `90`, `180`, `270`, `flip_h`, `flip_v`, `angle_deg` −180–180 with `fill_color`, `metadata_only: bool` | `transpose`, `hflip`, `vflip`, `rotate=a*PI/180:fillcolor=`, `-display_rotation` for metadata-only |
| `pad` | `aspect` or `width`/`height`, `color` or `blur`, `position` | `pad=…:color=` or blurred-background composite |
| `aspect` | `sar_1: bool`, `dar` | `setsar=1`, `setdar` |
| `platform_format` | `platform: youtube|youtube_shorts|instagram_feed|instagram_reel|instagram_story|tiktok|x|facebook|linkedin|whatsapp|pinterest`, `strategy: crop|pad|blur`, `max_duration: bool` | Looks up the platform table (size, aspect, fps cap, codec/profile, bitrate, max duration, file size) and composes scale/crop/pad + encode defaults; truncates with `trim` when `max_duration=true` |

### 8f. Visual filters, text, subtitles

| Operation | Parameters | ffmpeg mechanism |
|---|---|---|
| `deinterlace` | `mode: yadif|bwdif`, `field_order: auto|tff|bff`, `double_rate: bool` | `yadif`, `bwdif` |
| `denoise` | `strength: light|medium|strong`, `method: hqdn3d|nlmeans|atadenoise` (nlmeans is heavy) | `hqdn3d`, `nlmeans`, `atadenoise` |
| `sharpen` | `amount` 0.1–2 | `unsharp` |
| `blur` | `radius` 1–50 | `gblur` / `boxblur` |
| `color` | `brightness` −1–1, `contrast` 0–3, `saturation` 0–3, `gamma` 0.1–3, `hue_deg`, `temperature_k` 1000–40000, `vibrance` −2–2, `exposure` −3–3, `grayscale`, `sepia`, `invert`, `balance { shadows, midtones, highlights }`, `curves_preset` (`vintage`, `cross_process`, `darker`, `lighter`, `increase_contrast`, `linear_contrast`, `medium_contrast`, `strong_contrast`, `negative`, `color_negative`), `lut3d` (a `.cube` input) | `eq`, `hue`, `colortemperature`, `vibrance`, `exposure`, `format=gray`, `colorchannelmixer`, `negate`, `colorbalance`, `curves=preset=`, `lut3d` |
| `vignette` / `grain` / `deband` / `deflicker` | `strength` | `vignette`, `noise=alls=…:allf=t`, `deband`, `deflicker` |
| `region_blur` / `region_pixelate` / `drawbox` | `x`,`y`,`w`,`h`, `strength`, `color`, `thickness`, `start`, `end` | `crop,boxblur`/`pixelize` + `overlay:enable=`, `drawbox` |
| `stabilize` | `shakiness` 1–10, `smoothing` 1–100, `crop: keep|black` | `vidstabdetect` stage then `vidstabtransform` |
| `tonemap` | `hdr_to_sdr`, `algorithm: hable|mobius|reinhard|bt2390`, `peak_nits` | `zscale=t=linear:npl=…,tonemap=…,zscale=t=bt709:m=bt709,format=yuv420p` |
| `dedupe_frames` | `threshold` | `mpdecimate,setpts=N/FRAME_RATE/TB` (screen recordings) |
| `lens_correction` | `k1`, `k2` −1–1 | `lenscorrection` |
| `text` | `text` ≤ 500 chars, `font` from the bundled allowlist, `size` 8–300, `color`, `position` menu or `x`,`y` + `margin`, `box { color, opacity, padding }`, `outline { color, width }`, `shadow { x, y, color }`, `align`, `line_spacing`, `start`, `end`, `timecode: bool` | `drawtext=textfile=<server-written file>:fontfile=…:fontsize=…:fontcolor=…:x=…:y=…:box=…:enable=…`; `timecode=` + `rate=` for burnt-in timecode; text is never placed inline in the filtergraph |
| `subtitles_burn` | `input` (srt/vtt/ass) or `track` index, `style { font, size, color, outline, shadow, position, margin_v, background }`, `charenc`, `shift_ms` | `subtitles=filename=<job-local path>:force_style=…:charenc=`, `ass=`, picture-based tracks via `overlay`; the path is always a file the service placed in the job dir |
| `subtitles_mux` | `input` or `track`, `language`, `title`, `default`, `forced`, `format: mov_text|srt|ass|webvtt` | `-c:s`, `-metadata:s:s`, `-disposition:s` |
| `subtitles_extract` | `tracks[]`, `format: srt|vtt|ass` | `-map 0:s:N -c:s <fmt>`; each track is an output |
| `subtitles_convert` / `subtitles_shift` / `subtitles_strip` | `format`, `ms`, — | `-c:s`, `-itsoffset` on the subtitle input, `-sn` |

---
### 8g. Audio operations

| Operation | Parameters | ffmpeg mechanism |
|---|---|---|
| `gain` | `db` −60–30, or `to_peak_dbfs` (measure first) | `volume=…dB`; `volumedetect` stage for peak targeting |
| `normalize_loudness` | `target_lufs` (−30…−5; defaults: `-14` streaming, `-16` podcast, `-23` EBU R128), `true_peak_dbtp` (default −1.5), `lra` (default 11), `mode: two_pass` (default, linear) / `dynamic` | `loudnorm=print_format=json` measurement stage, then `loudnorm=…:measured_I=…:linear=true`; `dynaudnorm` for dynamic |
| `compress` | `preset: light|medium|heavy|voice|broadcast` or `threshold_db`, `ratio`, `attack_ms`, `release_ms`, `makeup_db` | `acompressor` |
| `limiter` | `ceiling_dbtp` | `alimiter` |
| `silence_trim` | `start: bool`, `end: bool`, `threshold_db` (default −50), `min_silence_s` | `silenceremove` |
| `channels` | `mono`, `stereo`, `downmix_surround`, `swap`, `left_only`, `right_only`, `surround_5_1` | `pan=`, `channelmap`, `-ac` |
| `pitch` | `semitones` −12–12, `preserve_tempo: bool` | `rubberband=pitch=` or `asetrate` + `aresample` + `atempo` |
| `tempo` | `factor` 0.5–2 (audio only) | `atempo` / `rubberband=tempo=` |
| `eq` | `preset: bass_boost|treble_boost|voice|podcast|loudness|flat` or `bands[]` of `{ freq_hz, width_hz, gain_db }` ≤ 10 | `equalizer=…` chain, `superequalizer` for presets |
| `bass` / `treble` | `gain_db` −20–20, `freq_hz` | `bass`, `treble` |
| `highpass` / `lowpass` / `bandpass` | `freq_hz`, `poles` | `highpass`, `lowpass`, `bandpass` |
| `remove_hum` | `freq_hz: 50|60`, `harmonics` 1–4 | `bandreject` notches |
| `denoise_audio` | `strength: light|medium|strong`, `method: afftdn|anlmdn` | `afftdn=nr=…`, `anlmdn` |
| `deesser` | `intensity` 0–1 | `deesser` |
| `echo` | `delay_ms[]`, `decay[]` | `aecho` |
| `stereo_width` | `amount` 0–2 | `extrastereo`, `stereotools=mlev` |
| `vocal_reduce` | `strength` | centre-channel cancellation via `pan=stereo|c0=c0-c1|c1=c1-c0` (karaoke-style) |
| `resample` | `rate`, `precision` | `aresample=resampler=soxr` |
| `audio_delay` | `ms` per channel | `adelay` |
| `crossfade` | see `concat.audio_crossfade_s` | `acrossfade` |
| `silence_pad` | `start_s`, `end_s` | `adelay`, `apad` |
| `trim_to_shortest` | — | `-shortest` |
| `audio_visual` | `kind: waveform_image|spectrogram_image|waveform_video|spectrum_video|bars_video|vectorscope_video`, `size`, `colors` palette name, `mode: line|point|cline|p2p`, `scale: lin|log|sqrt|cbrt`, `split_channels: bool` | `showwavespic`, `showspectrumpic`, `showwaves`, `showspectrum`, `showcqt`/`showfreqs`, `avectorscope`; image kinds are terminals producing png/jpg outputs |

### 8h. Images, thumbnails, GIF, sequences

| Operation | Parameters | ffmpeg mechanism |
|---|---|---|
| `thumbnail` (terminal) | `at` (timestamp, `N%`, or `smart`), `count` 1–100 evenly spaced, `size` (`width`/`height`), `format: jpg|png|webp|avif`, `quality` 1–100 | `-ss … -frames:v 1`, `thumbnail=N` for smart, `fps=1/interval` for sets; `-q:v`/`-quality`/`-crf` per format |
| `thumbnails_scene` (terminal) | `threshold` 0.1–0.9, `max` ≤ 200, `min_gap_s` | `select='gt(scene,T)',showinfo`, `-fps_mode vfr` |
| `contact_sheet` (terminal) | `columns` 1–12, `rows` 1–20 or `interval_s`, `tile_width`, `timestamps: bool`, `padding`, `background`, `format` | `fps`, `scale`, `drawtext=timecode`/`pts`, `tile=CxR:padding:margin` |
| `storyboard` (terminal) | `interval_s`, `tile_width`, `columns` | Sprite sheet(s) plus a WebVTT file with `#xywh=` fragments for video players |
| `gif` (terminal) | `start`, `end` (≤ `GIF_MAX_SECONDS`), `fps` 1–30, `width` ≤ 1080, `loop: bool`, `dither: bayer|floyd_steinberg|sierra2_4a|none`, `bayer_scale`, `max_colors` 2–256, `palette: global|per_frame`, `diff_mode: bool` | `fps,scale,split[a][b];[a]palettegen=stats_mode=…[p];[b][p]paletteuse=dither=…` in one pass; `-loop` |
| `animated_webp` / `animated_avif` (terminal) | `fps`, `width`, `quality`, `lossless`, `loop` | `libwebp_anim` (`-lossless -quality -loop`), AVIF via `libsvtav1`/`libaom` with the avif muxer |
| `frames` (terminal) | `every_s` or `fps` or `all` (≤ `FRAMES_MAX_COUNT`), `format`, `size`, `zip: bool` (default true) | `fps=` / `select` + `image2` sequence into the job dir; zipped as one output or listed individually |
| `image_convert` (terminal, image inputs) | `format: jpg|png|webp|avif|gif|bmp|tiff`, `quality`, `lossless`, `strip_metadata: bool`, `background` for alpha flattening | `-q:v`, `-compression_level`, `-lossless`, `-map_metadata -1`, `format=rgb24` with `pad`/`color` |
| `image_resize` / `image_crop` | same parameters as `scale` / `crop` | `scale`, `crop` on `image2` input |
| `images_to_video` (terminal) | `duration_each_s` or `fps`, `size`, `fit`, `transition`, `audio` input, `loop_audio` | concat demuxer with per-image `duration`, `scale`/`pad`, `xfade`, `-shortest` |
| `ken_burns` | `zoom_from`, `zoom_to` 1–2, `pan: center|left|right|up|down`, `duration_s` | `zoompan=z=…:x=…:y=…:d=…:fps=…` |
| `poster_frame` | `at` | extracts a frame and attaches it as `attached_pic` (cover) |

### 8i. Packaging and streaming

| Operation | Parameters | ffmpeg mechanism |
|---|---|---|
| `hls` (terminal) | `segment_s` 2–10, `variants[]` of `{ height, video_bitrate_kbps, audio_bitrate_kbps }` or `ladder: auto` (1080/720/480/360 ≤ source), `segment_type: mpegts|fmp4`, `playlist_type: vod`, `independent_segments: bool`, `audio_only_variant: bool` | `-f hls -hls_time -hls_playlist_type vod -hls_segment_type -master_pl_name master.m3u8 -var_stream_map "v:0,a:0 v:1,a:1" -hls_flags independent_segments`, `-g`/`-sc_threshold 0`/`-keyint_min` aligned to segments; one encoder per variant from a `split` |
| `dash` (terminal) | `segment_s`, `variants[]`, `single_file: bool` | `-f dash -seg_duration -adaptation_sets "id=0,streams=v id=1,streams=a"`; served under `/d/hls/:outputId/` with the same token |
| `remux` (terminal) | `container`, `fix_incompatible: bool` (re-encode only streams the container rejects, e.g. subtitles to `mov_text`, Vorbis to AAC for mp4), `faststart`, `video_codec` (`h264`/`hevc`) and `audio_codec` (`aac`): streams already in that codec are copied, any other is converted to it | `-c copy`, selective `-c:v`/`-c:a`/`-c:s` |
| `fragmented_mp4` (terminal) | `fragment_s` | `-movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration` |
| `mpegts` (terminal) | `pcr`, `muxrate` | `-f mpegts -mpegts_flags` |
| `fix` (terminal) | `regen_timestamps`, `ignore_errors`, `fix_duration`, `fill_gaps`, `faststart` | `-fflags +genpts+igndts`, `-err_detect ignore_err`, `-avoid_negative_ts make_zero`, `-max_interleave_delta 0`, `-movflags +faststart`, `aresample=async=1` |
| `bitstream` (terminal) | `filter: annexb|adts_to_asc|remove_sei|hevc_metadata` | `-bsf:v h264_mp4toannexb`, `-bsf:a aac_adtstoasc`, `filter_units`, `hevc_metadata` |
| `segment` | see `split.every_seconds` with `mode: copy` | `-f segment` |

### 8j. Analysis (JSON report outputs)

| Operation | Parameters | ffmpeg / ffprobe mechanism |
|---|---|---|
| `probe` | `frames: bool` (first N) | `ffprobe -print_format json -show_format -show_streams -show_chapters -show_programs` |
| `keyframes` | `max` | `ffprobe -skip_frame nokey -show_entries frame=pts_time,pkt_pos -select_streams v` |
| `bitrate_timeline` | `window_s` | `ffprobe -show_packets -show_entries packet=pts_time,size` aggregated server-side |
| `scene_changes` | `threshold` | `select='gt(scene,T)',metadata=print` |
| `black_detect` | `min_duration_s`, `pixel_threshold`, `picture_threshold` | `blackdetect`, `blackframe` |
| `freeze_detect` | `noise`, `duration_s` | `freezedetect` |
| `silence_detect` | `threshold_db`, `min_duration_s` | `silencedetect` |
| `loudness` | — | `ebur128=peak=true` + `loudnorm=print_format=json` (I, LRA, TP, threshold, momentary/short-term series) |
| `volume` | — | `volumedetect`, `astats=measure_overall` (mean/max/RMS/peak/DC/dynamic range per channel) |
| `crop_detect` | `limit`, `round`, `sample_s` | `cropdetect` |
| `interlace_detect` | `sample_s` | `idet` |
| `duplicate_frames` | `threshold` | `mpdecimate` count |
| `quality_compare` | `reference` input, `metrics[]: psnr|ssim|vmaf`, `model` (vmaf) | `psnr`, `ssim`, `libvmaf` filters with the reference scaled to match; per-frame series plus aggregates |
| `hash` | `algorithm: md5|sha256|crc32`, `per_stream: bool` | `-f hash -hash`, `-f streamhash` |
| `frame_hashes` | `algorithm` | `-f framemd5` (for frame-accurate dedup/diff) |
| `peaks` | `per_second` 1–100 | `astats` per window / `aresample`+`asetnsamples` → normalised peak array for UI waveforms |
| `transcribe` | `language` (ISO code or `auto`), `model` (name from `FFMPEG_WHISPER_MODELS`; default `FFMPEG_WHISPER_DEFAULT_MODEL`), `format: srt|vtt|json|txt`, `max_line_chars` 0–200, `vad: bool` (default true) | ffmpeg 8.1 `whisper` audio filter (whisper.cpp): `-vn`, `whisper=model=…:language=…:use_gpu=0:queue=20` (10 without VAD) `:vad_model=…:max_len=…:format=srt|json|text:destination=<service-generated path in the job dir>`, `-filter_threads FFMPEG_THREADS`, `-f null -`; `vtt` converted from the srt output; no translation (not in the 8.1 filter); heavy weight in the cost model, calibrated from the server benchmark (`DEPLOY.md` §2b); `FEATURE_DISABLED` only when the startup probe finds no filter, no model file or no AVX2 |

### 8k. Built-in recipe presets (`recipe: "<name>"`)

| Name | Steps |
|---|---|
| `web_mp4_1080` / `web_mp4_720` / `web_mp4_480` | `scale` → `encode` mp4 h264 crf 23 veryfast, aac 128k, faststart |
| `compress_to_size` | `encode` with `target_size_mb` (two-pass), audio 96k |
| `social_vertical` | `platform_format` 9:16 blur pad → `encode` h264 high 4.1, aac 128k |
| `clip` | `trim` accurate → `fade` 0.3 s → `web_mp4_720` |
| `audio_mp3_192` / `audio_m4a_160` / `audio_opus_96` / `audio_flac` | `encode` audio-only with embedded metadata and cover |
| `podcast` | `channels` stereo → `highpass` 80 Hz → `compress` voice → `normalize_loudness` −16 → `encode` mp3 128k mono-compatible |
| `audiobook_m4b` | `normalize_loudness` −18 → `encode` m4a aac 64k mono with chapters, renamed `.m4b` |
| `gif_preview` | `gif` 6 s, 480 px, 12 fps, sierra dither |
| `thumbnail_set` | `thumbnail` count 5 + `contact_sheet` 4×4 |
| `storyboard_vtt` | `storyboard` 5 s interval |
| `hls_ladder` | `hls` auto ladder, 6 s fmp4 segments |
| `archive_mkv` | `remux` mkv keeping all streams, chapters and attachments |
| `h264_mp4` | `remux` mp4 with `video_codec: h264`, `audio_codec: aac`, `fix_incompatible`: plays everywhere; H.264 and AAC are copied, VP9/AV1/HEVC and Opus re-encoded (x264 veryfast, 8-bit) |
| `audio_waveform_video` | `audio_to_video` waveform 1920×1080 → `encode` h264 stillimage tune |
| `burn_subtitles` | `subtitles_burn` from an srt input → `web_mp4_1080` |
| `loudness_report` | `loudness` + `volume` + `silence_detect` |
| `media_report` | `probe` + `keyframes` + `bitrate_timeline` + `scene_changes` + `black_detect` + `interlace_detect` |

### 8l. Never exposed (ffmpeg)

Raw `-vf`/`-af`/`-filter_complex` strings, any expression text, `-f lavfi` definitions, file paths (`movie=`, `amovie=`, `subtitles=` or `drawtext=fontfile=` from clients), inline `drawtext=text=`, `concat:`/`subfile:`/`data:` protocols, `-protocol_whitelist` wider than `file`, `-i` of anything but a resolved input, `-threads`, `-hwaccel`, encoder private options outside the mapped menus, `-metadata` keys outside the allowlist, `-map` strings (only validated indexes), output paths (fixed per job), `-progress` targets other than the pipe.

---
## 9. Jobs, pipelines and lifecycle

### 9a. Job types

| `type` | Input | Work | Children |
|---|---|---|---|
| `download` | `url` + §7 options | yt-dlp per item, then optional `then` recipe per produced file | playlist/channel: one `item` per entry |
| `batch` | `items[]` of URLs with per-item options | same as `download` per URL | one `item` per URL |
| `record` | live/premiere `url` | yt-dlp live recording with the §7d controls, remux, optional split | — |
| `process` | `inputs[]` + `recipe` | ffmpeg stages composed from the recipe | — |
| `comments` | `url`, `max`, `sort` | yt-dlp comments extraction to a JSON output | — |
| `probe` | one input | fetch + ffprobe to a JSON output | — |

### 9b. Pipelines (`then`)

```json
{ "type": "download", "url": "https://…", "preset": "1080p",
  "sponsorblock": { "remove": ["sponsor", "selfpromo"] },
  "then": { "steps": [ { "op": "normalize_loudness", "target_lufs": -14 },
                       { "op": "encode", "name": "web", "container": "mp4", "video": { "codec": "h264", "crf": 22 }, "audio": { "codec": "aac", "bitrate_kbps": 160 } },
                       { "op": "thumbnail", "name": "poster", "at": "smart" } ] },
  "destination": { "type": "google_drive" } }
```

- `then` is a recipe (inline or named) applied to **each media file the download produced** (the main file, each section, each chapter when `chapters.split`). It runs as a child `process` step on the `ffmpeg` queue; the download item is `processing` meanwhile.
- Outputs of the download (subtitles, thumbnails, info JSON) are available to the recipe as implicit inputs: `{ "type": "job_output", "role": "subtitles", "lang": "en" }`, `{ "role": "thumbnail" }`, so "download with English subtitles and burn them in" is one request.
- `keep_original: bool` (default false when `then` is set) decides whether the yt-dlp output is delivered alongside the processed outputs.
- Watches (§7e) may carry a `then` recipe too.

### 9c. States and stages

```
queued → running → completed
   │        │        ↘ completed_with_errors (parents only)
   │        └──────→ failed | cancelled
   └──────────────→ expired (never started before its deadline)
record: queued → waiting → recording → running (remux/split) → completed
```

Stage within `running`: `resolving_inputs`, `expanding`, `downloading`, `postprocessing` (yt-dlp's own ffmpeg steps), `processing` (recipe stages, `stage i/n`), `uploading`, `finalizing`. Progress payload: `percent`, `stage`, `speed`, `eta`, `bytes`, `out_time` for ffmpeg, `fragment` counts for yt-dlp, and for parents `{ total, completed, failed, running, queued }`.

- **Retries:** up to 2 automatic retries with backoff for network/transient errors (`5xx`, timeouts, throttling, `BOT_CHECK` once with a different impersonation target when configured). Unsupported site, private/removed media, limit violations and recipe errors fail immediately. `POST /v1/jobs/:id/retry` re-queues failed items manually.
- **Stalls and restarts:** BullMQ stalled-job detection re-queues jobs whose worker died; temp directories of orphaned jobs are swept by the cleanup worker.
- **Cancel:** the API publishes `cancel:<jobId>` on a Redis channel; every worker subscribes and sends SIGTERM to the matching child process (SIGINT for `record`, so yt-dlp finalises the file), then marks `cancelled`. Playlist/batch cancel fans out to pending and running children; completed outputs remain.
- **Timeouts:** `JOB_TIMEOUT_MINUTES` for downloads; `base + estimated_cost × factor` for recipes; `LIVE_MAX_DURATION_MINUTES` for recordings; per-stage ffprobe/expansion timeouts.
- **Idempotency:** `Idempotency-Key` scoped to `(client, user_id)`, unique for 24 h; a repeated key returns the original job.

### 9d. Deduplication

- **Downloads** dedupe on `(extractor, media_id, preset, container, options_hash)` where `options_hash` covers everything that changes the bytes (sections, SponsorBlock, embeds, subtitles). A hit reuses the unexpired file instantly.
- **Process jobs** dedupe on `(input_hashes, canonical_recipe_hash)`.
- **In-flight dedup:** a Redis lock on the dedup key makes a second concurrent request wait for the first run instead of downloading twice; the waiter gets the same output.
- Drive destinations still upload per user. Dedup never crosses `(client, user_id)` boundaries for Drive-only or inbox/upload inputs; it does for public media URLs.

### 9e. Playlists, channels and batches

```
POST /v1/jobs (playlist URL or batch)
   │
   ▼
parent job ── expand: yt-dlp --flat-playlist -J --playlist-end N (metadata only, PLAYLIST_EXPAND_TIMEOUT_SECONDS)
   │            ├─ apply items selection, date/metadata filters, archive (skip_downloaded), caps
   │            └─ create child item jobs
   ▼
feeder keeps ≤ USER_MAX_CONCURRENT_ITEMS children active per user, across both queues
   ▼
item jobs ── same path as a single download (dedup, options, limits, then-recipe, Drive upload)
   ▼
parent = aggregate status (+ optional concat_items output, ZIP, manifests)
```

- yt-dlp never downloads a whole playlist in one process; every item runs with `--no-playlist` and passes the URL guard again.
- Caps: `PLAYLIST_MAX_ITEMS` (larger playlists require an `items` range), `PLAYLIST_MAX_TOTAL_DURATION_HOURS` (unknown durations count as `PLAYLIST_UNKNOWN_DURATION_MINUTES`), `BATCH_MAX_URLS`.
- Partial failures: items fail individually with their own error code; the parent ends `completed_with_errors`. All failed → `failed`.
- Expansions are cached in `playlists` for `PLAYLIST_CACHE_TTL_MINUTES`.
- The disk guard is checked per item start, not only at parent creation.

### 9f. Watches

- A watch stores a URL, interval (≥ `WATCH_MIN_INTERVAL_MINUTES`), filters, download options, `then` recipe and destination.
- The scheduler (BullMQ repeatable job) expands the source with `--flat-playlist --playlist-end WATCH_MAX_NEW_ITEMS --break-on-existing` against the user's archive, creates a `batch` job for new entries and records a run.
- Consecutive failures pause the watch after `WATCH_MAX_FAILURES` with the last error; `PATCH` resumes it.

---

## 10. Outputs, files and links

- Every job produces **outputs**: media files, images, subtitle files, JSON reports, ZIPs, HLS/DASH packages. Each output has an id, `role` (`media`, `audio`, `thumbnail`, `subtitles`, `info_json`, `description`, `comments`, `report`, `package`, `archive`), name, mime, size, duration, probe summary, `expires_at`, and its signed link and/or Drive link.
- Files live under `<FILES_DIR>/<jobId>/<outputId>/<sanitised-name>.<ext>`; packages (HLS/DASH, frame sets) are directories under the output id.
- **Signed links** are HMAC-signed and valid for `FILE_TTL_DAYS` (default 7). `/d/:outputId` verifies signature and expiry and returns `X-Accel-Redirect` to an `internal` nginx location; nginx streams with Range/resume and the right `Content-Disposition`. Package links sign the output id, so one token covers every file beneath it, and the API maps the sub-path onto the internal location.
- **Job ZIP** (`/d/job/:jobId.zip`) streams a store-only archive of all completed outputs; no extra disk, no build wait, no Range. **Manifests**: `.m3u` with every media link; the JSON manifest is `GET /v1/jobs/:id/outputs`.
- Outputs can be **re-used as inputs** (`{ type: "output", outputId }`) until they expire; each reuse extends the file's expiry to `FILE_TTL_DAYS` from the latest use.
- **Deleting on request:** a user deletes one of their files (`DELETE /v1/outputs/:id`) or all of a finished job's (`DELETE /v1/jobs/:id/outputs`) before they expire. Only the owner can, and not while the job, or the playlist or batch it belongs to, still runs (`409 JOB_NOT_FINISHED`): recipes, ZIPs and concat read those files. The output row goes at once, so its link answers 404; the file goes once no other output points at it (a dedup hit or reuse shares the path). A job's hidden originals go with the last file it shows. The job's own dedup entry is dropped, so the next identical download fetches anew instead of reusing a job with files missing. The Drive copy and the archive entry stay.
- **Cleanup:** hourly job deletes expired files, orphaned temp dirs, expired uploads and input cache entries. Neither using an upload nor a cache hit extends its expiry, so those two go only once expired for longer than `JOB_TIMEOUT_MINUTES` + 1 h, when no job can still be reading them. **Disk guard:** new jobs and item starts are rejected with `503 STORAGE_FULL` above `DISK_QUOTA_PERCENT`; the estimated space of a recipe (inputs + outputs + temp, ~3× input) must fit.
- Delivery to Drive leaves the local file in place for the TTL, so a fallback link exists and dedup works.

---

## 11. Google Drive (per-user OAuth)

- **Scopes:** `drive.file` (the app only sees files and folders it created) + `openid email` (to show the connected account).
- **Connect flow:** `POST /v1/drive/connect` stores a single-use `state` (expires after `OAUTH_STATE_TTL_MINUTES`) and returns the consent URL (`access_type=offline&prompt=consent`); the callback exchanges the code and stores the refresh token encrypted with AES-256-GCM (versioned key).
- **Folder targeting under `drive.file`:** the app can write only into folders it created itself. `folderId` must therefore be the user's root folder, a sub-folder the service created, or any id listed by `GET /v1/drive/files`. A hand-made folder id fails with `DRIVE_FOLDER_NOT_ACCESSIBLE`. (Broader access would need the Picker flow or the restricted `drive` scope and Google's verification; out of v2.)
- **Upload:** first upload creates `Media downloads` in the user's Drive unless `folderId` is given. Playlists and batches go into a sub-folder named after the playlist/batch; multi-output recipes into a sub-folder named after the job; HLS/DASH packages upload as a folder tree. Resumable upload in 8 MB chunks with per-chunk retry; stored result: Drive `fileId`, `webViewLink`, folder link.
- **Read-back:** files the app created are usable as inputs with the user's token; public files via `GOOGLE_API_KEY` (§5).
- **Failures:** `invalid_grant` → connection `revoked`, job `DRIVE_RECONNECT_REQUIRED`, local file kept; storage full → `DRIVE_STORAGE_FULL`; 403 rate limit / 429 → exponential backoff.
- **Google Cloud setup (owner):** project, OAuth client, consent screen **"In production"** (Testing-mode refresh tokens expire after 7 days), redirect URI `https://<subdomain>/oauth/google/callback`, Drive API enabled, an API key restricted to the Drive API for public-file reads.

---
## 12. Security

- **URL guard** (every `media_url`, `url`, playlist entry and redirect hop): `http`/`https` only; the hostname is resolved and rejected if any address is private, loopback, link-local, multicast, reserved or a cloud-metadata address. yt-dlp's generic extractor is disabled; `SITE_ALLOWLIST` optionally restricts extractors.
- **Egress filtering**: `api`, the workers and `pot-provider` reach the internet only through a Docker network whose rules drop RFC1918, CGNAT, loopback, link-local, multicast and metadata ranges and new connections to the host, so DNS rebinding or redirects inside yt-dlp or undici cannot reach internal services. Postgres and Redis are reached over a separate `internal` network that has no route out (rules in `DEPLOY.md` §4.5).
- **Subprocess hardening** (yt-dlp, ffmpeg, ffprobe, deno): argument arrays via execa, `--` before URLs, cwd = job temp dir, minimal environment (`PATH`, `HOME`, `TMPDIR` only; secrets never reach children), `--ignore-config`, per-run timeouts, SIGTERM then SIGKILL, stdout/stderr size caps, logs redacted.
- **ffmpeg inputs**: only files the service placed in the job directory; `-protocol_whitelist file,crypto`; container allowlist via ffprobe before any run; subtitle/font/LUT/text files written by the service; `-nostdin -hide_banner -loglevel error -progress pipe:1 -nostats -y`.
- **Filtergraph composition**: parameters are validated numbers and enums; strings (text, metadata values, titles) go through files or `-metadata` arguments, never into graph syntax; fonts from the bundled allowlist by name; expressions are generated from numbers only.
- **Resource limits**: `-threads FFMPEG_THREADS`, `nice`, Compose `cpus`/`mem_limit` on `worker-ff`, `-fs` output cap, partial-file **watchdog** that polls the job directory every few seconds and kills any process exceeding `MAX_FILE_SIZE_MB` (covers fragmented downloads where yt-dlp's own check cannot), cost model and timeouts for recipes, `REVERSE_MAX_SECONDS`, `INTERPOLATE_MAX_SECONDS`, `GIF_MAX_SECONDS`, `FRAMES_MAX_COUNT`.
- **Uploads**: tus with declared size ≤ `MAX_UPLOAD_SIZE_MB`, per-user concurrent upload and daily byte quotas, upload token bound to `(client, user_id, uploadId)` with a short TTL, files probed before use, never executed or served raw before probing.
- **Inbox**: read-only mount; bare names; realpath must stay inside `INBOX_DIR/<client>/`; symlinks rejected; listing paginated.
- **Secrets at rest**: refresh tokens, cookie jars and site credentials encrypted with AES-256-GCM under `TOKEN_ENCRYPTION_KEYS` (versioned; newest encrypts, all decrypt). Cookie jars are decrypted to a job-local temp file only for the run and shredded after.
- **Playlist bounds**: expansion limited by `--playlist-end` and a timeout; item and duration caps.
- **Containers**: non-root user, read-only root filesystem; the files volume, the job temp dir and the yt-dlp cache dir are the only writable paths; the inbox is read-only.
- **Rate limits**: per API key in the app (Redis-backed, `API_RATE_LIMIT_PER_MINUTE`), per-user job creation and upload quotas, `limit_req` per IP in nginx; tus and `/d/` locations have their own limits.
- **Signed links** are bearer links by design; the token includes the output id and expiry; packages share one token per output. Logs redact signed URLs, API keys, tokens and cookies.
- **Payments/PII**: out of scope; no card data anywhere.

---

## 13. Configuration (`.env`)

All values validated with Zod at startup; the service refuses to start on invalid values. Changes apply on restart. `.env.example` documents every variable.

### Limits and quotas

| Variable | Default | Meaning |
|---|---|---|
| `DOWNLOAD_CONCURRENCY` | `4` | Concurrent download items per `worker-dl` |
| `FFMPEG_CONCURRENCY` | `2` | Concurrent recipe stages per `worker-ff` |
| `FFMPEG_THREADS` | `4` | Threads per ffmpeg process |
| `FFMPEG_HWACCEL` | `none` | `none` / `vaapi` / `nvenc` / `qsv` |
| `USER_MAX_CONCURRENT_ITEMS` | `2` | Active items per user across both queues |
| `USER_MAX_ITEMS_PER_DAY` | `300` | Items per user per rolling 24 h (every item, recipe and recording counts) |
| `USER_MAX_PROCESS_MINUTES_PER_DAY` | `600` | Summed input duration of recipes per user per day |
| `USER_MAX_UPLOAD_MB_PER_DAY` | `20480` | Upload bytes per user per day |
| `PLAYLIST_MAX_ITEMS` | `100` | Max items per playlist job; larger playlists require an `items` range |
| `PLAYLIST_MAX_TOTAL_DURATION_HOURS` | `24` | Combined duration cap per playlist job |
| `PLAYLIST_UNKNOWN_DURATION_MINUTES` | `10` | Assumed duration for entries without one |
| `PLAYLIST_EXPAND_TIMEOUT_SECONDS` | `120` | Expansion process timeout |
| `PLAYLIST_CACHE_TTL_MINUTES` | `60` | Reuse window for expansions |
| `BATCH_MAX_URLS` | `50` | URLs per batch job |
| `API_RATE_LIMIT_PER_MINUTE` | `120` | Requests per API key per minute |
| `MAX_MEDIA_DURATION_MINUTES` | `240` | Max duration of a single item or recipe input |
| `MAX_FILE_SIZE_MB` | `4096` | Max size of any input or output |
| `MAX_UPLOAD_SIZE_MB` | `4096` | Max size of one upload |
| `UPLOAD_TTL_HOURS` | `24` | Unused uploads are deleted after this |
| `INPUT_CACHE_HOURS` | `6` | Fetched URL/Drive inputs are reused for this long |
| `PROBE_MAX_MB` | `64` | Synchronous probe fetch limit |
| `COMMENTS_SYNC_MAX` | `200` | Synchronous comments cap |
| `JOB_TIMEOUT_MINUTES` | `60` | Hard timeout per download item |
| `RECIPE_TIMEOUT_BASE_MINUTES` / `RECIPE_TIMEOUT_FACTOR` | `5` / `2.0` | Recipe timeout = base + input minutes × factor × cost class |
| `RECIPE_MAX_COST` | `5000` | Work-unit budget per recipe |
| `RECIPE_MAX_STEPS` / `RECIPE_MAX_INPUTS` / `RECIPE_MAX_OUTPUTS` / `RECIPE_MAX_TEXT_LAYERS` | `25` / `20` / `10` / `8` | Recipe shape caps |
| `REVERSE_MAX_SECONDS` / `INTERPOLATE_MAX_SECONDS` / `GIF_MAX_SECONDS` / `FRAMES_MAX_COUNT` | `60` / `120` / `30` / `2000` | Memory-heavy operation caps |
| `LIVE_MAX_DURATION_MINUTES` | `360` | Max recording length |
| `LIVE_MAX_WAIT_MINUTES` | `720` | Max wait for a scheduled premiere/live |
| `JOB_RATE_LIMIT_MAX_KBPS` | `0` (unlimited) | Upper bound for per-job `limit_rate_kbps` |
| `TRANSCRIPT_TIMEOUT_SECONDS` | `60` | Synchronous transcript timeout |
| `FILE_TTL_DAYS` | `7` | File and signed-link lifetime |
| `DISK_QUOTA_PERCENT` | `80` | Reject new work above this volume usage |
| `OAUTH_STATE_TTL_MINUTES` | `10` | Drive consent link validity |
| `WATCH_MIN_INTERVAL_MINUTES` / `WATCH_MAX_NEW_ITEMS` / `WATCH_MAX_FAILURES` | `30` / `20` / `5` | Watch scheduling bounds |
| `SITE_ALLOWLIST` | *(empty)* | Comma-separated extractor names; empty = all built-in |

### yt-dlp behaviour

| Variable | Meaning |
|---|---|
| `YTDLP_IMPERSONATE_DEFAULT` | Default `--impersonate` target (`chrome`) or empty |
| `YTDLP_POT_PROVIDER_URL` | PO-token provider service URL (plugin configured from it) |
| `YTDLP_ALLOWED_PLAYER_CLIENTS` | Allowed `youtube.player_client` values |
| `YTDLP_SLEEP_REQUESTS_SECONDS` | `--sleep-requests` applied to every run (anti-throttling) |
| `PROXY_POOL` | JSON `{ "name": "scheme://user:pass@host:port", … }` |
| `PROXY_DEFAULT_BY_EXTRACTOR` | JSON `{ "youtube": "name", … }` |
| `GEO_BYPASS_ALLOWLIST` | ISO country codes allowed for `geo_country` |
| `SPONSORBLOCK_API_URL` | Default `https://sponsor.ajay.app` |
| `SITE_CREDENTIALS_ENABLED` / `TV_PROVIDER_ENABLED` | Feature flags for §7f credential paths |
| `FFMPEG_WHISPER_MODELS` | JSON name → model path in the `models` volume, e.g. `{"fast":"/models/ggml-base-q8_0.bin","balanced":"/models/ggml-small-q8_0.bin","accurate":"/models/ggml-large-v3-turbo-q5_0.bin"}`; every path is checked at startup |
| `FFMPEG_WHISPER_DEFAULT_MODEL` | Name used when a recipe omits `model` (`accurate`) |
| `FFMPEG_WHISPER_VAD_MODEL` | Silero VAD model path (`/models/ggml-silero-v6.2.0.bin`); empty disables `vad` |
| `FONT_DIR` | Fonts available to `text`/`subtitles_burn`; the allowlist is derived from it at startup |

### Infrastructure and secrets

| Variable | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | e.g. `https://dl.<domain>`, or `https://<host>/<path>` behind a reverse proxy that serves the service under a path and strips it (no query, fragment or credentials; a trailing slash is dropped); links, tus URLs and the OAuth redirect URI |
| `API_PORT` | Port bound on `127.0.0.1` |
| `WORKER_ROLE` | `download` or `ffmpeg` for the worker entry point |
| `DATABASE_URL` / `DATABASE_MIGRATION_URL` / `DATABASE_SSL_MODE` / `DATABASE_SSL_CA_FILE` / `DATABASE_POOL_MAX` | Postgres (as v1) |
| `REDIS_URL` | Redis (`rediss://` for TLS) |
| `BACKUP_ENABLED` | Nightly `pg_dump` on/off |
| `FILES_DIR` / `INBOX_DIR` | Volumes inside containers |
| `NGINX_INTERNAL_FILES_PREFIX` | Internal nginx location for `X-Accel-Redirect` |
| `LINK_SIGNING_SECRET` | HMAC key for signed links and upload tokens |
| `TOKEN_ENCRYPTION_KEYS` | Versioned AES-256-GCM keys (`v1:<base64>,v2:<base64>`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_API_KEY` | OAuth client and the Drive-restricted API key |
| `LOG_LEVEL` | pino level |

---

## 14. Data model (Postgres, Drizzle migrations)

| Table | Columns |
|---|---|
| `clients` | id, name, created_at |
| `api_keys` | id, client_id, key_hash, prefix, default_user_id, share_outputs_within_client, last_used_at, revoked_at, created_at |
| `drive_connections` | id, client_id, user_id, google_email, refresh_token_enc, key_version, root_folder_id, status, created_at, updated_at — unique (client_id, user_id) |
| `oauth_states` | state, client_id, user_id, expires_at |
| `cookie_jars` | id, client_id, user_id, label, domains (JSONB), jar_enc, key_version, is_default, expires_at, created_at |
| `site_credentials` | id, client_id, user_id, site_key, username, secret_enc, totp_seed_enc, key_version, created_at |
| `uploads` | id, client_id, user_id, filename, mime, declared_size, received_size, path, status, probe (JSONB), expires_at, created_at |
| `inputs` | id, client_id, user_id, type, source (JSONB), content_hash, path, size_bytes, probe (JSONB), expires_at, created_at — unique (client_id, user_id, content_hash) |
| `media_files` | id, extractor, media_id, preset, options_hash, path, size_bytes, mime, title, duration_s, probe (JSONB), last_used_at, expires_at — unique (extractor, media_id, preset, options_hash) |
| `playlists` | id, extractor, playlist_id, title, uploader, item_count, entries (JSONB), expanded_at |
| `jobs` | id, type (`download`/`batch`/`record`/`process`/`comments`/`probe`), kind (`parent`/`item`/`single`), parent_job_id, playlist_index, client_id, user_id, url, options (JSONB), recipe (JSONB), inputs (JSONB), destination (JSONB), status, stage, error_code, error_message, total_items, completed_items, failed_items, attempts, cost_estimate, idempotency_key, created_at, started_at, finished_at |
| `outputs` | id, job_id, client_id, user_id, role, name, path, is_directory, mime, size_bytes, duration_s, probe (JSONB), media_file_id, drive_file_id, drive_link, drive_folder_id, expires_at, created_at |
| `recipes` | id, client_id, name, steps (JSONB), created_at, updated_at — unique (client_id, name) |
| `archive` | client_id, user_id, extractor, media_id, job_id, created_at — primary key (client_id, user_id, extractor, media_id) |
| `watches` | id, client_id, user_id, url, interval_minutes, options (JSONB), recipe (JSONB), destination (JSONB), status, failures, last_run_at, next_run_at, created_at |
| `watch_runs` | id, watch_id, started_at, finished_at, new_items, job_id, error |
| `job_logs` | job_id, seq, line (redacted), created_at — capped per job, purged with the job's files |

Live progress, quota counters, rate limits, dedup locks, cancel channel and the cost ledger live in Redis only.

---
## 15. Scaling triggers

Built in from day one: separate api / worker-dl / worker-ff containers, two BullMQ queues, Redis-backed limits and locks, storage behind an interface, stateless API and MCP, quotas, dedup, cost model, metrics.

| When | Do |
|---|---|
| Download queue waits grow / bandwidth saturated | Add `worker-dl` machines (same image, same Postgres + Redis) |
| ffmpeg queue waits grow / CPU saturated | Add `worker-ff` machines, raise `FFMPEG_CONCURRENCY` on bigger hosts, enable `FFMPEG_HWACCEL` where a GPU exists |
| Heavy recipes dominate | A third queue (`ffmpeg-heavy`) fed by cost class, with its own workers |
| Workers span machines, or serving files eats bandwidth | Switch storage to Cloudflare R2 / S3 (config change); tus moves to direct-to-bucket uploads |
| Hundreds of concurrent jobs | PgBouncer; consider managed Postgres |
| Source sites block the server IP | Rotate the proxy pool, add residential proxies, PO-token provider already in place |
| Third parties are onboarded | OAuth 2.1 for MCP, per-client limit overrides, billing, admin UI |
| Before any public launch | k6 load tests, Grafana alerts, ffmpeg sandboxing (seccomp profile / gVisor) |

---

## 16. Testing and quality

- **Lint/format/types:** ESLint (typescript-eslint), Prettier, TypeScript strict.
- **Unit (Vitest):** URL guard; option → yt-dlp argument mapping for every §7 field (snapshot per option); `items` parsing; `mode` decision; match-filter composition (literal escaping); playlist caps and bounded expansion; feeder fairness; aggregate status rules; progress parsers (yt-dlp JSON template, ffmpeg `-progress`); link signing and package tokens; token/cookie encryption and key rotation; quota and limit logic; recipe validation (every operation's schema, bad combinations, caps); **filtergraph composer** (snapshot per operation and for multi-output/stage splitting, text via textfile, escaping of file paths and metadata); cost model; dedup key canonicalisation; inbox path validation (traversal, symlinks); env validation. Uses a **fake yt-dlp** and a **fake ffmpeg/ffprobe** script for success, progress, errors, timeouts, mixed-result playlists and multi-stage recipes.
- **Integration:** Testcontainers (Postgres + Redis); REST via Fastify inject; MCP via the SDK's in-memory client; tus upload flow (create, patch chunks, resume after interruption, expiry); Google OAuth/Drive mocked with undici MockAgent (revocation, quota errors, resumable chunk retry, folders, public-file read, inaccessible folder); streamed ZIP validity; expired-link rejection; cancel via Redis channel kills a running fake process; in-flight dedup; watch scheduling.
- **Real-binary tests (container):** real ffmpeg/ffprobe against generated fixtures (`testsrc2`, `sine`) for every operation in §8: output probes assert codec, size, duration, stream layout, loudness within tolerance, GIF palette, HLS ladder playability (ffprobe of master and variants), subtitle burn-in presence (frame diff), text overlay presence, concat durations, stabilisation/tonemap/vidstab execution; `transcribe` of whisper.cpp's `samples/jfk.wav` with the `fast` model (expected phrase present in srt/json/txt/vtt, VAD on and off); rejection of hls/concat/lavfi inputs; `-fs` cap; watchdog kill.
- **Config:** env validation for database/Redis URLs, SSL settings, proxy pool and font allowlist (bad values refuse to start); the integration suite also runs with TLS-enabled Postgres and a separate migration role.
- **Smoke:** real yt-dlp in the container against a local media server — single item, a 3-item playlist, sections, SponsorBlock (mocked API), subtitles embed, a `then` recipe, a live recording from a local HLS stream, signed link through nginx, upload through tus → recipe → Drive (mock).
- **E2E (Playwright):** Drive connect/callback pages; a minimal upload test page driving tus-js-client against the API.
- **CI (GitHub Actions):** lint, typecheck, unit, integration, real-binary tests, image build, push to GHCR; weekly rebuild with the latest pinned yt-dlp; live YouTube tests on demand. YouTube often refuses runner IPs (`BOT_CHECK`): the end-to-end test then skips its YouTube checks, for that answer only, and flags the run with a warning.

---

## 17. Deployment

- Repo ships: `docker-compose.yml`, `.env.example`, an **nginx vhost snippet** (upstream proxy; `proxy_buffering off` and long `proxy_read_timeout` for `/mcp`, `/v1/jobs/*/events` and `/u/`; `proxy_request_buffering off` and `client_max_body_size` matching `MAX_UPLOAD_SIZE_MB` on `/u/`; `internal` files location with Range support and `Content-Disposition` pass-through; `limit_req` zones for API, uploads and downloads), and certbot instructions. Also `install.sh`, `deploy.sh`, `smoke.sh`, `models.sh`, the egress firewall unit and `nginx/front.conf` (a minimal TLS front for the bundled proxy). The whole `deploy/` folder is also copied into the image at `/app/deploy`, so an installed version always runs with its matching compose file and scripts.
- **Quick deploy (`install.sh`, `DEPLOY-QUICKSTART.md`):** one command on a fresh Ubuntu/Debian amd64 server. It checks the OS and architecture only: there is no CPU, RAM or disk minimum (`DEPLOY.md` §3 recommends a size), and on a CPU without AVX2 it installs with transcription turned off (`MODELS=none`). It installs Docker if missing, pulls the image, extracts `/app/deploy` to `/srv/media`, writes `.env` with generated secrets on the first run only, checks that the ports it publishes are free (`API_PORT` on `127.0.0.1`, the bundled nginx on `HTTP_BIND:HTTP_PORT`; the stack's own containers holding them on an update are fine) and otherwise stops, naming who holds the port and the `.env` setting to change, connects to an outside database when `DATABASE_URL` is given (§17a) and stops on failure, installs the egress firewall unit, downloads the whisper models, and starts the stack with the `local-db`, `local-redis` and `proxy` profiles on `http://127.0.0.1:8085`, reachable from the server only. It then runs `smoke.sh`, creates the first API key (`keys:create` must work non-interactively and print the key once), and prints a summary. Overrides are environment variables on the same command (`MEDIA_VERSION`, `HTTP_PORT`, `HTTP_BIND`, `PUBLIC_BASE_URL`, `MEDIA_FILES_PATH`, `MODELS`, `GH_TOKEN`, and `DATABASE_URL` with its `DATABASE_SSL_*` settings for an outside database). Re-running it updates and never overwrites `.env`. Opening the service to other machines is the operator's decision, never the installer's: either `HTTP_BIND=0.0.0.0` and `PUBLIC_BASE_URL` in `.env` (plain HTTP), or host nginx with `front.conf` + certbot in front of the default `127.0.0.1` bind, with `PUBLIC_BASE_URL` set to its address.
- **Windows (`install-windows.ps1`, `DEPLOY-QUICKSTART.md` "Windows"):** the same stack under Docker Desktop, run from a git clone's `deploy` folder. On the first run it writes `.env` with generated secrets, plus `docker-compose.override.yml` declaring Docker volumes for the files, Postgres and Redis, since Postgres refuses a Windows folder. It downloads the whisper models from `models.sh`'s catalog, checking each SHA-256, and pulls the release the clone has checked out (read from `.git`, so git needn't be installed). It starts the stack, checks the API through the bundled proxy with a temporary key, and creates the first API key. Later runs keep `.env` and only set `IMAGE_TAG`, plus `PUBLIC_BASE_URL` or the models when asked. There is no egress firewall. On an ARM PC it asks Docker for the amd64 build.
- **Images (two, `linux/amd64`, private on GHCR):**
  - `media-ffmpeg:n8.1.3-w1.9.5-r<N>`: Debian trixie-slim; FFmpeg n8.1.3 built from source with `--enable-gpl --enable-whisper` and the §2 library set from Debian `-dev` packages; whisper.cpp v1.9.5 static, CPU only, `GGML_NATIVE=OFF` with AVX2/FMA/F16C/BMI2 (a native build would target the CI runner's CPU). CI acceptance: `-buildconf` has `--enable-whisper`, `-h filter=whisper` works, the §2 filters are listed, `jfk.wav` transcribes. Rebuilt on version bumps and monthly for Debian security updates.
  - `media-service:<git-sha>`: `FROM media-ffmpeg@sha256:…`; Node 24; Python venv with pinned `yt-dlp[default,curl-cffi]`, `mutagen` and the PO-token provider plugin; deno pinned; fonts; non-root UID 10001; read-only root FS. Built on every push to `main`, weekly with the latest yt-dlp, and by hand for urgent extractor fixes.
- **Compose services:** `api`, `worker-dl`, `worker-ff` (CPU and memory limits), `pot-provider` (PO-token provider), `migrate`, `backup`, optional `postgres`/`redis` profiles, and a `proxy` profile: a bundled nginx container (pinned image) running the production vhost snippet on plain HTTP, published on `${HTTP_BIND:-127.0.0.1}:${HTTP_PORT:-8085}` (nginx listens on 8080 inside the container), looking `api` up again in Docker's DNS every few seconds (`resolve`) so a recreated `api` with a new address needs no proxy restart, with the files volume mounted read-only so X-Accel downloads and tus uploads behave as with host nginx. It serves development and the quick deploy; the full production setup uses host nginx instead (`DEPLOY.md` §4.4). Volumes: `files` (host path `${MEDIA_FILES_PATH:-/srv/media/files}`), `inbox` (read-only in api and workers), `models` (read-only in `worker-ff`), `ytdlp-cache`. Networks: `backend` (`internal: true`), the filtered `egress` network (§2), and `edge` for the `proxy` container's published port (the proxy never fetches caller URLs).
- **Releases:** `IMAGE_TAG` in `.env` selects the image; `deploy.sh <git-sha>` sets it, records it in `.release-history`, pulls, runs `up -d` and then `smoke.sh` (health, info, download + Range request through nginx, recipe, transcribe). Rollback = `deploy.sh <previous sha>`. Workers get `stop_grace_period: 5m`.
- **Migrations:** the one-off `migrate` service applies Drizzle migrations on every deploy before the others start. Migrations are **expand/contract**: a release only adds; removals and renames ship a release later. An older image's `migrate` is then a no-op, so rolling back never touches the schema.
- **Backups:** nightly `pg_dump`, 14-day retention; `BACKUP_ENABLED=false` when the external DB handles backups. Files are not backed up (7-day TTL by design).
- **yt-dlp / ffmpeg updates:** versions pinned in the image; CI rebuilds weekly; a daily canary on the server (`canary.sh`: download, recipe, transcription, from the server's own IP) alerts on breakage; manual "rebuild now" path for urgent extractor fixes.

### 17a. External Postgres / Redis

The bundled `postgres` and `redis` services are optional. Changing credentials or moving to another server is a `.env` change plus a restart.

**Requirements for an external Postgres:** PostgreSQL 15+; a dedicated database and app role (`ytdlp_app`), optionally a migration role; port 5432 reachable only from the app server (private network, WireGuard or firewall); TLS required (`DATABASE_SSL_MODE=verify-full` with `DATABASE_SSL_CA_FILE`).

**Moving from the bundled DB:** create database and roles → `docker compose stop api worker-dl worker-ff` → `pg_dump -Fc` / `pg_restore` → update `DATABASE_URL` (and migration/SSL vars) → start without the `local-db` profile (`migrate` runs first) → verify `/health`, a smoke download and a smoke recipe → remove the old `pgdata` volume.

**Installing straight onto an outside Postgres** (Supabase, a managed service, another server): `DATABASE_URL=… [DATABASE_SSL_MODE=…] [DATABASE_SSL_CA_FILE=/path/ca.pem] [DATABASE_MIGRATION_URL=…] install.sh`. The stack then starts without the `local-db` profile, `DATABASE_SSL_MODE` defaults to `verify-full`, and the CA is copied to `/srv/media/certs/database-ca.pem`, which every app container mounts read-only at `/certs`. Before the firewall and the model download, the installer runs the one-off `migrate` service against it (on every run, updates too); when that fails it stops, naming the host and `migrate`'s one-line reason (`Migrations failed: <message> (<SQLSTATE>)`), never the URL. The generated `POSTGRES_*` values stay in `.env`, because compose resolves the bundled service's variables even with its profile off. `migrate` is on the `egress` network so it can reach the database (the egress firewall leaves public addresses open; a private one needs `EGRESS_ALLOW`). Supabase: the pooler's session mode (port 5432), because the direct address is IPv6-only and the installer turns Docker's IPv6 off, and transaction mode breaks the migration lock; its CA certificate from the dashboard. The nightly `pg_dump` uses `DATABASE_URL` as given (libpq's default `prefer`: encrypted, not verified).

**Redis:** set `REDIS_URL` (`rediss://` for TLS) and start without `local-redis`; drain or let in-flight jobs finish first (queue state is transient).

**Credential rotation:** create the new password/role, update `.env`, `docker compose up -d`, revoke the old credentials.

---

## 18. Milestones

1. Skeleton, config/env validation, database, API keys, `info` / `search` / `transcripts` / `comments` / `presets`
2. `media-ffmpeg` base image (ffmpeg 8.1 + whisper.cpp) and its CI build; single-item downloads with the full §7a–7c option set, `worker-dl`, progress, signed links via nginx, cleanup, dedup (incl. in-flight), cancel channel, watchdog
3. Playlists, channels, batches: bounded expansion, child jobs, feeder, filters, archive, aggregate status, ZIP + manifests, `concat_items`
4. Inputs: tus uploads, inbox, output reuse, URL fetch, input cache; `probe`
5. ffmpeg core: recipe schema, composer, cost model, `worker-ff`, `encode`, time ops, geometry, remux/fix, thumbnails/GIF, analysis basics, pipelines (`then`)
6. ffmpeg extended: composition (concat/overlay/stack/slideshow/generate), visual filters, text, subtitles, audio suite, packaging (HLS/DASH), full analysis set including `transcribe` and the `models` volume, built-in and saved recipes, platform formats
7. MCP server (all tools)
8. Access features: cookies, credentials vault (flagged), impersonation, proxy pool, geo, PO-token provider service; live `record` jobs; watches
9. Google Drive OAuth, upload (folders, packages), read-back, public-file inputs
10. Docker, nginx snippet, CI, backups, canaries; full smoke + E2E on the server

---

## 19. Open items and risks

- **Subdomain:** not needed for development (`localhost`); needed before Drive setup and deployment for `PUBLIC_BASE_URL`, the OAuth redirect URI, tus URLs, the nginx vhost and TLS certificate. Placeholder `dl.<domain>`.
- **Google Cloud project:** owner creates it; redirect URI `https://<subdomain>/oauth/google/callback`, parent domain under authorized domains, Drive API enabled, a Drive-restricted API key for public-file reads.
- **CPU budget:** ffmpeg work is CPU-bound; a small VPS will process roughly at realtime for 1080p h264 and far slower for av1/hevc/nlmeans/vmaf, and `transcribe` with large models competes for the same cores (8 dedicated vCPU / 16 GB recommended, `DEPLOY.md` §3). The cost model and queue separation keep downloads responsive, but throughput for heavy recipes is a hardware question.
- **ffmpeg build features:** the build is ours (§17), so vidstab, zimg, vmaf, rubberband and whisper are expected. The startup capability probe (`ffmpeg -filters`, `-encoders`, model files, AVX2) still reports anything missing as `FEATURE_DISABLED`. Owning the build means tracking FFmpeg, whisper.cpp and Debian security updates ourselves (monthly rebuild).
- **Source blocking:** YouTube may challenge or block the server IP even at low volume; cookies, impersonation, the PO-token provider and the proxy pool are the mitigations and are in v2 scope.
- **Legal / terms of service:** fine for personal and internal use; cookies and credential storage increase the owner's responsibility for user data; revisit before any public offering. DRM-protected content is out of scope.
- **Scope size:** v2 is several times v1. Milestones 1–5 deliver a usable product; 6–9 can ship incrementally behind the same API.
