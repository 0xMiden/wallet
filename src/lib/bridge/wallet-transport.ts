import { bindTransferQuote, type QuoteRequest, type TransferQuote } from './core/quote';
import { quoteAgglayer } from './providers/agglayer/quote';
import { quoteEpochSend } from './providers/epoch';
import { quoteXReserve } from './providers/xreserve/quote';

export async function quoteBridgeTransfer(request: QuoteRequest, signal: AbortSignal): Promise<TransferQuote | null> {
  request = structuredClone(request);
  signal.throwIfAborted();
  // Retained Epoch 2.0.1 only reverse-quotes EVM input; never reinterpret the one editable source amount as output.
  if (request.route.provider === 'epoch' && request.route.mode === 'receive') return null;
  const result = request.route.provider === 'epoch'
    ? await quoteEpochSend(request)
    : request.route.provider === 'agglayer'
      ? await quoteAgglayer(request, signal)
      : await quoteXReserve(request, signal);
  signal.throwIfAborted();
  return result ? bindTransferQuote(request, result) : null;
}
