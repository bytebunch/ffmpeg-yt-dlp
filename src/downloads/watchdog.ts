import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Total bytes of regular files under `dir` (recursive); missing paths count as zero. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/**
 * Partial-file watchdog (SPEC §12): yt-dlp's --max-filesize cannot see fragmented downloads,
 * so the job directory is measured every few seconds and the run aborted above the limit.
 */
export function startWatchdog(
  dir: string,
  maxBytes: number,
  onExceeded: () => void,
  intervalMs = 3000,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    void directorySize(dir).then((size) => {
      if (!stopped && size > maxBytes) {
        stopped = true;
        clearInterval(timer);
        onExceeded();
      }
    });
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
