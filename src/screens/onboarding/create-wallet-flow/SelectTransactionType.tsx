import React, { useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import colors from 'utils/tailwind-colors';

export interface SelectTransactionTypeScreenProps {
  onSubmit?: (selectedType: 'delegate' | 'local') => void;
  className?: string;
}

enum TransactionType {
  Delegate = 'delegate',
  Local = 'local'
}

type TransactionTypeOption = {
  id: TransactionType;
  title?: string;
  isPopular?: boolean;
  features: { title?: string; subtitle?: string }[];
};

export const SelectTransactionTypeScreen: React.FC<SelectTransactionTypeScreenProps> = ({
  onSubmit,
  className,
  ...props
}) => {
  const { t } = useTranslation();
  const [selectedType, setSelectedType] = useState<TransactionType>(TransactionType.Delegate);

  const Options: TransactionTypeOption[] = useMemo(
    () => [
      {
        id: TransactionType.Delegate,
        title: t('delegateTransactions'),
        isPopular: true,
        features: [
          {
            title: t('vpnLevelPrivacy')
          },
          {
            title: t('transactionSpeed'),
            subtitle: t('transactionSpeed2Sec')
          },
          {
            title: t('additionalDownloads'),
            subtitle: t('additionalDownloads0mb')
          },
          {
            title: t('delegateProofsToSecureServers')
          },
          {
            title: t('yourKeysStayPrivate')
          }
        ]
      },
      {
        id: TransactionType.Local,
        title: t('generateTransactionsLocally'),
        features: [
          {
            title: t('maximumPrivacy')
          },
          {
            title: t('transactionSpeed'),
            subtitle: t('transactionSpeedMins')
          },
          {
            title: t('additionalDownloads'),
            subtitle: t('600megabytes')
          },
          {
            title: t('createsProofsOnYourComputer')
          },
          {
            title: t('yourKeysStayPrivate')
          }
        ]
      }
    ],
    [t]
  );

  const handleContinue = () => {
    if (onSubmit) {
      onSubmit(selectedType);
    }
  };

  return (
    <div className={classNames('flex-1', 'flex flex-col items-center', 'bg-app-bg gap-8 p-6', className)} {...props}>
      <h1 className="text-2xl font-semibold">{t('selectTheDefaultTransactionType')}</h1>

      <div className="flex gap-x-2">
        {Options.map(option => (
          <div
            key={option.id}
            onClick={() => setSelectedType(option.id)}
            className={classNames(
              'w-[260px] h-[440px] flex flex-col relative',
              'px-5 pb-6 pt-8',
              'rounded-lg',
              'cursor-pointer',
              {
                'border-2 border-black': selectedType === option.id,
                'border my-px': selectedType !== option.id
              }
            )}
          >
            <input className="hidden" type="radio" name={option.id} checked={selectedType === option.id} />
            {option.isPopular && (
              <div
                className={classNames(
                  'absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2',
                  'bg-black text-white text-xs font-medium',
                  'px-2 py-1 rounded-full'
                )}
              >
                {t('popular')}
              </div>
            )}

            <div className="flex flex-col grow overflow-scroll no-scrollbar">
              <h2 className="font-semibold text-base text-center whitespace-pre">{option.title}</h2>
              <ul className="flex flex-1 flex-col mt-6 px-5 divide-y divide-grey-100">
                {option.features.map((feature, index) => (
                  <li key={index} className="flex flex-col py-2 justify-center">
                    <p className={classNames('text-center text-sm', { 'text-grey-600': !!feature.subtitle })}>
                      {feature.title}
                    </p>
                    {feature.subtitle && <p className="text-sm text-center">{feature.subtitle}</p>}
                  </li>
                ))}
              </ul>
            </div>
            <Button
              title={t(selectedType === option.id ? 'selected' : 'select')}
              variant={selectedType === option.id ? ButtonVariant.Ghost : ButtonVariant.Secondary}
              className={classNames('mt-4', { 'text-primary-500': selectedType === option.id })}
              iconLeft={
                selectedType === option.id ? (
                  <Icon
                    name={IconName.CheckboxCircleFill}
                    fill={selectedType === option.id ? colors.primary[500] : 'black'}
                  />
                ) : null
              }
            />
          </div>
        ))}
      </div>

      <Button title={t('continue')} onClick={handleContinue} className="w-[360px] h-[48px]" />
    </div>
  );
};
