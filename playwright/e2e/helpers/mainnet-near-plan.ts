import type { OneClickAsset, OneClickConfig, OneClickQuoteRequest, OneClickQuoteResponse } from '../../../src/lib/one-click/types';
import { canonicalMainnetLoopFaucet } from './mainnet-loop-config';
import type { MainnetNearCheckpoint } from './mainnet-near-checkpoint';
import type { MainnetEvmHolding } from './mainnet-one-click-evm';

export interface MainnetNearPlanningFacts {
  account: string;
  accountHex: string;
  sourceRunId: string;
  pricedAt: string;
  native: MainnetNearCheckpoint['native'];
  baseFee: bigint;
  lossBudgetUsdMicros: bigint;
  config: OneClickConfig;
  nativeAsset: OneClickAsset;
  candidates: { holding: MainnetEvmHolding; tokenUsdMicros: bigint; gasUsdMicros: bigint }[];
}
export async function prepareMainnetNearRoundTrip(
  _facts: MainnetNearPlanningFacts, _quote: (request: OneClickQuoteRequest) => Promise<OneClickQuoteResponse | undefined>
): Promise<MainnetNearCheckpoint> {
  throw new Error('Bounded funded native NEAR round-trip planning is not implemented');
}


export function selectMainnetNearNativeAsset(
  assets: readonly OneClickAsset[], nativeFaucetHex: string, balance: bigint, feeReserve: bigint
): OneClickAsset {
  if (nativeFaucetHex !== '0xe69e6ca6e39df1b10c1e5399399feb' || typeof balance !== 'bigint' || typeof feeReserve !== 'bigint' ||
      feeReserve <= 0n || balance <= feeReserve) throw new Error('Existing native NEAR principal or fee reserve is unavailable');
  const matches = assets.filter(asset => asset.blockchain === 'miden' && asset.assetId === `nep141:miden-${nativeFaucetHex}.omft.near`);
  const asset = matches[0];
  if (matches.length !== 1 || !asset?.faucetId || asset.decimals !== 6 || asset.symbol.toUpperCase() !== 'USDCX' ||
      canonicalMainnetLoopFaucet(asset.faucetId) !== nativeFaucetHex) throw new Error('Exact native NEAR catalog binding is missing or ambiguous');
  return asset;
}
