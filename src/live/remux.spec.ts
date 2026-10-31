import { describe, expect, it } from 'vitest';

import { remuxArgs, waitArgs } from './remux';

describe('remuxArgs (SPEC §7d)', () => {
  it('copies video and audio into the container, with faststart for MP4 and MOV', () => {
    expect(remuxArgs('/w/in.ts', '/w/out.mp4', 'mp4')).toEqual([
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-protocol_whitelist',
      'file',
      '-i',
      '/w/in.ts',
      '-map',
      '0:v?',
      '-map',
      '0:a?',
      '-c',
      'copy',
      '-f',
      'mp4',
      '-movflags',
      '+faststart',
      '/w/out.mp4',
    ]);
    expect(remuxArgs('/w/in.ts', '/w/out.mkv', 'mkv').slice(-3)).toEqual([
      '-f',
      'matroska',
      '/w/out.mkv',
    ]);
    expect(remuxArgs('/w/in.ts', '/w/out.mov', 'mov')).toContain('+faststart');
  });

  it('splits into segments that each start at zero', () => {
    const args = remuxArgs('/w/in.ts', '/w/out - part %03d.mp4', 'mp4', 600);
    expect(args.slice(args.indexOf('-f'))).toEqual([
      '-f',
      'segment',
      '-segment_time',
      '600',
      '-reset_timestamps',
      '1',
      '-segment_format',
      'mp4',
      '-segment_format_options',
      'movflags=+faststart',
      '/w/out - part %03d.mp4',
    ]);
    expect(remuxArgs('/w/in.ts', '/w/o%03d.mkv', 'mkv', 60)).not.toContain(
      '-segment_format_options',
    );
  });
});

describe('waitArgs', () => {
  it('turns minutes into the seconds --wait-for-video takes', () => {
    expect(waitArgs(undefined)).toEqual([]);
    expect(waitArgs({ min_minutes: 5 })).toEqual(['--wait-for-video', '300']);
    expect(waitArgs({ min_minutes: 1, max_minutes: 10 })).toEqual(['--wait-for-video', '60-600']);
    expect(waitArgs({ min_minutes: 2, max_minutes: 2 })).toEqual(['--wait-for-video', '120']);
  });
});
