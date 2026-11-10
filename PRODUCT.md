# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Design: static HTML/CSS prototype in `design/` (user's choice). Build: Next.js later (user agreed), with its own
server side that holds the API key and sends each signed-in member's id as `X-User-Id`; the browser never sees an
`mk_…` key (SPEC §3). Uploads go straight to `/u/` with a short-lived upload token; signed `/d/…` links go straight
to the browser.

Studio's own database (members, invites, roles, servers, the job → server map) is Supabase or plain Postgres; the same
code runs on both. Server API keys are encrypted in the application (AES-256-GCM) before they reach the database, with
the master keys in `STUDIO_ENCRYPTION_KEYS` in `.env`, which the app only reads. Servers may also be declared read-only
in `STUDIO_SERVERS` by whoever deploys Studio. The app never writes its `.env`.

## Users

Invited members (invite only; no public sign-up). Anyone OTW Design invites: creators, marketers, editors and
OTW's own team. They work on a phone as much as on a desktop: they paste a link they just found, start a
download or a conversion, and come back for the file.

## Product Purpose

OTW Studio is the web app over the media service (yt-dlp + ffmpeg, this repository). It turns a link or an
uploaded file into the file the member needs: a download in a chosen quality, a converted or edited version
through a recipe, a transcript, comments, or a recording of a live stream, delivered as a link or to Google
Drive. Success: a member goes from a pasted link to a finished file without knowing what yt-dlp or ffmpeg is.

## Positioning

One place that both fetches media from over a thousand sites and processes it with production recipes (web
MP4, social vertical, GIF preview, podcast, HLS, transcription), with jobs that run on the server while the
member does something else, and that keep following channels on their own (watches).

## Operating Context

- Paste a link → see what it is (title, length, formats, playlist size) → choose quality/preset → launch →
  follow progress (stage, percent, speed, ETA; per item for playlists) → download or send to Drive.
- Upload a file (resumable) or reuse an earlier output → apply a recipe → download.
- Watches check a channel or playlist on a schedule and download new items automatically.
- Files are kept 7 days, then deleted. A member can delete their own sooner.
- Some sites refuse the server's IP (YouTube "confirm you're not a bot", TikTok, Reddit, Vimeo login): the
  member's own cookies or site login fix it, so the app must lead there from the error.
- The server can refuse new jobs when its disk passes the quota (`STORAGE_FULL`).

## Capabilities and Constraints

- Everything in SPEC §4: info, search, transcripts, comments, probe, presets; jobs (`download`, `batch`,
  `record`, `process`, `comments`, `probe`) with items, outputs, events, log, retry, cancel; uploads (tus);
  library of outputs and the download archive; cookies, site credentials, saved recipes, watches; Google Drive.
- Job states: queued, running (stages resolving_inputs, expanding, downloading, postprocessing, processing,
  uploading, finalizing), completed, completed_with_errors, failed, cancelled, expired; record adds waiting
  and recording.
- Error codes are part of the vocabulary: `BOT_CHECK`, `LOGIN_REQUIRED`, `UNSUPPORTED_SITE`,
  `MEDIA_UNAVAILABLE`, `STORAGE_FULL`, validation errors.
- Several media servers, each with its own database (bundled Postgres or Supabase). Only admins add, change or remove
  them in Studio: name, HTTPS origin, an API key created on that server with `cli keys:create otw-studio` (no default
  user; Studio sends each member's id). A key is tested before it's saved, stored encrypted, shown afterwards only as its
  prefix, and never sent to the browser. Members pick a server; jobs, files, cookies, logins, Drive, recipes and watches
  are per server, and Studio keeps a job → server map so lists can show all servers.
- Accounts, invites and roles live in the Next.js app, not in the API. Undecided: per-member limits (none are
  designed until decided).

## Brand Commitments

- Name: **OTW Studio**, by OTW Design (otw.design).
- OTW Design's identity: hot magenta `#EC2C92`, black, white and greys; a chrome astronaut-helmet mark on
  magenta; Raleway as the text face on otw.design, Assistant for Hebrew there.
- Look: futuristic and modern (user's words: "I don't want any old design").
- Mobile first and fully responsive.
- Languages: English and Hebrew, with full right-to-left layout.

## Evidence on Hand

- Real API responses from the live server (2026-11-01/02): archive.org "Big Buck Bunny" (596 s), a Twitch clip
  download of 16,299,615 bytes, `BOT_CHECK` from YouTube, `LOGIN_REQUIRED` from Vimeo/Reddit, `STORAGE_FULL` at
  91%.
- Stills in `design/assets/media/`: frames from Blender Foundation open movies (Big Buck Bunny, Sintel, Elephants
  Dream, Caminandes: Llamigos), CC BY, taken with ffmpeg from archive.org. All sample jobs in the design are
  synthetic and labeled.
- No testimonials, customers, pricing or usage statistics exist; none may be invented.

## Product Principles

1. Link in, file out: every screen shortens the path from a pasted link or a file to the finished output.
2. Show the work: jobs run on the server, so their state, stage and progress are always visible and honest.
3. Errors lead to the fix: an error names what happened and offers the action that solves it (add cookies,
   retry, try later).
4. The phone is a first-class place to work, not a reduced desktop.

## Accessibility & Inclusion

WCAG 2.2 AA contrast and keyboard access; full RTL mirroring for Hebrew; respects reduced motion.
