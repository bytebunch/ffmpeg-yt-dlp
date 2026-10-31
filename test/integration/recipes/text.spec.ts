import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import { ffprobe, type ProbeSummary } from '../../../src/media/ffprobe';
import { FontCatalog } from '../../../src/recipes/fonts';
import { type RecipeRunResult, runRecipe } from '../../../src/recipes/run-recipe';
import { parseRecipe } from '../../../src/recipes/validate';

/** Text, fonts and subtitles (SPEC §8f) on the production ffmpeg 8.1 with the bundled fonts. */

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
  RECIPE_MAX_TEXT_LAYERS: 8,
};
const FONT_DIR = '/usr/share/fonts';
const root = mkdtempSync(path.join(tmpdir(), 'text-'));
const ff = (args: string) =>
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args.split(' ')], { cwd: root });
const file = (name: string) => path.join(root, name);
const CLIP = file('clip.mp4');
const SRT = file('subs.srt');
const TRACKS = file('tracks.mkv');
let fonts: FontCatalog;

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
    fonts,
    fontDir: FONT_DIR,
  });
}
const out = (result: RecipeRunResult, i = 0) => result.files[i]?.paths[0] ?? '';
const probeOut = (result: RecipeRunResult, i = 0): Promise<ProbeSummary> =>
  ffprobe('ffprobe', out(result, i));
const subtitleStreams = (probe: ProbeSummary) =>
  probe.streams.filter((stream) => stream.type === 'subtitle');
/** Mean luma of the frame at `at` seconds: burned-in text makes a dark frame brighter. */
const brightness = (video: string, at: number) =>
  Number(
    /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `movie=${video},trim=start=${at},select=eq(n\\,0),signalstats`,
          '-show_entries',
          'frame_tags=lavfi.signalstats.YAVG',
          '-of',
          'default=nw=1',
        ],
        { encoding: 'utf8' },
      ),
    )?.[1] ?? 'NaN',
  );

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the recipe to fail');
}

describe('text and subtitles on real ffmpeg 8.1', () => {
  beforeAll(async () => {
    fonts = await FontCatalog.scan(FONT_DIR);
    // A black clip, so any drawn text shows up as brightness.
    ff(
      `-f lavfi -i color=c=black:size=320x240:rate=25:duration=4 -f lavfi -i sine=duration=4 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ${CLIP}`,
    );
    writeFileSync(
      SRT,
      '1\n00:00:00,000 --> 00:00:01,500\nFIRST LINE\n\n2\n00:00:02,000 --> 00:00:03,500\nSECOND LINE\n',
    );
    writeFileSync(file('de.srt'), '1\n00:00:00,500 --> 00:00:03,000\nZWEITE SPUR\n');
    ff(
      `-i ${CLIP} -i ${SRT} -i de.srt -map 0:v -map 0:a -map 1 -map 2 -c copy -c:s srt -metadata:s:s:0 language=eng -metadata:s:s:1 language=ger ${TRACKS}`,
    );
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the installed font families from their name tables', () => {
    expect(fonts.list()).toEqual(
      expect.arrayContaining(['DejaVu Sans', 'Liberation Sans', 'Noto Sans']),
    );
    expect(fonts.face('dejavu sans', { bold: true })).toMatch(/DejaVuSans-Bold\.ttf$/);
    expect(fonts.face('Noto Sans', { italic: true })).toMatch(/NotoSans-Italic\.ttf$/);
    expect(fonts.face('Comic Sans')).toBeUndefined();
  });

  it('draws text with a box, outline and shadow only inside its time window', async () => {
    const result = await run(
      [CLIP],
      [
        {
          op: 'text',
          text: 'EPISODE 12\nPart two',
          font: 'Noto Sans',
          bold: true,
          size: 40,
          position: 'center',
          box: {},
          outline: {},
          shadow: {},
          start: 1,
          end: 3,
        },
        { op: 'encode', container: 'mp4' },
      ],
    );
    expect(brightness(out(result), 0.2)).toBeLessThan(20);
    expect(brightness(out(result), 2)).toBeGreaterThan(20);
  });

  it('keeps %{…} sequences literal and refuses unknown fonts', async () => {
    const literal = await run(
      [CLIP],
      [
        { op: 'text', text: '%{eif:1/0:d} %{pts} 100%', position: 'top_left' },
        { op: 'encode', container: 'mp4' },
      ],
    );
    expect((await probeOut(literal)).duration_s).toBeCloseTo(4, 0);
    expect(
      (
        await failure(
          run(
            [CLIP],
            [
              { op: 'text', text: 'x', font: 'Comic Sans' },
              { op: 'encode', container: 'mp4' },
            ],
          ),
        )
      ).message,
    ).toMatch(/font "Comic Sans" is not installed/);
    const timecode = await run(
      [CLIP],
      [
        { op: 'text', timecode: true, position: 'bottom_right', size: 20 },
        { op: 'encode', container: 'mp4' },
      ],
    );
    expect(brightness(out(timecode), 1)).toBeGreaterThan(0.5);
  });

  it('burns subtitles from a file, styled and shifted, and from an embedded track', async () => {
    const styled = await run(
      [CLIP, SRT],
      [
        {
          op: 'subtitles_burn',
          input: 1,
          style: {
            font: 'Liberation Sans',
            size: 28,
            color: 'yellow',
            outline: 2,
            position: 'top',
            background: true,
          },
        },
        { op: 'encode', container: 'mp4' },
      ],
    );
    expect(brightness(out(styled), 0.5)).toBeGreaterThan(brightness(out(styled), 1.8));
    // Shifted by 1 s: the first line now shows at 1.5 s, which was a gap before.
    const shifted = await run(
      [CLIP, SRT],
      [
        { op: 'subtitles_burn', input: 1, shift_ms: 1000 },
        { op: 'encode', container: 'mp4' },
      ],
    );
    expect(brightness(out(shifted), 1.7)).toBeGreaterThan(brightness(out(styled), 1.7));
    const embedded = await run(
      [TRACKS],
      [
        { op: 'subtitles_burn', track: 1 },
        { op: 'encode', container: 'mp4' },
      ],
    );
    expect(brightness(out(embedded), 1)).toBeGreaterThan(1);
  });

  it('muxes subtitle tracks as the container needs them', async () => {
    const mp4 = await probeOut(
      await run(
        [CLIP, SRT],
        [
          { op: 'subtitles_mux', input: 1, language: 'en', default: true },
          { op: 'encode', container: 'mp4' },
        ],
      ),
    );
    expect(subtitleStreams(mp4).map((stream) => [stream.codec, stream.language])).toEqual([
      ['mov_text', 'eng'],
    ]);
    const mkv = await probeOut(
      await run(
        [TRACKS, SRT],
        [
          { op: 'subtitles_mux', track: 1, language: 'de' },
          { op: 'subtitles_mux', input: 1, format: 'ass' },
          { op: 'encode', container: 'mkv' },
        ],
      ),
    );
    expect(subtitleStreams(mkv).map((stream) => [stream.codec, stream.language])).toEqual([
      ['subrip', 'de'],
      ['ass', null],
    ]);
    expect(
      (
        await failure(
          run(
            [CLIP, SRT],
            [
              { op: 'subtitles_mux', input: 1 },
              { op: 'encode', container: 'mp3' },
            ],
          ),
        )
      ).message,
    ).toMatch(/cannot carry subtitles/);
  });

  it('extracts, converts, shifts and strips subtitles', async () => {
    const extracted = await run(
      [TRACKS],
      [{ op: 'subtitles_extract', name: 'subs', format: 'vtt' }],
    );
    expect(extracted.files.map((entry) => path.basename(entry.paths[0] ?? ''))).toEqual([
      'subs.eng.vtt',
      'subs.ger.vtt',
    ]);
    expect(readFileSync(out(extracted, 1), 'utf8')).toContain('ZWEITE SPUR');
    const converted = await run(
      [SRT],
      [
        { op: 'subtitles_shift', ms: 500 },
        { op: 'subtitles_convert', format: 'ass' },
      ],
    );
    expect(readFileSync(out(converted), 'utf8')).toMatch(
      /Dialogue: 0,0:00:00\.50,0:00:02\.00,.*FIRST LINE/,
    );
    const stripped = await probeOut(
      await run([TRACKS], [{ op: 'subtitles_strip' }, { op: 'remux', container: 'mkv' }]),
    );
    expect(subtitleStreams(stripped)).toEqual([]);
  });

  it('stamps times on contact sheets and renders slates', async () => {
    const sheet = await run(
      [CLIP],
      [{ op: 'contact_sheet', columns: 2, rows: 1, tile_width: 160, timestamps: true }],
    );
    expect(brightness(out(sheet), 0)).toBeGreaterThan(0.5);
    const slate = await probeOut(
      await run(
        [CLIP],
        [
          { op: 'generate', kind: 'slate', text: 'Chapter 1', duration_s: 1, place: 'before' },
          { op: 'encode', container: 'mp4' },
        ],
      ),
    );
    expect(slate.duration_s).toBeCloseTo(5, 0);
  });
});
