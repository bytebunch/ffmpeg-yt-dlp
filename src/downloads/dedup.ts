import { createHash } from 'node:crypto';

/** Options that change how a file is fetched but not its bytes stay out of the dedup key. */
const RUNTIME_ONLY = new Set([
  'mode',
  'limit_rate_kbps',
  'concurrent_fragments',
  'impersonate',
  'verify_formats',
]);

/** JSON with sorted keys, so equal options always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SPEC §9d: covers everything that changes the bytes (container, sections, SponsorBlock, embeds…). */
export function optionsHash(options: Record<string, unknown>): string {
  const relevant = Object.fromEntries(
    Object.entries(options).filter(([key]) => !RUNTIME_ONLY.has(key)),
  );
  return createHash('sha256').update(canonicalJson(relevant)).digest('hex');
}

export interface DedupKey {
  extractor: string;
  mediaId: string;
  preset: string;
  optionsHash: string;
}

export function lockKey(key: DedupKey): string {
  return `media:lock:download:${createHash('sha256').update(canonicalJson(key)).digest('hex')}`;
}
