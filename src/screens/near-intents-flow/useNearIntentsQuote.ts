import { useRef } from 'react';

import { assertOneClickDeadline, assertOneClickFundingDeadline } from 'lib/one-click/deadline';
import type { OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';

import { usePolledPreview } from './usePolledPreview';

export { PREVIEW_DEBOUNCE_MS, PREVIEW_REFRESH_MS } from './usePolledPreview';

export type NearIntentsQuoteQuery = (
  request: OneClickQuoteRequest,
  signal: AbortSignal
) => Promise<OneClickQuoteResponse>;

export interface NearIntentsQuotePreview {
  quote?: OneClickQuoteResponse;
  loading: boolean;
  error?: Error;
}

/**
 * A dry 1Click quote for the current request, polled by `usePolledPreview`: it waits `PREVIEW_DEBOUNCE_MS` after a
 * change, then asks again `PREVIEW_REFRESH_MS` after each answer. A new request, a pause or an unmount aborts the
 * request on its way. A new request clears the previous quote; a refresh of the same request keeps it.
 */
export function useNearIntentsQuote(
  request: OneClickQuoteRequest | undefined,
  query: NearIntentsQuoteQuery,
  active = true
): NearIntentsQuotePreview {
  const requestKey = request === undefined ? '' : JSON.stringify(request);
  const requestRef = useRef(request);
  requestRef.current = request;
  const queryRef = useRef(query);
  queryRef.current = query;

  const preview = usePolledPreview(requestKey, active, signal => {
    const current = requestRef.current;
    if (current === undefined) return Promise.reject(new Error('There is no NEAR Intents quote request'));
    return queryRef.current(current, signal);
  });
  return { quote: preview.value, loading: preview.loading, error: preview.error };
}

/** True when the deadline of the quote has passed, so the quote cannot be used. */
export function nearIntentsQuoteExpired(quote: OneClickQuoteResponse, now = Date.now()): boolean {
  try {
    if (quote.quoteRequest.dry) {
      assertOneClickDeadline(quote.quoteRequest.deadline, now);
    } else {
      assertOneClickFundingDeadline(quote.quoteRequest.deadline, quote.quote.deadline, now);
    }
    return false;
  } catch {
    return true;
  }
}
