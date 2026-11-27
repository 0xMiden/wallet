/**
 * Read Miden Name registrations and bind an exact consume to a failed delivery claim.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import { compareAccountIds } from 'lib/miden/activity/utils';
import {
  IRegisterNameExtraInputs,
  isLiveTransaction,
  type IConsumeMidenNameExtraInputs,
  type IMidenNameClaimLink,
  ITransaction,
  ITransactionStatus,
  type MidenNameFailure,
  type MidenNamePhase
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { awaitingVerdict } from 'lib/miden/transaction/verdict-rules';
import { getEffectiveNetworkName, subscribeEffectiveEndpoints } from 'lib/miden-chain/effective-endpoints';

import { isMidenNameSupported } from './config';
import { normalizeMidenNameInput } from './encoding';

export type { MidenNameFailure, MidenNamePhase };

/** The state of a registration that the UI shows. */
export type MidenNameUiState = 'owned' | 'claiming' | 'failed';

/** The `extraInputs` of a `register-name` row, or undefined for all other rows. */
export function registerNameInputsOf(row: ITransaction): IRegisterNameExtraInputs | undefined {
  if (row.type !== 'register-name') return undefined;
  const inputs: IRegisterNameExtraInputs | undefined = row.extraInputs;
  return inputs;
}

/**
 * The effective phase of a `register-name` row.
 *
 * The status of the row can be ahead of the stored phase until the tracker
 * does its next pass:
 *   - a Failed row with a non-terminal phase is `failed`;
 *   - a Completed row with phase `requested` is `submitted` (two landed paths
 *     complete the row with no result, so the phase stays `requested`).
 */
export function phaseOf(row: ITransaction): MidenNamePhase {
  const phase = registerNameInputsOf(row)?.phase ?? 'requested';
  switch (phase) {
    case 'owned':
    case 'failed':
      return phase;
    case 'requested':
      if (row.status === ITransactionStatus.Failed && !awaitingVerdict(row)) return 'failed';
      if (row.status === ITransactionStatus.Completed) return 'submitted';
      return phase;
    default:
      return row.status === ITransactionStatus.Failed && !awaitingVerdict(row) ? 'failed' : phase;
  }
}

/** The UI state of a phase. All non-terminal phases show as `claiming`. */
export function uiStateOf(phase: MidenNamePhase): MidenNameUiState {
  switch (phase) {
    case 'owned':
      return 'owned';
    case 'failed':
      return 'failed';
    default:
      return 'claiming';
  }
}

/**
 * True when the row is a `register-name` row of the effective network that is
 * not restored from a backup.
 */
export function isLiveRegistrationRow(row: ITransaction, network: string = getEffectiveNetworkName()): boolean {
  const inputs = registerNameInputsOf(row);
  return inputs !== undefined && row.restoredFromBackup !== true && inputs.network === network;
}

export function claimForNote(row: ITransaction, noteId: string): IMidenNameClaimLink | undefined {
  const inputs: Partial<IConsumeMidenNameExtraInputs> | undefined = row.extraInputs;
  const normalized = noteId.toLowerCase();
  const byNote = inputs?.midenNameClaims?.[normalized];
  if (byNote) return byNote;
  if ((row.noteIds?.length ?? 0) <= 1) return inputs?.midenNameClaim;
  if (inputs?.midenNameClaim && row.noteId?.toLowerCase() === normalized) return inputs.midenNameClaim;
  return undefined;
}

export async function bindMidenNameClaimRegistration(
  registerId: string,
  consumeId: string,
  mode: 'manual' | 'completed'
): Promise<boolean> {
  return Repo.db.transaction('rw', Repo.transactions, async () => {
    const consume = await Repo.transactions.where({ id: consumeId }).first();
    let written = false;
    await Repo.transactions.where({ id: registerId }).modify(row => {
      const inputs = registerNameInputsOf(row);
      if (
        row.id !== registerId ||
        !isLiveRegistrationRow(row) ||
        row.status !== ITransactionStatus.Completed ||
        inputs?.phase !== 'failed' ||
        inputs.failure !== 'claim-failed' ||
        !inputs.deliveryNoteId ||
        consume?.id !== consumeId ||
        consume.type !== 'consume' ||
        consume.restoredFromBackup ||
        !compareAccountIds(row.accountId, consume.accountId)
      ) {
        return false;
      }

      const deliveryNoteId = inputs.deliveryNoteId.toLowerCase();
      const noteIds = consume.noteIds?.length ? consume.noteIds : [consume.noteId];
      if (!noteIds.some(id => id?.toLowerCase() === deliveryNoteId)) return false;
      const link = claimForNote(consume, deliveryNoteId);
      if (
        link?.registerTxId !== registerId ||
        normalizeMidenNameInput(link.label) !== normalizeMidenNameInput(inputs.label)
      ) {
        return false;
      }

      const completed = consume.status === ITransactionStatus.Completed;
      if (mode === 'completed') {
        if (!completed || inputs.claimTxId !== consumeId) return false;
      } else if (!completed && !isLiveTransaction(consume) && !awaitingVerdict(consume)) {
        return false;
      }

      const next: IRegisterNameExtraInputs = {
        ...inputs,
        phase: completed ? 'owned' : 'claiming',
        phaseUpdatedAt: Date.now(),
        claimTxId: consumeId
      };
      delete next.failure;
      delete next.lastError;
      row.extraInputs = next;
      written = true;
      return undefined;
    });
    return written;
  });
}

function newestFirst(a: ITransaction, b: ITransaction): number {
  return b.initiatedAt - a.initiatedAt || (b.queuedSeq ?? 0) - (a.queuedSeq ?? 0);
}

/**
 * The `register-name` rows of an account on the effective network, newest
 * first. Rows restored from a backup are not included.
 */
export async function listMidenNameRegistrations(accountId: string): Promise<ITransaction[]> {
  const network = getEffectiveNetworkName();
  const accountBase = accountId.split('_')[0] ?? accountId;
  const rows = await Repo.transactions
    .where('accountId')
    .startsWith(accountBase)
    .filter(row => compareAccountIds(row.accountId, accountId) && isLiveRegistrationRow(row, network))
    .toArray();
  return rows.sort(newestFirst);
}

export interface MidenNameRegistrationsState {
  rows: ITransaction[];
  /** True when the first live-query result is available. */
  loaded: boolean;
}

interface RegistrationsSnapshot {
  accountId: string | undefined;
  network: string;
  supported: boolean;
  state: MidenNameRegistrationsState;
}

const EMPTY_ROWS: ITransaction[] = [];

function defaultRegistrationsState(accountId: string | undefined, supported: boolean): MidenNameRegistrationsState {
  return { rows: EMPTY_ROWS, loaded: !accountId || !supported };
}

function sameRegistrationsQuery(
  snapshot: RegistrationsSnapshot,
  accountId: string | undefined,
  network: string,
  supported: boolean
): boolean {
  return snapshot.accountId === accountId && snapshot.network === network && snapshot.supported === supported;
}

/** Live list of the registrations of an account (see `listMidenNameRegistrations`). */
export function useMidenNameRegistrations(accountId: string | undefined): MidenNameRegistrationsState {
  const network = useSyncExternalStore(subscribeEffectiveEndpoints, getEffectiveNetworkName, getEffectiveNetworkName);
  const supported = useSyncExternalStore(subscribeEffectiveEndpoints, isMidenNameSupported, isMidenNameSupported);
  const fallback = useMemo(() => defaultRegistrationsState(accountId, supported), [accountId, supported]);
  const [snapshot, setSnapshot] = useState<RegistrationsSnapshot>(() => ({
    accountId,
    network,
    supported,
    state: fallback
  }));

  useEffect(() => {
    setSnapshot(prev =>
      sameRegistrationsQuery(prev, accountId, network, supported)
        ? prev
        : { accountId, network, supported, state: fallback }
    );
    if (!accountId || !supported) {
      return undefined;
    }
    let cancelled = false;
    const unsubscribe = subscribeToLiveQuery(() => listMidenNameRegistrations(accountId), {
      next: rows => {
        if (!cancelled) setSnapshot({ accountId, network, supported, state: { rows, loaded: true } });
      },
      error: error => console.error('[miden-name] Failed to read registrations:', error)
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [accountId, network, supported, fallback]);

  return sameRegistrationsQuery(snapshot, accountId, network, supported) ? snapshot.state : fallback;
}

/** The label of the newest owned registration, or undefined. */
export function ownedLabelOf(rows: ITransaction[]): string | undefined {
  const owned = rows.find(row => phaseOf(row) === 'owned');
  return owned ? registerNameInputsOf(owned)?.label : undefined;
}

/**
 * The label (without `.miden`) of the newest name that the account owns, or
 * undefined. Always undefined when the effective network has no Miden Name
 * deployment.
 */
export function useOwnedMidenName(accountId: string | undefined): string | undefined {
  const supported = useSyncExternalStore(subscribeEffectiveEndpoints, isMidenNameSupported, isMidenNameSupported);
  const { rows } = useMidenNameRegistrations(supported ? accountId : undefined);
  return supported ? ownedLabelOf(rows) : undefined;
}
