# media-service: API, workers, CLI and migrations in one image (SPEC §2, §17). Built on
# media-ffmpeg (docker/ffmpeg), which provides ffmpeg/ffprobe 8.1 with whisper.cpp.
#   docker build --build-arg FFMPEG_IMAGE=ghcr.io/<owner>/media-ffmpeg@sha256:... -t media-service .
ARG FFMPEG_IMAGE=media-ffmpeg:dev

FROM node:24-trixie-slim AS node
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./

FROM node AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM ${FFMPEG_IMAGE}
ARG YTDLP_VERSION=2026.10.26
# The PO-token plugin; its server is the pot-provider service (same version, SPEC §7f).
ARG POT_PLUGIN_VERSION=2.0.2
ARG DENO_VERSION=2.9.8
ARG GIT_SHA=unknown

# Fonts for text overlays and burned-in subtitles (SPEC §2): DejaVu, Liberation, Noto incl. CJK/Arabic.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv curl unzip \
      fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-cjk \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default,curl-cffi]==${YTDLP_VERSION}" mutagen \
      "bgutil-ytdlp-pot-provider==${POT_PLUGIN_VERSION}" \
 && curl -fsSLo /tmp/deno.zip \
      "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-$(uname -m)-unknown-linux-gnu.zip" \
 && unzip -q /tmp/deno.zip -d /usr/local/bin \
 && apt-get purge -y curl unzip && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /tmp/deno.zip

COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN useradd --uid 10001 --user-group --no-create-home --home-dir /app app \
 && mkdir -p /data/files /data/inbox \
 && chown 10001:10001 /data/files

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
COPY deploy ./deploy
COPY docker/app/cli /usr/local/bin/cli

ENV NODE_ENV=production \
    PATH=/opt/yt-dlp/bin:$PATH \
    DENO_BIN=/usr/local/bin/deno \
    FFMPEG_BIN=/usr/local/bin/ffmpeg \
    FFPROBE_BIN=/usr/local/bin/ffprobe \
    FILES_DIR=/data/files \
    INBOX_DIR=/data/inbox \
    FONT_DIR=/usr/share/fonts \
    PYTHONDONTWRITEBYTECODE=1
LABEL org.opencontainers.image.title="media-service" \
      org.opencontainers.image.revision="${GIT_SHA}"
USER 10001
EXPOSE 3000
CMD ["node", "dist/main.js"]
