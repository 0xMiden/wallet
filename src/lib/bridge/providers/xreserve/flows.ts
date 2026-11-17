import type { SubmissionChecks } from 'lib/bridge/core/submission';
import type { BridgeOperationInput } from 'lib/bridge/operation';

import type { XReserveDepositRequest } from './deposit';

export async function runXReserveReceive(
  _operation: BridgeOperationInput,
  _deps: Omit<XReserveDepositRequest, 'operation' | 'rowId'> & { checks: SubmissionChecks }
): Promise<string> {
  throw new Error('Circle provider is unavailable');
}
export async function runXReserveSend(_operation: BridgeOperationInput, _checks: SubmissionChecks): Promise<string> {
  throw new Error('Circle provider is unavailable');
}
