import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { FactRow, IconCircle } from 'components/ui/FactRow';
import { ListGroup } from 'components/ui/ListGroup';

export interface NetworkNoticeRow {
  /** Stable id, for test hooks: `no-value`, `no-real-funds`, `reset`. */
  id: string;
  titleKey: string;
  bodyKey: string;
  icon: IconName;
  /** The glyph's card-palette colour, as the Settings group icons take theirs. */
  tone: string;
}

/** The three facts, drawn by `NetworkNoticeRows` for the onboarding notice and the network sheet alike. */
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
 * Plain `FactRow`s on the page, each led by the Settings group's `IconCircle` with its glyph in a
 * card-palette colour.
 * Onboarding shows them above its one "I understand" button.
 */
export const NetworkNoticeRows: FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation();

  return (
    <ListGroup as="ul" surface="plain" insetHairlines className={className}>
      {NETWORK_NOTICE_ROWS.map(row => (
        <FactRow
          key={row.titleKey}
          as="li"
          data-testid={`network-notice-row-${row.id}`}
          leading={
            <IconCircle className={row.tone}>
              <Icon name={row.icon} fill="currentColor" />
            </IconCircle>
          }
          title={t(row.titleKey)}
          description={t(row.bodyKey)}
        />
      ))}
    </ListGroup>
  );
};
