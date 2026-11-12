/** Short-lived, in-memory cache for public site configuration, never session or order data. */
export function publicSnapshot<T>(load: () => Promise<T>, ttlMs = 30_000) {
  let cached: { value: T; expires: number } | undefined;
  let pending: Promise<T> | undefined;
  let generation = 0;
  return {
    invalidate(): void {
      generation++;
      cached = undefined;
      pending = undefined;
    },
    read(): Promise<T> {
      if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
      if (pending) return pending;
      const requestedGeneration = generation;
      const request = load().then((value) => {
        if (requestedGeneration === generation) cached = { value, expires: Date.now() + ttlMs };
        return value;
      });
      pending = request;
      void request
        .finally(() => {
          if (pending === request) pending = undefined;
        })
        .catch(() => {});
      return request;
    },
  };
}
