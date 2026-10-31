/** Wraps an async step so it runs at most once; every later call shares the first run's result. */
export function once(step: () => Promise<void>): () => Promise<void> {
  let run: Promise<void> | undefined;
  return () => (run ??= step());
}
