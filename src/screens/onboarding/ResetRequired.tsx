import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Message } from 'components/Message';
import { NavigationHeader } from 'components/NavigationHeader';

interface ResetRequiredScreenProps {
  onConfirm: () => void;
}

const ForgotPasswordInfoScreen: FC<ResetRequiredScreenProps> = ({ onConfirm }) => {
  const { t } = useTranslation();

  return (
    <div
      className={classNames(
        'w-[22.5rem] h-[37.5rem] md:w-[37.5rem] md:h-[46.875rem]',
        'border border-gray-100',
        'mx-auto md:rounded-3xl',
        'flex flex-1 flex-col bg-app-bg',
        'overflow-hidden relative'
      )}
    >
      <NavigationHeader title={t('resetRequired')} />
      <div className="flex flex-col flex-1 p-4 justify-between md:w-[460px] md:mx-auto">
        <div className="flex flex-col grow items-center justify-center">
          <Message
            className="flex-1"
            title={t('resetRequired')}
            description={t('resetRequiredDescription')}
            icon={IconName.MidenLogo}
            iconClassName="w-[218px] h-[218px]"
            secondDescription={t('resetRequiredSecondDescription')}
          />
        </div>
        <div className="flex flex-col">
          <Button className="mx-4 mt-4 mb-2" title={t('reset')} variant={ButtonVariant.Primary} onClick={onConfirm} />
        </div>
      </div>
    </div>
  );
};

export default ForgotPasswordInfoScreen;
