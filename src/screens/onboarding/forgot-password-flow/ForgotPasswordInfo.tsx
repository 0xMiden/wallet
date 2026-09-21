import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Hero } from 'components/ui/Hero';
import { SubPageLayout } from 'components/ui/SubPageLayout';

interface ForgotPasswordInfoScreenProps {
  onClose: () => void;
  onSignOut: () => void;
}

/**
 * Why a forgotten password means signing out and restoring. A page dismissed with ✕ back to unlock:
 * the header names it, the lock stands alone as its hero, and the two paragraphs explain.
 */
const ForgotPasswordInfoScreen: FC<ForgotPasswordInfoScreenProps> = ({ onClose, onSignOut }) => {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex h-full w-full max-w-[600px] flex-col bg-app-bg" data-testid="forgot-password-info">
      <SubPageLayout
        title={t('forgotPassword')}
        onClose={onClose}
        footer={<Button data-testid="sign-out-button" title={t('signOut')} onClick={onSignOut} />}
      >
        <div className="my-auto flex flex-col items-center gap-3 py-6 text-center">
          <Hero
            visual={
              <span className="flex size-16 items-center justify-center rounded-full bg-fill text-ink">
                <Icon name={IconName.Lock} size="lg" fill="currentColor" aria-hidden="true" />
              </span>
            }
          />
          <p className="font-sans text-base leading-6 text-ink">{t('forgotPasswordDescription')}</p>
          <p className="font-sans text-[15px] leading-[22px] text-muted">{t('forgotPasswordSecondDescription')}</p>
        </div>
      </SubPageLayout>
    </div>
  );
};

export default ForgotPasswordInfoScreen;
