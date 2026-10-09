import { findUsdcxDestinationTransaction } from './destination-transaction';

const mockGetLogs = jest.fn();
jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  createPublicClient: () => ({ getLogs: mockGetLogs })
}));

const args = {
  chainId: 5042002,
  recipient: '0x1111111111111111111111111111111111111111',
  amount: 1000000n,
  beforeBlock: '100',
  confirmedBlock: '110'
};
const hash = `0x${'a'.repeat(64)}`;
const transfer = { args: { value: 1000000n }, removed: false, transactionHash: hash };

beforeEach(() => {
  mockGetLogs.mockReset().mockResolvedValue([transfer]);
});

it('finds one matching transfer with one token and recipient filter', async () => {
  await expect(findUsdcxDestinationTransaction(args)).resolves.toBe(hash);
  expect(mockGetLogs).toHaveBeenCalledTimes(1);
  expect(mockGetLogs).toHaveBeenCalledWith(
    expect.objectContaining({
      address: '0x3600000000000000000000000000000000000000',
      args: { to: args.recipient },
      fromBlock: 101n,
      toBlock: 110n,
      strict: true
    })
  );
});

it('limits a long history to the last 2000 blocks before confirmation', async () => {
  await findUsdcxDestinationTransaction({ ...args, confirmedBlock: '100000' });
  expect(mockGetLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 98001n, toBlock: 100000n }));
  expect(mockGetLogs).toHaveBeenCalledTimes(1);
});

it.each([
  { label: 'missing', logs: [] },
  { label: 'ambiguous', logs: [transfer, { ...transfer, transactionHash: `0x${'b'.repeat(64)}` }] },
  { label: 'removed', logs: [{ ...transfer, removed: true }] },
  { label: 'wrong amount', logs: [{ ...transfer, args: { value: 999999n } }] }
])('omits a $label transfer', async ({ logs }) => {
  mockGetLogs.mockResolvedValueOnce(logs);
  await expect(findUsdcxDestinationTransaction(args)).resolves.toBeUndefined();
});

it('does not search an invalid recipient or empty block range', async () => {
  await expect(findUsdcxDestinationTransaction({ ...args, recipient: 'invalid' })).resolves.toBeUndefined();
  await expect(findUsdcxDestinationTransaction({ ...args, confirmedBlock: '100' })).resolves.toBeUndefined();
  expect(mockGetLogs).not.toHaveBeenCalled();
});

it('propagates RPC errors without a wider search', async () => {
  mockGetLogs.mockRejectedValueOnce(new Error('timeout'));
  await expect(findUsdcxDestinationTransaction(args)).rejects.toThrow('timeout');
  expect(mockGetLogs).toHaveBeenCalledTimes(1);
});
