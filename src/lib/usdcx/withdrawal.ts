import { hexToBytes, isAddress, padHex } from 'viem';

import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';

import { USDCX_DESTINATIONS } from './constant';

export class UsdcxBurnError extends Error {
  constructor(readonly translationKey: string) {
    super(translationKey);
    this.name = 'UsdcxBurnError';
  }
}

/**
 * The USDCx faucet id. USDCx is the chain's native asset, so the id is the one the wallet discovers
 * (`lib/miden-chain/native-asset`), never a compiled constant. Throws until the first discovery lands.
 */
export function requireUsdcxFaucetId(): string {
  const faucetId = getNativeAssetIdSync();
  if (!faucetId) throw new UsdcxBurnError('usdcxFaucetUnavailable');
  return faucetId;
}

export function isUsdcxFaucet(faucetId: string | undefined): boolean {
  const usdcxFaucetId = getNativeAssetIdSync();
  return !!faucetId && !!usdcxFaucetId && sameWalletAccountId(faucetId, usdcxFaucetId);
}

export function isUsdcxWithdrawalAvailable(faucetId: string | undefined): boolean {
  return getEffectiveNetworkName() === 'testnet' && isUsdcxFaucet(faucetId);
}

/**
 * Canonical XReserveBurnItems of miden-usdcx 0.17: three words, `[domain, 0, 0, 0]`, then the
 * recipient's eight LE u32 limbs as a double word. The faucet's burn policy refuses a domain
 * word whose padding is not zero.
 */
export function encodeBurnWithdrawal(destinationAddress: string, destinationDomain: number): bigint[] {
  if (!Number.isInteger(destinationDomain) || destinationDomain < 0 || destinationDomain > 0xffffffff) {
    throw new UsdcxBurnError('usdcxInvalidDestination');
  }
  if (!isAddress(destinationAddress)) throw new UsdcxBurnError('usdcxInvalidDestination');
  const bytes = hexToBytes(padHex(destinationAddress, { size: 32 }));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [
    BigInt(destinationDomain),
    0n,
    0n,
    0n,
    ...Array.from({ length: 8 }, (_, i) => BigInt(view.getUint32(i * 4, true)))
  ];
}

/**
 * Whether `destinationChainId` is a destination a burn can pay out to on the effective network:
 * a `USDCX_DESTINATIONS` entry whose chain is a testnet while withdrawals are testnet-only.
 */
export function isUsdcxDestinationChain(destinationChainId: number): boolean {
  const entry = USDCX_DESTINATIONS.get(destinationChainId);
  return !!entry && entry.chain.testnet === true;
}

export function validateUsdcxWithdrawal(faucetId: string, destinationChainId: number, amount: bigint): void {
  if (!isUsdcxWithdrawalAvailable(faucetId)) throw new UsdcxBurnError('usdcxUnsupportedFaucet');
  if (!isUsdcxDestinationChain(destinationChainId)) throw new UsdcxBurnError('usdcxInvalidDestination');
  if (amount <= 0n) throw new UsdcxBurnError('usdcxInvalidAmount');
}
