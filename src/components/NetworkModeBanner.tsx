import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { Button } from 'components/Button';
import { NetworkNoticeRows } from 'components/NetworkNoticeRows';
import { hapticLight } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { isDevnet } from 'utils/brand-colors';

/**
 * Persistent banner that tells the user which Miden network this build runs on.
 * The network name is a build-time constant: `MIDEN_NETWORK=devnet` shows
 * "Devnet", every other build shows "Testnet". The colors come from the
 * network-conditional brand ramp, so the devnet build shows the slate palette.
 *
 * Tapping the banner opens a sheet with the test-network explanation (#875):
 * no value, no real funds, and resets that never carry over to Mainnet.
 */
export const NetworkModeBanner: FC = () => {
  const { t } = useTranslation();
  const network = isDevnet ? t('devnet') : t('testnet');
  const [open, setOpen] = useState(false);

  const onOpen = useCallback(() => {
    hapticLight();
    setOpen(true);
  }, []);

  const onClose = useCallback(() => {
    hapticLight();
    setOpen(false);
  }, []);

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
        <DrawerContent className="pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
          <DrawerHeader>
            <DrawerTitle>{t('networkModeBanner', { network })}</DrawerTitle>
            <DrawerDescription>{t('networkNoticeBody')}</DrawerDescription>
          </DrawerHeader>

          <div className="flex flex-col gap-4 px-4" data-testid="network-mode-sheet">
            <NetworkNoticeRows className="flex flex-col divide-y divide-rule-default" />
            <Button title={t('iUnderstand')} onClick={onClose} className="w-full" />
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
};
