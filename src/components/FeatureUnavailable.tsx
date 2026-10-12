import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Notice, type NoticeVariant } from 'components/ui/Notice';
import type { FeatureAvailability } from 'lib/remote-config/availability';

export interface FeatureUnavailableNoticeProps {
  availability: FeatureAvailability;
  /** `inline` under a tile or a route card; `block` (default) on a page. */
  variant?: NoticeVariant;
  /** Layout only (margins, width). */
  className?: string;
}

/**
 * The one copy every greyed-out bridge and Earn control shows. The cause never reaches users (the runtime logs it),
 * and nothing renders while the feature is available or still loading.
 */
export function FeatureUnavailableNotice({
  availability,
  variant,
  className
}: FeatureUnavailableNoticeProps): JSX.Element | null {
  const { t } = useTranslation();
  if (availability.state !== 'unavailable') return null;
  return (
    <Notice
      tone="warning"
      variant={variant}
      icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
      title={t('bridgeFeatureUnavailableTitle')}
      className={className}
      data-testid="feature-unavailable-notice"
    >
      {t('bridgeFeatureUnavailableBody')}
    </Notice>
  );
}

/** True while a control must not start its feature: unavailable, or not known yet. */
export function isFeatureBlocked(availability: FeatureAvailability): boolean {
  return availability.state !== 'available';
}
