import { mkdir, statfs } from 'node:fs/promises';

import { AppError } from './errors';

export async function diskUsagePercent(dir: string): Promise<number> {
  await mkdir(dir, { recursive: true });
  const stats = await statfs(dir);
  if (stats.blocks === 0) return 0;
  return ((stats.blocks - stats.bavail) / stats.blocks) * 100;
}

/** SPEC §10 disk guard: new work is refused above DISK_QUOTA_PERCENT. */
export async function assertDiskSpace(dir: string, quotaPercent: number): Promise<void> {
  const used = await diskUsagePercent(dir);
  if (used > quotaPercent) {
    throw new AppError('STORAGE_FULL', 'The server is out of storage space; try again later', {
      used_percent: Math.round(used),
    });
  }
}
