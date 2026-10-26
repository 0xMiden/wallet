import type { MidenClient } from '@miden-sdk/miden-sdk/lazy';

import { StorageContinuityError } from './continuity';
import type { RecoveryAccountExpectation } from './types';

export interface RecoveryAccountMaterial {
  floor: RecoveryAccountExpectation;
  accountBytes: Uint8Array;
  guardianCommitment: string;
  signerCommitments: string[];
  chainCommitment: string;
}

export interface RecoveryAccountClient {
  accounts: Pick<MidenClient['accounts'], 'get' | 'insert'>;
}

export async function restoreRetainedGuardianAccount(
  _client: RecoveryAccountClient,
  _material: RecoveryAccountMaterial,
  _assertCurrent: () => void
): Promise<void> {
  throw new StorageContinuityError();
}
