import { buildEVMToMidenIntent } from './bridge';
import { MIDEN_DESTINATION_CHAIN_ID } from './config';

jest.mock('lib/miden/activity', () => ({ updateEarnDepositStatus: jest.fn() }));
jest.mock('./earn-note', () => ({ createEarnP2IDENote: jest.fn() }));
jest.mock('./sdk', () => ({ getEpochReadOnlySdk: jest.fn() }));

const SPONSOR = '0x00000000000000000000000000000000000000aa';
const TOKEN = '0x0000000000000000000000000000000000000002';

const params = {
  sourceChainId: 11155111,
  destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
  evmSourceAddress: SPONSOR,
  evmTokenAddress: TOKEN,
  midenRecipientId: '0x0123456789abcdef0123456789abcd',
  midenFaucetId: '0x123456789abcdef0123456789abcde',
  minTokenOut: '1000000',
  preFetchedQuote: {
    taskTypeString: 'task',
    intentData: { tokenIn: TOKEN, tokenInAmount: '0' },
    quoteResult: { success: true, resourceLockRequired: true, transactions: [], tokenIn: '1000000' },
    params: {
      sourceChainId: 11155111,
      destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
      evmSourceAddress: SPONSOR,
      evmTokenAddress: TOKEN,
      midenRecipientId: '0x0123456789abcdef0123456789abcd',
      midenFaucetId: '0x123456789abcdef0123456789abcde',
      minTokenOut: '1000000'
    }
  }
};

const balances = (...values: string[]) => {
  const fn = jest.fn();
  for (const balance of values) {
    fn.mockResolvedValueOnce([{ depositId: '42', symbol: '', balance, decimals: 0, withdrawStatus: 'Disabled' }]);
  }
  return fn;
};

const refusedSolve = jest.fn(async () => {
  throw new Error('Nonce has already been used; request a fresh nonce');
});
const getTaskData = jest.fn();

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

it('reports the deposit that a refused allocation left in the lock (#2120)', async () => {
  const getDepositedBalances = balances('5', '1000005');

  const intent = await buildEVMToMidenIntent({ getTaskData, solveIntent: refusedSolve, getDepositedBalances }, params);

  expect(intent.error).toBe('Nonce has already been used; request a fresh nonce');
  expect(intent.strandedDeposit).toEqual({ lockId: '42', amount: '1000000', tokenAddress: TOKEN });
});

it('reports no deposit when the solve failed before the deposit', async () => {
  const getDepositedBalances = balances('5', '5');

  const intent = await buildEVMToMidenIntent({ getTaskData, solveIntent: refusedSolve, getDepositedBalances }, params);

  expect(intent.error).toBeDefined();
  expect(intent.strandedDeposit).toBeUndefined();
});

it('reads the native lock at the zero address', async () => {
  const getDepositedBalances = balances('0', '7');

  const intent = await buildEVMToMidenIntent(
    { getTaskData, solveIntent: refusedSolve, getDepositedBalances },
    { ...params, isNative: true }
  );

  expect(getDepositedBalances).toHaveBeenCalledWith(SPONSOR, [
    { address: '0x0000000000000000000000000000000000000000', symbol: '', decimals: 0 }
  ]);
  expect(intent.strandedDeposit).toEqual({
    lockId: '42',
    amount: '7',
    tokenAddress: '0x0000000000000000000000000000000000000000'
  });
});

it('does not read the lock again after a solve that succeeds', async () => {
  const getDepositedBalances = balances('5');
  const solveIntent = jest.fn(async () => ({ nonce: '9' }));

  const intent = await buildEVMToMidenIntent({ getTaskData, solveIntent, getDepositedBalances }, params);

  expect(intent.error).toBeUndefined();
  expect(intent.strandedDeposit).toBeUndefined();
  expect(getDepositedBalances).toHaveBeenCalledTimes(1);
});
