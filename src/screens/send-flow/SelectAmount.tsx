import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { AmountInput } from 'components/AmountInput';
import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

import { UIToken } from './types';

export interface SelectAmountProps {
  token?: UIToken;
  amount: string;
  isValidAmount: boolean;
  error?: string;
  /** Overrides the amount label (e.g. "Select Amount", "You Pay"). */
  label?: React.ReactNode;
  /** Overrides the Confirm button label in the page variant. */
  confirmTitle?: string;
  showNetworkPill?: boolean;
  showBalanceHelper?: boolean;
  /** Padding classes for the confirm-button footer. The `pb-24` default clears
   *  the floating BottomNav; pass a snugger value when the navbar is hidden. */
  footerClassName?: string;
  children?: React.ReactNode;
  onAmountChange: (amount: string) => void;
  onSelectToken: () => void;
  /** Required in the default (page) variant, which renders its own Confirm CTA. */
  onConfirm?: () => void;
  /**
   * `embedded` strips the full-screen chrome (network pill, balance helper,
   * scroll container, Confirm button) so the field can be stacked — the swap
   * screen renders two of these (You Pay / You Receive) under one shared
   * Confirm. Defaults to the standalone page layout used by the send flow.
   */
  embedded?: boolean;
  /** Token-logo symbol override (e.g. the DEX `logoSymbol`); defaults to `token.name`. */
  logoSymbol?: string;
  /** Show a skeleton in place of the amount while it is being computed (e.g. the swap receive quote). */
  loading?: boolean;
}

/** Trim trailing zeros so "200.000" renders as "200" but "200.5" stays intact. */
function formatBalance(value: number): string {
  return Number(value.toFixed(4)).toString();
}

export const SelectAmount: React.FC<SelectAmountProps> = ({
  token,
  amount,
  isValidAmount,
  error,
  label,
  confirmTitle,
  showNetworkPill = true,
  showBalanceHelper = true,
  footerClassName = 'pt-4 pb-24',
  children,
  onAmountChange,
  onSelectToken,
  onConfirm,
  embedded = false,
  logoSymbol,
  loading
}) => {
  const { t } = useTranslation();

  const availableFiat = token ? token.balance * token.fiatPrice : 0;
  const canProceed = !!token && isValidAmount;

  const tokenSelector = (
    <button
      type="button"
      data-testid="send-token-selector"
      onClick={() => {
        hapticLight();
        onSelectToken();
      }}
      className="flex items-center gap-1.25 cursor-pointer"
    >
      {token ? (
        <TokenLogo symbol={logoSymbol ?? token.name} size="md" />
      ) : embedded ? (
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#2F6BED] text-lg font-bold text-pure-white">
          $
        </span>
      ) : null}
      <span className="font-heading text-2xl font-bold text-heading-gray">
        {token ? token.name : t('selectAToken')}
      </span>
      <Icon name={IconName.ChevronDown} size="sm" className="text-primary-500" fill="currentColor" />
    </button>
  );

  const helper =
    token && showBalanceHelper ? (
      <>
        <span className="font-heading text-gray text-base font-bold">
          {t('available')} {formatBalance(token.balance)} {token.name}
        </span>
        <span className="font-heading text-gray text-base font-bold">
          {t('approxFiatValue', { value: `$${availableFiat.toFixed(2)}` })}
        </span>
      </>
    ) : null;

  const amountField = (
    <AmountInput
      label={label ?? t('selectAmount')}
      value={amount}
      error={error ? t(error) : undefined}
      helper={embedded ? undefined : helper}
      tokenSelector={tokenSelector}
      data-testid="send-amount-input"
      loading={loading}
      onValueChange={(value, _name, values) => onAmountChange(values?.formatted || value || '')}
    />
  );

  if (embedded) {
    return amountField;
  }

  return (
    <div className={clsx('flex flex-col h-full min-h-0 bg-app-bg', isMobile() ? 'px-8' : 'px-6')}>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar pt-10">
        {showNetworkPill && (
          <span className="self-start text-xs font-semibold text-pure-white bg-primary-500 px-3 py-1 rounded-full mb-3">
            {t('miden')}
          </span>
        )}
        {amountField}
        {children}
      </div>

      <div className={clsx('shrink-0', footerClassName)}>
        <Button
          title={confirmTitle ?? t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          // `onConfirm` is optional (the embedded variant omits it and returns
          // early above), so in this page variant a missing handler disables
          // the CTA rather than rendering a live-but-dead button.
          disabled={!canProceed || !onConfirm}
          data-testid="send-amount-confirm"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};
