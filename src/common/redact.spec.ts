import { describe, expect, it } from 'vitest';

import { redactText, redactUrl } from './redact';

describe('redactUrl', () => {
  it('redacts signatures and tokens in bare request paths', () => {
    expect(redactUrl('/d/abc?exp=1700000000&sig=s3cr3t')).toBe(
      '/d/abc?exp=1700000000&sig=[REDACTED]',
    );
    expect(redactUrl('/oauth/google/callback?code=4/abc&state=xyz')).toBe(
      '/oauth/google/callback?code=[REDACTED]&state=xyz',
    );
  });

  it('redacts userinfo and secret parameters in absolute URLs', () => {
    expect(redactUrl('http://user:pw@proxy.example:8000/path?token=t&x=1')).toBe(
      'http://[REDACTED]@proxy.example:8000/path?token=[REDACTED]&x=1',
    );
  });

  it('leaves ordinary URLs untouched', () => {
    expect(redactUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1',
    );
    expect(redactUrl('/v1/jobs?status=running')).toBe('/v1/jobs?status=running');
  });

  it('matches parameter names case-insensitively', () => {
    expect(redactUrl('/x?SIG=abc')).toBe('/x?SIG=[REDACTED]');
  });
});

describe('redactText', () => {
  it('redacts bearer tokens, API keys and URLs with credentials inside free text', () => {
    const text =
      'GET https://dl.example.com/d/1?exp=2&sig=abc failed; Authorization: Bearer mk_abcdefgh_XYZ123; key mk_12345678_zzz';
    expect(redactText(text)).toBe(
      'GET https://dl.example.com/d/1?exp=2&sig=[REDACTED] failed; Authorization: Bearer [REDACTED]; key [REDACTED]',
    );
  });
});
