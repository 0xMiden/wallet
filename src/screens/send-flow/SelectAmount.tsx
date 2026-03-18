import React, { useCallback } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Chip } from 'components/Chip';
import { InputAmount } from 'components/InputAmount';
import { NavigationHeader } from 'components/NavigationHeader';
import colors from 'utils/tailwind-colors';

import { UIToken } from './types';
export interface SelectAmountProps {
  amount: string;
  isValidAmount: boolean;
  token: UIToken;
  error?: string;
  onGoBack: () => void;
  onGoNext: () => void;
  onCancel: () => void;
  onAmountChange: (amount: string | undefined) => void;
}

export const SelectAmount: React.FC<SelectAmountProps> = ({
  amount,
  isValidAmount,
  error,
  token,
  onGoBack,
  onGoNext,
  onCancel,
  onAmountChange
}) => {
  const { t } = useTranslation();

  const onTransactionAmountKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        onGoNext();
      }
    },
    [onGoNext]
  );

  const onAmountChangeHandler = useCallback(
    (
      value: string | undefined,
      name?: string,
      values?: {
        float: number | null;
        formatted: string;
        value: string;
      }
    ) => {
      onAmountChange(value ? values?.formatted : undefined);
    },
    [onAmountChange]
  );

  return (
    <div className="flex-1 flex flex-col relative">
      <NavigationHeader mode="back" title={`${t('send')} ${token.name}`} onBack={onGoBack} showBorder />
      <div className="flex-1 flex flex-col p-4 md:w-[460px] md:mx-auto">
        <div
          onKeyDown={onTransactionAmountKeyDown}
          className="flex-1 flex flex-col items-center justify-center gap-y-2"
        >
          <InputAmount
            className="self-stretch"
            value={amount}
            label={token.name}
            onValueChange={onAmountChangeHandler}
            autoFocus
          />
          <div className="min-h-[24px] w-full flex items-center justify-center">
            {error && (
              <span className="flex flex-row items-center gap-x-2">
                <Icon name={IconName.InformationFill} size={'xs'} />
                <p className="text-red-500 text-sm">{t(`${error}`)}</p>
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-y-2 ">
          <div className="flex flex-row items-center py-4">
            <div className="flex-1 flex-col gap-y-1">
              <p className="text-sm text-gray-400">{t('availableBalance')}</p>
              <p className="text-sm text-black">{`${token.balance?.toString()} ${token.name}`}</p>
            </div>
            <button onClick={() => onAmountChange(token.balance?.toString())} type="button">
              <Chip label={t('max')} className="cursor-pointer font-bold" />
            </button>
          </div>
        </div>
        <div className="flex flex-row gap-x-2">
          <Button className="flex-1" title={t('cancel')} variant={ButtonVariant.Secondary} onClick={onCancel} />
          <Button
            className="flex-1"
            title={t('next')}
            variant={ButtonVariant.Primary}
            disabled={!isValidAmount}
            onClick={onGoNext}
          />
        </div>
      </div>
    </div>
  );
};
