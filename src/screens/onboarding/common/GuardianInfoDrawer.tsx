import React from 'react';

import { Trans, useTranslation } from 'react-i18next';

import { ReactComponent as WhatIsGuardianHero } from 'app/icons/onboarding/what-is-guardian-hero.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface GuardianInfoDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface InfoRowProps {
  badge: React.ReactNode;
  title: string;
  description: string;
}

/**
 * One fact in the explainer: the badge leading, the title and the `muted` description stacked beside
 * it, a hairline above every fact but the first starting after the badge (the testnet notice's row).
 * `ListRow` is not used here because the description wraps to several lines.
 */
const InfoRow: React.FC<InfoRowProps> = ({ badge, title, description }) => (
  <div className="relative flex items-start gap-3 py-3.5 before:absolute before:top-0 before:right-0 before:left-11 before:h-px before:bg-hairline first:before:hidden">
    {badge}
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 className="min-w-0 break-words text-row-title text-ink">{title}</h3>
      <p className="break-words text-caption-heading text-muted">{description}</p>
    </div>
  </div>
);

const IconBadge: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <div aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${className}`}>
    {children}
  </div>
);

/**
 * The "what is a guardian" explainer sheet. It carries the app's one sheet header (title left,
 * close right) and states the three facts as plain rows on the sheet, hairlines between them, the
 * way the testnet notice and the guardian step draw theirs — no group fill, no literal colours.
 */
export const GuardianInfoDrawer: React.FC<GuardianInfoDrawerProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="guardian-info">
      <DrawerContent className="max-h-[78vh]">
        <DrawerHeader>
          <DrawerTitle>{t('whatIsAGuardian')}</DrawerTitle>
        </DrawerHeader>

        <div className="no-scrollbar flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-4">
          <WhatIsGuardianHero className="mx-auto h-[111px] w-[125px] shrink-0" />

          <p className="text-body text-ink">
            <Trans i18nKey="guardianInfoDescription" components={{ b: <span className="text-body-strong" /> }} />
          </p>

          <div className="flex flex-col" data-testid="guardian-info-facts">
            <InfoRow
              badge={
                <IconBadge className="bg-positive-tint text-positive-tint-ink">
                  <Icon name={IconName.Checkmark} size="xs" fill="currentColor" />
                </IconBadge>
              }
              title={t('guardianInfoWhatItDoesTitle')}
              description={t('guardianInfoWhatItDoesDescription')}
            />
            <InfoRow
              badge={
                <IconBadge className="bg-accent-tint text-accent-tint-ink">
                  <span className="text-row-title">!</span>
                </IconBadge>
              }
              title={t('guardianInfoSwitchingIsEasyTitle')}
              description={t('guardianInfoSwitchingIsEasyDescription')}
            />
            <InfoRow
              badge={
                <IconBadge className="bg-negative-tint text-negative-tint-ink">
                  <Icon name={IconName.Close} size="xs" fill="currentColor" />
                </IconBadge>
              }
              title={t('guardianInfoWhatItCannotDoTitle')}
              description={t('guardianInfoWhatItCannotDoDescription')}
            />
          </div>

          <div className="flex justify-center">
            <Button title={t('gotIt')} onClick={() => onOpenChange(false)} />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default GuardianInfoDrawer;
