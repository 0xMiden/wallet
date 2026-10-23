import { useEffect, useRef, useState } from 'react';

import { assertOneClickDeadline, assertOneClickFundingDeadline } from 'lib/one-click/deadline';
import { OneClickQuoteResponse, OneClickQuoteRequest } from 'lib/one-click/types';

export type OneClickQuoteQuery = (request: OneClickQuoteRequest) => Promise<OneClickQuoteResponse>;

interface QuoteState {
  quote?: OneClickQuoteResponse;
  loading: boolean;
  error?: Error;
}

export type OneClickQuotePreview = QuoteState;

const PREVIEW_DEBOUNCE_MS = 350;

export function useOneClickQuote(
  request: OneClickQuoteRequest | undefined,
  query: OneClickQuoteQuery,
  active = true
): OneClickQuotePreview {
  const [state, setState] = useState<QuoteState>({ loading: false });
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
      interval = window.setInterval(refresh, 30_000);
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

export function oneClickQuoteExpired(quote: OneClickQuoteResponse, now = Date.now()): boolean {
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
