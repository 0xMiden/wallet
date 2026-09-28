import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { useClaimNotes } from 'app/hooks/useClaimNotes';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import type { PendingActivityItem, PendingActivityStatus } from 'app/templates/history/PendingActivityCard';
import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import {
  initiateConsumeNotesTransaction,
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front';
import { groupNotesForClaim } from 'lib/miden/front/claim-groups';
import { reportNoteClaim } from 'lib/miden/front/claim-telemetry';
import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import * as Repo from 'lib/miden/repo';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { isExtension } from 'lib/platform';

type Attempts = ReadonlyMap<string, PendingActivityItem>;

// Lives outside the views: switching List and Groups remounts them, and a claim still being queued in one
// must keep the other from queueing the same note. One slot per account, RPC endpoint and network, the key
// AllHistory remounts the views on.
const slots = new Map<string, { attempts: Attempts; busy: Set<string> }>();
const listeners = new Set<() => void>();
const noAttempts: Attempts = new Map();

function slotOf(key: string) {
  let slot = slots.get(key);
  if (!slot) {
    slot = { attempts: noAttempts, busy: new Set() };
    slots.set(key, slot);
  }
  return slot;
}

function updateAttempts(key: string, update: (previous: Attempts) => Attempts) {
  const slot = slotOf(key);
  const next = update(slot.attempts);
  if (next === slot.attempts) return;
  slot.attempts = next;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget every account's claims. */
export function __resetActivityClaimsForTest(): void {
  slots.clear();
}

export function useActivityClaims() {
  const claim = useClaimNotes();
  const { signTransaction } = useMidenContext();
  const nativeFaucetId = useMidenFaucetId();
  const key = `${claim.account.publicKey}|${getEffectiveRpcUrl()}|${getEffectiveNetworkName()}`;
  const attempts = useSyncExternalStore(subscribe, () => slots.get(key)?.attempts ?? noAttempts);
  const setAttempts = (update: (previous: Attempts) => Attempts) => updateAttempts(key, update);
  // Notes whose claim is being queued right now. Once queued, the attempt's
  // `claiming` status is what keeps the note from being accepted again.
  const busy = slotOf(key).busy;

  // Transaction rows of the queued claims that have not settled yet.
  const watchedTxIds = [
    ...new Set([...attempts.values()].flatMap(item => (item.status === 'claiming' && item.txId ? [item.txId] : [])))
  ].join(',');

  useEffect(() => {
    if (!watchedTxIds) return;
    const txIds = watchedTxIds.split(',');
    return subscribeToLiveQuery(() => Repo.transactions.where('id').anyOf(txIds).toArray(), {
      next: rows => {
        const settled = new Map<string, Pick<PendingActivityItem, 'status' | 'claimedAt'>>();
        for (const tx of rows) {
          if (tx.status === ITransactionStatus.Completed) {
            settled.set(tx.id, { status: 'claimed', claimedAt: tx.completedAt });
          } else if (tx.status === ITransactionStatus.Failed) {
            settled.set(tx.id, { status: 'failed', claimedAt: tx.completedAt });
          }
        }
        updateAttempts(key, previous => {
          let next: Map<string, PendingActivityItem> | undefined;
          for (const [noteId, item] of previous) {
            const outcome = item.status === 'claiming' && item.txId ? settled.get(item.txId) : undefined;
            if (!outcome) continue;
            next ??= new Map(previous);
            next.set(noteId, { ...item, ...outcome });
          }
          return next ?? previous;
        });
      },
      error: error => console.warn('[activity] Could not read claim status', error)
    });
  }, [watchedTxIds, key]);

  const items = useMemo(() => {
    const result = new Map<string, PendingActivityItem>();
    for (const note of claim.safeClaimableNotes) {
      let status: PendingActivityStatus = 'pending';
      switch (true) {
        case note.isBeingClaimed:
          status = 'claiming';
          break;
        // The check holds back a note until its state is known; a cached note cannot be accepted, so it stays listed.
        case !note.fromCache && claim.checkingNoteIds.has(note.id):
          status = 'checking';
          break;
        case claim.invalidNoteIds.has(note.id):
          status = 'unavailable';
          break;
        case claim.retriableNoteIds.has(note.id):
          status = 'failed';
          break;
      }
      result.set(note.id, { note, status, txId: note.claimingTxId });
    }
    for (const [id, attempt] of attempts) {
      const current = result.get(id);
      // A failed attempt stays retryable only while its note is live and no newer state (a live claim or a
      // note check) replaced it: a note consumed elsewhere or recalled would fail every batch it joins.
      // Claimed receipts and queued claims outlive the note on purpose.
      if (attempt.status === 'failed' && (!current || (current.status !== 'pending' && current.status !== 'failed')))
        continue;
      result.set(id, { ...attempt, note: current?.note ?? attempt.note });
    }
    return [...result.values()];
  }, [claim.safeClaimableNotes, claim.checkingNoteIds, claim.invalidNoteIds, claim.retriableNoteIds, attempts]);

  const accept = async (note: ClaimableNoteWithMetadata) => {
    // A cache-first entry is displayed before any live read has confirmed it, so it
    // cannot start a claim. The live read replaces it within one poll lap.
    if (note.fromCache) return;
    const item = items.find(candidate => candidate.note.id === note.id);
    if (!item || (item.status !== 'pending' && item.status !== 'failed') || busy.has(note.id)) return;
    busy.add(note.id);
    setAttempts(previous => new Map(previous).set(note.id, { note, status: 'claiming' }));
    try {
      // Each queue call is one `note_handle` attempt. It wraps the call, not the whole action: the
      // catch below absorbs a queue-time throw, so a wrapper further out would report every failure
      // as a success.
      const txId = await reportNoteClaim(() =>
        initiateConsumeTransaction(claim.account.publicKey, note, claim.isDelegatedProvingEnabled, true)
      );
      setAttempts(previous => new Map(previous).set(note.id, { note, status: 'claiming', txId }));
    } catch (error) {
      setAttempts(previous => new Map(previous).set(note.id, { note, status: 'failed' }));
      console.error('[activity] Could not queue claim', error);
      return;
    } finally {
      busy.delete(note.id);
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
  const acceptMany = async (notes: readonly ClaimableNoteWithMetadata[]) => {
    const accepted = notes.filter(note => {
      // Same gate as `accept`: unconfirmed cache entries are never claimed.
      if (note.fromCache) return false;
      const item = items.find(candidate => candidate.note.id === note.id);
      return item !== undefined && (item.status === 'pending' || item.status === 'failed') && !busy.has(note.id);
    });
    if (accepted.length === 0) return;
    for (const note of accepted) busy.add(note.id);
    setAttempts(previous => {
      const next = new Map(previous);
      for (const note of accepted) next.set(note.id, { note, status: 'claiming' });
      return next;
    });

    let queued = false;
    for (const groupNotes of groupNotesForClaim(accepted, nativeFaucetId)) {
      try {
        const txId = await reportNoteClaim(() =>
          initiateConsumeNotesTransaction(claim.account.publicKey, groupNotes, claim.isDelegatedProvingEnabled, true)
        );
        queued = true;
        setAttempts(previous => {
          const next = new Map(previous);
          for (const note of groupNotes) next.set(note.id, { note, status: 'claiming', txId });
          return next;
        });
      } catch (error) {
        setAttempts(previous => {
          const next = new Map(previous);
          for (const note of groupNotes) next.set(note.id, { note, status: 'failed' });
          return next;
        });
        console.error('[activity] Could not queue batch claim', error);
      } finally {
        for (const note of groupNotes) busy.delete(note.id);
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
