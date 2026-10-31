#!/usr/bin/env bash
# Acceptance test for a media-ffmpeg image (DEPLOY.md §5):
#   docker/ffmpeg/test.sh <image>
# Checks the build flags, the filters and encoders the service relies on, and a real
# transcription of whisper.cpp's jfk.wav with the base model (downloaded once into a cache).
set -euo pipefail

image=${1:?usage: $0 <image>}
cache=${MODEL_CACHE:-$HOME/.cache/media-ffmpeg-models}
model=ggml-base-q8_0.bin
mkdir -p "$cache"
if [[ ! -f $cache/$model ]]; then
  curl -fsSL -o "$cache/$model.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$model"
  mv "$cache/$model.part" "$cache/$model"
fi

run() { docker run --rm -v "$cache:/models:ro" "$image" "$@"; }

fail=0
check() {  # <description> <command...>
  local description=$1
  shift
  if "$@" >/dev/null 2>&1; then echo "ok   $description"; else echo "FAIL $description"; fail=1; fi
}

buildconf=$(run ffmpeg -hide_banner -buildconf)
filters=$(run ffmpeg -hide_banner -filters)
encoders=$(run ffmpeg -hide_banner -encoders)
protocols=$(run ffmpeg -hide_banner -protocols)
check "ffmpeg 8.1"                 grep -q '^ffmpeg version n8.1' <(run ffmpeg -hide_banner -version)
check "--enable-whisper"           grep -q -- '--enable-whisper' <<<"$buildconf"
for filter in whisper vidstabdetect vidstabtransform zscale libvmaf rubberband ass subtitles drawtext loudnorm; do
  check "filter $filter"           grep -qw "$filter" <<<"$filters"
done
for encoder in libx264 libx265 libvpx-vp9 libaom-av1 libsvtav1 libopus libmp3lame libvorbis libwebp; do
  check "encoder $encoder"         grep -qw "$encoder" <<<"$encoders"
done
check "ffprobe runs"               run ffprobe -hide_banner -version
check "protocol https (GnuTLS)"   grep -qw https <<<"$protocols"

transcript=$(run sh -c "ffmpeg -nostdin -hide_banner -loglevel error -i /usr/local/share/media-ffmpeg/jfk.wav -vn \
  -af 'whisper=model=/models/$model:language=en:use_gpu=0:queue=20:format=text:destination=/tmp/out.txt' \
  -f null - && cat /tmp/out.txt")
check "whisper transcribes jfk.wav" grep -qi "ask not what your country can do for you" <<<"$transcript"

exit "$fail"
