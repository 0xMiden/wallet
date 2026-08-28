import React, { FC, useState } from 'react';

import clsx from 'clsx';
import { Trans, useTranslation } from 'react-i18next';

import {
  guardianEndpointHost,
  guardianOptionForEndpoint,
  useCurrentGuardianEndpoint
} from 'app/hooks/useCurrentGuardianEndpoint';
import { useGuardianPresentation } from 'app/hooks/useGuardianPresentation';
import { GUARDIAN_LOGOS, guardianLogoColorClass } from 'app/icons/guardian-operator-logs';
import { ReactComponent as GuardianAvatar } from 'app/icons/onboarding/guardian-avatar.svg';
import { Button } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';
import { GuardianInfoDrawer } from 'screens/onboarding/common/GuardianInfoDrawer';

const GuardianDetailRow: FC<{ label: string; value: string; isLast?: boolean }> = ({ label, value, isLast }) => (
  <div
    className={`flex min-h-12 items-center justify-between gap-4 py-3 text-heading-gray text-sm font-medium ${isLast ? '' : 'border-b border-border-faint'}`}
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
  // The ONE derivation of the guardian's status — pill, fault treatment and the
  // "Last sync" reading come from `deriveGuardianPresentation` (see that module
  // for the precedence rules and their history: drift outranks liveness,
  // `resolving` reads Checking not Online, a stamp has a freshness lifetime).
  // This screen only maps the result onto copy and styling; it derives nothing,
  // so it cannot disagree with the send guard or any other surface.
  const { pill: guardianStatus, fault: isGuardianFault, lastSync: lastSyncState } = useGuardianPresentation();
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const option = guardianOptionForEndpoint(currentEndpoint);
  const logoEntry = option ? GUARDIAN_LOGOS[option.id] : undefined;
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
        <h2 className="mt-2 break-all text-center font-heading text-xl font-bold text-heading-gray">{guardianName}</h2>
        {/* Both halves of this pill needed their own shade. `dark:text-green-400`
            compiled to nothing — `theme.colors` in tailwind.config.ts replaces
            Tailwind's palette rather than extending it — so dark mode kept
            green-700 (#38824A) at 3.05:1; green-300 is 6.6:1 there. Light mode was
            green-700 on green-50 at 4.34:1, short of AA now that this PR grew the
            text from 12px to 14px, so it takes the new green-800 (7.3:1). */}
        {/* `role="status"` + polite live region: this pill CHANGES under a user
            who is already on the page (the outage arms from the 3s sync tick,
            and "checking" resolves to "online" the moment the first sync
            lands), and a bare div announces nothing when it does. Polite, not
            assertive — it must not interrupt whatever is being read. */}
        {/* "Checking" uses the auto-flipping neutral tokens (`bg-gray-50` /
            `text-heading-gray`) already used elsewhere on this page, so it
            needs no `dark:` pairing of its own — unlike the red/green states,
            which use the fixed palette and therefore do. */}
        {currentEndpoint && (
          <div
            role="status"
            aria-live="polite"
            className={clsx(
              'mt-1.5 flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold',
              isGuardianFault
                ? // red-700 is 5.9:1 on red-50; red-300 was added for the dark fill
                  // (see tailwind-colors.js) — 500, the next shade down, is ~4.6:1
                  // there, short of AA at this size. Both fault states take it:
                  // "unreachable" and "answering but unusable" differ in cause,
                  // not in whether the account can transact.
                  'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                : guardianStatus === 'online'
                  ? 'bg-green-50 text-green-800 dark:bg-green-500/15 dark:text-green-300'
                  : // Both neutral states share the auto-flipping tokens: neither is
                    // a fault, and "not connected" is resolved by activating the
                    // device key, which the app prompts for elsewhere.
                    'bg-gray-50 text-heading-gray'
            )}
          >
            <span
              className={clsx(
                'h-2 w-2 rounded-full',
                isGuardianFault ? 'bg-red-500' : guardianStatus === 'online' ? 'bg-green-500' : 'bg-gray-400'
              )}
            />
            <span>
              {guardianStatus === 'offline'
                ? t('guardianOfflineLabel')
                : // Drift shares the unrepairable copy: both are "the operator is
                  // answering and this account still cannot rely on it, and you
                  // need to act". The causes differ, but no copy in the design
                  // distinguishes them, and inventing a string here would cost a
                  // 14-locale re-translation cycle (see the ledger's F-136).
                  guardianStatus === 'unrepairable' || guardianStatus === 'drifted'
                  ? t('guardianNeedsAttentionLabel')
                  : guardianStatus === 'online'
                    ? t('online')
                    : guardianStatus === 'checking'
                      ? t('guardianCheckingLabel')
                      : t('guardianNotConnectedLabel')}
            </span>
          </div>
        )}
      </div>

      <section className="mt-5">
        {/* `text-heading-gray`, the token the Settings page's own group headings
            use, rather than `text-text-muted`: muted is #ababab, and on the
            gray-25 chip this sits on (#f9f9f9) that is 2.18:1 — a 14px semibold
            heading, so it needs 4.5:1, not the large-text 3:1. heading-gray is
            8.69:1 there and pure white on the dark chip.

            `h3`, subordinate to the guardian name's h2 above: these are sections
            within the page, not siblings of its subject. The "settings group
            headings skipped h2" fix belonged to the Settings root list, where
            there was genuinely no h2 to be subordinate to; promoting these gave
            the page three sibling h2s and flattened a correct outline. */}
        <h3 className="inline-block rounded-full bg-gray-25 px-3 py-1 text-sm font-semibold text-heading-gray">
          {t('about')}
        </h3>
        <p className="mt-2 text-sm leading-5 text-heading-gray">
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

      <hr className="my-3 border-border-faint" />

      <section className="pb-4">
        <h3 className="inline-block rounded-full bg-gray-25 px-3 py-1 text-sm font-semibold text-heading-gray">
          {t('details')}
        </h3>
        <div className="mt-1">
          <GuardianDetailRow label={t('guardianProvider')} value={provider} />
          <GuardianDetailRow label={t('guardianEndpointLabel')} value={endpoint} />
          <GuardianDetailRow label={t('guardianRegion')} value={region} />
          <GuardianDetailRow label={t('guardianLastSync')} value={lastSync} isLast />
        </div>
      </section>

      <Button
        className="mt-auto mb-6 max-w-none shrink-0"
        data-testid="rotateGuardian"
        title={t('rotateGuardian')}
        onClick={handleRotate}
      />

      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </div>
  );
};

export default GuardianSettings;
