import type { EVMToMidenQuote } from './bridge';
import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import { useEpochStore } from './store';

const mockRegister = jest.fn();
const mockGetRow = jest.fn();
const SOLVED_INTENT = {
  taskTypeString: 'bridge',
  intentData: {},
  intentNonce: 'nonce-1',
  solveResult: { hash: '0xdeposit' }
};
const mockBuildIntent = jest.fn();

jest.mock('./bridge', () => ({ buildEVMToMidenIntent: (...args: unknown[]) => mockBuildIntent(...args) }));
const mockConnection = jest.fn();
const mockSwitchWebWalletChain = jest.fn();
jest.mock('./client', () => ({
  getEvmConnection: () => mockConnection(),
  switchWebWalletChain: (...args: unknown[]) => mockSwitchWebWalletChain(...args)
}));
const mockGetEpochSdk = jest.fn(async (_opts?: { allocatorUrl?: string }) => ({}));
jest.mock('./sdk', () => ({ getEpochSdk: (opts?: { allocatorUrl?: string }) => mockGetEpochSdk(opts) }));
let mockDocumentAllocator = 'https://allocator.document';
jest.mock('lib/remote-config/values', () => ({ getEpochAllocatorUrl: () => mockDocumentAllocator }));
jest.mock('./intent-status', () => ({ readEpochIntentStatus: async () => [] }));
jest.mock('lib/miden/activity/bridge-in', () => ({
  registerPendingBridgeIn: (...args: unknown[]) => mockRegister(...args),
  resolveBridgeInNoteId: jest.fn()
}));
const mockUpdatePhase = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('lib/miden/transaction/complete', () => ({
  updateBridgedReceivePhase: (...a: unknown[]) => mockUpdatePhase(...a)
}));
jest.mock('lib/miden/repo', () => ({ transactions: { get: (...args: unknown[]) => mockGetRow(...args) } }));

const quote: EVMToMidenQuote = {
  taskTypeString: 'bridge',
  intentData: {},
  // Deliberately not the row's amount: the pending record must not re-derive it.
  quoteResult: { success: true, resourceLockRequired: false, transactions: [], tokenIn: '99' },
  params: {
    sourceChainId: 11155111,
    destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
    evmSourceAddress: '0xowner',
    evmTokenAddress: '0x0000000000000000000000000000000000000002',
    midenRecipientId: '0x0123456789abcdef0123456789abcd',
    midenFaucetId: '0x123456789abcdef0123456789abcde',
    minTokenOut: '1000000'
  }
};

beforeEach(() => {
  mockConnection.mockReset().mockResolvedValue({ address: '0xowner', isNative: true });
  mockSwitchWebWalletChain.mockReset().mockResolvedValue(undefined);
  mockRegister.mockReset().mockResolvedValue(undefined);
  mockBuildIntent.mockReset().mockResolvedValue(SOLVED_INTENT);
  mockGetRow.mockReset();
  mockGetEpochSdk.mockClear();
  mockUpdatePhase.mockClear();
  mockDocumentAllocator = 'https://allocator.document';
  useEpochStore.getState().reset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('records the pending bridge-in with the exact amount and the symbol the tracking row holds', async () => {
  mockGetRow.mockResolvedValue({
    id: 'row-1',
    type: 'bridged-receive',
    extraInputs: {
      provider: 'epoch',
      phase: 'submitting',
      sourceAddress: '0xowner',
      sourceAmount: '10.012345678901234567',
      sourceSymbol: 'USDC',
      epochAllocatorUrl: 'https://allocator.saved'
    }
  });
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });

  await useEpochStore.getState().executeEVMToMiden('row-1');

  expect(mockRegister).toHaveBeenCalledWith(
    '0xowner',
    'nonce-1',
    expect.objectContaining({
      sourceAmount: '10.012345678901234567',
      sourceSymbol: 'USDC',
      bridgeReceiveTxId: 'row-1',
      epochAllocatorUrl: 'https://allocator.saved'
    })
  );
});

// A USDCx deposit switches the web wallet to Arc or Base; the Fast route switches it back instead of failing.
it('switches a web wallet left on another chain to Sepolia before executing', async () => {
  mockGetRow.mockResolvedValue(undefined);
  mockConnection
    .mockResolvedValueOnce({ address: '0xowner', isNative: false, chainId: 5042002 })
    .mockResolvedValue({ address: '0xowner', isNative: false, chainId: 11155111 });
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });

  await useEpochStore.getState().executeEVMToMiden('row-1');

  expect(mockSwitchWebWalletChain).toHaveBeenCalledWith(11155111);
  expect(mockRegister).toHaveBeenCalled();
});

it('still refuses when the web wallet stays on another chain', async () => {
  mockConnection.mockResolvedValue({ address: '0xowner', isNative: false, chainId: 5042002 });
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });

  await useEpochStore.getState().executeEVMToMiden('row-1');

  expect(mockSwitchWebWalletChain).toHaveBeenCalledWith(11155111);
  expect(useEpochStore.getState()).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('did not switch to the source chain')
  });
  expect(mockRegister).not.toHaveBeenCalled();
});

it('refuses without switching when no wallet is connected, and when the wallet disconnects during the switch', async () => {
  mockConnection.mockResolvedValue({ isNative: false, chainId: 5042002 });
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });
  await useEpochStore.getState().executeEVMToMiden('row-1');
  expect(mockSwitchWebWalletChain).not.toHaveBeenCalled();

  mockConnection
    .mockResolvedValueOnce({ address: '0xowner', isNative: false, chainId: 5042002 })
    .mockResolvedValue({ isNative: false, chainId: 11155111 });
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });
  await useEpochStore.getState().executeEVMToMiden('row-1');

  expect(mockSwitchWebWalletChain).toHaveBeenCalledTimes(1);
  expect(useEpochStore.getState()).toMatchObject({ status: 'failed', error: 'Connect an EVM wallet first' });
  expect(mockRegister).not.toHaveBeenCalled();
});

// The Epoch SDK keeps only viem's flattened text, so the solve's failure reaches the row, and its report, as a string.
it('fails the tracking row at the solve, with what failed it, when the Epoch SDK refuses the intent', async () => {
  const refusal = 'An unknown RPC error occurred.\n\nDetails: User rejected the request.\nVersion: viem@2.55.4';
  mockGetRow.mockResolvedValue(undefined);
  mockBuildIntent.mockResolvedValue({ taskTypeString: 'bridge', intentData: {}, error: refusal });
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });

  await useEpochStore.getState().executeEVMToMiden('row-1');

  expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'failed', {
    error: refusal,
    failure: { step: 'epoch_solve', cause: refusal, requestClient: 'native_reown' }
  });

  mockUpdatePhase.mockClear();
  mockConnection.mockResolvedValueOnce({ address: '0xowner', isNative: false, chainId: 11155111 });
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });

  await useEpochStore.getState().executeEVMToMiden('row-1');

  expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'failed', {
    error: refusal,
    failure: { step: 'epoch_solve', cause: refusal, requestClient: 'wagmi' }
  });
  expect(mockSwitchWebWalletChain).not.toHaveBeenCalled();
});

it('fails the tracking row at the execute, with what failed it, when the deposit throws before the solve', async () => {
  const cause = new Error('Wallet did not switch');
  mockConnection.mockRejectedValue(cause);
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });

  await useEpochStore.getState().executeEVMToMiden('row-1');

  expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'failed', {
    error: 'Wallet did not switch',
    failure: { step: 'epoch_execute', cause }
  });
});

describe('the allocator an intent was submitted to', () => {
  const trackingRow = (epochAllocatorUrl?: string) => ({
    id: 'row-1',
    type: 'bridged-receive',
    extraInputs: { provider: 'epoch', phase: 'submitting', sourceAddress: '0xowner', epochAllocatorUrl }
  });

  it('is the one the tracking row saved, for the build and for every later status read', async () => {
    mockGetRow.mockResolvedValue(trackingRow('https://allocator.saved'));
    useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });

    await useEpochStore.getState().executeEVMToMiden('row-1');
    mockDocumentAllocator = 'https://allocator.moved';
    await useEpochStore.getState().poll();

    expect(mockGetEpochSdk).toHaveBeenLastCalledWith(
      expect.objectContaining({ allocatorUrl: 'https://allocator.saved' })
    );
  });

  it('is the document allocator at submission when the row saved none, on every sink', async () => {
    mockGetRow.mockResolvedValue(trackingRow());
    useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });

    await useEpochStore.getState().executeEVMToMiden('row-1');
    mockDocumentAllocator = 'https://allocator.moved';
    await useEpochStore.getState().poll();

    expect(mockRegister).toHaveBeenCalledWith(
      '0xowner',
      'nonce-1',
      expect.objectContaining({ epochAllocatorUrl: 'https://allocator.document' })
    );
    expect(mockUpdatePhase).toHaveBeenCalledWith(
      'row-1',
      'delivering',
      expect.objectContaining({ epochAllocatorUrl: 'https://allocator.document' })
    );
    expect(mockGetEpochSdk).toHaveBeenLastCalledWith(
      expect.objectContaining({ allocatorUrl: 'https://allocator.document' })
    );
  });

  it('is forgotten on reset', async () => {
    mockGetRow.mockResolvedValue(trackingRow('https://allocator.saved'));
    useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });
    await useEpochStore.getState().executeEVMToMiden('row-1');

    useEpochStore.getState().reset();

    expect(useEpochStore.getState().allocatorUrl).toBeNull();
  });
});

jest.mock('./receipt', () => ({
  createEpochReceiptOwner: () => ({ hooks: undefined, preparation: () => undefined, retentionFailed: () => false })
}));
