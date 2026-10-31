import { describe, expect, it } from 'vitest';

import { AppError } from '../common/errors';
import { guardUrl, isBlockedAddress, type Resolver } from './url-guard';

const resolvesTo =
  (...addresses: string[]): Resolver =>
  () =>
    Promise.resolve(addresses);

async function rejection(url: string, resolver: Resolver = resolvesTo('93.184.215.14')) {
  try {
    await guardUrl(url, resolver);
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
}

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.100.100.200',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002:a00:1::',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '93.184.215.14',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('guardUrl', () => {
  it('accepts public http(s) URLs and returns the parsed URL', async () => {
    const url = await guardUrl('https://www.youtube.com/watch?v=abc', resolvesTo('142.250.1.1'));
    expect(url.hostname).toBe('www.youtube.com');
  });

  it.each([
    ['ftp://example.com/x', 'Only http and https'],
    ['file:///etc/passwd', 'Only http and https'],
    ['javascript:alert(1)', 'Only http and https'],
    ['https://user:pw@example.com/', 'must not contain credentials'],
    ['not a url', 'Not a valid URL'],
    [`https://example.com/${'a'.repeat(2048)}`, 'limited to 2048'],
  ])('rejects %s', async (url, message) => {
    const result = await rejection(url);
    expect(result?.code).toBe('URL_NOT_ALLOWED');
    expect(result?.message).toContain(message);
  });

  it('rejects IP literals in blocked ranges, including bracketed IPv6', async () => {
    for (const url of [
      'http://127.0.0.1:8080/',
      'http://169.254.169.254/latest',
      'http://[::1]/',
      'http://[fd00:ec2::254]/',
    ]) {
      expect((await rejection(url))?.code).toBe('URL_NOT_ALLOWED');
    }
  });

  it('rejects hosts when any resolved address is private (DNS rebinding with mixed answers)', async () => {
    expect(
      await rejection('https://evil.example/', resolvesTo('93.184.215.14', '10.0.0.5')),
    ).toEqual({
      code: 'URL_NOT_ALLOWED',
      message: 'The URL points to a private or reserved address',
    });
  });

  it('rejects hosts that do not resolve', async () => {
    const failing: Resolver = () => Promise.reject(new Error('ENOTFOUND'));
    expect((await rejection('https://nowhere.invalid/', failing))?.message).toMatch(
      /could not be resolved/,
    );
    expect((await rejection('https://empty.example/', resolvesTo()))?.message).toMatch(
      /could not be resolved/,
    );
  });

  it('resolves localhost through the system resolver and blocks it', async () => {
    await expect(guardUrl('http://localhost:3000/')).rejects.toMatchObject({
      code: 'URL_NOT_ALLOWED',
    });
  });
});
