import type { EIP1193Provider, PublicClient } from 'viem';

import type { SubmissionChecks } from 'lib/bridge/core/submission';
import type { TokenApprovalClient } from 'lib/bridge/evm/token-approval';
import type { BridgeOperationSnapshot } from 'lib/bridge/operation';

export type XReserveClient = TokenApprovalClient & Pick<PublicClient, 'estimateGas' | 'getBalance' | 'getGasPrice'>;
export interface XReserveDepositRequest {
  rowId: string;
  operation: BridgeOperationSnapshot;
  provider: EIP1193Provider;
  client: XReserveClient;
  checks: Pick<SubmissionChecks, 'readCurrent' | 'now'>;
}
export async function submitXReserveDeposit(_request: XReserveDepositRequest): Promise<void> {
  throw new Error('Circle provider is unavailable');
}
