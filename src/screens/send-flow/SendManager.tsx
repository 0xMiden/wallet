import React, { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { yupResolver } from '@hookform/resolvers/yup';
import { useAppEnv } from 'app/env';
import classNames from 'clsx';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { stringToBigInt } from 'lib/i18n/numbers';
import {
  initiateSendTransaction,
  requestSWTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import { useAccount, useAllAccounts, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { NoteTypeEnum } from 'lib/miden/types';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate, useLocation } from 'lib/woozie';
import { SubmitHandler, useForm } from 'react-hook-form';
import { isValidMidenAddress } from 'utils/miden';
import * as yup from 'yup';

import { WalletType } from '../onboarding/types';
import { AccountsList } from './AccountsList';
import { ReviewTransaction } from './ReviewTransaction';
import { SelectToken } from './SelectToken';
import { SendDetails } from './SendDetails';
import { Contact, SendFlowAction, SendFlowActionId, SendFlowForm, SendFlowStep, UIToken } from './types';

const ROUTES: Route[] = [
  {
    name: SendFlowStep.SelectToken,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.SendDetails,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.AccountsList,
    animationIn: 'present',
    animationOut: 'dismiss'
  },
  {
    name: SendFlowStep.ReviewTransaction,
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
  preselectedTokenId?: string | null;
}

export const SendManager: React.FC<SendManagerProps> = ({ preselectedTokenId }) => {
  const { navigateTo, goBack, cardStack } = useNavigator();
  const allAccounts = useAllAccounts();
  const { publicKey } = useAccount();
  const { fullPage, sidePanel } = useAppEnv();
  const delegateEnabled = isDelegateProofEnabled();
  const [recallDate, setRecallDate] = useState<Date | undefined>(undefined);
  const [recallTime, setRecallTime] = useState('12:00');
  const [note, setNote] = useState('');

  const { contacts: addressBookContacts } = useFilteredContacts();

  const allContactsList: Contact[] = useMemo(() => {
    const walletContacts: Contact[] = allAccounts
      .filter(c => c.publicKey !== publicKey)
      .map(contact => ({
        id: contact.publicKey,
        name: contact.name,
        isOwned: true,
        contactType: contact.isPublic ? ('public' as const) : ('private' as const),
        isGuardian: contact.type === WalletType.Psm
      }));

    const externalContacts: Contact[] = addressBookContacts
      .filter(c => c.address !== publicKey && !allAccounts.some(acc => acc.publicKey === c.address))
      .map(contact => ({
        id: contact.address,
        name: contact.name,
        isOwned: false,
        contactType: 'external' as const
      }));

    return [...walletContacts, ...externalContacts];
  }, [allAccounts, addressBookContacts, publicKey]);

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
    navigate('/');
  }, [fullPage]);

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
      sharePrivately: true,
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

  // Pre-select token when navigating from token detail page
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData } = useAllBalances(publicKey, allTokensBaseMetadata);
  useEffect(() => {
    if (!preselectedTokenId || !balanceData) return;
    const match = balanceData.find(t => t.tokenId === preselectedTokenId);
    if (!match) return;
    const uiToken: UIToken = {
      id: match.tokenId,
      name: match.metadata.symbol,
      decimals: match.metadata.decimals,
      balance: match.balance,
      fiatPrice: match.fiatPrice
    };
    setValue('token', uiToken);
  }, [preselectedTokenId, balanceData, setValue]);

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

  const onSubmit = useCallback<SubmitHandler<SendFlowForm>>(async () => {
    if (isSubmitting) {
      return;
    }
    try {
      clearErrors('root');
      // Drop any hash from a previous completed tx before starting a fresh one,
      // so the completion modal can't briefly flash a stale "View on Midenscan"
      // button pointing at the previous hash.
      useWalletStore.getState().setLastCompletedTxHash(null);

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
        // Stash the on-chain tx hash so the completion modal can render a
        // "View on Midenscan" button. Set before navigation so the modal
        // transitions to its complete state with the hash already present.
        useWalletStore.getState().setLastCompletedTxHash(result.txHash);
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
  }, [
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
  ]);

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
    (amountString: string) => {
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { amount: amountString }
      });

      const amount = parseFloat(amountString || '0');
      if (!validations.amount.isValidSync(amountString)) {
        setError('amount', { type: 'manual', message: 'invalidAmount' });
      } else if (token && amount > token.balance) {
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
        case SendFlowStep.SendDetails:
          if (!token) return null;
          return (
            <SendDetails
              token={token}
              amount={amount || ''}
              recipientAddress={recipientAddress || ''}
              sharePrivately={sharePrivately}
              delegateTransaction={delegateTransaction}
              recallBlocks={recallBlocks}
              isValidAmount={!errors.amount && validations.amount.isValidSync(amount)}
              isValidAddress={!errors.recipientAddress && validations.recipientAddress.isValidSync(recipientAddress)}
              amountError={errors.amount?.message?.toString()}
              addressError={errors.recipientAddress?.message?.toString()}
              recallTime={recallTime}
              recallDate={recallDate}
              note={note}
              onAction={onAction}
              onGoBack={preselectedTokenId ? onClose : goBack}
              onAmountChange={onAmountChange}
              onAddressChange={onAddressChange}
              onScannedAddress={onScannedAddress}
              onClearAddress={onClearAddress}
              onYourAccounts={() => goToStep(SendFlowStep.AccountsList)}
              onRecallDateChange={setRecallDate}
              onRecallTimeChange={setRecallTime}
              onNoteChange={setNote}
            />
          );
        case SendFlowStep.AccountsList:
          return (
            <AccountsList
              recipientAccountId={recipientAddress}
              accounts={allContactsList}
              onClose={goBack}
              onSelectContact={onSelectContact}
            />
          );
        case SendFlowStep.ReviewTransaction:
          return (
            <ReviewTransaction
              amount={amount || ''}
              token={token?.name || ''}
              recipientAddress={recipientAddress}
              sharePrivately={sharePrivately}
              delegateTransaction={delegateTransaction}
              recallBlocks={recallBlocks}
              recallTime={recallTime}
              recallDate={recallDate}
              onAction={onAction}
              onGoBack={goBack}
              onSubmit={handleSubmit(onSubmit)}
            />
          );
        default:
          return <></>;
      }
    },
    [
      token,
      recipientAddress,
      allContactsList,
      errors.recipientAddress,
      errors.amount,
      onAddressChange,
      onScannedAddress,
      onClearAddress,
      goBack,
      onSelectContact,
      amount,
      onAmountChange,
      onAction,
      sharePrivately,
      delegateTransaction,
      recallBlocks,
      goToStep,
      handleSubmit,
      onSubmit,
      recallDate,
      recallTime,
      note,
      onClose,
      preselectedTokenId
    ]
  );

  // On mobile, use h-full to inherit from parent chain (body has safe area padding)
  const isMobileDevice = isMobile();
  const containerClass =
    isMobileDevice || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div
      className={classNames(
        containerClass,
        'mx-auto overflow-hidden',
        'flex flex-col bg-app-bg',
        'overflow-hidden relative'
      )}
      data-testid="send-flow"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col flex-1 h-full min-h-0">
        <Navigator renderRoute={renderStep} />
      </form>
    </div>
  );
};

const NavigatorWrapper: React.FC<{ isLoading: boolean }> = props => {
  const { search } = useLocation();
  const preselectedTokenId = new URLSearchParams(search).get('tokenId');
  const initialRoute = preselectedTokenId ? SendFlowStep.SendDetails : SendFlowStep.SelectToken;

  return (
    <NavigatorProvider routes={ROUTES} initialRouteName={initialRoute}>
      <SendManager {...props} preselectedTokenId={preselectedTokenId} />
    </NavigatorProvider>
  );
};

export { NavigatorWrapper as SendFlow };
