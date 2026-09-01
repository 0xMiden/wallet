import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { FundWalletDrawer } from 'app/templates/FundWalletDrawer';
import { GuardianNeedsUrlBanner } from 'app/templates/GuardianNeedsUrlBanner';
import { PromptCard, PromptCardStatus, PromptCarousel, PromptCardVariant } from 'components/ui';
import { formatUsd } from 'lib/i18n/numbers';
import { initiateReplaceHotKeyTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { hasNoFeeAsset } from 'lib/miden/fees/spendable';
import type { TokenBalanceData } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';
import type { TokenPrices } from 'lib/prices';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount } from 'lib/shared/types';
import {
  fetchActiveBridgePrompts,
  faucet,
  fetchHotKeyHardwareError,
  getAccountWalletPromptStatus,
  getPendingNotesUsdTotal,
  type PendingNoteValue,
  pollActiveBridgePrompts,
  useGuardianNoteRecoveryProgress,
  useWalletPromptStorage,
  WalletPromptStatus,
  WalletPromptType
} from 'lib/wallet-prompts';
import { navigate } from 'lib/woozie';

type PromptCardOverrides = {
  body?: string;
  status?: PromptCardStatus;
  onClick?: () => void;
  onAction?: () => void;
  onDismiss?: () => void;
  actionDisabled?: boolean;
};

type WalletPromptDefinition = {
  titleKey: string;
  bodyKey: string;
  route?: string;
  actionKey?: string;
  variant?: PromptCardVariant;
  dismissible: boolean;
};

const WALLET_PROMPT_DEFINITIONS: Record<WalletPromptType, WalletPromptDefinition> = {
  [WalletPromptType.GuardianNoteRecovery]: {
    titleKey: 'guardianNoteRecoveryPromptTitle',
    bodyKey: 'guardianNoteRecoveryTransportStep',
    dismissible: false
  },
  [WalletPromptType.Bridge]: {
    titleKey: 'bridgePromptTitle',
    bodyKey: 'bridgePromptBody',
    dismissible: true
  },
  [WalletPromptType.Faucet]: {
    titleKey: 'faucetPromptTitle',
    bodyKey: 'faucetPromptBody',
    actionKey: 'faucetPromptAction',
    dismissible: true
  },
  [WalletPromptType.PendingNotes]: {
    titleKey: 'pendingNotesPromptTitle',
    bodyKey: 'pendingNotesPromptBody',
    actionKey: 'pendingNotesPromptAction',
    dismissible: true
  },
  [WalletPromptType.VerifySeedPhrase]: {
    titleKey: 'verifySeedPhrasePromptTitle',
    bodyKey: 'verifySeedPhrasePromptBody',
    route: '/settings/verify-seed-phrase',
    variant: 'warning',
    dismissible: true
  },
  [WalletPromptType.HotKeyHardwareUnavailable]: {
    titleKey: 'hotKeyHardwareErrorPromptTitle',
    bodyKey: 'hotKeyHardwareErrorPromptBody',
    actionKey: 'hotKeyHardwareErrorPromptAction',
    variant: 'critical',
    dismissible: true
  },
  [WalletPromptType.HotKeyRotationNeeded]: {
    titleKey: 'hotKeyRotationPromptTitle',
    bodyKey: 'hotKeyRotationPromptBody',
    actionKey: 'hotKeyRotationPromptAction',
    variant: 'critical',
    dismissible: true
  }
};

// E2E hooks, kebab-case like every other testid in the tree. Only prompts a
// spec actually drives get one — deriving an id for the whole enum would leave
// four that nothing reads. Pending notes is driven by
// playwright/e2e/tests/group-claim.spec.ts.
const WALLET_PROMPT_TEST_IDS: Partial<Record<WalletPromptType, string>> = {
  [WalletPromptType.PendingNotes]: 'pending-notes-prompt'
};

const WALLET_PROMPT_ORDER = [
  WalletPromptType.GuardianNoteRecovery,
  WalletPromptType.PendingNotes,
  WalletPromptType.Bridge,
  WalletPromptType.HotKeyRotationNeeded,
  WalletPromptType.HotKeyHardwareUnavailable,
  WalletPromptType.Faucet,
  WalletPromptType.VerifySeedPhrase
] as const;

interface HomePromptsProps {
  account: WalletAccount;
  balances: TokenBalanceData[];
  balancesLoading: boolean;
  claimableNotes: readonly PendingNoteValue[] | undefined;
  tokenPrices: TokenPrices;
}

export const HomePrompts: FC<HomePromptsProps> = ({
  account,
  balances,
  balancesLoading,
  claimableNotes,
  tokenPrices
}) => {
  const { t } = useTranslation();
  const { storage, isLoaded, setPromptStatus, setAccountPromptStatus, dismissPrompt, completePrompt, isPromptPending } =
    useWalletPromptStorage();
  const [faucetStatusIndicator, setFaucetStatusIndicator] = useState<PromptCardStatus>('idle');
  const [fundDrawerOpen, setFundDrawerOpen] = useState(false);
  const [faucetErrorMessage, setFaucetErrorMessage] = useState<string>();

  const [hotKeyError, setHotKeyError] = useState<string | null>(null);
  const [copyStatusIndicator, setCopyStatusIndicator] = useState<PromptCardStatus>('idle');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [rotationStatusIndicator, setRotationStatusIndicator] = useState<PromptCardStatus>('idle');
  const rotatingRef = useRef(false);
  const [bridgeTransactions, setBridgeTransactions] = useState<string[]>([]);
  const noteRecoveryProgress = useGuardianNoteRecoveryProgress(
    account.guardianNoteRecoveryPending === true ? account.publicKey : null
  );
  const bridgePromptPending = isPromptPending(WalletPromptType.Bridge);
  const hotKeyPromptPending = isPromptPending(WalletPromptType.HotKeyHardwareUnavailable);
  const pendingNotesStatus = storage.prompts[WalletPromptType.PendingNotes];
  const pendingNoteIds = useMemo(() => claimableNotes?.map(note => note.id) ?? [], [claimableNotes]);
  const hasPendingNotes = pendingNoteIds.length > 0;
  // A dismiss hides the batch of note ids current at the time; the prompt
  // resurfaces once none of the currently-pending notes were in that batch.
  const hasDismissedBatchNote = useMemo(() => {
    if (pendingNotesStatus !== WalletPromptStatus.Dismissed) return false;
    const dismissedIds = new Set(storage.pendingNotesDismissedIds);
    return pendingNoteIds.some(noteId => dismissedIds.has(noteId));
  }, [pendingNoteIds, pendingNotesStatus, storage.pendingNotesDismissedIds]);
  const showPendingNotesPrompt = isLoaded && hasPendingNotes && !hasDismissedBatchNote;
  const formattedPendingNotesUsdTotal = useMemo(
    () => formatUsd(getPendingNotesUsdTotal(claimableNotes ?? [], tokenPrices)),
    [claimableNotes, tokenPrices]
  );

  // One localized line per recovery step; the public-backfill step carries the
  // live block progress the SW reports after each scanned chunk.
  const noteRecoveryBody = useMemo(() => {
    if (!noteRecoveryProgress) return undefined;
    switch (noteRecoveryProgress.step) {
      case 'transport':
        return t('guardianNoteRecoveryTransportStep');
      case 'proposals':
        return t('guardianNoteRecoveryProposalsStep');
      case 'public': {
        const { syncedToBlock, latestBlock } = noteRecoveryProgress;
        if (syncedToBlock === undefined || latestBlock === undefined) {
          return t('guardianNoteRecoveryPublicPreparingStep');
        }
        return t('guardianNoteRecoveryPublicStep', {
          current: syncedToBlock.toLocaleString(),
          latest: latestBlock.toLocaleString()
        });
      }
    }
  }, [noteRecoveryProgress, t]);

  const nativeFaucetId = useMidenFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
  // "Funded" has to mean "can transact". On a fee-charging chain that is the
  // NATIVE balance specifically -- an account holding only other tokens cannot
  // move them, so it still needs the faucet. `hasNoFeeAsset` fails open, so a
  // zero-fee chain keeps the original any-token behaviour.
  const hasBalance = useMemo(
    () => balances.some(token => token.balance > 0) && !hasNoFeeAsset(balances, nativeFaucetId, verificationBaseFee),
    [balances, nativeFaucetId, verificationBaseFee]
  );
  // Per account, not wallet-wide: each account funds itself, so one account's
  // "Fund now" outcome must not hide or complete the prompt on its siblings.
  // (The seed-phrase prompt stays wallet-wide — there is only one seed.)
  const faucetStatus = getAccountWalletPromptStatus(storage, account.publicKey, WalletPromptType.Faucet);
  // Dismiss means "not now", not "never again". An account that has run its native
  // balance to zero on a fee-charging chain cannot transact at all, and this prompt
  // is the way out -- so a previous dismissal stops suppressing it. Without the
  // re-arm the user is left stuck with no affordance anywhere on Home.
  const cannotPayFee = hasNoFeeAsset(balances, nativeFaucetId, verificationBaseFee);
  const faucetIsTerminal =
    !cannotPayFee && (faucetStatus === WalletPromptStatus.Dismissed || faucetStatus === WalletPromptStatus.Completed);
  const showFaucetPrompt = isLoaded && !balancesLoading && !hasBalance && !faucetIsTerminal;

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    []
  );

  useEffect(() => {
    if (!hotKeyPromptPending) return;
    let cancelled = false;
    fetchHotKeyHardwareError()
      .then(record => {
        if (!cancelled) setHotKeyError(record?.message ?? null);
      })
      .catch(error => {
        console.warn('[wallet-prompts] failed to load hot-key hardware error:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [hotKeyPromptPending]);

  useEffect(() => {
    if (!isLoaded || !bridgePromptPending) {
      setBridgeTransactions([]);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const active = await fetchActiveBridgePrompts(account.publicKey);
        if (cancelled) return;
        if (active.length === 0) {
          setBridgeTransactions([]);
          completePrompt(WalletPromptType.Bridge);
          return;
        }

        setBridgeTransactions(active.map(tx => tx.id));
        await pollActiveBridgePrompts(active);
        if (cancelled) return;
        const refreshed = await fetchActiveBridgePrompts(account.publicKey);
        if (cancelled) return;
        setBridgeTransactions(refreshed.map(tx => tx.id));
        if (refreshed.length === 0) {
          completePrompt(WalletPromptType.Bridge);
          return;
        }
      } catch (error) {
        console.warn('[wallet-prompts] bridge poll failed:', error);
      }
      if (!cancelled) timer = setTimeout(tick, 8000);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [account.publicKey, bridgePromptPending, completePrompt, isLoaded]);

  const copyHotKeyError = useCallback(() => {
    const text = hotKeyError ?? 'Hot-key secure hardware unavailable';
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopyStatusIndicator('success');
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopyStatusIndicator('idle'), 1500);
      })
      .catch(error => {
        console.error('[wallet-prompts] failed to copy hot-key error:', error);
        setCopyStatusIndicator('failure');
      });
  }, [hotKeyError]);

  // Rotation-needed prompt action: enqueue a replace-hot-key transaction and
  // route to the generating-transaction page (which drives the FIFO loop on
  // mobile/desktop; on extension the SW owns it). Mirrors ReviewTransaction's
  // initiate-then-navigate shape. The prompt completes on successful initiate —
  // if the rotation transaction itself later fails, the next failing sign
  // re-arms the prompt (see reportHotKeyRotationNeeded).
  const rotateHotKey = useCallback(async () => {
    if (rotatingRef.current) return;
    rotatingRef.current = true;
    setRotationStatusIndicator('loading');
    try {
      const txId = await initiateReplaceHotKeyTransaction(account.publicKey, isDelegateProofEnabled(), zustandProvider);
      completePrompt(WalletPromptType.HotKeyRotationNeeded);
      if (isExtension()) requestSWTransactionProcessing();
      navigate(`/generating-transaction/${txId}`);
    } catch (error) {
      console.error('[wallet-prompts] hot-key rotation initiate failed:', error);
      setRotationStatusIndicator('failure');
    } finally {
      rotatingRef.current = false;
    }
  }, [account.publicKey, completePrompt]);

  useEffect(() => {
    if (!isLoaded || balancesLoading) return;
    if (!hasBalance && faucetStatus === undefined) {
      setAccountPromptStatus(account.publicKey, WalletPromptType.Faucet, WalletPromptStatus.Pending);
    } else if (hasBalance && faucetStatus === WalletPromptStatus.Pending) {
      setAccountPromptStatus(account.publicKey, WalletPromptType.Faucet, WalletPromptStatus.Completed);
    }
  }, [account.publicKey, balancesLoading, faucetStatus, hasBalance, isLoaded, setAccountPromptStatus]);

  // Drives the FundWalletDrawer; doubles as the drawer's onRetry. The drawer
  // owns the success/failure surface now (no auto-idle timer) — it stays up
  // showing the outcome until the user acts (Done / Retry / Close).
  const fundWallet = useCallback(async () => {
    setFundDrawerOpen(true);
    setFaucetErrorMessage(undefined);
    setFaucetStatusIndicator('loading');
    try {
      await faucet(account.publicKey);
      setFaucetStatusIndicator('success');
      setAccountPromptStatus(account.publicKey, WalletPromptType.Faucet, WalletPromptStatus.Completed);
    } catch (error) {
      setFaucetStatusIndicator('failure');
      setFaucetErrorMessage(error instanceof Error ? error.message : String(error));
      console.error('[wallet-prompts] faucet request failed:', error);
    }
  }, [account.publicKey, setAccountPromptStatus]);

  // Map the internal indicator onto the drawer's 3-state contract. 'idle' is only
  // the initial pre-funding value; opening always goes through fundWallet (which
  // clears any stale error and sets 'loading' first), and we intentionally keep
  // the last outcome as the drawer animates closed — no synchronous reset — so a
  // dismiss gesture doesn't flash the spinner, and a close mid-request leaves the
  // indicator on 'loading' (keeping the Fund-now action disabled, no double-fund).
  const fundDrawerState: 'loading' | 'success' | 'error' =
    faucetStatusIndicator === 'success' ? 'success' : faucetStatusIndicator === 'failure' ? 'error' : 'loading';

  const pendingWalletPrompts = useMemo(() => {
    if (!isLoaded || balancesLoading) return [];
    return WALLET_PROMPT_ORDER.filter(type => {
      if (type === WalletPromptType.GuardianNoteRecovery) return noteRecoveryProgress !== null;
      if (type === WalletPromptType.PendingNotes) return showPendingNotesPrompt;
      if (type === WalletPromptType.Faucet) return showFaucetPrompt;
      if (type === WalletPromptType.Bridge) return bridgePromptPending && bridgeTransactions.length > 0;
      return isPromptPending(type);
    }).map<[WalletPromptType, WalletPromptDefinition]>(type => [type, WALLET_PROMPT_DEFINITIONS[type]]);
  }, [
    balancesLoading,
    bridgePromptPending,
    bridgeTransactions.length,
    isLoaded,
    isPromptPending,
    noteRecoveryProgress,
    showFaucetPrompt,
    showPendingNotesPrompt
  ]);

  // Per-type runtime behavior in one place; anything not set here falls back
  // to the static definition (route click, plain body, default dismiss).
  const promptOverrides = useCallback(
    (type: WalletPromptType): PromptCardOverrides => {
      switch (type) {
        case WalletPromptType.GuardianNoteRecovery:
          return {
            body: noteRecoveryBody,
            status: 'loading'
          };
        case WalletPromptType.Faucet:
          return {
            onAction: fundWallet,
            actionDisabled: faucetStatusIndicator === 'loading',
            onDismiss: () =>
              setAccountPromptStatus(account.publicKey, WalletPromptType.Faucet, WalletPromptStatus.Dismissed)
          };
        case WalletPromptType.Bridge:
          return {
            onClick: () => navigate(`/history-details/${bridgeTransactions[0]}`),
            status: 'loading'
          };
        case WalletPromptType.PendingNotes:
          return {
            onAction: () => navigate('/pending-notes'),
            body: t(WALLET_PROMPT_DEFINITIONS[type].bodyKey, { amount: formattedPendingNotesUsdTotal }),
            onDismiss: () => setPromptStatus(type, WalletPromptStatus.Dismissed, pendingNoteIds)
          };
        case WalletPromptType.HotKeyHardwareUnavailable:
          return {
            onAction: copyHotKeyError,
            status: copyStatusIndicator
          };
        case WalletPromptType.HotKeyRotationNeeded:
          return {
            onAction: rotateHotKey,
            status: rotationStatusIndicator,
            actionDisabled: rotationStatusIndicator === 'loading'
          };
        default:
          return {};
      }
    },
    [
      account.publicKey,
      bridgeTransactions,
      noteRecoveryBody,
      copyHotKeyError,
      copyStatusIndicator,
      faucetStatusIndicator,
      formattedPendingNotesUsdTotal,
      fundWallet,
      pendingNoteIds,
      rotateHotKey,
      rotationStatusIndicator,
      setAccountPromptStatus,
      setPromptStatus,
      t
    ]
  );

  return (
    <>
      <PromptCarousel>
        {pendingWalletPrompts.map(([type, definition]) => {
          const overrides = promptOverrides(type);
          const route = definition.route;
          const testId = WALLET_PROMPT_TEST_IDS[type];
          return (
            <PromptCard
              key={type}
              data-testid={testId}
              actionTestId={testId ? `${testId}-action` : undefined}
              title={t(definition.titleKey)}
              body={overrides.body ?? t(definition.bodyKey)}
              variant={definition.variant}
              onClick={overrides.onClick ?? (route && !overrides.onAction ? () => navigate(route) : undefined)}
              actionLabel={definition.actionKey ? t(definition.actionKey) : undefined}
              onAction={overrides.onAction}
              actionDisabled={overrides.actionDisabled ?? false}
              status={overrides.status}
              onDismiss={overrides.onDismiss ?? (definition.dismissible ? () => dismissPrompt(type) : undefined)}
            />
          );
        })}
        {account.guardianSyncStatus === 'needs-user-input' && <GuardianNeedsUrlBanner />}
      </PromptCarousel>
      <FundWalletDrawer
        open={fundDrawerOpen}
        onOpenChange={setFundDrawerOpen}
        state={fundDrawerState}
        errorMessage={faucetErrorMessage}
        onRetry={fundWallet}
        onDone={() => setFundDrawerOpen(false)}
      />
    </>
  );
};

export default HomePrompts;
