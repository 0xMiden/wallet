import { useEffect, useMemo, useRef, useState } from 'react';

import { useActivityNoteDates } from 'app/hooks/useActivityNoteDates';
import { useClaimNotes } from 'app/hooks/useClaimNotes';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import type { NoteWithMetadata } from 'app/pages/Receive/PendingTab';
import type { PendingActivityItem, PendingActivityStatus } from 'app/templates/history/PendingActivityCard';
import {
  getTransactionById,
  initiateConsumeNotesTransaction,
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';

export function useActivityClaims() {
  const claim = useClaimNotes();
  const storedDates = useActivityNoteDates(
    claim.safeClaimableNotes.filter(note => note.receivedAt === undefined).map(note => note.id)
  );
  const { signTransaction } = useMidenContext();
  const nativeFaucetId = useMidenFaucetId();
  const [attempts, setAttempts] = useState<ReadonlyMap<string, PendingActivityItem>>(new Map());
  const busy = useRef(new Set<string>());
  const mounted = useRef(true);
  // A note with no stored receive date gets the time it was first listed here
  // and keeps it. Without a fixed date the row sits in the "date unavailable"
  // group and jumps into a dated group when the stored date lands later.
  const firstSeenAt = useRef(new Map<string, number>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const pending = [...attempts.values()].filter(item => item.status === 'claiming' && item.txId);
    if (pending.length === 0) return;
    let cancelled = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        await Promise.all(
          pending.map(async item => {
            if (!item.txId) return;
            try {
              const tx = await getTransactionById(item.txId);
              if (cancelled) return;
              let status: PendingActivityStatus;
              switch (tx.status) {
                case ITransactionStatus.Completed:
                  status = 'claimed';
                  break;
                case ITransactionStatus.Failed:
                  status = 'failed';
                  break;
                default:
                  return;
              }
              busy.current.delete(item.note.id);
              setAttempts(previous => {
                if (previous.get(item.note.id)?.txId !== item.txId) return previous;
                const next = new Map(previous);
                const noteIds = tx.noteIds ?? (tx.noteId ? [tx.noteId] : []);
                next.set(item.note.id, {
                  ...item,
                  status,
                  claimedAt: tx.completedAt,
                  replaceHistoryRow: noteIds.length === 1 && noteIds[0] === item.note.id
                });
                return next;
              });
            } catch (error) {
              console.warn('[activity] Could not read claim status', error);
            }
          })
        );
      } finally {
        reading = false;
      }
    };
    read();
    const timer = setInterval(read, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [attempts]);

  const items = useMemo(() => {
    const result = new Map<string, PendingActivityItem>();
    for (const note of claim.safeClaimableNotes) {
      let status: PendingActivityStatus = 'pending';
      switch (true) {
        case note.isBeingClaimed || claim.claimingNoteIds.has(note.id):
          status = 'claiming';
          break;
        case claim.checkingNoteIds.has(note.id):
          status = 'checking';
          break;
        case claim.invalidNoteIds.has(note.id):
          status = 'unavailable';
          break;
        case claim.retriableNoteIds.has(note.id):
          status = 'failed';
          break;
      }
      let receivedAt = note.receivedAt ?? storedDates.get(note.id);
      if (receivedAt === undefined) {
        const seen = firstSeenAt.current.get(note.id) ?? Math.floor(Date.now() / 1000);
        firstSeenAt.current.set(note.id, seen);
        receivedAt = seen;
      }
      result.set(note.id, {
        note: { ...note, receivedAt },
        status,
        txId: note.claimingTxId
      });
    }
    for (const [id, attempt] of attempts) {
      const current = result.get(id);
      // Live claims and terminal note checks take priority over an old failed attempt.
      if (attempt.status === 'failed' && current && current.status !== 'pending' && current.status !== 'failed')
        continue;
      result.set(id, { ...attempt, note: current?.note ?? attempt.note });
    }
    return [...result.values()];
  }, [
    claim.safeClaimableNotes,
    claim.claimingNoteIds,
    claim.checkingNoteIds,
    claim.invalidNoteIds,
    claim.retriableNoteIds,
    attempts,
    storedDates
  ]);

  const accept = async (note: NoteWithMetadata) => {
    // A cache-first entry is displayed before any live read has confirmed it, so it
    // cannot start a claim. The live read replaces it within one poll lap.
    if (note.fromCache) return;
    const item = items.find(candidate => candidate.note.id === note.id);
    if (!item || (item.status !== 'pending' && item.status !== 'failed') || busy.current.has(note.id)) return;
    busy.current.add(note.id);
    setAttempts(previous => new Map(previous).set(note.id, { note, status: 'claiming' }));
    try {
      const txId = await initiateConsumeTransaction(
        claim.account.publicKey,
        note,
        claim.isDelegatedProvingEnabled,
        true
      );
      if (mounted.current) {
        setAttempts(previous => new Map(previous).set(note.id, { note, status: 'claiming', txId }));
      }
    } catch (error) {
      busy.current.delete(note.id);
      if (mounted.current) setAttempts(previous => new Map(previous).set(note.id, { note, status: 'failed' }));
      console.error('[activity] Could not queue claim', error);
      return;
    }
    try {
      if (isExtension()) requestSWTransactionProcessing();
      else startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
    } catch (error) {
      // The transaction is queued. Keep its status until the worker reports a result.
      console.warn('[activity] Could not start claim processing', error);
    }
  };

  // Queues a claim for many notes at once. Every note shows as `claiming`
  // before the first queue call, so the list reacts on tap on all platforms.
  // One consume transaction per faucet, native asset first: the consume
  // credits the vault that the fee of the next group is paid from.
  const acceptMany = async (notes: readonly NoteWithMetadata[]) => {
    const accepted = notes.filter(note => {
      // Same gate as `accept`: unconfirmed cache entries are never claimed.
      if (note.fromCache) return false;
      const item = items.find(candidate => candidate.note.id === note.id);
      return (
        item !== undefined && (item.status === 'pending' || item.status === 'failed') && !busy.current.has(note.id)
      );
    });
    if (accepted.length === 0) return;
    for (const note of accepted) busy.current.add(note.id);
    setAttempts(previous => {
      const next = new Map(previous);
      for (const note of accepted) next.set(note.id, { note, status: 'claiming' });
      return next;
    });

    const byFaucet = new Map<string, NoteWithMetadata[]>();
    for (const note of accepted) {
      const group = byFaucet.get(note.faucetId);
      if (group) group.push(note);
      else byFaucet.set(note.faucetId, [note]);
    }
    const groups = [...byFaucet.entries()]
      .sort(([a], [b]) => Number(b === nativeFaucetId) - Number(a === nativeFaucetId))
      .map(([, groupNotes]) => groupNotes);

    let queued = false;
    for (const groupNotes of groups) {
      try {
        const txId = await initiateConsumeNotesTransaction(
          claim.account.publicKey,
          groupNotes,
          claim.isDelegatedProvingEnabled,
          true
        );
        queued = true;
        if (mounted.current) {
          setAttempts(previous => {
            const next = new Map(previous);
            for (const note of groupNotes) next.set(note.id, { note, status: 'claiming', txId });
            return next;
          });
        }
      } catch (error) {
        for (const note of groupNotes) busy.current.delete(note.id);
        if (mounted.current) {
          setAttempts(previous => {
            const next = new Map(previous);
            for (const note of groupNotes) next.set(note.id, { note, status: 'failed' });
            return next;
          });
        }
        console.error('[activity] Could not queue batch claim', error);
      }
    }
    if (!queued) return;
    try {
      if (isExtension()) requestSWTransactionProcessing();
      else startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
    } catch (error) {
      console.warn('[activity] Could not start claim processing', error);
    }
  };

  return {
    items,
    accept,
    acceptMany,
    account: claim.account,
    isLoadingNotes: claim.isFetchingNotes || claim.checkingNoteIds.size > 0
  };
}
