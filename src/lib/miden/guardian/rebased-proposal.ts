import type { Proposal } from '@openzeppelin/miden-multisig-client';

import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { withProposalStep } from 'lib/telemetry/crash-diagnostics';

import type { MultisigService } from './index';

/**
 * Proposes a wallet-built guarded request, re-bound to the current sync height (see
 * `MultisigService.createRebasedCustomProposal`), and persists the bytes it was proposed from:
 * signing and execution rebuild from `transaction.requestBytes`, so it must be these.
 *
 * Proposes once. A value-moving type meets Guardian backpressure by requeueing (#312), so only
 * a caller that must wait out a 409 in process (a bridged-send) wraps this in
 * `withGuardianConflictRetry`.
 *
 * `approvalExpirationDelta` is the Guardian expiration of #1081 for the types that carry one: the rebuild drops the
 * request's own delta, so it travels here instead.
 */
export const proposeRebased = async (
  service: MultisigService,
  transaction: ITransaction,
  requestBytes: Uint8Array,
  proposalType: string,
  approvalExpirationDelta?: number
): Promise<Proposal> => {
  const rebased = await service.createRebasedCustomProposal(requestBytes, proposalType, approvalExpirationDelta);
  transaction.requestBytes = rebased.requestBytes;
  // The proposal exists by now: a failure here never means none was made.
  await withProposalStep('rebased_request_persist', () =>
    Repo.transactions.where({ id: transaction.id }).modify(t => {
      t.requestBytes = rebased.requestBytes;
    })
  );
  return rebased.proposal;
};
