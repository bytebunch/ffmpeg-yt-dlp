import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sslOptions } from './database';

describe('sslOptions', () => {
  const caFile = path.join(mkdtempSync(path.join(tmpdir(), 'ca-')), 'ca.pem');
  writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');

  it('turns TLS off for disable', () => {
    expect(sslOptions({ DATABASE_SSL_MODE: 'disable', DATABASE_SSL_CA_FILE: undefined })).toBe(
      false,
    );
  });

  it('encrypts without verification for require, as libpq does', () => {
    expect(sslOptions({ DATABASE_SSL_MODE: 'require', DATABASE_SSL_CA_FILE: undefined })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('verifies the chain but not the host name for verify-ca', () => {
    const options = sslOptions({ DATABASE_SSL_MODE: 'verify-ca', DATABASE_SSL_CA_FILE: caFile });
    expect(options).toMatchObject({ rejectUnauthorized: true });
    expect(options && options.ca).toContain('BEGIN CERTIFICATE');
    expect(options && options.checkServerIdentity?.('db.example', {} as never)).toBeUndefined();
  });

  it('verifies chain and host name for verify-full, with system CAs when no file is given', () => {
    expect(
      sslOptions({ DATABASE_SSL_MODE: 'verify-full', DATABASE_SSL_CA_FILE: undefined }),
    ).toEqual({
      ca: undefined,
      rejectUnauthorized: true,
    });
  });
});
