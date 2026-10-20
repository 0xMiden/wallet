import { getMessage } from 'lib/i18n/core';
import { assertEarnDepositAvailable, geoFeatureGate } from 'lib/remote-config/availability';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

import type { ITransactionType } from '../db/types';

export function assertTransactionFeatureAllowed(transactionType: ITransactionType): void {
  if (transactionType === 'earn-deposit') {
    assertEarnDepositAvailable(getBridgeConfigSnapshot());
  } else if (transactionType === 'swap') {
    const snapshot = getBridgeConfigSnapshot();
    if (geoFeatureGate('swap', snapshot.config, snapshot.geo) !== null) {
      throw new Error(getMessage('swapUnavailableTitle'));
    }
  }
}
