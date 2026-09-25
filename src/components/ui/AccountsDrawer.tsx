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
import { HeaderRule } from './HeaderRule';
import { ListGroup } from './ListGroup';
import { ListRow } from './ListRow';
import { SectionHeader } from './SectionHeader';

export interface AccountsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Bottom sheet opened from the BalanceCard settings button. Lists
 * the balance-card color picker and account-level actions: Settings
 * (navigates to /settings) and private-key account import.
 */
export const AccountsDrawer: FC<AccountsDrawerProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const selectedCardColor = useCardColor();

  // `ListRow` fires the tap haptic itself, so the handlers only close and navigate.
  const handleSettings = () => {
    onOpenChange(false);
    navigate('/settings');
  };

  const handleImportAccount = () => {
    onOpenChange(false);
    navigate('/import-account');
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
        {/* The tab roots' rule under the title, inset to the sheet's margin. */}
        <HeaderRule className="mx-4 mb-4" />

        <div className="flex flex-col gap-5 px-4 pb-6">
          <section>
            <SectionHeader>{t('cardColor')}</SectionHeader>
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
          </section>

          {/* The two account actions as one grouped list, like Settings' own rows: both navigate,
              so both carry the chevron. */}
          <ListGroup>
            <ListRow
              title={t('settings')}
              icon={<Icon name={IconName.SettingsNew} fill="currentColor" />}
              chevron
              onClick={handleSettings}
            />
            <ListRow
              title={t('importAccount')}
              icon={<Icon name={IconName.Add} fill="currentColor" />}
              chevron
              onClick={handleImportAccount}
            />
          </ListGroup>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default AccountsDrawer;
