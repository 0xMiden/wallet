import { hexToBytes, isAddress, padHex } from 'viem';

import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { featureAvailability } from 'lib/remote-config/availability';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { getUsdcxDestinations, usdcxPayoutFeeShortfall } from './chains';

export class UsdcxBurnError extends Error {
  /** `values` fills the copy's placeholders, such as the fee allowance a burn must exceed. */
  constructor(
    readonly translationKey: string,
    readonly values?: Record<string, string>
  ) {
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

/**
 * Whether the effective network offers USDCx withdrawals at all, before any token is chosen: its bridge config lists
 * a destination and has `features.usdcxOut` on. A component that reads it subscribes with `useUsdcxRoutes`.
 */
export function isUsdcxWithdrawalNetwork(): boolean {
  return featureAvailability('usdcxOut', getBridgeConfigSnapshot()).state === 'available';
}

export function isUsdcxWithdrawalAvailable(faucetId: string | undefined): boolean {
  return isUsdcxWithdrawalNetwork() && isUsdcxFaucet(faucetId);
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
 * Whether `destinationChainId` is a destination a burn can pay out to on the effective network: a chain its bridge
 * config lists.
 */
export function isUsdcxDestinationChain(destinationChainId: number): boolean {
  return getUsdcxDestinations().has(destinationChainId);
}

export function validateUsdcxWithdrawal(faucetId: string, destinationChainId: number, amount: bigint): void {
  if (!isUsdcxWithdrawalAvailable(faucetId)) throw new UsdcxBurnError('usdcxUnsupportedFaucet');
  if (!isUsdcxDestinationChain(destinationChainId)) throw new UsdcxBurnError('usdcxInvalidDestination');
  if (amount <= 0n) throw new UsdcxBurnError('usdcxInvalidAmount');
  // Circle takes its fee from the payout, so a burn its fee allowance takes whole may pay out nothing.
  const shortfall = usdcxPayoutFeeShortfall(destinationChainId, amount);
  if (shortfall) throw new UsdcxBurnError('usdcxSendMoreThanPayoutFee', shortfall);
}
