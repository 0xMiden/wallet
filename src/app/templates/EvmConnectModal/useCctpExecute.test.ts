import { renderHook } from '@testing-library/react';

import { updateBridgedReceivePhase } from 'lib/miden/activity';
import { EvmTransactionRevertedError, waitForEvmReceipt } from 'lib/walletconnect/receipt';

import { useCctpExecute } from './useCctpExecute';

const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
const mockWrite = jest.fn(async () => hash);
const mockSwitch = jest.fn();

jest.mock('wagmi', () => ({
  useWriteContract: () => ({ mutateAsync: mockWrite }),
  useSwitchChain: () => ({ switchChainAsync: mockSwitch })
}));
jest.mock('lib/miden/activity', () => ({ updateBridgedReceivePhase: jest.fn() }));
jest.mock('lib/walletconnect/native', () => ({ isNativeReownAvailable: () => false }));
jest.mock('lib/walletconnect/receipt', () => ({
  ...jest.requireActual<typeof import('lib/walletconnect/receipt')>('lib/walletconnect/receipt'),
  waitForEvmReceipt: jest.fn()
}));

const leg = { sourceDomain: 6, message: '0x1234', attestation: '0xabcd' };

beforeEach(() => {
  jest.clearAllMocks();
});

// The order is recorded by both mocks and asserted after the call: an expect inside the receipt mock would throw
// into the hook's catch, which swallows every error but a revert.
it('saves the hash before the receipt can arrive', async () => {
  const order: string[] = [];
  jest.mocked(updateBridgedReceivePhase).mockImplementationOnce(async () => {
    order.push('save');
  });
  jest.mocked(waitForEvmReceipt).mockImplementationOnce(async () => {
    order.push('wait');
  });
  const { result, unmount } = renderHook(useCctpExecute);
  await expect(result.current('row', 84532, leg)).resolves.toBe(hash);
  expect(order).toEqual(['save', 'wait']);
  expect(updateBridgedReceivePhase).toHaveBeenCalledWith('row', 'delivering', {
    cctp: { sourceDomain: 6, executeTxHash: hash }
  });
  unmount();
});

it('clears the saved hash when the receipt shows a revert', async () => {
  const error = new EvmTransactionRevertedError('Arc');
  jest.mocked(waitForEvmReceipt).mockRejectedValueOnce(error);
  const { result, unmount } = renderHook(useCctpExecute);
  await expect(result.current('row', 84532, leg)).rejects.toBe(error);
  expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith('row', 'delivering', {
    cctp: {
      sourceDomain: 6,
      executeTxHash: undefined,
      message: undefined,
      attestation: undefined,
      forwarded: false,
      revertedExecuteTxHash: hash
    }
  });
  unmount();
});

it('keeps the saved hash when the receipt request fails', async () => {
  jest.mocked(waitForEvmReceipt).mockRejectedValueOnce(new Error('timeout'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const { result, unmount } = renderHook(useCctpExecute);
  await expect(result.current('row', 84532, leg)).resolves.toBe(hash);
  expect(updateBridgedReceivePhase).toHaveBeenCalledTimes(1);
  unmount();
  warn.mockRestore();
});
