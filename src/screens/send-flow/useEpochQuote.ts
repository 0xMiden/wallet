import { useEffect, useRef, useState } from 'react';

import { useDebounce } from 'use-debounce';

import { BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL, quoteEpochSendOutput } from 'lib/epoch';

export interface EpochQuoteState {
  loading: boolean;
  /** Estimated EVM output, human-formatted (18 decimals). */
  amount?: string;
  /** Output token symbol (USDC). */
  symbol: string;
  error?: string;
}

export interface UseEpochQuoteOpts {
  /** Miden input amount, base units. */
  amount?: bigint;
  /** EVM recipient (0x). */
  destinationAddress?: string;
  /** Sender's Miden account (bech32). */
  senderPublicKey?: string;
  /** Connected EVM wallet (intent sponsor). */
  sponsorAddress?: string;
  /** Gate: only quote when the Fast route is active + inputs are valid. */
  enabled: boolean;
}

const IDLE: EpochQuoteState = { loading: false, symbol: BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL };

/**
 * Debounced forward-quote for the Epoch (Fast) route. Once the user stops typing
 * the input amount (or changes the recipient), it forward-quotes the EVM output
 * and exposes `{ loading, amount, symbol }` for a "you receive ~N USDC" preview.
 * In-flight requests are superseded by a request id so a slow earlier quote can't
 * overwrite a newer one.
 */
export function useEpochQuote({
  amount,
  destinationAddress,
  senderPublicKey,
  sponsorAddress,
  enabled
}: UseEpochQuoteOpts): EpochQuoteState {
  const ready = enabled && !!amount && amount > 0n && !!destinationAddress && !!senderPublicKey && !!sponsorAddress;
  // Debounce the whole input set so neither amount nor recipient keystrokes spam
  // the quote endpoint.
  const key = ready
    ? JSON.stringify({ a: amount!.toString(), d: destinationAddress, s: senderPublicKey, p: sponsorAddress })
    : '';
  const [debouncedKey] = useDebounce(key, 500);
  const [state, setState] = useState<EpochQuoteState>(IDLE);
  const reqId = useRef(0);

  useEffect(() => {
    if (!debouncedKey) {
      reqId.current++; // supersede any in-flight request
      setState(IDLE);
      return;
    }
    const { a, d, s, p } = JSON.parse(debouncedKey) as { a: string; d: string; s: string; p: string };
    const id = ++reqId.current;
    setState({ loading: true, symbol: BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL });
    quoteEpochSendOutput({
      amount: BigInt(a),
      destinationAddress: d as `0x${string}`,
      senderPublicKey: s,
      sponsorAddress: p as `0x${string}`
    })
      .then(res => {
        if (id !== reqId.current) return;
        setState({ loading: false, amount: res.amount, symbol: res.symbol });
      })
      .catch((err: unknown) => {
        if (id !== reqId.current) return;
        setState({
          loading: false,
          symbol: BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL,
          error: err instanceof Error ? err.message : 'Quote failed'
        });
      });
  }, [debouncedKey]);

  return state;
}
