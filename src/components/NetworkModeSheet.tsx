import React, { FC, useEffect, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { usePageActive } from 'app/layouts/page-active';
import { useHideForegroundDappWhileOpen } from 'app/providers/DappBrowserProvider';
import { Button } from 'components/Button';
import { NetworkNoticeRows } from 'components/NetworkNoticeRows';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { useLocation } from 'lib/woozie';

export interface NetworkModeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The test-network explanation (#875): no value, no real funds, and resets that never carry over to
 * Mainnet. Opened from the corner ribbon on the bottom nav and from the dApp confirm window's
 * banner; the caller owns `open`. Renders nothing on mainnet.
 */
export const NetworkModeSheet: FC<NetworkModeSheetProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const { pathname, hash } = useLocation();
  const pageActive = usePageActive();
  // The latest callback, so closing on a navigation does not also run whenever the caller hands in
  // a new function (which would close the sheet the render after it opened).
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  // The sheet lives outside the routed page's own tree, so a navigation does not unmount it: close
  // it on any route or onboarding-step change, and when the page it opened from goes off screen (a
  // page slid over the tabs), since the drawer itself is portaled above everything. Only a change
  // closes it, so a sheet that mounts open stays open.
  const where = { pathname, hash, pageActive };
  const lastWhere = useRef(where);
  useEffect(() => {
    const last = lastWhere.current;
    lastWhere.current = { pathname, hash, pageActive };
    if (last.pathname !== pathname || last.hash !== hash || last.pageActive !== pageActive) {
      onOpenChangeRef.current(false);
    }
  }, [pathname, hash, pageActive]);

  // A foregrounded dApp's native window sits above the host WebView and would cover the sheet; the
  // provider hides it while this holds.
  useHideForegroundDappWhileOpen(open);

  const networkKey = getTestNetworkNameKey();
  if (!networkKey) return null;
  const network = t(networkKey);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="network-mode">
      {/* The rows scroll and the CTA stays pinned: the sheet can outgrow DrawerContent's 80vh cap in
          the 360x600 popup and in long locales. */}
      <DrawerContent className="pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <div className="flex min-h-0 flex-1 flex-col" data-testid="network-mode-sheet">
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="network-mode-sheet-body">
            <DrawerHeader>
              <DrawerTitle>{t('networkModeBanner', { network })}</DrawerTitle>
              <DrawerDescription>{t('networkNoticeBody')}</DrawerDescription>
            </DrawerHeader>
            <div className="px-4">
              <NetworkNoticeRows />
            </div>
          </div>
          {/* The shared Button fires its own tap haptic. */}
          <DrawerFooter className="shrink-0">
            <Button
              title={t('iUnderstand')}
              onClick={() => onOpenChange(false)}
              className="w-full"
              data-testid="network-mode-sheet-cta"
            />
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
};
