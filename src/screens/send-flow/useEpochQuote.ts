import { useEffect, useRef, useState } from 'react';

import { useDebounce } from 'use-debounce';

import { quoteEpochSendOutput } from 'lib/epoch';
import { normalizeMidenIdToHex } from 'lib/epoch/bridge';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectEpochOutputToken, selectEvmChainId } from 'lib/remote-config/values';

export interface EpochQuoteState {
  loading: boolean;
  /** Estimated EVM output as an exact human decimal; the Review rounds it down for display. */
  amount?: string;
  /** Output token symbol: the quote's, else the configured output token's, else ''. */
  symbol: string;
  /** The output token's contract and decimals, while the document names one for the sent faucet. */
  address?: `0x${string}`;
  decimals?: number;
  error?: string;
}

export interface UseEpochQuoteOpts {
  /** Miden input amount, base units. */
  amount?: bigint;
  /** Miden faucet id of the selected token; it arrives as the Epoch route's token that settles into this faucet. */
  faucetId?: string;
  /** EVM recipient (0x) — also the intent sponsor; no connected wallet needed. */
  destinationAddress?: string;
  /** Sender's Miden account (bech32). */
  senderPublicKey?: string;
  /** Gate: only quote when the Fast route is active + inputs are valid. */
  enabled: boolean;
  destinationChainId?: number;
}

type QuoteRequestState = Omit<EpochQuoteState, 'symbol'> & { symbol?: string };

const IDLE: QuoteRequestState = { loading: false };

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
  enabled,
  destinationChainId
}: UseEpochQuoteOpts): EpochQuoteState {
  const snapshot = useBridgeConfigSnapshot();
  const outputChainId = destinationChainId ?? selectEvmChainId(snapshot);
  const outputToken =
    outputChainId === null || !faucetId
      ? null
      : selectEpochOutputToken(snapshot, outputChainId, normalizeMidenIdToHex(faucetId));
  const outputSymbol = outputToken?.symbol ?? '';
  // The quote goes through the configured allocator for the output token the document and its read make usable, so
  // they key it too: a read that recovers or moves under the same document quotes anew. A move is no keystroke: it
  // supersedes the quote at once, not after the debounce.
  const configKey = JSON.stringify([
    snapshot.config?.['bridge-providers'].epoch.allocatorUrl ?? '',
    outputToken ? [outputToken.address, outputToken.chainId, outputToken.symbol, outputToken.decimals] : null
  ]);
  const ready = enabled && !!amount && amount > 0n && !!faucetId && !!destinationAddress && !!senderPublicKey;
  // Debounce the whole input set so neither amount nor recipient keystrokes spam
  // the quote endpoint.
  const key = ready
    ? JSON.stringify({ a: amount!.toString(), f: faucetId, d: destinationAddress, s: senderPublicKey })
    : '';
  const [debouncedKey] = useDebounce(key, 500);
  const [state, setState] = useState<QuoteRequestState>(IDLE);
  const reqId = useRef(0);

  useEffect(() => {
    if (!debouncedKey) {
      reqId.current++; // supersede any in-flight request
      setState(IDLE);
      return;
    }
    const { a, f, d, s } = JSON.parse(debouncedKey) as { a: string; f: string; d: string; s: string };
    const id = ++reqId.current;
    setState({ loading: true });
    quoteEpochSendOutput({
      amount: BigInt(a),
      faucetId: f,
      destinationAddress: d as `0x${string}`,
      senderPublicKey: s,
      destinationChainId
    })
      .then(res => {
        if (id !== reqId.current) return;
        setState({ loading: false, amount: res.amount, symbol: res.symbol });
      })
      .catch((err: unknown) => {
        if (id !== reqId.current) return;
        setState({ loading: false, error: err instanceof Error ? err.message : 'Quote failed' });
      });
  }, [debouncedKey, configKey, destinationChainId]);

  return {
    ...state,
    symbol: state.symbol ?? outputSymbol,
    ...(outputToken ? { address: outputToken.address, decimals: outputToken.decimals } : {})
  };
}
