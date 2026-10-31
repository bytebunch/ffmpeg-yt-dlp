import { describe, expect, it } from 'vitest';

import { classifyYtDlpError, errorMessage } from './errors';

const err = (line: string) => `[youtube] Extracting URL\nWARNING: something\nERROR: ${line}\n`;

describe('classifyYtDlpError', () => {
  it.each([
    ['[generic] Unsupported URL: https://example.com/', 'UNSUPPORTED_SITE'],
    [
      '[youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
      'BOT_CHECK',
    ],
    ["[youtube] abc: Sign in to confirm you're not a bot", 'BOT_CHECK'],
    ['[youtube] abc: Unable to download API page: HTTP Error 429: Too Many Requests', 'BOT_CHECK'],
    [
      '[youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.',
      'MEDIA_AGE_GATED',
    ],
    ['[youtube] abc: This live event will begin in 3 hours.', 'LIVE_NOT_STARTED'],
    ['[youtube] abc: Premieres in 2 days', 'LIVE_NOT_STARTED'],
    [
      '[youtube] abc: Video unavailable. The uploader has not made this video available in your country',
      'MEDIA_GEO_BLOCKED',
    ],
    [
      "[youtube] abc: Private video. Sign in if you've been granted access to this video",
      'MEDIA_PRIVATE',
    ],
    [
      '[youtube] abc: Join this channel to get access to members-only content like this video, and other exclusive perks.',
      'LOGIN_REQUIRED',
    ],
    [
      '[vimeo] 123: This video requires login. Use --cookies, --cookies-from-browser, --username and --password',
      'LOGIN_REQUIRED',
    ],
    [
      '[vimeo] 123: This video is protected by a password, use the --video-password option',
      'LOGIN_REQUIRED',
    ],
    ['[vimeo] 123: Wrong password', 'LOGIN_REQUIRED'],
    ['[fake] 1: Unable to login: Invalid username or password', 'LOGIN_REQUIRED'],
    [
      '[youtube] abc: Video unavailable. This video has been removed by the uploader',
      'MEDIA_UNAVAILABLE',
    ],
    ['[generic] Unable to download webpage: HTTP Error 404: Not Found', 'MEDIA_UNAVAILABLE'],
    ['[youtube] abc: Requested format is not available', 'EXTRACTION_FAILED'],
    [
      '[youtube] abc: Unable to download video data: HTTP Error 503: Service Unavailable',
      'UNAVAILABLE',
    ],
    ['[generic] Unable to download webpage: HTTP Error 502: Bad Gateway', 'UNAVAILABLE'],
    ['[youtube] abc: Unable to download API page: The read operation timed out', 'UNAVAILABLE'],
    [
      '[youtube] abc: Unable to download video data: HTTP Error 403: Forbidden',
      'EXTRACTION_FAILED',
    ],
  ])('maps "%s" to %s', (line, code) => {
    expect(classifyYtDlpError(err(line)).code).toBe(code);
  });

  it('uses the last ERROR line, without the extractor prefix, as the message', () => {
    const error = classifyYtDlpError('ERROR: first\nERROR: [youtube] abc123: Private video\n');
    expect(error.message).toBe('Private video');
  });

  it('reports a generic failure when yt-dlp printed no ERROR line', () => {
    expect(classifyYtDlpError('Traceback (most recent call last):\n  ...')).toMatchObject({
      code: 'EXTRACTION_FAILED',
      message: 'yt-dlp failed without an error message',
    });
  });
});

describe('errorMessage', () => {
  it('redacts credentials and truncates long messages', () => {
    const message = errorMessage(
      `ERROR: [generic] Unable to download https://proxy:secret@host/x?token=abc ${'x'.repeat(600)}`,
    );
    expect(message).toContain('https://[REDACTED]@host/x?token=[REDACTED]');
    expect(message).not.toContain('secret');
    expect(message?.length).toBe(500);
  });
});
