import { liveQuery, Subscription } from 'dexie';

interface QueryObserver<T> {
  next: (value: T) => void;
  error: (error: unknown) => void;
}

export function subscribeToLiveQuery<T>(query: () => T | Promise<T>, observer: QueryObserver<T>): () => void {
  let disposed = false;
  let generation = 0;
  let failures = 0;
  let subscription: Subscription | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function subscribe() {
    const current = ++generation;
    const candidate = liveQuery(async () => query()).subscribe({
      next: value => {
        if (disposed || current !== generation) return;
        failures = 0;
        observer.next(value);
      },
      error: error => {
        if (disposed || current !== generation) return;
        generation += 1;
        subscription?.unsubscribe();
        subscription = undefined;
        // A failed first read may establish no Dexie observation to wake on a later write.
        const delay = Math.min(1000 * 2 ** failures, 30000);
        failures = Math.min(failures + 1, 5);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          subscribe();
        }, delay);
        observer.error(error);
      }
    });
    if (disposed || current !== generation) candidate.unsubscribe();
    else subscription = candidate;
  }

  subscribe();
  return () => {
    disposed = true;
    generation += 1;
    clearTimeout(retryTimer);
    subscription?.unsubscribe();
  };
}
