import { createHash, randomBytes } from 'node:crypto';

import { and, asc, eq, isNull } from 'drizzle-orm';
import { DatabaseError } from 'pg';

import { AppError } from '../common/errors';
import type { Database } from '../db/database';
import { apiKeys, clients } from '../db/schema';

/** `mk_` followed by 32 base64url characters (24 random bytes). */
export const API_KEY_PATTERN = /^mk_[A-Za-z0-9_-]{32}$/;
/** Client names double as inbox folder names (INBOX_DIR/<client>/), so they stay path-safe. */
export const CLIENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Opaque end-user ids supplied by clients (SPEC §3). */
export const USER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

const PREFIX_LENGTH = 11; // "mk_" + 8 characters, shown in listings and used to revoke
const CREATE_ATTEMPTS = 3;

export function generateApiKey(): string {
  return `mk_${randomBytes(24).toString('base64url')}`;
}

/** Keys are stored only as SHA-256 hashes: they are 192-bit random, so no slow KDF is needed. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function keyPrefix(key: string): string {
  return key.slice(0, PREFIX_LENGTH);
}

export interface AuthContext {
  keyId: string;
  clientId: string;
  clientName: string;
  userId: string | undefined;
  shareOutputsWithinClient: boolean;
}

export interface KeyRecord {
  keyId: string;
  clientId: string;
  clientName: string;
  defaultUserId: string | null;
  shareOutputsWithinClient: boolean;
}

export interface CreatedKey {
  key: string;
  prefix: string;
  keyId: string;
  clientId: string;
}

export interface KeySummary {
  prefix: string;
  clientName: string;
  defaultUserId: string | null;
  shareOutputsWithinClient: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type KeySelector = { prefix: string } | { key: string };

function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error && 'cause' in error ? error.cause : error;
  return cause instanceof DatabaseError && cause.code === '23505';
}

export class ApiKeyService {
  constructor(private readonly db: Database) {}

  async create(options: {
    clientName: string;
    defaultUserId?: string | undefined;
    shareOutputsWithinClient?: boolean | undefined;
  }): Promise<CreatedKey> {
    if (!CLIENT_NAME_PATTERN.test(options.clientName)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Client names are 1-64 characters: lowercase letters, digits, "-" and "_", starting with a letter or digit',
      );
    }
    if (options.defaultUserId !== undefined && !USER_ID_PATTERN.test(options.defaultUserId)) {
      throw new AppError('VALIDATION_FAILED', 'The default user id has an invalid format');
    }
    for (let attempt = 1; ; attempt++) {
      const key = generateApiKey();
      try {
        return await this.insert(key, options);
      } catch (error) {
        // A 48-bit prefix collision is astronomically rare; a fresh key resolves it.
        if (!isUniqueViolation(error) || attempt >= CREATE_ATTEMPTS) throw error;
      }
    }
  }

  private insert(
    key: string,
    options: {
      clientName: string;
      defaultUserId?: string | undefined;
      shareOutputsWithinClient?: boolean | undefined;
    },
  ): Promise<CreatedKey> {
    return this.db.transaction(async (tx) => {
      await tx.insert(clients).values({ name: options.clientName }).onConflictDoNothing();
      const [client] = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.name, options.clientName));
      if (!client) throw new Error(`Client ${options.clientName} vanished during key creation`);
      const prefix = keyPrefix(key);
      const [row] = await tx
        .insert(apiKeys)
        .values({
          clientId: client.id,
          keyHash: hashApiKey(key),
          prefix,
          defaultUserId: options.defaultUserId ?? null,
          shareOutputsWithinClient: options.shareOutputsWithinClient ?? false,
        })
        .returning({ id: apiKeys.id });
      if (!row) throw new Error('Inserting the API key returned no row');
      return { key, prefix, keyId: row.id, clientId: client.id };
    });
  }

  /** Revokes the matching active key; returns how many keys were revoked (0 or 1). */
  async revoke(selector: KeySelector): Promise<number> {
    const condition =
      'key' in selector
        ? eq(apiKeys.keyHash, hashApiKey(selector.key))
        : eq(apiKeys.prefix, selector.prefix);
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(condition, isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return rows.length;
  }

  async list(clientName?: string): Promise<KeySummary[]> {
    return this.db
      .select({
        prefix: apiKeys.prefix,
        clientName: clients.name,
        defaultUserId: apiKeys.defaultUserId,
        shareOutputsWithinClient: apiKeys.shareOutputsWithinClient,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .innerJoin(clients, eq(clients.id, apiKeys.clientId))
      .where(clientName === undefined ? undefined : eq(clients.name, clientName))
      .orderBy(asc(clients.name), asc(apiKeys.createdAt));
  }

  /** The active key matching `key`, or undefined for unknown and revoked keys. */
  async authenticate(key: string): Promise<KeyRecord | undefined> {
    const [row] = await this.db
      .select({
        keyId: apiKeys.id,
        clientId: clients.id,
        clientName: clients.name,
        defaultUserId: apiKeys.defaultUserId,
        shareOutputsWithinClient: apiKeys.shareOutputsWithinClient,
      })
      .from(apiKeys)
      .innerJoin(clients, eq(clients.id, apiKeys.clientId))
      .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)));
    return row;
  }

  async touch(keyId: string): Promise<void> {
    await this.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyId));
  }
}
