export async function prepareWalletPair<T>(
  prepare: (label: 'A' | 'B') => Promise<T>,
  close?: (wallet: T) => Promise<void>
): Promise<{ A: T; B: T }> {
  const [A, B] = await Promise.allSettled([
    Promise.resolve().then(() => prepare('A')),
    Promise.resolve().then(() => prepare('B'))
  ]);
  if (A.status === 'fulfilled' && B.status === 'fulfilled') return { A: A.value, B: B.value };
  const failures: unknown[] = [];
  for (const result of [A, B]) {
    if (result.status === 'rejected') failures.push(result.reason);
    else {
      try { await close?.(result.value); }
      catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, 'Wallet pair setup failed');
}
