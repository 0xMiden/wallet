import React, { useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as ArrowRightIcon } from 'app/icons/arrow-right.svg';
import { CardButton } from 'components/ui/Card';

import { ImportType } from '../types';

export interface SelectImportTypeScreenProps {
  onSubmit?: (payload: ImportType) => void;
}

type ImportTypeOption = {
  id: ImportType;
  title: string;
  description: string;
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
        description: t('importWithEncryptedWalletFileDescription')
      }
    ],
    [t]
  );

  return (
    <div
      className="flex-1 flex flex-col items-center bg-transparent text-ink px-4 pt-6 overflow-y-auto"
      data-testid="import-select-type"
    >
      <div className="flex flex-col items-center pb-6">
        <h1 className="font-semibold text-2xl leading-tight">{t('chooseImportType')}</h1>
        <p className="text-sm text-center leading-snug mt-2 text-text-muted">{t('chooseImportTypeDescription')}</p>
      </div>
      <div className="flex flex-col gap-3 w-full pb-4">
        {ImportTypeOptions.map(option => (
          <CardButton
            padding="tile"
            key={option.id}
            // The E2E harness drives this step; matching on translated titles
            // would tie the suite to copy in whichever locale the build carries.
            data-testid={`import-type-${option.id}`}
            className="flex w-full flex-col"
            onClick={() => onSubmit?.(option.id)}
          >
            <div className="flex flex-row justify-between items-center">
              <h2 className="font-medium text-sm">{option.title}</h2>
              <ArrowRightIcon fill="currentColor" height={'16px'} width={'16px'} className="flex-shrink-0 ml-2" />
            </div>
            <p className="text-xs text-text-muted mt-1">{option.description}</p>
          </CardButton>
        ))}
      </div>
    </div>
  );
};
