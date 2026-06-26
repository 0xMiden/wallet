import React from 'react';

import clsx from 'clsx';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { SwapToken } from 'lib/miden/swap/tokens';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

import { SelectAmount } from '../send-flow/SelectAmount';
import { UIToken } from '../send-flow/types';

export interface SwapAmountsProps {
  offerToken: SwapToken;
  offerAmount: string;
  onOfferAmountChange: (amount: string) => void;
  onSelectOfferToken: () => void;
  requestToken: SwapToken;
  requestAmount: string;
  onRequestAmountChange: (amount: string) => void;
  onSelectRequestToken: () => void;
  onSwapDirection: () => void;
  onConfirm: () => void;
  canProceed: boolean;
  /** Helper line under the fields (fetching price / pick two tokens / unavailable). */
  statusMessage?: string;
  statusIsError?: boolean;
}

/** SwapToken → the UIToken shape SelectAmount expects (balance/fiat unused here). */
const swapTokenToUIToken = (token: SwapToken): UIToken => ({
  id: token.faucetId,
  name: token.symbol,
  decimals: token.decimals,
  balance: 0,
  fiatPrice: 0
});

/**
 * First swap screen: two stacked SelectAmount fields (You Pay / You Receive)
 * with a swap-direction toggle between them and a single shared Confirm CTA.
 */
export const SwapAmounts: React.FC<SwapAmountsProps> = ({
  offerToken,
  offerAmount,
  onOfferAmountChange,
  onSelectOfferToken,
  requestToken,
  requestAmount,
  onRequestAmountChange,
  onSelectRequestToken,
  onSwapDirection,
  onConfirm,
  canProceed,
  statusMessage,
  statusIsError
}) => {
  const { t } = useTranslation();

  return (
    <div className={clsx('flex h-full min-h-0 flex-col bg-app-bg', isMobile() ? 'px-8' : 'px-6')}>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto no-scrollbar pt-10">
        <SelectAmount
          embedded
          label={t('youPay')}
          token={swapTokenToUIToken(offerToken)}
          logoSymbol={offerToken.logoSymbol}
          amount={offerAmount}
          isValidAmount={Number(offerAmount) > 0}
          onAmountChange={onOfferAmountChange}
          onSelectToken={onSelectOfferToken}
        />

        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border-light" />
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
          <div className="h-px flex-1 bg-border-light" />
        </div>

        <SelectAmount
          embedded
          label={t('youReceive')}
          token={swapTokenToUIToken(requestToken)}
          logoSymbol={requestToken.logoSymbol}
          amount={requestAmount}
          isValidAmount={Number(requestAmount) > 0}
          onAmountChange={onRequestAmountChange}
          onSelectToken={onSelectRequestToken}
        />

        {statusMessage && (
          <span className={clsx('text-sm font-medium', statusIsError ? 'text-status-negative' : 'text-[#808080]')}>
            {statusMessage}
          </span>
        )}
      </div>

      <div className="shrink-0 pt-4 pb-24">
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={!canProceed}
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};
