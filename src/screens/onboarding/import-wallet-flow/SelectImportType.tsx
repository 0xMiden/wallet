import React, { useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';

import { OnboardingStepLayout } from '../common/OnboardingStepLayout';
import { ImportType } from '../types';

export interface SelectImportTypeScreenProps {
  onSubmit?: (payload: ImportType) => void;
}

type ImportTypeOption = {
  id: ImportType;
  icon: IconName;
  title: string;
  description: string;
};

/**
 * Where to restore from. Each choice goes straight to its step, so the choices are navigating rows
 * (a chevron, no selection to hold) in one group, not radio cards.
 */
export const SelectImportTypeScreen = ({ onSubmit }: SelectImportTypeScreenProps) => {
  const { t } = useTranslation();

  const importTypeOptions: ImportTypeOption[] = useMemo(
    () => [
      {
        id: ImportType.SeedPhrase,
        icon: IconName.Key,
        title: t('importWithSeedPhrase'),
        description: t('importWithSeedPhraseDescription')
      },
      {
        id: ImportType.WalletFile,
        icon: IconName.File,
        title: t('importWithEncryptedWalletFile'),
        description: t('importWithEncryptedWalletFileDescription')
      }
    ],
    [t]
  );

  return (
    <OnboardingStepLayout
      data-testid="import-select-type"
      title={t('chooseImportType')}
      description={t('chooseImportTypeDescription')}
    >
      <ListGroup>
        {importTypeOptions.map(option => (
          <ListRow
            key={option.id}
            // The E2E harness drives this step; matching on translated titles
            // would tie the suite to copy in whichever locale the build carries.
            data-testid={`import-type-${option.id}`}
            icon={<Icon name={option.icon} size="sm" fill="currentColor" />}
            title={option.title}
            subtitle={option.description}
            chevron
            onClick={() => onSubmit?.(option.id)}
          />
        ))}
      </ListGroup>
    </OnboardingStepLayout>
  );
};
