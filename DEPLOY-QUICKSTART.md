# Media Service — Quick Deploy

One command on a fresh server. Every setting has a working default, so nothing needs configuring first. nginx with TLS, Google Drive and the rest can be added later. The full production runbook is `DEPLOY.md`.

---

## Requirements

- A fresh **Ubuntu LTS (24.04 / 26.04) or Debian 13** server, amd64, with root access and internet.
- Any size works; the installer does not check CPU, RAM or disk. 8 vCPU / 16 GB RAM is recommended for regular use (`DEPLOY.md` §3), and a small server simply runs recipes and transcriptions more slowly. Leave enough free disk for a week of outputs.
- AVX2 on the CPU for `transcribe`. Without it the installer still works and turns transcription off.

## Deploy

```bash
curl -fsSL https://raw.githubusercontent.com/bytebunch/ffmpeg-yt-dlp/main/deploy/install.sh | sudo bash
```

If the repo and images are private, pass a GitHub token with repo read and `read:packages`:

```bash
curl -fsSL -H "Authorization: token $GH_TOKEN" https://raw.githubusercontent.com/bytebunch/ffmpeg-yt-dlp/main/deploy/install.sh | sudo GH_TOKEN="$GH_TOKEN" bash
```

It takes 5–10 minutes, mostly the image pull and ~1 GB of whisper models. When it finishes:

```
Media Service <git-sha> is running

  API      http://127.0.0.1:8085/v1
  Docs     http://127.0.0.1:8085/docs
  MCP      http://127.0.0.1:8085/mcp
  API key  mk_3f9a…   ← shown once, store it now

  Config   /srv/media/.env   ← back this file up: it holds the encryption key
  Access   this server only (HTTP_BIND=127.0.0.1). To open it to other machines, either
           - set HTTP_BIND=0.0.0.0 and PUBLIC_BASE_URL in /srv/media/.env, then docker compose up -d, or
           - put your nginx in front (/srv/media/nginx/front.conf) and set PUBLIC_BASE_URL to its address.
           DEPLOY-QUICKSTART.md, "Opening it up"
```

Try it on the server:

```bash
curl -H "Authorization: Bearer <api key>" -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=<id>"}' http://127.0.0.1:8085/v1/info
```

---

## Defaults

| Setting | Default | Change it with |
|---|---|---|
| Address | `http://127.0.0.1:8085`, this server only, served by a bundled nginx container | `HTTP_BIND`, `HTTP_PORT`, `PUBLIC_BASE_URL` ("Opening it up") |
| Version | Newest build of `main`; the exact git SHA is recorded | `MEDIA_VERSION=<git-sha>` |
| Postgres, Redis | Bundled containers | Postgres: `DATABASE_URL=…` on the install command, plus `DATABASE_SSL_CA_FILE=/path/ca.pem` for Supabase (SPEC §17a); Redis: `REDIS_URL` |
| Files | `/srv/media/files` on the root disk, deleted after 7 days | `MEDIA_FILES_PATH=/mnt/media-files` for a separate volume |
| Whisper models | `fast`, `balanced`, `accurate` + VAD (~920 MB) | `MODELS=fast` or `MODELS=none` |
| Secrets | Generated on first install, stored in `/srv/media/.env` | — |
| Egress firewall | On (§4.5) | — |
| Backups | Nightly database dump to `/srv/media/backups`, on the same server | Off-box copy: `DEPLOY.md` §4.10 |
| Google Drive | Off: results are delivered as signed links | `GOOGLE_*`, `DEPLOY.md` §4.7 |
| YouTube | No cookies or proxy | `DEPLOY.md` §2a |

Overrides go on the same command, e.g. `… | sudo HTTP_PORT=9000 MODELS=fast bash`. After the install, edit `/srv/media/.env` and run `docker compose up -d` in `/srv/media`.

### On an outside database (Supabase)

Give the database on the install command. With Supabase, use the pooler's **session** address (port 5432) from Connect in the dashboard, and download its CA certificate (Database settings, SSL) to the server first:

```bash
curl -fsSL https://raw.githubusercontent.com/bytebunch/ffmpeg-yt-dlp/main/deploy/install.sh | sudo \
  DATABASE_URL='postgres://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres' \
  DATABASE_SSL_CA_FILE=/root/prod-ca-2021.crt bash
```

Percent-encode special characters in the password. TLS is verified (`verify-full`) unless you pass `DATABASE_SSL_MODE`. The installer connects and applies the migrations before anything else; if that fails it stops and names the host and the reason. The bundled Postgres is not started. Details: SPEC §17a.

---

## What the installer does

1. Checks the OS and CPU architecture (stops on an unsupported one) and whether the CPU has AVX2 (without it, transcription is turned off).
2. Installs Docker Engine and the compose plugin if missing, with bounded logs, IPv6 off and public DNS (§4.2).
3. Pulls the image and copies the deployment files out of it into `/srv/media` (compose file, nginx config, scripts), so the files always match the image version.
4. Creates `/srv/media/{files,inbox,models,backups}` with the right owners.
5. Writes `.env` with generated secrets. This only happens on the first run; later runs never touch `.env`.
6. Checks that the ports it publishes are free: the API on `127.0.0.1:3000` (`API_PORT`) and the bundled nginx on `HTTP_BIND:HTTP_PORT`. If another program or another project's container holds one, it stops here, names it, and tells you which setting to change in `/srv/media/.env` before running the command again.
7. With an outside `DATABASE_URL`, connects to it and applies the migrations. A wrong URL, password or certificate stops the install here, naming the database host and the reason (never the URL itself).
8. Installs the egress firewall unit (§4.5).
9. Downloads the whisper models and checks their SHA-256.
10. Starts everything (`docker compose up -d`): migrations first, then the API, workers and bundled nginx. If Docker refuses, the error it printed is shown.
11. Runs the smoke test, creates the first API key and prints the summary above.

Re-running the command is safe, and it is also how you update (below).

---

## Opening it up

By default nothing outside the server can reach the service: the bundled nginx listens on `127.0.0.1:8085` only. Opening it is your decision, in one of two ways. Either way, set `PUBLIC_BASE_URL` to the address clients use, because download links and upload URLs are built from it.

**Your own nginx in front (recommended).** Keep `HTTP_BIND=127.0.0.1` and point your nginx at `127.0.0.1:8085`, with TLS: see the next section.

**Directly, through `.env`.** In `/srv/media/.env`:

```
HTTP_BIND=0.0.0.0
PUBLIC_BASE_URL=http://<server-ip>:8085
```

then `cd /srv/media && docker compose up -d`. This is plain HTTP: API keys and signed links travel unencrypted, and Docker opens the port even if `ufw` blocks it. Use it on a private network or to try the service out. The same settings can go on the install command: `… | sudo HTTP_BIND=0.0.0.0 bash`.

**Under a path of an existing site.** If your nginx serves the service under a path (`https://example.com/ffmpeg/`), strip the path on the way in and put it in `PUBLIC_BASE_URL`, so links carry it:

```nginx
location /ffmpeg/ {
    proxy_pass http://127.0.0.1:8085/;   # the trailing slash strips /ffmpeg
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;                 # streams (MCP, job events, downloads)
    proxy_request_buffering off;         # tus uploads
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 0;              # the bundled proxy enforces the real limit
}
```

```
PUBLIC_BASE_URL=https://example.com/ffmpeg
```

Studio takes the same address in Settings › Servers.

**For a quick look from your own machine**, keep the defaults and use an SSH tunnel: `ssh -L 8085:127.0.0.1:8085 <server>`, then open `http://127.0.0.1:8085/docs`. Links work through the tunnel because they point at `127.0.0.1:8085`.

---

## Later: nginx and TLS

The bundled nginx keeps doing the file serving and upload handling. The host nginx only adds TLS and forwards to it.

```bash
DOMAIN=dl.example.com                                                          # your subdomain
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp /srv/media/nginx/front.conf /etc/nginx/sites-available/media.conf     # plain proxy_pass to 127.0.0.1:8085
sudo sed -i "s/dl\.example\.com/$DOMAIN/" /etc/nginx/sites-available/media.conf
sudo ln -s /etc/nginx/sites-available/media.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d "$DOMAIN" --redirect
```

Then set these in `/srv/media/.env` and run `docker compose up -d`:

```
PUBLIC_BASE_URL=https://dl.example.com
HTTP_BIND=127.0.0.1
```

`HTTP_BIND=127.0.0.1` is the default; it matters if you had set `0.0.0.0` before, because it keeps port 8085 closed to the outside, so traffic only arrives through TLS. The DNS A record for `dl.example.com` must point at the server before running certbot.

To move file serving to the host nginx itself instead of the bundled one, follow the full setup in `DEPLOY.md` §4.4.

---

## Update and roll back

```bash
curl -fsSL https://raw.githubusercontent.com/bytebunch/ffmpeg-yt-dlp/main/deploy/install.sh | sudo bash   # update to the newest build
cd /srv/media && sudo ./deploy.sh <git-sha>                                                            # pin a version or roll back
```

Previous versions are listed in `/srv/media/.release-history`. Check for running live recordings before updating, because a restart cuts them short.

---

## Windows (Docker Desktop)

On a Windows PC, `install-windows.ps1` does what `install.sh` does, with Docker Desktop running the same containers. An Intel or AMD PC runs them natively; on an ARM PC the script asks for the amd64 build, which Docker runs emulated and more slowly. Two things differ from a server:

- The database, Redis and the downloaded files live in Docker volumes, because Postgres refuses a data folder on a Windows drive.
- There is no egress firewall. The service's own guard still refuses private addresses.

**Set up**

1. Install Docker Desktop and start it. In its Settings › General, turn on **Start Docker Desktop when you sign in**. If the PC should keep serving, set Windows to never sleep.
2. Clone the repository: in GitHub Desktop, File › Clone repository › URL `https://github.com/bytebunch/ffmpeg-yt-dlp`, or `git clone`.
3. In the clone's `deploy` folder, right-click `install-windows.ps1` › **Run with PowerShell**. Or, from a PowerShell window in that folder: `powershell -ExecutionPolicy Bypass -File .\install-windows.ps1`. Windows refuses to run scripts by default, and `-ExecutionPolicy Bypass` lifts that for this one run, as Run with PowerShell does.

The script:

- checks Docker Desktop;
- writes `.env` with generated secrets, and `docker-compose.override.yml` declaring the volumes;
- downloads the whisper models (about 920 MB, checked against their SHA-256; `-Models fast` or `-Models none` for fewer);
- pulls the release your clone has checked out and starts the stack;
- checks the API answers through the bundled proxy;
- prints the first API key, once.

The service is then at `http://127.0.0.1:8085` on that PC.

Options, after that command in a PowerShell window: `-PublicUrl <address>`, `-Models fast,balanced,accurate|none`, `-Version <git SHA>`, `-HttpPort <port>`, `-ProjectName <name>`.

**Back up `.env`.** It holds the encryption key for the cookies and logins stored on the server. The other local files in `deploy` (`docker-compose.override.yml`, `models`, `backups`, `inbox`, `certs`, `.release-history`) are ignored by git, so they stay out of commits.

**Opening it up.** Put your reverse proxy in front of `127.0.0.1:8085` (see "Opening it up" above). Then give the service the address you use, so that links carry it: set `PUBLIC_BASE_URL=https://example.com/ffmpeg` in `.env` and run the script again, or in one step from a PowerShell window, `powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -PublicUrl https://example.com/ffmpeg`.

**Update.** Pull the repository (GitHub Desktop: Fetch origin, then Pull), then run `install-windows.ps1` again. It keeps `.env` and the volumes, and sets the new release. If it says no image is tagged yet, CI is still publishing that commit: wait a few minutes and run it again.

**Coming from a manual setup.** Copy `.env` and `docker-compose.override.yml` into the clone's `deploy` folder, then run the script. The data stays: it lives in Docker volumes named after the project (`media_media-pgdata` and the others), not in the folder.

**Day to day.** In Docker Desktop, Containers › **media** starts, stops and restarts the stack, and shows each container's logs. To create another API key, open Containers › media › **api** › **Exec** and type `cli keys:create <name> --quiet`.

