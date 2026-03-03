import React, { useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ArrowRightIcon } from 'app/icons/arrow-right.svg';

import { ImportType } from '../types';

export interface SelectImportTypeScreenProps extends Omit<React.ButtonHTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  onSubmit?: (payload: ImportType) => void;
}

type ImportTypeOption = {
  id: ImportType;
  title: string;
  description: string;
  isLast?: boolean;
};

export const SelectImportTypeScreen = ({ onSubmit, ...props }: SelectImportTypeScreenProps) => {
  const { t } = useTranslation();

  const ImportTypeOptions: ImportTypeOption[] = useMemo(
    () => [
      {
        id: ImportType.SeedPhrase,
        title: t('importWithSeedPhrase'),
        description: t('importWithSeedPhraseDescription')
      },
      {
        id: ImportType.WalletFile,
        title: t('importWithEncryptedWalletFile'),
        description: t('importWithEncryptedWalletFileDescription'),
        isLast: true
      }
    ],
    [t]
  );

  return (
    <div className="flex-1 flex flex-col items-center bg-transparent p-8 h-full" data-testid="import-select-type">
      <div className="flex flex-col items-center w-4/5 pb-8">
        <h1 className="font-semibold text-2xl lh-title">{t('chooseImportType')}</h1>
        <p className="text-base text-center lh-title">{t('chooseImportTypeDescription')}</p>
      </div>
      {ImportTypeOptions.map(option => (
        <div
          key={option.id}
          className={classNames(
            'flex flex-col border w-3/5 p-4 rounded-lg cursor-pointer',
            { 'mb-2': !option.isLast },
            { 'mb-8': option.isLast }
          )}
          onClick={() => onSubmit?.(option.id)}
        >
          <div className="flex flex-row justify-between items-center">
            <h2 className="font-medium text-base">{option.title}</h2>
            <ArrowRightIcon fill="currentColor" height={'20px'} width={'20px'} />
          </div>
          <p className="text-grey-600">{option.description}</p>
        </div>
      ))}
    </div>
  );
};
