import React, { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { yupResolver } from '@hookform/resolvers/yup';
import classNames from 'clsx';
import { SubmitHandler, useForm } from 'react-hook-form';
import { useDebouncedCallback } from 'use-debounce';
import * as yup from 'yup';

import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { initiateB2AggBridge } from 'lib/agglayer/b2agg';
import { EVM_AGGLAYER_NETWORK_ID, MIDEN_AGGLAYER_FAUCET_ID } from 'lib/agglayer/b2agg/constant';
import { bridgeEpochSend } from 'lib/epoch';
import { stringToBigInt } from 'lib/i18n/numbers';
import { initiateSendTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { useAccount, useAllAccounts, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useMidenContext } from 'lib/miden/front/client';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { NoteTypeEnum } from 'lib/miden/types';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate, useLocation } from 'lib/woozie';
import { detectAddressChain, isValidEthereumAddress, isValidMidenAddress, isValidRecipientAddress } from 'utils/miden';

import { ReviewTransaction } from './ReviewTransaction';
import { SelectContactDrawer } from './SelectContactDrawer';
import { SelectTokenDrawer } from './SelectTokenDrawer';
import { SendForm } from './SendForm';
import { Contact, SendFlowAction, SendFlowActionId, SendFlowForm, SendFlowStep, UIToken } from './types';
import { WalletType } from '../onboarding/types';

const ROUTES: Route[] = [
  {
    name: SendFlowStep.SendForm,
    animationIn: 'push',
    animationOut: 'pop'
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
    .test('is-valid-address', 'Invalid address', value => isValidRecipientAddress(value ?? '')),
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
  const { signTransaction } = useMidenContext();
  const delegateEnabled = isDelegateProofEnabled();
  const [recallDate, setRecallDate] = useState<Date | undefined>(undefined);
  const [recallTime, setRecallTime] = useState('12:00');
  const [showTokenDrawer, setShowTokenDrawer] = useState(false);
  const [showContactDrawer, setShowContactDrawer] = useState(false);

  const { contacts: addressBookContacts } = useFilteredContacts();

  const allContactsList: Contact[] = useMemo(() => {
    const walletContacts: Contact[] = allAccounts
      .filter(c => c.publicKey !== publicKey)
      .map(contact => ({
        id: contact.publicKey,
        name: contact.name,
        isOwned: true,
        contactType: contact.isPublic ? ('public' as const) : ('private' as const),
        isGuardian: contact.type === WalletType.Guardian
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
    if (showTokenDrawer) {
      setShowTokenDrawer(false);
      return true;
    }
    if (showContactDrawer) {
      setShowContactDrawer(false);
      return true;
    }
    if (cardStack.length > 1) {
      goBack(); // Go to previous step (e.g. back from review)
      return true;
    }
    // On the root step, close the entire flow
    onClose();
    return true;
  }, [showTokenDrawer, showContactDrawer, cardStack.length, goBack, onClose]);

  const navigateToGeneratingTransaction = useCallback((txId?: string) => {
    navigate({
      pathname: '/generating-transaction-full',
      search: txId ? `?txId=${encodeURIComponent(txId)}` : ''
    });
  }, []);

  const onGenerateTransaction = useCallback(() => {
    navigateToGeneratingTransaction();
  }, [navigateToGeneratingTransaction]);

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
      token: undefined,
      bridgeRoute: 'epoch'
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
    register('bridgeRoute');
  }, [register]);

  const amount = watch('amount');
  const sharePrivately = watch('sharePrivately');
  const recipientAddress = watch('recipientAddress');
  const recallBlocks = watch('recallBlocks');
  const delegateTransaction = watch('delegateTransaction');
  const token = watch('token');
  const bridgeRoute = watch('bridgeRoute');

  // Cross-chain sends are restricted to the single bridgeable faucet token.
  const isBridgeableToken =
    !!token && accountIdStringToSdk(token.id.toLowerCase()).toString() === MIDEN_AGGLAYER_FAUCET_ID.toLowerCase();

  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData } = useAllBalances(publicKey, allTokensBaseMetadata);

  // Pre-select token when navigating from a token detail page.
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

  // Default-select the first token so the single screen always shows a token
  // (matches the design where a token + balance is shown by default).
  useEffect(() => {
    if (token || !balanceData || balanceData.length === 0) return;
    const first = balanceData[0];
    if (!first) return;
    setValue('token', {
      id: first.tokenId,
      name: first.metadata.symbol,
      decimals: first.metadata.decimals,
      balance: first.balance,
      fiatPrice: first.fiatPrice
    });
  }, [token, balanceData, setValue]);

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

      // Cross-chain (0x) recipient → bridge instead of a Miden send. Restricted
      // to the bridgeable token; Fast=Epoch / Slow=Agglayer per the selected route.
      if (detectAddressChain(recipientAddress!) === 'ethereum') {
        // Agglayer (Slow) can only bridge the dedicated agglayer faucet token;
        // Epoch (Fast) bridges any token.
        if (bridgeRoute === 'agglayer' && !isBridgeableToken) {
          setError('root', { type: 'manual', message: 'onlyBridgeableTokenSupported' });
          return;
        }
        const amountBase = stringToBigInt(amount!, token!.decimals);
        // Both routes mirror a normal send: create the `bridged-send` row first,
        // then navigate to the generating-transaction screen WITH its txId so the
        // screen tracks the real row (no navigate-first race / success flash).
        // Errors before the row exists (e.g. a failed Epoch quote) stay on the
        // form, where they're visible.
        try {
          if (bridgeRoute === 'agglayer') {
            const txId = await initiateB2AggBridge({
              amount: amountBase,
              destinationAddress: recipientAddress as `0x${string}`,
              senderPublicKey: publicKey!,
              destinationNetwork: EVM_AGGLAYER_NETWORK_ID
            });
            if (isExtension()) {
              requestSWTransactionProcessing();
            }
            navigateToGeneratingTransaction(txId);
          } else {
            // Epoch creates its row mid-solve; `onRowCreated` fires the moment it
            // exists so we navigate then (the rest of the solve runs in the
            // background while the screen drives the row to completion).
            await bridgeEpochSend({
              amount: amountBase,
              faucetId: token!.id,
              destinationAddress: recipientAddress as `0x${string}`,
              senderPublicKey: publicKey!,
              deps: { signTransaction, guardianProvider: zustandProvider },
              onRowCreated: txId => navigateToGeneratingTransaction(txId)
            });
          }
        } catch (bridgeErr: any) {
          if (bridgeErr?.message) {
            setError('root', { type: 'manual', message: bridgeErr.message });
          }
          console.error(bridgeErr);
        }
        return;
      }

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

      if (isExtension()) {
        // On extension: tell SW to process, then wait for Dexie updates
        requestSWTransactionProcessing();
      }

      navigateToGeneratingTransaction(txId);
    } catch (e: any) {
      if (e.message) {
        setError('root', { type: 'manual', message: e.message });
      }
      console.error(e);
    }
  }, [
    isSubmitting,
    clearErrors,
    publicKey,
    recipientAddress,
    sharePrivately,
    delegateTransaction,
    amount,
    recallBlocks,
    setError,
    token,
    bridgeRoute,
    isBridgeableToken,
    signTransaction,
    navigateToGeneratingTransaction
  ]);

  // Chain-aware address validation: 0x → Ethereum (hex), otherwise Miden bech32.
  // The error copy matches the detected chain so an Ethereum address no longer
  // shows the "Invalid Miden account ID" message.
  const validateAddress = useCallback(
    (address: string) => {
      const trimmed = address.trim();
      if (!trimmed) {
        clearErrors('recipientAddress');
        return;
      }
      const chain = detectAddressChain(trimmed);
      const valid = chain === 'ethereum' ? isValidEthereumAddress(trimmed) : isValidMidenAddress(trimmed);
      if (valid) {
        clearErrors('recipientAddress');
      } else {
        setError('recipientAddress', {
          type: 'manual',
          message: chain === 'ethereum' ? 'invalidEthereumAddress' : 'invalidMidenAccountId'
        });
      }
    },
    [setError, clearErrors]
  );

  // Only validate once the user pauses typing, so the "invalid" message doesn't
  // flash on every keystroke while a long address is being entered/pasted.
  const debouncedValidateAddress = useDebouncedCallback(validateAddress, 400);

  const onAddressChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const address = event.target.value;
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recipientAddress: address }
      });
      // Clear any prior error while typing; the debounced validator re-checks
      // once the user stops.
      clearErrors('recipientAddress');
      debouncedValidateAddress(address);
    },
    [onAction, clearErrors, debouncedValidateAddress]
  );

  const onSelectContact = useCallback(
    (contact: Contact) => {
      clearErrors('recipientAddress');
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recipientAddress: contact.id }
      });
      setShowContactDrawer(false);
    },
    [onAction, clearErrors]
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

  const onMax = useCallback(() => {
    if (!token) return;
    onAmountChange(String(token.balance));
  }, [token, onAmountChange]);

  const onSelectToken = useCallback(
    (selected: UIToken) => {
      setValue('token', selected);
      // Re-validate the amount against the newly selected token's balance.
      if (amount) onAmountChange(amount);
    },
    [setValue, amount, onAmountChange]
  );

  const onScannedAddress = useCallback(
    (address: string) => {
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recipientAddress: address }
      });
      // A scan yields a complete address — validate it right away.
      debouncedValidateAddress.cancel();
      validateAddress(address);
    },
    [onAction, debouncedValidateAddress, validateAddress]
  );

  const renderStep = useCallback(
    (route: Route) => {
      switch (route.name) {
        case SendFlowStep.SendForm:
          return (
            <SendForm
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
              bridgeRoute={bridgeRoute}
              isBridgeableToken={isBridgeableToken}
              senderPublicKey={publicKey}
              recallTime={recallTime}
              recallDate={recallDate}
              onAction={onAction}
              onAmountChange={onAmountChange}
              onAddressChange={onAddressChange}
              onScannedAddress={onScannedAddress}
              onMax={onMax}
              onOpenTokenDrawer={() => setShowTokenDrawer(true)}
              onOpenContactDrawer={() => setShowContactDrawer(true)}
              onBridgeRouteChange={route => setValue('bridgeRoute', route)}
              onRecallDateChange={setRecallDate}
              onRecallTimeChange={setRecallTime}
            />
          );
        case SendFlowStep.ReviewTransaction:
          return (
            <ReviewTransaction
              amount={amount || ''}
              token={token?.name || ''}
              fiatValue={token ? parseFloat(amount || '0') * token.fiatPrice : 0}
              recipientAddress={recipientAddress}
              recipientChain={detectAddressChain(recipientAddress || '')}
              bridgeRoute={bridgeRoute}
              sharePrivately={sharePrivately}
              delegateTransaction={delegateTransaction}
              recallBlocks={recallBlocks}
              recallTime={recallTime}
              recallDate={recallDate}
              onAction={onAction}
              onGoBack={goBack}
              onClose={onClose}
              onSubmit={handleSubmit(onSubmit)}
              isSubmitting={isSubmitting}
            />
          );
        default:
          return <></>;
      }
    },
    [
      token,
      recipientAddress,
      errors.recipientAddress,
      errors.amount,
      onAddressChange,
      onScannedAddress,
      onMax,
      goBack,
      amount,
      onAmountChange,
      onAction,
      onClose,
      sharePrivately,
      delegateTransaction,
      recallBlocks,
      handleSubmit,
      onSubmit,
      recallDate,
      recallTime,
      bridgeRoute,
      isBridgeableToken,
      publicKey,
      setValue,
      isSubmitting
    ]
  );

  // SendManager is rendered inside TabLayout > HomeSwipeContainer, which already
  // constrains its size. Hardcoded heights (h-[600px]/h-[640px]) overflow the
  // parent (which loses ~50px to the top action bar), clipping the bottom CTA.
  // Inherit from the parent chain instead.
  const containerClass = 'h-full w-full';

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

      <SelectTokenDrawer
        open={showTokenDrawer}
        onClose={() => setShowTokenDrawer(false)}
        onSelectToken={onSelectToken}
      />
      <SelectContactDrawer
        open={showContactDrawer}
        onClose={() => setShowContactDrawer(false)}
        recipientAccountId={recipientAddress}
        accounts={allContactsList}
        onSelectContact={onSelectContact}
      />
    </div>
  );
};

const NavigatorWrapper: React.FC<{ isLoading: boolean }> = props => {
  const { search } = useLocation();
  const preselectedTokenId = new URLSearchParams(search).get('tokenId');

  return (
    <NavigatorProvider routes={ROUTES} initialRouteName={SendFlowStep.SendForm}>
      <SendManager {...props} preselectedTokenId={preselectedTokenId} />
    </NavigatorProvider>
  );
};

export { NavigatorWrapper as SendFlow };
