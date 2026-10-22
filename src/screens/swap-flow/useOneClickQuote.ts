import { useCallback, useEffect, useRef, useState } from 'react';

import { OneClickQuoteResponse, OneClickQuoteRequest } from 'lib/one-click/types';

export type OneClickQuoteQuery = (request: OneClickQuoteRequest) => Promise<OneClickQuoteResponse>;

interface QuoteState {
  quote?: OneClickQuoteResponse;
  loading: boolean;
  error?: Error;
}

export interface OneClickQuotePreview extends QuoteState {
  refresh: () => Promise<OneClickQuoteResponse | undefined>;
}

export function useOneClickQuote(
  request: OneClickQuoteRequest | undefined,
  query: OneClickQuoteQuery,
  debounceMs = 300,
  active = true
): OneClickQuotePreview {
  const [state, setState] = useState<QuoteState>({ loading: false });
  const requestKey = request === undefined ? '' : JSON.stringify(request);
  const sequence = useRef(0);
  const currentKey = useRef(requestKey);
  const requestRef = useRef(request);
  requestRef.current = request;

  const fetchQuote = useCallback(
    async (nextRequest: OneClickQuoteRequest): Promise<OneClickQuoteResponse | undefined> => {
      const current = ++sequence.current;
      setState({ loading: true });
      try {
        const quote = await query(nextRequest);
        if (sequence.current !== current) return undefined;
        setState({ quote, loading: false });
        return quote;
      } catch (error) {
        if (sequence.current === current) {
          setState({ loading: false, error: error instanceof Error ? error : new Error(String(error)) });
        }
        return undefined;
      }
    },
    [query]
  );

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
    }, debounceMs);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (interval !== undefined) window.clearInterval(interval);
      sequence.current += 1;
    };
  }, [requestKey, query, debounceMs, active]);

  const refresh = useCallback(async () => {
    const currentRequest = requestRef.current;
    if (currentRequest === undefined) return undefined;
    return fetchQuote(currentRequest);
  }, [fetchQuote]);

  return { ...state, refresh };
}

export function oneClickQuoteExpired(quote: OneClickQuoteResponse, now = Date.now()): boolean {
  const expiry = quote.quote.deadline;
  const expiryTime = expiry === undefined ? Number.NaN : Date.parse(expiry);
  return !Number.isFinite(expiryTime) || expiryTime <= now;
}
