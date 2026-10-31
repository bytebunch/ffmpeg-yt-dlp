import { AppError } from '../common/errors';
import { checkFilters, type Filters } from './filters';

export type Entry = Record<string, unknown>;

export interface PlannedItem {
  index: number;
  id: string;
  url: string;
  title: string | null;
  duration: number | null;
}

export interface PlanLimits {
  maxItems: number;
  maxTotalHours: number;
  unknownDurationMinutes: number;
}

export interface PlanInput {
  entries: readonly Entry[];
  /** yt-dlp's `requested_entries`: the original index of each selected entry (flat entries lack it). */
  requestedIndices?: readonly number[] | undefined;
  limits: PlanLimits;
  /** An explicit `items` selection was applied during expansion. */
  selected: boolean;
  maxItems?: number | undefined;
  reverse?: boolean | undefined;
  random?: boolean | undefined;
  filters?: Filters | undefined;
  /** `<extractor>:<id>` keys from the user's download archive (skip_downloaded). */
  archived?: ReadonlySet<string> | undefined;
  shuffle?: <T>(items: T[]) => T[];
}

export interface Plan {
  items: PlannedItem[];
  filtered: number;
  archived: number;
  unsupported: number;
}

function defaultShuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

export function archiveKey(extractor: string, id: string): string {
  return `${extractor.toLowerCase()}:${id}`;
}

/** A flat entry's archive key; undefined for entries without an id. */
export function entryKey(entry: Entry): string | undefined {
  if (typeof entry.id !== 'string') return undefined;
  return archiveKey(typeof entry.ie_key === 'string' ? entry.ie_key : 'unknown', entry.id);
}

/**
 * Turns expanded playlist entries into the items to run (SPEC §7e, §9e): skips nested playlists
 * and entries without a URL, applies filters and the archive, then max_items, order and the caps.
 */
export function planItems(input: PlanInput): Plan {
  const { limits } = input;
  if (!input.selected && input.maxItems === undefined && input.entries.length > limits.maxItems) {
    throw new AppError(
      'PLAYLIST_TOO_LARGE',
      `This playlist has more than ${limits.maxItems} items; choose a range with "items" or set "max_items"`,
      { max_items: limits.maxItems },
    );
  }
  const plan: Plan = { items: [], filtered: 0, archived: 0, unsupported: 0 };
  for (const [position, entry] of input.entries.entries()) {
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    const url =
      typeof entry.url === 'string'
        ? entry.url
        : typeof entry.webpage_url === 'string'
          ? entry.webpage_url
          : undefined;
    if (entry._type === 'playlist' || id === undefined || url === undefined) {
      plan.unsupported++;
      continue;
    }
    if (input.filters && checkFilters(entry, input.filters) === 'reject') {
      plan.filtered++;
      continue;
    }
    if (input.archived?.has(entryKey(entry) ?? '')) {
      plan.archived++;
      continue;
    }
    plan.items.push({
      index:
        typeof entry.playlist_index === 'number'
          ? entry.playlist_index
          : (input.requestedIndices?.[position] ?? position + 1),
      id,
      url,
      title: typeof entry.title === 'string' ? entry.title : null,
      duration: typeof entry.duration === 'number' ? entry.duration : null,
    });
  }
  if (input.maxItems !== undefined) plan.items = plan.items.slice(0, input.maxItems);
  if (input.reverse) plan.items.reverse();
  if (input.random) plan.items = (input.shuffle ?? defaultShuffle)(plan.items);

  const totalSeconds = plan.items.reduce(
    (total, item) => total + (item.duration ?? limits.unknownDurationMinutes * 60),
    0,
  );
  if (totalSeconds > limits.maxTotalHours * 3600) {
    throw new AppError(
      'PLAYLIST_TOO_LARGE',
      `The selected items add up to more than ${limits.maxTotalHours} hours; choose fewer items`,
      { total_hours: Math.round(totalSeconds / 360) / 10, max_hours: limits.maxTotalHours },
    );
  }
  return plan;
}
