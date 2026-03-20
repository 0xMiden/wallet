import React, { useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { Badge } from 'lib/ui/badge';

import { WalletType } from '../types';

export type RecoveryOption = {
  id: WalletType;
  title: string;
  description: string;
  isDefault?: boolean;
  isLast?: boolean;
};

export interface SelectRecoveryMethodScreenProps extends Omit<React.ButtonHTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  onSubmit?: (payload: WalletType) => void;
  options?: RecoveryOption[];
}

export const SelectRecoveryMethodScreen = ({
  onSubmit,
  options: optionsProp,
  ...props
}: SelectRecoveryMethodScreenProps) => {
  const { t } = useTranslation();
  const defaultOptions: RecoveryOption[] = useMemo(
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
  const options = optionsProp || defaultOptions;
  const [selected, setSelected] = React.useState<WalletType>(options.find(o => o.isDefault)?.id || options[0].id);

  const handleContinue = () => {
    onSubmit?.(selected);
  };

  return (
    <div
      className="flex-1 flex flex-col items-center bg-transparent pt-6 h-full px-4 text-heading-gray gap-6"
      {...props}
    >
      <div className="flex flex-col items-center gap-2">
        <h1 className="font-semibold text-2xl lh-title">{t('chooseRecoveryMethod')}</h1>
        <p className="text-xs text-center lh-title px-4">{t('chooseRecoveryMethodDescription')}</p>
      </div>
      <div className="flex flex-col">
        {options.map(option => (
          <div
            key={option.id}
            className={classNames('flex flex-col p-4 rounded-lg cursor-pointer bg-white', {
              'mb-2': !option.isLast,
              'mb-8': option.isLast,
              'opacity-50': selected !== option.id
            })}
            onClick={() => setSelected(option.id)}
          >
            <div className="flex flex-row justify-between items-center">
              <div className="flex items-center gap-2">
                <h2 className="font-medium text-base">{option.title}</h2>
                {option.isDefault && (
                  <Badge variant={'default'} className="bg-primary-500 text-white">
                    {t('default')}
                  </Badge>
                )}
              </div>
            </div>
            <p className="text-grey-600">{option.description}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2 self-center w-full mt-auto">
        <Button title={t('continue')} onClick={handleContinue} className="text-base" />
      </div>
    </div>
  );
};
