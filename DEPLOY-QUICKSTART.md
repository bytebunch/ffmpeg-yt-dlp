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
| Postgres, Redis | Bundled containers | `DATABASE_URL`, `REDIS_URL` (SPEC §17a) |
| Files | `/srv/media/files` on the root disk, deleted after 7 days | `MEDIA_FILES_PATH=/mnt/media-files` for a separate volume |
| Whisper models | `fast`, `balanced`, `accurate` + VAD (~920 MB) | `MODELS=fast` or `MODELS=none` |
| Secrets | Generated on first install, stored in `/srv/media/.env` | — |
| Egress firewall | On (§4.5) | — |
| Backups | Nightly database dump to `/srv/media/backups`, on the same server | Off-box copy: `DEPLOY.md` §4.10 |
| Google Drive | Off: results are delivered as signed links | `GOOGLE_*`, `DEPLOY.md` §4.7 |
| YouTube | No cookies or proxy | `DEPLOY.md` §2a |

Overrides go on the same command, e.g. `… | sudo HTTP_PORT=9000 MODELS=fast bash`. After the install, edit `/srv/media/.env` and run `docker compose up -d` in `/srv/media`.

---

## What the installer does

1. Checks the OS and CPU architecture (stops on an unsupported one) and whether the CPU has AVX2 (without it, transcription is turned off).
2. Installs Docker Engine and the compose plugin if missing, with bounded logs, IPv6 off and public DNS (§4.2).
3. Pulls the image and copies the deployment files out of it into `/srv/media` (compose file, nginx config, scripts), so the files always match the image version.
4. Creates `/srv/media/{files,inbox,models,backups}` with the right owners.
5. Writes `.env` with generated secrets. This only happens on the first run; later runs never touch `.env`.
6. Checks that the ports it publishes are free: the API on `127.0.0.1:3000` (`API_PORT`) and the bundled nginx on `HTTP_BIND:HTTP_PORT`. If another program or another project's container holds one, it stops here, names it, and tells you which setting to change in `/srv/media/.env` before running the command again.
7. Installs the egress firewall unit (§4.5).
8. Downloads the whisper models and checks their SHA-256.
9. Starts everything (`docker compose up -d`): migrations first, then the API, workers and bundled nginx. If Docker refuses, the error it printed is shown.
10. Runs the smoke test, creates the first API key and prints the summary above.

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
