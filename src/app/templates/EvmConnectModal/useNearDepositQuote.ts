import { useEffect, useMemo, useState } from 'react';

import { amountExceedsTokenDecimals, stringToBigInt } from 'lib/i18n/numbers';
import { requestOneClickQuote } from 'lib/one-click/client';
import type { NearIntentsConfig, OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';
import type { ResolvedNearIntentsSelection } from 'screens/near-intents-flow/chains';
import { previewRefundAddress } from 'screens/near-intents-flow/preview-refund';
import { type NearIntentsQuoteQuery, useNearIntentsQuote } from 'screens/near-intents-flow/useNearIntentsQuote';

import { NEAR_PREVIEW_DEADLINE_REFRESH_MS, NEAR_SLIPPAGE_BPS, nearQuoteDeadline } from './near-deposit';

/** The typed amount in base units of `decimals`, or undefined for an empty, zero or too precise amount. */
export function nearAmountUnits(amount: string, decimals: number): bigint | undefined {
  if (amount.trim() === '' || amountExceedsTokenDecimals(amount, decimals)) return undefined;
  try {
    const units = stringToBigInt(amount, decimals);
    return units > 0n ? units : undefined;
  } catch {
    return undefined;
  }
}

/** The dry quote query of `config`. With no config (NEAR Intents is off) every query fails. */
export function nearDryQuoteQuery(config: NearIntentsConfig | null): NearIntentsQuoteQuery {
  return (request, signal) =>
    config === null
      ? Promise.reject(new Error('NEAR Intents is off'))
      : requestOneClickQuote(config, request, true, undefined, signal);
}

export interface NearDepositQuoteInput {
  config: NearIntentsConfig | null;
  /** The origin chain, token and Miden output. Undefined: nothing to quote. */
  route: ResolvedNearIntentsSelection | undefined;
  /** The typed amount, decimal text in units of the origin token. */
  amount: string;
  /** A usable refund address, or undefined: the dry quote then takes the preview placeholder of the chain kind. */
  refundTo: string | undefined;
  /** The Miden account that receives the deposit. */
  recipient: string | undefined;
  /** False pauses the poll (a page off screen, a submit on its way, another step). */
  active: boolean;
}

export interface NearDepositQuote {
  /** The dry quote request for the current inputs, or undefined when they are not complete. */
  request?: OneClickQuoteRequest;
  /** The latest dry quote of `request`. */
  quote?: OneClickQuoteResponse;
  loading: boolean;
  error?: Error;
  /** The typed amount in base units of the origin token. */
  amountUnits?: bigint;
}

/**
 * A dry 1Click quote for a NEAR Intents deposit, polled while `active` (`useNearIntentsQuote`). The deadline of the
 * request stays the same between renders, and moves forward before the 5 minutes run out.
 */
export function useNearDepositQuote({
  config,
  route,
  amount,
  refundTo,
  recipient,
  active
}: NearDepositQuoteInput): NearDepositQuote {
  const [deadline, setDeadline] = useState(nearQuoteDeadline);
  useEffect(() => {
    if (!active) return undefined;
    setDeadline(nearQuoteDeadline());
    const interval = window.setInterval(() => setDeadline(nearQuoteDeadline()), NEAR_PREVIEW_DEADLINE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [active]);

  const decimals = route?.token.asset.decimals;
  const amountUnits = useMemo(
    () => (decimals === undefined ? undefined : nearAmountUnits(amount, decimals)),
    [amount, decimals]
  );

  const request = useMemo<OneClickQuoteRequest | undefined>(() => {
    if (config === null || route === undefined || amountUnits === undefined || !recipient) return undefined;
    return {
      amount: amountUnits.toString(),
      originAsset: route.token.asset,
      destinationAsset: route.output,
      // The quote shows from the amount alone. Until the refund address is usable, the dry quote uses a placeholder.
      refundTo: refundTo ?? previewRefundAddress(route.chain.addressKind),
      recipient,
      deadline,
      slippageTolerance: NEAR_SLIPPAGE_BPS
    };
  }, [config, route, amountUnits, refundTo, recipient, deadline]);

  const query = useMemo(() => nearDryQuoteQuery(config), [config]);
  const preview = useNearIntentsQuote(request, query, active);
  return {
    request,
    quote: request === undefined ? undefined : preview.quote,
    loading: request !== undefined && preview.loading,
    error: request === undefined ? undefined : preview.error,
    amountUnits
  };
}
