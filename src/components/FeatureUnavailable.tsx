import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Notice, type NoticeVariant } from 'components/ui/Notice';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import type { FeatureUnavailableFeature } from 'lib/telemetry/ui-producer-diagnostics';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';

export interface FeatureUnavailableNoticeProps {
  availability: FeatureAvailability;
  feature?: FeatureUnavailableFeature;
  /** `inline` under a tile or a route card; `block` (default) on a page. */
  variant?: NoticeVariant;
  /** Layout only (margins, width). */
  className?: string;
  /** Lets the control it qualifies point at the notice with `aria-describedby`. */
  id?: string;
  'data-testid'?: string;
}

/**
 * The one copy every greyed-out bridge and Earn control shows. The cause never reaches users (the runtime logs it),
 * and nothing renders while the feature is available or still loading.
 */
export function FeatureUnavailableNotice({
  availability,
  feature = 'unknown',
  variant,
  className,
  id,
  'data-testid': dataTestId = 'feature-unavailable-notice'
}: FeatureUnavailableNoticeProps): JSX.Element | null {
  const { t } = useTranslation();
  useUserVisibleError(
    availability.state === 'unavailable' && availability.reason !== 'restricted' && availability.reason !== 'pending'
      ? 'bridgeFeatureUnavailableBody'
      : null,
    'notice',
    undefined,
    {
      kind: 'feature_unavailable',
      featureUnavailableFeature: feature,
      featureUnavailableReason:
        availability.state === 'unavailable' &&
        ['off', 'not-configured', 'not-deployed', 'service-down'].includes(availability.reason)
          ? (availability.reason as 'off' | 'not-configured' | 'not-deployed' | 'service-down')
          : 'unknown'
    }
  );
  if (availability.state !== 'unavailable') return null;
  const restricted = availability.reason === 'restricted';
  return (
    <Notice
      tone="warning"
      variant={variant}
      icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
      title={t(restricted ? 'geoRestrictedTitle' : 'bridgeFeatureUnavailableTitle')}
      className={className}
      id={id}
      data-testid={dataTestId}
      data-reason={availability.reason}
    >
      {t(restricted ? 'geoRestrictedBody' : 'bridgeFeatureUnavailableBody')}
    </Notice>
  );
}

/** True while a control must not start its feature: unavailable, or not known yet. */
export function isFeatureBlocked(availability: FeatureAvailability): boolean {
  return availability.state !== 'available';
}
