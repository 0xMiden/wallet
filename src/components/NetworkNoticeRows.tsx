import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { cn } from 'lib/ui/util';

export interface NetworkNoticeRow {
  /** Stable id, for test hooks: `no-value`, `no-real-funds`, `reset`. */
  id: string;
  titleKey: string;
  bodyKey: string;
  icon: IconName;
  /** The glyph's card-palette colour, as the Settings group icons take theirs. */
  tone: string;
}

/** The three facts, shared with onboarding's notice, which asks the user to tick each one. */
export const NETWORK_NOTICE_ROWS: readonly NetworkNoticeRow[] = [
  {
    id: 'no-value',
    titleKey: 'networkNoticeNoValueTitle',
    bodyKey: 'networkNoticeNoValueBody',
    icon: IconName.Coins,
    tone: 'text-card-green'
  },
  {
    id: 'no-real-funds',
    titleKey: 'networkNoticeNoRealFundsTitle',
    bodyKey: 'networkNoticeNoRealFundsBody',
    icon: IconName.Warning,
    tone: 'text-card-purple'
  },
  {
    id: 'reset',
    titleKey: 'networkNoticeResetTitle',
    bodyKey: 'networkNoticeResetBody',
    icon: IconName.Refresh,
    tone: 'text-card-blue'
  }
];

/**
 * The three test-network facts (#875): no value, no real funds, resets.
 * Shared by the onboarding notice and the banner's explanation sheet so both
 * say the same thing.
 *
 * Plain rows on the page, hairlines between them starting after the icon. Each fact leads with the
 * Settings group icon: a 32px `fill` circle with a 16px glyph in a card-palette colour. The rows are
 * hand-built because `ListRow` truncates its subtitle to one line.
 * Onboarding draws the same three facts as `CheckboxRow`s in a `ListGroup`, so the sheet and the
 * checklist read as one list with and without the ticks.
 */
export const NetworkNoticeRows: FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation();

  return (
    <ul className={cn('flex flex-col', className)}>
      {NETWORK_NOTICE_ROWS.map(row => (
        <li
          key={row.titleKey}
          data-testid={`network-notice-row-${row.id}`}
          className={cn(
            'relative flex min-w-0 items-start gap-3 py-3.5',
            // The hairline starts after the icon: 32px + the 12px gap.
            'before:absolute before:top-0 before:right-0 before:left-11 before:h-px before:bg-hairline first:before:hidden'
          )}
        >
          <span
            aria-hidden="true"
            data-slot="icon"
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fill [&>svg]:h-4 [&>svg]:w-4',
              row.tone
            )}
          >
            <Icon name={row.icon} fill="currentColor" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-row-title text-ink">{t(row.titleKey)}</span>
            <span className="text-caption-heading text-muted">{t(row.bodyKey)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
};
