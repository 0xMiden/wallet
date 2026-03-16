import React, { useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ArrowRightIcon } from 'app/icons/arrow-right.svg';

import { WalletType } from '../types';

export interface SelectRecoveryMethodScreenProps extends Omit<React.ButtonHTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  onSubmit?: (payload: WalletType) => void;
}

type RecoveryOption = {
  id: WalletType;
  title: string;
  description: string;
  isDefault?: boolean;
  isLast?: boolean;
};

export const SelectRecoveryMethodScreen = ({ onSubmit, ...props }: SelectRecoveryMethodScreenProps) => {
  const { t } = useTranslation();
  const options: RecoveryOption[] = useMemo(
    () => [
      {
        id: WalletType.Psm,
        title: t('guardianRecovery'),
        description: t('guardianRecoveryDescription'),
        isDefault: true
      },
      {
        id: WalletType.OffChain,
        title: t('fullyPrivateRecovery'),
        description: t('fullyPrivateRecoveryDescription'),
        isLast: true
      }
    ],
    [t]
  );

  return (
    <div className="flex-1 flex flex-col items-center bg-transparent pt-6 h-full" {...props}>
      <div className="flex flex-col items-center">
        <h1 className="font-semibold text-2xl lh-title">{t('chooseRecoveryMethod')}</h1>
        <p className="text-base text-center lh-title">{t('chooseRecoveryMethodDescription')}</p>
      </div>
      {options.map(option => (
        <div
          key={option.id}
          className={classNames('flex flex-col border p-4 rounded-lg cursor-pointer', {
            'mb-2': !option.isLast,
            'mb-8': option.isLast
          })}
          onClick={() => onSubmit?.(option.id)}
        >
          <div className="flex flex-row justify-between items-center">
            <div className="flex items-center gap-2">
              <h2 className="font-medium text-base">{option.title}</h2>
              {option.isDefault && (
                <span className="bg-pure-black text-pure-white text-xs font-medium px-2 py-0.5 rounded-full">
                  {t('default')}
                </span>
              )}
            </div>
            <ArrowRightIcon fill="currentColor" height={'20px'} width={'20px'} />
          </div>
          <p className="text-grey-600">{option.description}</p>
        </div>
      ))}
    </div>
  );
};
