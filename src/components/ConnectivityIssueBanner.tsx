import React, { FC, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ConnectivityCategory } from 'lib/miden/activity/connectivity-state';
import { useConnectivityState } from 'lib/miden/activity/use-connectivity-state';
import { isGuardianSyncOutage, subscribeGuardianSyncOutage } from 'lib/miden/front/guardian-sync';
import { requestImmediateSync } from 'lib/miden/front/useSyncTrigger';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

export interface ConnectivityIssueBannerProps {
  className?: string;
}

/**
 * `guardian` is a banner-local category, NOT part of the shared
 * connectivity-state snapshot: the outage flag lives in guardian-sync's own
 * realm-local subscription (the sync loop and this banner share the frontend
 * realm), so routing it through the SW-owned snapshot would only add a
 * cross-realm writer to a key with single-writer rules.
 */
type BannerCategory = ConnectivityCategory | 'guardian';

interface BannerView {
  category: BannerCategory;
  iconName: IconName;
  iconColor: string;
  titleKey: string;
  bodyKey: string;
  /** When set, render a retry CTA with this label. */
  ctaKey?: string;
}

/**
 * Decide which single category to surface. The user can have multiple active
 * at once (e.g. node down + prover down) but a stack of three banners is
 * worse UX than picking the most actionable one. Priority:
 *
 *   network > node > guardian > prover > resolving
 *
 * Reasoning: if the user is offline, fixing that fixes everything else, so
 * surface that. If the node is unreachable, that masks the prover signal
 * (we can't know prover health if we can't sync) — and the guardian signal
 * too, since guardian sync fails on a dead node as well. A down guardian
 * outranks the prover: it blocks every co-signed transaction and has a real
 * remedy (switch operators), while a prover failure just means transactions
 * go local, which still works. `resolving` only renders when nothing else is
 * active.
 */
function pickActiveCategory(
  state: ReturnType<typeof useConnectivityState>['state'],
  guardianDown: boolean
): BannerCategory | null {
  if (state.network.active) return 'network';
  if (state.node.active) return 'node';
  if (guardianDown) return 'guardian';
  if (state.prover.active) return 'prover';
  if (state.resolving.active) return 'resolving';
  return null;
}

const VIEWS: Record<BannerCategory, BannerView> = {
  network: {
    category: 'network',
    iconName: IconName.WarningFill,
    iconColor: '#FEA644',
    titleKey: 'connectivityNetworkTitle',
    bodyKey: 'connectivityNetworkBody',
    ctaKey: 'connectivityRetry'
  },
  node: {
    category: 'node',
    iconName: IconName.WarningFill,
    iconColor: '#FEA644',
    titleKey: 'connectivityNodeTitle',
    bodyKey: 'connectivityNodeBody',
    ctaKey: 'connectivityRetrySync'
  },
  guardian: {
    category: 'guardian',
    iconName: IconName.WarningFill,
    iconColor: '#FEA644',
    titleKey: 'connectivityGuardianTitle',
    bodyKey: 'connectivityGuardianBody',
    // Routes to Rotate Guardian rather than retrying: the flag only arms after
    // the sync loop has already retried past its threshold, and the direct
    // on-chain switch fallback makes the rotation work while the operator is
    // down. The flag self-clears the moment the guardian answers again.
    ctaKey: 'connectivityGuardianCta'
  },
  prover: {
    category: 'prover',
    iconName: IconName.InformationFill,
    iconColor: '#5b8def',
    titleKey: 'connectivityProverTitle',
    bodyKey: 'connectivityProverBody'
    // No CTA: prover failures auto-clear on the next successful prover call,
    // and there's nothing useful for the user to do besides wait.
  },
  resolving: {
    category: 'resolving',
    iconName: IconName.Refresh,
    iconColor: '#9ca3af',
    titleKey: 'connectivityResolvingTitle',
    bodyKey: 'connectivityResolvingBody'
  }
};

export const ConnectivityIssueBanner: FC<ConnectivityIssueBannerProps> = ({ className }) => {
  const { t } = useTranslation();
  const { state, dismiss } = useConnectivityState();

  // Guardian-outage flag for the CURRENT account, live from the sync loop
  // (armed after a threshold of consecutive server-down sync failures, cleared
  // by any guardian response — see guardian-sync.ts). Dismissal is
  // session-local: the flag clearing resets it, so a NEW outage re-surfaces
  // the banner rather than inheriting an old dismiss.
  const currentAccountPk = useWalletStore(s => s.currentAccount?.publicKey);
  const guardianOutage = useSyncExternalStore(subscribeGuardianSyncOutage, () =>
    currentAccountPk ? isGuardianSyncOutage(currentAccountPk) : false
  );
  // The dismissed ACCOUNT, not a bare boolean: the flag is per-account, so with
  // two guardian accounts on two dead operators a boolean would let a dismiss on
  // the first silently suppress the second's banner — `guardianOutage` stays
  // `true` across that switch, so the reset effect never fires.
  const [dismissedAccountPk, setDismissedAccountPk] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!guardianOutage) setDismissedAccountPk(undefined);
  }, [guardianOutage]);
  const guardianDismissed = dismissedAccountPk !== undefined && dismissedAccountPk === currentAccountPk;

  const active = useMemo(
    () => pickActiveCategory(state, guardianOutage && !guardianDismissed),
    [guardianDismissed, guardianOutage, state]
  );
  const view = active ? VIEWS[active] : null;

  const onCta = useCallback(() => {
    hapticLight();
    if (view?.category === 'guardian') {
      navigate('/rotate-guardian');
      return;
    }
    if (!isExtension()) {
      requestImmediateSync();
      return;
    }
    // Extension: poke the SW to sync immediately. SW will clear the
    // category on success or re-mark it on failure.
    void getIntercom()
      .request({ type: WalletMessageType.SyncRequest, force: true })
      .catch(() => {});
  }, [view]);

  const onDismiss = useCallback(() => {
    if (!view) return;
    hapticLight();
    if (view.category === 'guardian') {
      setDismissedAccountPk(currentAccountPk);
      return;
    }
    dismiss(view.category);
  }, [currentAccountPk, dismiss, view]);

  if (!view) return null;

  return (
    <div
      className={classNames('min-h-[56px] flex items-center bg-white px-4 gap-x-2 py-2 rounded-t-3xl', className)}
      data-testid={`connectivity-banner-${view.category}`}
    >
      <div className="flex items-center">
        <Icon name={view.iconName} size="md" fill={view.iconColor} />
      </div>
      <div className="flex-1 flex flex-col justify-center items-start min-w-0">
        <p className="text-black text-sm font-medium">{t(view.titleKey)}</p>
        <p className="text-text-muted text-xs">{t(view.bodyKey)}</p>
      </div>
      {view.ctaKey && (
        <button
          type="button"
          onClick={onCta}
          className="text-xs font-medium text-primary-500 px-2 py-1 rounded-md hover:bg-gray-100"
        >
          {t(view.ctaKey)}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('close')}
        className="flex size-8 shrink-0 items-center justify-center rounded-md opacity-50 hover:bg-gray-100 hover:opacity-100"
      >
        <Icon name={IconName.Close} size="sm" fill="currentColor" />
      </button>
    </div>
  );
};

/**
 * Legacy listener kept for back-compat with the SW->popup runtime-message
 * path. Now a no-op: the categorized state machine writes to chrome.storage
 * and the popup picks it up via `useConnectivityState`'s storage subscription.
 */
export const ExtensionMessageListener: FC = () => null;
