import React, { FC, useCallback } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { Button, ButtonVariant } from 'components/Button';
import { useNativeNavbarAction } from 'lib/dapp-browser';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';

type ImportNoteResultProps = {
  success: boolean;
};

const ImportNoteResult: FC<ImportNoteResultProps> = ({ success }) => {
  const { t } = useTranslation();
  const onDone = useCallback(() => navigate('/receive'), []);

  useNativeNavbarAction({
    label: success ? t('done') : t('close'),
    onTap: onDone,
    enabled: true
  });

  return (
    <PageLayout pageTitle={t('transactionFile')} showBottomBorder={false} hasBackAction={false}>
      <div className="flex m-auto">
        <div className="flex-1 flex flex-col justify-center items-center md:w-[460px] md:mx-auto">
          <div className="w-40 aspect-square flex items-center justify-center mb-8">
            {success && <Icon name={IconName.Success} size="3xl" />}
            {!success && <Icon name={IconName.Failed} size="3xl" />}
          </div>
          <h1 className="flex flex-col font-semibold text-2xl lh-title text-center text-balance pb-4">
            {success && <>{t('availableToClaim')}</>}
            {!success && <>{t('verificationFailed')}</>}
          </h1>
          <p className="text-sm text-center px-4">
            {success && <>{t('transactionVerifiedSuccessfully')}</>}
            {!success && <>{t('transactionFileCouldNotBeVerified')}</>}
          </p>
        </div>
      </div>
      {!isMobile() && (
        <div className="px-6 pb-6">
          <Button
            className="w-full"
            variant={ButtonVariant.Secondary}
            onClick={onDone}
            title={success ? t('done') : t('close')}
            style={{ cursor: 'pointer' }}
          />
        </div>
      )}
    </PageLayout>
  );
};

export default ImportNoteResult;
