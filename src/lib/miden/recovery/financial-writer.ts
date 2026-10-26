import { createIntercomClient } from 'lib/intercom/client';
import { WalletMessageType } from 'lib/shared/types';

import { getFinancialRecoveryBackend } from './financial-backend';
import { toSerializable } from './serialization';
import type { RecoveryDebitEntry, RecoveryPolicyEntry } from './types';
import { assertStorageHealthy, getStorageHealth } from '../storage-health';

export async function withFinancialRecoveryLock<T>(operation: () => Promise<T>): Promise<T> {
  assertStorageHealthy();
  const epoch = getStorageHealth().epoch;
  return new Promise<T>((resolve, reject) => {
    void navigator.locks
      .request('miden-financial-recovery-v1', async () => {
        try {
          assertStorageHealthy(epoch);
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      })
      .catch(reject);
  });
}

async function send(accountId: string, entry?: RecoveryDebitEntry | RecoveryPolicyEntry): Promise<void> {
  assertStorageHealthy();
  const epoch = getStorageHealth().epoch;
  const backend = getFinancialRecoveryBackend();
  if (backend) {
    await backend(accountId, entry, epoch);
  } else if (process.env.WALLET_BUILD_TARGET === 'extension') {
    const response: unknown = await createIntercomClient().request({
      type: WalletMessageType.FinancialRecoveryRequest,
      accountId,
      expectedEpoch: epoch,
      entry: toSerializable(entry)
    });
    if (
      typeof response !== 'object' ||
      response === null ||
      Reflect.get(response, 'type') !== WalletMessageType.FinancialRecoveryResponse
    )
      throw new Error('Financial recovery checkpoint unavailable');
  } else {
    const { withUnlocked } = await import('../back/store');
    assertStorageHealthy(epoch);
    await withUnlocked(({ vault }) => vault.checkpointFinancialRecovery(accountId, entry));
  }
  assertStorageHealthy(epoch);
}

export const verifyFinancialRecovery = (accountId: string): Promise<void> => send(accountId);
export const checkpointFinancialChange = (entry: RecoveryDebitEntry | RecoveryPolicyEntry): Promise<void> =>
  send(entry.accountId, entry);
