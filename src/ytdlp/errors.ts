import { AppError, type ErrorCode } from '../common/errors';
import { redactText } from '../common/redact';

/**
 * Maps yt-dlp's ERROR lines to stable error codes. Order matters: YouTube's bot and age
 * messages both start with "Sign in to confirm", and geo blocks begin with "Video unavailable".
 */
const RULES: readonly { code: ErrorCode; pattern: RegExp }[] = [
  { code: 'UNSUPPORTED_SITE', pattern: /Unsupported URL|No suitable extractor/i },
  {
    code: 'BOT_CHECK',
    pattern: /not a bot|confirm you.re not a robot|captcha|HTTP Error 429|Too Many Requests/i,
  },
  {
    code: 'MEDIA_AGE_GATED',
    pattern: /confirm your age|age[- ]restricted|inappropriate for some users/i,
  },
  {
    code: 'LIVE_NOT_STARTED',
    pattern:
      /live event will begin|Premieres? in \d|Premieres? in a few|stream has not (?:yet )?started|upcoming live/i,
  },
  {
    // Transient server-side trouble; retried by the queue (before MEDIA_UNAVAILABLE, which
    // would otherwise match "Service Unavailable").
    code: 'UNAVAILABLE',
    pattern:
      /HTTP Error 5\d\d|Service Unavailable|Internal Server Error|Bad Gateway|Gateway Time-?out|timed out|Connection reset|Temporary failure in name resolution/i,
  },
  {
    code: 'MEDIA_GEO_BLOCKED',
    pattern:
      /available (?:in|from) your (?:country|location|region)|geo[- ]?restrict|blocked (?:it )?in your country/i,
  },
  {
    code: 'MEDIA_PRIVATE',
    pattern: /private (?:video|playlist|account)|(?:video|playlist) is private/i,
  },
  {
    code: 'LOGIN_REQUIRED',
    pattern:
      /login required|log ?in (?:is )?required|unable to log ?in|sign in to|members[- ]only|Join this channel|requires? (?:a )?(?:subscription|login|authentication|premium)|--cookies|--username|--video-password|protected by a password|(?:wrong|incorrect|invalid) (?:username or )?password/i,
  },
  {
    code: 'MEDIA_UNAVAILABLE',
    pattern:
      /unavailable|has been removed|removed by|does not exist|not found|HTTP Error 4(?:04|10)|no longer available|terminated|deleted/i,
  },
];

const MAX_MESSAGE_LENGTH = 500;

/** The last ERROR line without its "ERROR: [extractor] id:" prefix, redacted and truncated. */
export function errorMessage(stderr: string): string | undefined {
  const lines = stderr.split('\n').filter((line) => line.startsWith('ERROR:'));
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const message = last
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*(?:[^\s:]+:\s*)?/, '')
    .trim();
  return redactText(message).slice(0, MAX_MESSAGE_LENGTH);
}

export function classifyYtDlpError(stderr: string): AppError {
  const message = errorMessage(stderr);
  if (message === undefined)
    return new AppError('EXTRACTION_FAILED', 'yt-dlp failed without an error message');
  const rule = RULES.find((candidate) => candidate.pattern.test(message));
  return new AppError(rule?.code ?? 'EXTRACTION_FAILED', message);
}
