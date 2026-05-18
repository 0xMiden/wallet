import React from 'react';

import { Trans, useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Drawer, DrawerContent } from 'lib/ui/drawer';

export interface GuardianInfoDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ShieldHero: React.FC = () => (
  <div className="w-20 h-20 rounded-2xl bg-[#0B4B33] flex items-center justify-center">
    <svg width="32" height="36" viewBox="0 0 32 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M16 1 L29 6 V18 C29 26 23 32 16 35 C9 32 3 26 3 18 V6 Z"
        fill="#FFFFFF"
      />
    </svg>
  </div>
);

interface InfoRowProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const InfoRow: React.FC<InfoRowProps> = ({ icon, title, description }) => (
  <div className="flex flex-col p-4 rounded-xl bg-surface-interactive">
    <div className="flex items-center gap-3">
      {icon}
      <h3 className="text-base font-semibold text-heading-gray">{title}</h3>
    </div>
    <p className="mt-2 text-sm text-text-tertiary-token leading-[140%]">{description}</p>
  </div>
);

const IconBadge: React.FC<{ bg: string; children: React.ReactNode }> = ({ bg, children }) => (
  <div className={`w-7 h-7 rounded-md flex items-center justify-center ${bg}`}>{children}</div>
);

export const GuardianInfoDrawer: React.FC<GuardianInfoDrawerProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[90vh]">
        <div className="flex flex-col overflow-y-auto px-6 pb-4">
          <div className="flex items-start justify-between">
            <h2 className="text-3xl font-semibold font-heading text-heading-gray leading-tight tracking-tight">
              {t('whatIsAGuardian')}
            </h2>
            <button
              type="button"
              aria-label={t('close')}
              onClick={() => onOpenChange(false)}
              className="shrink-0 w-9 h-9 rounded-full bg-surface-interactive flex items-center justify-center"
            >
              <Icon name={IconName.Close} size="sm" className="text-heading-gray" />
            </button>
          </div>

          <div className="flex justify-center mt-6">
            <ShieldHero />
          </div>

          <p className="mt-6 text-base text-heading-gray leading-[140%]">
            <Trans
              i18nKey="guardianInfoDescription"
              components={{ b: <span className="font-semibold" /> }}
            />
          </p>

          <div className="mt-6 flex flex-col gap-3">
            <InfoRow
              icon={
                <IconBadge bg="bg-status-positive">
                  <Icon name={IconName.Checkmark} size="xs" className="text-pure-white" />
                </IconBadge>
              }
              title={t('guardianInfoWhatItDoesTitle')}
              description={t('guardianInfoWhatItDoesDescription')}
            />
            <InfoRow
              icon={
                <IconBadge bg="bg-primary-500">
                  <Icon name={IconName.Close} size="xs" className="text-pure-white" />
                </IconBadge>
              }
              title={t('guardianInfoWhatItCannotDoTitle')}
              description={t('guardianInfoWhatItCannotDoDescription')}
            />
            <InfoRow
              icon={
                <IconBadge bg="bg-primary-500">
                  <Icon name={IconName.Information} size="xs" className="text-pure-white" />
                </IconBadge>
              }
              title={t('guardianInfoSwitchingIsEasyTitle')}
              description={t('guardianInfoSwitchingIsEasyDescription')}
            />
          </div>

          <div className="mt-6 flex justify-center">
            <Button title={t('gotIt')} onClick={() => onOpenChange(false)} />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default GuardianInfoDrawer;
