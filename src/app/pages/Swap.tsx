import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from 'components/Button';
import { stringToBigInt, toFixedRoundedDown } from 'lib/i18n/numbers';
import {
  initiateSwapTransaction,
  requestSWTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

/**
 * Swap currently supports only this fixed set of devnet test tokens.
 * Every token uses 8 decimals (see `SWAP_TOKEN_DECIMALS`).
 */
interface SwapToken {
  symbol: string;
  faucetId: string;
  decimals: number;
}

// Every swap token uses 8 decimals: the user enters a human-readable amount
// and `stringToBigInt(amount, 8)` converts it to base units for the tx.
const SWAP_TOKEN_DECIMALS = 8;

const TOKEN_IMIDEN: SwapToken = {
  symbol: 'IMIDEN',
  faucetId: 'mdev1aq484758cd3r5yt3x25megj0ag46wp8a_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS
};
const TOKEN_IETH: SwapToken = {
  symbol: 'IETH',
  faucetId: 'mdev1aqaww0tlzehhyvfjuwkthf67w5djl28w_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS
};
const TOKEN_IBTC: SwapToken = {
  symbol: 'IBTC',
  faucetId: 'mdev1azehytvhqdsknyg0crh2en8znvp3zmga_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS
};
const TOKEN_IUSDT: SwapToken = {
  symbol: 'IUSDT',
  faucetId: 'mdev1az0scmkp838d9vg8dg5ep20u9y2s8ymm_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS
};

interface PriceResponse {
  /** USD price for 1 whole token (i.e. 1 * 10^decimals base units). */
  price: number;
}

/** Fetch the USD price of 1 whole `token` from the in-protocol DEX price feed. */
async function getPrice(token: SwapToken): Promise<number> {
  const faucetHexId = accountIdStringToSdk(token.faucetId).toString();
  const res = await fetch(`https://35-175-40-181.sslip.io/v1/price/${faucetHexId}`);
  if (!res.ok) {
    throw new Error(`Price request failed for ${token.symbol}: ${res.status}`);
  }
  const json: PriceResponse = await res.json();
  return json.price;
}

/**
 * Fraction shaved off the fair USD-derived quote so a filler/solver that
 * consumes the PSWAP note has margin to do so profitably. The user receives
 * `1 - SOLVER_MARGIN` of the price-fair amount.
 */
const SOLVER_MARGIN = 0.05;

/**
 * Derive the requested-token amount from the offered amount via each token's
 * USD price. Both prices are per 1 whole token, so the decimals cancel and we
 * can work directly in display units: the fair quote is
 * `offered * offerP / requestP`, then discounted by `SOLVER_MARGIN`.
 * Rounded down to the requested token's precision; returns '' when the inputs
 * aren't usable yet (no amount, prices not loaded, or a non-positive result).
 */
function deriveRequestAmount(
  offerAmount: string,
  offerPrice: number | undefined,
  requestPrice: number | undefined,
  decimals: number
): string {
  const offered = Number(offerAmount);
  if (!offered || !offerPrice || !requestPrice) {
    return '';
  }
  const quote = ((offered * offerPrice) / requestPrice) * (1 - SOLVER_MARGIN);
  if (!Number.isFinite(quote) || quote <= 0) {
    return '';
  }
  const formatted = toFixedRoundedDown(quote, decimals).replace(/\.?0+$/, '');
  return formatted === '0' ? '' : formatted;
}

const SWAP_TOKENS: SwapToken[] = [TOKEN_IMIDEN, TOKEN_IETH, TOKEN_IUSDT, TOKEN_IBTC];

const PRICE_SWR_CONFIG = { refreshInterval: 60_000, dedupingInterval: 30_000 };

const selectClassName =
  'rounded-xl border border-rule-default bg-app-bg px-3 py-3 text-base font-semibold text-text-primary-token outline-none';

const inputClassName =
  'min-w-0 flex-1 rounded-xl border border-rule-default bg-app-bg px-3 py-3 text-base font-medium text-text-primary-token outline-none placeholder:text-text-tertiary-token';

const Swap: FC = () => {
  const { publicKey } = useAccount();

  const [offerSymbol, setOfferSymbol] = useState(TOKEN_IMIDEN.symbol);
  const [offerAmount, setOfferAmount] = useState('');
  const [requestSymbol, setRequestSymbol] = useState(TOKEN_IETH.symbol);
  const [requestAmount, setRequestAmount] = useState('');
  // True once the user manually edits the receive amount, which pauses the
  // auto-quote until they change the pay amount or a token again.
  const [requestEdited, setRequestEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offerToken = useMemo(
    () => SWAP_TOKENS.find(token => token.symbol === offerSymbol) ?? TOKEN_IMIDEN,
    [offerSymbol]
  );
  const requestToken = useMemo(
    () => SWAP_TOKENS.find(token => token.symbol === requestSymbol) ?? TOKEN_IETH,
    [requestSymbol]
  );

  // USD price per 1 whole token, keyed by faucet id and deduped across the two
  // selectors (so picking the same token on both sides reuses one fetch).
  const {
    data: offerPrice,
    isLoading: offerPriceLoading,
    error: offerPriceError
  } = useRetryableSWR<number, Error>(
    ['swap-token-price', offerToken.faucetId],
    () => getPrice(offerToken),
    PRICE_SWR_CONFIG
  );
  const {
    data: requestPrice,
    isLoading: requestPriceLoading,
    error: requestPriceError
  } = useRetryableSWR<number, Error>(
    ['swap-token-price', requestToken.faucetId],
    () => getPrice(requestToken),
    PRICE_SWR_CONFIG
  );

  // The price-fair quote for the receive amount. The field is auto-filled from
  // this but stays editable, so `quote` and `requestAmount` can diverge once
  // the user overrides it.
  const quote = useMemo(
    () => deriveRequestAmount(offerAmount, offerPrice, requestPrice, requestToken.decimals),
    [offerAmount, offerPrice, requestPrice, requestToken.decimals]
  );

  // Mirror the quote into the editable receive field unless the user has taken
  // it over. `requestEdited` is cleared whenever they change the pay amount or
  // a token, so the quote resumes driving the field.
  useEffect(() => {
    if (!requestEdited) {
      setRequestAmount(quote);
    }
  }, [quote, requestEdited]);

  const sameToken = offerToken.faucetId === requestToken.faucetId;
  const hasOfferAmount = Number(offerAmount) > 0;
  const pricesLoading = offerPriceLoading || requestPriceLoading;
  const priceUnavailable = Boolean(offerPriceError || requestPriceError);
  const canSwap = !submitting && !sameToken && hasOfferAmount && Number(requestAmount) > 0;

  const onSwap = useCallback(async () => {
    if (!publicKey || !canSwap) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const txId = await initiateSwapTransaction(
        publicKey,
        offerToken.faucetId,
        stringToBigInt(offerAmount, offerToken.decimals),
        requestToken.faucetId,
        stringToBigInt(requestAmount, requestToken.decimals),
        isDelegateProofEnabled()
      );

      useWalletStore.getState().openTransactionModal();
      if (isExtension()) {
        requestSWTransactionProcessing();
      }

      const result = await waitForTransactionCompletion(txId);
      if ('errorMessage' in result) {
        setError(result.errorMessage);
      } else {
        useWalletStore.getState().setLastCompletedTxHash(result.txHash);
        setOfferAmount('');
        setRequestAmount('');
        setRequestEdited(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [publicKey, canSwap, offerToken, requestToken, offerAmount, requestAmount]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-4 px-4 pt-3 pb-32">
          <div className="flex items-center justify-between pt-2">
            <span className="text-2xl font-bold text-text-primary-token">Swap</span>
          </div>

          <div className="flex flex-col gap-2 rounded-2xl border border-rule-default bg-white p-4">
            <span className="text-sm font-semibold text-text-secondary-token">You pay</span>
            <div className="flex items-center gap-3">
              <input
                aria-label="Amount to pay"
                inputMode="decimal"
                placeholder="0.00"
                value={offerAmount}
                onChange={event => {
                  setOfferAmount(event.target.value);
                  setRequestEdited(false);
                }}
                className={inputClassName}
              />
              <select
                aria-label="Token to pay"
                value={offerSymbol}
                onChange={event => {
                  setOfferSymbol(event.target.value);
                  setRequestEdited(false);
                }}
                className={selectClassName}
              >
                {SWAP_TOKENS.map(token => (
                  <option key={token.faucetId} value={token.symbol}>
                    {token.symbol}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-2xl border border-rule-default bg-white p-4">
            <span className="text-sm font-semibold text-text-secondary-token">You receive</span>
            <div className="flex items-center gap-3">
              <input
                aria-label="Amount to receive"
                inputMode="decimal"
                placeholder="0.00"
                value={requestAmount}
                onChange={event => {
                  setRequestAmount(event.target.value);
                  setRequestEdited(true);
                }}
                className={inputClassName}
              />
              <select
                aria-label="Token to receive"
                value={requestSymbol}
                onChange={event => {
                  setRequestSymbol(event.target.value);
                  setRequestEdited(false);
                }}
                className={selectClassName}
              >
                {SWAP_TOKENS.map(token => (
                  <option key={token.faucetId} value={token.symbol}>
                    {token.symbol}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {sameToken && <span className="text-xs font-medium text-red-500">Pick two different tokens to swap.</span>}
          {!sameToken && hasOfferAmount && priceUnavailable && (
            <span className="text-xs font-medium text-red-500">Price unavailable. Try again shortly.</span>
          )}
          {!sameToken && hasOfferAmount && !requestEdited && !priceUnavailable && pricesLoading && !requestAmount && (
            <span className="text-xs font-medium text-text-tertiary-token">Fetching price…</span>
          )}
          {error && <span className="select-text text-xs font-medium text-red-500">{error}</span>}

          <Button
            title={submitting ? 'Swapping…' : 'Swap'}
            isLoading={submitting}
            disabled={!canSwap}
            onClick={onSwap}
            className="max-w-none"
          />
        </div>
      </div>
    </div>
  );
};

export default Swap;
