#!/usr/bin/env bash
# Test double for the bundle's models.sh.
set -euo pipefail
printf 'models.sh %s\n' "$*" >>"$CALLS_LOG"
case $1 in
  env)
    shift
    if (( $# > 0 )); then
      echo "FFMPEG_WHISPER_MODELS='{\"$1\":\"/models/$1.bin\"}'"
      echo "FFMPEG_WHISPER_DEFAULT_MODEL=$1"
    else
      echo "FFMPEG_WHISPER_MODELS="
      echo "FFMPEG_WHISPER_DEFAULT_MODEL="
    fi ;;
  sync) ;;
  *) exit 1 ;;
esac
