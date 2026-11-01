import type { EpochIntentSDK } from '@epoch-protocol/epoch-intents-sdk';

import type { IEpochExecutionReceipt, ITransaction } from 'lib/miden/db/types';
import { recoveryCompactRequest, recoveryEpochExecution } from 'lib/miden/recovery/provider-record';
import { checkpointProviderReceipt } from 'lib/miden/recovery/receipt-writer';
import { sameRecoveryFields } from 'lib/miden/recovery/transaction-record';
import * as Repo from 'lib/miden/repo';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { assertStorageHealthy, getStorageHealth } from 'lib/miden/storage-health';

import type { EpochPreparedIntent, EpochReceiptHooks } from './bridge';
import { getEpochSdkConfig } from './sdk';

function sameMidenIdentity(left: string, right: string): boolean {
  try {
    return accountRefToSdk(left).toString() === accountRefToSdk(right).toString();
  } catch {
    return false;
  }
}

export function validateEpochReceiptOwner(row: ITransaction, receipt: IEpochExecutionReceipt): void {
  const request = recoveryCompactRequest.parse(JSON.parse(receipt.requestJson));
  const inputs = row.extraInputs;
  const owner =
    row.type === 'earn-deposit'
      ? inputs.evmRecipient
      : row.type === 'bridged-send'
        ? inputs.destinationAddress
        : inputs.sourceAddress;
  if (typeof owner !== 'string' || owner.toLowerCase() !== request.compact.sponsor.toLowerCase())
    throw new Error('Epoch receipt owner changed');
  const mandate = request.compact.mandate;
  const account = receipt.collateralType === 'miden' ? mandate.midenSourceAccount : mandate.midenRecipientAccount;
  if (
    !account ||
    !sameMidenIdentity(row.accountId, account) ||
    !row.faucetId ||
    !mandate.midenFaucetId ||
    !sameMidenIdentity(row.faucetId, mandate.midenFaucetId)
  )
    throw new Error('Epoch receipt Miden binding changed');
  if (
    row.type === 'bridged-receive' &&
    (inputs.provider !== 'epoch' || inputs.sourceChainId !== Number(request.chainId))
  )
    throw new Error('Epoch receipt source changed');
  if (row.type !== 'bridged-receive' && row.type !== 'bridged-send' && row.type !== 'earn-deposit')
    throw new Error('Unsupported Epoch receipt owner');
}

export function createEpochReceiptOwner(sdk: EpochIntentSDK, getRowId: () => string | undefined) {
  const epoch = getStorageHealth().epoch;
  let prepared: IEpochExecutionReceipt | undefined;
  let retentionFailed = false;
  const assertCurrent = () => assertStorageHealthy(epoch);
  const retain = async (next: IEpochExecutionReceipt, initial = false): Promise<void> => {
    assertCurrent();
    const id = getRowId();
    if (!id) throw new Error('Epoch receipt has no collateral row');
    let accepted: ITransaction | undefined;
    await Repo.transactions.where({ id }).modify(row => {
      assertCurrent();
      if (row.restoredFromBackup) throw new Error('Restored Epoch receipts cannot execute');
      validateEpochReceiptOwner(row, next);
      const previous: IEpochExecutionReceipt | undefined = row.extraInputs.epochExecution;
      if (
        initial
          ? previous !== undefined || row.extraInputs.sourceSubmission !== 'not-started'
          : !previous || !prepared || !sameRecoveryFields(previous, prepared)
      ) {
        throw new Error('Epoch attempt requires reconciliation');
      }
      row.extraInputs = {
        ...row.extraInputs,
        epochExecution: next,
        intentNonce: recoveryCompactRequest.parse(JSON.parse(next.requestJson)).compact.nonce,
        ...(row.type === 'bridged-receive' ? { sourceSubmission: 'attempted' } : {})
      };
      accepted = { ...row };
    });
    if (!accepted) throw new Error('Epoch receipt row disappeared');
    try {
      await checkpointProviderReceipt(accepted);
    } catch (error) {
      retentionFailed = true;
      throw error;
    }
    assertCurrent();
    const current = await Repo.transactions.get(id);
    if (!current || current.restoredFromBackup || !sameRecoveryFields(current.extraInputs.epochExecution, next))
      throw new Error('Epoch attempt changed during retention');
    prepared = next;
  };
  const hooks: EpochReceiptHooks = {
    config: getEpochSdkConfig(sdk),
    assertCurrent,
    hasPrepared: () => prepared !== undefined,
    beforeExecute: async (value: EpochPreparedIntent) => {
      const next = recoveryEpochExecution.parse({
        ...value,
        submission: 'prepared',
        transactionHashes: [],
        batchIds: []
      });
      if (prepared) throw new Error('Epoch execution already prepared');
      if (getRowId()) await retain(next, true);
      else {
        if (next.collateralType !== 'miden' || !next.resourceLockRequired)
          throw new Error('Epoch execution needs a retained source row');
        prepared = next;
      }
    },
    onSubmitted: async (kind, id) => {
      if (!prepared) throw new Error('Epoch execution is not prepared');
      const field = kind === 'batch' ? 'batchIds' : 'transactionHashes';
      const next = recoveryEpochExecution.parse({ ...prepared, [field]: [...new Set([...prepared[field], id])] });
      await retain(next);
    },
    onAllocated: async allocation => {
      if (!prepared) throw new Error('Epoch execution is not prepared');
      await retain(recoveryEpochExecution.parse({ ...prepared, submission: 'accepted', allocation }));
    },
    beforeAllocation: async requestJson => {
      if (!prepared) throw new Error('Epoch execution is not prepared');
      const previous = recoveryCompactRequest.parse(JSON.parse(prepared.requestJson));
      const current = recoveryCompactRequest.parse(JSON.parse(requestJson));
      const withoutNote = (request: typeof previous) => ({
        ...request,
        compact: { ...request.compact, mandate: { ...request.compact.mandate, midenNoteId: undefined } }
      });
      if (!sameRecoveryFields(withoutNote(previous), withoutNote(current)))
        throw new Error('Epoch allocation changed after preparation');
      await retain(recoveryEpochExecution.parse({ ...prepared, requestJson, submission: 'allocation-attempted' }));
    }
  };
  return { hooks, preparation: () => prepared, retentionFailed: () => retentionFailed };
}
