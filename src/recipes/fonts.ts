import { open, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The font allow-list (SPEC §13 FONT_DIR): every TrueType/OpenType face under FONT_DIR, named
 * by the family and style in its own `name` table. Recipes ask for a family; the composer picks
 * the face file, so clients never send a path.
 */

const FONT_FILE = /\.(ttf|otf|ttc)$/i;

/** Nest token for the worker's catalog, scanned once at start. */
export const FONT_CATALOG = Symbol('FONT_CATALOG');
const MAX_FILES = 5000;

export interface FontFace {
  family: string;
  style: string;
  file: string;
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

function decode(platform: number, bytes: Buffer): string {
  if (platform === 3 || platform === 0) {
    // UTF-16BE
    const swapped = Buffer.from(bytes);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return bytes.toString('latin1');
}

/** Family and style of one face: typographic names (16/17) when present, else 1/2. */
export async function readFace(file: string): Promise<{ family: string; style: string } | null> {
  const handle = await open(file, 'r');
  try {
    let base = 0;
    const head = await readAt(handle, 0, 12);
    if (head.length < 12) return null;
    if (head.toString('latin1', 0, 4) === 'ttcf')
      base = (await readAt(handle, 12, 4)).readUInt32BE(0);
    const directory = await readAt(handle, base, 12);
    const tables = directory.readUInt16BE(4);
    const records = await readAt(handle, base + 12, tables * 16);
    let nameOffset = -1;
    let nameLength = 0;
    for (let i = 0; i < tables; i++) {
      if (records.toString('latin1', i * 16, i * 16 + 4) === 'name') {
        nameOffset = records.readUInt32BE(i * 16 + 8);
        nameLength = records.readUInt32BE(i * 16 + 12);
      }
    }
    if (nameOffset < 0 || nameLength > 1_000_000) return null;
    const table = await readAt(handle, nameOffset, nameLength);
    const count = table.readUInt16BE(2);
    const strings = table.readUInt16BE(4);
    const names = new Map<number, { score: number; value: string }>();
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 12;
      if (at + 12 > table.length) break;
      const platform = table.readUInt16BE(at);
      const language = table.readUInt16BE(at + 4);
      const id = table.readUInt16BE(at + 6);
      const length = table.readUInt16BE(at + 8);
      const offset = table.readUInt16BE(at + 10);
      if (![1, 2, 16, 17].includes(id)) continue;
      // Windows US English first, then any Windows/Unicode entry, then Macintosh.
      const score =
        platform === 3 && language === 0x409 ? 3 : platform === 3 || platform === 0 ? 2 : 1;
      const value = decode(
        platform,
        table.subarray(strings + offset, strings + offset + length),
      ).trim();
      if (value && (names.get(id)?.score ?? 0) < score) names.set(id, { score, value });
    }
    const family = names.get(16)?.value ?? names.get(1)?.value;
    const style = names.get(17)?.value ?? names.get(2)?.value ?? 'Regular';
    return family ? { family, style } : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export class FontCatalog {
  private readonly families = new Map<string, { family: string; styles: Map<string, string> }>();

  constructor(faces: readonly FontFace[]) {
    for (const face of [...faces].sort((a, b) => a.file.localeCompare(b.file))) {
      const key = face.family.toLowerCase();
      const entry = this.families.get(key) ?? {
        family: face.family,
        styles: new Map<string, string>(),
      };
      if (!entry.styles.has(face.style.toLowerCase()))
        entry.styles.set(face.style.toLowerCase(), face.file);
      this.families.set(key, entry);
    }
  }

  static async scan(directory: string): Promise<FontCatalog> {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && FONT_FILE.test(entry.name)) files.push(full);
      }
    };
    await walk(directory);
    const faces: FontFace[] = [];
    for (const file of files) {
      const face = await readFace(file);
      if (face) faces.push({ ...face, file });
    }
    return new FontCatalog(faces);
  }

  /** Family names as installed, sorted. */
  list(): string[] {
    return [...this.families.values()]
      .map((entry) => entry.family)
      .sort((a, b) => a.localeCompare(b));
  }

  /** The face file for a family, closest to the asked weight and slant; undefined if unknown. */
  face(family: string, options: { bold?: boolean; italic?: boolean } = {}): string | undefined {
    const entry = this.families.get(family.toLowerCase());
    if (!entry) return undefined;
    const wanted =
      options.bold && options.italic
        ? 'bold italic'
        : options.bold
          ? 'bold'
          : options.italic
            ? 'italic'
            : 'regular';
    const fallbacks = [
      wanted,
      ...(options.bold ? ['bold'] : []),
      'regular',
      'book',
      'normal',
      'medium',
    ];
    for (const style of fallbacks) {
      const file = entry.styles.get(style);
      if (file) return file;
    }
    return entry.styles.values().next().value;
  }
}
