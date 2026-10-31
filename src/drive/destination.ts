import { z } from 'zod';

/** Drive file and folder ids: letters, digits, `-` and `_`. */
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * Where a job delivers (SPEC §8a, §9b): `"link"` (signed links, the default) or the user's Google
 * Drive, optionally into a folder this service created.
 */
export const destinationSchema = z.union([
  z.literal('link'),
  z.strictObject({
    type: z.literal('google_drive'),
    folderId: z.string().regex(DRIVE_ID, 'must be a folder id from GET /v1/drive/files').optional(),
  }),
]);

export type FinalStatus = 'completed' | 'completed_with_errors' | 'cancelled';

/** A stored Drive destination; the `_` fields are the service's own bookkeeping. */
export interface DriveDestination {
  type: 'google_drive';
  folderId?: string;
  /** The status the job takes once its outputs are in Drive. */
  _status?: FinalStatus;
  /** Parents: the sub-folder their items go into, and its name. */
  _folder?: string;
  _name?: string;
}

/** The Drive destination of a job row, if it has one. */
export function driveDestination(value: unknown): DriveDestination | undefined {
  return typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'google_drive'
    ? (value as DriveDestination)
    : undefined;
}

/** What a job row stores: null for links, the Drive destination otherwise. */
export function storedDestination(
  value: z.output<typeof destinationSchema> | undefined,
): DriveDestination | null {
  return value === undefined || value === 'link'
    ? null
    : { type: 'google_drive', ...(value.folderId !== undefined && { folderId: value.folderId }) };
}

/** The caller's part of a destination (no bookkeeping), for items created from a parent. */
export function requestedDestination(value: unknown): DriveDestination | null {
  const destination = driveDestination(value);
  if (!destination) return null;
  return {
    type: 'google_drive',
    ...(destination.folderId !== undefined && { folderId: destination.folderId }),
  };
}
