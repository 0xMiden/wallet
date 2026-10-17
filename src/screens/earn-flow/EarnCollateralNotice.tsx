import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Notice } from 'components/ui/Notice';

/** Why an Earn deposit's CTA waits on its collateral: still being read, not to be had, or not the one reviewed. */
export type EarnCollateralReason = 'loading' | 'unavailable' | 'mismatch';

/** The reason an Earn deposit step greys out its CTA over its collateral; nothing without one. */
export function EarnCollateralNotice({
  reason,
  className
}: {
  reason: EarnCollateralReason | null;
  className?: string;
}): JSX.Element | null {
  const { t } = useTranslation();
  if (!reason) return null;
  return (
    <Notice
      tone="warning"
      icon={
        <Icon name={reason === 'loading' ? IconName.Information : IconName.WarningFill} size="xs" fill="currentColor" />
      }
      className={className}
      data-testid="earn-collateral-notice"
    >
      {reason === 'loading'
        ? t('earnCollateralLoading')
        : reason === 'unavailable'
          ? t('earnCollateralUnavailable')
          : t('earnCollateralMismatch')}
    </Notice>
  );
}
