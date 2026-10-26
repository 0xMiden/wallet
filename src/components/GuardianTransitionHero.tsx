import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { guardianEndpointDisplayName, guardianOptionForEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import { Icon, IconName } from 'app/icons/v2';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { cn } from 'lib/ui/util';

interface GuardianTransitionHeroProps {
  previousEndpoint?: string;
  newEndpoint?: string;
  previousLabel: string;
  newLabel: string;
  className?: string;
}

interface SideProps {
  endpoint?: string;
  label: string;
  selected?: boolean;
}

/** One provider as Guardian settings draws it: the 88px round brand tile, its name, then its region. */
const Side: FC<SideProps> = ({ endpoint, label, selected }) => {
  const { t } = useTranslation();
  const option = guardianOptionForEndpoint(endpoint ?? '');

  return (
    <div data-testid="guardian-transition-side" className="flex min-w-0 flex-1 flex-col items-center text-center">
      <GuardianLogoTile guardianId={option?.id} size="hero" selected={selected} className="mb-2.5" />
      {/* The ring and the arrow carry which side is which; a screen reader hears the label instead. */}
      <span className="sr-only">{label}: </span>
      <p className="break-words text-row-title text-ink">{guardianEndpointDisplayName(endpoint, t('unknown'))}</p>
      {option && <p className="text-caption-heading text-muted">{option.location}</p>}
    </div>
  );
};

/**
 * The provider switch on the Guardian rotation review, read left to right: the provider being left, an
 * arrow, the provider taking over, ringed in `accent` as it was on the picker the user chose it on.
 * Activity's completed switch uses the compact `GuardianChangeSummary` instead.
 */
export const GuardianTransitionHero: FC<GuardianTransitionHeroProps> = ({
  previousEndpoint,
  newEndpoint,
  previousLabel,
  newLabel,
  className
}) => (
  <div data-testid="guardian-transition-hero" className={cn('flex w-full items-start gap-2', className)}>
    <Side endpoint={previousEndpoint} label={previousLabel} />
    {/* Centred on the 88px tiles: (88 - 32) / 2. */}
    <span
      aria-hidden="true"
      className="mt-7 flex size-8 shrink-0 items-center justify-center rounded-full bg-fill text-muted"
    >
      <Icon name={IconName.ArrowRight} size="xs" fill="currentColor" />
    </span>
    <Side endpoint={newEndpoint} label={newLabel} selected />
  </div>
);
