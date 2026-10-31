import { z } from 'zod';

/**
 * Metadata filters (SPEC §7e), applied by the service to expanded entries instead of composing
 * `--match-filters`: same effect, no yt-dlp filter syntax anywhere, and literal text matching only.
 * Fields a flat playlist entry lacks (YouTube has no dates or likes there) are checked again on
 * the full metadata when the item runs.
 */
export const filtersSchema = z.strictObject({
  min_duration: z.number().min(0).optional(),
  max_duration: z.number().min(0).optional(),
  min_views: z.number().int().min(0).optional(),
  max_views: z.number().int().min(0).optional(),
  min_likes: z.number().int().min(0).optional(),
  title_contains: z.array(z.string().min(1).max(200)).max(20).optional(),
  title_excludes: z.array(z.string().min(1).max(200)).max(20).optional(),
  uploader: z.string().min(1).max(200).optional(),
  exclude_live: z.boolean().optional(),
  exclude_upcoming: z.boolean().optional(),
  exclude_shorts: z.boolean().optional(),
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
    .optional(),
});

export type Filters = z.output<typeof filtersSchema>;

const DATE = /^(?:\d{8}|now(?:-\d{1,4}(?:day|week|month|year)s?)?|today|yesterday)$/;
export const dateFilter = z.string().regex(DATE, 'must be YYYYMMDD or relative such as now-7days');

type Entry = Record<string, unknown>;

const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const lower = (value: string) => value.toLocaleLowerCase();

export type Verdict = 'pass' | 'reject' | 'unknown';

/**
 * Checks one entry. `unknown` means a field the filter needs is missing, which is decided again
 * once the item's full metadata is known (at expansion, unknown entries are kept).
 */
export function checkFilters(entry: Entry, filters: Filters): Verdict {
  let unknown = false;
  const range = (value: number | undefined, min?: number, max?: number): boolean => {
    if (min === undefined && max === undefined) return true;
    if (value === undefined) {
      unknown = true;
      return true;
    }
    return (min === undefined || value >= min) && (max === undefined || value <= max);
  };
  const title = text(entry.title);
  const live = text(entry.live_status);
  const url = text(entry.url) ?? text(entry.webpage_url) ?? '';

  const checks = [
    range(num(entry.duration), filters.min_duration, filters.max_duration),
    range(num(entry.view_count), filters.min_views, filters.max_views),
    range(num(entry.like_count), filters.min_likes),
  ];
  if (filters.title_contains || filters.title_excludes) {
    if (title === undefined) {
      unknown = true;
    } else {
      checks.push(
        (filters.title_contains ?? []).every((needle) => lower(title).includes(lower(needle))),
        !(filters.title_excludes ?? []).some((needle) => lower(title).includes(lower(needle))),
      );
    }
  }
  if (filters.uploader !== undefined) {
    const uploader = text(entry.uploader) ?? text(entry.channel);
    if (uploader === undefined) unknown = true;
    else checks.push(lower(uploader) === lower(filters.uploader));
  }
  if (filters.exclude_live)
    checks.push(live !== 'is_live' && live !== 'was_live' && entry.was_live !== true);
  if (filters.exclude_upcoming) checks.push(live !== 'is_upcoming');
  if (filters.exclude_shorts) checks.push(!url.includes('/shorts/'));
  if (filters.language !== undefined) {
    const language = text(entry.language);
    if (language === undefined) unknown = true;
    else checks.push(lower(language).startsWith(lower(filters.language)));
  }
  if (checks.some((ok) => !ok)) return 'reject';
  return unknown ? 'unknown' : 'pass';
}

/** yt-dlp's relative and absolute dates, resolved to YYYYMMDD in UTC. */
export function resolveDate(value: string, now: Date = new Date()): string {
  const fmt = (date: Date) => date.toISOString().slice(0, 10).replaceAll('-', '');
  if (/^\d{8}$/.test(value)) return value;
  if (value === 'today' || value === 'now') return fmt(now);
  if (value === 'yesterday') return fmt(new Date(now.getTime() - 86_400_000));
  const match = /^now-(\d+)(day|week|month|year)s?$/.exec(value);
  if (!match) return fmt(now);
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === 'day' || unit === 'week') {
    return fmt(new Date(now.getTime() - amount * (unit === 'week' ? 7 : 1) * 86_400_000));
  }
  // Months and years clamp to the last day of the target month (31 Oct - 1 month = 30 Sep).
  const months = amount * (unit === 'year' ? 12 : 1);
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return fmt(target);
}

/** True when an upload date (YYYYMMDD) lies within the optional bounds; unknown dates pass. */
export function inDateRange(
  uploadDate: unknown,
  after?: string,
  before?: string,
  now = new Date(),
): boolean {
  if (typeof uploadDate !== 'string' || !/^\d{8}$/.test(uploadDate)) return true;
  if (after !== undefined && uploadDate < resolveDate(after, now)) return false;
  if (before !== undefined && uploadDate > resolveDate(before, now)) return false;
  return true;
}
