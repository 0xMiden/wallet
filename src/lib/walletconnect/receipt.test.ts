import { sepolia } from 'viem/chains';

import { EvmTransactionRevertedError, waitForEvmReceipt } from './receipt';

const mockWaitForReceipt = jest.fn();
jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  createPublicClient: () => ({ waitForTransactionReceipt: mockWaitForReceipt })
}));

const hash: `0x${string}` = `0x${'1'.repeat(64)}`;

it('accepts a successful receipt', async () => {
  mockWaitForReceipt.mockResolvedValueOnce({ status: 'success' });
  await expect(waitForEvmReceipt(hash, sepolia)).resolves.toBeUndefined();
});

it('identifies a reverted receipt', async () => {
  mockWaitForReceipt.mockResolvedValueOnce({ status: 'reverted' });
  await expect(waitForEvmReceipt(hash, sepolia)).rejects.toBeInstanceOf(EvmTransactionRevertedError);
});

it('preserves a receipt request error without classifying it as a revert', async () => {
  const error = new Error('RPC disconnected');
  mockWaitForReceipt.mockRejectedValueOnce(error);
  await expect(waitForEvmReceipt(hash, sepolia)).rejects.toBe(error);
});
