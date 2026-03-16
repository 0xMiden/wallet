import React, { useCallback, useEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import { useAppEnv } from 'app/env';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { CardItem } from 'components/CardItem';
import { NavigationHeader } from 'components/NavigationHeader';
import { QRCode } from 'components/QRCode';
import { SyncWaveBackground } from 'components/SyncWaveBackground';
import { formatBigInt } from 'lib/i18n/numbers';
import {
  getFailedTransactions,
  getUncompletedTransactions,
  initiateConsumeTransaction,
  verifyStuckTransactionsFromNode,
  waitForConsumeTx
} from 'lib/miden/activity';
import { AssetMetadata, useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { ConsumableNote } from 'lib/miden/types';
import { isMobile } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { goBack, HistoryAction, navigate, useLocation } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

export interface ReceiveProps {}

export const Receive: React.FC<ReceiveProps> = () => {
  const { t } = useTranslation();
  const { search } = useLocation();
  const account = useAccount();
  const address = account.publicKey;

  // Check if opened from notification (should go back instead of home on close)
  const fromNotification = new URLSearchParams(search).get('fromNotification') === 'true';
  const { fieldRef, copy, copied } = useCopyToClipboard();
  const { data: claimableNotes, mutate: mutateClaimableNotes } = useClaimableNotes(address);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();
  const { popup, fullPage } = useAppEnv();
  const safeClaimableNotes = (claimableNotes ?? []).filter((n): n is NonNullable<typeof n> => n != null);
  const [claimingNoteIds, setClaimingNoteIds] = useState<Set<string>>(new Set());
  // Track individual note claiming states reported by child components
  const [individualClaimingIds, setIndividualClaimingIds] = useState<Set<string>>(new Set());
  // Track notes that failed during Claim All
  const [failedNoteIds, setFailedNoteIds] = useState<Set<string>>(new Set());
  // Track notes being checked for state from node
  const [checkingNoteIds, setCheckingNoteIds] = useState<Set<string>>(new Set());
  const claimAllAbortRef = useRef<AbortController | null>(null);

  // Callback for child components to report their claiming state
  const handleClaimingStateChange = useCallback((noteId: string, isClaiming: boolean) => {
    setIndividualClaimingIds(prev => {
      const next = new Set(prev);
      if (isClaiming) {
        next.add(noteId);
      } else {
        next.delete(noteId);
      }
      return next;
    });
  }, []);

  // Notes that are not currently being claimed (available for "Claim All")
  // A note is claimable if it's not being claimed via:
  // - IndexedDB (isBeingClaimed) - from previous sessions or after tx queued
  // - Claim All operation (claimingNoteIds) - current batch operation
  // - Individual claim (individualClaimingIds) - user clicked single Claim button
  const unclaimedNotes = safeClaimableNotes.filter(
    n => !n.isBeingClaimed && !claimingNoteIds.has(n.id) && !individualClaimingIds.has(n.id)
  );

  useEffect(() => {
    return () => {
      claimAllAbortRef.current?.abort();
    };
  }, []);

  // Poll for stuck transactions and verify their state from the node
  useEffect(() => {
    const checkStuckTransactions = async () => {
      const resolved = await verifyStuckTransactionsFromNode();
      if (resolved > 0) {
        // Refresh claimable notes if any transactions were resolved
        mutateClaimableNotes();
      }
    };

    // Check immediately on mount
    checkStuckTransactions();

    // Then poll every 3 seconds
    const interval = setInterval(checkStuckTransactions, 3000);
    return () => clearInterval(interval);
  }, [mutateClaimableNotes]);

  // Check for failed notes: both from local IndexedDB and node state (only once on mount)
  const hasCheckedFailedNotes = useRef(false);
  useEffect(() => {
    const checkFailedNotes = async () => {
      if (safeClaimableNotes.length === 0) return;
      if (hasCheckedFailedNotes.current) return;
      hasCheckedFailedNotes.current = true;

      // Show loading wave on all notes while checking
      const noteIdsToCheck = new Set(safeClaimableNotes.map(n => n.id));
      setCheckingNoteIds(noteIdsToCheck);

      const failedIds = new Set<string>();

      try {
        // 1. Check local IndexedDB for failed consume transactions
        const failedTxs = await getFailedTransactions();
        for (const tx of failedTxs) {
          if (tx.type === 'consume' && tx.noteId) {
            failedIds.add(tx.noteId);
          }
        }

        // 2. Check node state for Invalid notes
        try {
          const { InputNoteState, NoteFilter, NoteFilterTypes, NoteId } = await import('@miden-sdk/miden-sdk');
          const noteIds = safeClaimableNotes.map(n => NoteId.fromHex(n.id));
          const noteDetails = await withWasmClientLock(async () => {
            const midenClient = await getMidenClient();
            const noteFilter = new NoteFilter(NoteFilterTypes.List, noteIds);
            return await midenClient.getInputNoteDetails(noteFilter);
          });

          for (const note of noteDetails) {
            if (note.state === InputNoteState.Invalid) {
              failedIds.add(note.noteId);
            }
          }
        } catch (err) {
          console.error('[Receive] Error checking node state for notes:', err);
        }

        // Only include notes that are still claimable (shown in UI)
        const claimableNoteIds = new Set(safeClaimableNotes.map(n => n.id));
        const failedClaimableNotes = new Set([...failedIds].filter(id => claimableNoteIds.has(id)));

        if (failedClaimableNotes.size > 0) {
          setFailedNoteIds(prev => new Set([...prev, ...failedClaimableNotes]));
        }
      } finally {
        setCheckingNoteIds(new Set());
      }
    };

    checkFailedNotes();
  }, [safeClaimableNotes]);

  const handleClaimAll = useCallback(async () => {
    if (unclaimedNotes.length === 0) return;

    claimAllAbortRef.current?.abort();
    claimAllAbortRef.current = new AbortController();
    const signal = claimAllAbortRef.current.signal;

    // Refresh the claimable notes list before queueing to avoid race conditions
    // with auto-consume (Explore page may have already started claiming some notes)
    const freshNotes = await mutateClaimableNotes();
    const freshUnclaimedNotes = (freshNotes ?? []).filter(
      n => n && !n.isBeingClaimed && !claimingNoteIds.has(n.id) && !individualClaimingIds.has(n.id)
    );

    if (freshUnclaimedNotes.length === 0) {
      // All notes are already being claimed (likely by auto-consume)
      return;
    }

    // Mark unclaimed notes as being claimed
    const noteIds = freshUnclaimedNotes.map(n => n!.id);
    setClaimingNoteIds(new Set(noteIds));

    // Track results
    let succeeded = 0;
    let failed = 0;
    let queueFailed = 0;

    // Clear previous failures
    setFailedNoteIds(new Set());

    try {
      // Queue all transactions first, before opening loading page
      // This ensures all notes get queued even if the popup closes
      const transactionIds: { noteId: string; txId: string }[] = [];
      for (const note of freshUnclaimedNotes) {
        try {
          const id = await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);
          transactionIds.push({ noteId: note.id, txId: id });
        } catch (err) {
          console.error('Error queuing note for claim:', note.id, err);
          queueFailed++;
          // Mark as failed and remove from claiming set
          setFailedNoteIds(prev => new Set(prev).add(note.id));
          setClaimingNoteIds(prev => {
            const next = new Set(prev);
            next.delete(note.id);
            return next;
          });
        }
      }

      // Open loading page (popup stays open since tab is not active)
      useWalletStore.getState().openTransactionModal();

      // Wait for all transactions to complete
      for (const { noteId, txId } of transactionIds) {
        if (signal.aborted) break;
        try {
          await waitForConsumeTx(txId, signal);
          succeeded++;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            break;
          }
          console.error('Error waiting for transaction:', txId, err);
          failed++;
          // Mark this note as failed
          setFailedNoteIds(prev => new Set(prev).add(noteId));
        }
        // Note: Don't remove from claimingNoteIds here - keep spinner visible
        // until mutateClaimableNotes() refreshes the list and removes the note
      }

      // Refresh the list - this will remove successfully claimed notes
      await mutateClaimableNotes();

      // Navigate to home on mobile after claiming all notes (only if all succeeded)
      failed += queueFailed;
      if (isMobile() && failed === 0) {
        navigate('/', HistoryAction.Replace);
      }
    } finally {
      setClaimingNoteIds(new Set());
    }
  }, [
    unclaimedNotes,
    account.publicKey,
    isDelegatedProvingEnabled,
    mutateClaimableNotes,
    claimingNoteIds,
    individualClaimingIds
  ]);

  const handleClose = () => {
    if (fromNotification) {
      goBack();
    } else {
      navigate('/', HistoryAction.Replace);
    }
  };

  // Match SendManager's container sizing - use h-full to inherit from parent (body has safe area padding)
  const containerClass = isMobile()
    ? 'h-full w-full'
    : fullPage
      ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px] border rounded-3xl'
      : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-white')}>
      <NavigationHeader mode="close" title={t('receive')} onClose={handleClose} showBorder />
      <div className="flex-1 flex flex-col min-h-0" data-testid="receive-page">
        <FormField ref={fieldRef} value={address} style={{ display: 'none' }} />
        {/* Fixed top section - QR code */}
        <div className="flex-shrink-0">
          <div className="w-5/6 md:w-1/2 mx-auto pb-4 flex flex-col items-center">
            <QRCode address={address} size={80} onCopy={copy} className="w-full" />
            {copied && <p className="text-xs text-primary-500 mt-1 transition-opacity duration-200">{t('copied')}</p>}
          </div>
          <div className="w-5/6 md:w-1/2 mx-auto" style={{ borderBottom: '1px solid #E9EBEF' }}></div>
        </div>
        {/* Scrollable notes section */}
        <div className="flex-1 min-h-0 w-5/6 md:w-1/2 mx-auto py-4 flex flex-col">
          {safeClaimableNotes.length === 0 ? (
            <div className="flex flex-col items-center pt-20">
              <Icon name={IconName.Coins} size="xl" className="mb-3 text-gray-600" />
              <p className="text-sm text-center text-gray-600">{t('noNotesToClaim')}</p>
            </div>
          ) : (
            <>
              <p className="text-md text-gray-600 mb-4 flex-shrink-0">
                {t('readyToClaim', { count: safeClaimableNotes.length })}
              </p>
              {/* Scrollable notes container */}
              <div className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-0">
                {safeClaimableNotes.map(note => (
                  <ConsumableNoteComponent
                    key={note.id}
                    note={note}
                    mutateClaimableNotes={mutateClaimableNotes}
                    account={account}
                    isDelegatedProvingEnabled={isDelegatedProvingEnabled}
                    isClaimingFromParent={claimingNoteIds.has(note.id)}
                    hasFailedFromParent={failedNoteIds.has(note.id)}
                    isCheckingFromParent={checkingNoteIds.has(note.id)}
                    onClaimingStateChange={handleClaimingStateChange}
                  />
                ))}
              </div>
            </>
          )}
          {unclaimedNotes.length > 0 && (
            <div className="flex justify-center mt-4 pb-4 flex-shrink-0">
              <Button
                className="w-[120px] h-[40px] text-md"
                variant={ButtonVariant.Primary}
                onClick={handleClaimAll}
                title={t('claimAll')}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface ConsumableNoteProps {
  account: WalletAccount;
  note: NonNullable<ConsumableNote & { metadata: AssetMetadata }>;
  mutateClaimableNotes: ReturnType<typeof useClaimableNotes>['mutate'];
  isDelegatedProvingEnabled: boolean;
  isClaimingFromParent?: boolean;
  hasFailedFromParent?: boolean;
  isCheckingFromParent?: boolean;
  onClaimingStateChange?: (noteId: string, isClaiming: boolean) => void;
}

export const ConsumableNoteComponent = ({
  note,
  mutateClaimableNotes,
  account,
  isDelegatedProvingEnabled,
  isClaimingFromParent = false,
  hasFailedFromParent = false,
  isCheckingFromParent = false,
  onClaimingStateChange
}: ConsumableNoteProps) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(note.isBeingClaimed || false);
  const showSpinner = isLoading || isClaimingFromParent || isCheckingFromParent;
  const [error, setError] = useState<string | null>(null);
  const hasError = error || hasFailedFromParent;
  const abortControllerRef = useRef<AbortController | null>(null);
  // Track if we've verified the claim status to prevent sync effect from re-enabling loading
  const hasVerifiedClaimStatus = useRef(false);

  // Report claiming state changes to parent
  useEffect(() => {
    onClaimingStateChange?.(note.id, isLoading);
  }, [isLoading, note.id, onClaimingStateChange]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Sync isLoading state when note.isBeingClaimed changes (e.g., popup reopened with in-progress claim)
  // Skip if we've already verified the claim status (e.g., found no transaction in IndexedDB)
  useEffect(() => {
    if (note.isBeingClaimed && !isLoading && !hasVerifiedClaimStatus.current) {
      setIsLoading(true);
    }
  }, [note.isBeingClaimed, isLoading]);

  // Resume waiting for in-progress transaction when component mounts with isBeingClaimed
  useEffect(() => {
    if (!note.isBeingClaimed || abortControllerRef.current) {
      return;
    }

    const resumeWaiting = async () => {
      const uncompletedTxs = await getUncompletedTransactions(account.publicKey);
      const tx = uncompletedTxs.find(t => t.type === 'consume' && t.noteId === note.id);

      if (!tx) {
        // Transaction not found - it may have completed/failed already
        hasVerifiedClaimStatus.current = true;
        setIsLoading(false);
        return;
      }

      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      try {
        const txHash = await waitForConsumeTx(tx.id, signal);
        await mutateClaimableNotes();
        console.log('Successfully consumed note (resumed), tx hash:', txHash);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        hasVerifiedClaimStatus.current = true;
        setError('Failed to consume note. Please try again.');
        console.error('Error consuming note (resumed):', err);
      } finally {
        setIsLoading(false);
      }
    };

    resumeWaiting();
  }, [note.isBeingClaimed, note.id, account.publicKey, mutateClaimableNotes]);

  const handleConsume = useCallback(async () => {
    setError(null);
    setIsLoading(true);

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    try {
      const id = await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);
      useWalletStore.getState().openTransactionModal();
      const txHash = await waitForConsumeTx(id, signal);
      const remainingNotes = await mutateClaimableNotes();
      console.log('Successfully consumed note, tx hash:', txHash);

      // Navigate to home on mobile if no more notes to claim
      if (isMobile() && (!remainingNotes || remainingNotes.length === 0)) {
        navigate('/', HistoryAction.Replace);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      setError('Failed to consume note. Please try again.');
      console.error('Error consuming note:', error);
    } finally {
      setIsLoading(false);
    }
  }, [account, isDelegatedProvingEnabled, mutateClaimableNotes, note]);
  const amountText = `${formatBigInt(BigInt(note.amount), note.metadata?.decimals || 6)} ${note.metadata?.symbol || 'UNKNOWN'}`;

  return (
    <div className="relative flex">
      <SyncWaveBackground isSyncing={showSpinner} className="rounded-lg" />
      <CardItem
        iconLeft={<Icon name={IconName.ArrowRightDownFilledCircle} size="lg" />}
        title={hasError ? `${t('error')}: ${amountText}` : amountText}
        subtitle={truncateAddress(note.senderAddress)}
        iconRight={
          !showSpinner ? (
            <Button
              className="w-[75px] h-[36px] text-md"
              variant={ButtonVariant.Primary}
              onClick={handleConsume}
              title={hasError ? t('retry') : t('claim')}
            />
          ) : undefined
        }
        className="flex-1 border border-grey-50 rounded-lg"
      />
    </div>
  );
};
