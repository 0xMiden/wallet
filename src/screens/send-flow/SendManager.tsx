import React, { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { yupResolver } from '@hookform/resolvers/yup';
import classNames from 'clsx';
import { SubmitHandler, useForm } from 'react-hook-form';
import * as yup from 'yup';

import { useAppEnv } from 'app/env';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { stringToBigInt } from 'lib/i18n/numbers';
import {
  initiateSendTransaction,
  requestSpeculateInvalidate,
  requestSpeculateSend,
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
import { isValidMidenAddress } from 'utils/miden';

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
        contactType: contact.isPublic ? ('public' as const) : ('private' as const)
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

  // Dismiss any stale completion modal on send-flow entry.
  //
  // After PR #230, the TransactionProgressModal auto-dismiss is gated on
  // terminal-state signals so the "Done" screen stays visible until the
  // user explicitly taps Done. The modal renders as `fixed inset-0` with
  // `zIndex: 9999` and no `pointer-events: none` — while it's open it
  // intercepts every click in the viewport.
  //
  // The modal is shared across the wallet: SendManager opens it for
  // sends, Receive opens it for claims, ConfirmPage opens it for dApp
  // requests. Any of those completing leaves it sticky. In stress and in
  // any user flow that initiates a send while a previous send/claim/dApp
  // tx's completion screen is still up, navigating to `/send` finds the
  // SelectToken tile blocked behind the modal — Playwright sees
  // `locator.click` time out against
  // `getByTestId('send-flow').locator('div.cursor-pointer')`. An
  // earlier fix gated on `lastCompletedTxHash !== null`, which only
  // catches the send-completion case (that hash is set by SendManager's
  // onSubmit only) — claim/dApp completions still produced sticky
  // modals because they leave the hash null but still flip
  // `transactionComplete` true via the Dexie queue going empty.
  //
  // Entering /send is a clear "I'm starting a new transaction" signal,
  // equivalent to tapping Done on whatever was open. Close
  // unconditionally on mount: in-flight modals can't reach this code
  // path here because PR #217's `pathname`-watching effect in the modal
  // already auto-dismisses non-terminal opens on navigation away from
  // `settledPathname`, so the only `isTransactionModalOpen === true`
  // state reachable at SendManager-mount time is terminal.
  useEffect(() => {
    const state = useWalletStore.getState();
    if (state.isTransactionModalOpen) {
      state.closeTransactionModal(true);
    }
    if (state.lastCompletedTxHash !== null) {
      state.setLastCompletedTxHash(null);
    }
    // Intentionally empty deps — run once on send-flow entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      token: undefined
    },
    resolver: yupResolver(validationSchema) as any
  });

  useEffect(() => {
    register('amount');
    register('sharePrivately');
    register('recipientAddress');
    register('recallBlocks');
    register('token');
  }, [register]);

  const amount = watch('amount');
  const sharePrivately = watch('sharePrivately');
  const recipientAddress = watch('recipientAddress');
  const recallBlocks = watch('recallBlocks');
  const token = watch('token');
  // delegateTransaction is now driven exclusively by the global setting in
  // General Settings — the per-send toggle was removed because mt-wasm +
  // offscreen-doc proving makes local proving fast enough that the per-tx
  // escape hatch isn't worth the UI surface. Read fresh on each render so
  // a settings change while the send flow is open takes effect.
  const delegateTransaction = delegateEnabled;

  // Speculative pre-prove: kick off execute + offscreen prove in the SW
  // as soon as the SendDetails form is valid, so the proof can finish
  // (~5-10s) while the user is still on details/review. Without an early
  // trigger, the user reaches review with the proof not yet started; their
  // typical 2-3s on review isn't enough to absorb the 10s prove cost.
  //
  // Cache lives in SW memory keyed by params hash; consumed by
  // MidenClientInterface.proveLocallyViaOffscreen on actual submit. If
  // the user clicks Confirm BEFORE the speculation finishes,
  // proveLocallyViaOffscreen calls SpeculationManager.awaitMatching to
  // wait on the in-flight prove instead of starting a duplicate one
  // (Fix B).
  //
  // Discarded-CPU bound: the SpeculationManager already serializes (one
  // active + one pending slot). Rapid form changes replace `pending`
  // before it ever runs, and the in-flight `active` is marked stale and
  // its result discarded. Worst case: ONE extra prove's worth of CPU per
  // session of form edits, regardless of how many keystrokes. The 500ms
  // React-level debounce below further trims churn during typing.
  //
  // Gates:
  //   - feature flag MIDEN_USE_SPECULATIVE_PROVING
  //   - extension context only (intercom doesn't exist on mobile/desktop)
  //   - global setting must be local proving (delegate path is just an RPC)
  //   - form must be valid (recipient is a Miden address, amount > 0
  //     and <= balance)
  //   - skip when recallBlocks is set (block-height drift between
  //     speculate-time and commit-time would invalidate the cached
  //     reclaim height — corner case, easier to skip than handle)
  useEffect(() => {
    if (process.env.MIDEN_USE_SPECULATIVE_PROVING !== 'true') return;
    if (!isExtension()) return;
    if (delegateEnabled) return; // delegated proving — no point speculating
    if (!publicKey || !recipientAddress || !token || !amount) return;
    if (recallBlocks) return;
    if (!isValidMidenAddress(recipientAddress)) return;
    const amountFloat = parseFloat(amount);
    if (!(amountFloat > 0)) return;
    if (amountFloat > token.balance) return;
    let amountBig: bigint;
    try {
      amountBig = stringToBigInt(amount, token.decimals);
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      requestSpeculateSend({
        accountId: publicKey,
        recipientAccountId: recipientAddress,
        faucetId: token.id,
        noteType: sharePrivately ? 'private' : 'public',
        amount: amountBig
      });
    }, 500);
    return () => {
      // Clear the debounced trigger if deps change before it fires.
      // We do NOT call requestSpeculateInvalidate here — the in-SW
      // SpeculationManager already replaces pending on each new
      // speculate() and discards stale active results. Invalidating on
      // every keystroke would defeat the cache.
      clearTimeout(timer);
    };
  }, [delegateEnabled, publicKey, recipientAddress, token, amount, sharePrivately, recallBlocks]);

  // One-time invalidation when the SendManager unmounts entirely (user
  // backs out of the send flow, or the tab closes). Drops any cached
  // completed entry and marks any active as stale so we don't carry
  // speculative state into a future send.
  useEffect(() => {
    if (process.env.MIDEN_USE_SPECULATIVE_PROVING !== 'true') return;
    if (!isExtension()) return;
    return () => {
      requestSpeculateInvalidate();
    };
  }, []);

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
