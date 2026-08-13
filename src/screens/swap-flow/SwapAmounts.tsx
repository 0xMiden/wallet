import React from 'react';

import clsx from 'clsx';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { SwapToken } from 'lib/miden/swap/tokens';
import { hapticLight } from 'lib/mobile/haptics';

import { SelectAmount } from '../send-flow/SelectAmount';
import { UIToken } from '../send-flow/types';

export interface SwapAmountsProps {
  offerToken: SwapToken;
  offerBalance: number;
  offerAmount: string;
  onOfferAmountChange: (amount: string) => void;
  onSelectOfferToken: () => void;
  requestToken: SwapToken;
  requestAmount: string;
  onRequestAmountChange: (amount: string) => void;
  onSelectRequestToken: () => void;
  /** Show a skeleton on the receive field while its quote is being computed. */
  requestLoading?: boolean;
  onSwapDirection: () => void;
  onConfirm: () => void;
  canProceed: boolean;
  /** Helper line under the fields (fetching price / pick two tokens / unavailable). */
  statusMessage?: string;
  statusIsError?: boolean;
}

/** SwapToken → the UIToken shape SelectAmount expects. `balance` feeds the
 * "Available X" helper on the You Pay field (#461); fiat is unused (0). */
const swapTokenToUIToken = (token: SwapToken, balance = 0): UIToken => ({
  id: token.faucetId,
  name: token.symbol,
  decimals: token.decimals,
  balance,
  fiatPrice: 0
});

/**
 * First swap screen: two stacked SelectAmount fields (You Pay / You Receive)
 * with a swap-direction toggle between them and a single shared Confirm CTA.
 */
export const SwapAmounts: React.FC<SwapAmountsProps> = ({
  offerToken,
  offerBalance,
  offerAmount,
  onOfferAmountChange,
  onSelectOfferToken,
  requestToken,
  requestAmount,
  onRequestAmountChange,
  onSelectRequestToken,
  requestLoading,
  onSwapDirection,
  onConfirm,
  canProceed,
  statusMessage,
  statusIsError
}) => {
  const { t } = useTranslation();
  const offerAmountValue = Number(offerAmount);
  const offerAmountExceedsBalance = offerAmountValue > offerBalance;
  const offerAmountError = offerAmountExceedsBalance ? 'amountMustBeLessThanBalance' : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg px-6">
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto no-scrollbar pt-10">
        <SelectAmount
          embedded
          label={t('youPay')}
          token={swapTokenToUIToken(offerToken, offerBalance)}
          logoSymbol={offerToken.logoSymbol}
          amount={offerAmount}
          isValidAmount={offerAmountValue > 0 && !offerAmountExceedsBalance}
          error={offerAmountError}
          onAmountChange={onOfferAmountChange}
          onSelectToken={onSelectOfferToken}
        />

        <div className="flex items-center gap-3">
          <div className="h-0.75 flex-1 bg-[#ECEBE8]" />
          <motion.button
            type="button"
            onClick={() => {
              hapticLight();
              onSwapDirection();
            }}
            whileTap={{ scale: 0.9 }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-500 text-pure-white"
            aria-label={t('swapDirection')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M8 3v10M8 13l-4-4M8 13l4-4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.button>
          <div className="h-0.75 flex-1 bg-[#ECEBE8]" />
        </div>

        <SelectAmount
          embedded
          // "You Receive" is the swap output — the user's balance of that token
          // isn't the spendable amount here, so no available-balance helper.
          showBalanceHelper={false}
          label={t('youReceive')}
          token={swapTokenToUIToken(requestToken)}
          logoSymbol={requestToken.logoSymbol}
          amount={requestAmount}
          isValidAmount={Number(requestAmount) > 0}
          loading={requestLoading}
          onAmountChange={onRequestAmountChange}
          onSelectToken={onSelectRequestToken}
        />

        {statusMessage && (
          <span className={clsx('text-sm font-medium', statusIsError ? 'text-status-negative' : 'text-[#808080]')}>
            {statusMessage}
          </span>
        )}
      </div>

      <div className="shrink-0 pt-4 pb-24" data-navbar-cushion="true">
        <Button
          title={t('reviewSwap')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={!canProceed}
          data-testid="swap-review-submit"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};
