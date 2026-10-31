import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import { ffprobe } from '../../../src/media/ffprobe';
import { type RecipeRunResult, runRecipe } from '../../../src/recipes/run-recipe';
import { parseRecipe } from '../../../src/recipes/validate';

/** Every visual and audio operation of milestone 6 through the production ffmpeg 8.1. */

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
};
const root = mkdtempSync(path.join(tmpdir(), 'filters-'));
const ff = (args: string) =>
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args.split(' ')], { cwd: root });
const clip = path.join(root, 'clip.mp4');
const speech = path.join(root, 'speech.wav');
const hdr = path.join(root, 'hdr.mkv');

let job = 0;
async function run(input: string, steps: unknown[]): Promise<RecipeRunResult> {
  return runRecipe(
    parseRecipe({ steps }, LIMITS),
    [{ path: input, probe: await ffprobe('ffprobe', input) }],
    {
      workDir: path.join(root, `job-${job++}`),
      threads: 2,
      maxFileBytes: 512 * 1024 * 1024,
      limits: {
        REVERSE_MAX_SECONDS: 60,
        INTERPOLATE_MAX_SECONDS: 120,
        GIF_MAX_SECONDS: 30,
        MAX_MEDIA_DURATION_MINUTES: 240,
      },
      ffmpegBin: 'ffmpeg',
      ffprobeBin: 'ffprobe',
      maxCost: 5000,
      timeoutBaseMinutes: 5,
      timeoutFactor: 2,
    },
  );
}
const out = (result: RecipeRunResult) => result.files[0]?.paths[0] ?? '';
const report = (result: RecipeRunResult) =>
  result.reports[0]?.data as Record<string, number | null>;
const probeOf = (file: string) => ffprobe('ffprobe', file);

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the recipe to fail');
}

describe('visual and audio operations on real ffmpeg 8.1', () => {
  beforeAll(() => {
    ff(
      `-f lavfi -i testsrc2=size=320x240:rate=25:duration=4 -f lavfi -i sine=frequency=440:duration=4:sample_rate=48000 -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 2 -shortest ${clip}`,
    );
    // HDR10-tagged 10-bit HEVC (PQ transfer, BT.2020).
    ff(
      `-f lavfi -i testsrc2=size=320x240:rate=25:duration=2 -vf setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=yuv420p10le -c:v libx265 -x265-params log-level=error ${hdr}`,
    );
    // 1 s silence, 2 s tone, 1.5 s silence.
    ff(
      `-f lavfi -i anullsrc=r=48000:cl=mono:d=1 -f lavfi -i sine=frequency=300:duration=2:sample_rate=48000 -f lavfi -i anullsrc=r=48000:cl=mono:d=1.5 -filter_complex [0:a][1:a][2:a]concat=n=3:v=0:a=1[a] -map [a] ${speech}`,
    );
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { op: 'deinterlace' },
    { op: 'deinterlace', mode: 'yadif', double_rate: true },
    { op: 'denoise' },
    { op: 'denoise', method: 'nlmeans', strength: 'light' },
    { op: 'denoise', method: 'atadenoise' },
    { op: 'sharpen', amount: 1.2 },
    { op: 'blur', radius: 3 },
    {
      op: 'color',
      brightness: 0.05,
      contrast: 1.1,
      saturation: 1.2,
      gamma: 1.1,
      hue_deg: 10,
      temperature_k: 5500,
      vibrance: 0.3,
      exposure: 0.2,
      balance: { shadows: { r: 0.1 }, highlights: { b: -0.1 } },
      curves_preset: 'vintage',
      sepia: true,
    },
    { op: 'color', grayscale: true, invert: true },
    { op: 'vignette' },
    { op: 'grain' },
    { op: 'deband' },
    { op: 'deflicker' },
    { op: 'region_blur', x: 10, y: 10, w: 100, h: 80, start: 1, end: 3 },
    { op: 'region_pixelate', x: 0, y: 0, w: 160, h: 120 },
    { op: 'drawbox', x: 20, y: 20, w: 50, h: 50, color: '#ff0000', opacity: 0.5, thickness: 4 },
    { op: 'dedupe_frames' },
    { op: 'lens_correction', k1: -0.2, k2: 0.05 },
    { op: 'gain', db: -6 },
    { op: 'compress', preset: 'voice' },
    { op: 'compress', threshold_db: -30, ratio: 6, makeup_db: 6 },
    { op: 'limiter', ceiling_dbtp: -3 },
    { op: 'channels', layout: 'swap' },
    { op: 'channels', layout: 'surround_5_1' },
    { op: 'pitch', semitones: 3 },
    { op: 'eq', preset: 'podcast' },
    { op: 'eq', bands: [{ freq_hz: 1000, width_hz: 200, gain_db: -6 }] },
    { op: 'bass', gain_db: 6 },
    { op: 'treble', gain_db: -3 },
    { op: 'highpass', freq_hz: 200 },
    { op: 'lowpass', freq_hz: 3000, poles: 1 },
    { op: 'bandpass', freq_hz: 440 },
    { op: 'remove_hum', freq_hz: 50 },
    { op: 'denoise_audio' },
    { op: 'denoise_audio', method: 'anlmdn', strength: 'light' },
    { op: 'deesser' },
    { op: 'echo', delay_ms: [200, 400], decay: [0.5, 0.3] },
    { op: 'stereo_width', amount: 1.5 },
    { op: 'vocal_reduce' },
    { op: 'resample', rate: 44_100 },
    { op: 'audio_delay', left_ms: 20 },
    { op: 'silence_pad', start_s: 0.5, end_s: 0.5 },
    { op: 'normalize_loudness', mode: 'dynamic' },
  ])('runs %j', async (step) => {
    const result = await run(clip, [step, { op: 'encode', container: 'mp4' }]);
    expect(existsSync(out(result))).toBe(true);
    expect((await probeOf(out(result))).duration_s).toBeGreaterThan(2);
  });

  it('normalises loudness in two passes to the target', async () => {
    const result = await run(clip, [
      { op: 'gain', db: -12 },
      { op: 'normalize_loudness', target_lufs: -16 },
      { op: 'encode', container: 'mp4' },
    ]);
    const measured = await run(out(result), [{ op: 'loudness' }]);
    expect(report(measured).integrated_lufs).toBeGreaterThan(-17.5);
    expect(report(measured).integrated_lufs).toBeLessThan(-14.5);
    expect(
      (await probeOf(out(result))).streams.find((stream) => stream.type === 'audio')?.sample_rate,
    ).toBe(48_000);
  });

  it('raises the peak to a target level', async () => {
    const result = await run(clip, [
      { op: 'gain', to_peak_dbfs: -3 },
      { op: 'encode', container: 'mkv', audio: { codec: 'flac' } },
    ]);
    const measured = await run(out(result), [{ op: 'volume' }]);
    expect(report(measured).max_volume_db).toBeCloseTo(-3, 0);
  });

  it('trims leading and trailing silence', async () => {
    const both = await run(speech, [{ op: 'silence_trim' }, { op: 'encode', container: 'wav' }]);
    expect((await probeOf(out(both))).duration_s).toBeCloseTo(2, 0);
    const startOnly = await run(speech, [
      { op: 'silence_trim', end: false },
      { op: 'encode', container: 'wav' },
    ]);
    expect((await probeOf(out(startOnly))).duration_s).toBeCloseTo(3.5, 0);
  });

  it('tone-maps HDR to SDR, and refuses SDR input', async () => {
    const result = await run(hdr, [
      { op: 'tonemap', algorithm: 'mobius' },
      { op: 'encode', container: 'mp4' },
    ]);
    expect((await probeOf(out(result))).streams[0]).toMatchObject({
      codec: 'h264',
      color_transfer: 'bt709',
    });
    expect(
      (await failure(run(clip, [{ op: 'tonemap' }, { op: 'encode', container: 'mp4' }]))).message,
    ).toMatch(/needs HDR video/);
  });

  it('stabilises in two passes', async () => {
    const result = await run(clip, [
      { op: 'stabilize', shakiness: 4 },
      { op: 'encode', container: 'mp4' },
    ]);
    expect((await probeOf(out(result))).duration_s).toBeCloseTo(4, 0);
  });

  it('changes channels, tempo and streams as asked', async () => {
    const mono = await run(clip, [
      { op: 'channels', layout: 'mono' },
      { op: 'encode', container: 'm4a' },
    ]);
    expect((await probeOf(out(mono))).streams[0]?.channels).toBe(1);
    const faster = await run(speech, [
      { op: 'tempo', factor: 1.5 },
      { op: 'encode', container: 'mp3' },
    ]);
    expect((await probeOf(out(faster))).duration_s).toBeCloseTo(3, 0);
    const silent = await run(clip, [{ op: 'remove_audio' }, { op: 'encode', container: 'mp4' }]);
    expect((await probeOf(out(silent))).streams.map((stream) => stream.type)).toEqual(['video']);
    const deeper = await run(speech, [
      { op: 'pitch', semitones: -5, preserve_tempo: false },
      { op: 'encode', container: 'wav' },
    ]);
    expect((await probeOf(out(deeper))).duration_s).toBeGreaterThan(5.5);
  });

  it('stops at the shortest stream when asked', async () => {
    const longer = await run(clip, [
      { op: 'audio_offset', ms: 2000 },
      { op: 'encode', container: 'mp4' },
    ]);
    const shortest = await run(clip, [
      { op: 'audio_offset', ms: 2000 },
      { op: 'trim_to_shortest' },
      { op: 'encode', container: 'mp4' },
    ]);
    expect((await probeOf(out(longer))).duration_s).toBeGreaterThan(5.5);
    expect((await probeOf(out(shortest))).duration_s).toBeLessThan(4.5);
  });

  it('refuses audio-only changes on media with video', async () => {
    expect(
      (
        await failure(
          run(clip, [
            { op: 'tempo', factor: 2 },
            { op: 'encode', container: 'mp4' },
          ]),
        )
      ).message,
    ).toMatch(/use speed/);
    expect(
      (await failure(run(speech, [{ op: 'blur' }, { op: 'encode', container: 'wav' }]))).message,
    ).toMatch(/needs a video stream/);
  });
});
