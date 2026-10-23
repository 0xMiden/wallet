import type { Account } from '@miden-sdk/miden-sdk/lazy';

import { getMessage } from 'lib/i18n/core';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { FEE_RESERVE_MULTIPLE } from 'lib/miden/fees/spendable';
import { getBech32AddressFromAccountId, sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import {
  cacheScope,
  getNativeAssetId,
  getNativeAssetIdSync,
  getVerificationBaseFee,
  getVerificationBaseFeeSync
} from 'lib/miden-chain/native-asset';

import { canonicalFaucetId } from './faucet-ids';

export interface SwapFeeContext {
  scope: string;
  nativeAssetId: string;
  baseFee: bigint;
}

const unavailable = () => new Error(getMessage('swapBalanceUnavailable'));

/** Resolve outside a WASM hold: fee discovery may use its own RPC client. */
export async function readSwapFeeContext(scope = cacheScope()): Promise<SwapFeeContext> {
  if (scope !== cacheScope()) throw unavailable();
  const nativeAssetId = await getNativeAssetId();
  const baseFee = await getVerificationBaseFee();
  return checkedFeeContext(scope, nativeAssetId, baseFee);
}

/** No RPC or nested WASM call; safe inside an execution hold after preflight primed discovery. */
export function getSwapFeeContextSync(scope = cacheScope()): SwapFeeContext {
  return checkedFeeContext(scope, getNativeAssetIdSync(), getVerificationBaseFeeSync());
}

function checkedFeeContext(scope: string, nativeAssetId: string | null, baseFee: number | null): SwapFeeContext {
  if (!nativeAssetId || baseFee === null || !Number.isSafeInteger(baseFee) || baseFee < 0 || scope !== cacheScope()) {
    throw unavailable();
  }
  return { scope, nativeAssetId: canonicalFaucetId(nativeAssetId), baseFee: BigInt(baseFee) };
}

/** Must run inside the caller's current WASM hold; no borrowed Account escapes it. */
export function assertSwapAccountBalance(
  account: Account | undefined | null,
  accountId: string,
  faucetId: string,
  amount: bigint,
  fee: SwapFeeContext
): void {
  if (
    !account ||
    fee.scope !== cacheScope() ||
    !sameWalletAccountId(getBech32AddressFromAccountId(account.id()), accountId)
  ) {
    throw unavailable();
  }
  const offeredId = canonicalFaucetId(faucetId);
  let offered = 0n;
  let native = 0n;
  for (const asset of account.vault().fungibleAssets()) {
    const id = getBech32AddressFromAccountId(asset.faucetId());
    if (id === offeredId) offered += asset.amount();
    if (id === fee.nativeAssetId) native += asset.amount();
  }
  if (native < fee.baseFee) throw new Error(getMessage('insufficientFeeAsset'));
  const reserve = offeredId === fee.nativeAssetId ? fee.baseFee * BigInt(FEE_RESERVE_MULTIPLE) : 0n;
  if (amount <= 0n || offered < amount + reserve) throw new Error(getMessage('amountMustBeLessThanBalance'));
}

/** Local SDK vault, not display state or a promise of remote-chain freshness. Never syncs. */
export async function assertSwapVaultBalance(
  accountId: string,
  faucetId: string,
  amount: bigint,
  scope = cacheScope()
): Promise<void> {
  const fee = await readSwapFeeContext(scope);
  await withWasmClientLock(
    async hold => {
      const account = await midenClientProxy.getAccount(accountId);
      assertWasmHoldCurrent(hold, 'swap balance preflight: after account read');
      assertSwapAccountBalance(account, accountId, faucetId, amount, fee);
    },
    { label: 'swap-balance' }
  );
}
