// The switch rows whose landed reconcile could not save the post-switch local state (#1233), for the
// sync loop's self-heal: it adopts that state from the previous guardian, registers it on the new
// one, and then clears the flag the receipt warns on.

import * as Repo from 'lib/miden/repo';
import { sameGuardianEndpoint } from 'lib/settings/helpers';

import type { ITransaction } from '../db/types';
import { sameWalletAccountId } from '../sdk/helpers';

export interface UnsavedSwitchRow {
  id: string;
  previousGuardianEndpoint: string;
  /** The switch fled an unresponsive previous guardian, which never received its delta. */
  switchedDirectly: boolean;
  /** The coordinated switch's proposal, whose executed delta the self-heal can push again. */
  switchProposalId: string | undefined;
  /** The previous guardian took that delta, from the landed push or a re-push. */
  switchDeltaPushed: boolean;
}

const isUnsavedSwitchTo = (tx: ITransaction, accountPublicKey: string, endpoint: string): boolean =>
  tx.type === 'switch-guardian' &&
  tx.extraInputs?.localStateNotSaved === true &&
  typeof tx.extraInputs.newGuardianEndpoint === 'string' &&
  sameWalletAccountId(tx.accountId, accountPublicKey) &&
  sameGuardianEndpoint(tx.extraInputs.newGuardianEndpoint, endpoint);

/** The newest such row for this account and the endpoint it switched to, when it names the previous one. */
export async function findUnsavedSwitchRow(
  accountPublicKey: string,
  endpoint: string
): Promise<UnsavedSwitchRow | undefined> {
  const rows = await Repo.transactions.filter(tx => isUnsavedSwitchTo(tx, accountPublicKey, endpoint)).toArray();
  const newest = rows.sort((a, b) => b.initiatedAt - a.initiatedAt)[0];
  const previous: unknown = newest?.extraInputs?.previousGuardianEndpoint;
  if (!newest || typeof previous !== 'string') return undefined;
  const proposalId: unknown = newest.extraInputs.switchProposalId;
  return {
    id: newest.id,
    previousGuardianEndpoint: previous,
    switchedDirectly: newest.extraInputs.switchedDirectly === true,
    switchProposalId: typeof proposalId === 'string' ? proposalId : undefined,
    switchDeltaPushed: newest.extraInputs.switchDeltaPushed === true
  };
}

/** Record that the previous guardian took this row's delta, so the self-heal does not push it again. */
export async function markSwitchDeltaPushed(rowId: string): Promise<void> {
  await Repo.transactions.where({ id: rowId }).modify(tx => {
    tx.extraInputs = { ...tx.extraInputs, switchDeltaPushed: true };
  });
}

/** Clear the flag on every such row, once this device registered the post-switch state. */
export async function clearLocalStateNotSaved(accountPublicKey: string, endpoint: string): Promise<void> {
  await Repo.transactions
    .filter(tx => isUnsavedSwitchTo(tx, accountPublicKey, endpoint))
    .modify(tx => {
      tx.extraInputs = { ...tx.extraInputs, localStateNotSaved: false };
    });
}
