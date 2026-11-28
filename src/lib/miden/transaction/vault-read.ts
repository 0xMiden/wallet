import { midenClientProxy } from '../back/miden-client-proxy';
import { isSyncFused, noteProbeFailure, noteSyncSuccess } from '../front/sync-fuse';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { assertWasmHoldCurrent, tryWithWasmClientLock } from '../sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from '../sdk/wasm-client-poison';

/**
 * The account's fungible holdings by bech32 faucet id, in base units, read without waiting for the client lock.
 * `null` when the read could not run: a busy or fused client, an unknown account, or a failed read. An unavailable
 * fact must never read as an empty vault.
 */
export async function readVaultHoldings(accountId: string, label: string): Promise<Map<string, bigint> | null> {
  if (isSyncFused('balances')) return null;
  try {
    const read = await tryWithWasmClientLock(
      async hold => {
        const result = await midenClientProxy.tryGetAccount(accountId);
        assertWasmHoldCurrent(hold, `inside the ${label} read`, 'after the account read');
        if (!result.ran) return null;
        if (!result.account) return null;
        const held = new Map<string, bigint>();
        for (const asset of result.account.vault().fungibleAssets()) {
          const faucetId = getBech32AddressFromAccountId(asset.faucetId());
          held.set(faucetId, (held.get(faucetId) ?? 0n) + asset.amount());
        }
        return held;
      },
      { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label }
    ).catch(error => {
      noteProbeFailure('balances', error);
      throw error;
    });
    if (!read.ran || read.value === null) return null;
    noteSyncSuccess('balances');
    return read.value;
  } catch {
    // A trap must reach the lock's retirement path before it becomes an unknown holding.
    return null;
  }
}
