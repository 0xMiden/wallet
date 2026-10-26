import type { Signer } from '@openzeppelin/guardian-client';

import { StorageContinuityError } from './continuity';

export function guardianStateReadSigner(
  _delegate: Signer,
  _accountId: string,
  _assertCurrent: () => Promise<void>
): Signer {
  throw new StorageContinuityError();
}
