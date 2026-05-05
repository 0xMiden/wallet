import React, { FC, useCallback, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ConnectivityCategory } from 'lib/miden/activity/connectivity-state';
import { useConnectivityState } from 'lib/miden/activity/use-connectivity-state';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';

export interface ConnectivityIssueBannerProps {
  className?: string;
}

interface BannerView {
  category: ConnectivityCategory;
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
 *   network > node > prover > resolving
 *
 * Reasoning: if the user is offline, fixing that fixes everything else, so
 * surface that. If the node is unreachable, that masks the prover signal
 * (we can't know prover health if we can't sync). Prover is the lowest hard
 * category — it just means transactions go local, which still works.
 * `resolving` only renders when nothing else is active.
 */
function pickActiveCategory(state: ReturnType<typeof useConnectivityState>['state']): ConnectivityCategory | null {
  if (state.network.active) return 'network';
  if (state.node.active) return 'node';
  if (state.prover.active) return 'prover';
  if (state.resolving.active) return 'resolving';
  return null;
}

const VIEWS: Record<ConnectivityCategory, BannerView> = {
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

  const active = useMemo(() => pickActiveCategory(state), [state]);
  const view = active ? VIEWS[active] : null;

  const onRetry = useCallback(() => {
    hapticLight();
    if (!isExtension()) {
      // On mobile/desktop sync runs in-process via useSyncTrigger; flipping
      // the resolving flag prompts a UI hint that a retry is in progress.
      // The next sync tick (max ~3s) will either clear the issue or
      // re-mark it.
      return;
    }
    // Extension: poke the SW to sync immediately. SW will clear the
    // category on success or re-mark it on failure.
    void getIntercom()
      .request({ type: WalletMessageType.SyncRequest })
      .catch(() => {});
  }, []);

  const onDismiss = useCallback(() => {
    if (!view) return;
    hapticLight();
    dismiss(view.category);
  }, [dismiss, view]);

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
        <p className="text-gray-600 text-xs">{t(view.bodyKey)}</p>
      </div>
      {view.ctaKey && (
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-medium text-primary-500 px-2 py-1 rounded-md hover:bg-gray-100"
        >
          {t(view.ctaKey)}
        </button>
      )}
      <Icon
        name={IconName.Close}
        size="sm"
        fill="currentColor"
        className="cursor-pointer hover:opacity-100 opacity-50"
        onClick={onDismiss}
      />
    </div>
  );
};

/**
 * Legacy listener kept for back-compat with the SW->popup runtime-message
 * path. Now a no-op: the categorized state machine writes to chrome.storage
 * and the popup picks it up via `useConnectivityState`'s storage subscription.
 */
export const ExtensionMessageListener: FC = () => null;
