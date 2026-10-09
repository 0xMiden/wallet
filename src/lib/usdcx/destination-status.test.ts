import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus } from 'lib/miden/db/types';

import { pollUsdcxDestination, readUsdcxDestinationBalance } from './destination-status';

jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));

let stored: ITransaction;
const mockReadContract = jest.fn();
const mockGetBlockNumber = jest.fn();
jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  createPublicClient: () => ({ readContract: mockReadContract, getBlockNumber: mockGetBlockNumber })
}));
jest.mock('lib/miden/repo', () => ({
  transactions: { where: () => ({ modify: async (fn: (row: ITransaction) => void) => fn(stored) }) }
}));

const recipient = '0x1111111111111111111111111111111111111111';
const before = { balance: '5000000', blockNumber: '100' };
const arrived = { balance: '6000000', blockNumber: '101' };
const read = jest.fn(async () => arrived);

function row(burn: Partial<NonNullable<IBridgedSendExtraInputs['usdcxBurn']>> = {}): ITransaction {
  const extraInputs: IBridgedSendExtraInputs = {
    provider: 'usdcx',
    sourceFaucetId: 'faucet',
    destinationAddress: recipient,
    destinationNetwork: 5042002,
    claimStatus: 'not-applicable',
    usdcxBurn: {
      noteId: 'note-1',
      destinationDomain: 26,
      phase: 'confirmed',
      destinationBalanceBefore: before,
      ...burn
    }
  };
  return {
    id: 'row',
    type: 'bridged-send',
    accountId: 'sender',
    initiatedAt: 1,
    status: ITransactionStatus.Completed,
    displayIcon: 'SEND',
    amount: 1000000n,
    extraInputs
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  stored = row();
});

it('reads the recipient USDC balance at the reported block', async () => {
  mockGetBlockNumber.mockResolvedValueOnce(101n);
  mockReadContract.mockResolvedValueOnce(6000000n);
  await expect(readUsdcxDestinationBalance(5042002, recipient)).resolves.toEqual(arrived);
  expect(mockReadContract).toHaveBeenCalledWith(
    expect.objectContaining({
      address: '0x3600000000000000000000000000000000000000',
      functionName: 'balanceOf',
      args: [recipient],
      blockNumber: 101n
    })
  );
});

it('confirms arrival and preserves burn confirmation', async () => {
  await pollUsdcxDestination(stored, read);
  expect(read).toHaveBeenCalledWith(5042002, recipient);
  expect(stored.extraInputs.usdcxBurn).toMatchObject({
    phase: 'confirmed',
    destinationBalanceBefore: before,
    destinationBalanceConfirmed: arrived
  });
  await pollUsdcxDestination(stored, read);
  expect(read).toHaveBeenCalledTimes(1);
});

it.each([
  { balance: '5000000', blockNumber: '101' },
  // One unit below the amount minus Arc's 0.1 USDC fee allowance.
  { balance: '5899999', blockNumber: '101' },
  { balance: '4000000', blockNumber: '101' },
  { balance: '6000000', blockNumber: '100' },
  { balance: '6000000', blockNumber: '99' }
])('keeps the burn stage for insufficient or stale evidence: %j', async observation => {
  await pollUsdcxDestination(stored, async () => observation);
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toBeUndefined();
});

it('confirms a payout that Circle reduced by its fee', async () => {
  const afterFee = { balance: '5988701', blockNumber: '101' };
  await pollUsdcxDestination(stored, async () => afterFee);
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(afterFee);
});

it('retries after an RPC error', async () => {
  read.mockRejectedValueOnce(new Error('timeout'));
  await expect(pollUsdcxDestination(stored, read)).rejects.toThrow('timeout');
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toBeUndefined();
  await pollUsdcxDestination(stored, read);
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(arrived);
});

it('does not check old, restored, unsubmitted or unburned rows', async () => {
  await pollUsdcxDestination(row({ destinationBalanceBefore: undefined }), read);
  await pollUsdcxDestination({ ...stored, restoredFromBackup: true }, read);
  await pollUsdcxDestination({ ...stored, status: ITransactionStatus.Queued }, read);
  await pollUsdcxDestination(row({ phase: 'pending' }), read);
  await pollUsdcxDestination(row({ phase: 'discarded' }), read);
  expect(read).not.toHaveBeenCalled();
});

it('does not apply an RPC response after the burn note changes', async () => {
  await pollUsdcxDestination(stored, async () => {
    stored = row({ noteId: 'note-2' });
    return arrived;
  });
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toBeUndefined();
});

it('does not overwrite confirmation from another window', async () => {
  const other = { balance: '7000000', blockNumber: '102' };
  await pollUsdcxDestination(stored, async () => {
    stored = row({ destinationBalanceConfirmed: other });
    return arrived;
  });
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(other);
});
