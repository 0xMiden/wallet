import { v4 as uuid } from 'uuid';
import { isHash, isHex, type Hash } from 'viem';

import { configKey } from 'lib/bridge/core/routes';
import {
  bridgeOperationOf,
  captureBridgeWalletScope,
  findAdmittedBridgeOperation,
  hasBridgeOperation,
  type BridgeOperationSnapshot
} from 'lib/bridge/operation';
import type { ITransaction, IUsdcxCctpLeg } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import { cctpAllowsManualExecution } from 'lib/usdcx/cctp';
import type { UsdcxExecutorSource } from 'lib/usdcx/constant';
import { UsdcxBurnError } from 'lib/usdcx/withdrawal';

import { matchesCctpSourceMessage } from './cctp-message';
import { ownedCctpSourceProof } from './cctp-status';

type WalletScope = ReturnType<typeof captureBridgeWalletScope>;
export interface OwnedCctpExecution {
  rowId: string;
  operation: BridgeOperationSnapshot;
  sourceHash: Hash;
  source: UsdcxExecutorSource;
  leg: IUsdcxCctpLeg;
  invocationScope: WalletScope;
}

/** Tag absence is compatibility only for a real local tracking row, never a deleted/restored owner. */
export function captureCctpExecution(
  row: ITransaction | undefined,
  sourceChainId: number,
  leg: IUsdcxCctpLeg,
  invocationScope: WalletScope
): OwnedCctpExecution | undefined {
  const inputs = row?.extraInputs;
  if (
    !row ||
    row.type !== 'bridged-receive' ||
    row.restoredFromBackup ||
    row.recovered ||
    inputs?.provider !== 'usdcx' ||
    inputs.phase !== 'delivering'
  )
    throw new UsdcxBurnError('bridgeReviewChanged');
  if (!hasBridgeOperation(row)) return undefined;
  const operation = bridgeOperationOf(row);
  const source = inputs.usdcxSource;
  const hash = inputs.evmTxHash;
  const original = source?.route === 'cctp-executor' ? ownedCctpSourceProof(row, source) : undefined;
  if (
    !operation ||
    !source ||
    source.route !== 'cctp-executor' ||
    source.chain.id !== sourceChainId ||
    inputs.sourceChainId !== sourceChainId ||
    !isHash(hash) ||
    !original ||
    !isHex(leg.message) ||
    !isHex(leg.attestation) ||
    leg.attestation === '0x' ||
    !matchesCctpSourceMessage(original, leg.message) ||
    !cctpAllowsManualExecution(leg) ||
    configKey(inputs.cctp) !== configKey(leg) ||
    leg.executeTxHash
  )
    throw new UsdcxBurnError('bridgeReviewChanged');
  const prior = leg.executeAttempt;
  if (
    prior &&
    (prior.phase !== 'known' ||
      typeof prior.hash !== 'string' ||
      !isHash(prior.hash) ||
      ![leg.revertedExecuteTxHash, leg.stalledExecuteTxHash].some(
        value => value?.toLowerCase() === prior.hash?.toLowerCase()
      ))
  )
    throw new UsdcxBurnError('bridgeReviewChanged');
  return structuredClone({ rowId: row.id, operation, sourceHash: hash, source, leg, invocationScope });
}

/** Reserve once before invoking a wallet; no external await lives inside this transaction. */
export async function reserveCctpExecution(expected: OwnedCctpExecution): Promise<string> {
  return Repo.db.transaction('rw', Repo.transactions, async () => {
    const row = await findAdmittedBridgeOperation(expected.operation);
    const current = captureCctpExecution(row, expected.source.chain.id, expected.leg, expected.invocationScope);
    if (
      !current ||
      current.rowId !== expected.rowId ||
      current.operation.revision !== expected.operation.revision ||
      current.sourceHash !== expected.sourceHash ||
      configKey(current.source) !== configKey(expected.source) ||
      configKey(expected.invocationScope) !== configKey(captureBridgeWalletScope())
    )
      throw new UsdcxBurnError('bridgeReviewChanged');
    const id = uuid();
    await Repo.transactions.update(expected.rowId, { 'extraInputs.cctp.executeAttempt': { id, phase: 'uncertain' } });
    return id;
  });
}

/** Returned facts survive UI departure, but never replace a newer passive execution or terminal phase. */
export async function recordCctpExecutionHash(
  expected: OwnedCctpExecution,
  attemptId: string,
  hash: Hash
): Promise<void> {
  await Repo.db.transaction('rw', Repo.transactions, async () => {
    const row = await findAdmittedBridgeOperation(expected.operation);
    const original = row && bridgeOperationOf(row);
    const inputs = row?.extraInputs;
    const attempt = inputs?.cctp?.executeAttempt;
    if (
      !row ||
      row.id !== expected.rowId ||
      original?.revision !== expected.operation.revision ||
      inputs?.evmTxHash !== expected.sourceHash ||
      !attempt ||
      attempt.id !== attemptId ||
      (attempt.hash && attempt.hash.toLowerCase() !== hash.toLowerCase())
    )
      throw new UsdcxBurnError('bridgeReviewChanged');
    await Repo.transactions.update(row.id, { 'extraInputs.cctp.executeAttempt': { ...attempt, phase: 'known', hash } });
    if (inputs.phase === 'delivering' && !inputs.cctp?.executeTxHash)
      await updateBridgedReceivePhase(
        row.id,
        'delivering',
        { cctp: { sourceDomain: expected.leg.sourceDomain, executeTxHash: hash } },
        undefined,
        { onlyIfNoExecuteHash: true }
      );
  });
}
