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
  /** Miden faucet id of the selected token (Epoch quotes any token → USDC). */
  faucetId?: string;
  /** EVM recipient (0x) — also the intent sponsor; no connected wallet needed. */
  destinationAddress?: string;
  /** Sender's Miden account (bech32). */
  senderPublicKey?: string;
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
  faucetId,
  destinationAddress,
  senderPublicKey,
  enabled
}: UseEpochQuoteOpts): EpochQuoteState {
  const ready = enabled && !!amount && amount > 0n && !!faucetId && !!destinationAddress && !!senderPublicKey;
  // Debounce the whole input set so neither amount nor recipient keystrokes spam
  // the quote endpoint.
  const key = ready
    ? JSON.stringify({ a: amount!.toString(), f: faucetId, d: destinationAddress, s: senderPublicKey })
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
    const { a, f, d, s } = JSON.parse(debouncedKey) as { a: string; f: string; d: string; s: string };
    const id = ++reqId.current;
    setState({ loading: true, symbol: BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL });
    quoteEpochSendOutput({
      amount: BigInt(a),
      faucetId: f,
      destinationAddress: d as `0x${string}`,
      senderPublicKey: s
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
