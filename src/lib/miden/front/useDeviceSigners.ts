import { useEffect, useState } from 'react';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { findOwnSignerCommitment, getSignerCommitmentsFromAccount } from 'lib/miden/guardian/account';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { sameCommitment } from 'lib/secure-hot-key/commitment';
import type { WalletAccount } from 'lib/shared/types';

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
  return withWasmClientLock(
    async hold => {
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
    },
    { label: 'device-list' }
  );
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
