import React, { FC, useState } from 'react';

import { Trans, useTranslation } from 'react-i18next';

import {
  guardianEndpointHost,
  guardianOptionForEndpoint,
  useCurrentGuardianEndpoint
} from 'app/hooks/useCurrentGuardianEndpoint';
import { useGuardianPresentation } from 'app/hooks/useGuardianPresentation';
import { Button } from 'components/Button';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { StatusBadge } from 'components/ui/StatusBadge';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';
import { GuardianInfoDrawer } from 'screens/onboarding/common/GuardianInfoDrawer';

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
  // The ONE derivation of the guardian's status - the pill and the "Last sync"
  // reading come from `deriveGuardianPresentation` (see that module for the
  // precedence rules and their history: drift outranks liveness, `resolving`
  // reads Checking not Online, a stamp has a freshness lifetime). This screen
  // only maps the result onto copy and badge tone, so it cannot disagree with
  // the send guard or any other surface.
  const { pill: guardianStatus, lastSync: lastSyncState } = useGuardianPresentation();
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const option = guardianOptionForEndpoint(currentEndpoint);
  const guardianName = option?.name ?? (currentEndpoint ? t('customGuardian') : t('loading'));
  const provider = option?.operatedBy ?? (currentEndpoint ? t('customGuardian') : t('loading'));
  const region = option?.location ?? t('unknown');
  const endpoint = guardianEndpointHost(currentEndpoint) || t('loading');
  // The module decides WHAT the row says; this screen only formats it.
  const lastSync =
    lastSyncState.kind === 'timestamp'
      ? formatLastSync(lastSyncState.at, i18n?.resolvedLanguage ?? i18n?.language ?? 'en')
      : lastSyncState.kind === 'checking'
        ? t('guardianCheckingLabel')
        : lastSyncState.kind === 'never'
          ? t('never')
          : t('unknown');

  // No haptic here: this is handed to `Button`, whose onClick wrapper already
  // fires a hapticLight on every click, so the tap buzzed twice. Same double-fire
  // that was removed from Settings' recovery-phrase and seed-warning handlers.
  const handleRotate = () => {
    navigate('/rotate-guardian');
  };

  // `live`: this pill CHANGES under a user who is already on the page (the
  // outage arms from the 3s sync tick, and "checking" resolves to "online" the
  // moment the first sync lands), and a bare element announces nothing when it
  // does. Polite, not assertive — it must not interrupt whatever is being read.
  //
  // Offline, unrepairable and drifted share the negative tone: unreachable,
  // answering-but-unusable, and pointing at an operator that is no longer the
  // guardian differ in cause, not in whether the account can rely on its guardian.
  // Drift shares the unrepairable copy: both are "the operator is answering and
  // this account still cannot rely on it, and you need to act". The causes
  // differ, but no copy in the design distinguishes them, and inventing a string
  // here would cost a 14-locale re-translation cycle (see the ledger's F-136).
  const statusPill = currentEndpoint && (
    <StatusBadge
      size="md"
      live
      className="mt-1.5"
      status={
        guardianStatus === 'offline'
          ? 'offline'
          : guardianStatus === 'unrepairable' || guardianStatus === 'drifted'
            ? 'needsAttention'
            : guardianStatus === 'online'
              ? 'online'
              : guardianStatus === 'checking'
                ? 'checking'
                : 'notConnected'
      }
      data-testid="guardian-status-pill"
    />
  );

  return (
    <SubPageLayout
      data-testid="guardian-settings"
      // Always offered: a rotation is cold-signed, and an account with no local
      // cold key (seed removed, hot-key-only import) gets a seed phrase prompt
      // for the one transaction instead of losing the action.
      footer={
        <Button
          className="flex-1 max-w-none"
          data-testid="rotateGuardian"
          title={t('rotateGuardian')}
          onClick={handleRotate}
        />
      }
    >
      {/* The provider's logo on the same brand tile the guardian picker's cards draw, at hero size,
          then its name once and the status pill. */}
      <div className="flex flex-col items-center pt-1">
        <Hero visual={<GuardianLogoTile guardianId={option?.id} size="hero" />} name={guardianName} />
        {statusPill}
      </div>

      {/* `h3`, subordinate to the guardian name's h2 above: these are sections
          within the page, not siblings of its subject. */}
      <SubPageSection
        title={t('about')}
        titleAs="h3"
        description={
          <Trans i18nKey="guardianInfoDescription" components={{ b: <span className="text-body-strong text-ink" /> }} />
        }
      >
        {/* accent-tint-ink, not accent: accent is 3.0:1 on the page, short of AA for 14px text. */}
        <button
          type="button"
          onClick={() => {
            hapticLight();
            setIsInfoOpen(true);
          }}
          className="self-start px-1 text-action text-accent-tint-ink"
        >
          {t('learnMoreAboutGuardian')}
        </button>
      </SubPageSection>

      <SubPageSection title={t('details')} titleAs="h3">
        <DetailCard>
          <DetailRow label={t('guardianProvider')}>{provider}</DetailRow>
          <DetailRow label={t('guardianEndpointLabel')} stacked>
            {endpoint}
          </DetailRow>
          <DetailRow label={t('guardianRegion')}>{region}</DetailRow>
          <DetailRow label={t('guardianLastSync')}>{lastSync}</DetailRow>
        </DetailCard>
      </SubPageSection>

      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </SubPageLayout>
  );
};

export default GuardianSettings;
