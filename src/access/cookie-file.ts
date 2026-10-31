import { AppError } from '../common/errors';
import { hasControlCharacters } from '../recipes/values';

export const COOKIES_MAX_BYTES = 1024 * 1024;
export const COOKIES_MAX_COUNT = 5000;
export const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';

const HTTP_ONLY = '#HttpOnly_';
const DOMAIN =
  /^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const FLAG = /^(?:TRUE|FALSE)$/i;

export interface ParsedCookies {
  /** The jar as stored and handed to yt-dlp: header plus the unexpired cookies. */
  text: string;
  /** Cookie domains without the leading dot, lowercase, sorted. */
  domains: string[];
  count: number;
  /** When the last persistent cookie expires; null when every cookie is a session cookie. */
  expiresAt: Date | null;
}

function invalid(message: string, line?: number): AppError {
  return new AppError(
    'VALIDATION_FAILED',
    line === undefined ? message : `cookies line ${line}: ${message}`,
  );
}

/**
 * Validates a Netscape cookie file (the format browser exporters and yt-dlp use) and keeps the
 * unexpired cookies. Nothing else is accepted: the file is written verbatim for `--cookies`.
 */
export function parseCookieFile(input: string, now = Date.now()): ParsedCookies {
  if (Buffer.byteLength(input) > COOKIES_MAX_BYTES)
    throw invalid('the cookie file is larger than 1 MB');
  const trimmed = input.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    throw invalid('cookies must be a Netscape cookie file (cookies.txt), not JSON');
  }
  const lines: string[] = [];
  const domains = new Set<string>();
  let latest = 0;
  input.split(/\r?\n/).forEach((raw, index) => {
    const number = index + 1;
    const httpOnly = raw.startsWith(HTTP_ONLY);
    if (raw.trim() === '' || (raw.startsWith('#') && !httpOnly)) return;
    // Tab separates the fields; any other control character is refused.
    if (hasControlCharacters(raw.replaceAll('\t', ' ')))
      throw invalid('contains control characters', number);
    const fields = (httpOnly ? raw.slice(HTTP_ONLY.length) : raw).split('\t');
    if (fields.length !== 7)
      throw invalid(`expected 7 tab-separated fields, found ${fields.length}`, number);
    const [domain = '', subdomains = '', path = '', secure = '', expiry = '', name = ''] = fields;
    if (!DOMAIN.test(domain)) throw invalid('the domain is not valid', number);
    if (!FLAG.test(subdomains) || !FLAG.test(secure))
      throw invalid('flags must be TRUE or FALSE', number);
    if (!path.startsWith('/')) throw invalid('the path must start with /', number);
    if (!/^\d{1,12}$/.test(expiry)) throw invalid('the expiry must be a Unix timestamp', number);
    if (name === '') throw invalid('the cookie has no name', number);
    const expires = Number(expiry) * 1000;
    if (expires !== 0 && expires <= now) return;
    if (lines.length === COOKIES_MAX_COUNT) throw invalid(`more than ${COOKIES_MAX_COUNT} cookies`);
    latest = Math.max(latest, expires);
    domains.add(domain.replace(/^\./, '').toLowerCase());
    lines.push(raw);
  });
  if (lines.length === 0) throw invalid('the cookie file has no unexpired cookies');
  return {
    text: [NETSCAPE_HEADER, '', ...lines, ''].join('\n'),
    domains: [...domains].sort(),
    count: lines.length,
    expiresAt: latest === 0 ? null : new Date(latest),
  };
}
