#!/usr/bin/env bats
# models.sh: the .env lines it writes and the checks it makes before keeping a download.

setup() {
  export MODELS_DIR="$BATS_TEST_TMPDIR/models"
  export CALLS_LOG="$BATS_TEST_TMPDIR/calls.log"
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  # curl double: records the call and writes junk where a model should go.
  cat >"$BATS_TEST_TMPDIR/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$CALLS_LOG"
while [[ $# -gt 0 ]]; do
  if [[ $1 == -o ]]; then echo junk >"$2"; shift; fi
  shift
done
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/curl"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
}

@test "env: the selected models, the most accurate as default, and the VAD model" {
  run /deploy/models.sh env fast accurate
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "FFMPEG_WHISPER_MODELS='{\"fast\":\"/models/ggml-base-q8_0.bin\",\"accurate\":\"/models/ggml-large-v3-turbo-q5_0.bin\"}'" ]
  [ "${lines[1]}" = "FFMPEG_WHISPER_DEFAULT_MODEL=accurate" ]
  [ "${lines[2]}" = "FFMPEG_WHISPER_VAD_MODEL=/models/ggml-silero-v6.2.0.bin" ]
}

@test "env: no models leaves transcription off" {
  run /deploy/models.sh env
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "FFMPEG_WHISPER_MODELS=" ]
  [ "${lines[2]}" = "FFMPEG_WHISPER_VAD_MODEL=" ]
}

@test "env: refuses unknown names" {
  run /deploy/models.sh env huge
  [ "$status" -eq 1 ]
  [[ $output == *'unknown model "huge"'* ]]
}

@test "sync: keeps files of the right size without downloading" {
  /deploy/models.sh env fast >"$BATS_TEST_TMPDIR/.env"
  mkdir -p "$MODELS_DIR"
  truncate -s 81768585 "$MODELS_DIR/ggml-base-q8_0.bin"
  truncate -s 885098 "$MODELS_DIR/ggml-silero-v6.2.0.bin"
  run /deploy/models.sh sync "$BATS_TEST_TMPDIR/.env"
  [ "$status" -eq 0 ]
  [ ! -f "$CALLS_LOG" ]
}

@test "sync: a download with the wrong SHA-256 is deleted and fails" {
  /deploy/models.sh env fast >"$BATS_TEST_TMPDIR/.env"
  run /deploy/models.sh sync "$BATS_TEST_TMPDIR/.env"
  [ "$status" -eq 1 ]
  [[ $output == *"SHA-256 does not match"* ]]
  grep -q "huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q8_0.bin" "$CALLS_LOG"
  [ -z "$(ls -A "$MODELS_DIR")" ]
}

@test "sync: refuses files that are not in the catalog" {
  echo "FFMPEG_WHISPER_MODELS='{\"x\":\"/models/other.bin\"}'" >"$BATS_TEST_TMPDIR/.env"
  run /deploy/models.sh sync "$BATS_TEST_TMPDIR/.env"
  [ "$status" -eq 1 ]
  [[ $output == *"not in the catalog"* ]]
}
