import React from 'react';

import { Trans, useTranslation } from 'react-i18next';

import { ReactComponent as WhatIsGuardianHero } from 'app/icons/onboarding/what-is-guardian-hero.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { FactRow, IconCircle } from 'components/ui/FactRow';
import { ListGroup } from 'components/ui/ListGroup';
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

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
      <DrawerContent className="max-h-[calc(100dvh-env(safe-area-inset-top)-1.5rem)] pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <DrawerHeader>
          <DrawerTitle>{t('whatIsAGuardian')}</DrawerTitle>
        </DrawerHeader>

        {/* Every line of the sheet is Nunito: the body styles that read `--font-sans` resolve to the
            heading face here, the explainer's bold phrase included. */}
        <div className="no-scrollbar flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-4 face-heading">
          <WhatIsGuardianHero className="mx-auto h-[111px] w-[125px] shrink-0" />

          <p className="text-body font-semibold text-ink">
            <Trans
              i18nKey="guardianInfoDescription"
              components={{ b: <span className="text-body-strong font-extrabold" /> }}
            />
          </p>

          <ListGroup surface="plain" insetHairlines className="-mt-4 shrink-0">
            <FactRow
              titleAs="h3"
              leading={
                <IconCircle className="bg-positive-tint-ink text-positive-tint">
                  <Icon name={IconName.FactCheck} size="xs" fill="currentColor" />
                </IconCircle>
              }
              title={<span className="font-extrabold">{t('guardianInfoWhatItDoesTitle')}</span>}
              description={t('guardianInfoWhatItDoesDescription')}
            />
            <FactRow
              titleAs="h3"
              leading={
                <IconCircle className="bg-accent-tint-ink text-accent-tint">
                  <Icon name={IconName.FactAlert} size="xs" fill="currentColor" />
                </IconCircle>
              }
              title={<span className="font-extrabold">{t('guardianInfoSwitchingIsEasyTitle')}</span>}
              description={t('guardianInfoSwitchingIsEasyDescription')}
            />
            <FactRow
              titleAs="h3"
              leading={
                <IconCircle className="bg-negative-tint-ink text-negative-tint">
                  <Icon name={IconName.FactCross} size="xs" fill="currentColor" />
                </IconCircle>
              }
              title={<span className="font-extrabold">{t('guardianInfoWhatItCannotDoTitle')}</span>}
              description={t('guardianInfoWhatItCannotDoDescription')}
            />
          </ListGroup>
        </div>

        {/* Pinned outside the scrolling body, as NetworkModeSheet does: at the sheet's height cap the
            button used to scroll with the facts and sit half cut off at the bottom edge. */}
        <DrawerFooter className="shrink-0">
          <Button title={t('gotIt')} className="w-full max-w-none" onClick={() => onOpenChange(false)} />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
};

export default GuardianInfoDrawer;
