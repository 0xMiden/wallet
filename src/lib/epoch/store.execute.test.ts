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
jest.mock('./client', () => ({ getEvmConnection: async () => ({ address: '0xowner', isNative: true }) }));
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
