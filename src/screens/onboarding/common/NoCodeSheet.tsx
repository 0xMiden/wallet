import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { isExtension } from 'lib/platform';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { cn } from 'lib/ui/util';

export interface NoCodeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Show the access code information. The caller controls `open`.
 */
export const NoCodeSheet: FC<NoCodeSheetProps> = ({ open, onOpenChange }) => {
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
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
};
