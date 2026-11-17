// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/approval.ts (MIT).
import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex } from 'viem';

import { parseBridgeApproval, replaceApproval, type BridgeApproval } from 'lib/bridge/evm/approval';
import { captureSourceTransaction, type SourceTransaction } from 'lib/bridge/evm/source-transaction';
import { recordBridgeApproval, type BridgeOperationSnapshot } from 'lib/bridge/operation';

import type { AgglayerClient } from './deposit';

interface ApprovalRequest {
  operation: BridgeOperationSnapshot;
  chainId: number;
  account: Address;
  token: Address;
  spender: Address;
  amount: bigint;
  client: AgglayerClient;
  send: (to: Address, data: Hex, value: bigint) => Promise<Hash>;
  assertCurrent: () => Promise<void>;
}

/** A receipt verifies the requested allowance, never permission to deposit after a scope change. */
export async function ensureAgglayerApproval(request: ApprovalRequest): Promise<void> {
  const { operation, client, chainId, account, token, spender, amount } = request;
  const allowance = () => client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, spender] });
  const save = async (approval: BridgeApproval) => {
    if (!(await recordBridgeApproval(operation.operationId, operation.revision, approval)))
      throw new Error('Agglayer approval ownership changed');
  };
  const approve = async (value: bigint) => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, value] });
    const result = await client.call({ account, to: token, data });
    if (result.data && result.data !== '0x' && BigInt(result.data) !== 1n)
      throw new Error('Agglayer token approval was refused');
    const hash = await request.send(token, data, 0n);
    let approval: BridgeApproval = { chainId, account, token, spender, amount: value.toString(), hash };
    await save(approval);
    const transaction = await captureSourceTransaction(client, chainId, hash).catch(() => undefined);
    if (transaction) {
      approval = parseBridgeApproval({ ...approval, transaction });
      await save(approval);
    }
    const replacements: Promise<void>[] = [];
    let replacementError: unknown;
    const receipt = await client.waitForTransactionReceipt({
      hash, timeout: 120000,
      onReplaced: replacement => {
        try {
          const tx: SourceTransaction = { ...replacement.transaction, chainId, value: replacement.transaction.value.toString() };
          approval = replaceApproval(approval, tx);
          if (approval.replacementReason !== replacement.reason) throw new Error('Agglayer approval replacement changed');
          replacements.push(save(approval));
        } catch (error) { replacementError = error; }
      }
    });
    await Promise.all(replacements);
    if (replacementError) throw replacementError;
    if (approval.replacementReason === 'cancelled' || approval.replacementReason === 'replaced')
      throw new Error('Agglayer token approval was cancelled or replaced');
    if (receipt.status !== 'success') throw new Error('Agglayer token approval reverted');
    await request.assertCurrent();
    const confirmed = await allowance();
    if (value === 0n ? confirmed !== 0n : confirmed < value) throw new Error('Agglayer allowance is not confirmed');
  };
  const current = await allowance();
  if (current >= amount) return;
  if (current > 0n) await approve(0n);
  await approve(amount);
}
