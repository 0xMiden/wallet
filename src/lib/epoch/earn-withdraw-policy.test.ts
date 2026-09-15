import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';

import {
  earnWithdrawalRetryKind,
  selectEarnWithdrawPreparedExecution,
  validateEarnWithdrawPreparedExecution
} from './earn-withdraw-policy';
import {
  preparedAllocation,
  preparedExecution,
  PREPARED_FAUCET,
  PREPARED_OWNER,
  PREPARED_RECIPIENT
} from './testing/earn-prepared';

jest.mock('@miden-sdk/miden-sdk', () => ({
  AccountId: {
    fromHex: (value: string) => {
      if (!/^0x[0-9a-f]{28,32}$/.test(value)) throw new Error('invalid account');
      return { toString: () => value };
    }
  }
}));
jest.mock('./bridge', () => ({ normalizeMidenIdToHex: (value: string) => value }));

const identity = {
  owner: PREPARED_OWNER,
  attemptId: 'attempt-1',
  sourceChainId: 11155111,
  destinationChainId: 999999999,
  recipientAccountId: PREPARED_RECIPIENT,
  destinationFaucetId: PREPARED_FAUCET
};

function row(): ITransaction {
  return {
    id: 'row-1',
    type: 'earn-withdraw',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    accountId: PREPARED_RECIPIENT,
    displayIcon: 'DEFAULT',
    extraInputs: {
      evmOwner: PREPARED_OWNER,
      marketUid: 'DUMMY_LENDING:11155111:token',
      destinationFaucetId: PREPARED_FAUCET,
      sourceAmount: '10',
      sourceSymbol: 'USDC',
      phase: 'failed',
      submissionAttemptId: 'attempt-1',
      submissionState: 'preparing'
    }
  };
}

it('retains every descriptor and selects the non-first Miden allocation', () => {
  const input = preparedExecution();
  const selected = selectEarnWithdrawPreparedExecution(input, identity);
  expect(selected?.allocations).toEqual(input.allocations);
  expect(selected?.delivery).toMatchObject({ allocationIndex: 1, nonce: '22' });
  expect(validateEarnWithdrawPreparedExecution(selected, identity)?.allocationRequests).toHaveLength(2);
});

it('rejects zero or multiple delivery matches without confusing total allocation count', () => {
  expect(
    selectEarnWithdrawPreparedExecution({ chainId: 11155111, allocations: [preparedAllocation('11', false)] }, identity)
  ).toBeUndefined();
  expect(
    selectEarnWithdrawPreparedExecution(
      { chainId: 11155111, allocations: [preparedAllocation('11', true), preparedAllocation('22', true)] },
      identity
    )
  ).toBeUndefined();
});

it('rejects delivery metadata omitted from its signed witness fields', () => {
  const allocation = preparedAllocation('22', true);
  const changed = {
    ...allocation,
    requestJson: allocation.requestJson.replace(',string midenRecipientAccount,string midenFaucetId', '')
  };
  expect(selectEarnWithdrawPreparedExecution({ chainId: 11155111, allocations: [changed] }, identity)).toBeUndefined();
});

it.each(['sponsor', 'nonce', 'expires', 'requestJson'])('rejects inconsistent descriptor %s', field => {
  const input = preparedExecution();
  const first = input.allocations[0];
  if (!first) throw new Error('fixture');
  const changed = { ...first, [field]: 'invalid' };
  expect(
    selectEarnWithdrawPreparedExecution({ ...input, allocations: [changed, ...input.allocations.slice(1)] }, identity)
  ).toBeUndefined();
});

it('separates proven source retry from same-allocation retry and legacy ambiguity', () => {
  const current = row();
  expect(earnWithdrawalRetryKind(current)).toBe('source');
  current.extraInputs.submissionState = undefined;
  expect(earnWithdrawalRetryKind(current)).toBeUndefined();
  current.extraInputs.submissionState = 'prepared';
  current.extraInputs.withdrawIntentNonce = '22';
  current.extraInputs.preparedExecution = selectEarnWithdrawPreparedExecution(preparedExecution(), identity);
  expect(earnWithdrawalRetryKind(current)).toBe('allocation');
  current.extraInputs.withdrawIntentNonce = '11';
  expect(earnWithdrawalRetryKind(current)).toBeUndefined();
  current.extraInputs.withdrawIntentNonce = '22';
  current.restoredFromBackup = true;
  expect(earnWithdrawalRetryKind(current)).toBeUndefined();
});

it.each(['prepared', 'accepted'])('refuses %s rows with no valid payload and no nonce', state => {
  const current = row();
  current.extraInputs.submissionState = state;
  expect(earnWithdrawalRetryKind(current)).toBeUndefined();
});

it.each(['evmTxHash', 'midenNoteId', 'outputAmount', 'outputSymbol', 'withdrawIntentNonce', 'preparedExecution'])(
  'refuses a source retry when preparing contains conflicting %s evidence',
  field => {
    const current = row();
    current.extraInputs[field] = '';
    expect(earnWithdrawalRetryKind(current)).toBeUndefined();
  }
);

it.each([undefined, null, {}, 1, 'market:not-a-chain'])(
  'refuses malformed market identity %s without throwing',
  market => {
    const current = row();
    current.extraInputs.marketUid = market;
    expect(earnWithdrawalRetryKind(current)).toBeUndefined();
  }
);
