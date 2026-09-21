import React, { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { yupResolver } from '@hookform/resolvers/yup';
import { useForm } from 'react-hook-form';
import * as yup from 'yup';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { useHomePaneSubPage } from 'app/layouts/home-pane-subpage';
import { HomeGroupPaneRoot } from 'app/layouts/HomeGroupPane';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { stringToBigInt } from 'lib/i18n/numbers';
import { hasNoFeeAsset, maxSendableNative } from 'lib/miden/fees/spendable';
import { useAccount, useAllAccounts, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isMobile } from 'lib/platform';
import { isScanAvailable, scanQRCode } from 'lib/qr';
import { useWalletStore } from 'lib/store';
import { navigate, useLocation } from 'lib/woozie';
import {
  detectAddressChain,
  isValidEthereumAddress,
  isValidMidenAddress,
  isValidRecipientAddress,
  MidenAddressError
} from 'utils/miden';

import { AccountsListDrawer } from './AccountsList';
import { AddContactDrawer } from './AddContactDrawer';
import { BRIDGE_NETWORKS, BridgeNetworkId, SendNetworkId } from './bridge-networks';
import { ScanQrDrawer } from './ScanQrDrawer';
import { SelectRecipient } from './SelectRecipient';
import { SelectTokenDrawer } from './SelectToken';
import { consumeSendDraft, SendDraft, setSendDraft } from './send-draft';
import { SendAmount } from './SendAmount';
import { SendRoute } from './SendRoute';
import {
  BridgeRoute,
  Contact,
  RecentRecipient,
  SendFlowAction,
  SendFlowActionId,
  SendFlowForm,
  SendFlowStep,
  UIToken
} from './types';
import { useEpochQuote } from './useEpochQuote';
import { useRecentRecipients } from './useRecentRecipients';
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
  /** Recipient handed over by a contact's page, with its saved network for a `0x` contact. */
  preselectedRecipient?: string | null;
  preselectedNetwork?: string | null;
}

export const SendManager: React.FC<SendManagerProps> = ({
  preselectedTokenId,
  draft,
  preselectedRecipient,
  preselectedNetwork
}) => {
  const { navigateTo, goBack, cardStack } = useNavigator();
  const { pathname } = useLocation();
  const allAccounts = useAllAccounts();
  const { publicKey } = useAccount();

  const { contacts: addressBookContacts } = useFilteredContacts();

  // Token picker is a bottom sheet over the Amount step, not a Navigator step.
  const [showTokenDrawer, setShowTokenDrawer] = useState(false);
  // Contact picker is likewise a bottom sheet over the recipient step.
  const [showContactsDrawer, setShowContactsDrawer] = useState(false);
  // EVM destination networks are selected in a bottom sheet from the recipient step.
  // Saving an unknown-but-valid recipient to the address book, also a bottom sheet.
  const [showAddContactDrawer, setShowAddContactDrawer] = useState(false);
  // Extension-only: the webcam QR scanner is a bottom sheet over the recipient
  // step (mobile scans through its native plugin instead — see onScan below).
  const [showScanDrawer, setShowScanDrawer] = useState(false);
  // Retain a choice made before the address determines whether the send is Miden or EVM.
  const [recipientNetwork, setRecipientNetwork] = useState<SendNetworkId>();

  // A step pushed over the recipient takes over the screen — no action bar above it, no tab bar
  // under it — the way Earn's routed vault detail does; its CTA then sits at the actual bottom.
  // Gated on the pathname because SendManager stays mounted inside HomeSwipeContainer even
  // when another home-group page is centered — without the gate, a send flow
  // left mid-step would strip the chrome off Overview too.
  const currentStep = cardStack[cardStack.length - 1]?.name;
  const pastRecipientStep = pathname === '/send' && currentStep !== SendFlowStep.SelectRecipient;
  useHomePaneSubPage(pastRecipientStep);

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
        contactType: 'external' as const,
        network: BRIDGE_NETWORKS.find(n => n.id === contact.network)?.id
      }));

    return [...walletContacts, ...externalContacts];
  }, [allAccounts, addressBookContacts, publicKey]);

  const onClose = useCallback(() => {
    navigate('/');
  }, []);

  // Receive, offered on the amount step when the account has no MIDEN for the fee.
  const onReceive = useCallback(() => navigate('/receive'), []);

  // On-screen back for the steps after the recipient. Same rule as the hardware
  // back below: pop a step, or close the flow if a step somehow is the root.
  const onStepBack = useCallback(() => {
    if (cardStack.length > 1) {
      goBack();
      return;
    }
    onClose();
  }, [cardStack.length, goBack, onClose]);

  // Handle mobile back button/gesture. Open bottom sheets close first;
  // otherwise back pops the Navigator step or exits the flow.
  useMobileBackHandler(() => {
    if (showAddContactDrawer) {
      setShowAddContactDrawer(false);
      return true;
    }
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
  }, [showAddContactDrawer, showContactsDrawer, showTokenDrawer, cardStack.length, goBack, onClose]);

  // Reset the leftover completion state on send-flow entry.
  //
  // `lastCompletedTxHash` is set by the send/swap success path and read by the
  // receipt view; entering /send is a clear "I'm starting a new transaction"
  // signal, so clear it (and, defensively, any `isTransactionModalOpen` flag —
  // the progress modal that used to consume it has been removed, so in practice
  // that branch no longer fires).
  //
  // Gated on `/send` (not run-once-on-mount): submit happens on the full-screen
  // `/send/review` route where TabLayout is unmounted, so the post-success
  // navigate('/') freshly mounts SendManager — a mount effect would instantly
  // null the Midenscan hash on the receipt.
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
  const displayedNetwork: SendNetworkId | undefined = recipientAddress?.trim()
    ? isBridge
      ? bridgeNetwork
      : 'miden'
    : recipientNetwork;
  const selectedContact = useMemo(() => {
    const normalizedAddress = recipientAddress?.trim().toLowerCase();
    if (!normalizedAddress) return undefined;
    return allContactsList.find(contact => contact.id.trim().toLowerCase() === normalizedAddress);
  }, [allContactsList, recipientAddress]);

  const isValidRecipient = !errors.recipientAddress && validations.recipientAddress.isValidSync(recipientAddress);
  // A valid address that isn't in the wallet or the address book can be saved
  // straight from the recipient step — the pill offers "Add to contacts?".
  const canAddContact = isValidRecipient && !selectedContact;

  // Previous recipients, resolved against the contact list for display names.
  const recentSendRecipients = useRecentRecipients(publicKey);
  const recents: RecentRecipient[] = useMemo(
    () =>
      recentSendRecipients.map(recipient => ({
        ...recipient,
        name: allContactsList.find(contact => contact.id.trim().toLowerCase() === recipient.address.toLowerCase())?.name
      })),
    [recentSendRecipients, allContactsList]
  );

  // A destination selected before typing can carry into an EVM address. Once a
  // non-empty Miden address is entered, the EVM destination is no longer meaningful.
  useEffect(() => {
    const hasRecipientAddress = !!recipientAddress?.trim();
    if (hasRecipientAddress && !isBridge && bridgeNetwork) {
      setValue('bridgeNetwork', undefined);
    }
    if (hasRecipientAddress && !isBridge && recipientNetwork !== 'miden') {
      setRecipientNetwork('miden');
    }
  }, [recipientAddress, isBridge, bridgeNetwork, recipientNetwork, setValue]);

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

  // E2E-only hook: mirror the forward-quote's state so the harness can assert on
  // WHY a quote is missing instead of on the "$" the fee happens to render.
  // `fastFeeUsd` below is undefined for three unrelated reasons — no token, no
  // amount, or no quote — and all three paint the same "—", so a test gated on
  // the rendered text cannot tell a quote-service outage from a token that never
  // loaded. `useEpochQuote` already captures the failure reason and nothing reads
  // it. Mirrors the __TEST_STORE__ / __TEST_SET_SHARE_PRIVATELY__ gate; zero
  // production impact.
  useEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__TEST_EPOCH_QUOTE__ = {
      enabled: isBridge,
      loading: epochQuote.loading,
      amount: epochQuote.amount ?? null,
      symbol: epochQuote.symbol ?? null,
      error: epochQuote.error ?? null,
      hasToken: !!token,
      hasAmount: amountBaseUnits != null,
      fiatPrice: token?.fiatPrice ?? null
    };
  }, [isBridge, epochQuote.loading, epochQuote.amount, epochQuote.symbol, epochQuote.error, token, amountBaseUnits]);

  // Fast-route fee = what the user sends (USD) minus the USDC they'd receive.
  const fastFeeUsd = useMemo(() => {
    if (!token || !amount || epochQuote.amount == null) return undefined;
    const input = parseFloat(amount) * token.fiatPrice;
    const output = parseFloat(epochQuote.amount);
    if (!isFinite(input) || !isFinite(output)) return undefined;
    return Math.max(0, input - output);
  }, [token, amount, epochQuote.amount]);

  // Pre-select token when navigating from token detail page
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData, isLoading: balancesLoading } = useAllBalances(publicKey, allTokensBaseMetadata);
  const nativeFaucetId = useMidenFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
  useEffect(() => {
    if (!preselectedTokenId || !balanceData) return;
    const match = balanceData.find(t => t.tokenId === preselectedTokenId);
    if (!match) return;
    const uiToken: UIToken = {
      id: match.tokenId,
      name: match.metadata.symbol,
      decimals: match.metadata.decimals,
      balance: match.balance,
      fiatPrice: match.fiatPrice,
      scaleIsKnown: hasKnownScale(match.metadata)
    };
    setValue('token', uiToken);
  }, [preselectedTokenId, balanceData, setValue]);

  // What the user may actually send. The fee is withdrawn from this account's own
  // vault, so the full NATIVE balance is not spendable -- a send of everything is
  // accepted here and then fails in the epilogue on its own fee, which is the failure
  // `maxSendableNative` exists to prevent and which nothing was calling it to prevent.
  // Non-native tokens are unaffected (their fee comes out of a different asset), and
  // `maxSendableNative` fails open on an unknown or zero fee, so a zero-fee chain and
  // the pre-discovery window both keep the full balance.
  const spendableBalance = useMemo(() => {
    if (!token) return 0;
    return nativeFaucetId !== null && token.id === nativeFaucetId
      ? maxSendableNative(token.balance, verificationBaseFee, token.decimals)
      : token.balance;
  }, [token, nativeFaucetId, verificationBaseFee]);

  // Shown on the Amount step so the quoted "Available" is the number the validation
  // below actually enforces. The form's own `token` keeps the true balance, which is
  // what review and submit read.
  const spendableToken = useMemo(
    () => (token ? { ...token, balance: spendableBalance } : token),
    [token, spendableBalance]
  );

  // Re-validate the amount whenever the selected token changes. In the new
  // flow the user can type an amount before picking a token, so the balance
  // check in onAmountChange may have run with no token (or a different one).
  // Without this, an over-balance amount could reach Review with Confirm
  // still enabled.
  useEffect(() => {
    // A resolved fee shortfall matters before typing, but the balance hook's
    // initial zero is a loading placeholder, not evidence of missing MIDEN.
    if (!balancesLoading && hasNoFeeAsset(balanceData ?? [], nativeFaucetId, verificationBaseFee)) {
      setError('amount', { type: 'manual', message: 'insufficientFeeAsset' });
      return;
    }
    if (amount === undefined) {
      // Clear a previous shortfall once funds arrive, even before typing.
      // A cleared field ('') still follows the invalid-amount path below.
      if (errors.amount) clearErrors('amount');
      return;
    }
    if (!validations.amount.isValidSync(amount)) {
      setError('amount', { type: 'manual', message: 'invalidAmount' });
    } else if (token && parseFloat(amount) > spendableBalance) {
      // Between one base fee and the 30x reserve the whole native balance is held back,
      // so `Available` reads 0 and "amount must be less than balance" is true but useless:
      // the user sees a balance and no amount clears the check. `hasNoFeeAsset` above
      // refuses only BELOW one base fee, and that asymmetry is deliberate — so name the
      // reserve here rather than widen the refusal.
      const reserveHoldsWholeBalance = spendableBalance <= 0 && (token?.balance ?? 0) > 0;
      setError('amount', {
        type: 'manual',
        message: reserveHoldsWholeBalance ? 'feeReserveBlocksSend' : 'amountMustBeLessThanBalance'
      });
    } else {
      clearErrors('amount');
    }
    // Also re-run when the balances or the chain's fee resolve: both arrive
    // asynchronously, so an amount typed before they landed was validated against an
    // empty balance list and an unknown fee and then never re-checked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, spendableBalance, balanceData, balancesLoading, nativeFaucetId, verificationBaseFee]);

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

  // Chain-aware address validation: 0x → Ethereum (hex + EIP-55), otherwise a
  // strict Miden bech32 decode via the SDK. The error copy matches the detected
  // chain, and a well-formed address for a different Miden network gets its own
  // message instead of failing later in the transaction pipeline.
  const recipientErrorKey = useCallback(
    (raw: string): string | null => {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      if (detectAddressChain(trimmed) === 'ethereum') {
        return isValidEthereumAddress(trimmed) ? null : 'invalidEthereumAddress';
      }
      // Self-send guard: a P2IDE to yourself consumes through the kernel's
      // target branch, so recall semantics are meaningless and auto-consume
      // would claim it right back. Block it at entry, before the decode check —
      // it's the more specific message for the account's own address.
      if (sameWalletAccountId(trimmed, publicKey)) return 'cannotSendToSelf';
      try {
        isValidMidenAddress(trimmed);
      } catch (error) {
        return error instanceof MidenAddressError && error.reason === 'wrong-network'
          ? 'midenAddressWrongNetwork'
          : 'invalidMidenAccountId';
      }
      return null;
    },
    [publicKey]
  );

  const applyRecipientValidation = useCallback(
    (address: string) => {
      const errorKey = recipientErrorKey(address);
      if (errorKey) {
        setError('recipientAddress', { type: 'manual', message: errorKey });
      } else {
        clearErrors('recipientAddress');
      }
    },
    [recipientErrorKey, setError, clearErrors]
  );

  const onAddressChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const address = event.target.value;
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recipientAddress: address }
      });
      applyRecipientValidation(address);
    },
    [onAction, applyRecipientValidation]
  );

  // Apply a scanned recipient address. Shared by the mobile native scanner and
  // the extension webcam drawer so both go through the same validation — scanning
  // your own receive QR is the easy way to self-send, and a QR from another
  // network's wallet should surface the wrong-network message here.
  const applyScannedAddress = useCallback(
    (address: string) => {
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recipientAddress: address }
      });
      applyRecipientValidation(address);
    },
    [onAction, applyRecipientValidation]
  );

  // Surface a scan error (from either scan path) on the recipient field.
  const applyScanError = useCallback(
    (errorKey: string) => {
      setError('recipientAddress', { type: 'manual', message: errorKey });
    },
    [setError]
  );

  // Mobile: the native barcode plugin (iOS Swift / Android npm) returns a single
  // scan result. The extension has no such plugin — it opens the webcam drawer.
  const runNativeScan = useCallback(async () => {
    const result = await scanQRCode();
    if (result.success && result.address) {
      applyScannedAddress(result.address);
    } else if (result.errorKey && result.errorKey !== 'scanCancelled') {
      applyScanError(result.errorKey);
    }
  }, [applyScannedAddress, applyScanError]);

  const openScanDrawer = useCallback(() => setShowScanDrawer(true), []);

  // Paste goes through the scanned-address path so a pasted address gets the same validation and
  // wrong-network messaging as a scan. Mobile only, gated like the scanner below: the native
  // clipboard is the one read that works. A WebView's own readText() raises the platform's paste
  // callout rather than returning text, and in the extension it never settles at all, because the
  // manifest holds clipboardWrite and not clipboardRead — so a pill there would do nothing, with
  // no way to report it. Off mobile the field is a textarea and the platform's own paste works.
  // Only text is used: an image on the pasteboard comes back as a base64 data URL in `value`.
  const onPaste = useCallback(async () => {
    try {
      const { value, type } = await Clipboard.read();
      const text = type?.startsWith('text') ? value.trim() : '';
      if (text) applyScannedAddress(text);
    } catch {
      // An empty clipboard or a refused system prompt leaves the field as it is; both are the
      // user's own doing, so neither needs a message.
    }
  }, [applyScannedAddress]);

  const onScan = isMobile() ? runNativeScan : openScanDrawer;

  const onSelectContact = useCallback(
    (contact: Contact) => {
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: contact.network
          ? { recipientAddress: contact.id, bridgeNetwork: contact.network }
          : { recipientAddress: contact.id }
      });
      // A `0x` contact carries its destination network, so the network chips come up chosen.
      if (contact.network) setRecipientNetwork(contact.network);
      // A saved contact can be the account's own address — same guard as typed entry.
      applyRecipientValidation(contact.id);
    },
    [onAction, applyRecipientValidation]
  );

  // Opened from a contact's page (`/send?to=…&network=…`): start with that contact as the recipient.
  useEffect(() => {
    if (!preselectedRecipient) return;
    const network = BRIDGE_NETWORKS.find(n => n.id === preselectedNetwork)?.id;
    onAction({
      id: SendFlowActionId.SetFormValues,
      payload: network
        ? { recipientAddress: preselectedRecipient, bridgeNetwork: network }
        : { recipientAddress: preselectedRecipient }
    });
    if (network) setRecipientNetwork(network);
    applyRecipientValidation(preselectedRecipient);
    // Once per contact opened, not on every change of the callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectedRecipient, preselectedNetwork]);

  // A 0x recipient's destination network, picked from the chips on the recipient step.
  const onSelectNetwork = useCallback(
    (network: BridgeNetworkId) => {
      setRecipientNetwork(network);
      onAction({ id: SendFlowActionId.SetFormValues, payload: { bridgeNetwork: network } });
    },
    [onAction]
  );

  // While there is a single bridge network there is nothing to choose, so a valid 0x recipient
  // gets it selected; the recipient step shows it as a fact and Confirm is ready.
  useEffect(() => {
    const only = BRIDGE_NETWORKS.length === 1 ? BRIDGE_NETWORKS[0] : undefined;
    if (only && isBridge && isValidRecipient && bridgeNetwork !== only.id) onSelectNetwork(only.id);
  }, [isBridge, isValidRecipient, bridgeNetwork, onSelectNetwork]);

  // A "Recent" row fills the recipient exactly like picking a contact does.
  const onSelectRecent = useCallback(
    (recipient: RecentRecipient) => {
      onAction({
        id: SendFlowActionId.SetFormValues,
        payload: { recipientAddress: recipient.address }
      });
      applyRecipientValidation(recipient.address);
    },
    [onAction, applyRecipientValidation]
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
      } else if (!balancesLoading && hasNoFeeAsset(balanceData ?? [], nativeFaucetId, verificationBaseFee)) {
        // The fee is taken from this account's own vault, so with no native
        // asset the transaction cannot succeed however small the amount.
        setError('amount', { type: 'manual', message: 'insufficientFeeAsset' });
      } else if (token && amount > spendableBalance) {
        // Between one base fee and the 30x reserve the whole native balance is held back,
        // so `Available` reads 0 and "amount must be less than balance" is true but useless:
        // the user sees a balance and no amount clears the check. `hasNoFeeAsset` above
        // refuses only BELOW one base fee, and that asymmetry is deliberate — so name the
        // reserve here rather than widen the refusal.
        const reserveHoldsWholeBalance = spendableBalance <= 0 && (token?.balance ?? 0) > 0;
        setError('amount', {
          type: 'manual',
          message: reserveHoldsWholeBalance ? 'feeReserveBlocksSend' : 'amountMustBeLessThanBalance'
        });
      } else {
        clearErrors('amount');
      }
    },
    [
      onAction,
      token,
      setError,
      clearErrors,
      // The fee-reserved cap, not the raw balance (see `spendableBalance`).
      spendableBalance,
      // These feed the `insufficientFeeAsset` branch above. Omitted, the check
      // runs against first-render values -- an empty balance list and an unresolved
      // base fee -- so it either blocks a send that can pay its fee or admits one
      // that cannot, and the amount field's error stops tracking reality.
      balanceData,
      balancesLoading,
      nativeFaucetId,
      verificationBaseFee
    ]
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
              isValidAddress={isValidRecipient}
              error={errors.recipientAddress?.message?.toString()}
              chain={chain}
              network={displayedNetwork}
              recipientName={selectedContact?.name}
              recents={recents}
              canAddContact={canAddContact}
              onAddressChange={onAddressChange}
              onAddressBook={() => setShowContactsDrawer(true)}
              onAddContact={() => setShowAddContactDrawer(true)}
              onSelectRecent={onSelectRecent}
              onSelectNetwork={onSelectNetwork}
              onScan={isScanAvailable() ? onScan : undefined}
              onPaste={isMobile() ? onPaste : undefined}
              onConfirm={() => goToStep(SendFlowStep.SelectAmount)}
            />
          );
        case SendFlowStep.SelectAmount:
          return (
            <SendAmount
              token={spendableToken}
              amount={amount || ''}
              isValidAmount={!errors.amount && validations.amount.isValidSync(amount)}
              error={errors.amount?.message?.toString()}
              recipientAddress={recipientAddress || ''}
              recipientName={selectedContact?.name}
              network={displayedNetwork}
              onAmountChange={onAmountChange}
              onSelectToken={() => setShowTokenDrawer(true)}
              onReceive={onReceive}
              onBack={onStepBack}
              onConfirm={onConfirmAmount}
            />
          );
        case SendFlowStep.Route:
          return (
            <SendRoute
              route={bridgeRoute ?? 'epoch'}
              onRouteChange={onRouteChange}
              fastFeeUsd={fastFeeUsd}
              fastQuoteLoading={epochQuote.loading}
              onBack={onStepBack}
              onConfirm={goToReview}
            />
          );
        default:
          return <></>;
      }
    },
    [
      // Rendered as the Amount step's quoted balance. Omitted, the step keeps the
      // first-render cap -- the full balance, before the fee resolved. `token` itself
      // is no longer a dependency: it reaches the render only through this value.
      spendableToken,
      recipientAddress,
      isValidRecipient,
      recents,
      canAddContact,
      onSelectRecent,
      onPaste,
      errors.recipientAddress,
      errors.amount,
      onAddressChange,
      onScan,
      amount,
      onAmountChange,
      goToStep,
      onConfirmAmount,
      onStepBack,
      onSelectNetwork,
      onReceive,
      chain,
      displayedNetwork,
      selectedContact?.name,
      bridgeRoute,
      onRouteChange,
      fastFeeUsd,
      epochQuote.loading,
      goToReview
    ]
  );

  return (
    // The shared home-group pane box. SendManager is rendered inside TabLayout >
    // HomeSwipeContainer and inherits its size from that chain: hardcoded heights
    // (h-[600px]/h-[640px]) overflow the parent, which loses ~50px to the top action bar, and
    // clip the bottom CTA.
    <HomeGroupPaneRoot testId="send-flow">
      <Navigator renderRoute={renderStep} />

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

      <AddContactDrawer
        open={showAddContactDrawer}
        onOpenChange={setShowAddContactDrawer}
        address={recipientAddress ?? ''}
        network={isBridge ? bridgeNetwork : undefined}
      />

      <ScanQrDrawer
        open={showScanDrawer}
        onOpenChange={setShowScanDrawer}
        onDetected={applyScannedAddress}
        onError={applyScanError}
      />
    </HomeGroupPaneRoot>
  );
};

const NavigatorWrapper: React.FC<{ isLoading: boolean }> = props => {
  const { search } = useLocation();
  // One-shot: a draft exists only when the user backed out of /send/review.
  // Restore their values and reopen on the Amount step; the token restores
  // through the preselect effect via its id.
  const [draft] = useState(consumeSendDraft);
  const params = new URLSearchParams(search);
  const preselectedTokenId = draft?.tokenId ?? params.get('tokenId');
  // A restored draft already carries its recipient.
  const preselectedRecipient = draft ? null : params.get('to');
  const preselectedNetwork = draft ? null : params.get('network');
  // Otherwise start at recipient selection; a preselected token just pre-fills
  // the token for the Amount step (see the preselect effect in SendManager).
  // A restored draft reopens on Amount with Recipient beneath it, so back returns
  // to the (prefilled) address instead of closing the flow. Starting the stack at
  // Amount alone left no way back to the address: back closed the flow, and the
  // still-mounted Send pane reopened on Amount.
  const initialRoutes = draft
    ? [SendFlowStep.SelectRecipient, SendFlowStep.SelectAmount]
    : [SendFlowStep.SelectRecipient];

  return (
    <NavigatorProvider routes={ROUTES} initialRouteNames={initialRoutes}>
      <SendManager
        {...props}
        preselectedTokenId={preselectedTokenId}
        draft={draft}
        preselectedRecipient={preselectedRecipient}
        preselectedNetwork={preselectedNetwork}
      />
    </NavigatorProvider>
  );
};

export { NavigatorWrapper as SendFlow };
