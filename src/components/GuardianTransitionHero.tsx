import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { guardianEndpointDisplayName } from 'app/hooks/useCurrentGuardianEndpoint';
import { Icon, IconName } from 'app/icons/v2';

interface GuardianTransitionHeroProps {
  previousEndpoint?: string;
  newEndpoint?: string;
  previousLabel: string;
  newLabel: string;
  className?: string;
}

/** Shared vertical provider transition used by Guardian review and history. */
export const GuardianTransitionHero: FC<GuardianTransitionHeroProps> = ({
  previousEndpoint,
  newEndpoint,
  previousLabel,
  newLabel,
  className = ''
}) => {
  const { t } = useTranslation();
  const unknown = t('unknown');

  return (
    <div
      data-testid="guardian-transition-hero"
      className={`w-full rounded-2xl bg-surface-interactive px-4 py-8 flex flex-col items-center ${className}`}
    >
      <span className="px-3 py-1 rounded-lg bg-white text-sm font-medium text-text-tertiary-token">
        {previousLabel}
      </span>
      <h2 className="mt-3 text-3xl font-semibold font-heading text-heading-gray text-center break-all">
        {guardianEndpointDisplayName(previousEndpoint, unknown)}
      </h2>
      <div className="my-5 w-10 h-10 rounded-lg bg-primary-500 flex items-center justify-center">
        <Icon name={IconName.ArrowDown} fill="white" size="sm" />
      </div>
      <span className="px-3 py-1 rounded-lg bg-white text-sm font-medium text-text-tertiary-token">{newLabel}</span>
      <h2 className="mt-3 text-3xl font-semibold font-heading text-heading-gray text-center break-all">
        {guardianEndpointDisplayName(newEndpoint, unknown)}
      </h2>
    </div>
  );
};
