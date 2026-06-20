import React, { FC, useCallback, useMemo, useState } from 'react';

import { Button } from 'components/Button';
import { stringToBigInt } from 'lib/i18n/numbers';
import {
  initiateSwapTransaction,
  requestSWTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';

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

const TOKEN_MTA: SwapToken = {
  symbol: 'MTA',
  faucetId: 'mdev1ap0eexjfl05j2yt83pmu88cfl5g8ehmm_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS
};
const TOKEN_MTB: SwapToken = {
  symbol: 'MTB',
  faucetId: 'mdev1arft5lvn248mz5t43j6v7uplsgy2tdmu_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS
};

const SWAP_TOKENS: SwapToken[] = [TOKEN_MTA, TOKEN_MTB];

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offerToken = useMemo(() => SWAP_TOKENS.find(token => token.symbol === offerSymbol) ?? TOKEN_MTA, [offerSymbol]);
  const requestToken = useMemo(
    () => SWAP_TOKENS.find(token => token.symbol === requestSymbol) ?? TOKEN_MTB,
    [requestSymbol]
  );

  const sameToken = offerToken.faucetId === requestToken.faucetId;
  const canSwap = !submitting && !sameToken && Number(offerAmount) > 0 && Number(requestAmount) > 0;

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
                onChange={event => setOfferAmount(event.target.value)}
                className={inputClassName}
              />
              <select
                aria-label="Token to pay"
                value={offerSymbol}
                onChange={event => setOfferSymbol(event.target.value)}
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
                onChange={event => setRequestAmount(event.target.value)}
                className={inputClassName}
              />
              <select
                aria-label="Token to receive"
                value={requestSymbol}
                onChange={event => setRequestSymbol(event.target.value)}
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
