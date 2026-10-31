/**
 * Stable error codes (SPEC §4 "Errors") plus the generic HTTP ones every API needs. Clients
 * switch on `code`; `message` is for humans and may change.
 */
const STATUS_BY_CODE = {
  // SPEC §4
  UNSUPPORTED_SITE: 422,
  URL_NOT_ALLOWED: 400,
  INPUT_NOT_FOUND: 404,
  INPUT_NOT_MEDIA: 422,
  INPUT_FORMAT_NOT_ALLOWED: 422,
  MEDIA_TOO_LONG: 422,
  FILE_TOO_LARGE: 413,
  PLAYLIST_TOO_LARGE: 422,
  BATCH_TOO_LARGE: 422,
  RECIPE_INVALID: 400,
  RECIPE_TOO_EXPENSIVE: 422,
  QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  STORAGE_FULL: 507,
  UPLOAD_INCOMPLETE: 409,
  UPLOAD_EXPIRED: 410,
  DRIVE_NOT_CONNECTED: 409,
  DRIVE_RECONNECT_REQUIRED: 409,
  DRIVE_STORAGE_FULL: 507,
  DRIVE_FOLDER_NOT_ACCESSIBLE: 403,
  MEDIA_UNAVAILABLE: 404,
  MEDIA_PRIVATE: 403,
  MEDIA_GEO_BLOCKED: 451,
  MEDIA_AGE_GATED: 403,
  LOGIN_REQUIRED: 403,
  BOT_CHECK: 503,
  LIVE_NOT_STARTED: 409,
  FEATURE_DISABLED: 501,
  // Generic
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  TIMEOUT: 504,
  EXTRACTION_FAILED: 502,
  UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof STATUS_BY_CODE;

export const ERROR_CODES = Object.keys(STATUS_BY_CODE) as ErrorCode[];

export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers: Record<string, string> = {},
    /** Overrides the queue's per-code retry rule for deterministic failures. */
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = statusFor(code);
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
