/**
 * Read model of the Miden Name registrations.
 *
 * The record of a registration is its `register-name` transaction row (see
 * `IRegisterNameExtraInputs`). The functions here only read these rows. The
 * tracker (`tracker.ts`) writes the phase.
 */

import { useEffect, useState } from 'react';

import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import { compareAccountIds } from 'lib/miden/activity/utils';
import {
  IRegisterNameExtraInputs,
  ITransaction,
  ITransactionStatus,
  type MidenNameFailure,
  type MidenNamePhase
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { isMidenNameSupported } from './config';

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
      if (row.status === ITransactionStatus.Failed) return 'failed';
      if (row.status === ITransactionStatus.Completed) return 'submitted';
      return phase;
    default:
      return row.status === ITransactionStatus.Failed ? 'failed' : phase;
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

/** Live list of the registrations of an account (see `listMidenNameRegistrations`). */
export function useMidenNameRegistrations(accountId: string | undefined): MidenNameRegistrationsState {
  const [state, setState] = useState<MidenNameRegistrationsState>({ rows: [], loaded: false });

  useEffect(() => {
    setState({ rows: [], loaded: false });
    if (!accountId) {
      setState({ rows: [], loaded: true });
      return undefined;
    }
    return subscribeToLiveQuery(() => listMidenNameRegistrations(accountId), {
      next: rows => setState({ rows, loaded: true }),
      error: error => console.error('[miden-name] Failed to read registrations:', error)
    });
  }, [accountId]);

  return state;
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
  const { rows } = useMidenNameRegistrations(accountId);
  if (!isMidenNameSupported()) return undefined;
  return ownedLabelOf(rows);
}
