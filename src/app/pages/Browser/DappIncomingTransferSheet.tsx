import React, { type FC } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { useHideForegroundDappWhileOpen } from 'app/providers/DappBrowserProvider';
import { useActivityClaimList } from 'app/templates/history/useActivityClaimList';
import { EmptyState } from 'components/ui/EmptyState';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface DappIncomingTransferSheetProps {
  onClose: () => void;
}

export const DappIncomingTransferSheet: FC<DappIncomingTransferSheetProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const { representedItems, renderPendingItem } = useActivityClaimList('', 'pending');
  useHideForegroundDappWhileOpen(true);

  return (
    <Drawer open onOpenChange={open => !open && onClose()} screenKey="dapp-incoming-transfer">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('noteReceivedTitle')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-6">
          {representedItems.length ? (
            representedItems.map(item => renderPendingItem(item, true))
          ) : (
            <EmptyState icon={IconName.ArrowUpDown} title={t('noOperationsFound')} />
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};
