import { Inject, Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

import { AppError } from '../common/errors';
import { APP_CONFIG } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';

/** drive.file: only files and folders the service created (SPEC §11); openid email for the account. */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];

export const CALLBACK_PATH = '/oauth/google/callback';

/** Google refused the refresh token: the user revoked access or the grant expired. */
export class DriveRevokedError extends AppError {
  constructor() {
    super(
      'DRIVE_RECONNECT_REQUIRED',
      'Google Drive access was revoked or has expired; connect again (POST /v1/drive/connect)',
      undefined,
      {},
      false,
    );
  }
}

/** Google's error body (`{ error: "invalid_grant" }`) as gaxios reports it. */
function oauthError(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } }).response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

/** The ID token's claims. It came straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7). */
function idTokenEmail(idToken: string | null | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (payload === undefined) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    email?: unknown;
  };
  return typeof claims.email === 'string' ? claims.email : null;
}

/**
 * Google OAuth for the per-user Drive connection: consent URL, code exchange, access tokens from
 * the stored refresh token, revocation. Requests go through the global fetch (undici), like every
 * other outbound call of the service.
 */
@Injectable()
export class GoogleOAuth {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get configured(): boolean {
    return (
      this.config.GOOGLE_CLIENT_ID !== undefined && this.config.GOOGLE_CLIENT_SECRET !== undefined
    );
  }

  requireConfigured(): void {
    if (!this.configured) {
      throw new AppError(
        'FEATURE_DISABLED',
        'Google Drive is not configured on this server (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)',
      );
    }
  }

  consentUrl(state: string): string {
    return this.client().generateAuthUrl({
      access_type: 'offline',
      // A refresh token on every consent, also when the user connected before.
      prompt: 'consent',
      scope: DRIVE_SCOPES,
      state,
    });
  }

  /** The authorization code → refresh token and the Google account's email. */
  async exchange(code: string): Promise<{ refreshToken: string; email: string | null }> {
    let tokens;
    try {
      ({ tokens } = await this.client().getToken(code));
    } catch (error) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Google did not accept the sign-in (${oauthError(error) ?? 'unknown error'})`,
      );
    }
    if (!tokens.refresh_token)
      throw new AppError('VALIDATION_FAILED', 'Google returned no refresh token');
    return { refreshToken: tokens.refresh_token, email: idTokenEmail(tokens.id_token) };
  }

  async accessToken(refreshToken: string): Promise<string> {
    const client = this.client();
    client.setCredentials({ refresh_token: refreshToken });
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new AppError('UNAVAILABLE', 'Google returned no access token');
      return token;
    } catch (error) {
      if (oauthError(error) === 'invalid_grant') throw new DriveRevokedError();
      if (error instanceof AppError) throw error;
      throw new AppError('UNAVAILABLE', 'Google sign-in is not reachable right now');
    }
  }

  /** True when Google revoked it now or it was no longer valid. */
  async revoke(refreshToken: string): Promise<boolean> {
    try {
      await this.client().revokeToken(refreshToken);
      return true;
    } catch (error) {
      if (oauthError(error) === 'invalid_token') return true;
      return false;
    }
  }

  private client(): OAuth2Client {
    this.requireConfigured();
    return new OAuth2Client({
      clientId: this.config.GOOGLE_CLIENT_ID,
      clientSecret: this.config.GOOGLE_CLIENT_SECRET,
      redirectUri: `${this.config.PUBLIC_BASE_URL}${CALLBACK_PATH}`,
      transporterOptions: { fetchImplementation: fetch },
    });
  }
}
