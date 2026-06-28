import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';
import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { AddressTab } from 'app/pages/Receive/AddressTab';
import { PendingTab } from 'app/pages/Receive/PendingTab';
import {
  getFailedTransactions,
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  verifyStuckTransactionsFromNode,
  waitForConsumeTx
} from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import { HistoryAction, navigate } from 'lib/woozie';

export interface ReceiveProps {}

export const Receive: React.FC<ReceiveProps> = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const address = account.publicKey;

  const { data: claimableNotes, mutate: mutateClaimableNotes } = useClaimableNotes(address);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();
  const { fullPage, sidePanel } = useAppEnv();
  const safeClaimableNotes = useMemo(
    () => (claimableNotes ?? []).filter((n): n is NonNullable<typeof n> => n != null),
    [claimableNotes]
  );
  const [claimingNoteIds, setClaimingNoteIds] = useState<Set<string>>(new Set());
  const [individualClaimingIds, setIndividualClaimingIds] = useState<Set<string>>(new Set());
  const [failedNoteIds, setFailedNoteIds] = useState<Set<string>>(new Set());
  const [checkingNoteIds, setCheckingNoteIds] = useState<Set<string>>(new Set());
  const claimAllAbortRef = useRef<AbortController | null>(null);

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

  // Notes that are not currently being claimed (available for "Claim All").
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

  // Poll for stuck transactions and verify their state from the node.
  // On extension, skip — the SW handles stuck transaction cleanup via generateTransactionsLoop.
  useEffect(() => {
    if (isExtension()) return;

    const checkStuckTransactions = async () => {
      const resolved = await verifyStuckTransactionsFromNode();
      if (resolved > 0) {
        mutateClaimableNotes();
      }
    };

    checkStuckTransactions();

    const interval = setInterval(checkStuckTransactions, 3000);
    return () => clearInterval(interval);
  }, [mutateClaimableNotes]);

  // Check for failed notes: both from local IndexedDB and node state (only once on mount).
  const hasCheckedFailedNotes = useRef(false);
  useEffect(() => {
    const checkFailedNotes = async () => {
      if (safeClaimableNotes.length === 0) return;
      if (hasCheckedFailedNotes.current) return;
      hasCheckedFailedNotes.current = true;

      const noteIdsToCheck = new Set(safeClaimableNotes.map(n => n.id));
      setCheckingNoteIds(noteIdsToCheck);

      const failedIds = new Set<string>();

      try {
        const failedTxs = await getFailedTransactions();
        for (const tx of failedTxs) {
          if (tx.type === 'consume' && tx.noteId) {
            failedIds.add(tx.noteId);
          }
        }

        try {
          if (isExtension()) {
            const res = await getIntercom().request({
              type: WalletMessageType.GetInputNoteDetailsRequest,
              noteIds: safeClaimableNotes.map(n => n.id)
            });
            if (res && 'notes' in res) {
              for (const note of (res as any).notes) {
                if (note.state === 'Invalid') {
                  failedIds.add(note.noteId);
                }
              }
            }
          } else {
            const noteIds = safeClaimableNotes.map(n => n.id);
            const noteDetails = await withWasmClientLock(async () => {
              const midenClient = await getMidenClient();
              return await midenClient.getInputNoteDetails({ ids: noteIds });
            });

            for (const note of noteDetails) {
              if (note.state === InputNoteState.Invalid) {
                failedIds.add(note.noteId);
              }
            }
          }
        } catch (err) {
          console.error('[Receive] Error checking node state for notes:', err);
        }

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

  const claimNotesBatch = useCallback(
    async (filter?: (note: NonNullable<(typeof safeClaimableNotes)[number]>) => boolean) => {
      claimAllAbortRef.current?.abort();
      claimAllAbortRef.current = new AbortController();
      const signal = claimAllAbortRef.current.signal;

      // Refresh the claimable notes list before queueing to avoid race conditions
      // with auto-consume (Explore page may have already started claiming some notes).
      const freshNotes = await mutateClaimableNotes();
      let freshUnclaimedNotes = freshNotes
        ? freshNotes.filter(
            n => n && !n.isBeingClaimed && !claimingNoteIds.has(n.id) && !individualClaimingIds.has(n.id)
          )
        : unclaimedNotes;

      if (filter) {
        freshUnclaimedNotes = freshUnclaimedNotes.filter(n => n && filter(n));
      }

      if (freshUnclaimedNotes.length === 0) {
        return;
      }

      const noteIds = freshUnclaimedNotes.map(n => n!.id);
      setClaimingNoteIds(prev => new Set([...prev, ...noteIds]));

      setFailedNoteIds(new Set());

      try {
        const transactionIds: { noteId: string; txId: string }[] = [];
        for (const note of freshUnclaimedNotes) {
          try {
            const id = await initiateConsumeTransaction(account.publicKey, note!, isDelegatedProvingEnabled);
            transactionIds.push({ noteId: note!.id, txId: id });
          } catch (err) {
            console.error('Error queuing note for claim:', note!.id, err);
            setFailedNoteIds(prev => new Set(prev).add(note!.id));
            setClaimingNoteIds(prev => {
              const next = new Set(prev);
              next.delete(note!.id);
              return next;
            });
          }
        }

        if (isExtension()) {
          // On extension: fire-and-forget — SW handles processing.
          // Notes show "claiming" spinner via claimingNoteIds + NoteClaimStarted broadcast.
          // Notes disappear when sync cycle removes them from getConsumableNotes().
          requestSWTransactionProcessing();
        } else {
          useWalletStore.getState().openTransactionModal();

          for (const { noteId, txId } of transactionIds) {
            if (signal.aborted) break;
            try {
              await waitForConsumeTx(txId, signal);
            } catch (err) {
              if (err instanceof DOMException && err.name === 'AbortError') {
                break;
              }
              console.error('Error waiting for transaction:', txId, err);
              setFailedNoteIds(prev => new Set(prev).add(noteId));
            }
          }

          await mutateClaimableNotes();

          if (isMobile()) {
            navigate('/', HistoryAction.Replace);
          }
        }
      } finally {
        if (!isExtension()) {
          setClaimingNoteIds(new Set());
        }
        // On extension, keep claimingNoteIds set — they'll be cleared when notes disappear from sync.
      }
    },
    [
      unclaimedNotes,
      account.publicKey,
      isDelegatedProvingEnabled,
      mutateClaimableNotes,
      claimingNoteIds,
      individualClaimingIds
    ]
  );

  const handleClaimAll = useCallback(async () => {
    if (unclaimedNotes.length === 0) return;
    await claimNotesBatch();
  }, [unclaimedNotes.length, claimNotesBatch]);

  const handleClaimGroup = useCallback(
    async (faucetId: string) => {
      await claimNotesBatch(n => n.faucetId === faucetId);
    },
    [claimNotesBatch]
  );

  // Match SendManager's container sizing - use h-full to inherit from parent (body has safe area padding).
  const containerClass =
    isMobile() || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  const [activeTab, setActiveTab] = useState<'address' | 'pending'>('address');
  const pendingCount = safeClaimableNotes.length;

  const handleTabTap = (id: 'address' | 'pending') => {
    if (id === activeTab) return;
    hapticLight();
    setActiveTab(id);
  };

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg relative')}>
      {/* Address / Pending tab switcher */}
      <div className="shrink-0 flex border-b border-rule-default">
        <button
          type="button"
          data-testid="receive-tab-address"
          onClick={() => handleTabTap('address')}
          aria-pressed={activeTab === 'address'}
          className={classNames(
            'flex-1 h-12 text-sm font-semibold transition-colors',
            activeTab === 'address' ? 'bg-surface-interactive text-accent-primary' : 'bg-white text-text-primary-token'
          )}
        >
          {t('address')}
        </button>
        <button
          type="button"
          data-testid="receive-tab-pending"
          onClick={() => handleTabTap('pending')}
          aria-pressed={activeTab === 'pending'}
          className={classNames(
            'flex-1 h-12 text-sm font-semibold transition-colors',
            activeTab === 'pending' ? 'bg-surface-interactive text-accent-primary' : 'bg-white text-text-primary-token'
          )}
        >
          {`${t('pending')} (`}
          <span data-testid="receive-pending-count">{pendingCount}</span>
          {')'}
        </button>
      </div>

      {activeTab === 'address' ? (
        <AddressTab address={address} />
      ) : (
        <PendingTab
          safeClaimableNotes={safeClaimableNotes}
          unclaimedNotesCount={unclaimedNotes.length}
          account={account}
          mutateClaimableNotes={mutateClaimableNotes}
          isDelegatedProvingEnabled={isDelegatedProvingEnabled}
          claimingNoteIds={claimingNoteIds}
          failedNoteIds={failedNoteIds}
          checkingNoteIds={checkingNoteIds}
          onClaimingStateChange={handleClaimingStateChange}
          onClaimAll={handleClaimAll}
          onClaimGroup={handleClaimGroup}
        />
      )}
    </div>
  );
};
