import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AppError } from '../common/errors';
import {
  dedupeRolling,
  parseJson3,
  parseSrt,
  parseSubtitles,
  parseTimestamp,
  parseVtt,
  toSrt,
  toText,
  toVtt,
} from './subtitles';

const sub = (name: string) =>
  readFileSync(path.resolve(__dirname, '../../test/fixtures/ytdlp/subs', name), 'utf8');

describe('parsers (real YouTube captions of jNQXAC9IVRw)', () => {
  it('reads json3', () => {
    const cues = parseJson3(sub('jNQXAC9IVRw.en.json3'));
    expect(cues).toHaveLength(6);
    expect(cues[0]).toEqual({
      start: 1.2,
      end: 3.36,
      text: 'All right, so here we are, in front of the\nelephants',
    });
  });

  it('reads WebVTT and gets the same cues as json3', () => {
    const vtt = parseVtt(sub('jNQXAC9IVRw.en.vtt'));
    const json3 = parseJson3(sub('jNQXAC9IVRw.en.json3'));
    expect(vtt.map((cue) => cue.text)).toEqual(json3.map((cue) => cue.text));
    expect(vtt[0]?.start).toBe(1.2);
  });

  it('reads SRT', () => {
    expect(
      parseSrt(
        '1\n00:00:01,500 --> 00:00:02,000\nHello <i>there</i>\n\n2\n01:00:00,000 --> 01:00:01,250\nBye\n',
      ),
    ).toEqual([
      { start: 1.5, end: 2, text: 'Hello there' },
      { start: 3600, end: 3601.25, text: 'Bye' },
    ]);
  });

  it('strips tags, decodes entities and skips cues without text', () => {
    const cues = parseVtt(sub('jNQXAC9IVRw.es.vtt'));
    expect(cues.some((cue) => /<\/?c>|<\d{2}:/.test(cue.text))).toBe(false);
    expect(cues.at(-1)?.text).toBe('bienvenidos al canal\n& gracias <3');
  });

  it('dispatches by extension and rejects unknown formats', () => {
    expect(parseSubtitles('srt', '1\n00:00:00,000 --> 00:00:01,000\nx\n')).toHaveLength(1);
    expect(() => parseSubtitles('ttml', '<tt/>')).toThrow(AppError);
    expect(() => parseJson3('{not json')).toThrow(AppError);
  });

  it('parses short and long timestamps', () => {
    expect(parseTimestamp('01:02.5')).toBe(62.5);
    expect(parseTimestamp('1:00:00.001')).toBe(3600.001);
    expect(() => parseTimestamp('soon')).toThrow(AppError);
  });
});

describe('dedupeRolling (YouTube automatic captions)', () => {
  it('keeps only the line each rolling cue adds', () => {
    const cues = dedupeRolling(parseVtt(sub('jNQXAC9IVRw.es.vtt')));
    expect(cues.map((cue) => cue.text)).toEqual([
      'hola a todos',
      'bienvenidos al canal',
      '& gracias <3',
    ]);
    expect(cues[1]).toMatchObject({ start: 2.399, end: 4.87 });
  });
});

describe('writers', () => {
  const cues = [
    { start: 1.2, end: 3.36, text: 'Line one\nline two' },
    { start: 3661.005, end: 3662, text: 'Tom & <Jerry>' },
  ];

  it('writes SRT', () => {
    expect(toSrt(cues)).toBe(
      '1\n00:00:01,200 --> 00:00:03,360\nLine one\nline two\n\n2\n01:01:01,005 --> 01:01:02,000\nTom & <Jerry>\n',
    );
  });

  it('writes WebVTT with escaped text that parses back to the same cues', () => {
    const vtt = toVtt(cues);
    expect(vtt.startsWith('WEBVTT\n\n00:00:01.200 --> 00:00:03.360\n')).toBe(true);
    expect(vtt).toContain('Tom &amp; &lt;Jerry&gt;');
    expect(parseVtt(vtt)).toEqual(cues);
  });

  it('writes plain text without consecutive repeats', () => {
    expect(toText([...cues, { start: 4000, end: 4001, text: 'Tom & <Jerry>' }])).toBe(
      'Line one\nline two\nTom & <Jerry>',
    );
  });
});
