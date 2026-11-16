import type { QuoteRequest, QuoteResult } from 'lib/bridge/core/quote';
import type { BridgeOperationInput } from 'lib/bridge/operation';
import type { BridgeNoteDeps } from 'lib/epoch/miden-note';

export async function quoteEpochSend(_request: QuoteRequest): Promise<QuoteResult> {
  throw new Error('Epoch Command quote adapter is unavailable');
}

export async function runEpochSend(
  _operation: BridgeOperationInput,
  _deps: BridgeNoteDeps,
  _onRowCreated?: (txId: string) => void
): Promise<{ txId?: string }> {
  throw new Error('Epoch Command send adapter is unavailable');
}
