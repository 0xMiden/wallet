import type { QuoteRequest, QuoteResult } from 'lib/bridge/core/quote';

export async function quoteAgglayer(_request: QuoteRequest, _signal: AbortSignal): Promise<QuoteResult | null> {
  throw new Error('Agglayer quote port is unavailable');
}
