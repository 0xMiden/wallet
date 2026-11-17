// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/approval.ts (MIT).
import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex, type PublicClient } from 'viem';

import { parseBridgeApproval, replaceApproval, type BridgeApproval } from 'lib/bridge/evm/approval';
import {
  captureSourceTransaction,
  recoverSourceTransaction,
  type SourceTransaction,
  type SourceTransactionClient
} from 'lib/bridge/evm/source-transaction';
import {
  bridgeOperationOf,
  findAdmittedBridgeOperation,
  recordBridgeApproval,
  type BridgeOperationSnapshot
} from 'lib/bridge/operation';
import * as Repo from 'lib/miden/repo';

export type TokenApprovalClient = SourceTransactionClient &
  Pick<PublicClient, 'readContract' | 'call' | 'waitForTransactionReceipt'>;

interface ApprovalRequest {
  operation: BridgeOperationSnapshot;
  chainId: number;
  account: Address;
  token: Address;
  spender: Address;
  amount: bigint;
  client: TokenApprovalClient;
  send: (to: Address, data: Hex, value: bigint) => Promise<Hash>;
  assertCurrent: () => Promise<void>;
}

async function approvalReceipt(
  client: TokenApprovalClient,
  initial: BridgeApproval,
  save: (approval: BridgeApproval) => Promise<void>
) {
  let approval = initial;
  const writes: Promise<void>[] = [];
  let replacementError: unknown;
  const receipt = await client
    .waitForTransactionReceipt({
      hash: approval.hash,
      timeout: 120000,
      onReplaced: replacement => {
        try {
          const transaction: SourceTransaction = {
            ...replacement.transaction,
            chainId: approval.chainId,
            value: replacement.transaction.value.toString()
          };
          approval = replaceApproval(approval, transaction);
          if (approval.replacementReason !== replacement.reason)
            throw new Error('Bridge approval replacement changed');
          writes.push(
            save(approval).catch(error => {
              replacementError = error;
            })
          );
        } catch (error) {
          replacementError = error;
        }
      }
    })
    .finally(async () => {
      await Promise.all(writes);
    });
  if (replacementError) throw replacementError;
  if (
    receipt.transactionHash.toLowerCase() !== approval.hash.toLowerCase() ||
    (receipt.status !== 'success' && receipt.status !== 'reverted')
  )
    throw new Error('Bridge approval receipt is not verified');
  return { approval, receipt };
}

async function settleEarlierApprovals(request: ApprovalRequest, allowance: () => Promise<bigint>): Promise<void> {
  const rows = await Repo.transactions
    .where('type')
    .equals('bridged-receive')
    .filter(row => !row.restoredFromBackup && !row.recovered)
    .toArray();
  await request.assertCurrent();
  for (const row of rows) {
    const original = bridgeOperationOf(row);
    if (
      !original ||
      original.operationId === request.operation.operationId ||
      (original.sourceAttempt?.hash && original.sourceAttempt.hash === row.extraInputs?.evmTxHash)
    )
      continue;
    const references = (original.approvals ?? []).filter(
      reference =>
        reference.chainId === request.chainId &&
        reference.account.toLowerCase() === request.account.toLowerCase() &&
        reference.token.toLowerCase() === request.token.toLowerCase() &&
        reference.spender.toLowerCase() === request.spender.toLowerCase() &&
        !original.approvals?.some(
          next => next.hash !== reference.hash && next.originalTransaction?.hash === reference.hash
        )
    );
    if (!references.length) continue;
    const admitted = await findAdmittedBridgeOperation(original);
    await request.assertCurrent();
    if (!admitted || bridgeOperationOf(admitted)?.revision !== original.revision || !original.sourceAttempt)
      throw new Error('Bridge pending approval ownership is not verified');
    const save = async (reference: BridgeApproval) => {
      if (!(await recordBridgeApproval(original.operationId, original.revision, reference)))
        throw new Error('Bridge pending approval ownership changed');
    };
    for (const saved of references) {
      const resolved = await recoverSourceTransaction(request.client, saved.chainId, saved.hash, saved.transaction);
      await request.assertCurrent();
      if (resolved.uncertain || !resolved.transaction) throw new Error('Bridge pending approval is not verified');
      let reference = parseBridgeApproval({ ...saved, transaction: resolved.transaction });
      await save(reference);
      await request.assertCurrent();
      if (resolved.replacement) {
        reference = replaceApproval(reference, resolved.replacement);
        await save(reference);
        await request.assertCurrent();
      }
      if (
        reference.replacementReason !== 'cancelled' &&
        reference.replacementReason !== 'replaced' &&
        BigInt(reference.amount) >= request.amount
      ) {
        const sufficient = await allowance();
        await request.assertCurrent();
        if (sufficient >= request.amount) continue;
      }
      await approvalReceipt(request.client, reference, save);
      await request.assertCurrent();
    }
  }
}

/** Passive facts only: a pending approval can never restart its original source attempt. */
export async function recoverTokenApprovals(
  operation: BridgeOperationSnapshot,
  client: TokenApprovalClient
): Promise<void> {
  const admitted = await findAdmittedBridgeOperation(operation);
  if (!admitted || bridgeOperationOf(admitted)?.revision !== operation.revision) return;
  for (const saved of operation.approvals ?? []) {
    if (
      saved.replacementReason === 'cancelled' ||
      saved.replacementReason === 'replaced' ||
      operation.approvals?.some(next => next.hash !== saved.hash && next.originalTransaction?.hash === saved.hash)
    )
      continue;
    const resolved = await recoverSourceTransaction(client, saved.chainId, saved.hash, saved.transaction);
    const row = await findAdmittedBridgeOperation(operation);
    if (!row || bridgeOperationOf(row)?.revision !== operation.revision) return;
    let reference = saved;
    if (resolved.transaction) {
      reference = parseBridgeApproval({ ...saved, transaction: resolved.transaction });
      if (!(await recordBridgeApproval(operation.operationId, operation.revision, reference))) return;
    }
    if (resolved.replacement && reference.transaction) {
      const replacement = replaceApproval(reference, resolved.replacement);
      await recordBridgeApproval(operation.operationId, operation.revision, replacement);
    }
  }
}

/** A receipt verifies the requested allowance, never permission to deposit after a scope change. */
export async function ensureTokenApproval(request: ApprovalRequest): Promise<void> {
  const { operation, client, chainId, account, token, spender, amount } = request;
  const allowance = () =>
    client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, spender] });
  const save = async (approval: BridgeApproval) => {
    if (!(await recordBridgeApproval(operation.operationId, operation.revision, approval)))
      throw new Error('Bridge approval ownership changed');
  };
  const approve = async (value: bigint) => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, value] });
    const result = await client.call({ account, to: token, data });
    if (result.data && result.data !== '0x' && BigInt(result.data) !== 1n)
      throw new Error('Bridge token approval was refused');
    const hash = await request.send(token, data, 0n);
    let approval: BridgeApproval = { chainId, account, token, spender, amount: value.toString(), hash };
    await save(approval);
    const transaction = await captureSourceTransaction(client, chainId, hash).catch(() => undefined);
    if (transaction) {
      approval = parseBridgeApproval({ ...approval, transaction });
      await save(approval);
    }
    const observed = await approvalReceipt(client, approval, save);
    if (observed.approval.replacementReason === 'cancelled' || observed.approval.replacementReason === 'replaced')
      throw new Error('Bridge token approval was cancelled or replaced');
    if (observed.receipt.status !== 'success') throw new Error('Bridge token approval reverted');
    await request.assertCurrent();
    const confirmed = await allowance();
    if (value === 0n ? confirmed !== 0n : confirmed < value) throw new Error('Bridge allowance is not confirmed');
  };
  await settleEarlierApprovals(request, allowance);
  const current = await allowance();
  if (current >= amount) return;
  if (current > 0n) await approve(0n);
  await approve(amount);
}
