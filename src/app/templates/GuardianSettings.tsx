import React, { FC, useEffect, useState, useSyncExternalStore } from 'react';

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
import {
  getGuardianLastSyncAt,
  isGuardianLastSyncFresh,
  isGuardianSyncOutage,
  isGuardianUnrepairable,
  subscribeGuardianSyncOutage
} from 'lib/miden/front/guardian-sync';
import { hapticLight } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
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
  // Live reachability from the sync loop's outage flag (armed after a
  // threshold of consecutive server-down sync failures, cleared by any
  // guardian response) — the same signal the home connectivity banner reads.
  // Endpoint presence alone said "Online" through an entire outage.
  const currentAccountPk = useWalletStore(s => s.currentAccount?.publicKey);
  // The guardian sync loop only runs for accounts that carry a hot key — see the
  // filter's docstring in `guardian-sync.ts`. A rotation-pending or
  // not-yet-migrated account is skipped entirely, so it never stamps a sync and
  // never arms an outage: reading that silence as "checking" left the pill
  // spinning forever on an account nothing was ever going to check.
  const hasHotKey = useWalletStore(s => Boolean(s.currentAccount?.hotPublicKey));
  // Reconciler verdict on whether the operator named on this screen is still the
  // account's on-chain guardian. Selected as the field rather than the account so
  // an unrelated account update does not re-render the status.
  const guardianSyncStatus = useWalletStore(s => s.currentAccount?.guardianSyncStatus);
  const guardianOutage = useSyncExternalStore(subscribeGuardianSyncOutage, () =>
    currentAccountPk ? isGuardianSyncOutage(currentAccountPk) : false
  );
  // The operator ANSWERS and the account still cannot use it, with automatic
  // repair exhausted. Distinct from an outage — the endpoint is up, so nothing
  // else on this screen would ever say anything is wrong.
  const guardianUnrepairable = useSyncExternalStore(subscribeGuardianSyncOutage, () =>
    currentAccountPk ? isGuardianUnrepairable(currentAccountPk) : false
  );
  // The GUARDIAN's own last sync, from the same channel as the pill — not the
  // store's wallet-wide `lastSyncedAt`, which a healthy chain sync keeps
  // refreshing while the guardian is down, putting "3s ago" next to an Offline
  // pill on this very screen.
  const guardianLastSyncAt = useSyncExternalStore(subscribeGuardianSyncOutage, () =>
    currentAccountPk ? getGuardianLastSyncAt(currentAccountPk) : undefined
  );
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  // Both the pill and the "Last sync" row are functions of ELAPSED time, and
  // nothing else on this screen re-renders on the clock: the sync module notifies
  // only on a completed sync or an observable flag change, and the other
  // subscriptions here are primitives that do not change. So a screen left open
  // kept rendering the string computed at the last notification — "3s ago",
  // indefinitely — and the freshness check below would never re-evaluate. This
  // interval is the clock the two of them read.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!currentEndpoint) return;
    // 15s: fine enough that the pill flips within a fraction of the freshness
    // window and the relative time never visibly lags, coarse enough to be free.
    const timer = setInterval(() => setClockTick(tick => tick + 1), 15_000);
    return () => clearInterval(timer);
  }, [currentEndpoint]);

  const option = guardianOptionForEndpoint(currentEndpoint);
  const logoEntry = option ? GUARDIAN_LOGOS[option.id] : undefined;
  const guardianName = option?.name ?? (currentEndpoint ? t('customGuardian') : t('loading'));
  const provider = option?.operatedBy ?? (currentEndpoint ? t('customGuardian') : t('loading'));
  const region = option?.location ?? t('unknown');
  const endpoint = guardianEndpointHost(currentEndpoint) || t('loading');
  // `guardianLastSyncAt` is session-local and starts empty on every popup
  // reopen, so its absence means "not checked yet this session" — not "online"
  // and not "never synced, historically". `guardianStatus` is the one place
  // that turns those two signals into a status, so the pill and the "Last
  // sync" row below always read as one consistent story rather than two.
  // Drift outranks every liveness signal, because it invalidates the SUBJECT the
  // rest of this screen describes. `needs-user-input` means the account's
  // on-chain guardian is not the operator named here and the wallet could not
  // work out which one it is — so the name, the provider, the region and the host
  // on this screen are all about the previous operator. Left out of this
  // derivation, a still-live previous operator kept answering our syncs and the
  // screen reported it Online with a seconds-old "Last sync": true about that
  // endpoint, false about this account's guardian, and the only state on this
  // screen where the user cannot act on what they are being shown. The recovery
  // prompt for it lives on Home, so Settings said nothing at all.
  //
  // `resolving` is deliberately NOT a fault here: it is the marker the reconciler
  // writes at the START of a round that normally ends `in-sync`, so treating it
  // as one would flash "Needs attention" through every ordinary reconciliation.
  //
  // But it is not "Online" either, and that was the gap. `assertGuardianInSync`
  // rejects on ANY status other than `in-sync` — `resolving` included — so while
  // the reconciler is mid-round every send is refused with "guardian out of
  // sync". With a fresh sync stamp the freshness arm below then reported a green
  // "Online" for exactly that window: the pill claiming the guardian is usable
  // while the wallet was refusing to use it, which is the one failure this pill
  // exists to prevent. "Checking" is the honest reading and keeps the intent
  // above intact — it is not an accusation, it just declines to certify.
  const guardianDrifted = guardianSyncStatus === 'needs-user-input';
  const guardianResolving = guardianSyncStatus === 'resolving';
  const guardianStatus: 'not-connected' | 'drifted' | 'offline' | 'unrepairable' | 'checking' | 'online' = !hasHotKey
    ? 'not-connected'
    : guardianDrifted
      ? 'drifted'
      : guardianOutage
        ? 'offline'
        : guardianUnrepairable
          ? 'unrepairable'
          : // FRESHNESS, not existence. The stamp records a moment; this pill
            // asserts a present state, and two reachable paths stop syncing
            // without arming either fault flag — a sustained 429 (which clears
            // the outage, because the server answered) and any sustained local
            // error. Both leave the last stamp in place, so reading its mere
            // existence as "online" made a permanently-stuck account read green
            // for the life of the realm. See `GUARDIAN_SYNC_STAMP_FRESH_MS`.
            guardianResolving || !isGuardianLastSyncFresh(currentAccountPk ?? '')
            ? 'checking'
            : 'online';
  // Three states, one visual treatment: unreachable, answering-but-unusable, and
  // pointing at an operator that is no longer the guardian differ in cause, not
  // in whether the account can rely on its guardian.
  const isGuardianFault =
    guardianStatus === 'offline' || guardianStatus === 'unrepairable' || guardianStatus === 'drifted';
  const lastSync =
    // A stamp is suppressed under drift, and only under drift. Beside an Offline
    // pill "5 min ago" is a true historical fact about the operator this screen
    // names — it synced, then went down. Under drift that operator is not the
    // account's guardian, so rendering its stamp here would put a fresh
    // timestamp next to a fault pill and attribute one operator's success to
    // another: the same contradiction, one subsystem further along.
    // A STALE stamp still renders its real age here, beside a "Checking" pill,
    // and that is the intended reading rather than a contradiction: this row is
    // history ("the last confirmed sync was 5 minutes ago") and the pill is the
    // present ("we do not currently know"). Replacing the age with "Unknown"
    // would throw away the most useful fact on the screen in exactly the state
    // where the user is trying to work out how long something has been wrong.
    guardianLastSyncAt !== undefined && !guardianDrifted
      ? formatLastSync(guardianLastSyncAt, i18n?.resolvedLanguage ?? i18n?.language ?? 'en')
      : // Derived from the SAME status as the pill, so the two cannot disagree.
        // A second, looser condition is what let them: an outage arms without
        // ever stamping a sync, so `hasHotKey && !unrepairable` stayed true
        // underneath an Offline pill and this row answered "Checking" for the
        // whole outage — contradicting the pill directly above it, in the one
        // state where the user most needs to believe it.
        //
        // Three different silences, three different answers. "Checking" only
        // while something IS checking. "Never" only where it is literally true —
        // an account with no hot key has never synced from this device. A fault
        // state gets "Unknown": the stamp is session-local, so its absence under
        // an operator that is down says nothing about whether this account ever
        // synced, and "Never" would assert something false about the account's
        // whole history on the screen the user came to for the truth.
        guardianStatus === 'checking'
        ? t('guardianCheckingLabel')
        : guardianStatus === 'not-connected'
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
