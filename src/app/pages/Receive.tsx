import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { AddressTab } from 'app/pages/Receive/AddressTab';
import { useNativeNavbarAction } from 'lib/dapp-browser';
import {
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  verifyStuckTransactionsFromNode
} from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { navigate } from 'lib/woozie';

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
  const claimAllAbortRef = useRef<AbortController | null>(null);

  // Notes that are not currently being claimed (available for "Claim All").
  // A note is claimable if it's not being claimed via:
  // - IndexedDB (isBeingClaimed) - from previous sessions or after tx queued
  // - Claim All operation (claimingNoteIds) - current batch operation
  const unclaimedNotes = safeClaimableNotes.filter(n => !n.isBeingClaimed && !claimingNoteIds.has(n.id));

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

  const claimNotesBatch = useCallback(
    async (filter?: (note: NonNullable<(typeof safeClaimableNotes)[number]>) => boolean) => {
      claimAllAbortRef.current?.abort();
      claimAllAbortRef.current = new AbortController();
      const signal = claimAllAbortRef.current.signal;

      // Refresh the claimable notes list before queueing to avoid race conditions
      // with auto-consume (Explore page may have already started claiming some notes).
      const freshNotes = await mutateClaimableNotes();
      let freshUnclaimedNotes = freshNotes
        ? freshNotes.filter(n => n && !n.isBeingClaimed && !claimingNoteIds.has(n.id))
        : unclaimedNotes;

      if (filter) {
        freshUnclaimedNotes = freshUnclaimedNotes.filter(n => n && filter(n));
      }

      if (freshUnclaimedNotes.length === 0) {
        return;
      }

      const noteIds = freshUnclaimedNotes.map(n => n!.id);
      setClaimingNoteIds(prev => new Set([...prev, ...noteIds]));

      try {
        const transactionIds: { noteId: string; txId: string }[] = [];
        for (const note of freshUnclaimedNotes) {
          try {
            // User tapped Claim All — bypass the auto-consume backoff gate
            // so failed notes can be retried on demand.
            const id = await initiateConsumeTransaction(account.publicKey, note!, isDelegatedProvingEnabled, true);
            transactionIds.push({ noteId: note!.id, txId: id });
          } catch (err) {
            console.error('Error queuing note for claim:', note!.id, err);
            setClaimingNoteIds(prev => {
              const next = new Set(prev);
              next.delete(note!.id);
              return next;
            });
          }
        }

        if (isExtension()) {
          // On extension: fire-and-forget — SW handles processing.
          // Keep the native Claim All action disabled until sync removes the queued notes.
          requestSWTransactionProcessing();
        }

        const firstTxId = transactionIds[0]?.txId;
        if (firstTxId && !signal.aborted) {
          navigate({
            pathname: '/generating-transaction-full',
            search: `?txId=${encodeURIComponent(firstTxId)}`
          });
        }
      } finally {
        if (!isExtension()) {
          setClaimingNoteIds(new Set());
        }
        // On extension, keep claimingNoteIds set — they'll be cleared when notes disappear from sync.
      }
    },
    [unclaimedNotes, account.publicKey, isDelegatedProvingEnabled, mutateClaimableNotes, claimingNoteIds]
  );

  const handleClaimAll = useCallback(async () => {
    if (unclaimedNotes.length === 0) return;
    await claimNotesBatch();
  }, [unclaimedNotes.length, claimNotesBatch]);

  // Lift the Claim All button into the native navbar overlay on mobile.
  // The navbar morphs to compact mode when claimableNotes appear and
  // back to default when they're all gone — handles the dynamic case
  // where the background sync surfaces claimable notes mid-page-life.
  const isClaimingAll = claimingNoteIds.size > 0;
  useNativeNavbarAction(
    unclaimedNotes.length > 0
      ? {
          label: t('claimAll'),
          onTap: handleClaimAll,
          enabled: !isClaimingAll
        }
      : null
  );

  // Match SendManager's container sizing - use h-full to inherit from parent (body has safe area padding).
  const containerClass =
    isMobile() || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg relative')}>
      <AddressTab address={address} />
    </div>
  );
};
