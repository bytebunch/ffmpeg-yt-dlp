import { z } from 'zod';

const CLOCK = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)$/;
const SECONDS = /^\d{1,5}(?:\.\d{1,3})?$/;

/** "90", "1:30", "01:01:30.5" or a number of seconds → seconds. */
export function parseTime(value: string | number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (SECONDS.test(value)) return Number(value);
  const match = CLOCK.exec(value);
  if (!match) return undefined;
  const [, hours = '0', minutes = '0', seconds = '0'] = match;
  if (Number(minutes) > 59 || Number(seconds) >= 60) return undefined;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** A point in time: seconds (number) or a clock string; always seconds after parsing. */
export const timeValue = z.union([z.number(), z.string().max(20)]).transform((value, ctx) => {
  const seconds = parseTime(value);
  if (seconds === undefined || seconds > 864_000) {
    ctx.addIssue({ code: 'custom', message: 'must be seconds or HH:MM:SS(.mmm)' });
    return z.NEVER;
  }
  return Math.round(seconds * 1000) / 1000;
});

const NAMED_COLORS: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '00FF00',
  blue: '0000FF',
  yellow: 'FFFF00',
  gray: '808080',
};

/** "#RRGGBB", "RRGGBB" or a few names → ffmpeg's "0xRRGGBB". */
export const colorValue = z
  .string()
  .max(16)
  .transform((value, ctx) => {
    const hex = NAMED_COLORS[value.toLowerCase()] ?? /^#?([0-9a-fA-F]{6})$/.exec(value)?.[1];
    if (!hex) {
      ctx.addIssue({
        code: 'custom',
        message: `must be #RRGGBB or one of ${Object.keys(NAMED_COLORS).join(', ')}`,
      });
      return z.NEVER;
    }
    return `0x${hex.toUpperCase()}`;
  });

/** "16:9", "2.39:1" → a ratio. */
export const aspectValue = z
  .string()
  .regex(/^\d{1,3}(?:\.\d{1,3})?:\d{1,3}(?:\.\d{1,3})?$/, 'must look like 16:9')
  .transform((value, ctx) => {
    const [width, height] = value.split(':').map(Number);
    if (!width || !height || width / height < 0.1 || width / height > 10) {
      ctx.addIssue({ code: 'custom', message: 'aspect ratio out of range' });
      return z.NEVER;
    }
    return { text: value, ratio: width / height, width, height };
  });

export type Aspect = z.output<typeof aspectValue>;

/** Terminal and analysis names become file names: short, lower case, no separators. */
export const outputName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'a-z, 0-9, _ and -, at most 32');

/** True when the text holds a control character other than a newline. */
export function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

/** Text for metadata values: no control characters except newlines. */
export const metadataText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !hasControlCharacters(value), 'must not contain control characters');
