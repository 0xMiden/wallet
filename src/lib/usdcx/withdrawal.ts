import { hexToBytes, isAddress, padHex } from 'viem';

import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { USDCX_FAUCET_ID_BECH32, USDCX_WITHDRAWAL_DESTINATION } from './constant';

export class UsdcxBurnError extends Error {
  constructor(readonly translationKey: string) {
    super(translationKey);
    this.name = 'UsdcxBurnError';
  }
}

export function isUsdcxFaucet(faucetId: string | undefined): boolean {
  return !!faucetId && sameWalletAccountId(faucetId, USDCX_FAUCET_ID_BECH32);
}

export function isUsdcxWithdrawalAvailable(faucetId: string | undefined): boolean {
  return getEffectiveNetworkName() === 'testnet' && isUsdcxFaucet(faucetId);
}

/** Canonical XReserveBurnItems: domain, eight LE u32 recipient limbs, three padding felts. */
export function encodeBurnWithdrawal(destinationAddress: string, destinationDomain: number): bigint[] {
  if (!Number.isInteger(destinationDomain) || destinationDomain < 0 || destinationDomain > 0xffffffff) {
    throw new UsdcxBurnError('usdcxInvalidDestination');
  }
  if (!isAddress(destinationAddress)) throw new UsdcxBurnError('usdcxInvalidDestination');
  const bytes = hexToBytes(padHex(destinationAddress, { size: 32 }));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [
    BigInt(destinationDomain),
    ...Array.from({ length: 8 }, (_, i) => BigInt(view.getUint32(i * 4, true))),
    0n,
    0n,
    0n
  ];
}

export function validateUsdcxWithdrawal(faucetId: string, destinationChainId: number, amount: bigint): void {
  if (!isUsdcxWithdrawalAvailable(faucetId)) throw new UsdcxBurnError('usdcxUnsupportedFaucet');
  if (destinationChainId !== USDCX_WITHDRAWAL_DESTINATION.chainId) {
    throw new UsdcxBurnError('usdcxInvalidDestination');
  }
  if (amount <= 0n) throw new UsdcxBurnError('usdcxInvalidAmount');
}
