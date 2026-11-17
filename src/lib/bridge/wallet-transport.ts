import type { QuoteRequest, TransferQuote } from './core/quote';

export async function quoteBridgeTransfer(request: QuoteRequest, signal: AbortSignal): Promise<TransferQuote | null> {
  signal.throwIfAborted();
  void request;
  return null;
}
