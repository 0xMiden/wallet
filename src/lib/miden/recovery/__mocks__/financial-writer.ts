let tail: Promise<unknown> = Promise.resolve();
export function withFinancialRecoveryLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = tail.then(operation);
  tail = next.catch(() => {});
  return next;
}
export const checkpointFinancialChange = jest.fn(async () => {});
export const verifyFinancialRecovery = jest.fn(async () => {});
