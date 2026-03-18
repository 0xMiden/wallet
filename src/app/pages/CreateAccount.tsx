import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { SubmitHandler, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { ACCOUNT_NAME_PATTERN } from 'app/defaults';
import { NavigationHeader } from 'components/NavigationHeader';
import { useMidenContext, useAllAccounts } from 'lib/miden/front';
import { goBack, navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

type FormData = {
  name: string;
  walletType: WalletType;
};

const WalletTypeOptions = [
  {
    id: WalletType.OnChain,
    title: 'On-chain Account (Public)',
    description: 'Use an existing 12 word recovery phrase. You can also import wallets from other wallet providers.'
  },
  {
    id: WalletType.OffChain,
    title: 'Off-chain Account (Private)',
    description: 'Fast, private operations with minimal fees, bypassing direct blockchain interaction.'
  }
];

const SUBMIT_ERROR_TYPE = 'submit-error';

const CreateAccount: FC = () => {
  const { t } = useTranslation();
  const [selectedWalletType, setSelectedWalletType] = useState<WalletType>(WalletType.OnChain);
  const { createAccount, updateCurrentAccount } = useMidenContext();
  const allAccounts = useAllAccounts();

  const computedDefaultName = useMemo(() => {
    if (selectedWalletType === WalletType.OnChain) {
      return `Pub Account ${allAccounts.filter(acc => acc.isPublic).length + 1}`;
    } else {
      return `Priv Account ${allAccounts.filter(acc => !acc.isPublic).length + 1}`;
    }
  }, [allAccounts, selectedWalletType]);

  const prevAccLengthRef = useRef(allAccounts.length);
  useEffect(() => {
    async function updateAccount() {
      const accLength = allAccounts.length;
      if (prevAccLengthRef.current < accLength) {
        await updateCurrentAccount(allAccounts[accLength - 1].publicKey);
        // Navigate with query param to show AccountCreatedSuccess banner
        navigate('/select-account?fromCreateAccount=true');
      }
      prevAccLengthRef.current = accLength;
    }
    updateAccount();
  }, [allAccounts, updateCurrentAccount]);

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<FormData>({
    defaultValues: { name: computedDefaultName }
  });

  useEffect(() => {
    setValue('name', computedDefaultName);
  }, [computedDefaultName, setValue]);

  const handleWalletTypeSelect = (type: WalletType) => {
    setSelectedWalletType(type);
  };

  const onSubmit = useCallback<SubmitHandler<FormData>>(
    async ({ name, walletType }) => {
      if (isSubmitting) return;

      clearErrors('name');

      try {
        await createAccount(selectedWalletType, name);
      } catch (err: any) {
        console.error(err);

        // Human delay.
        await new Promise(res => setTimeout(res, 300));
        setError('name', { type: SUBMIT_ERROR_TYPE, message: err.message });
      }
    },
    [isSubmitting, clearErrors, setError, createAccount, selectedWalletType]
  );

  return (
    <div className="text-heading-gray">
      <NavigationHeader title={t('createAccount')} showBorder className="bg-gray-25" onBack={goBack} />
      <div className="w-full max-w-sm mx-auto px-6 pt-6">
        <form onSubmit={handleSubmit(onSubmit)}>
          <FormField
            {...register('name', {
              pattern: {
                value: ACCOUNT_NAME_PATTERN,
                message: t('accountNameInputTitle')
              }
            })}
            label={<div className="font-semibold -mb-2 text-xl">{t('accountName')}</div>}
            id="create-account-name"
            type="text"
            placeholder={computedDefaultName}
            errorCaption={errors.name?.message}
            autoFocus
            className="border-gray-500 border rounded-[10px]"
          />
          {/* Wallet Type Selection */}
          <div className="pb-8 pt-6">
            <div className="font-semibold text-xl mb-4">{t('chooseYourAccountType')}</div>
            {WalletTypeOptions.map((option, idx) => (
              <div
                key={option.id}
                className={classNames('flex flex-col p-4 rounded-lg cursor-pointer', 'w-full', 'mb-4', {
                  'bg-gray-25': selectedWalletType === option.id // Highlight if selected
                })}
                onClick={() => handleWalletTypeSelect(option.id)}
              >
                <div className="flex flex-row justify-between items-center">
                  <h3 className="font-semibold text-base">{option.title}</h3>
                </div>
                <p className="text-grey-500 text-sm leading-4.5">{option.description}</p>
              </div>
            ))}
          </div>

          <FormSubmitButton
            className="capitalize w-full justify-center rounded-[10px] text-base font-semibold"
            loading={isSubmitting}
          >
            {t('createAccount')}
          </FormSubmitButton>
        </form>
      </div>
    </div>
  );
};

export default CreateAccount;
