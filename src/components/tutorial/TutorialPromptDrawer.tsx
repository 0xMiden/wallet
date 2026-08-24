import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface TutorialPromptDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: () => void;
}

/**
 * Post-onboarding "would you like a tour?" prompt. Presentational only — the
 * parent owns the pending flag and treats every dismissal (Skip, swipe-down,
 * outside tap) as a skip, so the prompt shows at most once.
 */
export const TutorialPromptDrawer: React.FC<TutorialPromptDrawerProps> = ({ open, onOpenChange, onStart }) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="tutorial-prompt">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('tutorialPromptTitle')}</DrawerTitle>
          <DrawerDescription>{t('tutorialPromptBody')}</DrawerDescription>
        </DrawerHeader>
        <DrawerFooter>
          <Button title={t('tutorialPromptStart')} onClick={onStart} />
          <Button variant={ButtonVariant.Secondary} title={t('skip')} onClick={() => onOpenChange(false)} />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
};

export default TutorialPromptDrawer;
