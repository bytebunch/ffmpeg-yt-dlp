const SECRET_QUERY_PARAMS = new Set(['sig', 'token', 'key', 'api_key', 'access_token', 'code']);
const REDACTED = '[REDACTED]';

/**
 * Removes credentials from a URL or request path before it is logged: signed-link signatures,
 * tokens and userinfo (SPEC §12: logs redact signed URLs, API keys, tokens and cookies).
 * Works on absolute URLs and on bare paths such as `/d/abc?exp=1&sig=xyz`.
 */
export function redactUrl(value: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  let url: URL;
  try {
    url = new URL(value, 'http://redact.invalid');
  } catch {
    return REDACTED;
  }
  if (url.username || url.password) {
    url.username = url.username ? REDACTED : '';
    url.password = '';
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_PARAMS.has(name.toLowerCase())) url.searchParams.set(name, REDACTED);
  }
  const text = url.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
  return absolute ? text : text.slice('http://redact.invalid'.length);
}

const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;
const API_KEY = /\bmk_[A-Za-z0-9_-]{8,}/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/g;

/** Redacts credentials inside free text such as subprocess output. */
export function redactText(text: string): string {
  return text
    .replace(URL_PATTERN, (url) => redactUrl(url))
    .replace(BEARER, `$1${REDACTED}`)
    .replace(API_KEY, REDACTED);
}
