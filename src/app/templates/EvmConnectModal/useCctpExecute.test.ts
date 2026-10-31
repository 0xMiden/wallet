import { renderHook } from '@testing-library/react';

import { updateBridgedReceivePhase } from 'lib/miden/activity';
import { getUsdcxExecutorSource } from 'lib/usdcx/constant';
import { NativeReown, NativeSessionChainNotApprovedError, prepareNativeSessionChain } from 'lib/walletconnect/native';
import { EvmTransactionRevertedError, waitForEvmReceipt } from 'lib/walletconnect/receipt';

import { useCctpExecute } from './useCctpExecute';

jest.mock('lib/miden/repo', () => ({ transactions: { get: async () => undefined } }));

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
const mockWrite = jest.fn(async () => hash);
const mockSwitch = jest.fn();
let mockNativeAvailable = false;

jest.mock('wagmi', () => ({
  useWriteContract: () => ({ mutateAsync: mockWrite }),
  useSwitchChain: () => ({ switchChainAsync: mockSwitch })
}));
jest.mock('lib/miden/activity', () => ({ updateBridgedReceivePhase: jest.fn() }));
jest.mock('lib/walletconnect/fees', () => ({ readNativeFeeFields: async () => ({}) }));
jest.mock('lib/walletconnect/native', () => ({
  isNativeReownAvailable: () => mockNativeAvailable,
  NativeReown: { sendTransaction: jest.fn() },
  NativeSessionChainNotApprovedError:
    jest.requireActual<typeof import('lib/walletconnect/native')>('lib/walletconnect/native')
      .NativeSessionChainNotApprovedError,
  prepareNativeSessionChain: jest.fn(),
  unwrapNativeResult: (value: unknown) => value
}));
jest.mock('lib/walletconnect/receipt', () => ({
  ...jest.requireActual<typeof import('lib/walletconnect/receipt')>('lib/walletconnect/receipt'),
  waitForEvmReceipt: jest.fn()
}));

const leg = { sourceDomain: 6, message: '0x1234', attestation: '0xabcd' };

beforeEach(() => {
  jest.clearAllMocks();
  mockNativeAvailable = false;
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
  expect(updateBridgedReceivePhase).toHaveBeenCalledTimes(2);
  expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith('row', 'delivering', {
    cctp: { sourceDomain: 6, executeTxHash: hash }
  });
  unmount();
  warn.mockRestore();
});

describe('on native Reown', () => {
  const { target } = getUsdcxExecutorSource(84532);

  beforeEach(() => {
    mockNativeAvailable = true;
    jest.mocked(prepareNativeSessionChain).mockReset().mockResolvedValue(undefined);
    jest.mocked(NativeReown.sendTransaction).mockReset().mockResolvedValue({ hash });
  });

  it('refuses before the wallet prompt when the session did not approve the target chain', async () => {
    const refusal = new NativeSessionChainNotApprovedError(target.chain.id, target.chain.name);
    jest.mocked(prepareNativeSessionChain).mockRejectedValueOnce(refusal);
    const { result, unmount } = renderHook(useCctpExecute);

    const outcome = await result.current('row', 84532, leg).catch((error: unknown) => error);

    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
    expect(outcome).toBe(refusal);
    expect(prepareNativeSessionChain).toHaveBeenCalledWith(target.chain.id);
    expect(updateBridgedReceivePhase).not.toHaveBeenCalled();
    unmount();
  });

  it('prepares the target chain once, then executes on it', async () => {
    const { result, unmount } = renderHook(useCctpExecute);

    await expect(result.current('row', 84532, leg)).resolves.toBe(hash);

    expect(jest.mocked(prepareNativeSessionChain).mock.calls).toEqual([[target.chain.id]]);
    const [prepared] = jest.mocked(prepareNativeSessionChain).mock.invocationCallOrder;
    const [sent] = jest.mocked(NativeReown.sendTransaction).mock.invocationCallOrder;
    expect(prepared).toBeLessThan(sent!);
    expect(NativeReown.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: target.chain.id, to: target.executor })
    );
    unmount();
  });
});
