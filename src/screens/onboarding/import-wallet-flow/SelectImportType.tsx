import React, { useMemo } from 'react';

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

export const SelectImportTypeScreen = ({ onSubmit }: SelectImportTypeScreenProps) => {
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
    <div
      className="flex-1 flex flex-col items-center bg-transparent px-4 pt-6 overflow-y-auto"
      data-testid="import-select-type"
    >
      <div className="flex flex-col items-center pb-6">
        <h1 className="font-semibold text-2xl leading-tight">{t('chooseImportType')}</h1>
        <p className="text-sm text-center leading-snug mt-2 text-grey-600">{t('chooseImportTypeDescription')}</p>
      </div>
      <div className="flex flex-col gap-3 w-full pb-4">
        {ImportTypeOptions.map(option => (
          <div
            key={option.id}
            className="flex flex-col border border-grey-200 w-full p-4 rounded-xl cursor-pointer hover:bg-grey-50 transition-colors"
            onClick={() => onSubmit?.(option.id)}
          >
            <div className="flex flex-row justify-between items-center">
              <h2 className="font-medium text-sm">{option.title}</h2>
              <ArrowRightIcon fill="currentColor" height={'16px'} width={'16px'} className="flex-shrink-0 ml-2" />
            </div>
            <p className="text-xs text-grey-600 mt-1">{option.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
