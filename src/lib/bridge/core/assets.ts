export type BridgeAsset = { network: string; symbol: string; decimals: number; name?: string; logo?: string } & (
  | { kind: 'native' }
  | { kind: 'erc20'; address: string }
  | { kind: 'miden'; faucetId: string }
);
export type MidenAsset = Extract<BridgeAsset, { kind: 'miden' }>;
export type EvmAsset = Exclude<BridgeAsset, MidenAsset>;
export function assetKey(_asset: BridgeAsset): string {
  throw new Error('Unsupported bridge core');
}
export function sameAsset(_left: BridgeAsset, _right: BridgeAsset): boolean {
  throw new Error('Unsupported bridge core');
}
