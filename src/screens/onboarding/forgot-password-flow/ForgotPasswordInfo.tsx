import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Message } from 'components/Message';
import { NavigationHeader } from 'components/NavigationHeader';

interface ForgotPasswordInfoScreenProps {
  onClose: () => void;
  onSignOut: () => void;
}

const ForgotPasswordInfoScreen: FC<ForgotPasswordInfoScreenProps> = ({ onClose, onSignOut }) => {
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
      <NavigationHeader mode="close" title={t('forgotPassword')} onClose={onClose} />
      <div className="flex flex-col flex-1 p-4 justify-between md:w-[460px] md:mx-auto">
        <div className="flex flex-col grow items-center justify-center">
          <Message
            className="flex-1"
            title={t('forgotPassword')}
            description={t('forgotPasswordDescription')}
            secondDescription={t('forgotPasswordSecondDescription')}
            icon={IconName.Lock}
            descriptionClasses="text-sm"
          />
        </div>
        <div className="flex flex-col">
          <Button className="mx-4 mt-4 mb-2" title={t('signOut')} variant={ButtonVariant.Primary} onClick={onSignOut} />
        </div>
      </div>
    </div>
  );
};

export default ForgotPasswordInfoScreen;
