import React, { FC, useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { useHideForegroundDappWhileOpen } from 'app/providers/DappBrowserProvider';
import { Button } from 'components/Button';
import { NetworkNoticeRows } from 'components/NetworkNoticeRows';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { hapticLight } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { useLocation } from 'lib/woozie';

/**
 * Persistent banner that tells the user which Miden network the wallet is on.
 * The name follows the effective network, so a Developer Settings override
 * shows here too, and the banner renders nothing on mainnet. The colors come
 * from the build-time brand ramp, so a devnet build shows the slate palette.
 *
 * Tapping the banner opens a sheet with the test-network explanation (#875):
 * no value, no real funds, and resets that never carry over to Mainnet.
 */
export const NetworkModeBanner: FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { pathname, hash } = useLocation();

  const onOpen = useCallback(() => {
    hapticLight();
    setOpen(true);
  }, []);

  // The shared Button fires its own tap haptic.
  const onClose = useCallback(() => setOpen(false), []);

  // The sheet lives outside the routed page, so a navigation does not unmount
  // it: close it on any route or onboarding-step change, and let mobile back
  // close it before anything underneath handles the press.
  useEffect(() => {
    setOpen(false);
  }, [pathname, hash]);
  useMobileBackHandler(
    () => {
      if (!open) return false;
      setOpen(false);
      return true;
    },
    [open],
    { overlay: true }
  );

  // A foregrounded dApp's native window sits above the host WebView and would
  // cover the sheet; the provider hides it while this holds.
  useHideForegroundDappWhileOpen(open);

  const networkKey = getTestNetworkNameKey();
  if (!networkKey) return null;
  const network = t(networkKey);

  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-11 w-full shrink-0 items-center justify-center gap-2 border-b border-dashed border-primary-orange-light bg-primary-orange-lighter px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/30 dark:border-primary-orange-dark dark:bg-primary-orange-darker"
        data-testid="network-mode-banner"
      >
        <BreadLogo aria-hidden="true" className="size-[18px] shrink-0" />
        <span className="font-heading text-sm font-bold text-primary-orange-dark dark:text-primary-orange-light">
          {t('networkModeBanner', { network })}
        </span>
      </button>

      <Drawer open={open} onOpenChange={setOpen} screenKey="network-mode">
        {/* The rows scroll and the CTA stays pinned: the sheet can outgrow
            DrawerContent's 80vh cap in the 360x600 popup and in long locales. */}
        <DrawerContent className="overflow-hidden pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
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
            <DrawerFooter className="shrink-0">
              <Button
                title={t('iUnderstand')}
                onClick={onClose}
                className="w-full"
                data-testid="network-mode-sheet-cta"
              />
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
};
