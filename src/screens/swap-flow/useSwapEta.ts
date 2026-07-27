import { useEffect, useRef, useState } from 'react';

import { useDebounce } from 'use-debounce';

import { stringToBigInt } from 'lib/i18n/numbers';
import { getSwapEta, SwapEta, SwapToken } from 'lib/miden/swap/tokens';

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

/**
 * Debounced quote for the current swap pair via the DEX `swap-eta` endpoint.
 * Once the user stops typing, it fetches the oracle rate + live fill signals for
 * `(offer, request)` and exposes them as a single {@link SwapEta}. In-flight
 * requests are superseded by a request id so a slow earlier quote can't
 * overwrite a newer one.
 *
 * `requestAmount` may be empty before the field is seeded. The endpoint rejects
 * `requested_amount=0`, so we bootstrap with the offered amount as a positive
 * placeholder — the oracle `marketPrice` is amount-independent, so it comes back
 * correct and the caller can use it to seed the receive field; the next call
 * then carries the real receive amount for the fill signals.
 */
export function useSwapEta({
  offerToken,
  requestToken,
  offerAmount,
  requestAmount,
  enabled
}: UseSwapEtaOpts): SwapEtaState {
  const offerRaw = stringToBigInt(offerAmount || '0', offerToken.decimals);
  const requestRaw = stringToBigInt(requestAmount || '0', requestToken.decimals);
  // The endpoint requires requested_amount > 0; before the field is seeded fall
  // back to the offered amount (marketPrice is amount-independent).
  const requestRawForApi = requestRaw > 0n ? requestRaw : offerRaw;
  const ready = enabled && offerRaw > 0n && offerToken.faucetId !== requestToken.faucetId;

  // Debounce the whole input set so keystrokes on either amount don't spam the
  // quote endpoint.
  const key = ready
    ? JSON.stringify({
        of: offerToken.faucetId,
        oa: offerRaw.toString(),
        rf: requestToken.faucetId,
        ra: requestRawForApi.toString()
      })
    : '';
  const [debouncedKey] = useDebounce(key, 500);
  const [state, setState] = useState<SwapEtaState>(IDLE);
  const reqId = useRef(0);

  useEffect(() => {
    if (!debouncedKey) {
      reqId.current++; // supersede any in-flight request
      setState(IDLE);
      return;
    }
    const { oa, ra }: { of: string; oa: string; rf: string; ra: string } = JSON.parse(debouncedKey);
    const id = ++reqId.current;
    setState(prev => ({ loading: true, eta: prev.eta }));
    getSwapEta(offerToken, BigInt(oa), requestToken, BigInt(ra))
      .then(eta => {
        if (id !== reqId.current) return;
        setState({ loading: false, eta });
      })
      .catch((err: unknown) => {
        if (id !== reqId.current) return;
        setState({ loading: false, error: err instanceof Error ? err.message : 'Quote failed' });
      });
    // offerToken/requestToken are captured in `debouncedKey`; re-run only on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedKey]);

  return state;
}
