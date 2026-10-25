export async function settledRoundTripBalance(
  refresh: () => Promise<void>,
  read: () => Promise<bigint>
): Promise<bigint> {
  await refresh();
  return read();
}
