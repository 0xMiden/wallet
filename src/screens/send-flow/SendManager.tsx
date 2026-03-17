import React, { ChangeEvent, useCallback, useEffect, useMemo } from 'react';

import { yupResolver } from '@hookform/resolvers/yup';
import classNames from 'clsx';
import { SubmitHandler, useForm } from 'react-hook-form';
import * as yup from 'yup';

import { useAppEnv } from 'app/env';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { stringToBigInt } from 'lib/i18n/numbers';
import {
  initiateSendTransaction,
  requestSWTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import { useAccount, useAllAccounts } from 'lib/miden/front';
import { NoteTypeEnum } from 'lib/miden/types';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { isValidMidenAddress } from 'utils/miden';

import { AccountsList } from './AccountsList';
import { ReviewTransaction } from './ReviewTransaction';
import { SelectAmount } from './SelectAmount';
import { SelectRecipient } from './SelectRecipient';
import { SelectToken } from './SelectToken';
import { TransactionInitiated } from './TransactionInitiated';
import { Contact, SendFlowAction, SendFlowActionId, SendFlowForm, SendFlowStep } from './types';

const ROUTES: Route[] = [
  {
    name: SendFlowStep.SelectToken,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.SelectRecipient,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.AccountsList,
    animationIn: 'present',
    animationOut: 'dismiss'
  },
  {
    name: SendFlowStep.SelectAmount,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.ReviewTransaction,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.GeneratingTransaction,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.TransactionInitiated,
    animationIn: 'push',
    animationOut: 'pop'
  }
];

const validations = {
  amount: yup
    .string()
    .required()
    .test('is-greater-than-zero', 'Amount must be greater than 0', value => {
      return parseFloat(value) > 0;
    }),
  sharePrivately: yup.boolean().required(),
  recipientAddress: yup
    .string()
    .required()
    .test('is-valid-address', 'Invalid address', value => isValidMidenAddress(value)),
  recallBlocks: yup.number(),
  delegateTransaction: yup.boolean().required()
};

const validationSchema = yup.object().shape(validations).required();

export interface SendManagerProps {
  isLoading: boolean;
}

export const SendManager: React.FC<SendManagerProps> = ({ isLoading }) => {
  const { navigateTo, goBack, cardStack } = useNavigator();
  const allAccounts = useAllAccounts();
  const { publicKey } = useAccount();
  const { fullPage } = useAppEnv();
  const delegateEnabled = isDelegateProofEnabled();

  const otherAccounts: Contact[] = useMemo(
    () =>
      allAccounts
        .filter(c => c.publicKey !== publicKey)
        .map(
          contact =>
            ({
              id: contact.publicKey,
              name: contact.name,
              isOwned: true
            }) as Contact
        ),
    [allAccounts, publicKey]
  );

  const onClose = useCallback(() => {
    navigate('/');
  }, []);

  // Handle mobile back button/gesture
  useMobileBackHandler(() => {
    if (cardStack.length > 1) {
      goBack(); // Go to previous step
      return true;
    }
    // On first step, close entire flow
    onClose();
    return true;
  }, [cardStack.length, goBack, onClose]);

  const onGenerateTransaction = useCallback(async () => {
    // On mobile, open the modal and go back to home
    // The modal handles the entire transaction flow
    if (isMobile()) {
      useWalletStore.getState().openTransactionModal();
      // Don't navigate - stay on page to see if modal appears
      // navigate('/');
      return;
    }

    if (fullPage) {
      navigate('/generating-transaction-full');
      return;
    }

    useWalletStore.getState().openTransactionModal();
    navigateTo(SendFlowStep.TransactionInitiated);
  }, [fullPage, navigateTo]);

  const {
    register,
    watch,
    handleSubmit,
    setError,
    clearErrors,
    setValue,
    trigger,
    formState: { errors, isSubmitting }
  } = useForm<SendFlowForm>({
    defaultValues: {
      amount: undefined,
      sharePrivately: false,
      recipientAddress: undefined,
      recallBlocks: undefined,
      delegateTransaction: delegateEnabled,
      token: undefined
    },
    resolver: yupResolver(validationSchema) as any
  });

  useEffect(() => {
    register('amount');
    register('sharePrivately');
    register('recipientAddress');
    register('recallBlocks');
    register('delegateTransaction');
    register('token');
  }, [register]);

  const amount = watch('amount');
  const sharePrivately = watch('sharePrivately');
  const recipientAddress = watch('recipientAddress');
  const recallBlocks = watch('recallBlocks');
  const delegateTransaction = watch('delegateTransaction');
  const token = watch('token');

  const onAction = useCallback(
    (action: SendFlowAction) => {
      switch (action.id) {
        case SendFlowActionId.Navigate:
          navigateTo(action.step);
          break;
        case SendFlowActionId.GoBack:
          goBack();
          break;
        case SendFlowActionId.Finish:
          onClose?.();
          break;
        case SendFlowActionId.SetFormValues:
          Object.entries(action.payload).forEach(([key, value]) => {
            setValue(key as keyof SendFlowForm, value);
          });
          if (action.triggerValidation) {
            trigger();
          }
          break;
        case SendFlowActionId.GenerateTransaction:
          onGenerateTransaction();
          break;
        default:
          break;
      }
    },
    [navigateTo, goBack, onClose, onGenerateTransaction, setValue, trigger]
  );

  const onSubmit = useCallback<SubmitHandler<SendFlowForm>>(
    async data => {
      if (isSubmitting) {
        return;
      }
      try {
        clearErrors('root');

        // Step 1: Create the transaction (same as Receive's initiateConsumeTransaction)
        const txId = await initiateSendTransaction(
          publicKey!,
          recipientAddress!,
          token!.id,
          sharePrivately ? NoteTypeEnum.Private : NoteTypeEnum.Public,
          stringToBigInt(amount!, token!.decimals),
          recallBlocks ? parseInt(recallBlocks) : undefined,
          delegateTransaction
        );

        // Step 2: Open the loading modal
        useWalletStore.getState().openTransactionModal();

        if (isExtension()) {
          // On extension: tell SW to process, then wait for Dexie updates
          requestSWTransactionProcessing();
        }

        // Step 3: Wait for transaction completion (Dexie liveQuery works cross-context)
        const result = await waitForTransactionCompletion(txId);

        if ('errorMessage' in result) {
          setError('root', { type: 'manual', message: result.errorMessage });
        } else {
          // Success - navigate to home on mobile, or completion screen on desktop
          if (isMobile()) {
            navigate('/');
          } else {
            onAction({ id: SendFlowActionId.GenerateTransaction });
          }
        }
      } catch (e: any) {
        if (e.message) {
          setError('root', { type: 'manual', message: e.message });
        }
        console.error(e);
      }
    },
    [
      isSubmitting,
      clearErrors,
      onAction,
      publicKey,
      recipientAddress,
      sharePrivately,
      delegateTransaction,
      amount,
      recallBlocks,
      setError,
      token
    ]
  );

  const onAddressChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const address = event.target.value;
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recipientAddress: address }
      });
      if (!isValidMidenAddress(address)) {
        setError('recipientAddress', { type: 'manual', message: 'invalidMidenAccountId' });
      } else {
        clearErrors('recipientAddress');
      }
    },
    [onAction, setError, clearErrors]
  );

  const onSelectContact = useCallback(
    (contact: Contact) => {
      clearErrors('recipientAddress');
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recipientAddress: contact.id }
      });
      setTimeout(() => goBack(), 300);
    },
    [onAction, goBack, clearErrors]
  );

  const onAmountChange = useCallback(
    (amountString: string | undefined) => {
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { amount: amountString }
      });

      const amount = parseFloat(amountString || '0');
      if (!validations.amount.isValidSync(amountString)) {
        setError('amount', { type: 'manual', message: 'Invalid amount' });
      } else if (amount > token!.balance) {
        setError('amount', { type: 'manual', message: 'amountMustBeLessThanBalance' });
      } else {
        clearErrors('amount');
      }
    },
    [onAction, token, setError, clearErrors]
  );

  const goToStep = useCallback(
    (step: SendFlowStep) => {
      onAction({ id: SendFlowActionId.Navigate, step });
    },
    [onAction]
  );

  const onClearAddress = useCallback(() => {
    onAction({
      id: SendFlowActionId.SetFormValues,
      payload: { recipientAddress: '' }
    });
    clearErrors('recipientAddress');
  }, [onAction, clearErrors]);

  const onScannedAddress = useCallback(
    (address: string) => {
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recipientAddress: address }
      });
      if (!isValidMidenAddress(address)) {
        setError('recipientAddress', { type: 'manual', message: 'invalidMidenAccountId' });
      } else {
        clearErrors('recipientAddress');
      }
    },
    [onAction, setError, clearErrors]
  );

  const renderStep = useCallback(
    (route: Route) => {
      switch (route.name) {
        case SendFlowStep.SelectToken:
          return <SelectToken onAction={onAction} />;
        case SendFlowStep.SelectRecipient:
          return (
            <SelectRecipient
              address={recipientAddress}
              isValidAddress={!errors.recipientAddress && validations.recipientAddress.isValidSync(recipientAddress)}
              error={errors.recipientAddress?.message?.toString()}
              onAddressChange={onAddressChange}
              onScannedAddress={onScannedAddress}
              onYourAccounts={() => goToStep(SendFlowStep.AccountsList)}
              onGoNext={() => goToStep(SendFlowStep.SelectAmount)}
              onClear={onClearAddress}
              onClose={onClose}
              onCancel={onClose}
            />
          );
        case SendFlowStep.AccountsList:
          return (
            <AccountsList
              recipientAccountId={recipientAddress}
              accounts={otherAccounts}
              onClose={goBack}
              onSelectContact={onSelectContact}
            />
          );
        case SendFlowStep.SelectAmount:
          return (
            <SelectAmount
              amount={amount}
              isValidAmount={!errors.amount && validations.amount.isValidSync(amount)}
              error={errors.amount?.message?.toString()}
              token={token!}
              onGoBack={goBack}
              onGoNext={() => goToStep(SendFlowStep.ReviewTransaction)}
              onCancel={onClose}
              onAmountChange={onAmountChange}
            />
          );
        case SendFlowStep.ReviewTransaction:
          return (
            <ReviewTransaction
              onAction={onAction}
              onGoBack={goBack}
              amount={amount}
              token={token!.name}
              recipientAddress={recipientAddress}
              sharePrivately={sharePrivately}
              delegateTransaction={delegateTransaction}
            />
          );
        case SendFlowStep.TransactionInitiated:
          return <TransactionInitiated onAction={onAction} />;
        default:
          return <></>;
      }
    },
    [
      token,
      recipientAddress,
      otherAccounts,
      errors.recipientAddress,
      errors.amount,
      onAddressChange,
      onScannedAddress,
      onClearAddress,
      onClose,
      goBack,
      onSelectContact,
      amount,
      onAmountChange,
      onAction,
      sharePrivately,
      delegateTransaction,
      goToStep
    ]
  );

  // On mobile, use h-full to inherit from parent chain (body has safe area padding)
  const isMobileDevice = isMobile();
  const containerClass = isMobileDevice
    ? 'h-full w-full'
    : fullPage
      ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px] border rounded-3xl'
      : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div
      className={classNames(
        containerClass,
        'mx-auto overflow-hidden ',
        'flex flex-1',
        'flex-col bg-white',
        'overflow-hidden relative'
      )}
      data-testid="send-flow"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex-1 flex">
        <Navigator renderRoute={renderStep} initialRouteName={SendFlowStep.SelectToken} />
      </form>
    </div>
  );
};

const NavigatorWrapper: React.FC<SendManagerProps> = props => {
  return (
    <NavigatorProvider routes={ROUTES}>
      <SendManager {...props} />
    </NavigatorProvider>
  );
};

export { NavigatorWrapper as SendFlow };
