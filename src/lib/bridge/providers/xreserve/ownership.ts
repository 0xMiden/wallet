import type { Hash } from 'viem';

import { assertReviewedBridge } from 'lib/bridge/core/review';
import { configKey } from 'lib/bridge/core/routes';
import type { SubmissionChecks } from 'lib/bridge/core/submission';
import { assertBridgeOperationCurrent, bridgeOperationOf, recordBridgeSourceAttempt, type BridgeOperationSnapshot } from 'lib/bridge/operation';
import * as Repo from 'lib/miden/repo';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

export interface OwnedUsdcxDeposit {
  rowId: string;
  operation: BridgeOperationSnapshot;
  checks: Pick<SubmissionChecks, 'readCurrent' | 'now'>;
}

/** Uses only the receive wrapper's original CAS winner, never a reread revision or a second claim. */
export async function assertUsdcxDepositCurrent(owned: OwnedUsdcxDeposit): Promise<void> {
  const { operation, checks } = owned;
  const live = await checks.readCurrent();
  const row = await Repo.transactions.get(owned.rowId);
  const recorded = row && bridgeOperationOf(row);
  if (!row || !recorded || recorded.revision !== operation.revision ||
      recorded.sourceAttempt?.phase !== 'running' || row.extraInputs?.phase !== 'submitting' ||
      row.extraInputs.evmTxHash || row.extraInputs.intentNonce)
    throw new Error('Circle source ownership changed');
  assertBridgeOperationCurrent(row, operation);
  assertReviewedBridge(operation.review, live, checks.now());
  const current = getBridgeConfigSnapshot();
  const recovery = operation.review.route.recovery;
  if (operation.review.route.provider !== 'xreserve' || operation.review.route.mode !== 'receive' ||
      current.status !== 'ready' || configKey([current.network, current.config, current.derived]) !==
      configKey([recovery.network, recovery.config, recovery.derived]))
    throw new Error('Circle deposit terms changed');
}

export async function recordUsdcxDepositHash(owned: OwnedUsdcxDeposit, hash: Hash): Promise<void> {
  if (!(await recordBridgeSourceAttempt(owned.operation.operationId, owned.operation.revision, { hash })))
    throw new Error('Circle source identity could not be recorded');
}
