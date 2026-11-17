import type { QuoteRequest, QuoteResult } from 'lib/bridge/core/quote';

export async function quoteXReserve(_request: QuoteRequest, _signal: AbortSignal): Promise<QuoteResult | null> {
  return null;
}
