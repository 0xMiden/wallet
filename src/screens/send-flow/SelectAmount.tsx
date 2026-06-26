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
  /** Overrides the amount label (e.g. "You Pay"). Defaults to "Select Amount". */
  label?: string;
  /** Token-logo symbol override (e.g. the DEX `logoSymbol`); defaults to `token.name`. */
  logoSymbol?: string;
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
  onAmountChange,
  onSelectToken,
  onConfirm,
  embedded = false,
  label,
  logoSymbol
}) => {
  const { t } = useTranslation();

  const availableFiat = token ? token.balance * token.fiatPrice : 0;
  const canProceed = !!token && isValidAmount;

  const tokenSelector = (
    <button
      type="button"
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

  const helper = token ? (
    <>
      <span className="font-heading text-[#808080] text-base font-bold">
        {t('available')} {formatBalance(token.balance)} {token.name}
      </span>
      <span className="font-heading text-[#808080] text-base font-bold">
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
      onValueChange={(value, _name, values) => onAmountChange(values?.formatted || value || '')}
    />
  );

  if (embedded) {
    return amountField;
  }

  return (
    <div className={clsx('flex flex-col h-full min-h-0 bg-app-bg', isMobile() ? 'px-8' : 'px-6')}>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar pt-10">
        <span className="self-start text-xs font-semibold text-pure-white bg-primary-500 px-3 py-1 rounded-full mb-3">
          {t('miden')}
        </span>
        {amountField}
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
