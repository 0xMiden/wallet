import React, { FC, useEffect, useState, useSyncExternalStore } from 'react';

import { Trans, useTranslation } from 'react-i18next';

import {
  guardianEndpointHost,
  guardianOptionForEndpoint,
  useCurrentGuardianEndpoint
} from 'app/hooks/useCurrentGuardianEndpoint';
import { Button } from 'components/Button';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { StatusBadge } from 'components/ui/StatusBadge';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
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
        <Button className="flex-1" data-testid="rotateGuardian" title={t('rotateGuardian')} onClick={handleRotate} />
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
