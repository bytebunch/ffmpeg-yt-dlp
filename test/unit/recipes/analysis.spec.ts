import { describe, expect, it } from 'vitest';

import {
  analysisReport,
  cropMeasurement,
  FilterLogCollector,
  keyframesReport,
  probeReport,
} from '../../../src/recipes/analysis';
import { failureSummary } from '../../../src/recipes/run-stage';

// Captured from ffmpeg n8.1.3 (black 2–4 s, silence 2–3.5 s), plus input metadata that imitates
// filter lines: ffmpeg indents metadata, so it must not count.
const LOG = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':
  Metadata:
    title           : [Parsed_silencedetect_6 @ 0xdead] silence_start: 99
[Parsed_volumedetect_8 @ 0xaaaabec12ec0] n_samples: 0
[Parsed_scdet_3 @ 0xffff98005b30] lavfi.scd.score: 40.756, lavfi.scd.time: 2
[Parsed_silencedetect_6 @ 0xffff98005ff0] silence_start: 2.020249
[Parsed_silencedetect_6 @ 0xffff98005ff0] silence_end: 3.5061 | silence_duration: 1.48585
[Parsed_blackdetect_1 @ 0xffff98002c90] black_start:2 black_end:4 black_duration:2
[Parsed_scdet_3 @ 0xffff98005b30] lavfi.scd.score: 41.531, lavfi.scd.time: 4
[Parsed_silencedetect_6 @ 0xffff98005ff0] silence_start: 5.5
[Parsed_loudnorm_10 @ 0xffff980865f0] 
{
	"input_i" : "-22.15",
	"input_tp" : "-17.12",
	"input_lra" : "2.30",
	"input_thresh" : "-32.26",
	"output_i" : "-23.22",
	"output_tp" : "-18.15",
	"output_lra" : "2.40",
	"output_thresh" : "-33.31",
	"normalization_type" : "dynamic",
	"target_offset" : "-0.78"
}
[Parsed_volumedetect_8 @ 0xffff980062c0] n_samples: 265216
[Parsed_volumedetect_8 @ 0xffff980062c0] mean_volume: -22.3 dB
[Parsed_volumedetect_8 @ 0xffff980062c0] max_volume: -17.6 dB
[Parsed_volumedetect_8 @ 0xffff980062c0] histogram_17db: 1644
[Parsed_cropdetect_0 @ 0xffff9800] x1:0 x2:319 y1:30 y2:209 w:320 h:176 x:0 y:32 pts:0 t:0.0 limit:0.094 crop=320:176:0:32
[Parsed_cropdetect_0 @ 0xffff9800] x1:0 x2:319 y1:30 y2:209 w:320 h:180 x:0 y:30 pts:50 t:2.0 limit:0.094 crop=320:180:0:30
[out#0/null @ 0xaaaabec12bf0] video:62KiB audio:518KiB`;

function collect(text = LOG): FilterLogCollector {
  const log = new FilterLogCollector();
  for (const line of text.split('\n')) log.push(line);
  return log;
}

describe('analysis log parsing', () => {
  const log = collect();

  it('reads loudness from the loudnorm JSON block', () => {
    expect(analysisReport('loudness', log, 6)).toEqual({
      integrated_lufs: -22.15,
      true_peak_dbtp: -17.12,
      lra_lu: 2.3,
      threshold_lufs: -32.26,
    });
  });

  it('reads the final volumedetect figures, not the early probe', () => {
    expect(analysisReport('volume', log, 6)).toEqual({
      mean_volume_db: -22.3,
      max_volume_db: -17.6,
      samples: 265216,
      histogram_db: { '-17': 1644 },
    });
  });

  it('pairs silence starts and ends, closing a trailing silence at the end of the media', () => {
    expect(analysisReport('silence_detect', log, 6)).toEqual({
      silences: [
        { start_s: 2.020249, end_s: 3.5061, duration_s: 1.48585 },
        { start_s: 5.5, end_s: 6, duration_s: 0.5 },
      ],
      total_silence_s: 1.986,
    });
  });

  it('reads black intervals, scene changes and the crop measurement', () => {
    expect(analysisReport('black_detect', log, 6)).toEqual({
      intervals: [{ start_s: 2, end_s: 4, duration_s: 2 }],
    });
    expect(analysisReport('scene_changes', log, 6)).toEqual({
      scenes: [
        { time_s: 2, score: 0.408 },
        { time_s: 4, score: 0.415 },
      ],
    });
    expect(cropMeasurement(log)).toEqual({ w: 320, h: 180, x: 0, y: 30 });
    expect(cropMeasurement(collect('nothing here'))).toBeNull();
  });

  it('reports nothing when a filter logged nothing', () => {
    expect(analysisReport('loudness', collect(''), null)).toBeNull();
    expect(analysisReport('black_detect', collect(''), null)).toEqual({ intervals: [] });
  });

  it('keeps keyframes only, caps them and measures the largest gap', () => {
    const lines = [
      '0.000000,48,K__',
      '0.040000,900,___',
      '1.000000,9000,K__',
      '3.500000,30000,K__',
      'garbage',
    ];
    expect(keyframesReport(lines, 10)).toEqual({
      count: 3,
      truncated: false,
      max_interval_s: 2.5,
      keyframes: [
        { time_s: 0, pos: 48 },
        { time_s: 1, pos: 9000 },
        { time_s: 3.5, pos: 30000 },
      ],
    });
    expect(keyframesReport(lines, 2)).toMatchObject({ count: 2, truncated: true });
  });

  it('removes the server path from probe reports and failure messages', () => {
    expect(
      probeReport('{"format":{"filename":"/data/files/x.mp4","duration":"6"},"streams":[]}'),
    ).toEqual({ format: { duration: '6' }, streams: [] });
    const tail = [
      'Input #0, from /data/files/.work/job/in.mp4',
      '[in#0 @ 0x1] Error opening input: Invalid data found when processing input',
      'Error opening input file /data/files/.work/job/in.mp4.',
    ];
    const summary = failureSummary(tail, ['/data/files/.work/job']);
    expect(summary).toContain('Invalid data found');
    expect(summary).not.toContain('/data/files');
  });
});
