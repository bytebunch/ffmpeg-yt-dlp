import { describe, expect, it } from 'vitest';

import { classifyFile } from '../../../src/downloads/classify';
import { parseProgressLine } from '../../../src/downloads/progress';

describe('parseProgressLine', () => {
  const line = (data: object) => `MEDIA-PROGRESS ${JSON.stringify(data)}`;

  it('computes the percentage from downloaded and total bytes', () => {
    expect(
      parseProgressLine(
        line({
          status: 'downloading',
          downloaded_bytes: 2500,
          total_bytes: 10000,
          speed: 512.5,
          eta: 4,
        }),
      ),
    ).toEqual({
      stage: 'downloading',
      percent: 25,
      bytes: 2500,
      total_bytes: 10000,
      speed: 512.5,
      eta: 4,
      fragment: null,
      postprocessor: null,
    });
  });

  it('falls back to the estimated total and reports fragments', () => {
    const progress = parseProgressLine(
      line({
        status: 'downloading',
        downloaded_bytes: 1,
        total_bytes_estimate: 3,
        fragment_index: 2,
        fragment_count: 9,
      }),
    );
    expect(progress).toMatchObject({
      percent: 33.3,
      total_bytes: 3,
      fragment: { index: 2, count: 9 },
    });
  });

  it('reports 100 when finished and null when the total is unknown', () => {
    expect(parseProgressLine(line({ status: 'finished', downloaded_bytes: 5 }))?.percent).toBe(100);
    expect(
      parseProgressLine(line({ status: 'downloading', downloaded_bytes: 5 }))?.percent,
    ).toBeNull();
  });

  it('reads post-processing steps', () => {
    expect(
      parseProgressLine('MEDIA-POSTPROCESS {"postprocessor":"Merger","status":"started"}'),
    ).toMatchObject({
      stage: 'postprocessing',
      postprocessor: 'Merger',
    });
  });

  it('ignores everything else', () => {
    for (const text of ['[download] 10%', 'MEDIA-PROGRESS not json', 'MEDIA-PROGRESS 42', '']) {
      expect(parseProgressLine(text)).toBeUndefined();
    }
  });
});

describe('classifyFile', () => {
  it.each([
    ['Me at the zoo [jNQXAC9IVRw].mp4', 'media', 'video/mp4'],
    ['clip.mkv', 'media', 'video/x-matroska'],
    ['song.mp3', 'audio', 'audio/mpeg'],
    ['song.opus', 'audio', 'audio/ogg'],
    ['song.m4a', 'audio', 'audio/mp4'],
    ['cover.webp', 'thumbnail', 'image/webp'],
    ['clip.en.vtt', 'subtitles', 'text/vtt'],
    ['clip.de.srt', 'subtitles', 'application/x-subrip'],
    ['clip.info.json', 'info_json', 'application/json'],
    ['clip.description', 'description', 'text/plain; charset=utf-8'],
  ])('%s is %s (%s)', (name, role, mime) => {
    expect(classifyFile(name)).toEqual({ role, mime });
  });

  it.each([
    'clip.mp4.part',
    'clip.f137.mp4',
    'clip.mp4.ytdl',
    'clip.part-Frag12',
    '.hidden.mp4',
    'notes.txt',
    'clip.temp.mp4.part',
  ])('skips %s', (name) => {
    expect(classifyFile(name)).toBeUndefined();
  });
});
