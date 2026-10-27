import { createIntercomClient } from 'lib/intercom/client';
import { WalletMessageType } from 'lib/shared/types';

import { getProviderReceiptBackend } from './receipt-backend';
import { toSerializable } from './serialization';
import { projectRecoveryTransaction } from './transaction-record';
import type { ITransaction } from '../db/types';
import { assertStorageHealthy, getStorageHealth } from '../storage-health';

export async function checkpointProviderReceipt(row: ITransaction): Promise<void> {
  assertStorageHealthy();
  const epoch = getStorageHealth().epoch;
  const value = toSerializable(projectRecoveryTransaction(row));
  const backend = getProviderReceiptBackend();
  if (backend) {
    await backend(value, epoch);
  } else {
    const response: unknown = await createIntercomClient().request({
      type: WalletMessageType.ProviderReceiptRequest,
      expectedEpoch: epoch,
      row: value
    });
    if (
      typeof response !== 'object' ||
      response === null ||
      Reflect.get(response, 'type') !== WalletMessageType.ProviderReceiptResponse
    )
      throw new Error('Provider receipt acknowledgement unavailable');
  }
  assertStorageHealthy(epoch);
}
