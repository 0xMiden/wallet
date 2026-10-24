import type { Account } from '@miden-sdk/miden-sdk/lazy';

import { getMessage } from 'lib/i18n/core';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { FEE_RESERVE_MULTIPLE } from 'lib/miden/fees/spendable';
import { selectFungibleAssetSlot } from 'lib/miden/sdk/fungible-asset-slot';
import { getBech32AddressFromAccountId, sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { cacheScope } from 'lib/miden-chain/native-asset';

import { canonicalFaucetId } from './faucet-ids';
import { assertSwapFeeContextCurrent, readSwapFeeContext, type SwapFeeContext } from './fee-context';

export { assertSwapFeeContextMatches, getSwapFeeContextSync, readSwapFeeContext } from './fee-context';
export type { SwapFeeContext } from './fee-context';

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
    throw new Error(getMessage('swapBalanceUnavailable'));
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
