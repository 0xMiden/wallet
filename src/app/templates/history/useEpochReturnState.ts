import { useEffect, useState } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { Status } from 'components/ui/StatusBadge';
import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import { EpochNoteState, readEpochNoteState } from 'lib/epoch/return-state';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { IHistoryEntry } from './IHistoryEntry';

export interface EpochReturnState {
  status?: Status;
  messageKey?: string;
}

export function epochReturnNote(
  entry: IHistoryEntry | null | undefined,
  restored: boolean
): { noteId: string; height: number } | undefined {
  if (!entry) return undefined;
  const isEpoch = entry.bridgeProvider === 'epoch';
  const noteMayExist = entry.isUnconfirmed === true || entry.bridgeEpochStatus === 'failed';
  const intentNeverRecorded =
    isEpoch &&
    entry.status === ITransactionStatus.Completed &&
    !entry.bridgeIntentNonce &&
    entry.bridgeEpochStatus === undefined;
  const fillFailed = isEpoch && entry.status === ITransactionStatus.Completed && entry.bridgeEpochStatus === 'failed';
  const reclaimNoteId =
    entry.outputNoteIds?.[0] ??
    (entry.bridgeSubmitClaimed === true && (entry.isUnconfirmed === true || entry.bridgeEpochStatus === 'failed')
      ? entry.bridgeReclaimNoteId
      : undefined);

  if (
    !isEpoch ||
    restored ||
    entry.bridgeReclaimHeight == null ||
    !reclaimNoteId ||
    !(noteMayExist || intentNeverRecorded || fillFailed)
  ) {
    return undefined;
  }

  return { noteId: reclaimNoteId, height: entry.bridgeReclaimHeight };
}

export function epochReturnDisplay(
  note: EpochNoteState | undefined,
  claims: Pick<ITransaction, 'status'>[],
  payoutConfirmed = false
): EpochReturnState {
  const returned = claims.some(tx => tx.status === ITransactionStatus.Completed);
  if (returned) return { status: 'fundsReturned', messageKey: 'epochReturnDone' };
  const returning = claims.some(
    tx => tx.status === ITransactionStatus.Queued || tx.status === ITransactionStatus.GeneratingTransaction
  );
  if (returning) return { status: 'returningFunds', messageKey: 'epochReturnPending' };
  if (claims.some(tx => tx.status === ITransactionStatus.Unconfirmed)) {
    return { status: 'unconfirmed', messageKey: 'epochReturnUnavailable' };
  }
  switch (note) {
    case 'spent':
      return payoutConfirmed
        ? { status: 'confirmed', messageKey: 'epochReturnPaid' }
        : { status: 'unconfirmed', messageKey: 'epochReturnSpent' };
    case 'waiting':
      return { status: 'awaitingReturn', messageKey: 'epochReturnWaiting' };
    case 'ready':
      return { status: 'readyToClaim', messageKey: 'epochReturnReady' };
    default:
      return { messageKey: 'epochReturnUnavailable' };
  }
}

/** Keep the bridge error record. Use node evidence for the visible recovery state. */
export function useEpochReturnState(
  entry: IHistoryEntry | null | undefined,
  accountId: string,
  restored: boolean
): EpochReturnState {
  const pageActive = usePageActive();
  const candidate = entry?.txType === 'bridged-send' ? epochReturnNote(entry, restored) : undefined;
  const noteId = accountId ? candidate?.noteId : undefined;
  const height = candidate?.height;
  const [read, setRead] = useState<{ noteId: string; note: EpochNoteState }>();
  const [claims, setClaims] = useState<{ noteId: string; rows: ITransaction[] }>();

  useEffect(() => {
    if (!noteId || height == null || !pageActive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const note = await readEpochNoteState(noteId, height);
        if (!cancelled) setRead({ noteId, note });
        if (note === 'spent') return;
      } catch {
        if (!cancelled) setRead(undefined);
      }
      if (!cancelled) timer = setTimeout(tick, 15000);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [noteId, height, pageActive]);

  useEffect(() => {
    if (!noteId) return;
    return subscribeToLiveQuery(
      () =>
        Repo.transactions
          .where({ accountId })
          .filter(
            tx =>
              tx.type === 'consume' &&
              !tx.restoredFromBackup &&
              (tx.noteId === noteId || tx.noteIds?.includes(noteId) === true)
          )
          .toArray(),
      {
        next: rows => setClaims({ noteId, rows }),
        error: () => setClaims(undefined)
      }
    );
  }, [noteId, accountId]);

  if (!noteId || height == null) return {};
  const note = read?.noteId === noteId ? read.note : undefined;
  if (note === 'spent' && claims?.noteId !== noteId) {
    return { status: 'unconfirmed', messageKey: 'epochReturnSpent' };
  }
  return epochReturnDisplay(
    note,
    claims?.noteId === noteId ? claims.rows : [],
    entry?.bridgeEpochStatus === 'confirmed'
  );
}
