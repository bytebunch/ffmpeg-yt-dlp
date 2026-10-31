/** Calls `onLine` for each complete line of a stream (the last partial line at the end). */
export function forEachLine(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) return;
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) onLine(line.replace(/\r$/, ''));
  });
  stream.on('end', () => {
    if (pending) onLine(pending);
  });
}
