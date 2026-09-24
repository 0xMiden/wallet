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
}

/**
 * The vertical provider transition on the Guardian rotation review: the current provider on `fill`
 * above the one being adopted on `accent`. Activity's completed switch uses the compact, top-down
 * `GuardianChangeSummary` instead.
 */
export const GuardianTransitionHero: FC<GuardianTransitionHeroProps> = ({
  previousEndpoint,
  newEndpoint,
  previousLabel,
  newLabel,
  className = ''
}) => {
  const { t } = useTranslation();
  const unknown = t('unknown');
  const previousOption = guardianOptionForEndpoint(previousEndpoint ?? '');
  const newOption = guardianOptionForEndpoint(newEndpoint ?? '');

  return (
    <div data-testid="guardian-transition-hero" className={`w-full ${className}`}>
      <div className="flex min-h-[5.5rem] flex-col items-center justify-center rounded-3xl bg-fill px-4 py-4">
        {/* `text-ink`, matching the "New Guardian" chip below rather
              than `text-text-muted`: the two chips sit one above the other, and
              the muted token is 2.3:1 on this white pill in light mode while the
              other chip's ink is 9.2:1. */}
        <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-medium text-ink">{previousLabel}</span>
        <h2 className="mt-1.5 break-all text-center font-heading text-xl font-bold text-ink">
          {guardianEndpointDisplayName(previousEndpoint, unknown)}
        </h2>
        {previousOption && (
          <p className="mt-0.5 text-xs font-semibold text-ink">
            {t('guardianProviderRegion', { provider: previousOption.operatedBy, region: previousOption.location })}
          </p>
        )}
      </div>

      <div className="relative mt-5 flex min-h-[5.5rem] flex-col items-center justify-center rounded-3xl bg-primary-500 px-4 py-4 text-pure-white">
        <div className="absolute -top-4 flex h-9 w-9 items-center justify-center rounded-xl border-4 border-app-bg bg-primary-500">
          <Icon name={IconName.ArrowDown} fill="currentColor" size="sm" />
        </div>
        <span className="rounded-full bg-pure-white px-2.5 py-0.5 text-xs font-medium text-grey-700">{newLabel}</span>
        <h2 className="mt-1.5 break-all text-center font-heading text-xl font-bold text-pure-white">
          {guardianEndpointDisplayName(newEndpoint, unknown)}
        </h2>
        {newOption && (
          <p className="mt-0.5 text-center text-xs font-semibold text-pure-white">
            {t('guardianProviderRegion', { provider: newOption.operatedBy, region: newOption.location })}
          </p>
        )}
      </div>
    </div>
  );
};
