import { AppError } from '../common/errors';

/** A caption in seconds. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

export const TRANSCRIPT_FORMATS = ['json', 'srt', 'vtt', 'txt'] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

/** Subtitle file types the service can read, in the order it asks yt-dlp for them. */
export const READABLE_SUBTITLE_EXTS = ['json3', 'vtt', 'srt'] as const;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|apos|nbsp);/g,
    (_match, name: string) => ENTITIES[name] ?? '',
  );
}

/** `HH:MM:SS.mmm`, `MM:SS.mmm` or `HH:MM:SS,mmm` to seconds. */
export function parseTimestamp(value: string): number {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) throw new AppError('EXTRACTION_FAILED', `Unreadable subtitle timestamp "${value}"`);
  const [, hours = '0', minutes = '0', seconds = '0', millis = '0'] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(millis.padEnd(3, '0')) / 1000
  );
}

function cleanLines(lines: string[]): string[] {
  return lines
    .map((line) => decodeEntities(line.replace(/<[^>]*>/g, '')).trim())
    .filter((line) => line.length > 0);
}

/** WebVTT and SRT share a block structure: optional id, a `start --> end` line, text lines. */
function parseBlocks(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing < 0) continue;
    const [start = '', rest = ''] = lines[timing]?.split('-->') ?? [];
    const end = rest.trim().split(/\s+/)[0] ?? '';
    const textLines = cleanLines(lines.slice(timing + 1));
    if (textLines.length === 0) continue;
    cues.push({
      start: parseTimestamp(start),
      end: parseTimestamp(end),
      text: textLines.join('\n'),
    });
  }
  return cues;
}

export const parseVtt = parseBlocks;
export const parseSrt = parseBlocks;

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string }[];
}

/** YouTube's json3 caption format. */
export function parseJson3(text: string): Cue[] {
  let document: { events?: Json3Event[] };
  try {
    document = JSON.parse(text) as { events?: Json3Event[] };
  } catch {
    throw new AppError('EXTRACTION_FAILED', 'Unreadable json3 subtitles');
  }
  const cues: Cue[] = [];
  for (const event of document.events ?? []) {
    const content = (event.segs ?? []).map((segment) => segment.utf8 ?? '').join('');
    const lines = cleanLines(content.split('\n'));
    if (lines.length === 0 || event.tStartMs === undefined) continue;
    // Sum in integer milliseconds: 1.2 + 2.16 would give 3.3600000000000003.
    const end = (event.tStartMs + (event.dDurationMs ?? 0)) / 1000;
    cues.push({ start: event.tStartMs / 1000, end, text: lines.join('\n') });
  }
  return cues;
}

export function parseSubtitles(ext: string, text: string): Cue[] {
  switch (ext) {
    case 'json3':
      return parseJson3(text);
    case 'vtt':
      return parseVtt(text);
    case 'srt':
      return parseSrt(text);
    default:
      throw new AppError('EXTRACTION_FAILED', `Subtitles in "${ext}" format are not supported`);
  }
}

/**
 * YouTube's automatic captions "roll": each cue repeats the previous line and adds a new one,
 * with 10 ms transition cues in between. Keeps only the lines a cue adds.
 */
export function dedupeRolling(cues: readonly Cue[]): Cue[] {
  const result: Cue[] = [];
  let previous = new Set<string>();
  for (const cue of cues) {
    const lines = cue.text.split('\n');
    const added = lines.filter((line) => !previous.has(line));
    previous = new Set(lines);
    if (added.length > 0) result.push({ ...cue, text: added.join('\n') });
  }
  return result;
}

function timestamp(seconds: number, separator: '.' | ','): string {
  const millis = Math.round(seconds * 1000);
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const secs = Math.floor((millis % 60_000) / 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis % 1000, 3)}`;
}

export function toSrt(cues: readonly Cue[]): string {
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n${timestamp(cue.start, ',')} --> ${timestamp(cue.end, ',')}\n${cue.text}\n`,
    )
    .join('\n');
}

export function toVtt(cues: readonly Cue[]): string {
  const escape = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const body = cues
    .map(
      (cue) => `${timestamp(cue.start, '.')} --> ${timestamp(cue.end, '.')}\n${escape(cue.text)}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** Plain text, one caption line per line, without consecutive repeats. */
export function toText(cues: readonly Cue[]): string {
  const lines: string[] = [];
  for (const line of cues.flatMap((cue) => cue.text.split('\n'))) {
    if (lines.at(-1) !== line) lines.push(line);
  }
  return lines.join('\n');
}
