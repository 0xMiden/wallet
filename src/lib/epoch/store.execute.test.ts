import type { EVMToMidenQuote } from './bridge';
import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import { useEpochStore } from './store';

const mockRegister = jest.fn();
const mockGetRow = jest.fn();

jest.mock('./bridge', () => ({
  buildEVMToMidenIntent: async () => ({
    taskTypeString: 'bridge',
    intentData: {},
    intentNonce: 'nonce-1',
    solveResult: { hash: '0xdeposit' }
  })
}));
const mockConnection = jest.fn();
const mockSwitchWebWalletChain = jest.fn();
jest.mock('./client', () => ({
  getEvmConnection: () => mockConnection(),
  switchWebWalletChain: (...args: unknown[]) => mockSwitchWebWalletChain(...args)
}));
jest.mock('./sdk', () => ({ getEpochSdk: async () => ({}) }));
jest.mock('lib/miden/activity/bridge-in', () => ({
  registerPendingBridgeIn: (...args: unknown[]) => mockRegister(...args),
  resolveBridgeInNoteId: jest.fn()
}));
jest.mock('lib/miden/transaction/complete', () => ({ updateBridgedReceivePhase: jest.fn(async () => undefined) }));
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
  mockGetRow.mockReset();
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
      sourceSymbol: 'USDC'
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
      bridgeReceiveTxId: 'row-1'
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
    error: expect.stringContaining('did not switch to Sepolia')
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
