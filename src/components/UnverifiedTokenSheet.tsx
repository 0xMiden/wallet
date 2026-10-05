import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { useHideForegroundDappWhileOpen } from 'app/providers/DappBrowserProvider';
import { Button } from 'components/Button';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

interface UnverifiedTokenSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Why a token is marked Unverified, opened from the "Unverified token · Why?" pill on its token page:
 * the token is not on Miden's verified list, and anyone can mint a token under any name, so the
 * faucet ID is what to check before trusting it.
 */
export const UnverifiedTokenSheet: FC<UnverifiedTokenSheetProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();

  // A foregrounded dApp's native window sits above the host WebView and would cover the sheet.
  useHideForegroundDappWhileOpen(open);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="unverified-token">
      <DrawerContent className="pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <div className="flex min-h-0 flex-1 flex-col" data-testid="unverified-token-sheet">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DrawerHeader>
              <DrawerTitle>{t('unverifiedTokenTitle')}</DrawerTitle>
            </DrawerHeader>
            {/* 16px, a size up from the drawer's caption, in the heading face: it is the sheet's whole message. */}
            <DrawerDescription className="face-heading text-body-strong">
              {t('unverifiedTokenDescription')}
            </DrawerDescription>
          </div>
          {/* The shared Button fires its own tap haptic. */}
          <DrawerFooter className="shrink-0">
            <Button
              title={t('iUnderstand')}
              onClick={() => onOpenChange(false)}
              className="w-full"
              data-testid="unverified-token-sheet-cta"
            />
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
};
