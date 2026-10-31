import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ffprobe, type ProbeSummary } from '../../../src/media/ffprobe';
import { FontCatalog } from '../../../src/recipes/fonts';
import { type RecipeRunResult, runRecipe } from '../../../src/recipes/run-recipe';
import { parseRecipe } from '../../../src/recipes/validate';

/** Images, sequences and packages (SPEC §8h, §8i) through the production ffmpeg 8.1. */

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
};
const root = mkdtempSync(path.join(tmpdir(), 'images-'));
const ff = (args: string) =>
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args.split(' ')], { cwd: root });
const file = (name: string) => path.join(root, name);
const [HD, SCENES, PHOTO, LOGO, ADTS] = [
  'hd.mp4',
  'scenes.mp4',
  'photo.jpg',
  'logo.png',
  'audio.aac',
].map(file) as [string, string, string, string, string];
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
      FRAMES_MAX_COUNT: 2000,
    },
    ffmpegBin: 'ffmpeg',
    ffprobeBin: 'ffprobe',
    maxCost: 5000,
    timeoutBaseMinutes: 5,
    timeoutFactor: 2,
    fonts,
    fontDir: '/usr/share/fonts',
  });
}
const out = (result: RecipeRunResult, i = 0) => result.files[i]?.paths[0] ?? '';
const probe = (target: string): Promise<ProbeSummary> => ffprobe('ffprobe', target);
const first = async (target: string) => (await probe(target)).streams[0];

describe('images and packages on real ffmpeg 8.1', () => {
  beforeAll(async () => {
    fonts = await FontCatalog.scan('/usr/share/fonts');
    ff(
      `-f lavfi -i testsrc2=size=1280x720:rate=25:duration=6 -f lavfi -i sine=frequency=440:duration=6:sample_rate=48000 -c:v libx264 -g 25 -pix_fmt yuv420p -c:a aac -ac 2 -shortest ${HD}`,
    );
    ff(
      `-f lavfi -i testsrc=size=320x240:rate=25:duration=2 -f lavfi -i smptebars=size=320x240:rate=25:duration=2 -f lavfi -i color=c=red:size=320x240:rate=25:duration=2 -filter_complex [0][1][2]concat=n=3:v=1:a=0[v] -map [v] -c:v libx264 -pix_fmt yuv420p ${SCENES}`,
    );
    ff(`-f lavfi -i testsrc=size=800x600 -frames:v 1 ${PHOTO}`);
    ff(`-f lavfi -i color=c=blue@0.5:size=64x32,format=rgba -frames:v 1 ${LOGO}`);
    ff(`-f lavfi -i sine=duration=2 -c:a aac -f adts ${ADTS}`);
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('picks thumbnails at scene changes and builds a storyboard with WebVTT', async () => {
    const scenes = await run(
      [SCENES],
      [{ op: 'thumbnails_scene', threshold: 0.3, min_gap_s: 0.5, width: 160 }],
    );
    expect(scenes.files[0]?.paths.length).toBeGreaterThanOrEqual(2);
    const board = await run(
      [HD],
      [{ op: 'storyboard', interval_s: 1, tile_width: 128, columns: 3, rows: 2 }],
    );
    const dir = out(board);
    expect(board.files[0]).toMatchObject({ directory: true, entry: 'storyboard.vtt' });
    expect(readdirSync(dir).sort()).toEqual(['sheet_001.jpg', 'storyboard.vtt']);
    const vtt = readFileSync(path.join(dir, 'storyboard.vtt'), 'utf8');
    expect(vtt).toContain('00:00:05.000 --> 00:00:06.000\nsheet_001.jpg#xywh=256,72,128,72');
    expect(await first(path.join(dir, 'sheet_001.jpg'))).toMatchObject({ width: 384, height: 144 });
  });

  it('makes animated WebP and AVIF', async () => {
    const result = await run(
      [HD],
      [
        { op: 'animated_webp', name: 'webp', end: 2, width: 320 },
        { op: 'animated_avif', name: 'avif', end: 2, width: 320 },
      ],
    );
    expect((await first(out(result, 0)))?.codec).toBe('webp');
    expect((await first(out(result, 1)))?.codec).toBe('av1');
  });

  it('exports frames zipped or one by one', async () => {
    const zipped = await run([HD], [{ op: 'frames', every_s: 2, width: 160 }]);
    expect(out(zipped)).toMatch(/frames\.zip$/);
    expect(readFileSync(out(zipped)).subarray(0, 2).toString()).toBe('PK');
    const loose = await run([HD], [{ op: 'frames', fps: 1, format: 'png', zip: false }]);
    expect(loose.files[0]?.paths.map((entry) => path.basename(entry)).slice(0, 2)).toEqual([
      'frames_001.png',
      'frames_002.png',
    ]);
  });

  it('converts, resizes and crops images', async () => {
    const converted = await run(
      [LOGO],
      [
        { op: 'image_resize', width: 32, height: 16, fit: 'stretch', upscale: true },
        { op: 'image_convert', name: 'jpg', format: 'jpg', background: 'white' },
        { op: 'image_convert', name: 'avif', format: 'avif', quality: 60 },
        { op: 'image_convert', name: 'webp', format: 'webp', lossless: true },
        { op: 'image_convert', name: 'tiff', format: 'tiff' },
      ],
    );
    expect(await first(out(converted, 0))).toMatchObject({ codec: 'mjpeg', width: 32, height: 16 });
    expect((await first(out(converted, 1)))?.codec).toBe('av1');
    expect((await first(out(converted, 2)))?.codec).toBe('webp');
    expect((await first(out(converted, 3)))?.codec).toBe('tiff');
    const cropped = await run(
      [PHOTO],
      [
        { op: 'image_crop', aspect: '1:1' },
        { op: 'image_convert', format: 'png' },
      ],
    );
    expect(await first(out(cropped))).toMatchObject({ width: 600, height: 600 });
  });

  it('turns stills into video: images_to_video and ken_burns', async () => {
    const show = await probe(
      out(
        await run(
          [PHOTO, LOGO],
          [{ op: 'images_to_video', duration_each_s: 1.5, size: { width: 640, height: 360 } }],
        ),
      ),
    );
    expect(show.duration_s).toBeCloseTo(3, 0);
    const panned = await probe(
      out(
        await run(
          [PHOTO],
          [
            { op: 'ken_burns', zoom_to: 1.5, pan: 'right', duration_s: 2 },
            { op: 'encode', container: 'mp4' },
          ],
        ),
      ),
    );
    expect(panned.duration_s).toBeCloseTo(2, 0);
  });

  it('attaches a poster frame as cover art', async () => {
    const result = await probe(
      out(
        await run(
          [HD],
          [
            { op: 'poster_frame', at: '50%' },
            { op: 'encode', container: 'mp4' },
          ],
        ),
      ),
    );
    expect(result.streams.map((stream) => [stream.type, stream.attached_pic])).toEqual([
      ['video', false],
      ['audio', false],
      ['video', true],
    ]);
  });

  it('pictures sound as images and video', async () => {
    const result = await run(
      [HD],
      [
        { op: 'audio_visual', name: 'wave', kind: 'waveform_image', split_channels: true },
        {
          op: 'audio_visual',
          name: 'spec',
          kind: 'spectrogram_image',
          size: { width: 640, height: 320 },
        },
        {
          op: 'audio_visual',
          name: 'scope',
          kind: 'vectorscope_video',
          size: { width: 320, height: 320 },
        },
      ],
    );
    expect(await first(out(result, 0))).toMatchObject({ codec: 'png', width: 1280, height: 360 });
    expect(await first(out(result, 1))).toMatchObject({ codec: 'png' });
    expect((await probe(out(result, 2))).duration_s).toBeCloseTo(6, 0);
  });

  it('packages HLS with an automatic ladder, fMP4 and MPEG-TS segments', async () => {
    const result = await run(
      [HD],
      [{ op: 'hls', segment_s: 2, ladder: 'auto', audio_only_variant: true }],
    );
    const dir = out(result);
    expect(result.files[0]).toMatchObject({
      directory: true,
      entry: 'master.m3u8',
      role: 'package',
    });
    const master = readFileSync(path.join(dir, 'master.m3u8'), 'utf8');
    // 720 source: 720, 480 and 360 variants plus audio only.
    expect(master.match(/#EXT-X-STREAM-INF/g)).toHaveLength(4);
    expect(master).toContain('RESOLUTION=1280x720');
    expect(master).toContain('RESOLUTION=640x360');
    // ffmpeg numbers the init file per variant (init_0.mp4) and the segments from 1.
    const v0 = readdirSync(path.join(dir, 'v0'));
    expect(v0).toEqual(expect.arrayContaining(['index.m3u8', 'init_0.mp4', 'segment_00001.m4s']));
    expect(readFileSync(path.join(dir, 'v0', 'index.m3u8'), 'utf8')).toContain(
      '#EXT-X-MAP:URI="init_0.mp4"',
    );
    const ts = await run(
      [HD],
      [{ op: 'hls', segment_type: 'mpegts', variants: [{ height: 360, video_bitrate_kbps: 600 }] }],
    );
    const tsFiles = readdirSync(path.join(out(ts), 'v0'));
    expect(tsFiles).toContain('index.m3u8');
    expect(tsFiles.filter((name) => name.endsWith('.ts')).length).toBeGreaterThanOrEqual(1);
  });

  it('packages DASH', async () => {
    const result = await run(
      [HD],
      [
        {
          op: 'dash',
          variants: [
            { height: 360, video_bitrate_kbps: 600 },
            { height: 240, video_bitrate_kbps: 300 },
          ],
        },
      ],
    );
    const dir = out(result);
    expect(result.files[0]).toMatchObject({ directory: true, entry: 'manifest.mpd' });
    expect(readFileSync(path.join(dir, 'manifest.mpd'), 'utf8')).toMatch(
      /<AdaptationSet[^>]*contentType="video"/,
    );
    expect(readdirSync(dir).filter((name) => name.startsWith('init-'))).toHaveLength(3);
  });

  it('writes fragmented MP4, MPEG-TS, bitstream variants and segments', async () => {
    const fragmented = await run([HD], [{ op: 'fragmented_mp4', fragment_s: 1 }]);
    expect(readFileSync(out(fragmented)).includes(Buffer.from('moof'))).toBe(true);
    const ts = await run([HD], [{ op: 'mpegts', muxrate_kbps: 3000 }]);
    expect((await probe(out(ts))).format).toBe('mpegts');
    const annexb = await run([HD], [{ op: 'bitstream', filter: 'annexb' }]);
    expect(out(annexb)).toMatch(/\.h264$/);
    expect(readFileSync(out(annexb)).subarray(0, 4).toString('hex')).toBe('00000001');
    const asc = await run([ADTS], [{ op: 'bitstream', filter: 'adts_to_asc' }]);
    expect((await probe(out(asc))).format).toContain('mp4');
    const sei = await run([HD], [{ op: 'bitstream', filter: 'remove_sei' }]);
    expect(existsSync(out(sei))).toBe(true);
    const parts = await run([HD], [{ op: 'segment', every_seconds: 2 }]);
    expect(parts.files[0]?.paths).toHaveLength(3);
  });
});
