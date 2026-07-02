import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { navigate } from 'lib/woozie';

export interface AccountsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Bottom sheet opened from the BalanceCard "more" (3-dots) button. Lists
 * account-level actions: Settings (navigates to /settings) and a disabled
 * "Add Account" placeholder.
 */
export const AccountsDrawer: FC<AccountsDrawerProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();

  const handleSettings = () => {
    hapticLight();
    onOpenChange(false);
    navigate('/settings');
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('accounts')}</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-col gap-2.5 px-4 pb-6">
          <button
            type="button"
            onClick={handleSettings}
            className={classNames(
              'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-4',
              'bg-[#F9F9F9]',
              'text-sm font-semibold text-[#8E8E93]',
              'transition-colors hover:bg-[#ECEAE7] dark:hover:bg-[#3f3f3f] rounded-2xl'
            )}
          >
            <Icon name={IconName.SettingsNew} className="w-4 h-4" fill="currentColor" />
            <span>{t('settings')}</span>
          </button>

          <button
            type="button"
            disabled
            aria-disabled="true"
            className={classNames(
              'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-4 cursor-default',
              'border border-dashed border-[#C7C7CC] bg-transparent',
              'text-sm font-medium text-[#8E8E93] rounded-2xl'
            )}
          >
            <Icon name={IconName.Add} className="w-4 h-4" fill="currentColor" />
            <span>{t('addAccountComingSoon')}</span>
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default AccountsDrawer;
