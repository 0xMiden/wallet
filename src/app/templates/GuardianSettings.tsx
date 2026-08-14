import React, { FC, useState } from 'react';

import clsx from 'clsx';
import { Trans, useTranslation } from 'react-i18next';

import {
  guardianEndpointHost,
  guardianOptionForEndpoint,
  useCurrentGuardianEndpoint
} from 'app/hooks/useCurrentGuardianEndpoint';
import { GUARDIAN_LOGOS, guardianLogoColorClass } from 'app/icons/guardian-operator-logs';
import { ReactComponent as GuardianAvatar } from 'app/icons/onboarding/guardian-avatar.svg';
import { Button } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { GuardianInfoDrawer } from 'screens/onboarding/common/GuardianInfoDrawer';

const GuardianDetailRow: FC<{ label: string; value: string; isLast?: boolean }> = ({ label, value, isLast }) => (
  <div
    className={`flex min-h-12 items-center justify-between gap-4 px-4 py-3 text-heading-gray text-sm font-medium ${isLast ? '' : 'border-b border-border-light'}`}
  >
    <span className="shrink-0">{label}</span>
    <span className="min-w-0 truncate text-right" title={value}>
      {value}
    </span>
  </div>
);

function formatLastSync(timestamp: number, locale: string): string {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });

  if (elapsedSeconds < 60) return formatter.format(-elapsedSeconds, 'second');
  if (elapsedSeconds < 3600) return formatter.format(-Math.round(elapsedSeconds / 60), 'minute');
  if (elapsedSeconds < 86_400) return formatter.format(-Math.round(elapsedSeconds / 3600), 'hour');
  return formatter.format(-Math.round(elapsedSeconds / 86_400), 'day');
}

const GuardianSettings: FC = () => {
  const { t, i18n } = useTranslation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();
  const lastSyncedAt = useWalletStore(s => s.lastSyncedAt);
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const option = guardianOptionForEndpoint(currentEndpoint);
  const logoEntry = option ? GUARDIAN_LOGOS[option.id] : undefined;
  const guardianName = option?.name ?? (currentEndpoint ? t('customGuardian') : t('loading'));
  const provider = option?.operatedBy ?? (currentEndpoint ? t('customGuardian') : t('loading'));
  const region = option?.location ?? t('unknown');
  const endpoint = guardianEndpointHost(currentEndpoint) || t('loading');
  const lastSync = lastSyncedAt
    ? formatLastSync(lastSyncedAt, i18n?.resolvedLanguage ?? i18n?.language ?? 'en')
    : t('never');

  const handleRotate = () => {
    hapticLight();
    navigate('/rotate-guardian');
  };

  return (
    <div className="flex min-h-full w-full flex-col">
      <div className="flex flex-col items-center pt-1">
        <div className="flex h-16 min-w-16 max-w-full items-center justify-center overflow-hidden rounded-xl bg-surface-interactive px-3">
          {logoEntry ? (
            <logoEntry.Logo
              data-testid="guardian-operator-logo"
              className={clsx('h-12 w-auto max-w-48', guardianLogoColorClass(logoEntry))}
            />
          ) : (
            <GuardianAvatar data-testid="guardian-avatar" className="h-14 w-14" />
          )}
        </div>
        <h2 className="mt-3 break-all text-center font-heading text-xl font-bold text-heading-gray">{guardianName}</h2>
        {currentEndpoint && (
          <div className="mt-2 flex items-center gap-2 rounded-full bg-green-50 px-4 py-1.5 text-xs font-semibold text-green-700 dark:bg-green-500/15 dark:text-green-400">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            <span>{t('online')}</span>
          </div>
        )}
      </div>

      <section className="mt-6">
        <h3 className="text-sm font-semibold text-gray font-heading">{t('about')}</h3>
        <p className="mt-2 text-base leading-none text-black">
          <Trans i18nKey="guardianInfoDescription" components={{ b: <span className="font-semibold" /> }} />
        </p>
        <button
          type="button"
          onClick={() => {
            hapticLight();
            setIsInfoOpen(true);
          }}
          className="mt-2 text-sm font-bold text-primary-500 underline underline-offset-4 decoration-2"
        >
          {t('learnMoreAboutGuardian')}
        </button>
      </section>

      <hr className="my-4 border-border-card" />

      <section>
        <h3 className="mb-2 text-sm font-semibold text-text-muted">{t('details')}</h3>
        <div className="overflow-hidden rounded-xl border border-border-card bg-white">
          <GuardianDetailRow label={t('guardianProvider')} value={provider} />
          <GuardianDetailRow label={t('guardianEndpointLabel')} value={endpoint} />
          <GuardianDetailRow label={t('guardianRegion')} value={region} />
          <GuardianDetailRow label={t('guardianLastSync')} value={lastSync} isLast />
        </div>
      </section>

      <Button
        className="mt-8 max-w-none shrink-0"
        data-testid="rotateGuardian"
        title={t('rotateGuardian')}
        onClick={handleRotate}
      />

      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </div>
  );
};

export default GuardianSettings;
