import type { SubmissionChecks } from 'lib/bridge/core/submission';
import type { BridgeOperationInput } from 'lib/bridge/operation';

import type { AgglayerDepositRequest } from './deposit';

export async function runAgglayerReceive(_operation: BridgeOperationInput, _deps: Omit<AgglayerDepositRequest, 'operation' | 'rowId'> & { checks: SubmissionChecks }): Promise<string> {
  throw new Error('Agglayer receive admission port unavailable');
}
