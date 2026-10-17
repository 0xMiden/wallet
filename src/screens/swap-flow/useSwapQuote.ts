import { useCallback, useEffect, useRef, useState } from 'react';

import { useDebounce } from 'use-debounce';

import { stringToBigInt } from 'lib/i18n/numbers';
import {
  quoteSwap,
  SWAP_QUOTE_REFRESH_MS,
  SwapQuote,
  swapQuoteErrorCode,
  SwapQuoteErrorCode
} from 'lib/miden/swap/quote';
import { SwapToken } from 'lib/miden/swap/tokens';

export interface SwapQuoteState {
  loading: boolean;
  /** The latest quote for the current pair and inputs, once resolved. */
  quote?: SwapQuote;
  error?: string;
  /** The service's stable code for `error`, so the form can name the reason. */
  errorCode?: SwapQuoteErrorCode;
}

export interface UseSwapQuoteOpts {
  offerToken: SwapToken;
  requestToken: SwapToken;
  /** Human display amounts, as typed. */
  offerAmount: string;
  requestAmount: string;
  /** The user took the receive field over: quote THEIR ask instead of building one. */
  requestEdited: boolean;
  slippageBps: number;
  /** Gate: only quote when the pair is swappable (e.g. two different tokens). */
  enabled: boolean;
  /** The page is on screen: a quote is refreshed every `SWAP_QUOTE_REFRESH_MS` only while it is. */
  active: boolean;
}

export interface UseSwapQuoteResult extends SwapQuoteState {
  /**
   * A fresh quote for the live inputs, now, skipping the debounce: the pre-submit check. Given an
   * ask, it checks THAT ask (the one on screen, about to be signed) rather than building one, and a
   * wallet-built ask stays wallet-built. It supersedes any request in flight and lands in the hook's
   * state too. Rejects as `quoteSwap`.
   */
  quoteNow: (requestedAmount?: bigint) => Promise<SwapQuote>;
}

const IDLE: SwapQuoteState = { loading: false };
const PENDING: SwapQuoteState = { loading: true };

/** Every non-idle state records the pair it was fetched for, as `offer|request` faucet ids. */
type PairedState = SwapQuoteState & {
  pair?: string;
  /** When the last request for this pair landed or failed; the refresh timer counts from it. */
  settledAt?: number;
};

const pairOf = (offerFaucetId: string, requestFaucetId: string) => `${offerFaucetId}|${requestFaucetId}`;

interface QuoteKey {
  of: string;
  oa: string;
  rf: string;
  /** The user's own ask, or null while the quote builds it. */
  ra: string | null;
  bps: number;
}

const toBigIntOrZero = (amount: string, decimals: number): bigint => {
  try {
    return stringToBigInt(amount || '0', decimals);
  } catch {
    return 0n;
  }
};

const failed = (pair: string, error: unknown): PairedState => ({
  loading: false,
  pair,
  error: error instanceof Error ? error.message : 'Quote failed',
  errorCode: swapQuoteErrorCode(error),
  settledAt: Date.now()
});

/**
 * Debounced quote for the current swap pair through the Swap Quote API v2 (`quoteSwap`): the
 * price, the ask built from it at the chosen slippage (or the user's own ask), and the solver's
 * verdict on that ask. Once the user stops typing, the whole input set is quoted; in-flight
 * requests are superseded by a request id so a slow earlier quote can't overwrite a newer one.
 *
 * While the receive field is wallet-built its typed value is NOT part of the key: the quote
 * produces it, so re-keying on it would quote twice per keystroke. Once the user edits it, the
 * key carries their ask and the quote checks that instead.
 *
 * A quote or error is returned only for the pair it was fetched for. A flip or a token change
 * reads as `{ loading: true }` until the new pair's own answer lands, so the old pair's rate can
 * never price (or its error block) the new order.
 *
 * A landed quote is refreshed every `SWAP_QUOTE_REFRESH_MS` while the page is active, so a review
 * left open shows a price the solver would still fill at; a page that comes back to the screen
 * with a stale quote refreshes at once.
 */
export function useSwapQuote({
  offerToken,
  requestToken,
  offerAmount,
  requestAmount,
  requestEdited,
  slippageBps,
  enabled,
  active
}: UseSwapQuoteOpts): UseSwapQuoteResult {
  const offerRaw = toBigIntOrZero(offerAmount, offerToken.decimals);
  const requestRaw = toBigIntOrZero(requestAmount, requestToken.decimals);
  // The endpoint requires requested_amount > 0, so an edited field that is empty is not quotable.
  const ready =
    enabled && offerRaw > 0n && offerToken.faucetId !== requestToken.faucetId && (!requestEdited || requestRaw > 0n);

  // Debounce the whole input set so keystrokes on either amount don't spam the quote endpoint.
  const liveKey: QuoteKey | null = ready
    ? {
        of: offerToken.faucetId,
        oa: offerRaw.toString(),
        rf: requestToken.faucetId,
        ra: requestEdited ? requestRaw.toString() : null,
        bps: slippageBps
      }
    : null;
  const key = liveKey === null ? '' : JSON.stringify(liveKey);
  const [debouncedKey] = useDebounce(key, 500);
  const [state, setState] = useState<PairedState>(IDLE);
  const reqId = useRef(0);
  // Bumped to re-run the fetch effect for the same key: the periodic refresh.
  const [refreshTick, setRefreshTick] = useState(0);
  const livePair = pairOf(offerToken.faucetId, requestToken.faucetId);

  // The live inputs, read by a fetch so the request is built from the pair its key names, and by
  // `quoteNow` so it is one stable function.
  const liveRef = useRef({ offerToken, requestToken, key: liveKey, pair: livePair });
  liveRef.current = { offerToken, requestToken, key: liveKey, pair: livePair };

  const runQuote = useCallback((quoteKey: QuoteKey, id: number, builtAsk = false): Promise<SwapQuote> => {
    const { offerToken: offer, requestToken: request } = liveRef.current;
    const pair = pairOf(quoteKey.of, quoteKey.rf);
    return quoteSwap(offer, BigInt(quoteKey.oa), request, {
      slippageBps: quoteKey.bps,
      ...(quoteKey.ra === null ? {} : { requestedAmount: BigInt(quoteKey.ra) }),
      ...(builtAsk ? { builtAsk } : {})
    }).then(
      quote => {
        if (id === reqId.current) setState({ loading: false, pair, quote, settledAt: quote.fetchedAt });
        return quote;
      },
      (error: unknown) => {
        if (id === reqId.current) setState(failed(pair, error));
        throw error;
      }
    );
  }, []);

  useEffect(() => {
    if (!debouncedKey) {
      reqId.current++; // supersede any in-flight request
      setState(IDLE);
      return;
    }
    const quoteKey: QuoteKey = JSON.parse(debouncedKey);
    const pair = pairOf(quoteKey.of, quoteKey.rf);
    const id = ++reqId.current;
    // Only a same-pair input change keeps the previous quote on screen while it reloads.
    setState(prev => ({ loading: true, pair, quote: prev.pair === pair ? prev.quote : undefined }));
    // The debounce delivers the live key 500 ms late, so a flip in this render would build the request from the
    // other pair's tokens; wait for it instead. livePair re-runs this when the flip is undone inside the window.
    if (pair !== livePair) return;
    runQuote(quoteKey, id).catch(() => undefined);
  }, [debouncedKey, livePair, refreshTick, runQuote]);

  // The periodic refresh: once a quote lands and the page is on screen, re-quote after the window.
  // A failed one is retried on the same clock, so a service that comes back finds the review
  // whole again instead of a receive field it emptied for good.
  const settledAt = state.settledAt;
  useEffect(() => {
    if (!active || settledAt === undefined || !debouncedKey) return;
    const due = Math.max(0, settledAt + SWAP_QUOTE_REFRESH_MS - Date.now());
    const timer = setTimeout(() => setRefreshTick(tick => tick + 1), due);
    return () => clearTimeout(timer);
  }, [active, settledAt, debouncedKey]);

  const quoteNow = useCallback(
    (requestedAmount?: bigint): Promise<SwapQuote> => {
      const { key: liveQuoteKey, pair } = liveRef.current;
      if (liveQuoteKey === null) return Promise.reject(new Error('Nothing to quote'));
      const quoteKey =
        requestedAmount === undefined ? liveQuoteKey : { ...liveQuoteKey, ra: requestedAmount.toString() };
      // The ask's origin is the live key's, not the amount's: a wallet-built ask checked again must
      // still fill the receive field, or a press that stops short of the queue empties it.
      const builtAsk = requestedAmount !== undefined && liveQuoteKey.ra === null;
      const id = ++reqId.current;
      setState(prev => ({ loading: true, pair, quote: prev.pair === pair ? prev.quote : undefined }));
      return runQuote(quoteKey, id, builtAsk);
    },
    [runQuote]
  );

  // Input that cannot be quoted hides the last quote at once, before the debounce catches up.
  if (liveKey === null) return { ...IDLE, quoteNow };
  // The debounce lags the pair by 500 ms plus the fetch, so compare against the live tokens.
  if (state.pair === undefined) return { ...state, quoteNow };
  if (state.pair !== livePair) return { ...PENDING, quoteNow };
  const { loading, quote, error, errorCode } = state;
  return { loading, quote, error, errorCode, quoteNow };
}
