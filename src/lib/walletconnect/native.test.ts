import { type NativeFeeFields, readNativeFeeFields } from './fees';
import {
  assertNativeSessionChain,
  buildNativeReownProvider,
  ensureNativeSessionChain,
  NativeReown,
  NativeSessionChainNotApprovedError,
  prepareNativeSessionChain,
  ReownState
} from './native';

const mockStateListeners: Array<(state: ReownState) => void> = [];
const mockRemoveListener = jest.fn(async () => undefined);

// The plugin object is built inside the factory: `registerPlugin` runs when `./native` loads,
// before any constant in this file is initialized.
jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    getState: jest.fn(),
    request: jest.fn(),
    sendTransaction: jest.fn(),
    addListener: jest.fn(async (_eventName: string, listener: (state: ReownState) => void) => {
      mockStateListeners.push(listener);
      return { remove: mockRemoveListener };
    })
  })
}));
jest.mock('lib/platform', () => ({ isAndroid: () => false, isIOS: () => true }));
jest.mock('./fees', () => ({ readNativeFeeFields: jest.fn() }));

const SEPOLIA = 11155111;
const ARC = 5042002;

// Arc Testnet with a public RPC that differs from its `rpcUrl`; every other chain is the registry's own.
jest.mock('./config', () => {
  const actual = jest.requireActual<typeof import('./config')>('./config');
  return {
    ...actual,
    getChain: (id: number) =>
      id === 5042002
        ? {
            id: 5042002,
            name: 'Arc Testnet',
            rpcUrl: 'https://rpc.walletconnect.org/v1?chainId=eip155:5042002&projectId=secret',
            publicRpcUrl: 'https://rpc.testnet.arc.network',
            explorer: 'https://testnet.arcscan.app',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }
          }
        : actual.getChain(id)
  };
});

const sessionState = (chainIds?: number[]): ReownState => ({
  configured: true,
  connected: true,
  topic: 'topic-1',
  address: '0x00000000000000000000000000000000000000e1',
  accounts: ['0x00000000000000000000000000000000000000e1'],
  chainId: SEPOLIA,
  chainIds
});

const mockSendTransaction = jest.mocked(NativeReown.sendTransaction);
const ESTIMATE: NativeFeeFields = { maxFeePerGas: '0x64', maxPriorityFeePerGas: '0x2' };
const provider = buildNativeReownProvider({ chainId: 11155111, address: '0xowner', rpcUrl: 'https://rpc.test' });
const send = (tx: Record<string, string>) =>
  provider.request({ method: 'eth_sendTransaction', params: [{ to: '0xto', data: '0x', ...tx }] });

beforeEach(() => {
  jest.clearAllMocks();
  mockStateListeners.length = 0;
  // The add-and-switch attempt logs a rejection it swallows.
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  // The session approved Sepolia, the chain every send below ends up on.
  jest.mocked(NativeReown.getState).mockResolvedValue(sessionState([SEPOLIA]));
  mockSendTransaction.mockResolvedValue({ hash: '0xhash' });
  jest.mocked(readNativeFeeFields).mockResolvedValue(ESTIMATE);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// A caller that set no fee gets fields with headroom; one that set any fee field keeps what it set.
it('sends the fee estimate when the caller set no fee', async () => {
  await send({});

  expect(readNativeFeeFields).toHaveBeenCalledWith(11155111);
  expect(mockSendTransaction).toHaveBeenCalledWith(expect.objectContaining(ESTIMATE));
});

it.each([
  ['gasPrice', { gasPrice: '0x9' }],
  ['maxFeePerGas', { maxFeePerGas: '0x50', maxPriorityFeePerGas: '0x3' }],
  ['only maxPriorityFeePerGas', { maxPriorityFeePerGas: '0x3' }]
])('keeps the fee the caller set with %s and reads no estimate', async (_label, fee) => {
  await send(fee);

  expect(readNativeFeeFields).not.toHaveBeenCalled();
  expect(mockSendTransaction).toHaveBeenCalledWith(expect.objectContaining(fee));
});

it('routes reads and sends to the selected chain after a claim switches chains', async () => {
  const switched = buildNativeReownProvider({ chainId: 5042002, address: '0xowner', rpcUrl: 'https://arc.test' });
  await switched.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
  expect(await switched.request({ method: 'eth_chainId' })).toBe('0xaa36a7');
  await switched.request({ method: 'eth_sendTransaction', params: [{ to: '0xto' }] });
  expect(mockSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ chainId: 11155111 }));
  expect(readNativeFeeFields).toHaveBeenCalledWith(11155111);
  await expect(
    switched.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xdeadbeef' }] })
  ).rejects.toThrow();
  expect(await switched.request({ method: 'eth_chainId' })).toBe('0xaa36a7');
});

describe('assertNativeSessionChain', () => {
  it('throws a NativeSessionChainNotApprovedError when the session did not approve the chain', () => {
    const thrown = (() => {
      try {
        assertNativeSessionChain(sessionState([SEPOLIA]), ARC, 'Arc Testnet');
        return undefined;
      } catch (err) {
        return err;
      }
    })();

    expect(thrown).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(thrown).toMatchObject({ chainId: ARC, networkName: 'Arc Testnet' });
  });

  it('passes when the session approved the chain', () => {
    expect(() => assertNativeSessionChain(sessionState([SEPOLIA, ARC]), ARC, 'Arc Testnet')).not.toThrow();
  });

  it('passes when an older native build reports no chainIds', () => {
    expect(() => assertNativeSessionChain(sessionState(undefined), ARC, 'Arc Testnet')).not.toThrow();
  });

  it.each([
    ['is not connected', { ...sessionState(undefined), connected: false, topic: undefined }],
    ['is connected with no topic', { ...sessionState(undefined), topic: undefined }]
  ])('refuses a state that %s, with or without chainIds', (_label, state) => {
    expect(() => assertNativeSessionChain(state, ARC, 'Arc Testnet')).toThrow(NativeSessionChainNotApprovedError);
    expect(() => assertNativeSessionChain({ ...state, chainIds: [ARC] }, ARC, 'Arc Testnet')).toThrow(
      NativeSessionChainNotApprovedError
    );
  });
});

describe('ensureNativeSessionChain', () => {
  beforeEach(() => {
    jest.mocked(NativeReown.request).mockReset();
    jest.mocked(NativeReown.getState).mockReset();
  });

  it('adds and switches to a missing chain on an approved chain, then reads the state again', async () => {
    jest.mocked(NativeReown.request).mockResolvedValue({ result: null });
    const reread = sessionState([SEPOLIA, ARC]);
    jest.mocked(NativeReown.getState).mockResolvedValue(reread);

    const next = await ensureNativeSessionChain(sessionState([SEPOLIA]), ARC);

    expect(NativeReown.request).toHaveBeenCalledTimes(2);
    expect(NativeReown.request).toHaveBeenNthCalledWith(1, {
      topic: 'topic-1',
      chainId: SEPOLIA,
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: '0x4cef52',
          chainName: 'Arc Testnet',
          rpcUrls: ['https://rpc.testnet.arc.network'],
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
          blockExplorerUrls: ['https://testnet.arcscan.app']
        }
      ]
    });
    expect(NativeReown.request).toHaveBeenNthCalledWith(2, {
      topic: 'topic-1',
      chainId: SEPOLIA,
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x4cef52' }]
    });
    expect(NativeReown.getState).toHaveBeenCalledTimes(1);
    expect(next).toBe(reread);
  });

  it('sends nothing when the session already approved the chain', async () => {
    const state = sessionState([SEPOLIA, ARC]);

    await expect(ensureNativeSessionChain(state, ARC)).resolves.toBe(state);

    expect(NativeReown.request).not.toHaveBeenCalled();
    expect(NativeReown.getState).not.toHaveBeenCalled();
  });

  it('sends nothing when an older native build reports no chainIds', async () => {
    const state = sessionState(undefined);

    await expect(ensureNativeSessionChain(state, ARC)).resolves.toBe(state);

    expect(NativeReown.request).not.toHaveBeenCalled();
  });

  it('swallows a rejected add, sends no switch, and leaves the guard to refuse the chain', async () => {
    jest.mocked(NativeReown.request).mockRejectedValue(new Error('Invalid permissions for call.'));
    jest.mocked(NativeReown.getState).mockResolvedValue(sessionState([SEPOLIA]));

    await expect(prepareNativeSessionChain(ARC)).rejects.toThrow(NativeSessionChainNotApprovedError);

    expect(NativeReown.request).toHaveBeenCalledTimes(1);
    expect(NativeReown.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'wallet_addEthereumChain' }));
  });
});

describe('waiting for the session to approve an added chain', () => {
  const updateSession = (state: ReownState) => mockStateListeners.forEach(listener => listener(state));

  // Records the outcome without leaving a rejection unhandled while the test moves the clock.
  const watch = (pending: Promise<void>) => {
    const watched: { settled: boolean; error?: unknown } = { settled: false };
    pending.then(
      () => {
        watched.settled = true;
      },
      (error: unknown) => {
        watched.settled = true;
        watched.error = error;
      }
    );
    return watched;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(NativeReown.request).mockReset().mockResolvedValue({ result: null });
    jest
      .mocked(NativeReown.getState)
      .mockReset()
      .mockResolvedValue(sessionState([SEPOLIA]));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves when the session update arrives after the switch answered', async () => {
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(1000);
    updateSession(sessionState([SEPOLIA, ARC]));
    await jest.advanceTimersByTimeAsync(0);

    expect(watched).toEqual({ settled: true, error: undefined });
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('resolves when a state re-read approves the chain and no update event arrives', async () => {
    jest
      .mocked(NativeReown.getState)
      .mockResolvedValueOnce(sessionState([SEPOLIA]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]))
      .mockResolvedValue(sessionState([SEPOLIA, ARC]));
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    expect(watched.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);

    expect(watched).toEqual({ settled: true, error: undefined });
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refuses the chain after 5 s when the session never approves it', async () => {
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(4999);
    expect(watched.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refuses the chain when the session is deleted during the wait', async () => {
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(1000);
    const deleted: ReownState = { configured: true, connected: false, accounts: [] };
    jest.mocked(NativeReown.getState).mockResolvedValue(deleted);
    updateSession(deleted);
    await jest.advanceTimersByTimeAsync(4000);

    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
  });

  it('refuses the chain at once when the wallet rejected the switch', async () => {
    jest
      .mocked(NativeReown.request)
      .mockResolvedValueOnce({ result: null })
      .mockRejectedValueOnce(new Error('User rejected'));
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);

    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(NativeReown.request).toHaveBeenCalledTimes(2);
    expect(NativeReown.addListener).not.toHaveBeenCalled();
  });
});

describe('buildNativeReownProvider', () => {
  beforeEach(() => {
    jest.mocked(NativeReown.request).mockReset();
    jest.mocked(NativeReown.getState).mockReset();
    jest.mocked(NativeReown.sendTransaction).mockReset();
  });

  it('refuses eth_sendTransaction on a chain the session did not approve, before any wallet prompt', async () => {
    jest.mocked(NativeReown.request).mockRejectedValue(new Error('User rejected'));
    jest.mocked(NativeReown.getState).mockResolvedValue(sessionState([SEPOLIA]));
    const provider = buildNativeReownProvider({
      chainId: ARC,
      address: '0x00000000000000000000000000000000000000e1',
      rpcUrl: 'https://rpc.test'
    });

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ to: '0x00000000000000000000000000000000000000b2' }]
      })
    ).rejects.toThrow(NativeSessionChainNotApprovedError);

    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
  });

  it('sends eth_sendTransaction on a chain the session approved', async () => {
    jest.mocked(NativeReown.getState).mockResolvedValue(sessionState([SEPOLIA]));
    jest.mocked(NativeReown.sendTransaction).mockResolvedValue({ hash: '0xhash' });
    const provider = buildNativeReownProvider({
      chainId: SEPOLIA,
      address: '0x00000000000000000000000000000000000000e1',
      rpcUrl: 'https://rpc.test'
    });

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ to: '0x00000000000000000000000000000000000000b2' }]
      })
    ).resolves.toBe('0xhash');

    expect(NativeReown.request).not.toHaveBeenCalled();
    expect(NativeReown.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ chainId: SEPOLIA }));
  });
});
