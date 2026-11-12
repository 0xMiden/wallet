import { useEffect, useRef, useState } from 'react';

import { assertOneClickDeadline, assertOneClickFundingDeadline } from 'lib/one-click/deadline';
import type { OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';

export type NearIntentsQuoteQuery = (request: OneClickQuoteRequest) => Promise<OneClickQuoteResponse>;

export interface NearIntentsQuotePreview {
  quote?: OneClickQuoteResponse;
  loading: boolean;
  error?: Error;
}

/** The wait after the last change to the request before the hook asks for a quote. */
export const PREVIEW_DEBOUNCE_MS = 350;
/** The interval at which the hook asks again for the same request, while it is active. */
export const PREVIEW_REFRESH_MS = 30_000;

/**
 * A dry 1Click quote for the current request. The hook waits `PREVIEW_DEBOUNCE_MS` after a change,
 * then asks again every `PREVIEW_REFRESH_MS`. It ignores an answer for a request that is not the
 * current one. A new request clears the previous quote; a refresh of the same request keeps it.
 */
export function useNearIntentsQuote(
  request: OneClickQuoteRequest | undefined,
  query: NearIntentsQuoteQuery,
  active = true
): NearIntentsQuotePreview {
  const [state, setState] = useState<NearIntentsQuotePreview>({ loading: false });
  const requestKey = request === undefined ? '' : JSON.stringify(request);
  const sequence = useRef(0);
  const currentKey = useRef(requestKey);
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    const nextRequest = requestRef.current;
    sequence.current += 1;
    const sameRequest = currentKey.current === requestKey;
    currentKey.current = requestKey;
    setState(previous => ({
      quote: sameRequest ? previous.quote : undefined,
      loading: nextRequest !== undefined && active
    }));
    if (nextRequest === undefined || !active)
      return () => {
        sequence.current += 1;
      };

    let stopped = false;
    const refresh = () => {
      const ownRequest = ++sequence.current;
      setState(previous => ({ ...previous, loading: true, error: undefined }));
      query(nextRequest).then(
        quote => {
          if (!stopped && sequence.current === ownRequest) setState({ quote, loading: false });
        },
        error => {
          if (!stopped && sequence.current === ownRequest) {
            setState(previous => ({
              quote: previous.quote,
              loading: false,
              error: error instanceof Error ? error : new Error(String(error))
            }));
          }
        }
      );
    };
    let interval: number | undefined;
    const timer = window.setTimeout(() => {
      refresh();
      interval = window.setInterval(refresh, PREVIEW_REFRESH_MS);
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (interval !== undefined) window.clearInterval(interval);
      sequence.current += 1;
    };
  }, [requestKey, query, active]);

  return state;
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
