import { describe, expect, it } from 'vitest';

import { isTransportNoise, parseFfmpegStats } from './ffmpeg-stats';

// Captured from yt-dlp 2026.10.26 recording a YouTube live stream through ffmpeg 8.1.
const STATS =
  'frame= 2849 fps= 37 q=-1.0 size=    4352KiB time=00:01:34.96 bitrate= 375.4kbits/s speed=1.24x elapsed=0:01:16.47    ';
const FINAL =
  'frame= 3149 fps= 35 q=-1.0 Lsize=    4982KiB time=00:01:44.96 bitrate= 388.8kbits/s speed=1.18x elapsed=0:01:28.74    ';

describe('parseFfmpegStats', () => {
  it('reads size, recorded time and bitrate from a stats line', () => {
    expect(parseFfmpegStats(STATS)).toEqual({
      bytes: 4352 * 1024,
      recordedS: 94.96,
      bytesPerSecond: (375.4 * 1000) / 8,
    });
    expect(parseFfmpegStats(FINAL)).toMatchObject({ bytes: 4982 * 1024, recordedS: 104.96 });
  });

  it('understands the other size units and missing bitrates', () => {
    expect(parseFfmpegStats('size=     512kB time=00:00:01.00 bitrate=N/A speed=1x')).toEqual({
      bytes: 512_000,
      recordedS: 1,
      bytesPerSecond: null,
    });
    expect(
      parseFfmpegStats('size=       3MiB time=01:00:00.50 bitrate=1000.0kbits/s'),
    ).toMatchObject({ bytes: 3 * 1024 * 1024, recordedS: 3600.5 });
    expect(parseFfmpegStats('size=     100B time=00:00:00.00 bitrate=0.0kbits/s')).toMatchObject({
      bytes: 100,
    });
  });

  it('ignores everything else', () => {
    expect(parseFfmpegStats('[download] Destination: x.mp4')).toBeUndefined();
    expect(
      parseFfmpegStats('frame=    0 fps=0.0 q=0.0 size=N/A time=N/A bitrate=N/A'),
    ).toBeUndefined();
  });
});

describe('isTransportNoise', () => {
  it('flags ffmpeg network lines, which carry signed CDN URLs and the server address', () => {
    expect(
      isTransportNoise(
        "[https @ 0xaaaac5861200] Opening 'https://rr2---sn.googlevideo.com/videoplayback/ip/1.2.3.4/sig/AE0'",
      ),
    ).toBe(true);
    expect(
      isTransportNoise(
        "[hls @ 0xffff8c006fd0] Opening 'https://manifest.googlevideo.com/x' for reading",
      ),
    ).toBe(true);
    expect(isTransportNoise('[tcp @ 0x1] Starting connection attempt to 1.2.3.4 port 443')).toBe(
      true,
    );
    expect(isTransportNoise('[q] command received. Exiting.')).toBe(false);
    expect(isTransportNoise('ERROR: [youtube] x: Private video')).toBe(false);
  });
});
