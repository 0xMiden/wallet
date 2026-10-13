import { findUsdcxDestinationTransaction } from './destination-transaction';

// The destination's USDC and its fee allowance come from the network's bridge config.
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .testnetRuntimeMock()
);

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
  { label: 'too small', logs: [{ ...transfer, args: { value: 899999n } }] },
  { label: 'too large', logs: [{ ...transfer, args: { value: 1000001n } }] }
])('omits a $label transfer', async ({ logs }) => {
  mockGetLogs.mockResolvedValueOnce(logs);
  await expect(findUsdcxDestinationTransaction(args)).resolves.toBeUndefined();
});

it('finds a transfer that Circle reduced by its fee', async () => {
  mockGetLogs.mockResolvedValueOnce([{ ...transfer, args: { value: 988701n } }]);
  await expect(findUsdcxDestinationTransaction(args)).resolves.toBe(hash);
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

// Circle charges a flat ~1,003,500 (about 1.0035 USDC) to pay a burn out on Ethereum; the allowance is 1.5 USDC.
it('finds a Sepolia payout the flat fee cut under half the amount', async () => {
  mockGetLogs.mockResolvedValueOnce([{ ...transfer, args: { value: 996500n } }]);
  await expect(findUsdcxDestinationTransaction({ ...args, chainId: 11155111, amount: 2_000_000n })).resolves.toBe(hash);
});

it('does not search for a burn the allowance takes whole', async () => {
  await expect(
    findUsdcxDestinationTransaction({ ...args, chainId: 11155111, amount: 1_500_000n })
  ).resolves.toBeUndefined();
  expect(mockGetLogs).not.toHaveBeenCalled();
});
