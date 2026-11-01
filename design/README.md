# OTW Studio: design prototype

Static HTML/CSS for the OTW Studio web app, the front end for the media service in this repository. It is the
design reference for the Next.js build; nothing here calls the API.

Open `index.html` (the app) or `signin.html` in a browser. No build step. Fonts load from Google Fonts.

- Theme: sun/moon button in the sidebar, or More → Light or dark on phones (dark is the default). Language: globe
  button (English / Hebrew, right to left).
- Phone layout below 1024 px (top bar, bottom tabs, More sheet); sidebar from 1024 px; In flight column from 1280 px.
- Press **Launch** on the Launch screen to see a job dock into In flight and run through its stages.
- Sign-in states: `signin.html#signin`, `#invite`, `#reset`, `#error`.
- Servers: the chip in the top bar (sidebar switch on desktop) picks the member's server; Settings → Servers is the
  admin page. Its "Prototype states" links show each connection-test result.

All jobs, files, people and comments are sample data (flagged "Sample data" in the UI). Hebrew covers the shell,
Launch and sign-in; the other screens show their mirrored layout with English text until the Next.js i18n.

## Screens and the API behind them

| Screen | Route | API (SPEC §4) |
|---|---|---|
| Launch: composer, preview, quality, options | `#launch` | `POST /v1/info`, `GET /v1/presets`, `POST /v1/jobs` (`download`, `batch`, `record`) |
| In flight, Jobs | `#launch`, `#jobs` | `GET /v1/jobs`, `GET /v1/jobs/:id/events` (SSE) |
| Job detail: items, files, log, details | `#job` | `GET /v1/jobs/:id`, `…/items`, `…/outputs`, `…/log`, `POST …/retry`, `DELETE /v1/jobs/:id`, `/d/job/:id.zip`, `.m3u` |
| Tools: upload, probe, recipes | `#tools` | `POST /v1/uploads` + tus `/u/:id`, `POST /v1/probe`, `GET /v1/recipes`, `POST /v1/jobs` (`process`) |
| Library: files, download archive | `#library` | `GET /v1/outputs`, `GET/POST/DELETE /v1/archive` |
| Watches | `#watches` | `/v1/watches`, `PATCH /v1/watches/:id`, `GET /v1/watches/:id/runs` |
| Search | `#search` | `GET /v1/search` |
| Transcripts | `#transcripts` | `POST /v1/transcripts`; Whisper via a `process` job |
| Comments | `#comments` | `POST /v1/comments` |
| Settings: cookies, site logins, Drive, recipes | `#settings` | `/v1/cookies`, `/v1/credentials/:site`, `/v1/drive/*`, `PUT /v1/recipes/:name` |
| Servers (admins): add, test, replace key, remove; server switcher | `#settings`, the chip / sidebar switch | Next.js app only; it calls each server with that server's key (a test call before saving) |
| Members, sign-in, invites | `#settings`, `signin.html` | Next.js app only (accounts are not in the API) |

Error designs map to the API's codes: `BOT_CHECK` and `LOGIN_REQUIRED` lead to Cookies or Site logins,
`MEDIA_UNAVAILABLE` offers a retry, `STORAGE_FULL` pauses new jobs.

## Credits

Stills in `assets/media/` are frames from Blender Foundation open movies, CC BY (blender.org): *Big Buck Bunny*
(2008), *Elephants Dream* (2006), *Sintel* (2010), *Caminandes: Llamigos* (2016). Taken with ffmpeg from the
archive.org copies.
