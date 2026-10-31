/** A stream inside the filtergraph: an input stream ("0:v:0") or a filter output. */
export interface Pad {
  label: string;
  kind: 'v' | 'a';
  /** An input stream: can be read any number of times and copied without decoding. */
  raw: boolean;
}

/**
 * Builds a -filter_complex graph. Filter outputs may be read several times: each read gets its
 * own label and finish() inserts the split. Pads nobody reads are returned as "dangling" so the
 * caller maps them to a null output (ffmpeg refuses graphs whose only ends are sinks).
 */
export class Graph {
  private readonly segments: string[] = [];
  private readonly reads = new Map<string, { kind: 'v' | 'a'; labels: string[] }>();
  private counter = 0;

  static input(kind: 'v' | 'a', input = 0): Pad {
    return { label: `${input}:${kind}:0`, kind, raw: true };
  }

  get empty(): boolean {
    return this.segments.length === 0;
  }

  newPad(kind: 'v' | 'a'): Pad {
    const label = `${kind}${this.counter++}`;
    this.reads.set(label, { kind, labels: [] });
    return { label, kind, raw: false };
  }

  /** The label to read a pad from once more. */
  read(pad: Pad): string {
    if (pad.raw) return pad.label;
    const entry = this.reads.get(pad.label);
    if (!entry) throw new Error(`Unknown pad ${pad.label}`);
    const label = `${pad.label}r${entry.labels.length}`;
    entry.labels.push(label);
    return label;
  }

  /** Appends a linear chain of filters reading one pad; `kind` changes for audio→video filters. */
  chain(pad: Pad, filters: readonly string[], kind: 'v' | 'a' = pad.kind): Pad {
    if (filters.length === 0) return pad;
    const out = this.newPad(kind);
    this.segments.push(`[${this.read(pad)}]${filters.join(',')}[${out.label}]`);
    return out;
  }

  /** Adds a hand-built segment; its input labels must come from read(). */
  segment(text: string): void {
    this.segments.push(text);
  }

  /** The graph text and the pads nobody reads. */
  finish(): { text: string; dangling: string[] } {
    const parts = [...this.segments];
    const dangling: string[] = [];
    for (const [label, { kind, labels }] of this.reads) {
      if (labels.length === 0) dangling.push(label);
      else
        parts.push(
          `[${label}]${kind === 'v' ? 'split' : 'asplit'}=${labels.length}${labels.map((out) => `[${out}]`).join('')}`,
        );
    }
    return { text: parts.join(';'), dangling };
  }
}

/** A number for a filter argument: finite, without exponent notation. */
export function num(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Not a finite number: ${value}`);
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(6).replace(/0+$/, '');
}
