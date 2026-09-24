import React, { useState } from 'react';

import clsx from 'clsx';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { stepFooterCushionClass } from 'components/flow/footer-cushion';
import { WaveDots } from 'components/ui';
import { resolveTransition, tabBarMotion, useTabBarMotion } from 'lib/animation';
import { SwapToken } from 'lib/miden/swap/tokens';
import { hapticLight } from 'lib/mobile/haptics';
import { useNavbarHidden } from 'lib/mobile/useNavbarHidden';

import { SelectAmount } from '../send-flow/SelectAmount';
import { UIToken } from '../send-flow/types';

export interface SwapAmountsProps {
  /** True when the account holds none of the native asset the fee is paid in. */
  feeAssetMissing?: boolean;
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
  fiatPrice: 0,
  // A registry token carries its own decimals — that is the point of the
  // registry, and why swap sides never fall back to the placeholder.
  scaleIsKnown: true
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
  statusIsError,
  feeAssetMissing = false
}) => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const motionTokens = useTabBarMotion();
  // Each press turns the arrow another half turn and lifts the two sides past each other, so the
  // switch reads as the two fields trading places. Same springs as the tab bars, so a press here
  // feels like a press there.
  const [flips, setFlips] = useState(0);
  const flipTransition = resolveTransition(reduceMotion, tabBarMotion.highlight);
  const sideMotion = (from: number) => ({
    key: flips,
    initial: flips === 0 ? false : { y: from, opacity: 0 },
    animate: { y: 0, opacity: 1 },
    transition: flipTransition
  });
  // Each side is titled like a tab root's page title, the same weight as Send's "Send to".
  const fieldLabel = (text: string) => <span className="text-title-tab text-ink">{text}</span>;
  // The CTA carries the state of the quote: ask for an amount, wait for the number, then review.
  const navbarHidden = useNavbarHidden();
  const offerAmountValue = Number(offerAmount);
  const awaitingAmount = !(offerAmountValue > 0);
  const offerAmountExceedsBalance = offerAmountValue > offerBalance;
  // Missing the fee asset outranks an over-balance amount: no amount at all is
  // sendable, so telling the user to lower it would send them in a loop.
  const offerAmountError = feeAssetMissing
    ? 'insufficientFeeAsset'
    : offerAmountExceedsBalance
      ? 'amountMustBeLessThanBalance'
      : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg px-6">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto no-scrollbar pt-6">
        <motion.div {...sideMotion(-24)} data-testid="swap-pay-side">
          <SelectAmount
            embedded
            label={fieldLabel(t('youPay'))}
            accent="swap"
            token={swapTokenToUIToken(offerToken, offerBalance)}
            logoSymbol={offerToken.logoSymbol}
            amount={offerAmount}
            isValidAmount={offerAmountValue > 0 && !offerAmountExceedsBalance}
            error={offerAmountError}
            onAmountChange={onOfferAmountChange}
            onSelectToken={onSelectOfferToken}
          />
        </motion.div>

        <div className="flex items-center gap-3">
          <div className="h-0.75 flex-1 bg-[#ECEBE8]" />
          <motion.button
            type="button"
            onClick={() => {
              hapticLight();
              setFlips(count => count + 1);
              onSwapDirection();
            }}
            {...motionTokens.press}
            animate={{ rotate: reduceMotion ? 0 : flips * 180 }}
            transition={flipTransition}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-swap text-accent-swap-on"
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

        <motion.div {...sideMotion(24)} data-testid="swap-receive-side">
          <SelectAmount
            embedded
            // "You Receive" is the swap output — the user's balance of that token
            // isn't the spendable amount here, so no available-balance helper.
            showBalanceHelper={false}
            label={fieldLabel(t('youReceive'))}
            accent="swap"
            token={swapTokenToUIToken(requestToken)}
            logoSymbol={requestToken.logoSymbol}
            amount={requestAmount}
            isValidAmount={Number(requestAmount) > 0}
            loading={requestLoading}
            onAmountChange={onRequestAmountChange}
            onSelectToken={onSelectRequestToken}
          />
        </motion.div>

        {statusMessage && (
          <span
            className={clsx('text-body-sm', statusIsError ? 'text-negative-tint-ink' : 'text-muted')}
            data-testid="swap-status-message"
          >
            {statusMessage}
          </span>
        )}
      </div>

      {/* Same cushion as a send step's CTA, so both flows' buttons sit on one line. */}
      <div className={clsx('shrink-0 pt-3', navbarHidden ? 'pb-4' : stepFooterCushionClass())}>
        <Button
          title={awaitingAmount ? t('enterAmount') : t('reviewSwap')}
          variant={ButtonVariant.Primary}
          // The whole flow is the swap colour, CTA included (design-system.md, "Action colours").
          accent="swap"
          onClick={onConfirm}
          disabled={!canProceed}
          data-testid="swap-review-submit"
          className="w-full max-w-none"
        >
          {requestLoading ? <WaveDots label={t('calculatingQuote')} /> : undefined}
        </Button>
      </div>
    </div>
  );
};
