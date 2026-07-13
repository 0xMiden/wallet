import React, { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { yupResolver } from '@hookform/resolvers/yup';
import classNames from 'clsx';
import { useForm } from 'react-hook-form';
import * as yup from 'yup';

import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { MIDEN_AGGLAYER_FAUCET_ID } from 'lib/agglayer/b2agg/constant';
import { stringToBigInt } from 'lib/i18n/numbers';
import { requestSpeculateInvalidate, requestSpeculateSend } from 'lib/miden/activity';
import { useAccount, useAllAccounts, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate, useLocation } from 'lib/woozie';
import { detectAddressChain, isValidEthereumAddress, isValidMidenAddress, isValidRecipientAddress } from 'utils/miden';

import { AccountsListDrawer } from './AccountsList';
import { DEFAULT_BRIDGE_NETWORK } from './bridge-networks';
import { Route as RouteStep } from './Route';
import { SelectAmount } from './SelectAmount';
import { SelectRecipient } from './SelectRecipient';
import { SelectTokenDrawer } from './SelectToken';
import { consumeSendDraft, hasSendDraft, SendDraft, setSendDraft } from './send-draft';
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
    name: SendFlowStep.Route,
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
  // Chain-aware: a Miden bech32 address (same-chain) or a 0x address (bridge).
  recipientAddress: yup
    .string()
    .required()
    .test('is-valid-address', 'Invalid address', value => isValidRecipientAddress(value ?? ''))
};

const validationSchema = yup.object().shape(validations).required();

export interface SendManagerProps {
  isLoading: boolean;
  preselectedTokenId?: string | null;
  /** Values restored when the user backs out of the full-screen review page. */
  draft?: SendDraft | null;
}

export const SendManager: React.FC<SendManagerProps> = ({ preselectedTokenId, draft }) => {
  const { navigateTo, goBack, cardStack } = useNavigator();
  const { pathname } = useLocation();
  const allAccounts = useAllAccounts();
  const { publicKey } = useAccount();
  const delegateEnabled = isDelegateProofEnabled();

  const { contacts: addressBookContacts } = useFilteredContacts();

  // Token picker is a bottom sheet over the Amount step, not a Navigator step.
  const [showTokenDrawer, setShowTokenDrawer] = useState(false);
  // Contact picker is likewise a bottom sheet over the recipient step.
  const [showContactsDrawer, setShowContactsDrawer] = useState(false);

  // Hide the floating BottomNav once the user moves past recipient selection,
  // so the step CTAs can sit at the actual bottom of the screen. Gated on the
  // pathname because SendManager stays mounted inside HomeSwipeContainer even
  // when another home-group page is centered — without the gate, a send flow
  // left mid-step would hide the navbar on Overview too.
  const currentStep = cardStack[cardStack.length - 1]?.name;
  const pastRecipientStep = pathname === '/send' && currentStep !== SendFlowStep.SelectRecipient;
  useHideNavbarWhileOpen(pastRecipientStep);

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

  // Handle mobile back button/gesture. Open bottom sheets close first;
  // otherwise back pops the Navigator step or exits the flow.
  useMobileBackHandler(() => {
    if (showContactsDrawer) {
      setShowContactsDrawer(false);
      return true;
    }
    if (showTokenDrawer) {
      setShowTokenDrawer(false);
      return true;
    }
    if (cardStack.length > 1) {
      goBack(); // Go to previous step
      return true;
    }
    // On first step, close entire flow
    onClose();
    return true;
  }, [showContactsDrawer, showTokenDrawer, cardStack.length, goBack, onClose]);

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
  // equivalent to tapping Done on whatever was open. In-flight modals can't
  // reach this code path here because PR #217's `pathname`-watching effect in
  // the modal already auto-dismisses non-terminal opens on navigation away
  // from `settledPathname`, so the only `isTransactionModalOpen === true`
  // state reachable here is terminal.
  //
  // Gated on `/send` (not run-once-on-mount): submit now happens on the
  // full-screen `/send/review` route where TabLayout is unmounted, so the
  // post-success navigate('/') freshly mounts SendManager — a mount effect
  // would instantly dismiss the "Done" modal and null the Midenscan hash.
  useEffect(() => {
    if (pathname !== '/send') return;
    const state = useWalletStore.getState();
    if (state.isTransactionModalOpen) {
      state.closeTransactionModal(true);
    }
    if (state.lastCompletedTxHash !== null) {
      state.setLastCompletedTxHash(null);
    }
  }, [pathname]);

  const {
    register,
    watch,
    setError,
    clearErrors,
    setValue,
    trigger,
    formState: { errors }
  } = useForm<SendFlowForm>({
    defaultValues: {
      amount: draft?.amount,
      recipientAddress: draft?.recipientAddress,
      token: undefined,
      bridgeNetwork: draft?.bridgeNetwork,
      bridgeRoute: draft?.bridgeRoute ?? 'epoch'
    },
    resolver: yupResolver(validationSchema) as any
  });

  useEffect(() => {
    register('amount');
    register('recipientAddress');
    register('token');
    register('bridgeNetwork');
    register('bridgeRoute');
  }, [register]);

  const amount = watch('amount');
  const recipientAddress = watch('recipientAddress');
  const token = watch('token');
  const bridgeNetwork = watch('bridgeNetwork');
  const bridgeRoute = watch('bridgeRoute');

  // A 0x recipient routes through the bridge instead of a same-chain Miden send.
  const chain = detectAddressChain(recipientAddress ?? '');
  const isBridge = !!recipientAddress && chain === 'ethereum';

  // Cross-chain sends over the Slow (Agglayer) route are restricted to the single
  // bridgeable faucet token; Fast (Epoch) bridges any token.
  const isBridgeableToken =
    !!token && accountIdStringToSdk(token.id.toLowerCase()).toString() === MIDEN_AGGLAYER_FAUCET_ID.toLowerCase();

  // Default a cross-chain send to the only destination network (Sepolia) so the
  // recipient step shows it selected without an extra tap.
  useEffect(() => {
    if (isBridge && !bridgeNetwork) {
      setValue('bridgeNetwork', DEFAULT_BRIDGE_NETWORK.id);
    }
  }, [isBridge, bridgeNetwork, setValue]);

  // If Slow was selected and the token changes to one it can't bridge, fall back
  // to Fast so Review/submit don't dead-end on the bridgeable-token guard.
  useEffect(() => {
    if (isBridge && bridgeRoute === 'agglayer' && !isBridgeableToken) {
      setValue('bridgeRoute', 'epoch');
    }
  }, [isBridge, bridgeRoute, isBridgeableToken, setValue]);

  // Forward-quote the USDC output for the Fast (Epoch) route, so the Route
  // screen can show a live fee regardless of which route is selected.
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
  //
  // Known gap: the review page always seeds a 7-day recallBlocks, while this
  // speculation proves a no-recall tx — a guaranteed params-hash mismatch, so
  // the cached prove goes unused (one wasted prove per send). The flag is off
  // by default; carrying the seeded recallBlocks into the speculate request is
  // the fix if it's ever enabled.
  useEffect(() => {
    if (process.env.MIDEN_USE_SPECULATIVE_PROVING !== 'true') return;
    if (!isExtension()) return;
    if (delegateEnabled) return; // delegated proving — no point speculating
    if (!publicKey || !recipientAddress || !token || !amount) return;
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
        // Sends are private unless E2E flips the toggle — and that only
        // happens on the review page, where a cache miss just falls back to
        // a normal prove.
        noteType: 'private',
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
  }, [delegateEnabled, publicKey, recipientAddress, token, amount]);

  // One-time invalidation when the SendManager unmounts entirely (user
  // backs out of the send flow, or the tab closes). Drops any cached
  // completed entry and marks any active as stale so we don't carry
  // speculative state into a future send. Skipped when a draft is pending —
  // that unmount is the handoff to /send/review, which consumes the cache on
  // submit and owns invalidation from there.
  useEffect(() => {
    if (process.env.MIDEN_USE_SPECULATIVE_PROVING !== 'true') return;
    if (!isExtension()) return;
    return () => {
      if (!hasSendDraft()) {
        requestSpeculateInvalidate();
      }
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
        default:
          break;
      }
    },
    [navigateTo, goBack, onClose, setValue, trigger]
  );

  // Hand off to the full-screen review page, which owns the transaction
  // pipeline. The draft lets SendManager restore the form (on the Amount
  // step) when the user backs out of review — see send-draft.ts.
  //
  // A cross-chain send carries its network + route along, so the review page
  // can quote the Epoch output and pick the right submit path.
  const goToReview = useCallback(() => {
    if (!token || !amount || !recipientAddress) return;
    setSendDraft({
      amount,
      recipientAddress,
      tokenId: token.id,
      bridgeNetwork: isBridge ? bridgeNetwork : undefined,
      bridgeRoute: isBridge ? bridgeRoute : undefined
    });
    const params = new URLSearchParams({ amount, to: recipientAddress, tokenId: token.id });
    if (isBridge && bridgeNetwork) params.set('network', bridgeNetwork);
    if (isBridge && bridgeRoute) params.set('route', bridgeRoute);
    navigate(`/send/review?${params.toString()}`);
  }, [amount, recipientAddress, token, isBridge, bridgeNetwork, bridgeRoute]);

  // From the Amount screen: a cross-chain send picks a route next; a same-chain
  // Miden send goes straight to review.
  const onConfirmAmount = useCallback(() => {
    if (isBridge) {
      navigateTo(SendFlowStep.Route);
      return;
    }
    goToReview();
  }, [isBridge, navigateTo, goToReview]);

  const onRouteChange = useCallback(
    (route: BridgeRoute) => {
      onAction({ id: SendFlowActionId.SetFormValues, payload: { bridgeRoute: route } });
    },
    [onAction]
  );

  // Chain-aware address validation: 0x → Ethereum (hex), otherwise Miden bech32.
  // The error copy matches the detected chain so an Ethereum address no longer
  // shows the "Invalid Miden account ID" message.
  const onAddressChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const address = event.target.value;
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recipientAddress: address }
      });
      const trimmed = address.trim();
      if (!trimmed) {
        clearErrors('recipientAddress');
        return;
      }
      const addressChain = detectAddressChain(trimmed);
      const valid = addressChain === 'ethereum' ? isValidEthereumAddress(trimmed) : isValidMidenAddress(trimmed);
      if (valid) {
        clearErrors('recipientAddress');
      } else {
        setError('recipientAddress', {
          type: 'manual',
          message: addressChain === 'ethereum' ? 'invalidEthereumAddress' : 'invalidMidenAccountId'
        });
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

  const goToStep = useCallback(
    (step: SendFlowStep) => {
      onAction({ id: SendFlowActionId.Navigate, step });
    },
    [onAction]
  );

  const renderStep = useCallback(
    (route: Route) => {
      switch (route.name) {
        case SendFlowStep.SelectRecipient:
          return (
            <SelectRecipient
              address={recipientAddress || ''}
              isValidAddress={!errors.recipientAddress && validations.recipientAddress.isValidSync(recipientAddress)}
              error={errors.recipientAddress?.message?.toString()}
              chain={chain}
              network={bridgeNetwork}
              onNetworkChange={id => onAction({ id: SendFlowActionId.SetFormValues, payload: { bridgeNetwork: id } })}
              onAddressChange={onAddressChange}
              onAddressBook={() => setShowContactsDrawer(true)}
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
              footerClassName="pt-4 pb-6"
              onAmountChange={onAmountChange}
              onSelectToken={() => setShowTokenDrawer(true)}
              onConfirm={onConfirmAmount}
            />
          );
        case SendFlowStep.Route:
          return (
            <RouteStep
              route={bridgeRoute ?? 'epoch'}
              onRouteChange={onRouteChange}
              fastFeeUsd={fastFeeUsd}
              fastQuoteLoading={epochQuote.loading}
              slowEnabled={isBridgeableToken}
              onConfirm={goToReview}
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
      amount,
      onAmountChange,
      goToStep,
      onConfirmAmount,
      chain,
      bridgeNetwork,
      bridgeRoute,
      onAction,
      onRouteChange,
      fastFeeUsd,
      epochQuote.loading,
      isBridgeableToken,
      goToReview
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
      <div className="flex flex-col flex-1 h-full min-h-0">
        <Navigator renderRoute={renderStep} />
      </div>

      <SelectTokenDrawer
        open={showTokenDrawer}
        onOpenChange={setShowTokenDrawer}
        onSelect={selectedToken => onAction({ id: SendFlowActionId.SetFormValues, payload: { token: selectedToken } })}
      />

      <AccountsListDrawer
        open={showContactsDrawer}
        onOpenChange={setShowContactsDrawer}
        recipientAccountId={recipientAddress}
        accounts={allContactsList}
        onSelectContact={onSelectContact}
      />
    </div>
  );
};

const NavigatorWrapper: React.FC<{ isLoading: boolean }> = props => {
  const { search } = useLocation();
  // One-shot: a draft exists only when the user backed out of /send/review.
  // Restore their values and reopen on the Amount step; the token restores
  // through the preselect effect via its id.
  const [draft] = useState(consumeSendDraft);
  const preselectedTokenId = draft?.tokenId ?? new URLSearchParams(search).get('tokenId');
  // Otherwise always start at recipient selection; a preselected token just
  // pre-fills the token for the Amount step (see the preselect effect in
  // SendManager).
  const initialRoute = draft ? SendFlowStep.SelectAmount : SendFlowStep.SelectRecipient;

  return (
    <NavigatorProvider routes={ROUTES} initialRouteName={initialRoute}>
      <SendManager {...props} preselectedTokenId={preselectedTokenId} draft={draft} />
    </NavigatorProvider>
  );
};

export { NavigatorWrapper as SendFlow };
