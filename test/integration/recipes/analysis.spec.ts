import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import { ffprobe } from '../../../src/media/ffprobe';
import type { WhisperSetup } from '../../../src/recipes/context';
import { type RecipeRunResult, runRecipe } from '../../../src/recipes/run-recipe';
import { parseRecipe } from '../../../src/recipes/validate';

/** The full analysis set and transcribe (SPEC §8j) on the production ffmpeg 8.1. */

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
};
const MODEL = '/app/.cache/models/ggml-base-q8_0.bin';
const JFK = '/usr/local/share/media-ffmpeg/jfk.wav';
const root = mkdtempSync(path.join(tmpdir(), 'analysis-'));
const ff = (args: string) =>
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args.split(' ')], { cwd: root });
const file = (name: string) => path.join(root, name);
const [CLIP, FREEZE, LETTERBOX, INTERLACED, DUPES, WORSE] = [
  'clip.mp4',
  'freeze.mp4',
  'letterbox.mp4',
  'interlaced.mp4',
  'dupes.mp4',
  'worse.mp4',
].map(file) as [string, string, string, string, string, string];

let job = 0;
async function run(
  inputs: string[],
  steps: unknown[],
  whisper?: WhisperSetup,
): Promise<RecipeRunResult> {
  const composed = await Promise.all(
    inputs.map(async (input) => ({ path: input, probe: await ffprobe('ffprobe', input) })),
  );
  return runRecipe(parseRecipe({ steps }, LIMITS), composed, {
    workDir: path.join(root, `job-${job++}`),
    threads: 2,
    maxFileBytes: 512 * 1024 * 1024,
    limits: {
      REVERSE_MAX_SECONDS: 60,
      INTERPOLATE_MAX_SECONDS: 120,
      GIF_MAX_SECONDS: 30,
      MAX_MEDIA_DURATION_MINUTES: 240,
      FRAMES_MAX_COUNT: 2000,
    },
    ffmpegBin: 'ffmpeg',
    ffprobeBin: 'ffprobe',
    maxCost: 5000,
    timeoutBaseMinutes: 5,
    timeoutFactor: 2,
    whisper,
  });
}
const report = (result: RecipeRunResult, name: string) =>
  result.reports.find((entry) => entry.name === name)?.data as Record<string, unknown>;

describe('analysis on real ffmpeg 8.1', () => {
  beforeAll(() => {
    ff(
      `-f lavfi -i testsrc2=size=320x240:rate=25:duration=4 -f lavfi -i sine=frequency=440:duration=4:sample_rate=48000 -c:v libx264 -g 25 -pix_fmt yuv420p -c:a aac -ac 2 -shortest ${CLIP}`,
    );
    // Moving 0–2 s, a still frame 2–4 s, moving again 4–6 s.
    ff(
      `-f lavfi -i testsrc2=size=320x240:rate=25:duration=2 -f lavfi -i testsrc2=size=320x240:rate=25:duration=2 -filter_complex [0]tpad=stop_mode=clone:stop_duration=2[a];[a][1]concat=n=2:v=1:a=0[v] -map [v] -c:v libx264 -pix_fmt yuv420p ${FREEZE}`,
    );
    ff(
      `-f lavfi -i testsrc2=size=320x180:rate=25:duration=2 -vf pad=320:240:0:30:black -c:v libx264 -pix_fmt yuv420p ${LETTERBOX}`,
    );
    ff(
      `-f lavfi -i testsrc2=size=320x240:rate=50:duration=2 -vf tinterlace=mode=interleave_top,setfield=tff -c:v libx264 -flags +ilme+ildct -pix_fmt yuv420p ${INTERLACED}`,
    );
    ff(
      `-f lavfi -i testsrc2=size=320x240:rate=5:duration=4 -vf fps=25 -c:v libx264 -pix_fmt yuv420p ${DUPES}`,
    );
    ff(`-i ${CLIP} -c:v libx264 -crf 45 -an ${WORSE}`);
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds frozen pictures, letterboxing and interlacing', async () => {
    const freeze = await run([FREEZE], [{ op: 'freeze_detect', name: 'freeze', duration_s: 1 }]);
    const [frozen] = report(freeze, 'freeze').freezes as { start_s: number; duration_s: number }[];
    expect(frozen?.start_s).toBeCloseTo(2, 0);
    expect(frozen?.duration_s).toBeCloseTo(2, 0);
    const crop = await run([LETTERBOX], [{ op: 'crop_detect', name: 'crop' }]);
    expect(report(crop, 'crop')).toMatchObject({
      crop: { w: 320, h: 180, x: 0, y: 30 },
      filter: 'crop=320:180:0:30',
    });
    const idet = await run([INTERLACED], [{ op: 'interlace_detect', name: 'idet' }]);
    expect(report(idet, 'idet').verdict).toBe('interlaced_tff');
    const progressive = await run([CLIP], [{ op: 'interlace_detect', name: 'idet' }]);
    expect(report(progressive, 'idet').verdict).toBe('progressive');
  });

  it('counts duplicate frames', async () => {
    const result = await run([DUPES], [{ op: 'duplicate_frames', name: 'dupes' }]);
    expect(report(result, 'dupes')).toMatchObject({ total_frames: 100 });
    expect(report(result, 'dupes').duplicate_ratio).toBeGreaterThan(0.7);
  });

  it('compares quality against a reference with VMAF, PSNR and SSIM', async () => {
    const result = await run([WORSE, CLIP], [{ op: 'quality_compare', name: 'q', reference: 1 }]);
    const quality = report(result, 'q') as Record<string, { mean: number; frames: number[] }>;
    expect(quality.vmaf?.mean).toBeGreaterThan(0);
    expect(quality.vmaf?.mean).toBeLessThan(99);
    expect(quality.vmaf?.frames).toHaveLength(100);
    expect(quality.psnr?.mean).toBeGreaterThan(15);
    expect(quality.ssim?.mean).toBeLessThan(1);
    const same = report(
      await run(
        [CLIP, CLIP],
        [{ op: 'quality_compare', name: 'q', reference: 1, metrics: ['psnr'] }],
      ),
      'q',
    ) as Record<string, { mean: number }>;
    // Identical frames: infinite PSNR reported as 100 dB.
    expect(same.psnr?.mean).toBe(100);
  });

  it('hashes content, frames, audio peaks and bitrate', async () => {
    const result = await run(
      [CLIP],
      // One hash per recipe: reports are matched to their analysis by type.
      [
        { op: 'hash', name: 'hash' },
        { op: 'frame_hashes', name: 'frames' },
        { op: 'peaks', name: 'peaks', per_second: 10 },
        { op: 'bitrate_timeline', name: 'rate' },
      ],
    );
    expect(report(result, 'hash').hash).toMatch(/^[0-9a-f]{64}$/);
    expect(report(result, 'frames')).toMatchObject({ count: 100 });
    expect((report(result, 'frames').frames as { hash: string }[])[0]?.hash).toMatch(
      /^[0-9a-f]{32}$/,
    );
    const peaks = report(result, 'peaks').peaks as number[];
    expect(peaks.length).toBeGreaterThanOrEqual(38);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(1);
    expect(Math.max(...peaks)).toBeGreaterThan(0.05);
    expect((report(result, 'rate').points as unknown[]).length).toBe(4);
    const perStream = await run(
      [CLIP],
      [{ op: 'hash', name: 'streams', per_stream: true, algorithm: 'md5' }],
    );
    expect(
      (report(perStream, 'streams').streams as { type: string; hash: string }[]).map(
        (entry) => entry.type,
      ),
    ).toEqual(['v', 'a']);
  });

  it.skipIf(!existsSync(MODEL))(
    'transcribes speech with whisper.cpp into SRT, WebVTT, JSON and text',
    async () => {
      const whisper: WhisperSetup = { models: { fast: MODEL }, defaultModel: 'fast' };
      const result = await run(
        [JFK],
        [
          { op: 'transcribe', name: 'srt', language: 'en', format: 'srt' },
          { op: 'transcribe', name: 'vtt', language: 'en', format: 'vtt' },
          { op: 'transcribe', name: 'txt', language: 'en', format: 'txt', vad: false },
        ],
        whisper,
      );
      const [srt, vtt, txt] = result.files.map((entry) =>
        readFileSync(entry.paths[0] ?? '', 'utf8'),
      );
      expect(srt).toMatch(/00:00:\d\d,\d{3} --> /);
      expect(srt?.toLowerCase()).toContain('ask not what your country can do for you');
      expect(vtt?.startsWith('WEBVTT')).toBe(true);
      expect(txt?.toLowerCase()).toContain('ask not');
      expect(result.files.map((entry) => entry.role)).toEqual(['subtitles', 'subtitles', 'report']);
    },
  );

  it('refuses transcribe when whisper is unavailable or the model is unknown', async () => {
    const off = await run([JFK], [{ op: 'transcribe' }], {
      disabled: 'this ffmpeg build has no whisper filter',
      models: {},
    }).catch((error: unknown) => error);
    expect(off).toBeInstanceOf(AppError);
    expect((off as AppError).code).toBe('FEATURE_DISABLED');
    const unknown = await run([JFK], [{ op: 'transcribe', model: 'huge' }], {
      models: { fast: MODEL },
    }).catch((error: unknown) => error);
    expect((unknown as AppError).message).toMatch(/unknown model "huge"/);
  });
});
