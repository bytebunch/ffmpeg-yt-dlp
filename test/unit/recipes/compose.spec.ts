import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors';
import type { ProbeSummary, StreamSummary } from '../../../src/media/ffprobe';
import { type ComposeOptions, compose, type Plan, type Stage } from '../../../src/recipes/compose';
import { parseRecipe } from '../../../src/recipes/validate';

const LIMITS = {
  RECIPE_MAX_STEPS: 25,
  RECIPE_MAX_OUTPUTS: 10,
  MAX_FILE_SIZE_MB: 4096,
  GIF_MAX_SECONDS: 30,
};
const OPTIONS: ComposeOptions = {
  workDir: '/work/job',
  threads: 4,
  maxFileBytes: 4096 * 1024 * 1024,
  limits: {
    REVERSE_MAX_SECONDS: 60,
    INTERPOLATE_MAX_SECONDS: 120,
    GIF_MAX_SECONDS: 30,
    MAX_MEDIA_DURATION_MINUTES: 240,
  },
  measurements: {},
};

const stream = (values: Partial<StreamSummary>): StreamSummary => ({
  type: 'video',
  codec: 'h264',
  width: null,
  height: null,
  fps: null,
  channels: null,
  sample_rate: null,
  bit_rate: null,
  language: null,
  attached_pic: false,
  color_transfer: null,
  ...values,
});

const VIDEO: ProbeSummary = {
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration_s: 120,
  size_bytes: 10_000_000,
  bit_rate: 600_000,
  streams: [
    stream({ type: 'video', codec: 'h264', width: 1920, height: 1080, fps: 30 }),
    stream({ type: 'audio', codec: 'aac', channels: 2, sample_rate: 48_000 }),
  ],
};
const AUDIO: ProbeSummary = {
  ...VIDEO,
  format: 'mp3',
  streams: [
    stream({ type: 'audio', codec: 'mp3', sample_rate: 44_100 }),
    stream({ type: 'video', codec: 'mjpeg', attached_pic: true }),
  ],
};

function plan(steps: unknown[], probe = VIDEO, options: Partial<ComposeOptions> = {}): Plan {
  const result = compose(parseRecipe({ steps }, LIMITS), [{ path: '/data/in.mp4', probe }], {
    ...OPTIONS,
    ...options,
  });
  if (result.kind !== 'plan')
    throw new Error(`expected a plan, got a ${result.stage.label} measurement`);
  return result.plan;
}

const main = (result: Plan): Stage => {
  const stage = result.stages.at(-1);
  if (!stage) throw new Error('no stages');
  return stage;
};
const graphOf = (stage: Stage) => stage.args[stage.args.indexOf('-filter_complex') + 1] ?? '';
const beforeInput = (stage: Stage) => stage.args.slice(0, stage.args.indexOf('-i'));

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

const mp4 = { op: 'encode', container: 'mp4' };

describe('compose', () => {
  it('encodes with safe defaults: input restricted to files, size cap, faststart, threads', () => {
    const stage = main(plan([{ ...mp4, name: 'web' }]));
    expect(stage.tool).toBe('ffmpeg');
    expect(stage.args).toEqual(
      expect.arrayContaining([
        '-protocol_whitelist',
        'file',
        '-i',
        '/data/in.mp4',
        '-c:v',
        'libx264',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
      ]),
    );
    expect(stage.args.join(' ')).toContain(`-fs ${4096 * 1024 * 1024}`);
    expect(stage.args.at(-1)).toBe('/work/job/out/web.mp4');
    expect(stage.args).not.toContain('-filter_complex');
  });

  it('turns a leading trim into input seeking and a later trim into filters', () => {
    const leading = main(plan([{ op: 'trim', start: 5, end: 20 }, mp4]));
    expect(beforeInput(leading)).toEqual(expect.arrayContaining(['-ss', '5', '-t', '15']));
    const later = main(
      plan([{ op: 'scale', height: 720 }, { op: 'trim', start: 5, end: 20 }, mp4]),
    );
    expect(graphOf(later)).toContain('trim=start=5:duration=15,setpts=PTS-STARTPTS');
    expect(graphOf(later)).toContain('atrim=start=5:duration=15');
    expect(
      errorOf(() =>
        plan([{ op: 'scale', height: 720 }, { op: 'trim', start: 1, mode: 'copy' }, mp4]),
      ).message,
    ).toMatch(/first step/);
  });

  it('splits a filtered stream once per consumer', () => {
    const stage = main(
      plan([
        { op: 'scale', height: 720 },
        mp4,
        { ...mp4, container: 'webm' },
        { op: 'thumbnail', at: 10 },
      ]),
    );
    expect(graphOf(stage)).toMatch(/\[v0\]split=3\[v0r0\]\[v0r1\]\[v0r2\]/);
    expect(stage.args.filter((arg) => arg === '-map').length).toBeGreaterThanOrEqual(5);
  });

  it('keeps stream copy for untouched streams and refuses it after filters', () => {
    const copy = main(
      plan([
        { op: 'trim', start: 1, end: 3, mode: 'copy' },
        { ...mp4, video: { codec: 'copy' }, audio: { codec: 'copy' } },
      ]),
    );
    expect(copy.args).toEqual(
      expect.arrayContaining(['-map', '0:V:0', '-c:v', 'copy', '-map', '0:a:0', '-c:a', 'copy']),
    );
    expect(
      errorOf(() =>
        plan([
          { op: 'scale', height: 720 },
          { ...mp4, video: { codec: 'copy' } },
        ]),
      ).message,
    ).toMatch(/copy cannot follow filters/);
    expect(
      errorOf(() =>
        plan([
          { op: 'trim', start: 1 },
          { ...mp4, video: { codec: 'copy' } },
        ]),
      ).message,
    ).toMatch(/keyframes/);
    expect(
      errorOf(() => plan([{ op: 'encode', container: 'webm', video: { codec: 'copy' } }])).message,
    ).toMatch(/webm cannot hold the input's h264/);
  });

  it('knows which streams the input has', () => {
    expect(errorOf(() => plan([{ op: 'scale', height: 720 }, mp4], AUDIO)).message).toMatch(
      /needs a video stream/,
    );
    const audioOnly = main(plan([{ op: 'encode', container: 'm4a' }], AUDIO));
    expect(audioOnly.args).not.toContain('-c:v');
    expect(audioOnly.args).toEqual(expect.arrayContaining(['-c:a', 'aac']));
    const mp4FromMp3 = plan([mp4], AUDIO);
    expect(mp4FromMp3.files[0]).toMatchObject({ role: 'audio', mime: 'audio/mp4' });
    expect(
      errorOf(() =>
        plan([{ op: 'loudness' }, mp4], { ...VIDEO, streams: VIDEO.streams.slice(0, 1) }),
      ).message,
    ).toMatch(/needs an audio stream/);
  });

  it('computes two-pass encodes for a target size', () => {
    const result = plan([{ ...mp4, name: 'small', video: { target_size_mb: 10 } }]);
    expect(result.stages.map((stage) => stage.label)).toEqual(['pass 1 small.mp4', 'main']);
    const [pass1, pass2] = result.stages;
    // 10 MiB over 120 s, 3 % muxing reserve, minus 128 kbps audio.
    const kbps = Math.floor((10 * 1024 * 1024 * 8 * 0.97) / 1000 / 120 - 128);
    expect(pass1?.args).toEqual(
      expect.arrayContaining(['-b:v', `${kbps}k`, '-pass', '1', '-an', '-f', 'null', '/dev/null']),
    );
    expect(pass2?.args).toEqual(
      expect.arrayContaining([
        '-b:v',
        `${kbps}k`,
        '-pass',
        '2',
        '-passlogfile',
        '/work/job/pass-small',
      ]),
    );
    expect(result.files[0]?.targetBytes).toBe(10 * 1024 * 1024);
    expect(errorOf(() => plan([{ ...mp4, video: { target_size_mb: 0.5 } }])).message).toMatch(
      /too small/,
    );
    expect(
      errorOf(() =>
        plan([
          {
            op: 'encode',
            container: 'mkv',
            video: { target_size_mb: 50 },
            audio: { codec: 'flac' },
          },
        ]),
      ).message,
    ).toMatch(/lossless/);
  });

  it('asks for a crop measurement first, then uses it', () => {
    const recipe = parseRecipe({ steps: [{ op: 'crop', auto: true }, mp4] }, LIMITS);
    const first = compose(recipe, [{ path: '/data/in.mp4', probe: VIDEO }], OPTIONS);
    expect(first.kind).toBe('measure');
    if (first.kind !== 'measure') return;
    expect(first.stage.measure).toEqual({ key: 'crop:0', kind: 'crop' });
    expect(first.stage.args).toEqual(expect.arrayContaining(['-skip_frame', 'nokey']));
    expect(graphOf(first.stage)).toContain('cropdetect=limit=24:round=2:reset=0');
    const second = compose(recipe, [{ path: '/data/in.mp4', probe: VIDEO }], {
      ...OPTIONS,
      measurements: { 'crop:0': { w: 1920, h: 800, x: 0, y: 140 } },
    });
    expect(second.kind === 'plan' && graphOf(main(second.plan))).toContain('crop=1920:800:0:140');
  });

  it('enforces the memory caps and the duration limit', () => {
    expect(errorOf(() => plan([{ op: 'reverse' }, mp4])).message).toMatch(/60 seconds/);
    expect(main(plan([{ op: 'trim', end: 10 }, { op: 'reverse' }, mp4])).args.join(' ')).toContain(
      'reverse',
    );
    const long = { ...VIDEO, duration_s: 300 };
    const interpolate = { op: 'fps', value: 60, mode: 'interpolate' };
    expect(errorOf(() => plan([interpolate, mp4], long)).message).toMatch(/120 seconds/);
    const looped = { ...VIDEO, duration_s: 3600 };
    expect(errorOf(() => plan([{ op: 'loop', count: 20 }, mp4], looped)).code).toBe(
      'MEDIA_TOO_LONG',
    );
  });

  it('loops the input file when loop comes first and buffers otherwise', () => {
    expect(beforeInput(main(plan([{ op: 'loop', count: 2 }, mp4])))).toEqual(
      expect.arrayContaining(['-stream_loop', '2']),
    );
    expect(beforeInput(main(plan([{ op: 'loop', to_duration_s: 300 }, mp4])))).toEqual(
      expect.arrayContaining(['-stream_loop', '-1', '-t', '300']),
    );
    const buffered = graphOf(main(plan([{ op: 'trim', end: 4 }, { op: 'loop', count: 1 }, mp4])));
    expect(buffered).toContain('loop=loop=1:size=121:start=0');
    expect(buffered).toContain('aloop=loop=1:size=192001:start=0');
  });

  it('builds speed, fade, cut_out and timelapse filters', () => {
    const graph = graphOf(
      main(plan([{ op: 'speed', factor: 4 }, { op: 'fade', in_s: 1, out_s: 2 }, mp4])),
    );
    expect(graph).toContain('setpts=PTS/4');
    expect(graph).toContain('atempo=2,atempo=2');
    // 120 s at 4x is 30 s; the fade out starts at 28 s.
    expect(graph).toContain('fade=t=out:st=28:d=2');
    expect(
      graphOf(main(plan([{ op: 'cut_out', ranges: [{ start: 10, end: 20 }] }, mp4]))),
    ).toContain("select='not(between(t,10,20))'");
    const lapse = main(plan([{ op: 'timelapse', every_nth_frame: 10 }, mp4]));
    expect(graphOf(lapse)).toContain("select='not(mod(n,10))'");
    expect(lapse.args).not.toContain('-c:a');
  });

  it('builds geometry filters with even sizes', () => {
    expect(graphOf(main(plan([{ op: 'scale', height: 720 }, mp4])))).toContain(
      "scale=w=-2:h='trunc(min(720,ih)/2)*2':flags=bicubic",
    );
    expect(
      graphOf(
        main(plan([{ op: 'scale', width: 1080, height: 1920, fit: 'pad', pad: 'blur' }, mp4])),
      ),
    ).toContain('overlay=(W-w)/2:(H-h)/2');
    expect(graphOf(main(plan([{ op: 'crop', aspect: '9:16', gravity: 'left' }, mp4])))).toContain(
      "crop=w='trunc(min(iw,ih*9/16)/2)*2'",
    );
    expect(
      errorOf(() => plan([{ op: 'crop', x: 1800, y: 0, w: 400, h: 400 }, mp4])).message,
    ).toMatch(/outside the 1920x1080/);
    expect(graphOf(main(plan([{ op: 'rotate', degrees: 90 }, mp4])))).toContain('transpose=clock');
    expect(
      beforeInput(
        main(
          plan([
            { op: 'rotate', degrees: 90, metadata_only: true },
            { ...mp4, video: { codec: 'copy' } },
          ]),
        ),
      ),
    ).toEqual(expect.arrayContaining(['-display_rotation:v:0', '-90']));
    expect(
      errorOf(() => plan([{ op: 'rotate', degrees: 90, metadata_only: true }, mp4])).message,
    ).toMatch(/metadata_only/);
    expect(errorOf(() => plan([{ op: 'pad', width: 1280, height: 720 }, mp4])).message).toMatch(
      /cannot shrink/,
    );
  });

  it('remuxes stream by stream and converts only when asked', () => {
    const withSubs: ProbeSummary = {
      ...VIDEO,
      streams: [...VIDEO.streams, stream({ type: 'subtitle', codec: 'subrip' })],
    };
    expect(errorOf(() => plan([{ op: 'remux', container: 'mp4' }], withSubs)).message).toMatch(
      /subtitle stream 2 \(subrip\)/,
    );
    const fixed = main(plan([{ op: 'remux', container: 'mp4', fix_incompatible: true }], withSubs));
    expect(fixed.args).toEqual(
      expect.arrayContaining([
        '-map',
        '0:2',
        '-c:s:0',
        'mov_text',
        '-c:v:0',
        'copy',
        '-c:a:0',
        'copy',
      ]),
    );
    expect(main(plan([{ op: 'remux', container: 'mkv' }], withSubs)).args).toEqual(
      expect.arrayContaining(['-map', '0:t?']),
    );
    expect(
      errorOf(() =>
        plan([
          { op: 'scale', height: 720 },
          { op: 'remux', container: 'mkv' },
        ]),
      ).message,
    ).toMatch(/untouched input/);
  });

  it('remuxes into the codecs asked for: copies streams already in them, converts the rest', () => {
    const youtube4k: ProbeSummary = {
      ...VIDEO,
      streams: [
        stream({ type: 'video', codec: 'vp9', width: 3840, height: 2160, fps: 30 }),
        stream({ type: 'audio', codec: 'opus', channels: 2, sample_rate: 48_000 }),
      ],
    };
    const h264 = { op: 'remux', container: 'mp4', video_codec: 'h264', audio_codec: 'aac' };
    const converted = plan([h264], youtube4k);
    expect(main(converted).args).toEqual(
      expect.arrayContaining(['-c:v:0', 'libx264', '-pix_fmt:v:0', 'yuv420p', '-c:a:0', 'aac']),
    );
    expect(main(converted).args).not.toContain('copy');

    // Already H.264 and AAC: both copied, nothing re-encoded.
    const copied = plan([h264]);
    expect(main(copied).args).toEqual(expect.arrayContaining(['-c:v:0', 'copy', '-c:a:0', 'copy']));
    expect(main(copied).args).not.toContain('libx264');
    expect(converted.cost).toBeGreaterThan(copied.cost * 10);

    expect(errorOf(() => plan([{ ...h264, container: 'webm' }])).message).toMatch(
      /webm cannot hold h264/,
    );
    expect(errorOf(() => plan([{ op: 'scale', height: 720 }, h264], youtube4k)).message).toMatch(
      /untouched input/,
    );
  });

  it('drains analysis branches into a null output and parses them from the log', () => {
    const stage = main(
      plan([{ op: 'loudness' }, { op: 'silence_detect' }, { op: 'scene_changes', threshold: 0.4 }]),
    );
    const graph = graphOf(stage);
    expect(graph).toContain('loudnorm=print_format=json');
    expect(graph).toContain('silencedetect=n=-50dB:d=0.5');
    expect(graph).toContain('scdet=threshold=40');
    expect(stage.args.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(stage.analyses.map((analysis) => analysis.kind)).toEqual([
      'loudness',
      'silence_detect',
      'scene_changes',
    ]);
  });

  it('runs probe and keyframes with ffprobe only', () => {
    const result = plan([{ op: 'probe' }, { op: 'keyframes', max: 50 }]);
    expect(result.stages.map((stage) => [stage.tool, stage.report?.kind])).toEqual([
      ['ffprobe', 'probe'],
      ['ffprobe', 'keyframes'],
    ]);
    expect(result.stages[0]?.args).toEqual(
      expect.arrayContaining(['-protocol_whitelist', 'file', '-show_chapters']),
    );
  });

  it('writes chapter metadata to a file and maps it', () => {
    const stage = main(
      plan([
        {
          ...mp4,
          name: 'ch',
          chapters: { set: [{ start: 0, end: 60, title: 'One; two = three' }] },
        },
      ]),
    );
    expect(stage.files[0]?.content).toContain(String.raw`title=One\; two \= three`);
    expect(stage.args).toEqual(
      expect.arrayContaining([
        '-f',
        'ffmetadata',
        '-i',
        '/work/job/chapters-ch.txt',
        '-map_chapters',
        '1',
      ]),
    );
  });

  it('drops chapters after time changes and keeps them otherwise', () => {
    expect(main(plan([mp4])).args).not.toContain('-map_chapters');
    expect(main(plan([{ op: 'speed', factor: 2 }, mp4])).args).toEqual(
      expect.arrayContaining(['-map_chapters', '-1']),
    );
  });

  it('estimates cost by codec, resolution and passes', () => {
    const h264 = plan([mp4]).cost;
    const hevc = plan([{ ...mp4, video: { codec: 'hevc' } }]).cost;
    const small = plan([{ op: 'scale', height: 360 }, mp4]).cost;
    expect(hevc).toBeGreaterThan(h264 * 2);
    expect(small).toBeLessThan(h264);
    expect(
      plan([{ ...mp4, video: { codec: 'copy' }, audio: { codec: 'copy' } }]).cost,
    ).toBeLessThan(1);
  });

  it('builds GIF, thumbnails, contact sheets and split outputs', () => {
    const gif = plan([{ op: 'gif', start: 2, end: 8, width: 320 }]);
    expect(graphOf(main(gif))).toMatch(
      /palettegen=max_colors=256:stats_mode=full.*paletteuse=dither=sierra2_4a/,
    );
    const thumbs = plan([{ op: 'thumbnail', count: 5, format: 'webp' }]);
    expect(thumbs.files[0]).toMatchObject({
      pattern: 'thumbnail_%03d.webp',
      multiple: true,
      mime: 'image/webp',
    });
    expect(main(thumbs).args).toEqual(
      expect.arrayContaining(['-frames:v', '5', '-c:v', 'libwebp']),
    );
    expect(graphOf(main(plan([{ op: 'contact_sheet', columns: 3, rows: 2 }])))).toContain(
      'tile=3x2',
    );
    const split = plan([{ op: 'split', every_seconds: 30 }]);
    expect(main(split).args).toEqual(
      expect.arrayContaining(['-f', 'segment', '-segment_time', '30', '-c', 'copy']),
    );
    expect(split.files[0]).toMatchObject({ pattern: 'split_%03d.mp4', multiple: true });
    expect(main(plan([{ op: 'split', at: [30, 90], mode: 'accurate' }])).args).toEqual(
      expect.arrayContaining(['-force_key_frames', '30,90', '-segment_times', '30,90']),
    );
  });
});
