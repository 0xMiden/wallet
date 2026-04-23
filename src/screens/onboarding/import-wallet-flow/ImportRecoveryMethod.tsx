import React, { useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Input } from 'components/Input';
import { DEFAULT_GUARDIAN_ENDPOINT } from 'lib/miden-chain/constants';
import { Badge } from 'lib/ui/badge';

import { WalletType } from '../types';

export interface ImportRecoveryMethodScreenProps {
  isError?: boolean;
  onSubmit: (payload: { walletType: WalletType; guardianEndpoint?: string }) => void;
}

export const ImportRecoveryMethodScreen: React.FC<ImportRecoveryMethodScreenProps> = ({ isError, onSubmit }) => {
  const { t } = useTranslation();

  const [selected, setSelected] = useState<WalletType>(WalletType.Guardian);
  const [endpointInput, setEndpointInput] = useState<string>(DEFAULT_GUARDIAN_ENDPOINT);
  const [isCustomizing, setIsCustomizing] = useState(false);
  const [dirty, setDirty] = useState(false);

  const showError = Boolean(isError) && !dirty && selected === WalletType.Guardian;

  const trimmedEndpoint = endpointInput.trim();
  const canContinue = selected === WalletType.OnChain || (selected === WalletType.Guardian && trimmedEndpoint.length > 0);

  const handleContinue = () => {
    console.log('Continue with selection:', { selected, trimmedEndpoint });
    if (selected === WalletType.OnChain) {
      onSubmit({ walletType: WalletType.OnChain });
      return;
    }
    onSubmit({ walletType: WalletType.Guardian, guardianEndpoint: trimmedEndpoint });
  };

  const handleSelectGuardian = () => {
    setSelected(WalletType.Guardian);
    setDirty(true);
  };

  const handleSelectOnChain = () => {
    setSelected(WalletType.OnChain);
    setDirty(true);
    setIsCustomizing(false);
  };

  const handleToggleCustom = () => {
    setIsCustomizing(prev => !prev);
    setDirty(true);
  };

  const options = useMemo(
    () => [
      {
        id: WalletType.Guardian,
        title: t('importViaGuardian'),
        description: t('importViaGuardianDescription'),
        isDefault: true,
        onSelect: handleSelectGuardian
      },
      {
        id: WalletType.OnChain,
        title: t('importPublicAccount'),
        description: t('importPublicAccountDescription'),
        onSelect: handleSelectOnChain
      }
    ],
    [t]
  );

  return (
    <div
      className="flex-1 flex flex-col items-center bg-transparent pt-6 h-full px-4 text-heading-gray gap-6"
      data-testid="import-recovery-method"
    >
      <div className="flex flex-col items-center gap-2">
        <h1 className="font-semibold text-2xl lh-title">{t('importRecoveryMethodTitle')}</h1>
        <p className="text-xs text-center lh-title px-4">{t('chooseRecoveryMethodDescription')}</p>
      </div>

      <div className="flex flex-col w-full">
        {options.map(option => {
          const isSelected = selected === option.id;
          const isGuardian = option.id === WalletType.Guardian;
          return (
            <div
              key={option.id}
              className={classNames('flex flex-col p-4 rounded-lg cursor-pointer bg-white mb-2', {
                'opacity-50': !isSelected
              })}
              onClick={option.onSelect}
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
              <p className="text-grey-600 text-sm">{option.description}</p>

              {isGuardian && isSelected && (
                <div className="mt-4 flex flex-col gap-2" onClick={e => e.stopPropagation()}>
                  {!isCustomizing && (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-grey-600">{t('guardianEndpoint')}</span>
                      <span className="text-sm font-mono break-all">{endpointInput}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleToggleCustom}
                    className="flex items-center gap-1 text-sm text-primary-500 font-medium self-start"
                  >
                    <span>{t('useDifferentGuardian')}</span>
                    <Icon name={isCustomizing ? IconName.ChevronUp : IconName.ChevronDown} size="sm" />
                  </button>
                  {isCustomizing && (
                    <Input
                      id="guardian-endpoint-input"
                      value={endpointInput}
                      placeholder={DEFAULT_GUARDIAN_ENDPOINT}
                      onChange={event => {
                        setEndpointInput(event.target.value);
                        setDirty(true);
                      }}
                    />
                  )}
                  {showError && <p className="text-red-500 text-xs mt-1">{t('guardianAccountNotFound')}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 self-center w-full mt-auto">
        <Button title={t('continue')} onClick={handleContinue} disabled={!canContinue} className="text-base" />
      </div>
    </div>
  );
};
