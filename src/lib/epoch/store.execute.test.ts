import { RelayApiError, RelayStillPendingError, RelayUnknownOutcomeError } from 'lib/evm-relay/errors';
import { reportOpenRelayJob } from 'lib/evm-relay/open-jobs';
import type { RelayJobRef } from 'lib/evm-relay/types';

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
  getEvmSourceConnection: (...args: unknown[]) => mockConnection(...args),
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
  mockGetRow.mockReset().mockResolvedValue({
    id: 'row-1',
    type: 'bridged-receive',
    extraInputs: { provider: 'epoch', phase: 'submitting', sourceAddress: '0xowner' }
  });
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

it('keeps a deposit that a refused allocation left in The Compact on the row, for recovery (#2120)', async () => {
  const refusal = 'Nonce has already been used; request a fresh nonce';
  jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
  mockBuildIntent.mockResolvedValue({
    taskTypeString: 'bridge',
    intentData: { tokenIn: '0x0000000000000000000000000000000000000002' },
    error: refusal,
    strandedDeposit: { lockId: '42', amount: '99', tokenAddress: '0x0000000000000000000000000000000000000002' }
  });
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });

  await useEpochStore.getState().executeEVMToMiden('row-1');

  expect(useEpochStore.getState()).toMatchObject({ status: 'failed', error: refusal });
  expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'failed', {
    error: refusal,
    epochAllocatorUrl: 'https://allocator.document',
    epochLockedDeposit: {
      sponsorAddress: '0xowner',
      chainId: 11155111,
      lockId: '42',
      tokenAddress: '0x0000000000000000000000000000000000000002',
      isNative: false,
      amount: '99',
      taskTypeString: 'bridge',
      intentData: { tokenIn: '0x0000000000000000000000000000000000000002' },
      lockedAt: 5000
    },
    failure: { step: 'epoch_solve', cause: refusal, requestClient: 'native_reown' }
  });
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

describe('a relay source', () => {
  const RELAY = '0x00000000000000000000000000000000000000aa';
  const relayQuote: EVMToMidenQuote = { ...quote, params: { ...quote.params, evmSourceAddress: RELAY } };
  const relayConnection = { address: RELAY, chainId: 11155111, isNative: false, isRelay: true };

  beforeEach(() => {
    mockConnection.mockReset().mockResolvedValue(relayConnection);
  });

  it('reads the reviewed source, switches no wallet chain, and binds the SDK to the relay address', async () => {
    useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: relayQuote });

    await useEpochStore.getState().executeEVMToMiden('row-1');

    expect(mockConnection).toHaveBeenCalledWith(RELAY, 11155111);
    expect(mockSwitchWebWalletChain).not.toHaveBeenCalled();
    expect(mockGetEpochSdk).toHaveBeenCalledWith(expect.objectContaining({ account: RELAY, chainId: 11155111 }));
    expect(mockRegister).toHaveBeenCalledWith(RELAY, 'nonce-1', expect.anything());
  });

  it('reports a refused solve with no wallet request client', async () => {
    mockBuildIntent.mockResolvedValue({ taskTypeString: 'bridge', intentData: {}, error: 'refused' });
    useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: relayQuote });

    await useEpochStore.getState().executeEVMToMiden('row-1');

    expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'failed', {
      error: 'refused',
      failure: { step: 'epoch_solve', cause: 'refused' }
    });
  });

  it('polls the intent status of the relay address with the relay SDK', async () => {
    useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: relayQuote });
    await useEpochStore.getState().executeEVMToMiden('row-1');
    mockGetEpochSdk.mockClear();

    await useEpochStore.getState().poll();

    expect(mockGetEpochSdk).toHaveBeenCalledWith(expect.objectContaining({ account: RELAY, chainId: 11155111 }));
  });

  describe('a relay send whose outcome is not known', () => {
    const JOB: RelayJobRef = { chainId: 11155111, id: `0x${'ab'.repeat(32)}`, deadline: 1_900_000_000 };
    const SDK_TEXT = 'An unknown RPC error occurred.\n\nDetails: relay: the outcome of the batch is not known';

    /** The SDK as it is: the submitter reports the open job, and the SDK gives back its own text alone. */
    function sdkLosesTheCause(job: RelayJobRef, address = RELAY, extra: Record<string, unknown> = {}) {
      mockBuildIntent.mockImplementation(async () => {
        reportOpenRelayJob(address, job);
        return { taskTypeString: 'bridge', intentData: {}, error: SDK_TEXT, ...extra };
      });
    }

    beforeEach(() => {
      useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: relayQuote });
    });

    it('keeps the row open with the job that the relay reported, when the SDK drops the cause', async () => {
      sdkLosesTheCause(JOB);

      await useEpochStore.getState().executeEVMToMiden('row-1');

      expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
      expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'submitting', { relayJob: JOB });
      expect(useEpochStore.getState()).toMatchObject({ status: 'failed', error: SDK_TEXT });
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it.each<[string, Error]>([
      ['a still-pending job', new RelayStillPendingError(JOB, `0x${'c1'.repeat(32)}`)],
      ['a job whose outcome is not known', new RelayUnknownOutcomeError(JOB)]
    ])('keeps the row open for %s in the cause chain of a thrown error', async (_name, relayError) => {
      mockBuildIntent.mockRejectedValue(new Error('wrapped', { cause: new Error('rpc', { cause: relayError }) }));

      await useEpochStore.getState().executeEVMToMiden('row-1');

      expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
      expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'submitting', { relayJob: JOB });
    });

    it('keeps the row open with the reported job when the build throws with the text alone', async () => {
      mockBuildIntent.mockImplementation(async () => {
        reportOpenRelayJob(RELAY, JOB);
        throw new Error(SDK_TEXT);
      });

      await useEpochStore.getState().executeEVMToMiden('row-1');

      expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'submitting', { relayJob: JOB });
      expect(mockUpdatePhase).not.toHaveBeenCalledWith('row-1', 'failed', expect.anything());
    });

    it('lets the stranded rule decide when the lock already shows the deposit', async () => {
      sdkLosesTheCause(JOB, RELAY, {
        strandedDeposit: { lockId: '42', amount: '99', tokenAddress: '0x0000000000000000000000000000000000000002' }
      });

      await useEpochStore.getState().executeEVMToMiden('row-1');

      expect(mockUpdatePhase).toHaveBeenCalledWith(
        'row-1',
        'failed',
        expect.objectContaining({
          epochLockedDeposit: expect.objectContaining({ lockId: '42', sponsorAddress: RELAY })
        })
      );
      expect(mockUpdatePhase).not.toHaveBeenCalledWith('row-1', 'submitting', expect.anything());
    });

    it.each<[string, RelayJobRef, string]>([
      ['another chain', { ...JOB, chainId: 84532 }, RELAY],
      ['another address', JOB, '0x00000000000000000000000000000000000000bb']
    ])('still fails the row for an open job of %s', async (_name, job, address) => {
      sdkLosesTheCause(job, address);

      await useEpochStore.getState().executeEVMToMiden('row-1');

      expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'failed', expect.objectContaining({ error: SDK_TEXT }));
    });

    it('still fails the row on a relay refusal, thrown or as text', async () => {
      const refusal = new RelayApiError('bad_signature', 400, 'no');
      mockBuildIntent.mockRejectedValue(new Error('wrapped', { cause: refusal }));

      await useEpochStore.getState().executeEVMToMiden('row-1');

      expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'failed', {
        error: 'wrapped',
        failure: { step: 'epoch_execute', cause: expect.any(Error) }
      });
    });

    it('does not carry an open job of an earlier attempt into the next one', async () => {
      sdkLosesTheCause(JOB);
      await useEpochStore.getState().executeEVMToMiden('row-1');
      // A report after the attempt ended reaches no watch.
      reportOpenRelayJob(RELAY, JOB);
      mockUpdatePhase.mockClear();
      mockBuildIntent.mockResolvedValue({ taskTypeString: 'bridge', intentData: {}, error: 'refused' });
      useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: relayQuote });

      await useEpochStore.getState().executeEVMToMiden('row-1');

      expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'failed', expect.objectContaining({ error: 'refused' }));
    });

    it('watches nothing for an external wallet', async () => {
      mockConnection.mockResolvedValue({ address: RELAY, isNative: true });
      sdkLosesTheCause(JOB);

      await useEpochStore.getState().executeEVMToMiden('row-1');

      expect(mockUpdatePhase).toHaveBeenCalledWith('row-1', 'failed', expect.objectContaining({ error: SDK_TEXT }));
    });
  });

  it('binds no account for an external wallet, and none for a source that is not an address', async () => {
    mockConnection.mockResolvedValue({ address: '0xowner', isNative: true });
    useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });
    await useEpochStore.getState().executeEVMToMiden('row-1');
    expect(mockGetEpochSdk).toHaveBeenCalledWith({ chainId: 11155111, allocatorUrl: 'https://allocator.document' });

    mockGetEpochSdk.mockClear();
    mockConnection.mockResolvedValue({ ...relayConnection, address: '0xowner' });
    useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote });
    await useEpochStore.getState().executeEVMToMiden('row-1');
    expect(mockGetEpochSdk).toHaveBeenCalledWith({ chainId: 11155111, allocatorUrl: 'https://allocator.document' });
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
