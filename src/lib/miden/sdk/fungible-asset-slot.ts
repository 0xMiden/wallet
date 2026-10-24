export function selectFungibleAssetSlot<T extends { amount(): bigint }>(
  assets: readonly T[],
  requestedAmount: bigint
): T | undefined {
  return (
    assets.find(asset => asset.amount() >= requestedAmount) ??
    assets.reduce<T | undefined>(
      (largest, asset) => (largest && largest.amount() >= asset.amount() ? largest : asset),
      undefined
    )
  );
}
