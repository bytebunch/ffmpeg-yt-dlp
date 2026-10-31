import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import { ffprobe, type ProbeSummary } from '../../../src/media/ffprobe';
import { type RecipeRunResult, runRecipe } from '../../../src/recipes/run-recipe';
import { parseRecipe } from '../../../src/recipes/validate';

/** Composition with several inputs (SPEC §8d) through the production ffmpeg 8.1. */

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
};
const root = mkdtempSync(path.join(tmpdir(), 'composition-'));
const ff = (args: string) =>
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args.split(' ')], { cwd: root });
const file = (name: string) => path.join(root, name);
const [A, B, LOGO, PHOTO1, PHOTO2, MUSIC, GREEN, SUBS] = [
  'a.mp4',
  'b.mp4',
  'logo.png',
  'photo1.jpg',
  'photo2.png',
  'music.mp3',
  'green.mp4',
  'subs.mkv',
].map(file) as [string, string, string, string, string, string, string, string];

let job = 0;
async function run(inputs: string[], steps: unknown[]): Promise<RecipeRunResult> {
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
    },
    ffmpegBin: 'ffmpeg',
    ffprobeBin: 'ffprobe',
    maxCost: 5000,
    timeoutBaseMinutes: 5,
    timeoutFactor: 2,
  });
}
const out = (result: RecipeRunResult, i = 0) => result.files[i]?.paths[0] ?? '';
const probeOut = (result: RecipeRunResult, i = 0): Promise<ProbeSummary> =>
  ffprobe('ffprobe', out(result, i));
const video = (probe: ProbeSummary) =>
  probe.streams.filter((stream) => stream.type === 'video' && !stream.attached_pic);
const audio = (probe: ProbeSummary) => probe.streams.filter((stream) => stream.type === 'audio');
const mp4 = { op: 'encode', container: 'mp4' };

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the recipe to fail');
}

describe('composition on real ffmpeg 8.1', () => {
  beforeAll(() => {
    ff(
      `-f lavfi -i testsrc2=size=320x240:rate=25:duration=4 -f lavfi -i sine=frequency=440:duration=4:sample_rate=48000 -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 2 ${A}`,
    );
    ff(
      `-f lavfi -i smptebars=size=640x360:rate=30:duration=3 -f lavfi -i sine=frequency=880:duration=3:sample_rate=44100 -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 1 ${B}`,
    );
    ff(`-f lavfi -i color=c=red@0.8:size=64x32,format=rgba -frames:v 1 ${LOGO}`);
    ff(`-f lavfi -i testsrc=size=800x600 -frames:v 1 ${PHOTO1}`);
    ff(`-f lavfi -i rgbtestsrc=size=600x800 -frames:v 1 ${PHOTO2}`);
    ff(
      `-f lavfi -i sine=frequency=220:duration=6:sample_rate=44100 -c:a libmp3lame -b:a 128k ${MUSIC}`,
    );
    ff(
      `-f lavfi -i color=c=0x00FF00:size=320x240:rate=25:duration=3 -vf drawbox=x=100:y=80:w=120:h=80:color=blue:t=fill -c:v libx264 -pix_fmt yuv420p ${GREEN}`,
    );
    writeFileSync(file('subs.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello\n');
    ff(`-i ${A} -i subs.srt -map 0:v -map 0:a -map 1 -c copy -c:s srt ${SUBS}`);
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('concatenates different inputs onto one canvas, with and without a transition', async () => {
    const plain = await probeOut(await run([A, B], [{ op: 'concat' }, mp4]));
    expect(plain.duration_s).toBeCloseTo(7, 0);
    expect(video(plain)[0]).toMatchObject({ width: 320, height: 240 });
    expect(audio(plain)[0]).toMatchObject({ channels: 2, sample_rate: 48_000 });
    const faded = await probeOut(
      await run([A, B], [{ op: 'concat', transition: { type: 'dissolve', duration_s: 0.5 } }, mp4]),
    );
    expect(faded.duration_s).toBeCloseTo(6.5, 0);
  });

  it('concatenates by stream copy when the inputs match, and refuses when they do not', async () => {
    const copied = await probeOut(
      await run(
        [A, A],
        [
          { op: 'concat', mode: 'copy' },
          { op: 'encode', container: 'mp4', video: { codec: 'copy' }, audio: { codec: 'copy' } },
        ],
      ),
    );
    expect(copied.duration_s).toBeCloseTo(8, 0);
    expect((await failure(run([A, B], [{ op: 'concat', mode: 'copy' }, mp4]))).message).toMatch(
      /differs in codecs or sizes/,
    );
  });

  it('lays images over the picture: watermark, faded, tiled', async () => {
    const marked = await run(
      [A, LOGO],
      [
        {
          op: 'overlay_image',
          input: 1,
          position: 'bottom_right',
          opacity: 0.5,
          scale_pct: 20,
          start: 1,
          end: 3,
        },
        mp4,
      ],
    );
    expect(video(await probeOut(marked))[0]).toMatchObject({ width: 320, height: 240 });
    const tiled = await run(
      [A, LOGO],
      [{ op: 'overlay_image', input: 1, tile: true, margin: 40 }, mp4],
    );
    expect(video(await probeOut(tiled))[0]).toMatchObject({ width: 320 });
  });

  it('puts a second video in a corner with a border, mixing its sound', async () => {
    const result = await probeOut(
      await run(
        [A, B],
        [
          {
            op: 'overlay_video',
            input: 1,
            size_pct: 30,
            start: 0.5,
            border: { width: 2 },
            audio: 'mix',
          },
          mp4,
        ],
      ),
    );
    expect(video(result)[0]).toMatchObject({ width: 320, height: 240 });
    expect(audio(result)).toHaveLength(1);
  });

  it('stacks inputs side by side, on top of each other and in a grid', async () => {
    const horizontal = video(await probeOut(await run([A, B], [{ op: 'stack' }, mp4])))[0];
    // B (640x360) is scaled to the canvas height 240 → 426 wide.
    expect(horizontal).toMatchObject({ width: 320 + 426, height: 240 });
    const vertical = video(
      await probeOut(await run([A, B], [{ op: 'stack', layout: 'vertical', gap: 10 }, mp4])),
    )[0];
    expect(vertical).toMatchObject({ width: 320, height: 240 + 10 + 180 });
    const grid = video(
      await probeOut(
        await run(
          [A, B, A],
          [{ op: 'stack', layout: 'grid', columns: 2, background: 'white' }, mp4],
        ),
      ),
    )[0];
    expect(grid).toMatchObject({ width: 640, height: 480 });
  });

  it('keys out a green background', async () => {
    const onColor = await run([GREEN], [{ op: 'chromakey', background: { color: 'white' } }, mp4]);
    expect(video(await probeOut(onColor))[0]).toMatchObject({ width: 320, height: 240 });
    const onPhoto = await run(
      [GREEN, PHOTO1],
      [{ op: 'chromakey', background: { input: 1 } }, mp4],
    );
    expect((await probeOut(onPhoto)).duration_s).toBeCloseTo(3, 0);
  });

  it('builds slideshows with music, transitions and Ken Burns motion', async () => {
    const plain = await probeOut(
      await run(
        [PHOTO1, PHOTO2, MUSIC],
        [
          {
            op: 'slideshow',
            images: [0, 1],
            duration_each_s: 2,
            audio: 2,
            size: { width: 640, height: 360 },
          },
          mp4,
        ],
      ),
    );
    expect(plain.duration_s).toBeCloseTo(4, 0);
    expect(video(plain)[0]).toMatchObject({ width: 640, height: 360 });
    expect(audio(plain)).toHaveLength(1);
    const faded = await probeOut(
      await run(
        [PHOTO1, PHOTO2],
        [
          { op: 'slideshow', duration_each_s: 2, transition: { duration_s: 0.5 }, ken_burns: true },
          mp4,
        ],
      ),
    );
    expect(faded.duration_s).toBeCloseTo(3.5, 0);
  });

  it.each(['waveform', 'spectrum', 'bars', 'none'])(
    'turns audio into video (%s)',
    async (visual) => {
      const result = await probeOut(
        await run(
          [MUSIC],
          [{ op: 'audio_to_video', visual, size: { width: 640, height: 360 } }, mp4],
        ),
      );
      expect(video(result)[0]).toMatchObject({ width: 640, height: 360 });
      expect(result.duration_s).toBeCloseTo(6, 0);
    },
  );

  it('uses a cover picture for audio', async () => {
    const result = await probeOut(
      await run([MUSIC, PHOTO1], [{ op: 'audio_to_video', visual: 'cover', cover: 1 }, mp4]),
    );
    expect(video(result)[0]).toMatchObject({ width: 1280, height: 720 });
  });

  it('generates clips before, after or instead of the media', async () => {
    expect(
      (
        await probeOut(
          await run([A], [{ op: 'generate', kind: 'black', duration_s: 1, place: 'before' }, mp4]),
        )
      ).duration_s,
    ).toBeCloseTo(5, 0);
    expect(
      (
        await probeOut(
          await run(
            [A],
            [{ op: 'generate', kind: 'test_pattern', duration_s: 2, place: 'after' }, mp4],
          ),
        )
      ).duration_s,
    ).toBeCloseTo(6, 0);
    const tone = await probeOut(
      await run(
        [A],
        [
          { op: 'generate', kind: 'tone', duration_s: 2, frequency_hz: 440 },
          { op: 'encode', container: 'wav' },
        ],
      ),
    );
    expect(tone.streams.map((stream) => stream.type)).toEqual(['audio']);
    expect(tone.duration_s).toBeCloseTo(2, 0);
  });

  it('mixes, replaces and adds audio', async () => {
    const mixed = await probeOut(
      await run([A, MUSIC], [{ op: 'mix_audio', inputs: [1], weights: [1, 0.3], duck: {} }, mp4]),
    );
    expect(audio(mixed)).toHaveLength(1);
    expect(mixed.duration_s).toBeCloseTo(4, 0);
    const replaced = await probeOut(
      await run(
        [A, MUSIC],
        [{ op: 'replace_audio', input: 1, language: 'en' }, { op: 'trim_to_shortest' }, mp4],
      ),
    );
    expect(replaced.duration_s).toBeCloseTo(4, 0);
    // MP4 keeps ISO 639-2 codes only, so "en" is written as "eng".
    expect(audio(replaced)[0]?.language).toBe('eng');
    const twoTracks = await probeOut(
      await run(
        [A, MUSIC],
        [
          { op: 'add_audio_track', input: 1, language: 'de', default: true },
          { op: 'encode', container: 'mkv' },
        ],
      ),
    );
    expect(audio(twoTracks).map((stream) => stream.language)).toEqual([null, 'de']);
  });

  it('selects input streams and extracts single streams', async () => {
    const twoTracks = await run(
      [A, MUSIC],
      [
        { op: 'add_audio_track', input: 1 },
        { op: 'encode', container: 'mkv' },
      ],
    );
    const second = await probeOut(
      await run(
        [out(twoTracks)],
        [
          { op: 'select_streams', audio: [1] },
          { op: 'encode', container: 'mkv', video: { codec: 'copy' }, audio: { codec: 'copy' } },
        ],
      ),
    );
    expect(audio(second).map((stream) => stream.codec)).toEqual(['aac']);
    const extracted = await run(
      [SUBS],
      [
        { op: 'extract_streams', name: 'video', stream: 'video', raw: true },
        { op: 'extract_streams', name: 'audio', stream: 'audio', raw: true },
        { op: 'extract_streams', name: 'subs', stream: 'subtitle' },
      ],
    );
    expect(extracted.files.map((entry) => path.basename(entry.paths[0] ?? ''))).toEqual([
      'video.h264',
      'audio.aac',
      'subs.srt',
    ]);
    expect(extracted.files.map((entry) => entry.role)).toEqual(['media', 'audio', 'subtitles']);
  });

  it('embeds cover art in audio files', async () => {
    for (const container of ['mp3', 'm4a', 'flac']) {
      const result = await probeOut(
        await run([MUSIC, PHOTO1], [{ op: 'encode', container, cover: { input: 1 } }]),
      );
      expect(result.streams.find((stream) => stream.attached_pic)?.codec).toBe('mjpeg');
    }
    const film = await probeOut(
      await run([A, PHOTO1], [{ op: 'encode', container: 'mp4', cover: { input: 1 } }]),
    );
    expect(film.streams.map((stream) => [stream.type, stream.attached_pic])).toEqual([
      ['video', false],
      ['audio', false],
      ['video', true],
    ]);
    expect(
      (
        await failure(
          run([MUSIC, PHOTO1], [{ op: 'encode', container: 'ogg', cover: { input: 1 } }]),
        )
      ).message,
    ).toMatch(/cannot carry cover art/);
  });

  it('checks input references', async () => {
    expect((await failure(run([A], [{ op: 'overlay_image', input: 3 }, mp4]))).message).toMatch(
      /there is no input 3/,
    );
    expect(
      (await failure(run([A, MUSIC], [{ op: 'overlay_video', input: 1 }, mp4]))).message,
    ).toMatch(/has no video stream/);
  });
});
