import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { guardianEndpointDisplayName, guardianOptionForEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import { Icon, IconName } from 'app/icons/v2';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { cn } from 'lib/ui/util';

export type GuardianChangeSummaryProps = {
  className?: string;
  'data-testid'?: string;
} & (
  | {
      /** A provider switch: both sides are drawn, old → new. Either endpoint may be absent on a legacy row. */
      kind: 'switch';
      previousEndpoint?: string;
      newEndpoint?: string;
      endpoint?: never;
    }
  | {
      /** A device-key rotation: the provider does not change, so it is drawn once. */
      kind: 'single';
      endpoint?: string;
      previousEndpoint?: never;
      newEndpoint?: never;
    }
);

interface GuardianSideProps {
  label: string;
  endpoint?: string;
}

/** One provider: its brand tile, the From/To (or Guardian) label, then its name. */
const GuardianSide: FC<GuardianSideProps> = ({ label, endpoint }) => {
  const { t } = useTranslation();
  const option = endpoint ? guardianOptionForEndpoint(endpoint) : undefined;

  return (
    <div data-testid="guardian-change-side" className="flex w-full flex-col items-center gap-2 text-center">
      <GuardianLogoTile guardianId={option?.id} />
      <div className="min-w-0">
        <p className="text-caption text-muted">{label}</p>
        <p className="break-words text-row-title text-ink">{guardianEndpointDisplayName(endpoint, t('unknown'))}</p>
      </div>
    </div>
  );
};

/**
 * A guardian change, read top down: the provider being left, an arrow, the provider taking over —
 * each on the same 48px brand tile the guardian picker and Guardian settings draw, so a provider
 * looks the same everywhere. `single` is the device-key rotation, which changes no provider: the
 * guardian is drawn once and the key itself belongs in the detail card below.
 */
export const GuardianChangeSummary: FC<GuardianChangeSummaryProps> = props => {
  const { t } = useTranslation();
  const { className, 'data-testid': dataTestId = 'guardian-change-summary' } = props;

  return (
    <div
      data-testid={dataTestId}
      data-kind={props.kind}
      // 16px radius on `fill`, the detail-card surface: this is a contained element, not a page hero.
      className={cn('flex w-full flex-col items-center gap-3 rounded-2xl bg-fill px-4 py-4', className)}
    >
      {props.kind === 'single' ? (
        <GuardianSide label={t('guardianBadge')} endpoint={props.endpoint} />
      ) : (
        <>
          <GuardianSide label={t('from')} endpoint={props.previousEndpoint} />
          {/* Decorative: the From/To labels already say which way this reads. */}
          <Icon
            name={IconName.ArrowDown}
            size="sm"
            fill="currentColor"
            aria-hidden="true"
            data-testid="guardian-change-arrow"
            className="shrink-0 text-muted"
          />
          <GuardianSide label={t('to')} endpoint={props.newEndpoint} />
        </>
      )}
    </div>
  );
};

export default GuardianChangeSummary;
