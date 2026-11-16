export type BridgeAsset = { network: string; symbol: string; decimals: number; name?: string; logo?: string } & (
  | { kind: 'native' }
  | { kind: 'erc20'; address: string }
  | { kind: 'miden'; faucetId: string }
);
export type MidenAsset = Extract<BridgeAsset, { kind: 'miden' }>;
export type EvmAsset = Exclude<BridgeAsset, MidenAsset>;

export function assetKey(asset: BridgeAsset): string {
  const identifier = asset.kind === 'erc20' ? asset.address : asset.kind === 'miden' ? asset.faucetId : 'native';
  return `${asset.network}:${asset.kind}:${identifier.toLowerCase()}`;
}

export function sameAsset(left: BridgeAsset, right: BridgeAsset): boolean {
  return assetKey(left) === assetKey(right);
}
