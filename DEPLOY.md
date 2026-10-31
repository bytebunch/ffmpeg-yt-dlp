# Media Service — Deployment

Status: **Plan** · Last updated: 2026-10-31 · Matches SPEC v2 §2, §13, §17 · One-command install with defaults: `DEPLOY-QUICKSTART.md`

This is the full production setup: host nginx serving files directly, a separate files volume, monitoring and backups. The quick deploy runs the same stack with a bundled nginx container on `127.0.0.1:8085` (this server only) and can be moved to this setup later.

Commands assume an **Ubuntu LTS (24.04 or 26.04) amd64** server. `dl.<domain>` is a placeholder until the subdomain is chosen. The code lives in `github.com/bytebunch/ffmpeg-yt-dlp` and the images in `ghcr.io/bytebunch`. The repo's `deploy/` folder is copied to `/srv/media` on the server: `docker-compose.yml`, `.env.example`, `install.sh`, `deploy.sh`, `smoke.sh`, `models.sh`, `nginx/media.conf` (vhost), `nginx/media-zones.conf` (rate-limit zones), `nginx/front.conf` (TLS front for the bundled proxy), `host/egress-firewall.sh` and `host/media-egress-firewall.service`. These are written during development; this document defines what they must do.

---

## 1. Shape of the deployment

```
GitHub ── push ──▶ Actions: lint · types · unit · integration · real-binary tests
                                   │
                                   ▼
                  ghcr.io/bytebunch/media-service:<git-sha>
                  (FROM ghcr.io/bytebunch/media-ffmpeg — ffmpeg 8.1 + whisper)
                                   │  docker compose pull
                                   ▼
 VPS ─ nginx (host, TLS) ──▶ api (127.0.0.1) ──▶ Postgres, Redis (bundled or external)
         │ X-Accel-Redirect         worker-dl · worker-ff · pot-provider · migrate · backup
         ▼
   /mnt/media-files (files volume)          /srv/media/models (whisper, read-only)
```

- **One dedicated VPS, Docker Compose, the host's nginx in front.** The server never builds anything: CI builds the images, the server pulls a tag and restarts.
- **Not suitable:** serverless (Vercel) — jobs run for minutes to hours and need ffmpeg, yt-dlp and a large disk; managed WordPress or shared hosting (Cloudways) — no Docker, no root, no nginx or firewall control; PaaS (Fly, Render, Railway) — workable, but local files served through nginx and per-GB egress billing make them costlier than a VPS. Revisit once storage moves to R2 (SPEC §15).

| Service | Role | Networks |
|---|---|---|
| nginx (host) | TLS, rate limits, proxies to `api`, serves files via X-Accel-Redirect | host |
| `api` | REST, MCP, OAuth callback, tus uploads; also runs the synchronous yt-dlp/ffprobe calls (`info`, `search`, `transcripts`, `probe`) | backend, egress |
| `worker-dl` | Download queue (yt-dlp) | backend, egress |
| `worker-ff` | ffmpeg queue, including `transcribe`; CPU and memory limits | backend, egress |
| `pot-provider` | YouTube PO-token provider | backend, egress |
| `migrate` | One-off; Drizzle migrations before anything else starts | backend |
| `backup` | Nightly `pg_dump`, 14-day retention | backend |
| `postgres`, `redis` | Bundled behind the `local-db` / `local-redis` profiles, or external (SPEC §17a) | backend |
| `proxy` | Bundled nginx (profile `proxy`): development and the quick deploy only; replaces host nginx there | backend, edge |

---

## 2. Before choosing a provider: one-day trial

Rent the cheapest hourly instance at the candidate provider, in the region you would use, run both checks, then delete it. The results decide the provider, the plan and whether a residential proxy is needed from day one.

### 2a. Does YouTube challenge this IP range?

```bash
sudo apt-get update && sudo apt-get install -y python3-venv unzip ffmpeg
curl -fsSLo /tmp/deno.zip https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip
mkdir -p ~/.local/bin && unzip -o /tmp/deno.zip -d ~/.local/bin      # yt-dlp's JS runtime for YouTube
python3 -m venv ~/ytdlp && ~/ytdlp/bin/pip install -U "yt-dlp[default,curl-cffi]"
export PATH="$HOME/.local/bin:$HOME/ytdlp/bin:$PATH"

# urls.txt: ~20 public videos — short, long, music, a Short, a finished livestream
yt-dlp --simulate --print "%(id)s ok" -a urls.txt 2>&1 | tee -a ~/trial.log
yt-dlp -f "bv*[height<=720]+ba/b" -o "dl/%(id)s.%(ext)s" "<one url from the list>"
```

Repeat hourly for a day (cron), then `grep -ci "not a bot" ~/trial.log`.

| Result | Plan |
|---|---|
| No bot checks | Start without a proxy |
| Occasional | Cookies from a dedicated Google account + the PO-token provider (already in scope) |
| Frequent | Residential proxy for YouTube from day one (`PROXY_DEFAULT_BY_EXTRACTOR`), or another provider |

### 2b. How fast is whisper on this CPU?

`transcribe` runs on the CPU, so the plan's cores decide how long a transcription takes. whisper-cli uses the same whisper.cpp library as the ffmpeg filter.

```bash
grep -o -m1 -w avx2 /proc/cpuinfo || echo "NO AVX2 — choose another plan"
sudo apt-get install -y build-essential cmake git
git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF \
  -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON
cmake --build build -j"$(nproc)"

for m in base-q8_0 small-q8_0 large-v3-turbo-q5_0; do sh ./models/download-ggml-model.sh "$m"; done
ffmpeg -i <10-minute speech recording> -ar 16000 -ac 1 -t 600 sample.wav
for m in base-q8_0 small-q8_0 large-v3-turbo-q5_0; do
  echo "$m"; ./build/bin/whisper-cli -m "models/ggml-$m.bin" -f sample.wav -t 4 -l auto 2>&1 >/dev/null | grep "total time"
done
```

Realtime factor = 600 s ÷ total time. Write the three numbers down: they set the `transcribe` weight in the cost model and confirm the CPU choice. Aim for `large-v3-turbo-q5_0` at 1× realtime or better on 4 threads; slower means more or faster cores, or defaulting long files to `balanced`. Watch peak memory in `top` during the large run.

---

## 3. Server size

| Resource | Recommended | Why |
|---|---|---|
| CPU | **8 dedicated vCPU** (fewer works, more slowly; the installer does not enforce a minimum), AVX2 | ffmpeg re-encodes 1080p h264 near realtime per 2–3 cores; each transcription uses 4 threads |
| RAM | **16 GB** | ffmpeg peaks on reverse, nlmeans and concat; plan ~2 GB per concurrent large-model transcription until §2b measures it |
| Disk | NVMe root 80 GB + separate 300–500 GB volume for files | OS, images, Postgres and models (~1 GB) on root; a full files volume must not take Postgres down |
| Network | 1 Gbps, unmetered or a generous cap | Downloads in, Drive uploads and signed links out |

Files volume size ≈ average item size × items per day × 7 days × 1.5 for temp files (50 items/day × 500 MB ≈ 260 GB). Dedicated box only: ffmpeg uses every core it is allowed, and YouTube traffic can get the IP flagged. Never co-host client sites.

---

## 4. One-time server setup

### 4.1 Base system

- SSH keys only (`PasswordAuthentication no`, `PermitRootLogin no`); a `deploy` user with sudo.
- Firewall: `ufw default deny incoming && ufw allow proto tcp to any port 22,80,443 && ufw enable`.
- `unattended-upgrades` on (default on Ubuntu); `timedatectl set-timezone UTC`.
- Swap ≈ half of RAM as headroom, `vm.swappiness=10`. The `mem_limit` on `worker-ff` is what makes the kernel kill ffmpeg instead of Postgres.

```bash
sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/90-swappiness.conf && sudo sysctl --system
```

### 4.2 Docker

Install Docker Engine and the compose plugin from Docker's apt repository ([docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/)), then `sudo usermod -aG docker deploy`.

`/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "ipv6": false,
  "live-restore": true,
  "dns": ["1.1.1.1", "9.9.9.9"]
}
```

- **Logs** are bounded (pino is verbose). **IPv6 off** because the egress rules are IPv4 only. **live-restore** keeps containers running when dockerd restarts during an upgrade.
- **Public DNS:** some providers run their resolver on a private address, which the egress filter (§4.5) would block.
- Keep Docker's default **iptables** firewall backend. The egress rules use the `DOCKER-USER` chain, which the nftables backend does not provide.

### 4.3 Disks and directories

Check `lsblk` first: `mkfs` erases the disk it is given.

```bash
sudo mkfs.ext4 -L media-files /dev/<files-volume>
echo 'LABEL=media-files /mnt/media-files ext4 defaults,noatime,nofail 0 2' | sudo tee -a /etc/fstab
sudo mkdir -p /mnt/media-files && sudo mount -a
sudo chown 10001:10001 /mnt/media-files && sudo chmod 755 /mnt/media-files
sudo mkdir -p /srv/media/{inbox,models,backups,pgdata,redis} && sudo chown -R deploy:deploy /srv/media
```

```
/srv/media/
  docker-compose.yml   .env (600)   deploy.sh   smoke.sh   models.sh   .release-history
  inbox/<client>/      read-only in api and workers
  models/              whisper models, read-only in worker-ff
  backups/             nightly dumps
  pgdata/  redis/      bundled Postgres/Redis only
/mnt/media-files/      FILES_DIR — owned by UID 10001
```

Containers run as UID 10001 with umask 022, so directories are 755 and files 644 and the host nginx user can read them. A mismatch here is the usual cause of X-Accel 403s.

### 4.4 DNS, TLS and nginx

1. A record `dl.<domain>` → server IP.
2. `sudo apt-get install -y nginx certbot python3-certbot-nginx`.
3. Copy `nginx/media-zones.conf` to `/etc/nginx/conf.d/` and `nginx/media.conf` to `sites-available` (linked from `sites-enabled`); replace the placeholder `dl.example.com` in `server_name`, and check the `API_PORT` upstream (`127.0.0.1:3000`) and `client_max_body_size` on `/u/` (`MAX_UPLOAD_SIZE_MB`). The vhost ships HTTP-only, so `sudo nginx -t && sudo systemctl reload nginx` passes before a certificate exists. Then run `sudo certbot --nginx -d dl.<domain> --redirect`, which adds TLS.
4. `PUBLIC_BASE_URL=https://dl.<domain>` in `.env`.

| Location | Settings |
|---|---|
| `/v1/`, `/oauth/`, `/docs` | Proxy to `127.0.0.1:<API_PORT>`, HTTP/1.1 keepalive, API `limit_req` zone |
| `/mcp`, `/v1/jobs/*/events` | `proxy_buffering off`, `proxy_read_timeout 3600s` |
| `/u/` (tus) | `proxy_request_buffering off`, `client_max_body_size` = `MAX_UPLOAD_SIZE_MB`, long read timeout, uploads `limit_req` zone |
| `/d/` | Proxy; the API answers with `X-Accel-Redirect` |
| `/_files/` | `internal; alias /mnt/media-files/;` — nginx handles Range and keeps the API's `Content-Disposition` |
| `/metrics`, `/health` | `allow` your IP/VPN and the uptime monitor's IPs, `deny all` |

### 4.5 Egress filtering

Every container that fetches caller-supplied URLs (api, worker-dl, worker-ff, pot-provider) reaches the internet only through the filtered `egress` network. `backend` is internal: no route out at all.

```yaml
# docker-compose.yml (excerpt)
networks:
  backend:
    internal: true
    ipam: { config: [{ subnet: 172.31.0.0/24 }] }
  egress:
    driver_opts: { com.docker.network.bridge.name: br-media-egress }
    ipam: { config: [{ subnet: 172.30.0.0/24 }] }
```

Containers talk to each other only over `backend`. The PO-token provider is addressed by an alias defined on `backend` only (`pot-backend`, the default `YTDLP_POT_PROVIDER_URL`), so its name never resolves to its egress address.

Host rules, applied by `host/egress-firewall.sh` (idempotent) from the systemd unit `media-egress-firewall.service`, which is ordered after `docker.service`:

```bash
# No private, CGNAT, link-local/cloud-metadata or multicast destinations from the egress network
iptables -I DOCKER-USER -s 172.30.0.0/24 \
  -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16,224.0.0.0/4 -j DROP
# No new connections from the egress network to the host itself (sshd, nginx, the bridge gateway).
# Replies stay allowed: nginx reaches api's published port over this bridge.
iptables -I INPUT -i br-media-egress -m conntrack --ctstate NEW -j DROP
```

The script keeps its rules in its own chains (`MEDIA-EGRESS` from `DOCKER-USER`, `MEDIA-EGRESS-HOST` from `INPUT`), lets replies through, and is safe to re-run: `media-egress-firewall apply | check | remove`. An external Postgres or Redis on a private network needs an exception, in `/etc/default/media-egress-firewall`:

```bash
EGRESS_ALLOW="10.0.0.5/32:5432 10.0.0.6/32:6379"     # CIDR[:port], space-separated
sudo systemctl restart media-egress-firewall
```

A unit is used instead of `iptables-persistent`, because saving the full ruleset also snapshots Docker's and ufw's own rules. Verify after the first `up`:

```bash
docker compose exec worker-dl node -e "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(5000)}).then(()=>console.log('REACHABLE — FIX'),()=>console.log('blocked'))"
docker compose exec worker-dl node -e "fetch('https://www.youtube.com/').then(r=>console.log(r.status))"
```

### 4.6 Secrets and `.env`

```bash
cp .env.example .env && chmod 600 .env
openssl rand -base64 32     # once each: LINK_SIGNING_SECRET, TOKEN_ENCRYPTION_KEYS (as v1:<value>)
openssl rand -hex 24        # Postgres password: hex, because it goes inside DATABASE_URL and base64's / + = would need URL-encoding
```

Keep a copy of `.env` in the password manager. Losing `TOKEN_ENCRYPTION_KEYS` makes every Drive connection, cookie jar and stored credential unreadable.

### 4.7 Google Cloud

One project; Drive API enabled; OAuth consent screen **External, published to production** (in Testing mode refresh tokens expire after 7 days); a Web application OAuth client with redirect URI `https://dl.<domain>/oauth/google/callback`; the parent domain under authorized domains; an API key restricted to the Drive API and the server's IP.

### 4.8 Whisper models

Models live outside the image, so weekly rebuilds do not re-ship ~1 GB and models can be added without a rebuild. `models.sh` downloads the pinned set and checks SHA-256:

```bash
cd /srv/media && ./models.sh
```

| Name (`model` in a recipe) | File | Size | Use |
|---|---|---|---|
| `fast` | `ggml-base-q8_0.bin` | 82 MB | Quick drafts, clear English speech |
| `balanced` | `ggml-small-q8_0.bin` | 264 MB | Long files when `accurate` is too slow |
| `accurate` (default) | `ggml-large-v3-turbo-q5_0.bin` | 574 MB | Default; the smaller models are weak outside English |
| VAD | `ggml-silero-v6.2.0.bin` | 0.9 MB | Splits audio at speech pauses for better segments |

Sources: `huggingface.co/ggerganov/whisper.cpp` and `huggingface.co/ggml-org/whisper-vad`.

```
FFMPEG_WHISPER_MODELS={"fast":"/models/ggml-base-q8_0.bin","balanced":"/models/ggml-small-q8_0.bin","accurate":"/models/ggml-large-v3-turbo-q5_0.bin"}
FFMPEG_WHISPER_DEFAULT_MODEL=accurate
FFMPEG_WHISPER_VAD_MODEL=/models/ggml-silero-v6.2.0.bin
```

### 4.9 Registry access

`docker login ghcr.io -u <github-user>` with a token limited to `read:packages`. Keep both GHCR packages private: they contain your code and GPL ffmpeg binaries.

### 4.10 Backups and monitoring

- `backup` writes nightly dumps to `/srv/media/backups` (14 days; `BACKUP_HOUR`, `BACKUP_RETENTION_DAYS`, `BACKUP_PING_URL` in `.env`). A nightly rclone cron copies them off the box, with `.env` going through an rclone **crypt** remote. Files are not backed up (7-day TTL by design).
- Restore one dump into a scratch database after the first deploy, so the backup is proven:
  ```bash
  docker compose exec backup media-backup once
  docker compose exec postgres createdb -U ytdlp_app restore_check
  docker compose exec -T postgres pg_restore -U ytdlp_app -d restore_check --no-owner <"$(ls -t backups/media-*.dump | head -1)"
  ```
- Daily canary on the server: `canary.sh` runs `smoke.sh` strictly (real download, recipe, transcription) and pings `CANARY_PING_URL`. Create its key with `docker compose exec api cli keys:create canary --default-user canary --quiet`, put it in `.env` as `CANARY_API_KEY`, then `crontab -e`: `15 5 * * * /srv/media/canary.sh >>/srv/media/canary.log 2>&1`. CI runs the same checks against YouTube daily (`.github/workflows/canary.yml`).
- External uptime check on `/health`; disk alert at 70% on `/mnt/media-files`; healthchecks.io pings from the backup job and the daily canaries (download, recipe, transcribe).

---

## 5. Images and CI

| Image | Contents | Rebuilt |
|---|---|---|
| `ghcr.io/bytebunch/media-ffmpeg:n8.1.3-w1.9.5-r<N>` | Debian trixie-slim. **FFmpeg n8.1.3 built from source** with `--enable-gpl --enable-whisper` and the SPEC §2 library set (from Debian `-dev` packages). **whisper.cpp v1.9.5**, static, CPU only: `GGML_NATIVE=OFF` with AVX2/FMA/F16C/BMI2 | On a version bump in `docker/ffmpeg/`, and monthly for Debian security updates |
| `ghcr.io/bytebunch/media-service:<git-sha>` | `FROM media-ffmpeg@sha256:…`; Node 24; yt-dlp venv (`default`, `curl-cffi`, mutagen, PO-token plugin); deno; fonts; the app. Non-root UID 10001, read-only root FS | Every push to `main`; weekly with the latest yt-dlp; manual "rebuild now" |

- **Why our own ffmpeg build:** BtbN's releases ship whisper switched off (their `50-whisper.sh` never enables it), so the BtbN download in SPEC v2 is replaced by this image.
- **Why `GGML_NATIVE=OFF`:** a native build targets the CI runner's CPU and can crash on the server with "illegal instruction". AVX2 is the baseline; §2b checks the server has it.
- **media-ffmpeg acceptance tests (CI):** `ffmpeg -buildconf` includes `--enable-whisper`; `ffmpeg -h filter=whisper` succeeds; `ffmpeg -filters` lists `vidstab*`, `zscale`, `libvmaf`, `rubberband`; transcribing whisper.cpp's `samples/jfk.wav` with the `fast` model returns "ask not what your country can do for you".
- **media-service pipeline:** lint, typecheck, unit, integration (Testcontainers), real-binary tests inside the built image, then push `:<git-sha>` and move `:main`.
- Images are `linux/amd64` only unless you develop on Apple silicon (§8).

---

## 6. Deploying a release

```
./deploy.sh <git-sha>
  1. sets IMAGE_TAG=<git-sha> in .env and appends it to .release-history
  2. docker compose pull
  3. docker compose up -d
       migrate runs first (service_completed_successfully), then api, workers, pot-provider
       workers get stop_grace_period: 5m so running jobs can finish
  4. waits for api health, then runs ./smoke.sh; on failure prints the rollback command
```

Jobs that do not finish within the grace period are marked stalled by BullMQ and retried by the new workers.

**smoke.sh** (after every deploy):
1. `GET /health` → 200.
2. `POST /v1/info` for a known URL.
3. A short download, then its signed link fetched through nginx with a `Range` header → 206.
4. A short recipe (5 s of `testsrc2` → h264).
5. `transcribe` of `jfk.wav` with `fast`.

**Rollback:** `./deploy.sh "$(tail -n 2 .release-history | head -n 1)"`.

**Migrations stay backward-compatible (expand/contract).** A release only adds columns, tables and indexes. Removals and renames ship a release later, once no running image uses the old shape. Drizzle's migrator only applies migrations newer than the last one recorded, so an older image's `migrate` step is a no-op, and rolling back the image never touches the schema.

---

## 7. Routine operations

| Task | How |
|---|---|
| Urgent yt-dlp fix | Run the rebuild workflow by hand → `./deploy.sh <new sha>` |
| ffmpeg / whisper.cpp upgrade | Bump versions in `docker/ffmpeg/`; CI builds and tests `media-ffmpeg`; update the digest in the app `Dockerfile`; deploy |
| Add a whisper model | `./models.sh <name>`; add it to `FFMPEG_WHISPER_MODELS`; `docker compose up -d worker-ff` |
| Rotate the database password | SPEC §17a |
| Rotate `TOKEN_ENCRYPTION_KEYS` | Put the new versioned key first (`v2:…,v1:…`), `docker compose up -d`, run `docker compose exec api cli secrets:reencrypt`, then remove the old key and `up -d` again |
| Disk filling up | New work is rejected above `DISK_QUOTA_PERCENT`; `du -sh /mnt/media-files/*` |
| Logs | `docker compose logs -f --since 30m api worker-dl worker-ff` |
| Restart one service | `docker compose up -d --force-recreate worker-ff` |

---

## 8. Local development

- **Windows:** keep the repo inside the WSL2 filesystem (not `/mnt/c`); Docker Desktop with the WSL backend.
- `docker compose --profile local-db --profile local-redis --profile proxy up`.
- **`proxy`** runs the same vhost snippet on plain HTTP (`PUBLIC_BASE_URL=http://localhost:8085`), so X-Accel downloads and tus uploads go through nginx exactly as in production.
- Download only the `fast` model locally.
- **Apple silicon Mac:** the images are amd64, so Docker Desktop runs them under Rosetta. This works, but ffmpeg and whisper are much slower. To develop on a Mac, add `linux/arm64` to both image builds; whisper.cpp builds for arm64 with NEON.

---

## 9. When to deploy first

SPEC §18 puts all deployment work in milestone 10. **Recommended (not yet approved):** provision the server and deploy at the end of **milestone 2**, the first point with real downloads and signed links.
- The `media-ffmpeg` image has to exist by milestone 2 anyway, because worker-dl needs ffmpeg.
- YouTube blocking, nginx file permissions and uploads through nginx only show up on the real box, and they are cheap to fix early.
- Every later milestone then ships through the same pipeline.

---

## 10. Decisions

- [x] ffmpeg: 8.1 with whisper (`transcribe` enabled), built in-house — 2026-10-31
- [x] Quick deploy: one-command `install.sh` with defaults and the bundled `proxy` nginx; host nginx + TLS added later — approved 2026-10-31
- [ ] VPS provider and plan (after the §2 trial)
- [ ] Subdomain for `dl.<domain>`
- [ ] Bundled or external Postgres/Redis
- [ ] Dedicated Google account for YouTube cookies; residential proxy from day one (§2a result)
- [ ] First deploy at milestone 2 or 10 (§9)
- [x] Development on the owner's Apple-silicon Mac in Docker Desktop, so images are built multi-arch (arm64 + amd64) — 2026-10-31
- [x] Production VPS runs Ubuntu 26.04 — 2026-10-31
- [ ] Repo and images public or private on GitHub (private: the quick-deploy command needs a token)

## 11. Spec follow-ups not yet in SPEC.md

- **Live recordings during a deploy:** `record` jobs run up to 6 hours, longer than any grace period. On SIGTERM worker-dl should stop recordings with SIGINT so yt-dlp finalises the partial file, and `deploy.sh` should warn while recordings are active.
- **`/health` exposure:** SPEC restricts it to own IPs; the uptime monitor's IPs must be allowed, or `/health` made public with a minimal body and details moved elsewhere.
- **Starting without Google:** the quickstart deploys before the Google Cloud project exists, so env validation must accept empty `GOOGLE_*` values and the Drive endpoints then return `FEATURE_DISABLED`.
