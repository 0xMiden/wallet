import type { EarnLockManager } from '../poll-registry';

type LockCallback<T> = (lock: object | null) => Promise<T>;

export class SharedEarnLocks implements EarnLockManager {
  readonly requests: string[] = [];
  private readonly held = new Set<string>();
  private readonly waiting = new Map<string, Array<() => void>>();

  heldNames(): string[] {
    return [...this.held];
  }

  // Also takes navigator.locks' two-argument form, request(name, callback), and resolves with
  // whatever the callback resolved with, as a real LockManager does.
  request<T>(name: string, ...args: [LockCallback<T>] | [{ ifAvailable: boolean }, LockCallback<T>]): Promise<T> {
    const [options, callback]: [{ ifAvailable: boolean }, LockCallback<T>] =
      args.length === 1 ? [{ ifAvailable: false }, args[0]] : args;
    this.requests.push(name);
    if (this.held.has(name) && options.ifAvailable) return callback(null);
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.held.add(name);
        void callback({ name })
          .then(resolve, reject)
          .finally(() => {
            this.held.delete(name);
            const queue = this.waiting.get(name);
            const next = queue?.shift();
            if (queue?.length === 0) this.waiting.delete(name);
            next?.();
          });
      };
      if (this.held.has(name)) {
        const queue = this.waiting.get(name) ?? [];
        queue.push(run);
        this.waiting.set(name, queue);
      } else {
        run();
      }
    });
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
