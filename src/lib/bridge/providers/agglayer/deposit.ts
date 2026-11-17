import type { EIP1193Provider, PublicClient } from 'viem';

import type { SourceTransactionClient } from 'lib/bridge/evm/source-transaction';
import type { BridgeOperationSnapshot } from 'lib/bridge/operation';

export type AgglayerClient = SourceTransactionClient & Pick<
  PublicClient,
  'readContract' | 'call' | 'estimateGas' | 'waitForTransactionReceipt' | 'getBalance' | 'getGasPrice'
>;
export interface AgglayerDepositRequest {
  rowId: string;
  operation: BridgeOperationSnapshot;
  provider: EIP1193Provider;
  client: AgglayerClient;
}

export async function submitAgglayerDeposit(_request: AgglayerDepositRequest): Promise<void> {
  throw new Error('Agglayer deposit port is unavailable');
}
