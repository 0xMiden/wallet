import React from 'react';

import { Trans, useTranslation } from 'react-i18next';

import { ReactComponent as WhatIsGuardianHero } from 'app/icons/onboarding/what-is-guardian-hero.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Drawer, DrawerContent, DrawerTitle } from 'lib/ui/drawer';

export interface GuardianInfoDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface InfoRowProps {
  badge: React.ReactNode;
  title: string;
  description: string;
  hasDivider?: boolean;
}

const InfoRow: React.FC<InfoRowProps> = ({ badge, title, description, hasDivider = true }) => (
  <div className={hasDivider ? 'border-b border-[#E9E9E9]' : undefined}>
    <div className="mx-auto flex max-w-[32rem] flex-col items-center px-4 py-4 text-center">
      <div className="flex max-w-full items-center justify-center gap-3">
        {badge}
        <h3 className="min-w-0 break-words text-left font-heading text-[18px] font-semibold leading-[1.2] text-[#151515] dark:text-heading-gray">
          {title}
        </h3>
      </div>
      <p className="mt-2.5 break-words text-[15px] font-normal leading-[1.32] text-[#8E8E93]">{description}</p>
    </div>
  </div>
);

const IconBadge: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${className}`}>{children}</div>
);

export const GuardianInfoDrawer: React.FC<GuardianInfoDrawerProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="max-h-[78vh] overflow-hidden rounded-t-[28px] border-t-[6px] border-primary-500 bg-surface-solid"
        overlayClassName="bg-transparent backdrop-blur-0 dark:bg-transparent"
      >
        <div className="flex flex-col overflow-y-auto px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4">
          <DrawerTitle className="text-center font-heading text-[28px] font-semibold leading-[1.1] text-heading-gray">
            {t('whatIsAGuardian')}
          </DrawerTitle>

          <WhatIsGuardianHero className="mx-auto mt-2 h-[111px] w-[125px] shrink-0" />

          <p className="mx-auto mt-3 max-w-[34rem] text-center text-[18px] font-normal leading-[1.28] text-heading-gray">
            <Trans i18nKey="guardianInfoDescription" components={{ b: <span className="font-semibold" /> }} />
          </p>

          <div className="mt-5 h-1.5 w-full shrink-0 rounded-full bg-primary-500" />

          <div className="mt-3 flex flex-col">
            <InfoRow
              badge={
                <IconBadge className="bg-[#7D936D]">
                  <Icon name={IconName.Checkmark} size="xs" fill="currentColor" className="text-pure-white" />
                </IconBadge>
              }
              title={t('guardianInfoWhatItDoesTitle')}
              description={t('guardianInfoWhatItDoesDescription')}
            />
            <InfoRow
              badge={
                <IconBadge className="bg-primary-500">
                  <span className="font-heading text-[17px] font-bold leading-none text-pure-white">!</span>
                </IconBadge>
              }
              title={t('guardianInfoSwitchingIsEasyTitle')}
              description={t('guardianInfoSwitchingIsEasyDescription')}
            />
            <InfoRow
              badge={
                <IconBadge className="bg-[#C96060]">
                  <Icon name={IconName.Close} size="xs" fill="currentColor" className="text-pure-white" />
                </IconBadge>
              }
              title={t('guardianInfoWhatItCannotDoTitle')}
              description={t('guardianInfoWhatItCannotDoDescription')}
              hasDivider={false}
            />
          </div>

          <div className="mt-4 flex justify-center">
            <Button title={t('gotIt')} onClick={() => onOpenChange(false)} />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default GuardianInfoDrawer;
