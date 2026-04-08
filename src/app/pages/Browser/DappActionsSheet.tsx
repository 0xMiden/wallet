/**
 * WeChat-style actions sheet for the active dApp.
 *
 * Triggered from the capsule's rightmost button (a `⋯` icon). Renders a
 * bottom drawer with a single horizontal row of icon + label buttons,
 * modeled on WeChat's mini-program top-right menu:
 *
 *   [ Copy link ]  [ Add to My Dapps ]  [ Reopen ]
 *
 * Reuses the same `Drawer` primitive that Settings uses so the morph
 * machinery that slides the native bottom navbar out of view is
 * already wired up via `DappActive`'s `data-drawer-open` effect.
 */

import React, { type FC, useCallback } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { type DappSession, getDappDisplayName, recordRecentDapp } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

interface DappActionsSheetProps {
  session: DappSession | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hard-restart: close the current session and open a fresh one at the same URL. */
  onReopen: () => void;
}

interface ActionButtonProps {
  icon: IconName;
  label: string;
  onClick: () => void;
}

const ActionButton: FC<ActionButtonProps> = ({ icon, label, onClick }) => (
  <button type="button" onClick={onClick} className="flex flex-1 flex-col items-center gap-2 px-2 py-2">
    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-grey-100">
      <Icon name={icon} size="md" className="text-grey-700" fill="currentColor" />
    </div>
    <span className="text-center text-xs font-medium leading-tight text-grey-700">{label}</span>
  </button>
);

export const DappActionsSheet: FC<DappActionsSheetProps> = ({ session, open, onOpenChange, onReopen }) => {
  const { t } = useTranslation();

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleCopyLink = useCallback(() => {
    if (!session) return;
    hapticLight();
    // Clipboard API is available in WKWebView under a secure context,
    // which the Capacitor host always is. Swallow errors — the UI
    // closes either way so the user isn't left with a stuck sheet.
    void navigator.clipboard.writeText(session.url).catch(() => {});
    close();
  }, [session, close]);

  const handleAddToMyDapps = useCallback(() => {
    if (!session) return;
    hapticLight();
    void recordRecentDapp({
      url: session.url,
      name: getDappDisplayName(session),
      origin: session.origin,
      favicon: session.favicon ?? undefined
    }).catch(() => {});
    close();
  }, [session, close]);

  const handleReopen = useCallback(() => {
    if (!session) return;
    hapticLight();
    // Close the sheet FIRST so the morph-in animation starts before the
    // hard-restart disposes the current native window. Otherwise the
    // sheet would be left stranded once the webview tears down.
    close();
    onReopen();
  }, [session, close, onReopen]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('dappActionsSheet') ?? 'dApp actions'}</DrawerTitle>
        </DrawerHeader>
        <div className="flex items-start justify-around gap-2 px-4 pb-8">
          <ActionButton icon={IconName.Copy} label={t('dappActionCopyLink') ?? 'Copy link'} onClick={handleCopyLink} />
          <ActionButton
            icon={IconName.AddCircle}
            label={t('dappActionAddToMyDapps') ?? 'Add to My Dapps'}
            onClick={handleAddToMyDapps}
          />
          <ActionButton icon={IconName.Refresh} label={t('dappActionReopen') ?? 'Reopen'} onClick={handleReopen} />
        </div>
      </DrawerContent>
    </Drawer>
  );
};
