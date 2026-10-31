import { type Entry, entryKey } from '../playlists/plan';

/**
 * The entries a watch run has not seen, newest first as sites list them (SPEC §9f). With
 * `breakOnExisting` the scan stops at the first known entry (yt-dlp's --break-on-existing);
 * otherwise known entries are skipped. `known` holds archive keys: downloaded or queued before.
 */
export function newEntries(
  entries: readonly Entry[],
  known: ReadonlySet<string>,
  breakOnExisting: boolean,
): Entry[] {
  const fresh: Entry[] = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    if (key !== undefined && known.has(key)) {
      if (breakOnExisting) break;
      continue;
    }
    fresh.push(entry);
  }
  return fresh;
}
