import { useEffect, useState } from 'react';

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

export function epochReturnDisplay(
  note: EpochNoteState | undefined,
  claims: Pick<ITransaction, 'status'>[]
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
      return { status: 'confirmed', messageKey: 'epochReturnPaid' };
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
  const candidate =
    !!accountId &&
    entry?.txType === 'bridged-send' &&
    entry.bridgeProvider === 'epoch' &&
    !restored &&
    (entry.status === ITransactionStatus.Failed ||
      entry.isUnconfirmed ||
      entry.bridgeEpochStatus === 'failed' ||
      (entry.status === ITransactionStatus.Completed && !entry.bridgeIntentNonce && !entry.bridgeEpochStatus));
  const noteId = candidate
    ? (entry.outputNoteIds?.[0] ?? (entry.bridgeSubmitClaimed ? entry.bridgeReclaimNoteId : undefined))
    : undefined;
  const height = candidate ? entry.bridgeReclaimHeight : undefined;
  const [read, setRead] = useState<{ noteId: string; note: EpochNoteState }>();
  const [claims, setClaims] = useState<{ noteId: string; rows: ITransaction[] }>();

  useEffect(() => {
    if (!noteId || height == null) return;
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
  }, [noteId, height]);

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
  if (note === 'spent' && claims?.noteId !== noteId) return { messageKey: 'epochReturnUnavailable' };
  return epochReturnDisplay(note, claims?.noteId === noteId ? claims.rows : []);
}
