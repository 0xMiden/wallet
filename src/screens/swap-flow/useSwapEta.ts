import { useEffect, useRef, useState } from 'react';

import { useDebounce } from 'use-debounce';

import { stringToBigInt } from 'lib/i18n/numbers';
import { getSwapEta, SwapEta, SwapToken } from 'lib/miden/swap/tokens';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

export interface SwapEtaState {
  loading: boolean;
  /** The latest quote for the current pair/amounts, once resolved. */
  eta?: SwapEta;
  error?: string;
}

export interface UseSwapEtaOpts {
  offerToken: SwapToken;
  requestToken: SwapToken;
  /** Human display amounts, as typed. */
  offerAmount: string;
  requestAmount: string;
  /** Gate: only quote when the pair is swappable (e.g. two different tokens). */
  enabled: boolean;
}

const IDLE: SwapEtaState = { loading: false };
const PENDING: SwapEtaState = { loading: true };

/** Quotes belong to both the faucet pair and the configured service. */
type PairedState = SwapEtaState & { pair?: string };

const pairOf = (offerFaucetId: string, requestFaucetId: string, etaUrl: string | undefined) =>
  JSON.stringify([offerFaucetId, requestFaucetId, etaUrl]);

function quoteAmount(amount: string, decimals: number): bigint | undefined {
  try {
    return stringToBigInt(amount || '0', decimals);
  } catch {
    return undefined;
  }
}

/**
 * Debounced quote for the current swap pair via the DEX `swap-eta` endpoint.
 * Modeled on {@link useEpochQuote}: once the user stops typing, it fetches the
 * oracle rate + live fill signals for `(offer, request)` and exposes them as a
 * single {@link SwapEta}. In-flight requests are superseded by a request id so a
 * slow earlier quote can't overwrite a newer one.
 *
 * `requestAmount` may be empty before the field is seeded. The endpoint rejects
 * `requested_amount=0`, so we bootstrap with the offered amount as a positive
 * placeholder — the oracle `marketPrice` is amount-independent, so it comes back
 * correct and the caller can use it to seed the receive field; the next call
 * then carries the real receive amount for the fill signals.
 *
 * A quote or error is returned only for the pair it was fetched for. A flip or a
 * token change reads as `{ loading: true }` until the new pair's own answer lands,
 * so the old pair's rate can never price (or its error block) the new order.
 */
export function useSwapEta({
  offerToken,
  requestToken,
  offerAmount,
  requestAmount,
  enabled
}: UseSwapEtaOpts): SwapEtaState {
  const etaUrl = useBridgeConfigSnapshot({ load: false }).config?.swap?.etaUrl;
  const parsedOffer = quoteAmount(offerAmount, offerToken.decimals);
  const parsedRequest = quoteAmount(requestAmount, requestToken.decimals);
  const offerRaw = parsedOffer ?? 0n;
  const requestRaw = parsedRequest ?? 0n;
  // The endpoint requires requested_amount > 0; before the field is seeded fall
  // back to the offered amount (marketPrice is amount-independent).
  const requestRawForApi = requestRaw > 0n ? requestRaw : offerRaw;
  const ready =
    enabled &&
    parsedOffer !== undefined &&
    parsedRequest !== undefined &&
    offerRaw > 0n &&
    offerToken.faucetId !== requestToken.faucetId;

  // Debounce the whole input set so keystrokes on either amount don't spam the
  // quote endpoint.
  const key = ready
    ? JSON.stringify({
        of: offerToken.faucetId,
        oa: offerRaw.toString(),
        rf: requestToken.faucetId,
        ra: requestRawForApi.toString(),
        etaUrl
      })
    : '';
  const [debouncedKey] = useDebounce(key, 500);
  const [state, setState] = useState<PairedState>(IDLE);
  const reqId = useRef(0);
  const livePair = pairOf(offerToken.faucetId, requestToken.faucetId, etaUrl);

  useEffect(() => {
    if (!ready || !debouncedKey) {
      reqId.current++; // supersede any in-flight request
      setState(IDLE);
      return;
    }
    const {
      of,
      oa,
      rf,
      ra,
      etaUrl: quoteUrl
    }: { of: string; oa: string; rf: string; ra: string; etaUrl?: string } = JSON.parse(debouncedKey);
    const pair = pairOf(of, rf, quoteUrl);
    const id = ++reqId.current;
    // Only a same-pair amount change keeps the previous quote on screen while it reloads.
    setState(prev => ({ loading: true, pair, eta: prev.pair === pair ? prev.eta : undefined }));
    // The debounce delivers the live key 500 ms late, so a flip in this render would build the request from the
    // other pair's tokens; wait for it instead. A readiness change must also wait for the current amount key.
    if (pair !== livePair || debouncedKey !== key) return;
    getSwapEta(offerToken, BigInt(oa), requestToken, BigInt(ra))
      .then(eta => {
        if (id !== reqId.current) return;
        setState({ loading: false, pair, eta });
      })
      .catch((err: unknown) => {
        if (id !== reqId.current) return;
        setState({ loading: false, pair, error: err instanceof Error ? err.message : 'Quote failed' });
      });
    // Debounce owns amount changes; livePair and ready invalidate stale tokens or input before it expires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedKey, livePair, ready]);

  // Invalid entry hides the last valid quote before the debounce catches up.
  if (!ready) return IDLE;

  // The debounce lags the pair by 500 ms plus the fetch, so compare against the live tokens.
  if (state.pair === undefined) return state;
  if (state.pair !== livePair) return PENDING;
  const { loading, eta, error } = state;
  return { loading, eta, error };
}
