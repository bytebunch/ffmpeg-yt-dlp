import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { accessArgs, selectProxy, youtubeExtractorArgs } from './access-args';
import { SECRETS_KEY, sealedPart, sealSecrets, unsealSecrets } from './sealed';

describe('accessArgs (SPEC §7f)', () => {
  it('maps each resolved option to its yt-dlp flag', () => {
    expect(accessArgs({})).toEqual([]);
    expect(accessArgs({ cookieFile: '/w/.access/cookies.txt' })).toEqual([
      '--cookies',
      '/w/.access/cookies.txt',
    ]);
    expect(accessArgs({ login: { username: 'u', password: 'p' } })).toEqual([
      '--username',
      'u',
      '--password',
      'p',
    ]);
    expect(accessArgs({ login: { username: 'u', password: 'p', twoFactor: '123456' } })).toEqual([
      '--username',
      'u',
      '--password',
      'p',
      '--twofactor',
      '123456',
    ]);
    expect(accessArgs({ secrets: { video_password: 'v' } })).toEqual(['--video-password', 'v']);
    expect(
      accessArgs({
        secrets: { tv_provider: { mso: 'Comcast_SSO', username: 'a', password: 'b' } },
      }),
    ).toEqual(['--ap-mso', 'Comcast_SSO', '--ap-username', 'a', '--ap-password', 'b']);
    expect(
      accessArgs({ proxyUrl: 'http://u:p@proxy:8080', geoCountry: 'GB', markWatched: true }),
    ).toEqual(['--proxy', 'http://u:p@proxy:8080', '--xff', 'GB', '--mark-watched']);
  });
});

describe('youtubeExtractorArgs', () => {
  it('composes one value from comments and the whitelisted keys, explicit keys winning', () => {
    expect(youtubeExtractorArgs(undefined)).toEqual([]);
    expect(youtubeExtractorArgs(undefined, { max: 50, sort: 'new' })).toEqual([
      '--extractor-args',
      'youtube:max_comments=50;comment_sort=new',
    ]);
    expect(
      youtubeExtractorArgs(
        { youtube: { player_client: ['tv', 'web_safari'], lang: 'de', max_comments: 10 } },
        { max: 50, sort: 'top' },
      ),
    ).toEqual([
      '--extractor-args',
      'youtube:player_client=tv,web_safari;lang=de;max_comments=10;comment_sort=top',
    ]);
  });
});

describe('selectProxy', () => {
  const pool = { residential: 'http://r:1', dc: 'http://d:2' };
  const defaults = { youtube: 'residential', vimeo: 'dc' };

  it('uses the requested name, else the extractor default, else none', () => {
    expect(selectProxy(pool, defaults, 'dc', { extractor: 'youtube' })).toBe('http://d:2');
    expect(selectProxy(pool, defaults, undefined, { extractor: 'Youtube' })).toBe('http://r:1');
    expect(selectProxy(pool, defaults, undefined, { extractor: 'youtube:tab' })).toBe('http://r:1');
    expect(selectProxy(pool, defaults, undefined, { extractor: 'twitch' })).toBeUndefined();
    expect(selectProxy(pool, {}, undefined, { extractor: 'youtube' })).toBeUndefined();
  });

  it('guesses the extractor from the URL before extraction', () => {
    expect(
      selectProxy(pool, defaults, undefined, { url: 'https://www.youtube.com/watch?v=x' }),
    ).toBe('http://r:1');
    expect(selectProxy(pool, defaults, undefined, { url: 'https://youtu.be/x' })).toBe(
      'http://r:1',
    );
    expect(
      selectProxy(pool, defaults, undefined, { url: 'https://player.vimeo.com/video/1' }),
    ).toBe('http://d:2');
    expect(
      selectProxy(pool, defaults, undefined, { url: 'https://example.com/v' }),
    ).toBeUndefined();
    expect(selectProxy(pool, defaults, undefined, { url: 'not a url' })).toBeUndefined();
  });
});

describe('sealed per-request secrets', () => {
  const keys = [{ version: 1, key: randomBytes(32) }];
  const owner = { clientId: 'c', userId: 'alice' };

  it('moves video_password and tv_provider into one encrypted value', () => {
    const tv = { mso: 'Comcast_SSO', username: 'a', password: 'b' };
    const sealed = sealSecrets(keys, owner, {
      preset: '720p',
      video_password: 'open-sesame-77',
      tv_provider: tv,
    });
    expect(Object.keys(sealed).sort()).toEqual([SECRETS_KEY, 'preset']);
    expect(JSON.stringify(sealed)).not.toContain('open-sesame-77');
    expect(unsealSecrets(keys, owner, sealed)).toEqual({
      video_password: 'open-sesame-77',
      tv_provider: tv,
    });
    expect(sealedPart(sealed)).toEqual({ [SECRETS_KEY]: sealed[SECRETS_KEY] });
    expect(() => unsealSecrets(keys, { ...owner, userId: 'bob' }, sealed)).toThrow();
  });

  it('leaves options without secrets alone', () => {
    const options = { preset: 'best' };
    expect(sealSecrets(keys, owner, options)).toBe(options);
    expect(unsealSecrets(keys, owner, options)).toBeUndefined();
    expect(sealedPart(options)).toEqual({});
  });
});
