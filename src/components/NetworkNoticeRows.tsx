import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { cn } from 'lib/ui/util';

export interface NetworkNoticeRow {
  /** Stable id, for test hooks: `no-value`, `no-real-funds`, `reset`. */
  id: string;
  titleKey: string;
  bodyKey: string;
}

/** The three facts, shared with onboarding's notice, which asks the user to tick each one. */
export const NETWORK_NOTICE_ROWS: readonly NetworkNoticeRow[] = [
  { id: 'no-value', titleKey: 'networkNoticeNoValueTitle', bodyKey: 'networkNoticeNoValueBody' },
  { id: 'no-real-funds', titleKey: 'networkNoticeNoRealFundsTitle', bodyKey: 'networkNoticeNoRealFundsBody' },
  { id: 'reset', titleKey: 'networkNoticeResetTitle', bodyKey: 'networkNoticeResetBody' }
];

/**
 * The three test-network facts (#875): no value, no real funds, resets.
 * Shared by the onboarding notice and the banner's explanation sheet so both
 * say the same thing.
 */
export const NetworkNoticeRows: FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation();

  return (
    <ul className={cn('flex flex-col divide-y divide-rule-default', className)}>
      {NETWORK_NOTICE_ROWS.map(row => (
        <li key={row.titleKey} className="py-4">
          <span className="flex flex-col gap-1 min-w-0">
            <span className="text-lg font-semibold leading-5 text-text-primary-token">{t(row.titleKey)}</span>
            <span className="text-sm leading-5 text-text-secondary-token">{t(row.bodyKey)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
};
