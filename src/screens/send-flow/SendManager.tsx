import React, { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { yupResolver } from '@hookform/resolvers/yup';
import { RpcClient } from '@miden-sdk/miden-sdk/lazy';
import classNames from 'clsx';
import { addDays, format } from 'date-fns';
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
import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate, useLocation } from 'lib/woozie';
import { detectAddressChain, isValidEthereumAddress, isValidMidenAddress, isValidRecipientAddress } from 'utils/miden';

import { AccountsList } from './AccountsList';
import { BRIDGE_OUTPUT_TOKEN_SYMBOL, DEFAULT_BRIDGE_NETWORK, getBridgeNetwork } from './bridge-networks';
import { dateTimeToRecallBlocks } from './RecallCalendarDrawer';
import { ReviewTransaction } from './ReviewTransaction';
import { Route as RouteStep } from './Route';
import { SelectAmount } from './SelectAmount';
import { SelectNetwork } from './SelectNetwork';
import { SelectRecipient } from './SelectRecipient';
import { SelectToken } from './SelectToken';
import { BridgeRoute, Contact, SendFlowAction, SendFlowActionId, SendFlowForm, SendFlowStep, UIToken } from './types';
import { useEpochQuote } from './useEpochQuote';
import { WalletType } from '../onboarding/types';

const ROUTES: Route[] = [
  {
    name: SendFlowStep.SelectRecipient,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.SelectAmount,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.SelectToken,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.SelectNetwork,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: SendFlowStep.Route,
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
    .test('is-valid-address', 'Invalid address', value => isValidRecipientAddress(value ?? '')),
  recallBlocks: yup.number()
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
    if (cardStack.length > 1) {
      goBack(); // Go to previous step (e.g. back from review)
      return true;
    }
    // On the root step, close the entire flow
    onClose();
    return true;
  }, [cardStack.length, goBack, onClose]);

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
    register('token');
    register('bridgeNetwork');
    register('bridgeRoute');
  }, [register]);

  // E2E-only hook: the per-send privacy toggle was removed from the UI, so the
  // harness can't pick a PUBLIC send by clicking. Mirror the __TEST_STORE__ gate
  // (process.env.MIDEN_E2E_TEST === 'true') and expose a setter that flips the
  // react-hook-form `sharePrivately` field. Zero production impact.
  useEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    (globalThis as any).__TEST_SET_SHARE_PRIVATELY__ = (v: boolean) => setValue('sharePrivately', v);
    return () => {
      delete (globalThis as any).__TEST_SET_SHARE_PRIVATELY__;
    };
  }, [setValue]);

  const amount = watch('amount');
  const sharePrivately = watch('sharePrivately');
  const recipientAddress = watch('recipientAddress');
  const recallBlocks = watch('recallBlocks');
  const token = watch('token');
  const bridgeNetwork = watch('bridgeNetwork');
  const bridgeRoute = watch('bridgeRoute');

  // delegateTransaction is driven exclusively by the global proving setting
  // (the per-send toggle was removed). Read fresh each render so a settings
  // change while the flow is open takes effect.
  const delegateTransaction = delegateEnabled;

  // A 0x recipient routes through the bridge instead of a same-chain Miden send.
  const isBridge = !!recipientAddress && detectAddressChain(recipientAddress) === 'ethereum';
  const bridgeNetworkObj = getBridgeNetwork(bridgeNetwork);

  // Cross-chain sends are restricted to the single bridgeable faucet token.
  const isBridgeableToken =
    !!token && accountIdStringToSdk(token.id.toLowerCase()).toString() === MIDEN_AGGLAYER_FAUCET_ID.toLowerCase();

  // Default a cross-chain send to the only destination network (Sepolia) so the
  // Amount screen shows "Network: Sepolia · arrives as USDC" without an extra tap.
  useEffect(() => {
    if (isBridge && !bridgeNetwork) {
      setValue('bridgeNetwork', DEFAULT_BRIDGE_NETWORK.id);
    }
  }, [isBridge, bridgeNetwork, setValue]);

  // The Slow (Agglayer) route only carries the dedicated bridgeable token. If it
  // was selected and the token changes to one it can't bridge, fall back to Fast
  // so Review/submit don't dead-end on the bridgeable-token guard.
  useEffect(() => {
    if (isBridge && bridgeRoute === 'agglayer' && !isBridgeableToken) {
      setValue('bridgeRoute', 'epoch');
    }
  }, [isBridge, bridgeRoute, isBridgeableToken, setValue]);

  // Forward-quote the USDC output for the Fast (Epoch) route. Drives both the
  // Route screen's Fast fee (input value − USDC out) and the Review "you receive"
  // line. Runs for any bridge send with valid inputs, independent of the
  // currently-selected route, so the Fast card always shows a live fee.
  const amountBaseUnits = useMemo(() => {
    if (!token || !amount || !validations.amount.isValidSync(amount)) return undefined;
    try {
      return stringToBigInt(amount, token.decimals);
    } catch {
      return undefined;
    }
  }, [token, amount]);

  const epochQuote = useEpochQuote({
    amount: amountBaseUnits,
    faucetId: token?.id,
    destinationAddress: recipientAddress,
    senderPublicKey: publicKey ?? undefined,
    enabled: isBridge
  });

  // Fast-route fee = what the user sends (USD) minus the USDC they'd receive.
  const fastFeeUsd = useMemo(() => {
    if (!token || !amount || epochQuote.amount == null) return undefined;
    const input = parseFloat(amount) * token.fiatPrice;
    const output = parseFloat(epochQuote.amount);
    if (!isFinite(input) || !isFinite(output)) return undefined;
    return Math.max(0, input - output);
  }, [token, amount, epochQuote.amount]);

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

  // Default every send to a 7-day reclaim (expiration) height. Fetch the
  // current block height once on flow entry and seed recallDate/recallBlocks.
  // The user can override via the "Edit" link on the Review screen, which
  // opens RecallCalendarDrawer; we skip seeding if a date is already set.
  useEffect(() => {
    if (recallDate) return;
    let cancelled = false;
    ensureSdkWasmReady()
      .then(() => {
        if (cancelled) return;
        const rpc = new RpcClient(getRpcEndpoint());
        return rpc.getBlockHeaderByNumber().then(header => {
          if (cancelled) return;
          const date = addDays(new Date(), 7);
          setRecallDate(date);
          setRecallTime(format(date, 'HH:mm'));
          setValue('recallBlocks', String(dateTimeToRecallBlocks(date, header.blockNum())));
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-validate the amount whenever the selected token changes. In the new
  // flow the user can type an amount before picking a token, so the balance
  // check in onAmountChange may have run with no token (or a different one).
  // Without this, an over-balance amount could reach Review with Confirm
  // still enabled.
  useEffect(() => {
    if (!amount) return;
    if (!validations.amount.isValidSync(amount)) {
      setError('amount', { type: 'manual', message: 'invalidAmount' });
    } else if (token && parseFloat(amount) > token.balance) {
      setError('amount', { type: 'manual', message: 'amountMustBeLessThanBalance' });
    } else {
      clearErrors('amount');
    }
    // Only re-run when the token changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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
    (event: ChangeEvent<HTMLTextAreaElement>) => {
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
      // Contact is picked from the AccountsList step — pop back to recipient.
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

  const onRouteChange = useCallback(
    (route: BridgeRoute) => {
      onAction({ id: SendFlowActionId.SetFormValues, payload: { bridgeRoute: route } });
    },
    [onAction]
  );

  // From the Amount screen: a cross-chain send picks a route next; a same-chain
  // Miden send goes straight to review.
  const onAmountConfirm = useCallback(() => {
    goToStep(isBridge ? SendFlowStep.Route : SendFlowStep.ReviewTransaction);
  }, [goToStep, isBridge]);

  const renderStep = useCallback(
    (route: Route) => {
      switch (route.name) {
        case SendFlowStep.SelectRecipient:
          return (
            <SelectRecipient
              address={recipientAddress || ''}
              isValidAddress={!errors.recipientAddress && validations.recipientAddress.isValidSync(recipientAddress)}
              error={errors.recipientAddress?.message?.toString()}
              onAddressChange={onAddressChange}
              onAddressBook={() => goToStep(SendFlowStep.AccountsList)}
              onConfirm={() => goToStep(SendFlowStep.SelectAmount)}
            />
          );
        case SendFlowStep.SelectAmount:
          return (
            <SelectAmount
              token={token}
              amount={amount || ''}
              isValidAmount={!errors.amount && validations.amount.isValidSync(amount)}
              error={errors.amount?.message?.toString()}
              isBridge={isBridge}
              network={bridgeNetworkObj}
              outputSymbol={BRIDGE_OUTPUT_TOKEN_SYMBOL}
              onAmountChange={onAmountChange}
              onSelectToken={() => goToStep(SendFlowStep.SelectToken)}
              onSelectNetwork={() => goToStep(SendFlowStep.SelectNetwork)}
              onConfirm={onAmountConfirm}
            />
          );
        case SendFlowStep.SelectToken:
          return <SelectToken onAction={onAction} />;
        case SendFlowStep.SelectNetwork:
          return <SelectNetwork selectedNetwork={bridgeNetwork} onAction={onAction} />;
        case SendFlowStep.Route:
          return (
            <RouteStep
              route={bridgeRoute ?? 'epoch'}
              onRouteChange={onRouteChange}
              fastFeeUsd={fastFeeUsd}
              fastQuoteLoading={epochQuote.loading}
              slowEnabled={isBridgeableToken}
              onConfirm={() => goToStep(SendFlowStep.ReviewTransaction)}
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
              token={token}
              recipientAddress={recipientAddress}
              recallTime={recallTime}
              recallDate={recallDate}
              isBridge={isBridge}
              network={bridgeNetworkObj}
              route={bridgeRoute}
              quote={epochQuote}
              outputSymbol={BRIDGE_OUTPUT_TOKEN_SYMBOL}
              isSubmitting={isSubmitting}
              onAction={onAction}
              onGoBack={goBack}
              onClose={onClose}
              onSubmit={handleSubmit(onSubmit)}
              onRecallDateChange={setRecallDate}
              onRecallTimeChange={setRecallTime}
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
      isBridge,
      bridgeNetwork,
      bridgeNetworkObj,
      bridgeRoute,
      isBridgeableToken,
      epochQuote,
      fastFeeUsd,
      onRouteChange,
      onAmountConfirm,
      allContactsList,
      onSelectContact,
      onClose,
      onAddressChange,
      goBack,
      amount,
      onAmountChange,
      onAction,
      goToStep,
      handleSubmit,
      onSubmit,
      isSubmitting,
      recallDate,
      recallTime
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
    </div>
  );
};

const NavigatorWrapper: React.FC<{ isLoading: boolean }> = props => {
  const { search } = useLocation();
  const preselectedTokenId = new URLSearchParams(search).get('tokenId');
  // Always start at recipient selection; a preselected token just pre-fills the
  // token for the Amount step (see the preselect effect in SendManager).
  const initialRoute = SendFlowStep.SelectRecipient;

  return (
    <NavigatorProvider routes={ROUTES} initialRouteName={initialRoute}>
      <SendManager {...props} preselectedTokenId={preselectedTokenId} />
    </NavigatorProvider>
  );
};

export { NavigatorWrapper as SendFlow };
