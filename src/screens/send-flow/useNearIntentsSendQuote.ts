import { useEffect, useMemo, useRef, useState } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { useAccount } from 'lib/miden/front';
import { OneClickHttpError } from 'lib/one-click/client';
import { useNearIntentsConfig } from 'lib/one-click/config';
import {
  findNearIntentsSendPairs,
  requestNearIntentsSendPreview,
  type NearIntentsSendPair,
  type NearIntentsSendQuoteInput
} from 'lib/one-click/send';
import type { OneClickQuoteResponse } from 'lib/one-click/types';
import { useNearIntentsCatalog } from 'screens/near-intents-flow/useNearIntentsCatalog';
import { PREVIEW_DEBOUNCE_MS, PREVIEW_REFRESH_MS } from 'screens/near-intents-flow/useNearIntentsQuote';

export type NearIntentsSendQuoteStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
export type NearIntentsSendQuoteErrorCode = 'no_liquidity' | 'invalid_recipient';

export interface NearIntentsSendQuoteParams {
  /** The 1Click blockchain name of the destination chain ('eth', 'sol', 'btc', 'near'). */
  chainId?: string;
  /** The Miden faucet of the token to send. */
  faucetId?: string;
  /** The amount to send, in base units of the Miden token. */
  amount?: bigint;
  /** The destination address, in the form that 1Click gets. */
  recipient?: string;
  enabled: boolean;
}

export interface NearIntentsSendQuote {
  /**
   * - `idle`: the hook is off, or the pair is known but the amount or the recipient is not.
   * - `loading`: the catalog or the first quote for the current input is on its way.
   * - `ready`: `quote` is the dry quote for the current input.
   * - `unsupported`: NEAR Intents is off, or it has no pair for this token on this chain.
   * - `error`: 1Click refused the last request; `errorCode` names a known reason.
   */
  status: NearIntentsSendQuoteStatus;
  pair?: NearIntentsSendPair;
  quote?: OneClickQuoteResponse;
  errorCode?: NearIntentsSendQuoteErrorCode;
}

interface PreviewState {
  key: string;
  quote?: OneClickQuoteResponse;
  failed: boolean;
  errorCode?: NearIntentsSendQuoteErrorCode;
}

/** The known reason of a refused 1Click request, or undefined. */
export function nearIntentsErrorCode(error: Error): NearIntentsSendQuoteErrorCode | undefined {
  if (!(error instanceof OneClickHttpError)) return undefined;
  switch (error.code) {
    case 'no_liquidity':
      return 'no_liquidity';
    case 'invalid_recipient':
      return 'invalid_recipient';
    default:
      return undefined;
  }
}

/**
 * A dry NEAR Intents quote for a send from Miden. The hook finds the first pair of the token and the chain in the
 * confirmed catalog. It waits `PREVIEW_DEBOUNCE_MS` after a change of the input, then asks again every
 * `PREVIEW_REFRESH_MS` while the page is active. It ignores an answer for an input that is not the current one.
 * The refund address is the Miden address of the current account.
 */
export function useNearIntentsSendQuote({
  chainId,
  faucetId,
  amount,
  recipient,
  enabled
}: NearIntentsSendQuoteParams): NearIntentsSendQuote {
  const config = useNearIntentsConfig();
  const catalog = useNearIntentsCatalog(enabled ? config : null);
  const { publicKey } = useAccount();
  const pageActive = usePageActive();

  const pair = useMemo(() => {
    if (catalog.status !== 'ready' || !chainId || !faucetId) return undefined;
    return findNearIntentsSendPairs(catalog.catalog, faucetId, chainId)[0];
  }, [catalog, chainId, faucetId]);

  const input = useMemo<NearIntentsSendQuoteInput | undefined>(() => {
    if (!pair || amount === undefined || amount <= 0n || !recipient || !publicKey) return undefined;
    return { pair, amount, recipient, refundTo: publicKey };
  }, [pair, amount, recipient, publicKey]);
  const key =
    input === undefined
      ? ''
      : JSON.stringify([
          input.pair.origin.assetId,
          input.pair.destination.assetId,
          input.amount.toString(),
          input.recipient,
          input.refundTo
        ]);
  const inputRef = useRef(input);
  inputRef.current = input;

  const [preview, setPreview] = useState<PreviewState>({ key: '', failed: false });
  const sequence = useRef(0);
  const active = enabled && pageActive;

  useEffect(() => {
    sequence.current += 1;
    const current = inputRef.current;
    // A new input clears the quote; a refresh of the same input keeps it until the answer comes.
    setPreview(previous => (previous.key === key ? previous : { key, failed: false }));
    if (current === undefined || config === null || !active) {
      return () => {
        sequence.current += 1;
      };
    }

    let stopped = false;
    const refresh = () => {
      const own = ++sequence.current;
      requestNearIntentsSendPreview(config, current).then(
        ({ quote }) => {
          if (!stopped && sequence.current === own) setPreview({ key, quote, failed: false });
        },
        error => {
          if (stopped || sequence.current !== own) return;
          console.warn('[NearIntentsSend] the quote request failed', error);
          setPreview({
            key,
            failed: true,
            errorCode: error instanceof Error ? nearIntentsErrorCode(error) : undefined
          });
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
  }, [key, config, active]);

  if (!enabled) return { status: 'idle' };
  if (config === null) return { status: 'unsupported' };
  switch (catalog.status) {
    case 'loading':
      return { status: 'loading' };
    case 'unavailable':
      return { status: 'unsupported' };
    case 'ready':
      break;
  }
  if (!faucetId) return { status: 'idle' };
  if (!pair) return { status: 'unsupported' };
  if (input === undefined) return { status: 'idle', pair };
  if (preview.key !== key) return { status: 'loading', pair };
  if (preview.failed) return { status: 'error', pair, errorCode: preview.errorCode };
  if (preview.quote) return { status: 'ready', pair, quote: preview.quote };
  return { status: 'loading', pair };
}
