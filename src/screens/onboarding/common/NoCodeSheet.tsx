import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface NoCodeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An existing account needs no code: the recover flow. */
  onRecover: () => void;
}

/**
 * The invite-only Welcome's "I don't have a code": a new wallet needs a mainnet access code. An
 * account that already exists can still be recovered. The caller owns `open`.
 */
export const NoCodeSheet: FC<NoCodeSheetProps> = ({ open, onOpenChange, onRecover }) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="no-code">
      <DrawerContent>
        <div className="flex min-h-0 flex-col" data-testid="no-code-sheet">
          <DrawerHeader>
            <DrawerTitle>{t('noCodeTitle')}</DrawerTitle>
          </DrawerHeader>
          <DrawerDescription>{t('noCodeBody')}</DrawerDescription>
          {/* The shared Button fires its own tap haptic. */}
          <DrawerFooter className="shrink-0 gap-2.5">
            <Button
              title={t('gotIt')}
              onClick={() => onOpenChange(false)}
              className="w-full"
              data-testid="no-code-sheet-close"
            />
            <Button
              variant={ButtonVariant.Secondary}
              title={t('recoverYourAccount')}
              onClick={onRecover}
              className="w-full"
              data-testid="no-code-sheet-recover"
            />
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
};
