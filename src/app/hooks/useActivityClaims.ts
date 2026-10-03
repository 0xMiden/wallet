import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useClaimNotes } from 'app/hooks/useClaimNotes';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import type { PendingActivityItem, PendingActivityStatus } from 'app/templates/history/PendingActivityCard';
import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import {
  holdsNotes,
  initiateConsumeNotesTransaction,
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  requeueFailedTransaction,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { isAgglayerBridgeDelivery } from 'lib/miden/activity/bridge-in';
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
const slots = new Map<string, { attempts: Attempts; busy: Set<string>; retrying: Set<string> }>();
const listeners = new Set<() => void>();
const noAttempts: Attempts = new Map();

function slotOf(key: string) {
  let slot = slots.get(key);
  if (!slot) {
    slot = { attempts: noAttempts, busy: new Set(), retrying: new Set() };
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

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(id => b.has(id));
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
  // Held rows whose Retry is running. The card keeps offering Retry until the live query sees the row move, so a
  // second tap in that window would requeue a row the first one already requeued, and store its refusal.
  const retrying = slotOf(key).retrying;

  // Rows of every claiming item: session attempts and the claiming map's held rows alike (#1081).
  const watchedTxIds = [
    ...new Set([
      ...[...attempts.values()].flatMap(item => (item.status === 'claiming' && item.txId ? [item.txId] : [])),
      ...claim.safeClaimableNotes.flatMap(n => (n.isBeingClaimed && n.claimingTxId ? [n.claimingTxId] : []))
    ])
  ]
    .sort()
    .join(',');
  const [heldTxIds, setHeldTxIds] = useState<ReadonlySet<string>>(new Set());
  const [retryErrors, setRetryErrors] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (!watchedTxIds) return;
    const txIds = watchedTxIds.split(',');
    return subscribeToLiveQuery(() => Repo.transactions.where('id').anyOf(txIds).toArray(), {
      next: rows => {
        const settled = new Map<string, Pick<PendingActivityItem, 'status' | 'claimedAt'>>();
        const held = new Set<string>();
        for (const tx of rows) {
          if (tx.status === ITransactionStatus.Completed) {
            settled.set(tx.id, { status: 'claimed', claimedAt: tx.completedAt });
          } else if (tx.status === ITransactionStatus.Failed || tx.status === ITransactionStatus.Unconfirmed) {
            if (holdsNotes(tx)) held.add(tx.id);
            else settled.set(tx.id, { status: 'failed', claimedAt: tx.completedAt });
          }
        }
        // Every emission lists every watched row; an unchanged set keeps its identity so the items do not rebuild.
        setHeldTxIds(previous => (sameIds(previous, held) ? previous : held));
        // A refusal describes the hold it met; once the row moves on it must not return with a later hold.
        setRetryErrors(previous => {
          const moved = rows.filter(tx => !held.has(tx.id) && previous.has(tx.id));
          if (moved.length === 0) return previous;
          const next = new Map(previous);
          for (const tx of moved) next.delete(tx.id);
          return next;
        });
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
    // A refusal belongs to the held claim whose Retry met it: once the row settles or runs again it no longer applies.
    const heldFields = (
      status: PendingActivityStatus,
      txId: string | undefined
    ): Pick<PendingActivityItem, 'held' | 'retryError'> => {
      if (status !== 'claiming' || txId === undefined || !heldTxIds.has(txId)) return {};
      const retryError = retryErrors.get(txId);
      return retryError === undefined ? { held: true } : { held: true, retryError };
    };
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
      const txId = note.claimingTxId;
      result.set(note.id, { note, status, txId, ...heldFields(status, txId) });
    }
    for (const [id, attempt] of attempts) {
      const current = result.get(id);
      // A failed attempt stays retryable only while its note is live and no newer state (a live claim or a
      // note check) replaced it: a note consumed elsewhere or recalled would fail every batch it joins.
      // Claimed receipts and queued claims outlive the note on purpose.
      if (attempt.status === 'failed' && (!current || (current.status !== 'pending' && current.status !== 'failed')))
        continue;
      result.set(id, { ...attempt, note: current?.note ?? attempt.note, ...heldFields(attempt.status, attempt.txId) });
    }
    return [...result.values()];
  }, [
    claim.safeClaimableNotes,
    claim.checkingNoteIds,
    claim.invalidNoteIds,
    claim.retriableNoteIds,
    attempts,
    heldTxIds,
    retryErrors
  ]);

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
    const groups = groupNotesForClaim(accepted, nativeFaucetId, note => isAgglayerBridgeDelivery(note.senderAddress));
    for (const groupNotes of groups) {
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

  // A held claim's Retry requeues its own row in place: History hides that row while this card stands in for its
  // notes, so this is its only Retry (#1081). No history entry, no navigation, so this starts processing itself.
  const retryHeld = async (item: PendingActivityItem) => {
    const { txId } = item;
    if (txId === undefined || item.held !== true || retrying.has(txId)) return;
    retrying.add(txId);
    setRetryErrors(previous => {
      const next = new Map(previous);
      next.delete(txId);
      return next;
    });
    try {
      await requeueFailedTransaction(txId);
    } catch (error) {
      setRetryErrors(previous => new Map(previous).set(txId, error instanceof Error ? error.message : String(error)));
      return;
    } finally {
      retrying.delete(txId);
    }
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
    retryHeld,
    account: claim.account,
    isLoadingNotes: claim.isFetchingNotes || claim.checkingNoteIds.size > 0
  };
}
