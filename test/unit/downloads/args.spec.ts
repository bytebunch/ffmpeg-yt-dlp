import { describe, expect, it } from 'vitest';

import {
  downloadArgs,
  escapeRegex,
  formatTime,
  type DownloadContext,
} from '../../../src/downloads/args';
import { downloadOptionsSchema, optionProblems } from '../../../src/downloads/options';

const context: DownloadContext = {
  workDir: '/data/files/.work/j1',
  tempDir: '/data/files/.work/j1/.tmp',
  ffmpegLocation: '/usr/local/bin/ffmpeg',
  maxFileSizeMb: 4096,
  sponsorblockApiUrl: 'https://sponsor.ajay.app',
};

const args = (input: Record<string, unknown> = {}) =>
  downloadArgs(downloadOptionsSchema.parse(input), context);

/** The values following each occurrence of a flag. */
function valuesOf(list: string[], flag: string): string[] {
  return list.flatMap((arg, i) => (arg === flag ? [list[i + 1] ?? ''] : []));
}

describe('downloadArgs — fixed flags (SPEC §7g)', () => {
  it('always sets progress, paths, retries, size cap and single-item mode', () => {
    const list = args();
    expect(list.slice(0, 6)).toEqual([
      '--no-playlist',
      '--newline',
      '--progress',
      '--progress-template',
      'download:MEDIA-PROGRESS %(progress)j',
      '--progress-template',
    ]);
    expect(valuesOf(list, '--paths')).toEqual([
      'home:/data/files/.work/j1',
      'temp:/data/files/.work/j1/.tmp',
    ]);
    expect(valuesOf(list, '--ffmpeg-location')).toEqual(['/usr/local/bin/ffmpeg']);
    expect(
      downloadArgs(downloadOptionsSchema.parse({}), { ...context, ffmpegLocation: undefined }),
    ).not.toContain('--ffmpeg-location');
    expect(list).toEqual(
      expect.arrayContaining(['--no-overwrites', '--no-mtime', '--abort-on-unavailable-fragments']),
    );
    expect(valuesOf(list, '--retry-sleep')).toEqual(['exp=1:30']);
    expect(valuesOf(list, '--max-filesize')).toEqual(['4096M']);
  });

  it('lowers the size cap to max_filesize_mb but never raises it', () => {
    expect(valuesOf(args({ max_filesize_mb: 100 }), '--max-filesize')).toEqual(['100M']);
    expect(valuesOf(args({ max_filesize_mb: 99_999 }), '--max-filesize')).toEqual(['4096M']);
  });

  it('allows missing fragments only when asked', () => {
    expect(args({ allow_missing_fragments: true })).not.toContain(
      '--abort-on-unavailable-fragments',
    );
  });
});

describe('downloadArgs — format selection (§7a)', () => {
  it('merges best video and audio into the container by default', () => {
    const list = args();
    expect(valuesOf(list, '-f')).toEqual(['bv*+ba/b']);
    expect(valuesOf(list, '-S')).toEqual(['hdr:sdr']);
    expect(valuesOf(list, '--merge-output-format')).toEqual(['mp4']);
    expect(valuesOf(list, '--remux-video')).toEqual(['mp4']);
  });

  it('caps the resolution for tier presets and recodes on request', () => {
    const list = args({ preset: '720p', container: 'mkv', recode: true });
    expect(valuesOf(list, '-S')).toEqual(['res:720,hdr:sdr']);
    expect(valuesOf(list, '--recode-video')).toEqual(['mkv']);
    expect(list).not.toContain('--remux-video');
  });

  it('extracts audio for audio presets', () => {
    expect(args({ preset: 'audio_mp3', audio_bitrate_kbps: 192 })).toEqual(
      expect.arrayContaining([
        '-f',
        'ba/b',
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '192K',
      ]),
    );
    expect(valuesOf(args({ preset: 'audio_best' }), '--audio-format')).toEqual(['best']);
    expect(valuesOf(args({ preset: 'audio_opus', audio_vbr: 2 }), '--audio-quality')).toEqual([
      '2',
    ]);
    expect(args({ preset: 'audio_m4a', keep_video: true })).toContain('-k');
    expect(args({ preset: 'audio_flac' })).not.toContain('--merge-output-format');
  });

  it('builds the sort order from codec, fps, HDR and custom keys', () => {
    const list = args({
      preset: '1080p',
      video_codec: 'hevc',
      audio_codec: 'opus',
      fps_max: 30,
      hdr: 'prefer',
      format_sort: ['+size', 'proto'],
    });
    expect(valuesOf(list, '-S')).toEqual([
      'res:1080,vcodec:h265,acodec:opus,fps:30,hdr,+size,proto',
    ]);
    expect(valuesOf(args({ video_codec: 'av1', hdr: 'any' }), '-S')).toEqual(['vcodec:av01']);
  });

  it('uses an explicit format_id instead of the preset selection', () => {
    expect(valuesOf(args({ format_id: '137+140' }), '-f')).toEqual(['137+140']);
  });

  it('keeps every audio language for multistreams', () => {
    const list = args({ multistreams: 'audio', container: 'mkv' });
    expect(list).toEqual(
      expect.arrayContaining(['--audio-multistreams', '-f', 'bv+mergeall[vcodec=none]']),
    );
  });

  it('downloads no media for the *_only presets', () => {
    expect(args({ preset: 'thumbnail_only' })).toEqual(
      expect.arrayContaining(['--skip-download', '--write-thumbnail']),
    );
    expect(args({ preset: 'metadata_only' })).toEqual(
      expect.arrayContaining(['--skip-download', '--write-info-json']),
    );
    expect(valuesOf(args({ preset: 'subtitles_only' }), '--sub-langs')).toEqual(['en']);
    expect(args({ preset: 'metadata_only' })).not.toContain('-f');
    expect(args({ preset: 'metadata_only' })).not.toContain('--merge-output-format');
  });

  it('passes free-format preference and format verification', () => {
    expect(args({ prefer_free_formats: true, verify_formats: true })).toEqual(
      expect.arrayContaining(['--prefer-free-formats', '--check-formats']),
    );
  });
});

describe('downloadArgs — sections, chapters, SponsorBlock (§7b)', () => {
  it('turns time ranges into section arguments', () => {
    const list = args({
      sections: [
        { start: '1:30', end: 95.5 },
        { start: 0, end: '0:10' },
      ],
      force_keyframes: true,
    });
    expect(valuesOf(list, '--download-sections')).toEqual([
      '*00:01:30.000-00:01:35.500',
      '*00:00:00.000-00:00:10.000',
    ]);
    expect(list).toContain('--force-keyframes-at-cuts');
  });

  it('matches chapter titles literally', () => {
    const list = args({
      sections_by_chapter: ['Intro (part 1)'],
      chapters: { remove_titles: ['Ad.*'] },
    });
    expect(valuesOf(list, '--download-sections')).toEqual(['^Intro \\(part 1\\)$']);
    expect(valuesOf(list, '--remove-chapters')).toEqual(['^Ad\\.\\*$']);
  });

  it('splits chapters with their own output template and removes ranges', () => {
    const list = args({ chapters: { split: true, remove_ranges: [{ start: 0, end: 5 }] } });
    expect(list).toContain('--split-chapters');
    expect(valuesOf(list, '-o')[0]).toMatch(/^chapter:/);
    expect(valuesOf(list, '--remove-chapters')).toEqual(['*00:00:00.000-00:00:05.000']);
  });

  it('embeds chapters by default for mp4/mkv only, unless told otherwise', () => {
    expect(args()).toContain('--embed-chapters');
    expect(args({ container: 'webm' })).not.toContain('--embed-chapters');
    expect(args({ chapters: { embed: false } })).not.toContain('--embed-chapters');
  });

  it('marks and removes SponsorBlock segments with a fixed title template', () => {
    const list = args({
      sponsorblock: {
        mark: ['intro'],
        remove: ['sponsor', 'selfpromo'],
        chapter_title: 'category',
      },
    });
    expect(valuesOf(list, '--sponsorblock-mark')).toEqual(['intro']);
    expect(valuesOf(list, '--sponsorblock-remove')).toEqual(['sponsor,selfpromo']);
    expect(valuesOf(list, '--sponsorblock-chapter-title')).toEqual(['%(category_names)l']);
    expect(valuesOf(list, '--sponsorblock-api')).toEqual(['https://sponsor.ajay.app']);
    expect(args()).not.toContain('--sponsorblock-mark');
  });
});

describe('downloadArgs — subtitles, thumbnails, metadata, naming (§7c)', () => {
  it('writes, converts and embeds subtitles', () => {
    const list = args({
      subtitles: { langs: ['en', 'pt-BR'], auto: true, format: 'srt', embed: true },
    });
    expect(list).toEqual(
      expect.arrayContaining(['--write-subs', '--write-auto-subs', '--embed-subs']),
    );
    expect(valuesOf(list, '--sub-langs')).toEqual(['en,pt-BR']);
    expect(valuesOf(list, '--sub-format')).toEqual(['srt/best']);
    expect(valuesOf(list, '--convert-subs')).toEqual(['srt']);
    expect(args({ subtitles: {} })).not.toContain('--convert-subs');
  });

  it('handles thumbnails', () => {
    expect(args({ thumbnail: { write: true, all: true, embed: true, convert: 'jpg' } })).toEqual(
      expect.arrayContaining([
        '--write-thumbnail',
        '--write-all-thumbnails',
        '--embed-thumbnail',
        '--convert-thumbnails',
        'jpg',
      ]),
    );
  });

  it('embeds metadata unless disabled, and info JSON into mkv on request', () => {
    expect(args()).toContain('--embed-metadata');
    expect(args({ metadata: { embed: false } })).toContain('--no-embed-metadata');
    expect(args({ container: 'mkv', metadata: { info_json: true } })).toContain(
      '--embed-info-json',
    );
  });

  it('writes extras, with curated comment arguments', () => {
    const list = args({
      extras: ['info_json', 'description', 'comments'],
      comments: { max: 50, sort: 'new' },
    });
    expect(list).toEqual(
      expect.arrayContaining([
        '--write-info-json',
        '--clean-info-json',
        '--write-description',
        '--write-comments',
      ]),
    );
    expect(valuesOf(list, '--extractor-args')).toEqual([
      'youtube:max_comments=50;comment_sort=new',
    ]);
  });

  it('merges comment settings and whitelisted extractor args into one youtube value (§7f)', () => {
    const list = args({
      extras: ['comments'],
      comments: { max: 50, sort: 'new' },
      extractor_args: { youtube: { player_client: ['tv'], lang: 'de' } },
    });
    expect(valuesOf(list, '--extractor-args')).toEqual([
      'youtube:player_client=tv;lang=de;max_comments=50;comment_sort=new',
    ]);
    expect(
      valuesOf(args({ extractor_args: { youtube: { lang: 'fr' } } }), '--extractor-args'),
    ).toEqual(['youtube:lang=fr']);
    expect(() =>
      downloadOptionsSchema.parse({ extractor_args: { youtube: { po_token: 'x' } } }),
    ).toThrow();
    expect(() => downloadOptionsSchema.parse({ extractor_args: { generic: {} } })).toThrow();
    expect(optionProblems(downloadOptionsSchema.parse({ mark_watched: true }))).toEqual([
      'mark_watched requires cookies',
    ]);
    expect(
      optionProblems(downloadOptionsSchema.parse({ mark_watched: true, cookies: true })),
    ).toEqual([]);
  });

  it('names files from a fixed menu of templates', () => {
    expect(valuesOf(args(), '-o')).toEqual(['%(title).150B [%(id)s].%(ext)s']);
    expect(valuesOf(args({ filename: 'id' }), '-o')).toEqual(['%(id)s.%(ext)s']);
    expect(args({ ascii_filenames: true, windows_safe: true })).toEqual(
      expect.arrayContaining([
        '--trim-filenames',
        '180',
        '--restrict-filenames',
        '--windows-filenames',
      ]),
    );
  });

  it('limits the rate and the concurrent fragments', () => {
    const list = args({ limit_rate_kbps: 500, concurrent_fragments: 4 });
    expect(valuesOf(list, '-r')).toEqual(['500K']);
    expect(valuesOf(list, '-N')).toEqual(['4']);
  });
});

describe('downloadOptionsSchema', () => {
  it('normalises timestamps to seconds', () => {
    expect(
      downloadOptionsSchema.parse({ sections: [{ start: '01:02:03.5', end: '1:02:04' }] }).sections,
    ).toEqual([{ start: 3723.5, end: 3724 }]);
  });

  it.each([
    [{ sections: [{ start: 10, end: 5 }] }, 'end must be after start'],
    [
      {
        sections: [
          { start: 0, end: 10 },
          { start: 5, end: 15 },
        ],
      },
      'must not overlap',
    ],
    [{ format_id: '-f bestvideo' }, 'format_id'],
    [{ format_sort: ['res', 'evil'] }, 'unknown sort key'],
    [{ subtitles: { langs: ['en.*'] } }, 'language tag'],
    [{ sponsorblock: { remove: ['ads'] } }, ''],
    [{ exec: 'rm -rf /' }, ''],
    [{ concurrent_fragments: 9 }, ''],
  ])('rejects %j', (input, message) => {
    const result = downloadOptionsSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success && message) expect(JSON.stringify(result.error.issues)).toContain(message);
  });

  it('reports cross-field problems', () => {
    const problems = (input: Record<string, unknown>) =>
      optionProblems(downloadOptionsSchema.parse(input));
    expect(problems({ multistreams: 'audio' })).toEqual(['multistreams requires container "mkv"']);
    expect(problems({ metadata: { info_json: true } })).toEqual([
      'metadata.info_json requires container "mkv"',
    ]);
    expect(problems({ keep_video: true })).toEqual(['keep_video only applies to audio presets']);
    expect(problems({ preset: 'audio_mp3', audio_bitrate_kbps: 128, audio_vbr: 2 })).toHaveLength(
      1,
    );
    expect(problems({ preset: 'audio_mp3', recode: true })).toEqual([
      'recode applies to video presets',
    ]);
    expect(problems({ subtitles: { format: 'lrc', embed: true } })).toEqual([
      'lrc subtitles cannot be embedded',
    ]);
    expect(
      problems({
        chapters: { remove_ranges: [{ start: 0, end: 1 }] },
        sponsorblock: { mark: ['sponsor'] },
      }),
    ).toEqual(['chapters.remove_ranges cannot be combined with sponsorblock']);
    expect(
      problems({ chapters: { remove_ranges: [{ start: 0, end: 1 }] }, sponsorblock: {} }),
    ).toEqual([]);
    expect(problems({ preset: '1080p', container: 'mkv', multistreams: 'audio' })).toEqual([]);
  });
});

describe('helpers', () => {
  it('formats times for section ranges', () => {
    expect(formatTime(0)).toBe('00:00:00.000');
    expect(formatTime(3723.5)).toBe('01:02:03.500');
  });

  it('escapes every regular-expression metacharacter', () => {
    expect(escapeRegex('a.b*c+d?e^f$g(h)i[j]k{l}m|n/o\\p-q')).toBe(
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\(h\\)i\\[j\\]k\\{l\\}m\\|n\\/o\\\\p\\-q',
    );
  });
});
