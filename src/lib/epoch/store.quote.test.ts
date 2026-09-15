import type { CrossChainQuote, EVMToMidenQuote } from './bridge';
import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import { useEpochStore } from './store';
import type { CrossChainIntentParams, EVMToMidenIntentParams } from './types';

const mockGetEVMToMidenQuote = jest.fn();
const mockGetCrossChainQuote = jest.fn();

jest.mock('./bridge', () => ({
  getEVMToMidenQuote: (...args: unknown[]) => mockGetEVMToMidenQuote(...args),
  getCrossChainQuote: (...args: unknown[]) => mockGetCrossChainQuote(...args)
}));
jest.mock('./client', () => ({ getEvmConnection: async () => ({ address: '0xowner', isNative: true }) }));
jest.mock('./sdk', () => ({ getEpochSdk: async () => ({}) }));
jest.mock('lib/miden/activity/bridge-in', () => ({
  registerPendingBridgeIn: jest.fn(),
  resolveBridgeInNoteId: jest.fn()
}));
jest.mock('lib/miden/transaction/complete', () => ({ updateBridgedReceivePhase: jest.fn() }));
jest.mock('lib/miden/repo', () => ({ transactions: {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const depositParams = (minTokenOut: string): EVMToMidenIntentParams => ({
  sourceChainId: 11155111,
  destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
  evmSourceAddress: '0xowner',
  evmTokenAddress: '0x0000000000000000000000000000000000000002',
  midenRecipientId: '0x0123456789abcdef0123456789abcd',
  midenFaucetId: '0x123456789abcdef0123456789abcde',
  minTokenOut
});

const depositQuote = (minTokenOut: string): EVMToMidenQuote => ({
  taskTypeString: 'bridge',
  intentData: {},
  quoteResult: { success: true, resourceLockRequired: false, transactions: [], tokenIn: minTokenOut },
  params: depositParams(minTokenOut)
});

const withdrawParams = (minTokenOut: string): CrossChainIntentParams => ({
  midenAccountId: '0x0123456789abcdef0123456789abcd',
  midenFaucetId: '0x123456789abcdef0123456789abcde',
  midenReclaimHeight: 5_000,
  evmRecipient: '0x0000000000000000000000000000000000000003',
  destinationChainId: 11155111,
  outputTokenAddress: '0x0000000000000000000000000000000000000002',
  minTokenOut
});

const withdrawQuote = (minTokenOut: string): CrossChainQuote => ({
  taskTypeString: 'bridge',
  intentData: {},
  quoteResult: { success: true, resourceLockRequired: false, transactions: [], tokenIn: minTokenOut },
  params: withdrawParams(minTokenOut)
});

const quotedAmount = () => useEpochStore.getState().quote?.params.minTokenOut;

beforeEach(() => {
  mockGetEVMToMidenQuote.mockReset();
  mockGetCrossChainQuote.mockReset();
  useEpochStore.getState().reset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('Epoch quote actions apply only the latest request', () => {
  it('keeps the newer EVM→Miden quote when the older one answers last', async () => {
    const older = deferred<EVMToMidenQuote>();
    const newer = deferred<EVMToMidenQuote>();
    mockGetEVMToMidenQuote.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { quoteEVMToMiden } = useEpochStore.getState();

    const first = quoteEVMToMiden(depositParams('1000000'), '0xowner');
    const second = quoteEVMToMiden(depositParams('2000000'), '0xowner');
    newer.resolve(depositQuote('2000000'));
    await second;
    expect(quotedAmount()).toBe('2000000');

    older.resolve(depositQuote('1000000'));
    await first;
    expect(useEpochStore.getState()).toMatchObject({ status: 'quoted', flow: 'evm-to-miden', error: null });
    expect(quotedAmount()).toBe('2000000');
  });

  it('keeps the newer EVM→Miden quote when the older request fails last', async () => {
    const older = deferred<EVMToMidenQuote>();
    mockGetEVMToMidenQuote.mockReturnValueOnce(older.promise).mockResolvedValueOnce(depositQuote('2000000'));
    const { quoteEVMToMiden } = useEpochStore.getState();

    const first = quoteEVMToMiden(depositParams('1000000'), '0xowner');
    await quoteEVMToMiden(depositParams('2000000'), '0xowner');
    older.reject(new Error('allocator timeout'));
    await first;

    expect(useEpochStore.getState()).toMatchObject({ status: 'quoted', error: null });
    expect(quotedAmount()).toBe('2000000');
  });

  it('keeps the failure of the latest request when an older quote answers after it', async () => {
    const older = deferred<EVMToMidenQuote>();
    mockGetEVMToMidenQuote.mockReturnValueOnce(older.promise).mockRejectedValueOnce(new Error('no route'));
    const { quoteEVMToMiden } = useEpochStore.getState();

    const first = quoteEVMToMiden(depositParams('1000000'), '0xowner');
    await quoteEVMToMiden(depositParams('2000000'), '0xowner');
    older.resolve(depositQuote('1000000'));
    await first;

    expect(useEpochStore.getState()).toMatchObject({ status: 'failed', error: 'no route', quote: null });
  });

  it('keeps the newer Miden→EVM quote when the older one answers last', async () => {
    const older = deferred<CrossChainQuote>();
    mockGetCrossChainQuote.mockReturnValueOnce(older.promise).mockResolvedValueOnce(withdrawQuote('2000000'));
    const { quoteMidenToEVM } = useEpochStore.getState();

    const first = quoteMidenToEVM(withdrawParams('1000000'), '0xowner');
    await quoteMidenToEVM(withdrawParams('2000000'), '0xowner');
    older.resolve(withdrawQuote('1000000'));
    await first;

    expect(useEpochStore.getState()).toMatchObject({ status: 'quoted', flow: 'miden-to-evm', error: null });
    expect(quotedAmount()).toBe('2000000');
  });

  it('keeps the newer Miden→EVM quote when the older request fails last', async () => {
    const older = deferred<CrossChainQuote>();
    mockGetCrossChainQuote.mockReturnValueOnce(older.promise).mockResolvedValueOnce(withdrawQuote('2000000'));
    const { quoteMidenToEVM } = useEpochStore.getState();

    const first = quoteMidenToEVM(withdrawParams('1000000'), '0xowner');
    await quoteMidenToEVM(withdrawParams('2000000'), '0xowner');
    older.reject(new Error('allocator timeout'));
    await first;

    expect(useEpochStore.getState()).toMatchObject({ status: 'quoted', error: null });
    expect(quotedAmount()).toBe('2000000');
  });

  it('drops a quote that answers after a reset', async () => {
    const pending = deferred<EVMToMidenQuote>();
    mockGetEVMToMidenQuote.mockReturnValueOnce(pending.promise);

    const quoting = useEpochStore.getState().quoteEVMToMiden(depositParams('1000000'), '0xowner');
    useEpochStore.getState().reset();
    pending.resolve(depositQuote('1000000'));
    await quoting;

    expect(useEpochStore.getState()).toMatchObject({ status: 'idle', flow: null, quote: null, error: null });
  });
});
