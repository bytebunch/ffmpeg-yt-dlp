import { describe, expect, it } from 'vitest';

import { describeMigrationFailure } from './migrations';

// install.sh shows the last line `migrate` prints when it checks an outside database, so a
// failure must come out as one line that names the cause.
describe('describeMigrationFailure', () => {
  it('names the error in one line', () => {
    expect(describeMigrationFailure(new Error('getaddrinfo ENOTFOUND db.example.com'))).toBe(
      'Migrations failed: getaddrinfo ENOTFOUND db.example.com',
    );
  });

  it('adds the Postgres error code when there is one', () => {
    const error = Object.assign(new Error('password authentication failed for user "media"'), {
      code: '28P01',
    });
    expect(describeMigrationFailure(error)).toBe(
      'Migrations failed: password authentication failed for user "media" (28P01)',
    );
  });

  it('uses the first underlying error when connecting to every address failed', () => {
    const error = new AggregateError(
      [new Error('connect ECONNREFUSED 203.0.113.7:5432'), new Error('connect ENETUNREACH ::1')],
      '',
    );
    expect(describeMigrationFailure(error)).toBe(
      'Migrations failed: connect ECONNREFUSED 203.0.113.7:5432',
    );
  });

  it('keeps only the first line of a long message', () => {
    expect(describeMigrationFailure(new Error('self-signed certificate\n    at TLSSocket'))).toBe(
      'Migrations failed: self-signed certificate',
    );
  });

  it('describes values that are not errors', () => {
    expect(describeMigrationFailure('timeout')).toBe('Migrations failed: timeout');
  });
});
