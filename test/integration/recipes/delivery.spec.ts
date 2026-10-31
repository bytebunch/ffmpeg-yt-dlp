import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ffprobe, type ProbeSummary } from '../../../src/media/ffprobe';
import { presetSteps } from '../../../src/recipes/presets';
import { type RecipeRunResult, runRecipe } from '../../../src/recipes/run-recipe';
import { parseRecipe } from '../../../src/recipes/validate';

/** Split modes, colour, platform formats and built-in recipes on the production ffmpeg 8.1. */

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
};
const root = mkdtempSync(path.join(tmpdir(), 'delivery-'));
const ff = (args: string) =>
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args.split(' ')], { cwd: root });
const file = (name: string) => path.join(root, name);
const [CHAPTERED, PAUSES, SCENES] = ['chaptered.mp4', 'pauses.mp4', 'scenes.mp4'].map(file) as [
  string,
  string,
  string,
];

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
const pieces = (result: RecipeRunResult) => result.files[0]?.paths ?? [];
const probe = (target: string): Promise<ProbeSummary> => ffprobe('ffprobe', target);
const tags = (target: string) =>
  JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=color_space,color_primaries,color_transfer,color_range,profile,level',
        '-of',
        'json',
        target,
      ],
      { encoding: 'utf8' },
    ),
  ) as {
    streams: Record<string, string | number>[];
  };

describe('delivery features on real ffmpeg 8.1', () => {
  beforeAll(() => {
    writeFileSync(
      file('chapters.txt'),
      ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=One\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=5000\ntitle=Two\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=6000\ntitle=Three\n',
    );
    ff(
      `-f lavfi -i testsrc2=size=320x240:rate=25:duration=6 -f lavfi -i sine=duration=6 -i chapters.txt -map 0 -map 1 -map_chapters 2 -c:v libx264 -g 25 -pix_fmt yuv420p -c:a aac -shortest ${CHAPTERED}`,
    );
    // Sound with two pauses (1.5–2.5 s and 4–5 s).
    ff(
      `-f lavfi -i testsrc2=size=320x240:rate=25:duration=6 -f lavfi -i sine=duration=6 -filter_complex [1:a]volume=enable='between(t,1.5,2.5)+between(t,4,5)':volume=0[a] -map 0:v -map [a] -c:v libx264 -g 25 -pix_fmt yuv420p -c:a aac ${PAUSES}`,
    );
    ff(
      `-f lavfi -i testsrc=size=320x240:rate=25:duration=2 -f lavfi -i smptebars=size=320x240:rate=25:duration=2 -filter_complex [0][1]concat=n=2:v=1:a=0[v] -map [v] -c:v libx264 -pix_fmt yuv420p ${SCENES}`,
    );
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('splits by chapters, by silence and by scene changes', async () => {
    const chapters = pieces(
      await run(CHAPTERED, [{ op: 'split', by_chapters: true, mode: 'accurate' }]),
    );
    expect(chapters).toHaveLength(3);
    expect((await probe(chapters[1] ?? '')).duration_s).toBeCloseTo(3, 0);
    const silences = pieces(
      await run(PAUSES, [
        { op: 'split', by_silence: { threshold_db: -50, min_silence_s: 0.5 }, mode: 'accurate' },
      ]),
    );
    expect(silences).toHaveLength(3);
    const scenes = pieces(
      await run(SCENES, [{ op: 'split', by_scene: { threshold: 0.3 }, mode: 'accurate' }]),
    );
    expect(scenes).toHaveLength(2);
  });

  it('converts and tags colour', async () => {
    const result = await run(CHAPTERED, [
      { op: 'encode', container: 'mp4', video: { color: { space: 'bt601', range: 'tv' } } },
    ]);
    expect(tags(result.files[0]?.paths[0] ?? '').streams[0]).toMatchObject({
      color_space: 'smpte170m',
      color_primaries: 'smpte170m',
      color_transfer: 'smpte170m',
      color_range: 'tv',
    });
  });

  it('formats for platforms: size, profile, level, duration cap', async () => {
    const reel = await run(CHAPTERED, [
      { op: 'platform_format', platform: 'instagram_reel', strategy: 'pad' },
      { op: 'encode', container: 'mp4' },
    ]);
    const target = reel.files[0]?.paths[0] ?? '';
    expect((await probe(target)).streams[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(tags(target).streams[0]).toMatchObject({ profile: 'High', level: 41 });
    const whatsapp = await run(CHAPTERED, [
      { op: 'platform_format', platform: 'whatsapp', strategy: 'crop' },
      { op: 'encode', container: 'mp4' },
    ]);
    expect(tags(whatsapp.files[0]?.paths[0] ?? '').streams[0]).toMatchObject({
      profile: 'Main',
      level: 31,
    });
  });

  it('runs built-in recipes end to end', async () => {
    const book = await run(CHAPTERED, presetSteps('audiobook_m4b') ?? []);
    const audiobook = book.files[0]?.paths[0] ?? '';
    expect(audiobook).toMatch(/\.m4b$/);
    expect((await probe(audiobook)).chapters).toHaveLength(3);
    expect((await probe(audiobook)).streams[0]).toMatchObject({ codec: 'aac', channels: 1 });
    const vertical = await run(CHAPTERED, presetSteps('social_vertical') ?? []);
    expect((await probe(vertical.files[0]?.paths[0] ?? '')).streams[0]).toMatchObject({
      width: 1080,
      height: 1920,
    });
    const clip = await run(CHAPTERED, presetSteps('clip', { start: 1, end: 3 }) ?? []);
    expect((await probe(clip.files[0]?.paths[0] ?? '')).duration_s).toBeCloseTo(2, 0);
    const report = await run(CHAPTERED, presetSteps('media_report') ?? []);
    expect(report.reports.map((entry) => entry.op).sort()).toEqual([
      'bitrate_timeline',
      'black_detect',
      'interlace_detect',
      'keyframes',
      'probe',
      'scene_changes',
    ]);
  });
});
