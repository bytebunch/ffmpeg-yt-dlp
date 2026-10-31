import { describe, expect, it } from 'vitest';

import { once } from './once';

describe('once', () => {
  it('runs the step on the first call only', async () => {
    let runs = 0;
    const step = once(() => {
      runs++;
      return Promise.resolve();
    });
    await step();
    await step();
    expect(runs).toBe(1);
  });

  it('lets concurrent callers wait for the same run', async () => {
    let runs = 0;
    let finish = (): void => undefined;
    const step = once(() => {
      runs++;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    const first = step();
    const second = step();
    finish();
    await Promise.all([first, second]);
    expect(runs).toBe(1);
  });

  it('hands a failure to every caller instead of running the step again', async () => {
    let runs = 0;
    const step = once(() => {
      runs++;
      return Promise.reject(new Error('cleanup failed'));
    });
    await expect(step()).rejects.toThrow('cleanup failed');
    await expect(step()).rejects.toThrow('cleanup failed');
    expect(runs).toBe(1);
  });
});
