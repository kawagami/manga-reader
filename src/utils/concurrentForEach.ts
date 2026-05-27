export function concurrentForEach<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): { done: Promise<void>; cancel: () => void } {
  let cancelled = false;
  let i = 0;
  const next = async (): Promise<void> => {
    while (i < items.length && !cancelled) {
      const idx = i++;
      await fn(items[idx]);
    }
  };
  const done = Promise.all(Array.from({ length: concurrency }, next)).then(() => undefined);
  return { done, cancel: () => { cancelled = true; } };
}
