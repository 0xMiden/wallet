import type { Account } from '@miden-sdk/miden-sdk/lazy';

import { getMessage } from 'lib/i18n/core';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { FEE_RESERVE_MULTIPLE } from 'lib/miden/fees/spendable';
import { selectFungibleAssetSlot } from 'lib/miden/sdk/fungible-asset-slot';
import { getBech32AddressFromAccountId, sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getEffectiveFeeFaucetId } from 'lib/miden-chain/effective-endpoints';
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
  feeFaucetId: string | null;
  baseFee: bigint;
}

const unavailable = () => new Error(getMessage('swapBalanceUnavailable'));

/** Resolve outside a WASM hold: fee discovery may use its own RPC client. */
export async function readSwapFeeContext(scope = cacheScope()): Promise<SwapFeeContext> {
  const feeFaucetId = activeFeeFaucetId();
  if (scope !== cacheScope()) throw unavailable();
  const nativeAssetId = await getNativeAssetId();
  const baseFee = await getVerificationBaseFee();
  return checkedFeeContext(scope, nativeAssetId, baseFee, feeFaucetId);
}

export function assertSwapFeeContextMatches(
  queued: SwapFeeContext,
  current: SwapFeeContext,
  expectedScope = queued.scope
): SwapFeeContext {
  if (
    queued.scope !== expectedScope ||
    current.scope !== expectedScope ||
    queued.nativeAssetId !== current.nativeAssetId ||
    queued.feeFaucetId !== current.feeFaucetId ||
    queued.baseFee !== current.baseFee
  ) {
    throw unavailable();
  }
  return current;
}

/** No RPC or nested WASM call; safe inside an execution hold after preflight primed discovery. */
export function getSwapFeeContextSync(scope = cacheScope()): SwapFeeContext {
  return checkedFeeContext(scope, getNativeAssetIdSync(), getVerificationBaseFeeSync(), activeFeeFaucetId());
}

function activeFeeFaucetId(): string | null {
  const id = getEffectiveFeeFaucetId();
  return id ? canonicalFaucetId(id) : null;
}

function checkedFeeContext(
  scope: string,
  nativeAssetId: string | null,
  baseFee: number | null,
  feeFaucetId: string | null
): SwapFeeContext {
  const canonicalNativeAssetId = nativeAssetId ? canonicalFaucetId(nativeAssetId) : null;
  if (!canonicalNativeAssetId || baseFee === null || !Number.isSafeInteger(baseFee) || baseFee < 0) throw unavailable();
  const context = { scope, nativeAssetId: canonicalNativeAssetId, feeFaucetId, baseFee: BigInt(baseFee) };
  assertSwapFeeContextCurrent(context, scope);
  return context;
}

function assertSwapFeeContextCurrent(fee: SwapFeeContext, expectedScope = fee.scope, checkSyncBaseFee = false): void {
  const currentNativeAssetId = getNativeAssetIdSync();
  const currentBaseFee = checkSyncBaseFee ? getVerificationBaseFeeSync() : null;
  if (
    fee.scope !== expectedScope ||
    fee.scope !== cacheScope() ||
    fee.feeFaucetId !== activeFeeFaucetId() ||
    (fee.feeFaucetId !== null && fee.nativeAssetId !== fee.feeFaucetId) ||
    (currentNativeAssetId !== null && canonicalFaucetId(currentNativeAssetId) !== fee.nativeAssetId) ||
    (currentBaseFee !== null &&
      (!Number.isSafeInteger(currentBaseFee) || currentBaseFee < 0 || BigInt(currentBaseFee) !== fee.baseFee))
  ) {
    throw unavailable();
  }
}

/** Must run inside the caller's current WASM hold; no borrowed Account escapes it. */
export function assertSwapAccountBalance(
  account: Account | undefined | null,
  accountId: string,
  faucetId: string,
  amount: bigint,
  fee: SwapFeeContext,
  expectedScope = fee.scope
): void {
  assertSwapFeeContextCurrent(fee, expectedScope, true);
  if (!account || !sameWalletAccountId(getBech32AddressFromAccountId(account.id()), accountId)) {
    throw unavailable();
  }
  const offeredId = canonicalFaucetId(faucetId);
  const assets = account.vault().fungibleAssets();
  const offeredAssets = assets.filter(asset => getBech32AddressFromAccountId(asset.faucetId()) === offeredId);
  let native = 0n;
  for (const asset of assets) {
    const id = getBech32AddressFromAccountId(asset.faucetId());
    if (id === fee.nativeAssetId) native += asset.amount();
  }
  if (native < fee.baseFee) throw new Error(getMessage('insufficientFeeAsset'));
  const reserve = offeredId === fee.nativeAssetId ? fee.baseFee * BigInt(FEE_RESERVE_MULTIPLE) : 0n;
  const selected = selectFungibleAssetSlot(offeredAssets, amount);
  if (amount <= 0n || !selected || selected.amount() < amount + reserve) {
    throw new Error(getMessage('amountMustBeLessThanBalance'));
  }
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
      assertSwapAccountBalance(account, accountId, faucetId, amount, fee, scope);
    },
    { label: 'swap-balance' }
  );
}
