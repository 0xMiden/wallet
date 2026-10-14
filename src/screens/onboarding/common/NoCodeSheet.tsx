import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { isExtension } from 'lib/platform';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { cn } from 'lib/ui/util';

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
      {/* The sheet keeps the width of the onboarding column (`data-onboarding-root`) and stays
          centred under it: an extension tab is wider than the column. On the extension it is at
          least 500px tall, and the actions stay pinned to its bottom edge. */}
      <DrawerContent className={cn('mx-auto max-w-[420px]', isExtension() && 'min-h-[500px]')}>
        <div className="flex min-h-0 flex-1 flex-col" data-testid="no-code-sheet">
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
