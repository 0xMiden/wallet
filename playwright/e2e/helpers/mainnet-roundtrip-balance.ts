export async function settledRoundTripBalance(
  _refresh: () => Promise<void>,
  read: () => Promise<bigint>
): Promise<bigint> {
  return read();
}
