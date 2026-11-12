import { useEffect, useState } from 'react';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { getSignerCommitmentsFromAccount } from 'lib/miden/guardian/account';
import { assertWasmHoldCurrent, tryWithWasmClientLock, type WasmLockHold } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';

/** The number of tries when the WASM lock is busy. After the last try, the read stops and gives no count. */
export const SIGNER_COUNT_BUSY_ATTEMPTS = 3;
/** The time between two tries when the WASM lock is busy. */
export const SIGNER_COUNT_BUSY_DELAY_MS = 500;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Reads the number of devices that hold the account: the on-chain signer list less the recovery (cold) key.
 *
 * The read takes the WASM lock without a wait (`tryWithWasmClientLock`), so it never stays behind a sync or a
 * transaction. It reads the account from IndexedDB and does not sync. It makes a check of the hold after the
 * account read, because an eviction releases the mutex and the next client call goes to a different client.
 * A busy lock causes a small number of tries. A failure gives `undefined`, because the count is only a help text.
 */
export async function readOnChainSignerCount(accountPublicKey: string): Promise<number | undefined> {
  const readSigners = async (hold: WasmLockHold) => {
    const account = await midenClientProxy.getAccount(accountPublicKey);
    assertWasmHoldCurrent(hold, 'device count read', 'after the account read');
    if (!account) return undefined;
    return getSignerCommitmentsFromAccount(account).length;
  };

  for (let attempt = 0; attempt < SIGNER_COUNT_BUSY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(SIGNER_COUNT_BUSY_DELAY_MS);
    try {
      const read = await tryWithWasmClientLock(readSigners, {
        watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
        label: 'device-count'
      });
      if (!read.ran) continue;
      // An account without signers is not a Guardian account that this count can describe.
      if (read.value === undefined || read.value < 1) return undefined;
      return read.value - 1;
    } catch (error) {
      console.warn('[useOnChainSignerCount] device count read failed:', error);
      return undefined;
    }
  }
  return undefined;
}

/**
 * The number of devices that hold the account, from the on-chain signer list. It is `undefined` while the read
 * runs, and when the read did not complete.
 */
export function useOnChainSignerCount(accountPublicKey: string): number | undefined {
  const [count, setCount] = useState<{ account: string; value: number | undefined } | null>(null);

  useEffect(() => {
    let cancelled = false;
    readOnChainSignerCount(accountPublicKey).then(value => {
      if (!cancelled) setCount({ account: accountPublicKey, value });
    });
    return () => {
      cancelled = true;
    };
  }, [accountPublicKey]);

  // A count for a different account is not a count for this one.
  return count?.account === accountPublicKey ? count.value : undefined;
}
