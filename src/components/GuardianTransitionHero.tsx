import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { guardianEndpointDisplayName, guardianOptionForEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import { Icon, IconName } from 'app/icons/v2';

interface GuardianTransitionHeroProps {
  previousEndpoint?: string;
  newEndpoint?: string;
  previousLabel: string;
  newLabel: string;
  className?: string;
  variant?: 'default' | 'review';
}

/** Shared vertical provider transition used by Guardian review and history. */
export const GuardianTransitionHero: FC<GuardianTransitionHeroProps> = ({
  previousEndpoint,
  newEndpoint,
  previousLabel,
  newLabel,
  className = '',
  variant = 'default'
}) => {
  const { t } = useTranslation();
  const unknown = t('unknown');
  const previousOption = guardianOptionForEndpoint(previousEndpoint ?? '');
  const newOption = guardianOptionForEndpoint(newEndpoint ?? '');

  if (variant === 'review') {
    return (
      <div data-testid="guardian-transition-hero" className={`w-full ${className}`}>
        <div className="flex min-h-36 flex-col items-center justify-center rounded-3xl border border-border-card bg-white px-4 py-6">
          <span className="rounded-lg bg-surface-interactive px-3 py-1 text-xs font-semibold uppercase tracking-wide text-heading-gray">
            {previousLabel}
          </span>
          <h2 className="mt-3 break-all text-center font-heading text-2xl font-bold text-heading-gray">
            {guardianEndpointDisplayName(previousEndpoint, unknown)}
          </h2>
          {previousOption && <p className="mt-1 text-sm text-text-muted">{previousOption.location}</p>}
        </div>

        <div className="relative mt-6 flex min-h-36 flex-col items-center justify-center rounded-3xl bg-primary-500 px-4 py-6 text-pure-white">
          <div className="absolute -top-5 flex h-11 w-11 items-center justify-center rounded-xl border-4 border-app-bg bg-primary-500">
            <Icon name={IconName.ArrowDown} fill="currentColor" size="sm" />
          </div>
          <span className="rounded-lg bg-primary-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-primary-500">
            {newLabel}
          </span>
          <h2 className="mt-3 break-all text-center font-heading text-2xl font-bold text-pure-white">
            {guardianEndpointDisplayName(newEndpoint, unknown)}
          </h2>
          {newOption && (
            <p className="mt-1 text-center text-sm font-semibold text-pure-white">
              {t('guardianProviderRegion', { provider: newOption.operatedBy, region: newOption.location })}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="guardian-transition-hero"
      className={`w-full rounded-2xl bg-surface-interactive px-4 py-8 flex flex-col items-center ${className}`}
    >
      <span className="px-3 py-1 rounded-lg bg-white text-sm font-medium text-heading-gray">{previousLabel}</span>
      <h2 className="mt-3 text-3xl font-semibold font-heading text-heading-gray text-center break-all">
        {guardianEndpointDisplayName(previousEndpoint, unknown)}
      </h2>
      <div className="my-5 w-10 h-10 rounded-lg bg-primary-500 flex items-center justify-center">
        <Icon name={IconName.ArrowDown} fill="white" size="sm" />
      </div>
      <span className="px-3 py-1 rounded-lg bg-white text-sm font-medium text-heading-gray">{newLabel}</span>
      <h2 className="mt-3 text-3xl font-semibold font-heading text-heading-gray text-center break-all">
        {guardianEndpointDisplayName(newEndpoint, unknown)}
      </h2>
    </div>
  );
};
