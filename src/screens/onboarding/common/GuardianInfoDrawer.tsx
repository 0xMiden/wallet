import React from 'react';

import { Trans, useTranslation } from 'react-i18next';

import { ReactComponent as WhatIsGuardianHero } from 'app/icons/onboarding/what-is-guardian-hero.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { FactRow, IconCircle } from 'components/ui/FactRow';
import { ListGroup } from 'components/ui/ListGroup';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface GuardianInfoDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

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

          <ListGroup surface="plain" insetHairlines className="shrink-0">
            <FactRow
              titleAs="h3"
              leading={
                <IconCircle className="bg-positive-tint text-positive-tint-ink">
                  <Icon name={IconName.Checkmark} size="xs" fill="currentColor" />
                </IconCircle>
              }
              title={t('guardianInfoWhatItDoesTitle')}
              description={t('guardianInfoWhatItDoesDescription')}
            />
            <FactRow
              titleAs="h3"
              leading={
                <IconCircle className="bg-accent-tint text-accent-tint-ink">
                  <span className="text-row-title">!</span>
                </IconCircle>
              }
              title={t('guardianInfoSwitchingIsEasyTitle')}
              description={t('guardianInfoSwitchingIsEasyDescription')}
            />
            <FactRow
              titleAs="h3"
              leading={
                <IconCircle className="bg-negative-tint text-negative-tint-ink">
                  <Icon name={IconName.Close} size="xs" fill="currentColor" />
                </IconCircle>
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
