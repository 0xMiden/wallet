/** Convert a Miden account ID (hex) to the 20-byte address used by the AggLayer bridge. */
export function midenAccountIdToEvmAddr(accountId: string): `0x${string}` {
  const strippedHex = accountId.startsWith('0x') ? accountId.slice(2) : accountId;
  return `0x${'00'.repeat(4)}${strippedHex}00` as `0x${string}`;
}
