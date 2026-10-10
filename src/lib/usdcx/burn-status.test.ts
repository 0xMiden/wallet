import { ITransaction, ITransactionStatus, IBridgedSendExtraInputs } from 'lib/miden/db/types';

import { burnPhaseFromStatus, pollUsdcxBurn } from './burn-status';

let stored: ITransaction;
const mockGetNetworkNoteStatus = jest.fn();
const mockFree = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteId: { fromHex: (id: string) => id },
  RpcClient: jest.fn(() => ({ getNetworkNoteStatus: mockGetNetworkNoteStatus, free: mockFree }))
}));
jest.mock('lib/miden/repo', () => ({
  transactions: { where: () => ({ modify: async (fn: (row: ITransaction) => void) => fn(stored) }) }
}));
jest.mock('lib/miden-chain/constants', () => ({ getRpcEndpoint: () => 'https://rpc.example' }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));

function row(phase: 'pending' | 'consuming' | 'confirmed' | 'discarded' = 'pending'): ITransaction {
  const extraInputs: IBridgedSendExtraInputs = {
    provider: 'usdcx',
    sourceFaucetId: 'faucet',
    destinationAddress: '0xrecipient',
    destinationNetwork: 11155111,
    claimStatus: 'not-applicable',
    usdcxBurn: { noteId: 'burn-note', destinationDomain: 0, phase }
  };
  return {
    id: 'row',
    type: 'bridged-send',
    accountId: 'sender',
    initiatedAt: 1,
    status: ITransactionStatus.Completed,
    displayIcon: 'SEND',
    extraInputs
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  stored = row();
});

it('reads burn status through its own RPC client and frees it', async () => {
  mockGetNetworkNoteStatus.mockResolvedValueOnce({ status: 'NullifierCommitted', attemptCount: 1 });
  await pollUsdcxBurn(stored);
  expect(mockGetNetworkNoteStatus).toHaveBeenCalledWith('burn-note');
  expect(stored.extraInputs.usdcxBurn.phase).toBe('confirmed');
  expect(mockFree).toHaveBeenCalledTimes(1);
});

it('frees the RPC client after a failed request and leaves the row pending', async () => {
  mockGetNetworkNoteStatus.mockRejectedValueOnce(new Error('timeout'));
  await expect(pollUsdcxBurn(stored)).rejects.toThrow('timeout');
  expect(stored.extraInputs.usdcxBurn.phase).toBe('pending');
  expect(mockFree).toHaveBeenCalledTimes(1);
});

it.each([
  ['Pending', 'pending'],
  ['NullifierInflight', 'consuming'],
  ['NullifierCommitted', 'confirmed'],
  ['Discarded', 'discarded']
])('persists %s as %s without resubmitting the sender transaction', async (status, phase) => {
  const read = jest.fn(async () => ({ status, attemptCount: 2, lastAttemptBlockNum: 500, lastError: 'diagnostic' }));
  await pollUsdcxBurn(stored, read);
  expect(read).toHaveBeenCalledWith('burn-note');
  expect(stored.extraInputs.usdcxBurn).toMatchObject({
    phase,
    attemptCount: 2,
    lastAttemptBlockNum: 500,
    lastError: 'diagnostic'
  });
  expect(stored.status).toBe(ITransactionStatus.Completed);
});

it('leaves timeouts and unknown node statuses pending so reopening can reconcile', async () => {
  await expect(
    pollUsdcxBurn(stored, async () => {
      throw new Error('timeout');
    })
  ).rejects.toThrow('timeout');
  expect(stored.extraInputs.usdcxBurn.phase).toBe('pending');
  await pollUsdcxBurn(stored, async () => ({ status: 'FutureStatus', attemptCount: 0 }));
  expect(stored.extraInputs.usdcxBurn.phase).toBe('pending');
  expect(burnPhaseFromStatus('FutureStatus')).toBeUndefined();
  await pollUsdcxBurn({ ...stored }, async () => ({ status: 'NullifierCommitted', attemptCount: 1 }));
  expect(stored.extraInputs.usdcxBurn.phase).toBe('confirmed');
});

it.each(['confirmed', 'discarded'])('does not overwrite %s with a stale response', async terminal => {
  await pollUsdcxBurn(stored, async () => {
    stored = row(terminal === 'confirmed' ? 'confirmed' : 'discarded');
    return { status: 'Pending', attemptCount: 0 };
  });
  expect(stored.extraInputs.usdcxBurn.phase).toBe(terminal);
});

it('does not poll restored, unsubmitted, or terminal rows', async () => {
  const read = jest.fn(async () => ({ status: 'Pending', attemptCount: 0 }));
  await pollUsdcxBurn({ ...stored, restoredFromBackup: true }, read);
  await pollUsdcxBurn({ ...stored, status: ITransactionStatus.Queued }, read);
  await pollUsdcxBurn(row('confirmed'), read);
  await pollUsdcxBurn(row('discarded'), read);
  expect(read).not.toHaveBeenCalled();
});

it('does not regress an in-flight consumption on an older pending response', async () => {
  stored = row('consuming');
  await pollUsdcxBurn(stored, async () => ({ status: 'Pending', attemptCount: 0 }));
  expect(stored.extraInputs.usdcxBurn.phase).toBe('consuming');
});
