#!/usr/bin/env bash
# Whisper models for `transcribe` (SPEC §8j, DEPLOY.md §2b). They live in ./models, mounted
# read-only into worker-ff at /models; the image never carries them.
#   ./models.sh list                         names, files and sizes
#   ./models.sh env fast balanced accurate   the FFMPEG_WHISPER_* lines for .env
#   ./models.sh sync /srv/media/.env         download what .env refers to, verify SHA-256
# Files are pinned by SHA-256 (taken from the Hugging Face listings); a mismatch is an error.
set -euo pipefail

models_dir=${MODELS_DIR:-$(cd "$(dirname "$0")" && pwd)/models}
container_dir=/models

# name|repository|file|bytes|sha256
CATALOG='fast|ggerganov/whisper.cpp|ggml-base-q8_0.bin|81768585|c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9
balanced|ggerganov/whisper.cpp|ggml-small-q8_0.bin|264464607|49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f
accurate|ggerganov/whisper.cpp|ggml-large-v3-turbo-q5_0.bin|574041195|394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
vad|ggml-org/whisper-vad|ggml-silero-v6.2.0.bin|885098|2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'

die() { echo "models.sh: $*" >&2; exit 1; }

entry() {  # <field: name|file> <value>: prints the catalog line
  local field=$1 value=$2 line name file
  while IFS= read -r line; do
    IFS='|' read -r name _ file _ _ <<<"$line"
    if [[ $field == name && $name == "$value" ]] || [[ $field == file && $file == "$value" ]]; then
      echo "$line"
      return 0
    fi
  done <<<"$CATALOG"
  return 1
}

cmd_list() {
  local line name repo file bytes
  while IFS= read -r line; do
    IFS='|' read -r name repo file bytes _ <<<"$line"
    printf '%-9s %-30s %5d MB  %s\n' "$name" "$file" $((bytes / 1024 / 1024)) "$repo"
  done <<<"$CATALOG"
}

cmd_env() {  # <name>...: the most accurate selected model becomes the default
  local name file json="" default=""
  for name in "$@"; do
    if [[ $name == vad ]] || ! entry name "$name" >/dev/null; then
      die "unknown model \"$name\" (fast, balanced, accurate)"
    fi
    IFS='|' read -r _ _ file _ _ <<<"$(entry name "$name")"
    json+="${json:+,}\"$name\":\"$container_dir/$file\""
    default=$name
  done
  if [[ -z $json ]]; then
    printf 'FFMPEG_WHISPER_MODELS=\nFFMPEG_WHISPER_DEFAULT_MODEL=\nFFMPEG_WHISPER_VAD_MODEL=\n'
    return
  fi
  IFS='|' read -r _ _ file _ _ <<<"$(entry name vad)"
  printf "FFMPEG_WHISPER_MODELS='{%s}'\n" "$json"
  printf 'FFMPEG_WHISPER_DEFAULT_MODEL=%s\n' "$default"
  printf 'FFMPEG_WHISPER_VAD_MODEL=%s/%s\n' "$container_dir" "$file"
}

fetch() {  # <catalog line>: downloads into models_dir unless a file of the right size is there
  local repo file bytes sha target part
  IFS='|' read -r _ repo file bytes sha <<<"$1"
  target="$models_dir/$file"
  if [[ -f $target && $(stat -c %s "$target") == "$bytes" ]]; then
    echo "ok    $file"
    return
  fi
  part="$target.part"
  echo "fetch $file ($((bytes / 1024 / 1024)) MB)"
  curl -fL --retry 3 --retry-delay 5 -o "$part" "https://huggingface.co/$repo/resolve/main/$file" </dev/null
  if [[ $(sha256sum "$part" | cut -d' ' -f1) != "$sha" ]]; then
    rm -f "$part"
    die "$file: SHA-256 does not match the pinned value"
  fi
  chmod 0644 "$part"
  mv "$part" "$target"
  echo "ok    $file"
}

cmd_sync() {  # <env file>: every /models/<file> it mentions
  local env_file=$1 file line
  [[ -f $env_file ]] || die "no such file: $env_file"
  mkdir -p "$models_dir"
  grep -E '^FFMPEG_WHISPER_(MODELS|VAD_MODEL)=' "$env_file" | grep -oE "$container_dir/[A-Za-z0-9._-]+" | sort -u |
    while IFS= read -r file; do
      line=$(entry file "${file#"$container_dir"/}") || die "$file is not in the catalog (models.sh list)"
      fetch "$line"
    done
}

case ${1:-} in
  list) cmd_list ;;
  env) shift; cmd_env "$@" ;;
  sync) [[ $# -eq 2 ]] || die "usage: models.sh sync ENV_FILE"; cmd_sync "$2" ;;
  *) die "usage: models.sh list | env NAME... | sync ENV_FILE" ;;
esac
