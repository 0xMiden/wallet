import React from 'react';

import BigNumber from 'bignumber.js';
import { useTranslation } from 'react-i18next';

import { Pill } from 'components/ui/Pill';
import { balanceLowerBound } from 'lib/i18n/numbers';

interface AmountShortcutsProps {
  balance: number | null;
  decimals: number;
  scaleIsKnown: boolean;
  onAmountChange: (amount: string) => void;
  disabled?: boolean;
  includeMax?: boolean;
  compact?: boolean;
  className?: string;
  testIdPrefix?: string;
}

const PERCENTAGES = [25, 50, 75] as const;

function trimDecimalZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

// An amount a shortcut puts into the field is the amount sent, so it keeps every
// decimal of the token. Rounded DOWN, so it never passes the spendable balance.
// A display figure (such as "Available") must never be used here: it keeps only
// about 4 decimals, and Max then leaves the rest of the balance behind (#2157).
function formatAmount(value: BigNumber, decimals: number): string {
  return trimDecimalZeros(value.toFixed(decimals, BigNumber.ROUND_DOWN));
}

export const AmountShortcuts: React.FC<AmountShortcutsProps> = ({
  balance,
  decimals,
  scaleIsKnown,
  onAmountChange,
  disabled = false,
  includeMax = true,
  compact = false,
  className,
  testIdPrefix = 'amount-shortcut'
}) => {
  const { t, i18n } = useTranslation();
  if (
    !scaleIsKnown ||
    balance === null ||
    !Number.isFinite(balance) ||
    balance <= 0 ||
    !Number.isInteger(decimals) ||
    decimals < 0
  ) {
    return null;
  }

  const available = new BigNumber(balanceLowerBound(balance, decimals));
  if (available.isNaN() || available.lte(0)) return null;

  const percentLabel = (percent: number) => {
    try {
      return new Intl.NumberFormat((i18n.resolvedLanguage ?? i18n.language).replace(/_/g, '-'), {
        style: 'percent',
        maximumFractionDigits: 0
      }).format(percent / 100);
    } catch {
      return `${percent}%`;
    }
  };

  return (
    <div className={`${compact ? '' : 'mt-3'} flex gap-2`} data-testid="amount-shortcuts">
      {PERCENTAGES.map(percent => (
        <Pill
          key={percent}
          onClick={() => onAmountChange(formatAmount(available.multipliedBy(percent).dividedBy(100), decimals))}
          disabled={disabled}
          className={`flex-1 justify-center ${className ?? ''}`}
          aria-label={percentLabel(percent)}
          data-testid={`${testIdPrefix}-${percent}`}
        >
          {percentLabel(percent)}
        </Pill>
      ))}
      {includeMax && (
        <Pill
          onClick={() => onAmountChange(formatAmount(available, decimals))}
          disabled={disabled}
          className={`flex-1 justify-center ${className ?? ''}`}
          data-testid={`${testIdPrefix}-max`}
        >
          {t('max')}
        </Pill>
      )}
    </div>
  );
};
