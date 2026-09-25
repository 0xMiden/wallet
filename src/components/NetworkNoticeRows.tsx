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
 *
 * One `fill` group with hairlines inset between the rows, like every other list in the wallet.
 * Onboarding draws the same three facts as `CheckboxRow`s in a `ListGroup`, so the sheet and the
 * checklist read as one list with and without the ticks.
 */
export const NetworkNoticeRows: FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation();

  return (
    <ul className={cn('flex flex-col overflow-hidden rounded-2xl bg-fill', className)}>
      {NETWORK_NOTICE_ROWS.map(row => (
        <li
          key={row.titleKey}
          className={cn(
            'relative flex min-w-0 flex-col justify-center gap-0.5 px-4 py-3.5',
            'before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-hairline first:before:hidden'
          )}
        >
          <span className="text-row-title text-ink">{t(row.titleKey)}</span>
          <span className="text-caption text-muted">{t(row.bodyKey)}</span>
        </li>
      ))}
    </ul>
  );
};
