import { describe, expect, it, vi } from 'vitest';

import type { ApiKeyService } from './auth/api-keys';
import { runCli } from './cli';

function setup(overrides: { revoke?: number; list?: unknown[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const create = vi.fn().mockResolvedValue({
    key: 'mk_KEY',
    prefix: 'mk_KEYPREFX',
    keyId: 'k1',
    clientId: 'c1',
  });
  const revoke = vi.fn().mockResolvedValue(overrides.revoke ?? 1);
  const list = vi.fn().mockResolvedValue(overrides.list ?? []);
  const keys = { create, revoke, list } as unknown as ApiKeyService;
  const reencrypt = vi.fn().mockResolvedValue({ cookies: 2, credentials: 1, drive: 3 });
  const run = (args: string[]) =>
    runCli(
      args,
      { keys, reencrypt },
      { out: (line) => out.push(line), err: (line) => err.push(line) },
    );
  return { create, revoke, reencrypt, out, err, run };
}

describe('runCli', () => {
  it('secrets:reencrypt reports what it re-encrypted and takes no arguments', async () => {
    const { reencrypt, out, err, run } = setup();
    expect(await run(['secrets:reencrypt'])).toBe(0);
    expect(reencrypt).toHaveBeenCalledOnce();
    expect(out).toEqual([
      'Re-encrypted 2 cookie jar(s), 1 credential(s) and 3 Drive connection(s).',
    ]);
    expect(await run(['secrets:reencrypt', 'extra'])).toBe(2);
    expect(err.join('\n')).toMatch(/Wrong arguments for secrets:reencrypt/);
  });

  it('keys:create --quiet prints only the key, as install.sh expects', async () => {
    const { create, out, run } = setup();
    expect(await run(['keys:create', 'default', '--quiet'])).toBe(0);
    expect(out).toEqual(['mk_KEY']);
    expect(create).toHaveBeenCalledWith({
      clientName: 'default',
      defaultUserId: undefined,
      shareOutputsWithinClient: undefined,
    });
  });

  it('keys:create passes the default user and sharing flag', async () => {
    const { create, out, run } = setup();
    expect(await run(['keys:create', 'app', '--default-user', 'u1', '--share-outputs'])).toBe(0);
    expect(create).toHaveBeenCalledWith({
      clientName: 'app',
      defaultUserId: 'u1',
      shareOutputsWithinClient: true,
    });
    expect(out.join('\n')).toContain('cannot be shown again');
  });

  it('keys:revoke accepts a prefix or --key, but not both', async () => {
    const { revoke, run } = setup();
    expect(await run(['keys:revoke', 'mk_abcdefgh'])).toBe(0);
    expect(revoke).toHaveBeenLastCalledWith({ prefix: 'mk_abcdefgh' });
    expect(await run(['keys:revoke', '--key', 'mk_full'])).toBe(0);
    expect(revoke).toHaveBeenLastCalledWith({ key: 'mk_full' });
    expect(await run(['keys:revoke', 'mk_abcdefgh', '--key', 'mk_full'])).toBe(2);
    expect(await run(['keys:revoke'])).toBe(2);
  });

  it('keys:revoke fails when nothing matched', async () => {
    const { err, run } = setup({ revoke: 0 });
    expect(await run(['keys:revoke', 'mk_nothing0'])).toBe(1);
    expect(err).toEqual(['No active key matches.']);
  });

  it('keys:list prints a tab-separated table', async () => {
    const { out, run } = setup({
      list: [
        {
          prefix: 'mk_abcdefgh',
          clientName: 'app',
          defaultUserId: null,
          shareOutputsWithinClient: false,
          createdAt: new Date('2026-10-31T10:00:00Z'),
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
    });
    expect(await run(['keys:list'])).toBe(0);
    expect(out[1]).toBe('mk_abcdefgh\tapp\t-\t2026-10-31 10:00\t-\t-');
  });

  it('returns 2 with usage for unknown commands, unknown flags and missing arguments', async () => {
    const { err, run } = setup();
    expect(await run(['keys:nope'])).toBe(2);
    expect(await run(['keys:create', 'app', '--bogus'])).toBe(2);
    expect(await run(['keys:create'])).toBe(2);
    expect(await run([])).toBe(2);
    expect(err.every((message) => message.includes('Usage:'))).toBe(true);
  });

  it('--help prints usage and succeeds', async () => {
    const { out, run } = setup();
    expect(await run(['--help'])).toBe(0);
    expect(out[0]).toContain('keys:create');
  });
});
