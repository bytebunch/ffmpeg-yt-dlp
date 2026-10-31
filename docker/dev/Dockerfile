# Development and test toolbox: Node 24 + pnpm, yt-dlp (with the deno challenge solver) and the
# production ffmpeg 8.1 build copied from media-ffmpeg (docker/ffmpeg), so recipe tests run
# against the same ffmpeg as the server. This image is never deployed.
ARG FFMPEG_IMAGE=media-ffmpeg:dev
FROM ${FFMPEG_IMAGE} AS ffmpeg

FROM node:24-trixie-slim

ARG YTDLP_VERSION=2026.10.26
# The PO-token plugin; its server is the pot-provider service (same version, SPEC §7f).
ARG POT_PLUGIN_VERSION=2.0.2
ARG DENO_VERSION=2.9.8
ARG PNPM_VERSION=10.34.9

COPY --from=ffmpeg /usr/local/share/media-ffmpeg/runtime-packages.txt /tmp/ffmpeg-packages.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip git python3 python3-venv \
      fonts-dejavu-core fonts-liberation fonts-noto-core \
 && xargs -a /tmp/ffmpeg-packages.txt apt-get install -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* /tmp/ffmpeg-packages.txt
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/
# whisper.cpp's sample speech (MIT) for transcription tests.
COPY --from=ffmpeg /usr/local/share/media-ffmpeg/jfk.wav /usr/local/share/media-ffmpeg/jfk.wav

RUN python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default,curl-cffi]==${YTDLP_VERSION}" mutagen \
      "bgutil-ytdlp-pot-provider==${POT_PLUGIN_VERSION}"

RUN curl -fsSLo /tmp/deno.zip \
      "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-$(uname -m)-unknown-linux-gnu.zip" \
 && unzip -q /tmp/deno.zip -d /usr/local/bin \
 && rm /tmp/deno.zip

ENV PATH=/opt/yt-dlp/bin:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store
# Chromium for the Playwright browser tests (SPEC §16); keep equal to @playwright/test in package.json.
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app
