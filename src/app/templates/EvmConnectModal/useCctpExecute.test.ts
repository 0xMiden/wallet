import { renderHook } from '@testing-library/react';
import { decodeFunctionData } from 'viem';

import 'lib/bridge/testing/fixtures';

import type { BatchCall } from 'lib/evm-relay/batch';
import { RelayUnknownOutcomeError } from 'lib/evm-relay/errors';
import type { RelaySource } from 'lib/evm-relay/source';
import { updateBridgedReceivePhase } from 'lib/miden/activity';
import { BridgedReceiveTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { GENERIC_EXECUTOR_ABI, getUsdcxExecutorSource } from 'lib/usdcx/constant';
import { NativeReown, NativeSessionChainNotApprovedError, prepareNativeSessionChain } from 'lib/walletconnect/native';
import { EvmTransactionRevertedError, waitForEvmReceipt } from 'lib/walletconnect/receipt';

import { useCctpExecute } from './useCctpExecute';

jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));

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
// The row's source is a relay address of this wallet only when a case says so.
const mockFindRelaySource = jest.fn((_address: string): RelaySource | null => null);
const mockRelayServesChain = jest.fn((_chainId: number) => true);
const mockRelaySendCalls = jest.fn(async (_calls: BatchCall[]) => hash);
const mockBuildRelayProvider = jest.fn((_source: RelaySource, _chainId: number) => ({ sendCalls: mockRelaySendCalls }));
jest.mock('lib/evm-relay/source', () => ({
  findRelaySource: (address: string) => mockFindRelaySource(address),
  relayServesChain: (chainId: number) => mockRelayServesChain(chainId),
  buildRelayProvider: (source: RelaySource, chainId: number) => mockBuildRelayProvider(source, chainId)
}));

const leg = { sourceDomain: 6, message: '0x1234', attestation: '0xabcd' };
const RELAY: RelaySource = { accountPublicKey: 'account', address: '0x1111111111111111111111111111111111111111' };

beforeEach(async () => {
  jest.clearAllMocks();
  mockNativeAvailable = false;
  mockFindRelaySource.mockReturnValue(null);
  mockRelayServesChain.mockReturnValue(true);
  mockRelaySendCalls.mockResolvedValue(hash);
  await Repo.transactions.clear();
  const row = new BridgedReceiveTransaction(
    '0x387149ae66116cf114eebd60bb7381',
    1500000n,
    '0x4cbdcaffe75f0a317482224dae6436',
    'usdcx',
    '0x1111111111111111111111111111111111111111',
    '1.5',
    'USDC'
  );
  row.id = 'row';
  row.extraInputs = {
    ...row.extraInputs,
    phase: 'delivering',
    sourceChainId: 84532,
    usdcxSource: getUsdcxExecutorSource(84532),
    cctp: structuredClone(leg)
  };
  await Repo.transactions.add(row);
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

describe('from the relay address', () => {
  const { target } = getUsdcxExecutorSource(84532);

  beforeEach(() => {
    mockFindRelaySource.mockReturnValue(RELAY);
  });

  it('executes on the target chain through the relay, with no wallet prompt and no chain switch', async () => {
    const { result, unmount } = renderHook(useCctpExecute);

    await expect(result.current('row', 84532, leg)).resolves.toBe(hash);

    expect(mockFindRelaySource).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111');
    expect(mockRelayServesChain).toHaveBeenCalledWith(target.chain.id);
    expect(mockBuildRelayProvider).toHaveBeenCalledWith(RELAY, target.chain.id);
    const calls = mockRelaySendCalls.mock.calls[0]?.[0] ?? [];
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('no relay call');
    expect(call).toMatchObject({ to: target.executor, value: 0n });
    expect(decodeFunctionData({ abi: GENERIC_EXECUTOR_ABI, data: call.data })).toEqual({
      functionName: 'execute',
      args: [leg.message, leg.attestation]
    });
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockSwitch).not.toHaveBeenCalled();
    expect(prepareNativeSessionChain).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('row', 'delivering', {
      cctp: { sourceDomain: 6, executeTxHash: hash }
    });
    unmount();
  });

  it('records nothing when the relay outcome is not known', async () => {
    const unknown = new RelayUnknownOutcomeError({ chainId: target.chain.id, id: `0x${'ab'.repeat(32)}`, deadline: 1 });
    mockRelaySendCalls.mockRejectedValueOnce(unknown);
    const { result, unmount } = renderHook(useCctpExecute);

    await expect(result.current('row', 84532, leg)).rejects.toBe(unknown);

    expect(updateBridgedReceivePhase).not.toHaveBeenCalled();
    unmount();
  });

  it('executes from the connected wallet when the relay does not serve the target chain', async () => {
    mockRelayServesChain.mockReturnValue(false);
    const { result, unmount } = renderHook(useCctpExecute);

    await expect(result.current('row', 84532, leg)).resolves.toBe(hash);

    expect(mockBuildRelayProvider).not.toHaveBeenCalled();
    expect(mockSwitch).toHaveBeenCalledWith({ chainId: target.chain.id });
    expect(mockWrite).toHaveBeenCalled();
    unmount();
  });
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
