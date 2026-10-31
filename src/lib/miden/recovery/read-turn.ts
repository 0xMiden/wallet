const active = new Map<string, Promise<unknown>>();

/** A timed-out RPC still owns its turn until the underlying promise settles. */
export async function withRecoveryReadTurn<T>(
  scope: string,
  deadline: number,
  assertCurrent: () => void,
  operation: (check: () => void) => Promise<T>
): Promise<T | undefined> {
  if (active.has(scope) || Date.now() >= deadline) return undefined;
  const check = () => {
    if (Date.now() >= deadline) throw new Error('Recovery read deadline expired');
    assertCurrent();
  };
  const pending = Promise.resolve().then(() => {
    check();
    return operation(check);
  });
  active.set(scope, pending);
  void pending
    .finally(() => {
      if (active.get(scope) === pending) active.delete(scope);
    })
    .catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
