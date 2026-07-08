import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { setCardColor, useCardColor } from 'lib/settings/card-color';
import { CARD_COLORS, CardColor } from 'lib/settings/constants';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { navigate } from 'lib/woozie';

import { CARD_COLOR_BG } from './BalanceCard';

export interface AccountsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Bottom sheet opened from the BalanceCard "more" (3-dots) button. Lists
 * the balance-card color picker and account-level actions: Settings
 * (navigates to /settings) and a disabled "Add Account" placeholder.
 */
export const AccountsDrawer: FC<AccountsDrawerProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const selectedCardColor = useCardColor();

  const handleSettings = () => {
    hapticLight();
    onOpenChange(false);
    navigate('/settings');
  };

  const handleCardColorSelect = (color: CardColor) => {
    if (color === selectedCardColor) return;
    hapticLight();
    setCardColor(color);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('accounts')}</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-col gap-4 px-4 pb-6">
          <div className="flex flex-col gap-2">
            <span className="text-base font-bold font-heading uppercase  text-grey-400">{t('cardColor')}</span>
            <div className="flex items-center justify-between">
              {CARD_COLORS.map(color => {
                const isSelected = color === selectedCardColor;
                return (
                  <button
                    key={color}
                    type="button"
                    aria-label={color}
                    aria-pressed={isSelected}
                    onClick={() => handleCardColorSelect(color)}
                    className={classNames(
                      'flex h-10 w-10 items-center justify-center rounded-full',
                      'transition-transform active:scale-95',
                      CARD_COLOR_BG[color]
                    )}
                  >
                    {isSelected && (
                      <Icon name={IconName.Checkmark} className="w-5 h-5 text-pure-white" fill="currentColor" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            onClick={handleSettings}
            className={classNames(
              'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-4',
              'bg-surface-input',
              'text-sm font-semibold text-gray-secondary',
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
              'text-sm font-medium text-gray-secondary rounded-2xl'
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
