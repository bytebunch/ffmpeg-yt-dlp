import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, lt } from 'drizzle-orm';

import type { AuthContext } from '../auth/api-keys';
import { requireUserId } from '../auth/request-auth';
import { AppError } from '../common/errors';
import { decryptSecret, encryptSecret } from '../common/secrets';
import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { type DriveConnection, driveConnections, oauthStates } from '../db/schema';
import { DriveClient, FOLDER_MIME } from './drive-client';
import { DriveRevokedError, GoogleOAuth } from './google-oauth';

export interface Owner {
  clientId: string;
  userId: string;
}

/** What the callback page tells the user. */
export type CallbackResult = { ok: true; email: string | null } | { ok: false; reason: string };

const context = (owner: Owner) => `drive:${owner.clientId}:${owner.userId}`;
export const folderLink = (id: string) => `https://drive.google.com/drive/folders/${id}`;
export const ROOT_FOLDER = 'Media downloads';

/**
 * Per-user Drive connections (SPEC §4, §11): consent links with single-use state, the OAuth
 * callback, status, disconnect with revocation, and access tokens for uploads and reads.
 */
@Injectable()
export class DriveConnections {
  private readonly logger = new Logger(DriveConnections.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    private readonly oauth: GoogleOAuth,
  ) {}

  /** A consent URL for this user; the state is good once, for OAUTH_STATE_TTL_MINUTES. */
  async connect(auth: AuthContext) {
    this.oauth.requireConfigured();
    const userId = requireUserId(auth);
    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.OAUTH_STATE_TTL_MINUTES * 60_000);
    await this.db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
    await this.db.insert(oauthStates).values({ state, clientId: auth.clientId, userId, expiresAt });
    return { consent_url: this.oauth.consentUrl(state), expires_at: expiresAt.toISOString() };
  }

  /** The Google redirect: consumes the state, exchanges the code, stores the encrypted token. */
  async complete(query: {
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
  }): Promise<CallbackResult> {
    if (!this.oauth.configured)
      return { ok: false, reason: 'Google Drive is not configured on this server.' };
    if (!query.state || query.state.length > 200)
      return { ok: false, reason: 'This sign-in link is not valid.' };
    const [pending] = await this.db
      .delete(oauthStates)
      .where(and(eq(oauthStates.state, query.state), gt(oauthStates.expiresAt, new Date())))
      .returning();
    if (!pending)
      return {
        ok: false,
        reason: 'This sign-in link has expired or was already used. Ask for a new one.',
      };
    if (query.error !== undefined || !query.code)
      return { ok: false, reason: 'Google Drive access was not granted.' };
    const owner = { clientId: pending.clientId, userId: pending.userId };
    let granted;
    try {
      granted = await this.oauth.exchange(query.code);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return {
        ok: false,
        reason: 'Google did not accept the sign-in. Ask for a new link and try again.',
      };
    }
    const [key] = this.config.TOKEN_ENCRYPTION_KEYS;
    if (!key) throw new Error('No encryption key configured');
    const values = {
      googleEmail: granted.email,
      refreshTokenEnc: encryptSecret(
        this.config.TOKEN_ENCRYPTION_KEYS,
        context(owner),
        granted.refreshToken,
      ),
      keyVersion: key.version,
      status: 'connected',
      updatedAt: new Date(),
    };
    await this.db
      .insert(driveConnections)
      .values({ ...owner, ...values })
      .onConflictDoUpdate({
        target: [driveConnections.clientId, driveConnections.userId],
        set: values,
      });
    return { ok: true, email: granted.email };
  }

  async status(auth: AuthContext) {
    const connection = await this.find({ clientId: auth.clientId, userId: requireUserId(auth) });
    if (!connection)
      return {
        connected: false,
        status: 'not_connected',
        google_email: null,
        root_folder: null,
        connected_at: null,
      };
    return {
      connected: connection.status === 'connected',
      status: connection.status,
      google_email: connection.googleEmail,
      root_folder:
        connection.rootFolderId === null
          ? null
          : { id: connection.rootFolderId, link: folderLink(connection.rootFolderId) },
      connected_at: connection.createdAt.toISOString(),
    };
  }

  /** Revokes the token at Google (best effort) and forgets the connection. */
  async disconnect(auth: AuthContext) {
    const owner = { clientId: auth.clientId, userId: requireUserId(auth) };
    const connection = await this.find(owner);
    if (!connection) throw new AppError('DRIVE_NOT_CONNECTED', 'Google Drive is not connected');
    const revoked = await this.oauth.revoke(this.refreshToken(connection));
    if (!revoked)
      this.logger.warn({ connectionId: connection.id }, 'Google did not confirm the revocation');
    await this.db.delete(driveConnections).where(eq(driveConnections.id, connection.id));
    return { disconnected: true, revoked_at_google: revoked };
  }

  /** Whether this user has a working connection (for reads that may fall back to the API key). */
  async isConnected(owner: Owner): Promise<boolean> {
    if (!this.oauth.configured) return false;
    return (await this.find(owner))?.status === 'connected';
  }

  /** At job creation: Drive delivery needs a working connection (no call to Google). */
  async requireConnected(owner: Owner): Promise<void> {
    this.oauth.requireConfigured();
    const connection = await this.find(owner);
    if (!connection)
      throw new AppError(
        'DRIVE_NOT_CONNECTED',
        'Google Drive is not connected (POST /v1/drive/connect)',
      );
    if (connection.status !== 'connected') throw new DriveRevokedError();
  }

  /** The connection with a fresh access token; invalid_grant marks it revoked (SPEC §11). */
  async session(owner: Owner): Promise<{ connection: DriveConnection; accessToken: string }> {
    const connection = await this.find(owner);
    if (!connection)
      throw new AppError(
        'DRIVE_NOT_CONNECTED',
        'Google Drive is not connected (POST /v1/drive/connect)',
        undefined,
        {},
        false,
      );
    if (connection.status !== 'connected') throw new DriveRevokedError();
    try {
      return {
        connection,
        accessToken: await this.oauth.accessToken(this.refreshToken(connection)),
      };
    } catch (error) {
      if (error instanceof DriveRevokedError) {
        await this.db
          .update(driveConnections)
          .set({ status: 'revoked', updatedAt: new Date() })
          .where(eq(driveConnections.id, connection.id));
      }
      throw error;
    }
  }

  /** A Drive client for this user; its token refreshes itself after a 401. */
  async client(owner: Owner): Promise<{ client: DriveClient; connection: DriveConnection }> {
    const session = await this.session(owner);
    let accessToken = session.accessToken;
    const token = async (refresh = false) => {
      if (refresh) accessToken = (await this.session(owner)).accessToken;
      return accessToken;
    };
    return { client: new DriveClient({ token }), connection: session.connection };
  }

  /**
   * The user's "Media downloads" folder (SPEC §11), created on first use and again if the user
   * deleted it. The row lock keeps two jobs finishing together from creating two.
   */
  async ensureRoot(owner: Owner, client: DriveClient): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(driveConnections)
        .where(
          and(
            eq(driveConnections.clientId, owner.clientId),
            eq(driveConnections.userId, owner.userId),
          ),
        )
        .for('update');
      if (!locked)
        throw new AppError(
          'DRIVE_NOT_CONNECTED',
          'Google Drive is not connected',
          undefined,
          {},
          false,
        );
      if (locked.rootFolderId !== null) {
        try {
          return (await client.folder(locked.rootFolderId)).id;
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'DRIVE_FOLDER_NOT_ACCESSIBLE'))
            throw error;
        }
      }
      const root = await client.createFolder(ROOT_FOLDER);
      await tx
        .update(driveConnections)
        .set({ rootFolderId: root.id, updatedAt: new Date() })
        .where(eq(driveConnections.id, locked.id));
      return root.id;
    });
  }

  /** GET /v1/drive/files: what this service created in the user's Drive. */
  async files(auth: AuthContext, page: { cursor?: string | undefined; limit: number }) {
    const { client } = await this.client({ clientId: auth.clientId, userId: requireUserId(auth) });
    const listed = await client.list(page.cursor, page.limit);
    return {
      files: listed.files.map((file) => ({
        id: file.id,
        name: file.name,
        mime: file.mimeType,
        is_folder: file.mimeType === FOLDER_MIME,
        size_bytes: file.size === undefined ? null : Number(file.size),
        link: file.webViewLink ?? (file.mimeType === FOLDER_MIME ? folderLink(file.id) : null),
        parent_id: file.parents?.[0] ?? null,
        created_at: file.createdTime ?? null,
      })),
      next_cursor: listed.nextPageToken ?? null,
    };
  }

  /** Re-encrypts refresh tokens still on an older key (key rotation, SPEC §12). */
  async reencrypt(): Promise<number> {
    const keys = this.config.TOKEN_ENCRYPTION_KEYS;
    const [current] = keys;
    if (!current) return 0;
    let count = 0;
    for (const connection of await this.db.select().from(driveConnections)) {
      if (connection.keyVersion === current.version) continue;
      const owner = { clientId: connection.clientId, userId: connection.userId };
      await this.db
        .update(driveConnections)
        .set({
          refreshTokenEnc: encryptSecret(keys, context(owner), this.refreshToken(connection)),
          keyVersion: current.version,
        })
        .where(eq(driveConnections.id, connection.id));
      count++;
    }
    return count;
  }

  private refreshToken(connection: DriveConnection): string {
    return decryptSecret(
      this.config.TOKEN_ENCRYPTION_KEYS,
      context(connection),
      connection.refreshTokenEnc,
    );
  }

  private async find(owner: Owner): Promise<DriveConnection | undefined> {
    const [connection] = await this.db
      .select()
      .from(driveConnections)
      .where(
        and(
          eq(driveConnections.clientId, owner.clientId),
          eq(driveConnections.userId, owner.userId),
        ),
      );
    return connection;
  }
}
