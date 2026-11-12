import type { OneClickAsset } from '../../../src/lib/one-click/types';

export function selectMainnetNearNativeAsset(
  _assets: readonly OneClickAsset[], _nativeFaucetHex: string, _balance: bigint, _feeReserve: bigint
): OneClickAsset {
  throw new Error('Funded native NEAR asset selection is not implemented');
}
