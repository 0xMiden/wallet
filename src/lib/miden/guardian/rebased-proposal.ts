import type { Proposal } from '@openzeppelin/miden-multisig-client';

import type { ISwapExtraInputs, ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import type { RequestOrder } from 'lib/miden/sdk/apply-after-submit';
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
  const recordsOrder = transaction.type === 'swap';
  transaction.requestBytes = rebased.requestBytes;
  if (recordsOrder) transaction.extraInputs = withRequestOrder(transaction.extraInputs, rebased.order);
  // The proposal exists by now: a failure here never means none was made.
  await withProposalStep('rebased_request_persist', () =>
    Repo.transactions.where({ id: transaction.id }).modify(t => {
      t.requestBytes = rebased.requestBytes;
      if (recordsOrder) t.extraInputs = withRequestOrder(t.extraInputs, rebased.order);
    })
  );
  return rebased.proposal;
};

/**
 * A swap row's `extraInputs` recording `order` as the order of the request bytes written with them (`requestOrder`),
 * or without a record when no order was read off those bytes: a record left from other bytes would describe a request
 * the row no longer holds. Called only in the write that stores the bytes, and on the in-memory row the completion
 * reads.
 */
export const withRequestOrder = (
  extraInputs: ISwapExtraInputs | undefined,
  order: RequestOrder | undefined
): ISwapExtraInputs | undefined => {
  if (extraInputs === undefined) return undefined;
  const { requestOrder: _replaced, ...rest } = extraInputs;
  return order === undefined ? rest : { ...rest, requestOrder: { orderId: order.orderId, noteId: order.orderNoteId } };
};
