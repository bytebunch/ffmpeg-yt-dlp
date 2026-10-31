import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import { ffprobe, type ProbeSummary } from '../../../src/media/ffprobe';
import {
  type RecipeRunOptions,
  type RecipeRunResult,
  runRecipe,
} from '../../../src/recipes/run-recipe';
import { parseRecipe } from '../../../src/recipes/validate';

/**
 * Recipes run end to end with the production ffmpeg 8.1 build (the dev toolbox copies it from
 * media-ffmpeg): composition, measurements, stages, log parsing and output collection.
 */

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
};
const root = mkdtempSync(path.join(tmpdir(), 'recipes-'));
/** Runs ffmpeg with space-separated arguments (no fixture argument contains a space). */
const ff = (args: string) =>
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args.split(' ')], { cwd: root });

interface Probed {
  format: { duration?: string; format_name?: string };
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    side_data_list?: { rotation?: number }[];
  }[];
  chapters: { start_time: string; tags?: { title?: string } }[];
}
const probeFile = (file: string): Probed =>
  JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-show_chapters',
        file,
      ],
      { encoding: 'utf8' },
    ),
  ) as Probed;
const durationOf = (file: string) => Number(probeFile(file).format.duration);
/** Media stream codecs; mp4 stores chapters in an extra data track, left out here. */
const codecsOf = (file: string) =>
  probeFile(file)
    .streams.filter((stream) => stream.codec_type !== 'data')
    .map((stream) => stream.codec_name);

let job = 0;
async function run(
  input: string,
  steps: unknown[],
  extra: Partial<RecipeRunOptions> = {},
): Promise<RecipeRunResult> {
  const workDir = path.join(root, `job-${job++}`);
  const probe: ProbeSummary = await ffprobe('ffprobe', input);
  return runRecipe(parseRecipe({ steps }, LIMITS), [{ path: input, probe }], {
    workDir,
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
    ...extra,
  });
}

const fileOf = (result: RecipeRunResult, name: string) => {
  const found = result.files.find((file) => file.name === name)?.paths[0];
  if (!found) throw new Error(`no output ${name}`);
  return found;
};
const reportOf = (result: RecipeRunResult, name: string) =>
  result.reports.find((report) => report.name === name)?.data as Record<string, unknown>;

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the recipe to fail');
}

const clip = path.join(root, 'clip.mp4');
const letterbox = path.join(root, 'letterbox.mp4');
const subtitled = path.join(root, 'subtitled.mkv');

describe('recipes on real ffmpeg 8.1', () => {
  beforeAll(() => {
    // 6 s, 320x240 @ 25 fps, a keyframe every second; black picture 2–4 s; silence 2–3.5 s; 2 chapters.
    const chapter = (start: number, title: string) =>
      `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${start}\nEND=${start + 3000}\ntitle=${title}\n`;
    writeFileSync(
      path.join(root, 'chapters.txt'),
      `;FFMETADATA1\n${chapter(0, 'First')}${chapter(3000, 'Second')}`,
    );
    const graph =
      "[0:v]drawbox=enable='between(t,2,4)':color=black:t=fill[v];[1:a]volume=enable='between(t,2,3.5)':volume=0[a]";
    ff(
      `-f lavfi -i testsrc2=size=320x240:rate=25:duration=6 -f lavfi -i sine=frequency=440:duration=6:sample_rate=48000 -i chapters.txt -filter_complex ${graph} -map [v] -map [a] -map_chapters 2 -c:v libx264 -g 25 -pix_fmt yuv420p -c:a aac -ac 2 ${clip}`,
    );
    ff(
      `-f lavfi -i testsrc2=size=320x180:rate=25:duration=3 -vf pad=320:240:0:30:black -c:v libx264 -g 25 -pix_fmt yuv420p ${letterbox}`,
    );
    writeFileSync(
      path.join(root, 'subs.srt'),
      '1\n00:00:00,500 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:05,000\nWorld\n',
    );
    // Only video and audio: the mp4 chapter track is a data stream mkv cannot copy.
    ff(`-i ${clip} -i subs.srt -map 0:v -map 0:a -map 1 -c copy -c:s srt ${subtitled}`);
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('trims, scales and encodes mp4 with the requested geometry and codecs', async () => {
    const result = await run(clip, [
      { op: 'trim', start: 1, end: 4 },
      { op: 'scale', width: 160, height: 120 },
      { op: 'encode', name: 'web', container: 'mp4' },
    ]);
    const probed = probeFile(fileOf(result, 'web'));
    expect(codecsOf(fileOf(result, 'web'))).toEqual(['h264', 'aac']);
    expect(probed.streams[0]).toMatchObject({ width: 160, height: 120 });
    expect(durationOf(fileOf(result, 'web'))).toBeCloseTo(3, 0);
    // The leading trim keeps the chapters, shifted and clipped by ffmpeg.
    expect(probed.chapters.map((chapter) => chapter.tags?.title)).toEqual(['First', 'Second']);
  });

  it('feeds several terminals from one pass', async () => {
    const result = await run(clip, [
      { op: 'encode', name: 'webm', container: 'webm', video: { crf: 40 } },
      { op: 'encode', name: 'audio', container: 'mp3', audio: { bitrate_kbps: 96 } },
      { op: 'thumbnail', name: 'poster', at: '25%', width: 160 },
      { op: 'thumbnail', name: 'strip', count: 3, format: 'png' },
      { op: 'gif', name: 'preview', start: 0, end: 2, fps: 10, width: 160 },
      { op: 'contact_sheet', name: 'sheet', columns: 3, rows: 2, tile_width: 100 },
    ]);
    expect(result.plan.stages).toHaveLength(1);
    expect(probeFile(fileOf(result, 'webm')).streams.map((stream) => stream.codec_name)).toEqual([
      'vp9',
      'opus',
    ]);
    expect(probeFile(fileOf(result, 'audio')).streams.map((stream) => stream.codec_name)).toEqual([
      'mp3',
    ]);
    expect(probeFile(fileOf(result, 'poster')).streams[0]).toMatchObject({
      codec_name: 'mjpeg',
      width: 160,
    });
    expect(
      result.files.find((file) => file.name === 'strip')?.paths.map((file) => path.basename(file)),
    ).toEqual(['strip_001.png', 'strip_002.png', 'strip_003.png']);
    expect(probeFile(fileOf(result, 'preview')).streams[0]).toMatchObject({
      codec_name: 'gif',
      width: 160,
    });
    // 3 tiles of 100 px with 4 px padding and margins.
    expect(probeFile(fileOf(result, 'sheet')).streams[0]).toMatchObject({ width: 3 * 100 + 4 * 4 });
  });

  it('reaches a target size with a two-pass encode', async () => {
    const result = await run(clip, [
      {
        op: 'encode',
        name: 'small',
        container: 'mp4',
        video: { target_size_mb: 0.25 },
        audio: { bitrate_kbps: 64 },
      },
    ]);
    expect(result.plan.stages.map((stage) => stage.label)).toEqual(['pass 1 small.mp4', 'main']);
    expect(statSync(fileOf(result, 'small')).size).toBeLessThanOrEqual(0.25 * 1024 * 1024 * 1.05);
    expect(result.warnings).toEqual([]);
  });

  it('reports loudness, volume, silence, black frames, scene changes, probe and keyframes', async () => {
    const result = await run(clip, [
      { op: 'probe', name: 'probe' },
      { op: 'keyframes', name: 'keys' },
      { op: 'loudness', name: 'loud' },
      { op: 'volume', name: 'vol' },
      { op: 'silence_detect', name: 'silence', threshold_db: -50, min_duration_s: 0.5 },
      { op: 'black_detect', name: 'black' },
      { op: 'scene_changes', name: 'scenes', threshold: 0.2 },
    ]);
    expect(result.files).toEqual([]);
    const loud = reportOf(result, 'loud');
    expect(loud.integrated_lufs).toEqual(expect.any(Number));
    expect(reportOf(result, 'vol').max_volume_db).toEqual(expect.any(Number));
    const [silence] = reportOf(result, 'silence').silences as { start_s: number; end_s: number }[];
    expect(silence?.start_s).toBeCloseTo(2, 0);
    expect(silence?.end_s).toBeCloseTo(3.5, 0);
    expect(reportOf(result, 'black').intervals).toEqual([
      expect.objectContaining({ start_s: 2, end_s: expect.closeTo(4, 1) as number }),
    ]);
    expect(
      (reportOf(result, 'scenes').scenes as { time_s: number }[]).map((scene) =>
        Math.round(scene.time_s),
      ),
    ).toEqual([2, 4]);
    const keys = reportOf(result, 'keys');
    expect(keys).toMatchObject({ count: 6, max_interval_s: 1 });
    const probed = reportOf(result, 'probe') as {
      format: Record<string, unknown>;
      chapters: unknown[];
    };
    expect(probed.format.filename).toBeUndefined();
    expect(probed.chapters).toHaveLength(2);
  });

  it('measures and removes letterboxing (crop auto)', async () => {
    const result = await run(letterbox, [
      { op: 'crop', auto: true },
      { op: 'encode', name: 'cropped', container: 'mp4' },
    ]);
    expect(probeFile(fileOf(result, 'cropped')).streams[0]).toMatchObject({
      width: 320,
      height: 180,
    });
  });

  it('changes time: speed with fades, cut_out, reverse and boomerang', async () => {
    const fast = await run(clip, [
      { op: 'speed', factor: 2 },
      { op: 'fade', in_s: 0.5, out_s: 0.5 },
      { op: 'encode', name: 'fast', container: 'mp4' },
    ]);
    expect(durationOf(fileOf(fast, 'fast'))).toBeCloseTo(3, 0);
    expect(probeFile(fileOf(fast, 'fast')).chapters).toEqual([]);
    const cut = await run(clip, [
      { op: 'cut_out', ranges: [{ start: 1, end: 2 }] },
      { op: 'encode', name: 'cut', container: 'mp4' },
    ]);
    expect(durationOf(fileOf(cut, 'cut'))).toBeCloseTo(5, 0);
    const bounce = await run(clip, [
      { op: 'trim', end: 2 },
      { op: 'reverse' },
      { op: 'boomerang', duration: 1 },
      { op: 'encode', name: 'bounce', container: 'mp4' },
    ]);
    expect(durationOf(fileOf(bounce, 'bounce'))).toBeCloseTo(2, 0);
    const looped = await run(clip, [
      { op: 'loop', count: 1 },
      {
        op: 'encode',
        name: 'twice',
        container: 'mp4',
        video: { codec: 'copy' },
        audio: { codec: 'copy' },
      },
    ]);
    expect(durationOf(fileOf(looped, 'twice'))).toBeCloseTo(12, 0);
  });

  it('rotates pixels or only the display matrix', async () => {
    const turned = await run(clip, [
      { op: 'rotate', degrees: 90 },
      { op: 'encode', name: 'turned', container: 'mp4' },
    ]);
    expect(probeFile(fileOf(turned, 'turned')).streams[0]).toMatchObject({
      width: 240,
      height: 320,
    });
    const tagged = await run(clip, [
      { op: 'rotate', degrees: 90, metadata_only: true },
      { op: 'encode', name: 'tagged', container: 'mp4', video: { codec: 'copy' } },
    ]);
    const video = probeFile(fileOf(tagged, 'tagged')).streams[0];
    expect(video).toMatchObject({ width: 320, height: 240 });
    expect(video?.side_data_list?.[0]?.rotation).toBe(-90);
  });

  it('splits by stream copy at keyframes and accurately by re-encoding', async () => {
    const copy = await run(clip, [{ op: 'split', name: 'part', every_seconds: 2 }]);
    const parts = copy.files[0]?.paths ?? [];
    expect(parts.map((file) => path.basename(file))).toEqual([
      'part_001.mp4',
      'part_002.mp4',
      'part_003.mp4',
    ]);
    expect(durationOf(parts[0] ?? '')).toBeCloseTo(2, 0);
    const accurate = await run(clip, [{ op: 'split', name: 'cut', at: [1.5], mode: 'accurate' }]);
    const pieces = accurate.files[0]?.paths ?? [];
    expect(pieces).toHaveLength(2);
    expect(durationOf(pieces[0] ?? '')).toBeCloseTo(1.5, 1);
  });

  it('remuxes subtitles only when asked to convert them, and repairs files', async () => {
    const refused = await failure(run(subtitled, [{ op: 'remux', container: 'mp4' }]));
    expect(refused.message).toMatch(/subrip/);
    const remuxed = await run(subtitled, [
      { op: 'remux', name: 'mp4', container: 'mp4', fix_incompatible: true },
    ]);
    expect(codecsOf(fileOf(remuxed, 'mp4'))).toEqual(['h264', 'aac', 'mov_text']);
    const fixed = await run(clip, [{ op: 'fix', name: 'fixed', fill_gaps: true }]);
    expect(codecsOf(fileOf(fixed, 'fixed'))).toEqual(['h264', 'aac']);
  });

  it('writes chapters and allow-listed metadata', async () => {
    const result = await run(clip, [
      {
        op: 'encode',
        name: 'tagged',
        container: 'mp4',
        metadata: { title: 'Episode 12', comment: 'Line 1\nLine 2' },
        chapters: {
          set: [
            { start: 0, end: 1, title: 'Intro; part = 1' },
            { start: 1, end: 6, title: 'Main' },
          ],
        },
      },
    ]);
    const probed = probeFile(fileOf(result, 'tagged'));
    expect(probed.chapters.map((chapter) => chapter.tags?.title)).toEqual([
      'Intro; part = 1',
      'Main',
    ]);
    const tags = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', fileOf(result, 'tagged')],
        { encoding: 'utf8' },
      ),
    ) as { format: { tags: Record<string, string> } };
    expect(tags.format.tags).toMatchObject({ title: 'Episode 12', comment: 'Line 1\nLine 2' });
  });

  it('refuses work above the cost budget before running anything', async () => {
    const error = await failure(
      run(clip, [{ op: 'encode', container: 'mkv', video: { codec: 'av1_aom', preset: 'good' } }], {
        maxCost: 0.001,
      }),
    );
    expect(error.code).toBe('RECIPE_TOO_EXPENSIVE');
  });

  it('turns ffmpeg failures into RECIPE_INVALID without server paths, and stops on cancel', async () => {
    const broken = path.join(root, 'broken.mp4');
    writeFileSync(broken, readFileSync(clip));
    const probe = await ffprobe('ffprobe', broken);
    truncateSync(broken, 2000);
    const error = await failure(
      runRecipe(
        parseRecipe({ steps: [{ op: 'encode', container: 'mp4' }] }, LIMITS),
        [{ path: broken, probe }],
        {
          workDir: path.join(root, 'broken-job'),
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
      ),
    );
    expect(error.code).toBe('RECIPE_INVALID');
    expect(error.message).not.toContain(root);
    const controller = new AbortController();
    const pending = run(
      clip,
      [
        { op: 'loop', count: 20 },
        { op: 'encode', container: 'mp4', video: { preset: 'veryslow' } },
      ],
      { signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 500);
    expect((await failure(pending)).message).toMatch(/cancelled/);
  });
});
