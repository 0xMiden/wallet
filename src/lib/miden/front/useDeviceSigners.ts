import { useEffect, useState } from 'react';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { findOwnSignerCommitment, getSignerCommitmentsFromAccount } from 'lib/miden/guardian/account';
import { assertWasmHoldCurrent, tryWithWasmClientLock, type WasmLockHold } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import { sameCommitment } from 'lib/secure-hot-key/commitment';
import type { WalletAccount } from 'lib/shared/types';

import { SIGNER_COUNT_BUSY_ATTEMPTS, SIGNER_COUNT_BUSY_DELAY_MS } from './useOnChainSignerCount';

export interface DeviceSigner {
  commitment: string;
  current: boolean;
}

export async function readDeviceSigners(
  account: Pick<WalletAccount, 'publicKey' | 'coldPublicKey' | 'hotPublicKey'>
): Promise<DeviceSigner[]> {
  if (!account.coldPublicKey || !account.hotPublicKey) throw new Error('Signer identity is unavailable');
  const coldPublicKey = account.coldPublicKey;
  const hotPublicKey = account.hotPublicKey;
  const readUnderHold = async (hold: WasmLockHold) => {
    const state = await midenClientProxy.getAccount(account.publicKey);
    assertWasmHoldCurrent(hold, 'device list', 'after account read');
    if (!state) throw new Error('Account is unavailable');
    const recovery = await findOwnSignerCommitment(state, coldPublicKey);
    assertWasmHoldCurrent(hold, 'device list', 'after recovery key read');
    const current = await findOwnSignerCommitment(state, hotPublicKey);
    assertWasmHoldCurrent(hold, 'device list', 'after device key read');
    if (!recovery) throw new Error('Recovery key is unavailable');
    return getSignerCommitmentsFromAccount(state)
      .filter(commitment => !sameCommitment(commitment, recovery))
      .map(commitment => ({ commitment, current: current !== undefined && sameCommitment(commitment, current) }));
  };
  // Never queued behind a sync or a transaction: a few short tries, as for the device count, then the
  // list reads as unavailable and the screen offers its retry.
  for (let attempt = 0; attempt < SIGNER_COUNT_BUSY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise<void>(resolve => setTimeout(resolve, SIGNER_COUNT_BUSY_DELAY_MS));
    const read = await tryWithWasmClientLock(readUnderHold, {
      watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
      label: 'device-list'
    });
    if (read.ran) return read.value;
  }
  throw new Error('Client is busy');
}

export function useDeviceSigners(account: WalletAccount | null, refresh: number) {
  const [result, setResult] = useState<{ accountId: string; devices: DeviceSigner[] }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    setFailed(false);
    if (account) {
      readDeviceSigners(account)
        .then(devices => {
          if (!cancelled) setResult({ accountId: account.publicKey, devices });
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [account, refresh]);
  return { devices: result?.accountId === account?.publicKey ? result?.devices : undefined, failed };
}
