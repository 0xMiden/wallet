import { earnWithdrawExecutionIdentity, selectEarnWithdrawPreparedExecution } from 'lib/epoch/earn-withdraw-policy';
import {
  preparedExecution,
  PREPARED_FAUCET,
  PREPARED_OWNER,
  PREPARED_RECIPIENT
} from 'lib/epoch/testing/earn-prepared';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { transactions } from 'lib/miden/repo';

import { retryEarnWithdrawReceive } from './retry';

const dispatch = jest.fn();
jest.mock('lib/epoch', () => ({ retryEarnWithdrawal: (id: string) => dispatch(id) }));
jest.mock('@miden-sdk/miden-sdk', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk'),
  AccountId: {
    fromHex: (value: string) => {
      if (!/^0x[0-9a-f]{28,32}$/.test(value)) throw new Error('invalid account');
      return { toString: () => value };
    }
  }
}));

function sourceRow(): ITransaction {
  return {
    id: 'withdraw',
    accountId: PREPARED_RECIPIENT,
    initiatedAt: 1,
    status: ITransactionStatus.Completed,
    type: 'earn-withdraw',
    displayIcon: 'DEFAULT',
    extraInputs: {
      phase: 'failed',
      evmOwner: PREPARED_OWNER,
      marketUid: 'DUMMY_LENDING:11155111:token',
      sourceAmount: '10',
      sourceSymbol: 'USDC',
      destinationFaucetId: PREPARED_FAUCET,
      submissionState: 'preparing',
      submissionAttemptId: 'attempt-1'
    }
  };
}

function deliveryRow(): ITransaction {
  const row = sourceRow();
  const identity = earnWithdrawExecutionIdentity(row);
  if (!identity) throw new Error('invalid identity fixture');
  const saved = selectEarnWithdrawPreparedExecution(preparedExecution(), identity);
  if (!saved) throw new Error('invalid prepared execution fixture');
  row.extraInputs = {
    ...row.extraInputs,
    submissionState: 'prepared',
    withdrawIntentNonce: '22',
    preparedExecution: saved
  };
  return row;
}

beforeEach(() => dispatch.mockReset());

it.each([sourceRow, deliveryRow])('dispatches only a currently eligible withdrawal', async makeRow => {
  await transactions.put(makeRow());
  await retryEarnWithdrawReceive('withdraw');
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledWith('withdraw');
});

it.each([
  { phase: 'redeeming' },
  { submissionState: undefined },
  { withdrawIntentNonce: 'known-without-payload' },
  { preparedExecution: { delivery: {} } },
  { evmOwner: 'invalid' },
  { destinationFaucetId: undefined }
])('does not dispatch ambiguous or ineligible persisted data %j', changes => {
  const row = sourceRow();
  row.extraInputs = { ...row.extraInputs, ...changes };
  return transactions.put(row).then(async () => {
    await retryEarnWithdrawReceive(row.id);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it('rechecks the row after a previously eligible receipt changed', async () => {
  const row = deliveryRow();
  await transactions.put(row);
  await transactions.update(row.id, { 'extraInputs.withdrawIntentNonce': 'newer' });
  await retryEarnWithdrawReceive(row.id);
  expect(dispatch).not.toHaveBeenCalled();
});

it('refuses restored rows even when they contain a valid saved execution', async () => {
  const row = deliveryRow();
  row.restoredFromBackup = true;
  await transactions.put(row);
  await expect(retryEarnWithdrawReceive(row.id)).rejects.toThrow('restored from a backup');
  expect(dispatch).not.toHaveBeenCalled();
});

it('rejects an unknown or different transaction type', async () => {
  await expect(retryEarnWithdrawReceive('unknown')).rejects.toThrow('not an earn-withdraw');
  await transactions.put({ ...sourceRow(), type: 'send' });
  await expect(retryEarnWithdrawReceive('withdraw')).rejects.toThrow('not an earn-withdraw');
  expect(dispatch).not.toHaveBeenCalled();
});

it('preserves a domain retry rejection for the caller', async () => {
  await transactions.put(deliveryRow());
  dispatch.mockRejectedValueOnce(new Error('allocation unavailable'));
  await expect(retryEarnWithdrawReceive('withdraw')).rejects.toThrow('allocation unavailable');
});
