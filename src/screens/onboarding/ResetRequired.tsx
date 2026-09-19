import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Hero } from 'components/ui/Hero';
import { SubPageLayout } from 'components/ui/SubPageLayout';

interface ResetRequiredScreenProps {
  onConfirm: () => void;
}

/**
 * The wallet must be reset before it can be used again. No way back: the header names the page, the
 * Miden mark stands alone as its hero, and Reset is the one action.
 */
const ResetRequiredScreen: FC<ResetRequiredScreenProps> = ({ onConfirm }) => {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex h-full w-full max-w-[600px] flex-col bg-app-bg" data-testid="reset-required">
      <SubPageLayout
        title={t('resetRequired')}
        footer={<Button className="max-w-none" data-testid="reset-button" title={t('reset')} onClick={onConfirm} />}
      >
        <div className="my-auto flex flex-col items-center gap-3 py-6 text-center">
          <Hero
            visual={
              <span className="flex size-22 items-center justify-center rounded-full bg-fill">
                <Icon name={IconName.MidenLogo} className="size-12" aria-hidden="true" />
              </span>
            }
          />
          <p className="font-sans text-base leading-6 text-ink">{t('resetRequiredDescription')}</p>
          <p className="font-sans text-[15px] leading-[22px] text-muted">{t('resetRequiredSecondDescription')}</p>
        </div>
      </SubPageLayout>
    </div>
  );
};

export default ResetRequiredScreen;
