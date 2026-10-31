import { describe, expect, it } from 'vitest';

import { AppError } from '../common/errors';
import { COOKIES_MAX_BYTES, NETSCAPE_HEADER, parseCookieFile } from './cookie-file';

const NOW = Date.UTC(2026, 9, 31);
const future = Math.floor(NOW / 1000) + 86_400;
const later = future + 86_400;
const row = (...fields: (string | number)[]) => fields.join('\t');

const message = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION_FAILED');
    return (error as AppError).message;
  }
  throw new Error('expected a validation error');
};

describe('parseCookieFile', () => {
  it('keeps unexpired cookies, HttpOnly rows and session cookies, and reports domains and expiry', () => {
    const file = [
      '# Netscape HTTP Cookie File',
      '# exported by a browser extension',
      '',
      row('.youtube.com', 'TRUE', '/', 'TRUE', future, 'SID', 'abc'),
      row('#HttpOnly_.YouTube.com', 'TRUE', '/', 'TRUE', later, 'HSID', 'def'),
      row('accounts.google.com', 'FALSE', '/', 'TRUE', 0, 'session', ''),
      row('.old.example', 'TRUE', '/', 'FALSE', 1000, 'gone', 'x'),
    ].join('\r\n');
    const parsed = parseCookieFile(file, NOW);
    expect(parsed.count).toBe(3);
    expect(parsed.domains).toEqual(['accounts.google.com', 'youtube.com']);
    expect(parsed.expiresAt?.getTime()).toBe(later * 1000);
    expect(parsed.text.split('\n')[0]).toBe(NETSCAPE_HEADER);
    expect(parsed.text).toContain('#HttpOnly_.YouTube.com\tTRUE');
    expect(parsed.text).not.toContain('gone');
  });

  it('has no expiry when every cookie is a session cookie', () => {
    expect(
      parseCookieFile(row('example.com', 'FALSE', '/', 'FALSE', 0, 'a', 'b'), NOW).expiresAt,
    ).toBeNull();
  });

  it('refuses JSON exports, malformed rows and empty jars with the line number', () => {
    expect(message(() => parseCookieFile('[{"name":"SID"}]', NOW))).toMatch(/not JSON/);
    expect(message(() => parseCookieFile('example.com TRUE / FALSE 0 a b', NOW))).toMatch(
      /line 1: expected 7/,
    );
    expect(
      message(() => parseCookieFile(row('bad_domain!', 'TRUE', '/', 'FALSE', 0, 'a', 'b'), NOW)),
    ).toMatch(/domain/);
    expect(
      message(() => parseCookieFile(row('a.com', 'YES', '/', 'FALSE', 0, 'a', 'b'), NOW)),
    ).toMatch(/flags/);
    expect(
      message(() => parseCookieFile(row('a.com', 'TRUE', 'x', 'FALSE', 0, 'a', 'b'), NOW)),
    ).toMatch(/path/);
    expect(
      message(() => parseCookieFile(row('a.com', 'TRUE', '/', 'FALSE', '-1', 'a', 'b'), NOW)),
    ).toMatch(/expiry/);
    expect(
      message(() => parseCookieFile(row('a.com', 'TRUE', '/', 'FALSE', 0, '', 'b'), NOW)),
    ).toMatch(/no name/);
    expect(
      message(() =>
        parseCookieFile(`# header\n${row('a.com', 'TRUE', '/', 'FALSE', 0, 'a', 'b\u0007')}`, NOW),
      ),
    ).toMatch(/line 2: contains control/);
    expect(message(() => parseCookieFile('# only comments\n', NOW))).toMatch(
      /no unexpired cookies/,
    );
    expect(
      message(() => parseCookieFile(row('a.com', 'TRUE', '/', 'FALSE', 1000, 'a', 'b'), NOW)),
    ).toMatch(/no unexpired/);
  });

  it('caps the file size', () => {
    expect(message(() => parseCookieFile('#'.repeat(COOKIES_MAX_BYTES + 1), NOW))).toMatch(
      /larger than 1 MB/,
    );
  });
});
