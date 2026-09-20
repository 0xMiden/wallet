import React from 'react';

import { Trans, useTranslation } from 'react-i18next';

import { ReactComponent as WhatIsGuardianHero } from 'app/icons/onboarding/what-is-guardian-hero.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { ListGroup } from 'components/ui/ListGroup';
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
 * One fact in the explainer's group: the badge leading, the title beside it and the `muted`
 * description under both. `ListRow` is not used here because the description wraps to several
 * lines under the badge rather than sitting on a fixed 64px row.
 */
const InfoRow: React.FC<InfoRowProps> = ({ badge, title, description }) => (
  <div className="relative flex flex-col gap-1.5 px-4 py-3.5 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-hairline first:before:hidden">
    <div className="flex min-w-0 items-center gap-3">
      {badge}
      <h3 className="min-w-0 break-words text-row-title text-ink">{title}</h3>
    </div>
    <p className="break-words text-caption text-muted">{description}</p>
  </div>
);

const IconBadge: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <div aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${className}`}>
    {children}
  </div>
);

/**
 * The "what is a guardian" explainer sheet. It carries the app's one sheet header (title left,
 * close right) and states the three facts in a single `fill` group with inset hairlines, the way
 * every other list in the wallet is drawn — no rules across the sheet, no literal colours.
 */
export const GuardianInfoDrawer: React.FC<GuardianInfoDrawerProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="guardian-info">
      <DrawerContent
        className="max-h-[78vh] overflow-hidden"
        overlayClassName="bg-transparent backdrop-blur-0 dark:bg-transparent"
      >
        <DrawerHeader>
          <DrawerTitle>{t('whatIsAGuardian')}</DrawerTitle>
        </DrawerHeader>

        <div className="no-scrollbar flex flex-col gap-5 overflow-y-auto px-4 pb-4">
          <WhatIsGuardianHero className="mx-auto h-[111px] w-[125px] shrink-0" />

          <p className="text-body text-ink">
            <Trans i18nKey="guardianInfoDescription" components={{ b: <span className="text-body-strong" /> }} />
          </p>

          <ListGroup>
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
          </ListGroup>

          <div className="flex justify-center">
            <Button title={t('gotIt')} onClick={() => onOpenChange(false)} />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default GuardianInfoDrawer;
