import React, { useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { ChoiceCardGroup, ChoiceCardItem } from 'components/ui/ChoiceCard';
import { Pill } from 'components/ui/Pill';

import { OnboardingStepLayout } from '../common/OnboardingStepLayout';
import { WalletType } from '../types';

export type RecoveryOption = {
  id: WalletType;
  title: string;
  description: string;
  isDefault?: boolean;
};

export interface SelectRecoveryMethodScreenProps {
  onSubmit?: (payload: WalletType) => void;
  options?: RecoveryOption[];
  'data-testid'?: string;
}

export const SelectRecoveryMethodScreen = ({
  onSubmit,
  options: optionsProp,
  'data-testid': dataTestId
}: SelectRecoveryMethodScreenProps) => {
  const { t } = useTranslation();
  const defaultOptions: RecoveryOption[] = useMemo(
    () => [
      {
        id: WalletType.Guardian,
        title: t('guardianRecovery'),
        description: t('guardianRecoveryDescription'),
        isDefault: true
      },
      {
        id: WalletType.OffChain,
        title: t('fullyPrivateRecovery'),
        description: t('fullyPrivateRecoveryDescription')
      }
    ],
    [t]
  );
  const options = optionsProp || defaultOptions;
  const [selected, setSelected] = React.useState<WalletType>(options.find(o => o.isDefault)?.id || options[0]!.id);

  const handleContinue = () => {
    onSubmit?.(selected);
  };

  const items: ChoiceCardItem<WalletType>[] = options.map(option => ({
    id: option.id,
    title: option.title,
    subtitle: option.description,
    badge: option.isDefault ? (
      <Pill size="xs" tone="selected" data-testid="default-badge">
        {t('default')}
      </Pill>
    ) : undefined
  }));

  return (
    <OnboardingStepLayout
      data-testid={dataTestId}
      title={t('chooseRecoveryMethod')}
      description={t('chooseRecoveryMethodDescription')}
      footer={<Button title={t('continue')} onClick={handleContinue} />}
    >
      <ChoiceCardGroup items={items} value={selected} onChange={setSelected} aria-label={t('chooseRecoveryMethod')} />
    </OnboardingStepLayout>
  );
};
